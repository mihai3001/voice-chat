import SimplePeer from 'simple-peer';
import type { Instance as SimplePeerInstance, Options as SimplePeerOptions } from 'simple-peer';
import { TopologyManager, TopologyType } from './TopologyManager.js';
import { HostElection, PeerCapability, PeerConnectionStats } from './HostElection.js';
import { HostForwarder } from './HostForwarder.js';

export interface PeerConnectionInfo {
  peerId: string;
  username?: string;
  connection: SimplePeerInstance;
  stream?: MediaStream;
  connected: boolean;
  capability?: PeerCapability;
  stats?: PeerConnectionStats;
  retryCount?: number;
  retryTimeout?: NodeJS.Timeout;
  connectionType?: 'direct' | 'stun' | 'turn'; // How peer is connected
}

export interface MeshConnectionConfig {
  signalingUrl: string;
  roomId: string;
  peerId: string;
  username?: string;
  iceServers?: RTCIceServer[];
  enableHostTopology?: boolean; // Enable automatic host topology for 5+ peers
  iceTransportPolicy?: RTCIceTransportPolicy; // 'all' | 'relay' (force TURN)
}

export class MeshConnection {
  private signalingUrl: string;
  private socket: any; // Socket.io client socket (we'll import in client apps)
  private roomId: string;
  private peerId: string;
  private username?: string;
  private iceServers: RTCIceServer[];
  
  // Map of peerId -> connection info
  private peers = new Map<string, PeerConnectionInfo>();
  
  // Map of peerId -> username (for peers we know about but haven't connected to yet)
  private peerUsernames = new Map<string, string>();
  
  // Local media stream
  private localStream?: MediaStream;
  
  // Topology management
  private topologyManager: TopologyManager;
  private hostForwarder: HostForwarder;
  private currentHostId?: string;
  private isHost = false;
  private enableHostTopology: boolean;
  
  // Event handlers
  private onPeerJoinedHandler?: (peerId: string, username?: string) => void;
  private onPeerLeftHandler?: (peerId: string) => void;
  private onStreamReceivedHandler?: (peerId: string, stream: MediaStream) => void;
  private onConnectionStateChangeHandler?: (peerId: string, state: string) => void;
  private onTopologyChangeHandler?: (topology: TopologyType, hostPeerId?: string) => void;
  private onBecameHostHandler?: () => void;
  private onDataReceivedHandler?: (peerId: string, data: any) => void;
  
  constructor(config: MeshConnectionConfig) {
    this.signalingUrl = config.signalingUrl;
    this.roomId = config.roomId;
    this.peerId = config.peerId;
    this.username = config.username;
    this.enableHostTopology = config.enableHostTopology !== false; // Default to true
    
    // Configure ICE servers with STUN + public TURN fallback
    this.iceServers = config.iceServers || [
      // Google STUN servers
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      
      // Public TURN servers (Metered - free tier)
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ];
    
    // Initialize topology manager
    this.topologyManager = new TopologyManager({
      meshThreshold: 4
    });
    
    // Initialize host forwarder
    this.hostForwarder = new HostForwarder();
    
    // Set up topology change handler
    this.topologyManager.onTopologyChange((event) => {
      console.log(`[MeshConnection] Topology changed: ${event.oldTopology} → ${event.newTopology}`);
      this.handleTopologyChange(event.newTopology);
      
      if (this.onTopologyChangeHandler) {
        this.onTopologyChangeHandler(event.newTopology, this.currentHostId);
      }
    });
  }
  
  /**
   * Initialize connection to signaling server and set up socket listeners
   */
  async connect(socket: any, localStream?: MediaStream): Promise<void> {
    this.socket = socket;
    this.localStream = localStream;
    
    // Set up socket event listeners
    this.setupSocketListeners();
    
    // Join the room
    this.socket.emit('join-room', {
      roomId: this.roomId,
      peerId: this.peerId,
      username: this.username
    });
    
    console.log(`[MeshConnection] Joining room ${this.roomId} as ${this.peerId}`);
  }
  
  /**
   * Set up WebSocket event listeners for signaling
   */
  private setupSocketListeners(): void {
    // Room joined - got list of existing peers
    this.socket.on('room-joined', (data: { roomId: string; peers: Array<{ peerId: string; username?: string }> }) => {
      console.log(`[MeshConnection] Joined room ${data.roomId} with ${data.peers.length} existing peers`);
      
      // Store usernames for all peers
      data.peers.forEach(peer => {
        if (peer.username) {
          this.peerUsernames.set(peer.peerId, peer.username);
        }
      });
      
      // Initiate connections to all existing peers (we are the initiator)
      data.peers.forEach(peer => {
        this.createPeerConnection(peer.peerId, true, peer.username);
      });
      
      // Update topology based on peer count
      this.updateTopology();
    });
    
    // New peer joined the room
    this.socket.on('peer-joined', (data: { peerId: string; username?: string }) => {
      console.log(`[MeshConnection] New peer joined: ${data.peerId} (${data.username})`);
      
      // Store username for later
      if (data.username) {
        this.peerUsernames.set(data.peerId, data.username);
      }
      
      // If we already have a peer connection, update the username
      const existingPeer = this.peers.get(data.peerId);
      if (existingPeer && data.username) {
        existingPeer.username = data.username;
        console.log(`[MeshConnection] Updated username for ${data.peerId} to ${data.username}`);
      }
      
      if (this.onPeerJoinedHandler) {
        this.onPeerJoinedHandler(data.peerId, data.username);
      }
      
      // Update topology immediately (now that we track all known peers)
      this.updateTopology();
    });
    
    // Peer left the room
    this.socket.on('peer-left', (data: { peerId: string }) => {
      console.log(`[MeshConnection] Peer left: ${data.peerId}`);
      this.removePeerConnection(data.peerId);
      // Actually remove from username map since peer left the room
      this.peerUsernames.delete(data.peerId);
      
      if (this.onPeerLeftHandler) {
        this.onPeerLeftHandler(data.peerId);
      }
      
      // Update topology after peer left
      this.updateTopology();
      
      // If the host left, elect a new one
      if (data.peerId === this.currentHostId) {
        console.log('[MeshConnection] Host disconnected, re-electing');
        this.electHost();
      }
    });
    
    // Received signaling data from peer
    this.socket.on('signal', (data: { fromPeerId: string; signal: any; type: string }) => {
      const { fromPeerId, signal, type } = data;
      console.log(`[MeshConnection] Received ${type} from ${fromPeerId}`);
      
      let peerInfo = this.peers.get(fromPeerId);
      
      // If we don't have a connection yet, create one (we are NOT the initiator)
      if (!peerInfo) {
        const username = this.peerUsernames.get(fromPeerId);
        console.log(`[MeshConnection] Creating peer connection from signal (username: ${username})`);
        peerInfo = this.createPeerConnection(fromPeerId, false, username);
      }
      
      // Handle the signal
      peerInfo.connection.signal(signal);
    });
  }
  
  /**
   * Create a peer connection
   */
  private createPeerConnection(peerId: string, initiator: boolean, username?: string): PeerConnectionInfo {
    console.log(`[MeshConnection] Creating peer connection to ${peerId} (initiator: ${initiator})`);
    
    const options: SimplePeerOptions = {
      initiator,
      trickle: true,
      stream: this.localStream,
      config: {
        iceServers: this.iceServers,
        iceTransportPolicy: 'all', // Try all methods (STUN/TURN)
        iceCandidatePoolSize: 10,  // Gather more candidates
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
      },
      sdpTransform: (sdp: string) => {
        // Prefer Opus codec for better quality
        return sdp;
      }
    };
    
    const peer = new SimplePeer(options);
    
    const peerInfo: PeerConnectionInfo = {
      peerId,
      username,
      connection: peer,
      connected: false,
      retryCount: 0
    };
    
    // Handle signals (offers, answers, ICE candidates)
    peer.on('signal', (signal) => {
      const type = signal.type === 'offer' ? 'offer' : 
                   signal.type === 'answer' ? 'answer' : 'ice-candidate';
      
      this.socket.emit('signal', {
        roomId: this.roomId,
        targetPeerId: peerId,
        signal,
        type
      });
    });
    
    // Connection established
    peer.on('connect', () => {
      console.log(`[MeshConnection] Connected to ${peerId}`);
      peerInfo.connected = true;
      
      // If this is the host in host topology mode, close non-host connections
      if (this.currentHostId === peerId && !this.isHost) {
        console.log(`[MeshConnection] Host connection confirmed, closing non-host peers`);
        this.closeNonHostConnections(peerId);
      }
      
      // Update topology when a new connection is established
      this.updateTopology();
      
      if (this.onConnectionStateChangeHandler) {
        this.onConnectionStateChangeHandler(peerId, 'connected');
      }
    });
    
    // Received media stream
    peer.on('stream', (stream: MediaStream) => {
      console.log(`[MeshConnection] Received stream from ${peerId}`);
      peerInfo.stream = stream;
      
      // If we're the host, add this stream to the forwarder
      if (this.isHost) {
        this.hostForwarder.addPeerStream(peerId, stream);
      }
      
      if (this.onStreamReceivedHandler) {
        this.onStreamReceivedHandler(peerId, stream);
      }
    });
    
    // Handle data channel messages
    peer.on('data', (data: Buffer | string) => {
      try {
        const message = data.toString();
        if (this.onDataReceivedHandler) {
          this.onDataReceivedHandler(peerId, message);
        }
      } catch (err) {
        console.error(`[MeshConnection] Error handling data from ${peerId}:`, err);
      }
    });
    
    // Handle errors
    peer.on('error', (err) => {
      console.error(`[MeshConnection] Error with peer ${peerId}:`, err);
      
      // Log ICE connection issues
      if (err.message?.includes('ICE') || err.message?.includes('connection')) {
        console.warn(`[MeshConnection] ICE connection issue with ${peerId}, may need TURN server`);
      }
    });
    
    // Handle close
    peer.on('close', () => {
      console.log(`[MeshConnection] Connection closed with ${peerId}`);
      
      // If this is the host connection and we're in host mode, retry
      const isHostConnection = peerId === this.currentHostId && !this.isHost;
      const retryCount = peerInfo.retryCount || 0;
      const maxRetries = isHostConnection ? 3 : 1; // More retries for host
      
      if (retryCount < maxRetries) {
        console.log(`[MeshConnection] Retrying connection to ${peerId} (attempt ${retryCount + 1}/${maxRetries})`);
        peerInfo.retryCount = retryCount + 1;
        
        // Retry after a delay
        peerInfo.retryTimeout = setTimeout(() => {
          if (this.peerUsernames.has(peerId)) {
            console.log(`[MeshConnection] Reconnecting to ${peerId}...`);
            this.removePeerConnection(peerId);
            const username = this.peerUsernames.get(peerId);
            this.createPeerConnection(peerId, true, username);
          }
        }, 2000 * (retryCount + 1)); // Exponential backoff: 2s, 4s, 6s
      } else {
        console.error(`[MeshConnection] Max retries reached for ${peerId}`);
        this.removePeerConnection(peerId);
      }
      
      if (this.onConnectionStateChangeHandler) {
        this.onConnectionStateChangeHandler(peerId, 'closed');
      }
    });
    
    // Monitor ICE connection state via the underlying RTCPeerConnection
    // This helps diagnose NAT traversal issues
    const monitorIceState = () => {
      const pc = (peer as any)._pc as RTCPeerConnection;
      if (pc) {
        pc.addEventListener('iceconnectionstatechange', () => {
          console.log(`[MeshConnection] ICE connection state for ${peerId}: ${pc.iceConnectionState}`);
          
          if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            // Log selected candidate pair to see if using TURN
            pc.getStats().then(stats => {
              stats.forEach(report => {
                if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                  console.log(`[MeshConnection] ${peerId} connected via:`, report);
                  
                  // Check if local or remote candidate is relay (TURN)
                  const localCandidateId = report.localCandidateId;
                  const remoteCandidateId = report.remoteCandidateId;
                  
                  stats.forEach(candidateReport => {
                    if (candidateReport.id === localCandidateId || candidateReport.id === remoteCandidateId) {
                      if (candidateReport.candidateType === 'relay') {
                        console.log(`[MeshConnection] ⚡ Using TURN relay for ${peerId}`);
                        peerInfo.connectionType = 'turn';
                      } else if (candidateReport.candidateType === 'host') {
                        console.log(`[MeshConnection] 🏠 Direct connection to ${peerId}`);
                        peerInfo.connectionType = 'direct';
                      } else if (candidateReport.candidateType === 'srflx') {
                        console.log(`[MeshConnection] 🌐 STUN-assisted connection to ${peerId}`);
                        peerInfo.connectionType = 'stun';
                      }
                    }
                  });
                }
              });
            });
          }
        });
      }
    };
    
    // Set up monitoring after a brief delay (wait for _pc to be created)
    setTimeout(monitorIceState, 100);
    
    this.peers.set(peerId, peerInfo);
    return peerInfo;
  }
  
  /**
   * Remove a peer connection
   */
  private removePeerConnection(peerId: string): void {
    const peerInfo = this.peers.get(peerId);
    if (peerInfo) {
      // Clear retry timeout if exists
      if (peerInfo.retryTimeout) {
        clearTimeout(peerInfo.retryTimeout);
      }
      peerInfo.connection.destroy();
      this.peers.delete(peerId);
      console.log(`[MeshConnection] Removed peer connection: ${peerId}`);
    }
    // Don't remove from peerUsernames - keep it for potential reconnection
  }
  
  /**
   * Update local media stream
   */
  updateStream(stream: MediaStream): void {
    const oldStream = this.localStream;
    this.localStream = stream;
    
    // Update stream for all existing peers
    this.peers.forEach((peerInfo) => {
      try {
        // Remove old stream if it exists
        if (oldStream) {
          peerInfo.connection.removeStream(oldStream);
        }
        // Add new stream
        peerInfo.connection.addStream(stream);
      } catch (err) {
        console.error(`[MeshConnection] Error updating stream for ${peerInfo.peerId}:`, err);
      }
    });
    
    // Update host forwarder if we're the host
    if (this.isHost) {
      this.hostForwarder.updateLocalStream(stream);
    }
  }
  
  /**
   * Handle topology change
   */
  private handleTopologyChange(newTopology: TopologyType): void {
    if (!this.enableHostTopology) {
      console.log('[MeshConnection] Host topology disabled, staying in mesh mode');
      return;
    }
    
    if (newTopology === 'host') {
      // Switched to host mode - elect a host (or keep existing)
      this.electHost();
    } else {
      // Switched back to mesh mode
      this.dissolveHostTopology();
    }
  }
  
  /**
   * Elect a host peer
   */
  private electHost(): void {
    // Use all known peers (from peerUsernames), not just connected peers
    const allPeerIds = [this.peerId, ...Array.from(this.peerUsernames.keys())];
    
    // If there's a current host and they're still in the room, keep them
    if (this.currentHostId && allPeerIds.includes(this.currentHostId)) {
      console.log(`[MeshConnection] Keeping existing host: ${this.currentHostId}`);
      
      // Update our role based on whether we're the host
      if (this.currentHostId === this.peerId) {
        if (!this.isHost) {
          this.becomeHost();
        }
      } else {
        if (this.isHost) {
          // We were host but aren't anymore
          this.hostForwarder.stop();
          this.isHost = false;
        }
        this.connectToHost(this.currentHostId);
      }
      return;
    }
    
    // No current host or they left - elect new one deterministically
    // Use lowest peer ID for consistent election across all peers
    allPeerIds.sort();
    const electedHostId = allPeerIds[0];
    
    console.log(`[MeshConnection] Elected new host: ${electedHostId} (I am: ${this.peerId}, all peers: ${allPeerIds.join(', ')})`);
    
    // If currentHostId is changing and I was the old host, step down
    if (this.currentHostId && this.currentHostId !== electedHostId && this.isHost) {
      console.log('[MeshConnection] Stepping down as host');
      this.hostForwarder.stop();
      this.isHost = false;
    }
    
    this.currentHostId = electedHostId;
    
    if (electedHostId === this.peerId) {
      // I'm the host!
      this.becomeHost();
    } else {
      // Someone else is host
      this.connectToHost(electedHostId);
    }
  }
  
  /**
   * Become the host
   */
  private becomeHost(): void {
    console.log('[MeshConnection] I am now the host');
    this.isHost = true;
    
    // Ensure we have connections to all known peers
    this.peerUsernames.forEach((username, peerId) => {
      if (!this.peers.has(peerId)) {
        console.log(`[MeshConnection] Host establishing connection to ${peerId} (${username})`);
        this.createPeerConnection(peerId, true, username);
      }
    });
    
    // Start host forwarder
    this.hostForwarder.start(this.localStream);
    
    // Add existing peer streams to forwarder
    this.peers.forEach((peerInfo, peerId) => {
      if (peerInfo.stream) {
        this.hostForwarder.addPeerStream(peerId, peerInfo.stream);
      }
    });
    
    // Notify UI
    if (this.onBecameHostHandler) {
      this.onBecameHostHandler();
    }
    
    // In mesh mode, we already have connections to everyone
    // In host mode, just keep receiving their streams and forward mixed audio
  }
  
  /**
   * Connect to the elected host (as a non-host peer)
   */
  private connectToHost(hostPeerId: string): void {
    console.log(`[MeshConnection] Connecting to host: ${hostPeerId}`);
    
    // DON'T close connections yet - wait until host connection is confirmed
    // This prevents losing all audio if host connection fails
    
    // Ensure we have a connection to the host
    const hostPeer = this.peers.get(hostPeerId);
    if (!hostPeer) {
      console.warn(`[MeshConnection] No connection to host ${hostPeerId}, creating one`);
      const username = this.peerUsernames.get(hostPeerId);
      this.createPeerConnection(hostPeerId, true, username);
    } else if (hostPeer.connected) {
      // Host connection is good, now we can close other connections
      console.log(`[MeshConnection] Host connection confirmed, closing non-host peers`);
      this.closeNonHostConnections(hostPeerId);
    } else {
      // Host connection exists but not connected yet - wait for it
      console.log(`[MeshConnection] Waiting for host connection to establish...`);
    }
  }
  
  /**
   * Close connections to non-host peers
   */
  private closeNonHostConnections(hostPeerId: string): void {
    this.peers.forEach((peerInfo, peerId) => {
      if (peerId !== hostPeerId) {
        console.log(`[MeshConnection] Closing connection to non-host peer: ${peerId}`);
        peerInfo.connection.destroy();
        this.peers.delete(peerId);
        // Keep username for potential reconnection
      }
    });
  }
  
  /**
   * Dissolve host topology and return to mesh
   */
  private dissolveHostTopology(): void {
    console.log('[MeshConnection] Dissolving host topology, returning to mesh');
    
    if (this.isHost) {
      // Stop being host
      this.hostForwarder.stop();
      this.isHost = false;
    }
    
    this.currentHostId = undefined;
    
    // Reconnect to all peers we know about (from peerUsernames map)
    // We may have closed connections when switching to host mode
    this.peerUsernames.forEach((username, peerId) => {
      if (peerId !== this.peerId && !this.peers.has(peerId)) {
        console.log(`[MeshConnection] Reconnecting to peer ${peerId} (${username}) for mesh mode`);
        this.createPeerConnection(peerId, true, username);
      }
    });
  }
  
  /**
   * Update peer count and check topology
   */
  private updateTopology(): void {
    // Count all known peers (not just connected), excluding self
    const peerCount = this.peerUsernames.size;
    const newTopology = this.topologyManager.updatePeerCount(peerCount, this.currentHostId);
    console.log(`[MeshConnection] Updated topology: ${newTopology} (${peerCount} peers, ${this.peers.size} connected)`);
  }
  
  /**
   * Disconnect from all peers and leave room
   */
  disconnect(): void {
    console.log(`[MeshConnection] Disconnecting from room ${this.roomId}`);
    
    // Stop host duties if applicable
    if (this.isHost) {
      this.hostForwarder.stop();
      this.isHost = false;
    }
    
    // Reset topology state
    this.currentHostId = undefined;
    
    // Close all peer connections
    this.peers.forEach((peerInfo) => {
      if (peerInfo.retryTimeout) {
        clearTimeout(peerInfo.retryTimeout);
      }
      peerInfo.connection.destroy();
    });
    this.peers.clear();
    this.peerUsernames.clear();
    
    // Leave room on signaling server
    if (this.socket) {
      this.socket.emit('leave-room', {
        roomId: this.roomId,
        peerId: this.peerId
      });
    }
  }
  
  /**
   * Get all active peer connections
   */
  getPeers(): PeerConnectionInfo[] {
    return Array.from(this.peers.values());
  }
  
  /**
   * Get specific peer info
   */
  getPeer(peerId: string): PeerConnectionInfo | undefined {
    return this.peers.get(peerId);
  }
  
  /**
   * Send data to all connected peers via data channels
   */
  sendData(data: string | object): void {
    const dataString = typeof data === 'string' ? data : JSON.stringify(data);
    
    this.peers.forEach((peerInfo) => {
      if (peerInfo.connected) {
        try {
          peerInfo.connection.send(dataString);
        } catch (err) {
          console.error(`[MeshConnection] Error sending data to ${peerInfo.peerId}:`, err);
        }
      }
    });
  }
  
  /**
   * Send data to specific peer via data channel
   */
  sendDataToPeer(peerId: string, data: string | object): void {
    const peerInfo = this.peers.get(peerId);
    if (!peerInfo || !peerInfo.connected) {
      console.warn(`[MeshConnection] Cannot send data to ${peerId}: not connected`);
      return;
    }
    
    const dataString = typeof data === 'string' ? data : JSON.stringify(data);
    
    try {
      peerInfo.connection.send(dataString);
    } catch (err) {
      console.error(`[MeshConnection] Error sending data to ${peerId}:`, err);
    }
  }
  
  
  /**
   * Event handlers
   */
  onPeerJoined(handler: (peerId: string, username?: string) => void): void {
    this.onPeerJoinedHandler = handler;
  }
  
  onPeerLeft(handler: (peerId: string) => void): void {
    this.onPeerLeftHandler = handler;
  }
  
  onStreamReceived(handler: (peerId: string, stream: MediaStream) => void): void {
    this.onStreamReceivedHandler = handler;
  }
  
  onConnectionStateChange(handler: (peerId: string, state: string) => void): void {
    this.onConnectionStateChangeHandler = handler;
  }
  
  onTopologyChange(handler: (topology: TopologyType, hostPeerId?: string) => void): void {
    this.onTopologyChangeHandler = handler;
  }
  
  onBecameHost(handler: () => void): void {
    this.onBecameHostHandler = handler;
  }
  
  onDataReceived(handler: (peerId: string, data: any) => void): void {
    this.onDataReceivedHandler = handler;
  }
  
  /**
   * Get current topology type
   */
  getCurrentTopology(): TopologyType {
    return this.topologyManager.getCurrentTopology();
  }
  
  /**
   * Check if this peer is currently the host
   */
  isCurrentHost(): boolean {
    return this.isHost;
  }
  
  /**
   * Get the current host peer ID
   */
  getHostPeerId(): string | undefined {
    return this.currentHostId;
  }
  
  /**
   * Enable or disable host topology
   */
  setEnableHostTopology(enable: boolean): void {
    this.enableHostTopology = enable;
    if (!enable && this.isHost) {
      this.hostForwarder.stop();
      this.isHost = false;
    }
  }
}

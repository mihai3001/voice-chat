/**
 * Host Forwarder
 * 
 * Handles audio forwarding when acting as host:
 * - Receives audio streams from all peers
 * - Mixes audio together
 * - Forwards mixed audio back to each peer
 */

export interface HostForwarderConfig {
  mixingMode: 'mixed' | 'individual'; // Mix all or forward individual streams
  sampleRate: number;
}

export class HostForwarder {
  private audioContext?: AudioContext;
  private config: HostForwarderConfig;
  
  // Incoming streams from peers (peerId -> MediaStream)
  private incomingStreams = new Map<string, MediaStream>();
  
  // Audio sources for mixing (peerId -> MediaStreamAudioSourceNode)
  private audioSources = new Map<string, MediaStreamAudioSourceNode>();
  
  // Mixed output streams for each peer (peerId -> MediaStream)
  private outputStreams = new Map<string, MediaStream>();
  
  // Mixing destination
  private mixerDestination?: MediaStreamAudioDestinationNode;
  
  // Local stream (to include in mix)
  private localStream?: MediaStream;
  
  private isActive = false;
  
  constructor(config?: Partial<HostForwarderConfig>) {
    this.config = {
      mixingMode: 'mixed',
      sampleRate: 48000,
      ...config
    };
  }
  
  /**
   * Start forwarding (become host)
   */
  start(localStream?: MediaStream): void {
    if (this.isActive) {
      console.warn('[HostForwarder] Already active');
      return;
    }
    
    console.log('[HostForwarder] Starting as host');
    
    // Initialize audio context
    this.audioContext = new AudioContext({
      sampleRate: this.config.sampleRate
    });
    
    this.localStream = localStream;
    this.isActive = true;
    
    // Initialize mixer
    this.initializeMixer();
  }
  
  /**
   * Stop forwarding (step down as host)
   */
  stop(): void {
    if (!this.isActive) {
      return;
    }
    
    console.log('[HostForwarder] Stopping host duties');
    
    // Clean up audio sources
    this.audioSources.forEach(source => {
      source.disconnect();
    });
    this.audioSources.clear();
    
    // Clear streams
    this.incomingStreams.clear();
    this.outputStreams.clear();
    
    // Close audio context
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
    
    this.isActive = false;
  }
  
  /**
   * Initialize audio mixer
   */
  private initializeMixer(): void {
    if (!this.audioContext) return;
    
    // Create destination for mixed audio
    this.mixerDestination = this.audioContext.createMediaStreamDestination();
    
    // Add local stream to mix if available
    if (this.localStream) {
      try {
        const localSource = this.audioContext.createMediaStreamSource(this.localStream);
        localSource.connect(this.mixerDestination);
      } catch (err) {
        console.error('[HostForwarder] Error adding local stream to mix:', err);
      }
    }
    
    console.log('[HostForwarder] Mixer initialized');
  }
  
  /**
   * Add a peer's incoming audio stream
   */
  addPeerStream(peerId: string, stream: MediaStream): void {
    if (!this.isActive || !this.audioContext || !this.mixerDestination) {
      console.warn('[HostForwarder] Not active, cannot add peer stream');
      return;
    }
    
    console.log(`[HostForwarder] Adding stream from peer: ${peerId}`);
    
    // Remove existing if any
    this.removePeerStream(peerId);
    
    // Store incoming stream
    this.incomingStreams.set(peerId, stream);
    
    try {
      // Create audio source from stream
      const source = this.audioContext.createMediaStreamSource(stream);
      this.audioSources.set(peerId, source);
      
      // Connect to mixer
      source.connect(this.mixerDestination);
      
      // Generate output stream for this peer (mixed audio without their own voice)
      this.generateOutputStreamForPeer(peerId);
      
    } catch (err) {
      console.error(`[HostForwarder] Error adding stream from ${peerId}:`, err);
    }
  }
  
  /**
   * Remove a peer's stream
   */
  removePeerStream(peerId: string): void {
    console.log(`[HostForwarder] Removing stream from peer: ${peerId}`);
    
    // Disconnect and remove audio source
    const source = this.audioSources.get(peerId);
    if (source) {
      source.disconnect();
      this.audioSources.delete(peerId);
    }
    
    // Remove streams
    this.incomingStreams.delete(peerId);
    this.outputStreams.delete(peerId);
  }
  
  /**
   * Generate output stream for a specific peer
   * (mixed audio excluding their own voice)
   */
  private generateOutputStreamForPeer(peerId: string): void {
    if (!this.audioContext || !this.mixerDestination) return;
    
    // For simplicity in MVP, send the full mix to everyone
    // In future: can create individual mixes excluding each peer's own voice
    
    const mixedStream = this.mixerDestination.stream;
    this.outputStreams.set(peerId, mixedStream);
  }
  
  /**
   * Get output stream to send to a specific peer
   */
  getOutputStreamForPeer(peerId: string): MediaStream | undefined {
    if (!this.isActive) {
      console.warn('[HostForwarder] Not active');
      return undefined;
    }
    
    // For MVP: return the same mixed stream for all peers
    // In future: return individualized mix
    return this.mixerDestination?.stream;
  }
  
  /**
   * Get all peer IDs currently being forwarded
   */
  getPeerIds(): string[] {
    return Array.from(this.incomingStreams.keys());
  }
  
  /**
   * Check if host is active
   */
  isActiveHost(): boolean {
    return this.isActive;
  }
  
  /**
   * Update local stream
   */
  updateLocalStream(stream: MediaStream): void {
    this.localStream = stream;
    
    if (this.isActive && this.audioContext && this.mixerDestination) {
      // Reconnect local stream to mixer
      try {
        const localSource = this.audioContext.createMediaStreamSource(stream);
        localSource.connect(this.mixerDestination);
      } catch (err) {
        console.error('[HostForwarder] Error updating local stream:', err);
      }
    }
  }
  
  /**
   * Get mixing mode
   */
  getMixingMode(): string {
    return this.config.mixingMode;
  }
  
  /**
   * Set mixing mode
   */
  setMixingMode(mode: 'mixed' | 'individual'): void {
    this.config.mixingMode = mode;
    
    if (this.isActive) {
      // Reinitialize mixer with new mode
      this.stop();
      this.start(this.localStream);
      
      // Re-add all peer streams
      const streams = new Map(this.incomingStreams);
      this.incomingStreams.clear();
      streams.forEach((stream, peerId) => {
        this.addPeerStream(peerId, stream);
      });
    }
  }
  
  /**
   * Get stats about forwarding
   */
  getStats(): {
    isActive: boolean;
    peerCount: number;
    mixingMode: string;
  } {
    return {
      isActive: this.isActive,
      peerCount: this.incomingStreams.size,
      mixingMode: this.config.mixingMode
    };
  }
}

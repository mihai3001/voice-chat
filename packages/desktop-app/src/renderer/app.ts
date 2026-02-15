import { io, Socket } from 'socket.io-client';
import { MeshConnection, AudioManager } from '@voice-chat/client-core';

// State
let socket: Socket | null = null;
let meshConnection: MeshConnection | null = null;
let audioManager: AudioManager | null = null;
let connected = false;
let pushToTalkEnabled = false;
let pushToTalkActive = false;
let currentRoomId: string | null = null;

// Screen sharing state
let screenStream: MediaStream | null = null;
let isScreenSharing = false;
const remoteScreens = new Map<string, MediaStream>();
const remoteScreenAvailable = new Map<string, boolean>(); // Track who's sharing (but not necessarily streaming to us)
const screenViewers = new Set<string>(); // Track who's viewing our screen
let screenQuality: '720p15' | '720p30' | '720p60' | '1080p30' | '1080p60' | '1080p144' | '1440p60' | '1440p144' | '4k60' = '1080p30';

// Quality presets for screen sharing
const qualityPresets = {
  '720p15': {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 15, max: 15 }
  },
  '720p30': {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 }
  },
  '720p60': {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 60, max: 60 }
  },
  '1080p30': {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 30 }
  },
  '1080p60': {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 60, max: 60 }
  },
  '1080p144': {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 144, max: 144 }
  },
  '1440p60': {
    width: { ideal: 2560 },
    height: { ideal: 1440 },
    frameRate: { ideal: 60, max: 60 }
  },
  '1440p144': {
    width: { ideal: 2560 },
    height: { ideal: 1440 },
    frameRate: { ideal: 144, max: 144 }
  },
  '4k60': {
    width: { ideal: 3840 },
    height: { ideal: 2160 },
    frameRate: { ideal: 60, max: 60 }
  }
};

// Voice activity state
const peerSpeakingState = new Map<string, boolean>();

// Connection quality state (0-4 bars)
const peerConnectionQuality = new Map<string, number>();
let connectionQualityInterval: NodeJS.Timeout | null = null;

// Audio health check
let audioHealthCheckInterval: NodeJS.Timeout | null = null;
let isReconnectingAudio = false;

// Generate a unique peer ID
const peerId = `peer_${Math.random().toString(36).substr(2, 9)}`;

// Generate a random username for easy testing
const randomNames = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry', 'Iris', 'Jack'];
const defaultUsername = randomNames[Math.floor(Math.random() * randomNames.length)] + Math.floor(Math.random() * 100);

// DOM elements
const signalingUrlInput = document.getElementById('signaling-url') as HTMLInputElement;
const roomIdInput = document.getElementById('room-id') as HTMLInputElement;
const usernameInput = document.getElementById('username') as HTMLInputElement;
const audioDeviceSelect = document.getElementById('audio-device') as HTMLSelectElement;
const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
const disconnectBtn = document.getElementById('disconnect-btn') as HTMLButtonElement;
const muteBtn = document.getElementById('mute-btn') as HTMLButtonElement;
const deafenBtn = document.getElementById('deafen-btn') as HTMLButtonElement;
const pttToggleBtn = document.getElementById('ptt-toggle-btn') as HTMLButtonElement;
const pttIndicator = document.getElementById('ptt-indicator') as HTMLDivElement;
const statusDiv = document.getElementById('status') as HTMLDivElement;
const statusMessage = document.getElementById('status-message') as HTMLSpanElement;
const peersList = document.getElementById('peers-list') as HTMLDivElement;
const topologyInfo = document.getElementById('topology-info') as HTMLDivElement;
const topologyMode = document.getElementById('topology-mode') as HTMLSpanElement;
const topologyBadge = document.getElementById('topology-badge') as HTMLSpanElement;
const peerCount = document.getElementById('peer-count') as HTMLSpanElement;
const echoCancellationToggle = document.getElementById('echo-cancellation') as HTMLInputElement;
const noiseSuppressionToggle = document.getElementById('noise-suppression') as HTMLInputElement;
const autoGainControlToggle = document.getElementById('auto-gain-control') as HTMLInputElement;
const themeToggleBtn = document.getElementById('theme-toggle') as HTMLButtonElement;
const themeIcon = document.getElementById('theme-icon') as HTMLSpanElement;
const themeText = document.getElementById('theme-text') as HTMLSpanElement;

// Screen sharing elements
const screenShareBtn = document.getElementById('screen-share-btn') as HTMLButtonElement;
const stopScreenBtn = document.getElementById('stop-screen-btn') as HTMLButtonElement;
const screenContainer = document.getElementById('screen-container') as HTMLDivElement;
const localScreenVideo = document.getElementById('local-screen') as HTMLVideoElement;
const remoteScreensContainer = document.getElementById('remote-screens-container') as HTMLDivElement;
const remoteScreensDiv = document.getElementById('remote-screens') as HTMLDivElement;
const screenQualitySelect = document.getElementById('screen-quality') as HTMLSelectElement;

// Update banner elements
const updateBanner = document.getElementById('update-banner') as HTMLDivElement;
const updateBannerTitle = document.getElementById('update-banner-title') as HTMLDivElement;
const updateBannerMessage = document.getElementById('update-banner-message') as HTMLDivElement;
const updateDownloadBtn = document.getElementById('update-download-btn') as HTMLButtonElement;
const updateInstallBtn = document.getElementById('update-install-btn') as HTMLButtonElement;
const updateDismissBtn = document.getElementById('update-dismiss-btn') as HTMLButtonElement;
const updateProgress = document.getElementById('update-progress') as HTMLDivElement;

/**
 * Declare window.electron type
 */
declare global {
  interface Window {
    electron?: {
      ipcRenderer: {
        invoke: (channel: string, ...args: any[]) => Promise<any>;
        on: (channel: string, callback: (...args: any[]) => void) => void;
        removeAllListeners: (channel: string) => void;
      };
    };
  }
}

// Theme management
function getSystemTheme(): 'light' | 'dark' {
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

function getSavedTheme(): 'light' | 'dark' | null {
  try {
    const saved = localStorage.getItem('voiceChatTheme');
    return saved === 'dark' || saved === 'light' ? saved : null;
  } catch (err) {
    console.error('Error loading theme:', err);
    return null;
  }
}

function saveTheme(theme: 'light' | 'dark'): void {
  try {
    localStorage.setItem('voiceChatTheme', theme);
  } catch (err) {
    console.error('Error saving theme:', err);
  }
}

function applyTheme(theme: 'light' | 'dark'): void {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    themeIcon.textContent = '☀️';
    themeText.textContent = 'Light';
  } else {
    document.documentElement.removeAttribute('data-theme');
    themeIcon.textContent = '🌙';
    themeText.textContent = 'Dark';
  }
  console.log(`Theme applied: ${theme}`);
}

function toggleTheme(): void {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(newTheme);
  saveTheme(newTheme);
}

// Initialize theme on load
function initTheme(): void {
  const savedTheme = getSavedTheme();
  const theme = savedTheme || getSystemTheme();
  applyTheme(theme);
  
  // Listen for system theme changes
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!getSavedTheme()) {
        // Only auto-switch if user hasn't manually set a theme
        applyTheme(e.matches ? 'dark' : 'light');
      }
    });
  }
}

// Settings persistence
interface Settings {
  signalingUrl: string;
  username: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  pushToTalkEnabled: boolean;
}

function loadSettings(): Settings {
  const defaults: Settings = {
    signalingUrl: 'https://voice-chat-signaling-production.up.railway.app',
    username: defaultUsername,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    pushToTalkEnabled: false
  };
  
  try {
    const saved = localStorage.getItem('voiceChatSettings');
    return saved ? { ...defaults, ...JSON.parse(saved) } : defaults;
  } catch (err) {
    console.error('Error loading settings:', err);
    return defaults;
  }
}

function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem('voiceChatSettings', JSON.stringify(settings));
  } catch (err) {
    console.error('Error saving settings:', err);
  }
}

function getCurrentSettings(): Settings {
  return {
    signalingUrl: signalingUrlInput.value.trim(),
    username: usernameInput.value.trim(),
    echoCancellation: echoCancellationToggle.checked,
    noiseSuppression: noiseSuppressionToggle.checked,
    autoGainControl: autoGainControlToggle.checked,
    pushToTalkEnabled
  };
}

/**
 * Initialize audio manager and load devices
 */
async function initAudioManager() {
  const settings = loadSettings();
  
  audioManager = new AudioManager({
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl
  });

  // Load audio devices
  const devices = await audioManager.getAudioDevices();
  updateAudioDeviceList(devices);

  // Set up device change listener
  audioManager.onDevicesChanged((devices) => {
    updateAudioDeviceList(devices);
  });
  audioManager.setupDeviceChangeListener();
  
  // Set up voice activity detection
  audioManager.onVoiceActivity((peerId, isSpeaking) => {
    peerSpeakingState.set(peerId, isSpeaking);
    updatePeersList();
  });
}

/**
 * Update audio device dropdown
 */
function updateAudioDeviceList(devices: any[]) {
  const inputDevices = devices.filter(d => d.kind === 'audioinput');
  
  audioDeviceSelect.innerHTML = '<option value="">Default</option>';
  
  inputDevices.forEach(device => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label;
    audioDeviceSelect.appendChild(option);
  });
}

/**
 * Update connection status UI
 */
function updateStatus(status: 'disconnected' | 'connecting' | 'connected', message: string) {
  statusDiv.className = `status status-${status}`;
  statusMessage.textContent = message;
}

/**
 * Update peers list UI
 */
function updatePeersList() {
  if (!meshConnection) {
    peersList.innerHTML = '<div class="empty-state"><p>Connect to a room to see peers</p></div>';
    topologyInfo.style.display = 'none';
    return;
  }

  const peers = meshConnection.getPeers();
  const hostPeerId = meshConnection.getHostPeerId();
  
  if (peers.length === 0) {
    peersList.innerHTML = '<div class="empty-state"><p>No other peers in the room</p></div>';
    topologyInfo.style.display = 'none';
    return;
  }

  topologyInfo.style.display = 'flex';
  peerCount.textContent = (peers.length + 1).toString(); // +1 for self

  console.log('DEBUG: updatePeersList called, remoteScreenAvailable:', Array.from(remoteScreenAvailable.keys()));
  
  peersList.innerHTML = peers.map(peer => {
    const isHost = peer.peerId === hostPeerId;
    const isSpeaking = peerSpeakingState.get(peer.peerId) || false;
    const isSharing = remoteScreenAvailable.has(peer.peerId);
    const isViewing = remoteScreens.has(peer.peerId);
    
    console.log(`DEBUG: Peer ${peer.peerId.substring(0, 8)}... isSharing:${isSharing} isViewing:${isViewing}`);
    const connectionIcon = peer.connectionType === 'turn' ? '⚡' :
                          peer.connectionType === 'stun' ? '🌐' :
                          peer.connectionType === 'direct' ? '🏠' : '';
    const connectionLabel = peer.connectionType === 'turn' ? 'TURN' :
                           peer.connectionType === 'stun' ? 'STUN' :
                           peer.connectionType === 'direct' ? 'Direct' : '';
    
    const screenBtnClass = isSharing ? (isViewing ? 'btn-success-sm' : 'btn-primary-sm') : 'btn-disabled-sm';
    const screenBtnText = isViewing ? '👁️ Viewing' : (isSharing ? '👁️ View' : '🖥️ Not Sharing');
    
    // Get connection quality (0-4 bars)
    const quality = peerConnectionQuality.get(peer.peerId) || 0;
    const qualityClass = quality === 4 ? 'excellent' : quality === 3 ? 'good' : quality === 2 ? 'fair' : 'poor';
    const qualityBars = `
      <div class="connection-quality ${qualityClass}" title="Connection quality: ${qualityClass}">
        <div class="connection-bar ${quality >= 1 ? 'active' : ''}"></div>
        <div class="connection-bar ${quality >= 2 ? 'active' : ''}"></div>
        <div class="connection-bar ${quality >= 3 ? 'active' : ''}"></div>
        <div class="connection-bar ${quality >= 4 ? 'active' : ''}"></div>
      </div>
    `;
    
    return `
      <div class="peer-item ${peer.connected ? 'connected' : ''} ${isHost ? 'host' : ''}">
        <div class="peer-info">
          <div class="peer-indicator ${peer.connected ? (isSpeaking ? 'speaking' : 'connected') : ''}"></div>
          <span><strong>${peer.username || peer.peerId}</strong></span>
          ${isHost ? '<span class="host-badge">HOST</span>' : ''}
          ${peer.connected && connectionLabel ? `<span class="connection-badge" title="${connectionLabel} connection">${connectionIcon}</span>` : ''}
          ${isSpeaking ? '<span style="font-size: 12px;">🎤</span>' : ''}
        </div>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          ${peer.connected ? qualityBars : ''}
          <span style="font-size: 12px; color: #6b7280;">
            ${peer.connected ? `🔊 Connected${connectionLabel ? ' (' + connectionLabel + ')' : ''}` : '⏳ Connecting...'}
          </span>
          <button class="${screenBtnClass}" data-peer-id="${peer.peerId}" ${!isSharing ? 'disabled' : ''}>
            ${screenBtnText}
          </button>
        </div>
      </div>
    `;
  }).join('');
  
  // Add event listeners to screen buttons
  const screenButtons = peersList.querySelectorAll('button[data-peer-id]');
  screenButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const peerId = (e.target as HTMLButtonElement).dataset.peerId!;
      const isViewing = remoteScreens.has(peerId);
      
      if (isViewing) {
        stopViewingScreen(peerId);
      } else {
        requestScreenShare(peerId);
      }
    });
  });
}

/**
 * Update topology display UI
 */
function updateTopologyDisplay() {
  if (!meshConnection) return;

  const topology = meshConnection.getCurrentTopology();
  const isHost = meshConnection.isCurrentHost();
  
  if (isHost) {
    topologyMode.textContent = '⭐ YOU ARE THE HOST';
    topologyBadge.textContent = 'YOU ARE HOST';
    topologyBadge.className = 'topology-badge host';
  } else {
    topologyMode.textContent = topology === 'mesh' ? 'Mesh (≤4 peers)' : 'Host (5+ peers)';
    topologyBadge.textContent = topology.toUpperCase();
    topologyBadge.className = `topology-badge ${topology === 'host' ? 'host' : ''}`;
  }
  
  updatePeersList();
}

/**
 * Check if audio stream is healthy
 */
function isAudioStreamHealthy(): boolean {
  if (!audioManager) return false;
  
  const stream = audioManager.getLocalStream();
  if (!stream) return false;
  
  const tracks = stream.getAudioTracks();
  if (tracks.length === 0) return false;
  
  // Check if all tracks are enabled and not ended
  return tracks.every(track => track.readyState === 'live' && track.enabled);
}

/**
 * Reconnect audio stream
 */
async function reconnectAudio() {
  if (isReconnectingAudio || !connected) return;
  
  console.log('⚠️ Audio stream unhealthy, attempting reconnect...');
  isReconnectingAudio = true;
  updateStatus('connecting', 'Reconnecting audio...');
  
  try {
    const deviceId = audioDeviceSelect.value;
    
    // Stop and restart audio
    audioManager?.stopCapture();
    const newStream = await audioManager!.startCapture(deviceId || undefined);
    
    // Update mesh connection with new stream
    if (meshConnection && newStream) {
      meshConnection.updateStream(newStream);
      console.log('✅ Audio reconnected successfully');
      updateStatus('connected', 'Connected');
    }
  } catch (err) {
    console.error('❌ Failed to reconnect audio:', err);
    updateStatus('disconnected', 'Audio reconnection failed');
  } finally {
    isReconnectingAudio = false;
  }
}

/**
 * Start audio health check
 */
function startAudioHealthCheck() {
  // Clear any existing interval
  stopAudioHealthCheck();
  
  console.log('🔍 Starting audio health check (every 5 seconds)');
  
  audioHealthCheckInterval = setInterval(() => {
    if (!connected || !meshConnection) {
      stopAudioHealthCheck();
      return;
    }
    
    if (!isAudioStreamHealthy()) {
      console.warn('⚠️ Audio stream health check failed');
      reconnectAudio();
    }
  }, 5000); // Check every 5 seconds
}

/**
 * Stop audio health check
 */
function stopAudioHealthCheck() {
  if (audioHealthCheckInterval) {
    clearInterval(audioHealthCheckInterval);
    audioHealthCheckInterval = null;
    console.log('🔍 Stopped audio health check');
  }
}

/**
 * Calculate connection quality from WebRTC stats
 */
function calculateConnectionQuality(stats: { rtt?: number; packetsLost?: number; packetsReceived?: number; jitter?: number }): number {
  let quality = 4; // Start with excellent (4 bars)

  // Check RTT (Round Trip Time)
  if (stats.rtt !== undefined) {
    if (stats.rtt > 300) quality = Math.min(quality, 1); // Poor (>300ms)
    else if (stats.rtt > 150) quality = Math.min(quality, 2); // Fair (150-300ms)
    else if (stats.rtt > 50) quality = Math.min(quality, 3); // Good (50-150ms)
    // Excellent (<50ms) - no change
  }

  // Check packet loss
  if (stats.packetsLost !== undefined && stats.packetsReceived !== undefined) {
    const totalPackets = stats.packetsLost + stats.packetsReceived;
    if (totalPackets > 0) {
      const lossRate = stats.packetsLost / totalPackets;
      if (lossRate > 0.05) quality = Math.min(quality, 1); // Poor (>5%)
      else if (lossRate > 0.02) quality = Math.min(quality, 2); // Fair (2-5%)
      else if (lossRate > 0.01) quality = Math.min(quality, 3); // Good (1-2%)
      // Excellent (<1%) - no change
    }
  }

  // Check jitter
  if (stats.jitter !== undefined) {
    if (stats.jitter > 30) quality = Math.min(quality, 1); // Poor (>30ms)
    else if (stats.jitter > 15) quality = Math.min(quality, 2); // Fair (15-30ms)
    else if (stats.jitter > 5) quality = Math.min(quality, 3); // Good (5-15ms)
    // Excellent (<5ms) - no change
  }

  return quality;
}

/**
 * Monitor connection quality for a peer
 */
async function monitorPeerConnectionQuality(peerId: string) {
  if (!meshConnection) return;

  const peerInfo = meshConnection.getPeer(peerId);
  if (!peerInfo || !peerInfo.connection) return;

  try {
    // Access the internal SimplePeer connection to get stats
    const pc = (peerInfo.connection as any)._pc as RTCPeerConnection;
    if (!pc || pc.connectionState !== 'connected') return;

    const stats = await pc.getStats();
    let rtt: number | undefined;
    let packetsLost = 0;
    let packetsReceived = 0;
    let jitter: number | undefined;

    stats.forEach((report: any) => {
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        rtt = report.currentRoundTripTime ? report.currentRoundTripTime * 1000 : undefined;
      } else if (report.type === 'inbound-rtp' && report.kind === 'audio') {
        packetsLost += report.packetsLost || 0;
        packetsReceived += report.packetsReceived || 0;
        jitter = report.jitter ? report.jitter * 1000 : undefined;
      }
    });

    const quality = calculateConnectionQuality({ rtt, packetsLost, packetsReceived, jitter });
    peerConnectionQuality.set(peerId, quality);
  } catch (err) {
    console.warn(`Failed to get stats for peer ${peerId}:`, err);
  }
}

/**
 * Start connection quality monitoring
 */
function startConnectionQualityMonitoring() {
  stopConnectionQualityMonitoring();

  console.log('📊 Starting connection quality monitoring');

  connectionQualityInterval = setInterval(() => {
    if (!connected || !meshConnection) {
      stopConnectionQualityMonitoring();
      return;
    }

    const peers = meshConnection.getPeers();
    peers.forEach(peer => {
      if (peer.connected) {
        monitorPeerConnectionQuality(peer.peerId);
      }
    });

    // Update UI after checking all peers
    updatePeersList();
  }, 3000); // Check every 3 seconds
}

/**
 * Stop connection quality monitoring
 */
function stopConnectionQualityMonitoring() {
  if (connectionQualityInterval) {
    clearInterval(connectionQualityInterval);
    connectionQualityInterval = null;
    peerConnectionQuality.clear();
    console.log('📊 Stopped connection quality monitoring');
  }
}

/**
 * Connect to voice chat
 */
async function connect() {
  try {
    const signalingUrl = signalingUrlInput.value.trim();
    const roomId = roomIdInput.value.trim();
    const username = usernameInput.value.trim() || 'Anonymous';
    const deviceId = audioDeviceSelect.value;

    if (!signalingUrl || !roomId) {
      alert('Please enter signaling server URL and room ID');
      return;
    }

    updateStatus('connecting', 'Initializing audio...');
    connectBtn.disabled = true;

    // Initialize audio manager if not already done
    if (!audioManager) {
      await initAudioManager();
    }

    // Start audio capture
    const stream = await audioManager!.startCapture(deviceId || undefined);
    console.log('Audio capture started');

    // Connect to signaling server
    updateStatus('connecting', 'Connecting to signaling server...');
    socket = io(signalingUrl, {
      transports: ['websocket', 'polling']
    });

    // Wait for socket to connect
    await new Promise<void>((resolve, reject) => {
      socket!.on('connect', () => {
        console.log('Connected to signaling server');
        updateStatus('connecting', 'Joining room...');
        resolve();
      });

      socket!.on('connect_error', (err: Error) => {
        console.error('Signaling server connection error:', err);
        reject(err);
      });
    });

    // Store room ID for later use
    currentRoomId = roomId;

    // Create mesh connection
    meshConnection = new MeshConnection({
      signalingUrl,
      roomId,
      peerId,
      username
    });

    // Set up event handlers
    meshConnection.onPeerJoined((peerId, username) => {
      console.log(`Peer joined: ${peerId} (${username})`);
      updatePeersList();
    });

    meshConnection.onPeerLeft((peerId) => {
      console.log(`Peer left: ${peerId}`);
      audioManager?.removeRemoteStream(peerId);
      removeRemoteScreen(peerId); // Also remove their screen share if any
      updatePeersList();
    });

    meshConnection.onStreamReceived((peerId, stream) => {
      console.log(`Received stream from: ${peerId}`);
      
      // Check if stream has video tracks (screen share)
      const videoTracks = stream.getVideoTracks();
      if (videoTracks.length > 0) {
        console.log(`Received screen share from ${peerId}, ${videoTracks.length} video tracks`);
        
        // Create a new stream with only video tracks for screen display
        const screenOnlyStream = new MediaStream(videoTracks);
        handleRemoteScreen(peerId, screenOnlyStream);
        
        // Create audio-only stream for audio manager
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length > 0) {
          const audioOnlyStream = new MediaStream(audioTracks);
          audioManager?.addRemoteStream(peerId, audioOnlyStream);
        }
      } else {
        // Audio only
        audioManager?.addRemoteStream(peerId, stream);
      }
      
      updatePeersList();
    });

    meshConnection.onConnectionStateChange((peerId, state) => {
      console.log(`Connection state changed for ${peerId}: ${state}`);
      updatePeersList();
    });

    meshConnection.onTopologyChange((topology) => {
      console.log(`Topology changed to: ${topology}`);
      updateTopologyDisplay();
      updateStatus('connected', `Connected (${topology.toUpperCase()} mode)`);
    });

    meshConnection.onBecameHost(() => {
      console.log('This peer became the host');
      updateStatus('connected', 'You are now the HOST - forwarding audio for all peers');
      updateTopologyDisplay();
    });

    // Connect to room
    await meshConnection.connect(socket, stream);

    connected = true;
    updateStatus('connected', `Connected to room: ${roomId}`);
    
    // Set up screen sharing socket event handlers
    socket.on('screen-available', (data: { peerId: string }) => {
      console.log(`DEBUG: Received screen-available event from ${data.peerId}`);
      showScreenAvailable(data.peerId);
    });
    
    socket.on('screen-unavailable', (data: { peerId: string }) => {
      console.log(`Screen unavailable from ${data.peerId}`);
      removeRemoteScreen(data.peerId);
    });
    
    socket.on('request-screen', (data: { requesterPeerId: string }) => {
      console.log(`${data.requesterPeerId} requested to view screen`);
      if (isScreenSharing) {
        addScreenToViewer(data.requesterPeerId);
      }
    });
    
    socket.on('stop-request-screen', (data: { requesterPeerId: string }) => {
      console.log(`${data.requesterPeerId} stopped viewing screen`);
      if (isScreenSharing) {
        removeScreenFromViewer(data.requesterPeerId);
      }
    });
    
    // Update UI
    connectBtn.style.display = 'none';
    disconnectBtn.style.display = 'block';
    muteBtn.disabled = false;
    deafenBtn.disabled = false;
    pttToggleBtn.disabled = false;
    screenShareBtn.disabled = false;
    signalingUrlInput.disabled = true;
    roomIdInput.disabled = true;
    usernameInput.disabled = true;

    updatePeersList();
    
    // Save settings
    saveSettings(getCurrentSettings());
    
    // Start audio health check
    startAudioHealthCheck();
    
    // Start connection quality monitoring
    startConnectionQualityMonitoring();
    
  } catch (err) {
    console.error('Connection error:', err);
    updateStatus('disconnected', `Error: ${(err as Error).message}`);
    disconnect();
  }
}

/**
 * Disconnect from voice chat
 */
function disconnect() {
  console.log('Disconnecting...');
  
  // Stop audio health check
  stopAudioHealthCheck();
  
  // Stop connection quality monitoring
  stopConnectionQualityMonitoring();

  if (meshConnection) {
    meshConnection.disconnect();
    meshConnection = null;
  }

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  if (audioManager) {
    audioManager.cleanup();
  }

  connected = false;
  currentRoomId = null;
  updateStatus('disconnected', 'Disconnected');

  // Update UI
  connectBtn.style.display = 'block';
  connectBtn.disabled = false;
  disconnectBtn.style.display = 'none';
  muteBtn.disabled = true;
  deafenBtn.disabled = true;
  pttToggleBtn.disabled = true;
  screenShareBtn.disabled = true;
  signalingUrlInput.disabled = false;
  roomIdInput.disabled = false;
  usernameInput.disabled = false;
  
  // Stop screen sharing if active
  if (isScreenSharing) {
    stopScreenShare();
  }

  updatePeersList();
  
  // Clear speaking state
  peerSpeakingState.clear();
}

/**
 * Show source picker dialog
 */
function showSourcePicker(sources: any[]): Promise<any> {
  return new Promise((resolve) => {
    // Separate screens and windows
    const screens = sources.filter(s => s.id.startsWith('screen:'));
    const windows = sources.filter(s => s.id.startsWith('window:'));
    
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(10px);
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    `;
    
    // Create dialog
    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: var(--surface);
      border-radius: 16px;
      padding: 2rem;
      max-width: 900px;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      border: 2px solid var(--border-color);
    `;
    
    // Create header
    const header = document.createElement('h2');
    header.textContent = 'Choose what to share';
    header.style.cssText = `
      margin: 0 0 1.5rem 0;
      color: var(--text-primary);
      font-size: 1.5rem;
    `;
    dialog.appendChild(header);
    
    // Helper function to create source grid
    const createSourceGrid = (title: string, sourcesList: any[]) => {
      if (sourcesList.length === 0) return;
      
      const section = document.createElement('div');
      section.style.marginBottom = '2rem';
      
      const sectionTitle = document.createElement('h3');
      sectionTitle.textContent = title;
      sectionTitle.style.cssText = `
        margin: 0 0 1rem 0;
        color: var(--text-primary);
        font-size: 1.125rem;
        font-weight: 600;
      `;
      section.appendChild(sectionTitle);
      
      const grid = document.createElement('div');
      grid.style.cssText = `
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 1rem;
      `;
      
      sourcesList.forEach((source: any) => {
        const item = document.createElement('div');
        item.style.cssText = `
          cursor: pointer;
          border: 2px solid var(--border-color);
          border-radius: 12px;
          padding: 1rem;
          transition: all 0.2s;
          background: var(--surface-secondary);
        `;
        
        item.addEventListener('mouseenter', () => {
          item.style.borderColor = 'var(--accent)';
          item.style.transform = 'scale(1.05)';
        });
        
        item.addEventListener('mouseleave', () => {
          item.style.borderColor = 'var(--border-color)';
          item.style.transform = 'scale(1)';
        });
        
        item.addEventListener('click', () => {
          document.body.removeChild(overlay);
          resolve(source);
        });
        
        // Add thumbnail
        const img = document.createElement('img');
        img.src = source.thumbnail || '';
        img.style.cssText = `
          width: 100%;
          border-radius: 8px;
          margin-bottom: 0.5rem;
          background: #000;
        `;
        item.appendChild(img);
        
        // Add name
        const name = document.createElement('div');
        name.textContent = source.name;
        name.style.cssText = `
          color: var(--text-primary);
          font-size: 0.875rem;
          font-weight: 600;
          text-align: center;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        `;
        item.appendChild(name);
        
        grid.appendChild(item);
      });
      
      section.appendChild(grid);
      dialog.appendChild(section);
    };
    
    // Add screens section
    if (screens.length > 0) {
      createSourceGrid('🖥️ Entire Screens', screens);
    }
    
    // Add windows section
    if (windows.length > 0) {
      createSourceGrid('🪟 Application Windows', windows);
    }
    
    // Add cancel button
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'btn-danger';
    cancelBtn.style.cssText = `
      width: 100%;
      padding: 0.75rem;
      margin-top: 1rem;
    `;
    cancelBtn.addEventListener('click', () => {
      document.body.removeChild(overlay);
      resolve(null);
    });
    dialog.appendChild(cancelBtn);
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    
    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        document.body.removeChild(overlay);
        resolve(null);
      }
    });
  });
}

/**
 * Start screen sharing
 */
async function startScreenShare() {
  if (!connected || !meshConnection) {
    console.warn('Cannot share screen: not connected');
    alert('Please connect to a room first before sharing your screen.');
    return;
  }
  
  try {
    console.log('Requesting desktop sources...');
    
    // Check if electron API is available
    if (!window.electron?.ipcRenderer) {
      throw new Error('Electron IPC not available. This feature only works in the desktop app.');
    }
    
    // In Electron, we need to use desktopCapturer
    // @ts-ignore - electron API
    const sources = await window.electron.ipcRenderer.invoke('get-desktop-sources');
    
    console.log('Received sources:', sources);
    
    if (!sources || sources.length === 0) {
      throw new Error('No screen sources available. Please make sure you have at least one screen or window open.');
    }
    
    // Show source picker dialog
    const selectedSource = await showSourcePicker(sources);
    
    if (!selectedSource) {
      console.log('User cancelled source selection');
      return;
    }
    
    console.log('Selected source:', selectedSource.name, selectedSource.id);
    
    // Get quality settings
    const quality = qualityPresets[screenQuality];
    console.log(`Starting screen share with ${screenQuality} quality:`, quality);
    
    // Get the screen stream using the source ID
    screenStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        // @ts-ignore - Electron-specific constraint
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: selectedSource.id,
          minWidth: quality.width.ideal,
          maxWidth: quality.width.ideal,
          minHeight: quality.height.ideal,
          maxHeight: quality.height.ideal,
          maxFrameRate: quality.frameRate.max
        }
      }
    } as any);
    
    isScreenSharing = true;
    
    // Display local screen
    localScreenVideo.srcObject = screenStream;
    screenContainer.style.display = 'block';
    
    // Update button state
    screenShareBtn.textContent = '🖥️ Sharing...';
    screenShareBtn.className = 'btn-success';
    
    // Notify peers that screen is available (but don't send video yet)
    if (socket && currentRoomId) {
      console.log('DEBUG: Emitting screen-available event:', { roomId: currentRoomId, peerId: peerId });
      socket.emit('screen-available', {
        roomId: currentRoomId,
        peerId: peerId
      });
      console.log('Screen share available, waiting for viewers to request...');
    } else {
      console.error('DEBUG: Cannot emit screen-available - socket:', !!socket, 'currentRoomId:', currentRoomId);
    }
    
    // Handle stream end (user clicks browser's stop button)
    screenStream.getVideoTracks()[0].addEventListener('ended', () => {
      console.log('Screen sharing ended by user');
      stopScreenShare();
    });
    
    console.log('Screen sharing started');
  } catch (err) {
    console.error('Error starting screen share:', err);
    alert(`Could not start screen sharing: ${(err as Error).message}`);
  }
}

/**
 * Stop screen sharing
 */
function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }
  
  isScreenSharing = false;
  localScreenVideo.srcObject = null;
  screenContainer.style.display = 'none';
  
  // Update button state
  screenShareBtn.textContent = '🖥️ Share Screen';
  screenShareBtn.className = 'btn-primary';
  
  // Clear viewers list
  screenViewers.clear();
  
  // Notify peers and remove video tracks
  if (socket && connected && currentRoomId) {
    socket.emit('screen-unavailable', {
      roomId: currentRoomId,
      peerId: peerId
    });
  }
  
  // Remove video tracks from peer connections
  if (meshConnection && audioManager) {
    console.log('Removing screen video tracks from peer connections...');
    
    // Get audio-only stream
    const audioOnlyStream = audioManager.getLocalStream();
    if (audioOnlyStream) {
      // Update mesh connection back to audio only
      meshConnection.updateStream(audioOnlyStream);
      console.log('Removed screen sharing, back to audio only');
    }
  }
  
  console.log('Screen sharing stopped');
}

/**
 * Handle remote screen share
 */
function handleRemoteScreen(peerId: string, stream: MediaStream) {
  remoteScreens.set(peerId, stream);
  
  // Create or update the video element
  let screenItem = document.getElementById(`screen-${peerId}`);
  if (!screenItem) {
    screenItem = document.createElement('div');
    screenItem.id = `screen-${peerId}`;
    screenItem.className = 'remote-screen-item';
    screenItem.innerHTML = `
      <div class="screen-header">
        <span>${peerId}</span>
        <button class="fullscreen-btn" title="Full Screen">⛶</button>
      </div>
      <video autoplay playsinline></video>
    `;
    remoteScreensDiv.appendChild(screenItem);
    
    // Add full screen button handler  
    const fullscreenBtn = screenItem.querySelector('.fullscreen-btn') as HTMLButtonElement;
    const video = screenItem.querySelector('video') as HTMLVideoElement;
    
    fullscreenBtn.addEventListener('click', () => {
      console.log('Fullscreen button clicked!');
      
      // Toggle fullscreen class on the screen item container
      if (screenItem!.classList.contains('fullscreen-active')) {
        console.log('Exiting fullscreen mode');
        screenItem!.classList.remove('fullscreen-active');
        fullscreenBtn.textContent = '⛶'; // Enter fullscreen icon
      } else {
        console.log('Entering fullscreen mode');
        screenItem!.classList.add('fullscreen-active');
        fullscreenBtn.textContent = '⤓'; // Exit fullscreen icon
      }
    });
    
    // Also allow ESC key to exit fullscreen
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && screenItem!.classList.contains('fullscreen-active')) {
        screenItem!.classList.remove('fullscreen-active');
        fullscreenBtn.textContent = '⛶';
      }
    });
  }
  
  const video = screenItem.querySelector('video');
  if (video) {
    video.srcObject = stream;
  }
  
  remoteScreensContainer.style.display = 'block';
}

/**
 * Show screen available notification (not streaming yet)
 */
function showScreenAvailable(peerId: string) {
  remoteScreenAvailable.set(peerId, true);
  console.log(`DEBUG: showScreenAvailable called for ${peerId}`);
  console.log(`DEBUG: remoteScreenAvailable Map now has:`, Array.from(remoteScreenAvailable.keys()));
  
  // Update peers list to show the View Screen button as enabled
  updatePeersList();
}

/**
 * Request screen share from a peer
 */
function requestScreenShare(targetPeerId: string) {
  if (socket && currentRoomId) {
    console.log(`Requesting screen share from ${targetPeerId}`);
    socket.emit('request-screen', {
      roomId: currentRoomId,
      targetPeerId: targetPeerId,
      requesterPeerId: peerId
    });
    
    // Update UI
    updatePeersList();
  }
}

/**
 * Stop viewing a screen share
 */
function stopViewingScreen(targetPeerId: string) {
  if (socket && currentRoomId) {
    console.log(`Stopping screen view from ${targetPeerId}`);
    socket.emit('stop-request-screen', {
      roomId: currentRoomId,
      targetPeerId: targetPeerId,
      requesterPeerId: peerId
    });
  }
  
  // Remove the video element if it exists
  const screenItem = document.getElementById(`screen-${peerId}`);
  if (screenItem) {
    screenItem.remove();
  }
  
  // Remove from remoteScreens but keep in remoteScreenAvailable
  remoteScreens.delete(peerId);
  
  // Hide container if no videos playing
  if (remoteScreens.size === 0) {
    remoteScreensContainer.style.display = 'none';
  }
  
  // Update peers list button state
  updatePeersList();
}

/**
 * Remove remote screen
 */
function removeRemoteScreen(peerId: string) {
  remoteScreens.delete(peerId);
  remoteScreenAvailable.delete(peerId);
  screenViewers.delete(peerId);
  
  const screenItem = document.getElementById(`screen-${peerId}`);
  if (screenItem) {
    screenItem.remove();
  }
  
  // Hide container if no screens
  if (remoteScreens.size === 0) {
    remoteScreensContainer.style.display = 'none';
  }
  
  // Update peers list to grey out the button
  updatePeersList();
}

/**
 * Add screen video to a specific viewer
 */
function addScreenToViewer(viewerPeerId: string) {
  if (!screenStream || !meshConnection) {
    return;
  }
  
  screenViewers.add(viewerPeerId);
  console.log(`Adding screen video for viewer: ${viewerPeerId}`);
  
  // Get the peer connection
  const peerInfo = meshConnection.getPeer(viewerPeerId);
  if (!peerInfo) {
    console.error(`Peer ${viewerPeerId} not found`);
    return;
  }
  
  // Add only the video tracks to the existing peer connection
  // Audio tracks are already being sent, no need to touch them
  try {
    screenStream.getVideoTracks().forEach(track => {
      peerInfo.connection.addTrack(track, screenStream);
      console.log(`Added video track to ${viewerPeerId}`);
    });
    console.log(`Screen video added for ${viewerPeerId}`);
  } catch (err) {
    console.error(`Error adding screen to viewer ${viewerPeerId}:`, err);
  }
}

/**
 * Remove screen video from a specific viewer
 */
function removeScreenFromViewer(viewerPeerId: string) {
  if (!meshConnection || !screenStream) {
    return;
  }
  
  screenViewers.delete(viewerPeerId);
  console.log(`Removing screen video for viewer: ${viewerPeerId}`);
  
  // Get the peer connection
  const peerInfo = meshConnection.getPeer(viewerPeerId);
  if (!peerInfo) {
    return;
  }
  
  // Remove only the video tracks from the peer connection
  // Leave audio tracks alone
  try {
    screenStream.getVideoTracks().forEach(track => {
      const sender = peerInfo.connection['_pc']?.getSenders()?.find((s: RTCRtpSender) => s.track === track);
      if (sender) {
        peerInfo.connection.removeTrack(sender);
        console.log(`Removed video track from ${viewerPeerId}`);
      }
    });
    console.log(`Screen video removed for ${viewerPeerId}, back to audio only`);
  } catch (err) {
    console.error(`Error removing screen from viewer ${viewerPeerId}:`, err);
  }
}

/**
 * Handle audio device change while connected
 */
async function handleAudioDeviceChange() {
  if (!connected || !audioManager || !meshConnection) {
    return;
  }

  const deviceId = audioDeviceSelect.value;
  
  try {
    console.log('[App] Switching audio device:', deviceId || 'default');
    
    // Switch to the new device
    const newStream = await audioManager.switchInputDevice(deviceId || undefined);
    
    // Update the mesh connection with the new stream
    meshConnection.updateStream(newStream);
    
    console.log('[App] Audio device switched successfully');
  } catch (err) {
    console.error('[App] Error switching audio device:', err);
    updateStatus('connected', `Error switching audio device: ${(err as Error).message}`);
  }
}

/**
 * Toggle mute
 */
function toggleMute() {
  if (!audioManager) return;

  const muted = audioManager.toggleMute();
  
  if (muted) {
    muteBtn.textContent = '🔇 Muted';
    muteBtn.className = 'btn-muted';
  } else {
    muteBtn.textContent = '🎤 Unmuted';
    muteBtn.className = 'btn-success';
  }
}

/**
 * Toggle deafen
 */
function toggleDeafen() {
  if (!audioManager) return;

  const deafened = audioManager.toggleDeafen();
  
  if (deafened) {
    deafenBtn.textContent = '🔇 Deafened';
    deafenBtn.className = 'btn-muted';
  } else {
    deafenBtn.textContent = '🔊 Listening';
    deafenBtn.className = 'btn-success';
  }
}

/**
 * Toggle push-to-talk mode
 */
function togglePushToTalk() {
  pushToTalkEnabled = !pushToTalkEnabled;
  
  if (pushToTalkEnabled) {
    pttToggleBtn.textContent = '🔄 Push-to-Talk: ON';
    pttToggleBtn.className = 'btn-success';
    pttIndicator.classList.add('active');
    
    // Mute by default in PTT mode
    if (audioManager && !audioManager.isMuted()) {
      audioManager.setMuted(true);
    }
  } else {
    pttToggleBtn.textContent = '🔄 Push-to-Talk: OFF';
    pttToggleBtn.className = 'btn-primary';
    pttIndicator.classList.remove('active');
    pushToTalkActive = false;
    
    // Unmute when disabling PTT
    if (audioManager && audioManager.isMuted()) {
      audioManager.setMuted(false);
    }
    updateMuteButton();
  }
  
  saveSettings(getCurrentSettings());
}

/**
 * Handle push-to-talk key down
 */
function handlePushToTalkStart() {
  if (!pushToTalkEnabled || !audioManager || pushToTalkActive) return;
  
  pushToTalkActive = true;
  audioManager.setMuted(false);
  pttIndicator.textContent = '🎤 TALKING (Hold SPACE)';
  pttIndicator.style.background = '#10b981';
  pttIndicator.style.color = 'white';
}

/**
 * Handle push-to-talk key up
 */
function handlePushToTalkEnd() {
  if (!pushToTalkEnabled || !audioManager || !pushToTalkActive) return;
  
  pushToTalkActive = false;
  audioManager.setMuted(true);
  pttIndicator.textContent = 'Hold SPACE to talk';
  pttIndicator.style.background = '#fef3c7';
  pttIndicator.style.color = '#92400e';
}

/**
 * Update mute button state
 */
function updateMuteButton() {
  if (!audioManager) return;
  
  const muted = audioManager.isMuted();
  if (muted) {
    muteBtn.textContent = '🔇 Muted';
    muteBtn.className = 'btn-muted';
  } else {
    muteBtn.textContent = '🎤 Unmuted';
    muteBtn.className = 'btn-success';
  }
}

/**
 * Update audio settings
 */
async function updateAudioSettings() {
  if (!audioManager) return;
  
  const config = {
    echoCancellation: echoCancellationToggle.checked,
    noiseSuppression: noiseSuppressionToggle.checked,
    autoGainControl: autoGainControlToggle.checked
  };
  
  await audioManager.updateConfig(config);
  saveSettings(getCurrentSettings());
  console.log('Audio settings updated:', config);
}

/**
 * Keyboard shortcuts handler
 */
function handleKeyboard(event: KeyboardEvent) {
  // Don't handle shortcuts when typing in an input
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
    return;
  }
  
  switch (event.key.toLowerCase()) {
    case 'm':
      if (connected) toggleMute();
      break;
    case 'd':
      if (connected) toggleDeafen();
      break;
    case 'escape':
      if (connected) disconnect();
      break;
    case ' ':
      if (event.type === 'keydown' && connected) {
        event.preventDefault();
        handlePushToTalkStart();
      } else if (event.type === 'keyup' && connected) {
        event.preventDefault();
        handlePushToTalkEnd();
      }
      break;
  }
}

// Event listeners
connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);
muteBtn.addEventListener('click', toggleMute);
deafenBtn.addEventListener('click', toggleDeafen);
pttToggleBtn.addEventListener('click', togglePushToTalk);
themeToggleBtn.addEventListener('click', toggleTheme);

// Screen sharing listeners
screenShareBtn.addEventListener('click', () => {
  if (isScreenSharing) {
    stopScreenShare();
  } else {
    startScreenShare();
  }
});
stopScreenBtn.addEventListener('click', stopScreenShare);

// Screen quality selector
screenQualitySelect.addEventListener('change', () => {
  screenQuality = screenQualitySelect.value as typeof screenQuality;
  console.log(`Screen quality changed to: ${screenQuality}`);
  
  // If currently sharing, inform user they need to restart sharing for quality to take effect
  if (isScreenSharing) {
    alert('Quality will be applied when you restart screen sharing.');
  }
});

// Audio settings listeners
echoCancellationToggle.addEventListener('change', updateAudioSettings);
noiseSuppressionToggle.addEventListener('change', updateAudioSettings);
autoGainControlToggle.addEventListener('change', updateAudioSettings);

// Audio device change listener
audioDeviceSelect.addEventListener('change', handleAudioDeviceChange);

// Settings panel toggle
const settingsToggle = document.getElementById('settings-toggle') as HTMLDivElement;
const settingsContent = document.getElementById('settings-content') as HTMLDivElement;
const settingsArrow = settingsToggle?.querySelector('.settings-arrow') as HTMLSpanElement;

settingsToggle?.addEventListener('click', () => {
  const isExpanded = settingsContent.classList.contains('expanded');
  if (isExpanded) {
    settingsContent.classList.remove('expanded');
    settingsArrow.classList.remove('expanded');
  } else {
    settingsContent.classList.add('expanded');
    settingsArrow.classList.add('expanded');
  }
});

// Keyboard shortcuts
document.addEventListener('keydown', handleKeyboard);
document.addEventListener('keyup', handleKeyboard);

// Load saved settings
const savedSettings = loadSettings();
signalingUrlInput.value = savedSettings.signalingUrl;
usernameInput.value = savedSettings.username || defaultUsername;
echoCancellationToggle.checked = savedSettings.echoCancellation;
noiseSuppressionToggle.checked = savedSettings.noiseSuppression;
autoGainControlToggle.checked = savedSettings.autoGainControl;
pushToTalkEnabled = savedSettings.pushToTalkEnabled;

if (pushToTalkEnabled) {
  pttToggleBtn.textContent = '🔄 Push-to-Talk: ON';
  pttToggleBtn.className = 'btn-success';
  pttIndicator.classList.add('active');
}

// Save settings when inputs change
signalingUrlInput.addEventListener('change', () => saveSettings(getCurrentSettings()));
usernameInput.addEventListener('change', () => saveSettings(getCurrentSettings()));

// Initialize theme
initTheme();

// Initialize on load
initAudioManager().then(() => {
  console.log('Audio manager initialized');
});

// Cleanup on window close
window.addEventListener('beforeunload', () => {
  if (connected) {
    disconnect();
  }
});

// ============================================================================
// Auto-Update Handlers
// ============================================================================

let updateInfo: any = null;

/**
 * Show update banner
 */
function showUpdateBanner(title: string, message: string, showDownload: boolean = false, showInstall: boolean = false) {
  updateBannerTitle.textContent = title;
  updateBannerMessage.textContent = message;
  updateDownloadBtn.style.display = showDownload ? 'block' : 'none';
  updateInstallBtn.style.display = showInstall ? 'block' : 'none';
  updateBanner.classList.add('visible');
}

/**
 * Hide update banner
 */
function hideUpdateBanner() {
  updateBanner.classList.remove('visible');
  updateProgress.style.width = '0%';
}

/**
 * Handle update status from main process
 */
if (window.electron?.ipcRenderer) {
  window.electron.ipcRenderer.on('update-status', (payload: { event: string; data?: any }) => {
    const { event, data } = payload;
    console.log('Update event:', event, data);

    switch (event) {
      case 'checking-for-update':
        console.log('Checking for updates...');
        break;

      case 'update-available':
        updateInfo = data;
        showUpdateBanner(
          '🎉 Update Available!',
          `Version ${data.version} is available. Click to download.`,
          true,
          false
        );
        break;

      case 'update-not-available':
        console.log('App is up to date');
        break;

      case 'download-progress':
        const percent = Math.round(data.percent);
        updateProgress.style.width = `${percent}%`;
        updateBannerMessage.textContent = `Downloading update... ${percent}%`;
        break;

      case 'update-downloaded':
        updateProgress.style.width = '100%';
        showUpdateBanner(
          '✅ Update Ready!',
          'Update has been downloaded. Restart to install.',
          false,
          true
        );
        break;

      case 'update-error':
        console.error('Update error:', data.message);
        showUpdateBanner(
          '❌ Update Failed',
          `Error: ${data.message}`,
          false,
          false
        );
        setTimeout(hideUpdateBanner, 5000);
        break;
    }
  });

  // Download button handler
  updateDownloadBtn.addEventListener('click', async () => {
    updateDownloadBtn.disabled = true;
    updateDownloadBtn.textContent = 'Downloading...';
    try {
      await window.electron!.ipcRenderer.invoke('download-update');
    } catch (err) {
      console.error('Failed to download update:', err);
      updateDownloadBtn.disabled = false;
      updateDownloadBtn.textContent = 'Download';
    }
  });

  // Install button handler
  updateInstallBtn.addEventListener('click', async () => {
    try {
      await window.electron!.ipcRenderer.invoke('install-update');
    } catch (err) {
      console.error('Failed to install update:', err);
    }
  });

  // Dismiss button handler
  updateDismissBtn.addEventListener('click', () => {
    hideUpdateBanner();
  });

  // Get and display app version
  window.electron.ipcRenderer.invoke('get-app-version').then((version: string) => {
    console.log('App version:', version);
    // You could display this in the UI if desired
  });
}

console.log('Voice Chat P2P client initialized');
console.log('Peer ID:', peerId);

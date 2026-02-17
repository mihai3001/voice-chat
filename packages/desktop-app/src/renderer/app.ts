import { MeshConnection, AudioManager, ChatManager, ChatMessage } from '@voice-chat/client-core';

// Socket.io loaded from CDN
declare const io: any;
type Socket = any;

// State
let socket: Socket | null = null;
let meshConnection: MeshConnection | null = null;
let audioManager: AudioManager | null = null;
let chatManager: ChatManager | null = null;
let connected = false;
let pushToTalkEnabled = false;
let pushToTalkActive = false;
let currentRoomId: string | null = null;
let isMuted = false;
let isDeafened = false;

// Screen sharing state
let screenStream: MediaStream | null = null;
let isScreenSharing = false;
const remoteScreens = new Map<string, MediaStream>();
const remoteScreenAvailable = new Map<string, boolean>(); // Track who's sharing (but not necessarily streaming to us)
const screenViewers = new Set<string>(); // Track who's viewing our screen
let screenQuality: '720p15' | '720p30' | '720p60' | '1080p30' | '1080p60' | '1080p144' | '1440p60' | '1440p144' | '4k60' = '1080p30';

// Quality presets for screen sharing (keys match dropdown values)
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

// Notification sounds (simple Web Audio API tones)
const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

function playNotificationSound(type: 'message' | 'join' | 'leave' | 'mute') {
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  
  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  
  // Configure sound based on type
  switch (type) {
    case 'message':
      // Two quick beeps (Discord-like)
      oscillator.frequency.value = 600;
      gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.1);
      
      // Second beep
      setTimeout(() => {
        const osc2 = audioContext.createOscillator();
        const gain2 = audioContext.createGain();
        osc2.connect(gain2);
        gain2.connect(audioContext.destination);
        osc2.frequency.value = 750;
        gain2.gain.setValueAtTime(0.1, audioContext.currentTime);
        gain2.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
        osc2.start(audioContext.currentTime);
        osc2.stop(audioContext.currentTime + 0.1);
      }, 100);
      break;
      
    case 'join':
      // Rising tone
      oscillator.frequency.setValueAtTime(400, audioContext.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(600, audioContext.currentTime + 0.15);
      gainNode.gain.setValueAtTime(0.15, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.15);
      break;
      
    case 'leave':
      // Falling tone
      oscillator.frequency.setValueAtTime(600, audioContext.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(400, audioContext.currentTime + 0.15);
      gainNode.gain.setValueAtTime(0.15, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.15);
      break;
      
    case 'mute':
      // Short single beep
      oscillator.frequency.value = 500;
      gainNode.gain.setValueAtTime(0.12, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.08);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.08);
      break;
  }
}

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
const audioInputDeviceSelect = document.getElementById('audio-input-device') as HTMLSelectElement;
const audioOutputDeviceSelect = document.getElementById('audio-output-device') as HTMLSelectElement;
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
const userAvatar = document.getElementById('user-avatar') as HTMLDivElement;
const speakingIndicator = document.getElementById('speaking-indicator') as HTMLSpanElement;

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

// Chat elements
const chatMessages = document.getElementById('chat-messages') as HTMLDivElement;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const chatSendBtn = document.getElementById('chat-send-btn') as HTMLButtonElement;
const chatImageBtn = document.getElementById('chat-image-btn') as HTMLButtonElement;
const chatImageInput = document.getElementById('chat-image-input') as HTMLInputElement;
const chatEmptyState = document.getElementById('chat-empty-state') as HTMLDivElement;

// View elements
const disconnectedView = document.getElementById('disconnected-view') as HTMLDivElement;
const connectedView = document.getElementById('connected-view') as HTMLDivElement;
const rightSidebar = document.getElementById('right-sidebar') as HTMLDivElement;
const leftSidebar = document.getElementById('left-sidebar') as HTMLDivElement;
const mainContent = document.getElementById('main-content') as HTMLDivElement;
const centeredConnection = document.getElementById('centered-connection') as HTMLDivElement;

// User info elements
const currentUsername = document.getElementById('current-username') as HTMLDivElement;
const userStatus = document.getElementById('user-status') as HTMLDivElement;

// Settings modal
const settingsModal = document.getElementById('settings-modal') as HTMLDivElement;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
const settingsBtnMain = document.getElementById('settings-btn-main') as HTMLButtonElement;
const settingsCloseBtn = document.getElementById('settings-close-btn') as HTMLButtonElement;
// Theme toggle removed - always dark mode

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

// Theme management (dark mode only)
function applyTheme(): void {
  // Always use dark theme
  document.documentElement.setAttribute('data-theme', 'dark');
}

function toggleTheme(): void {
  // Theme toggle disabled - always dark mode
}

// Initialize theme on load
function initTheme(): void {
  applyTheme();
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
  const outputDevices = devices.filter(d => d.kind === 'audiooutput');
  
  // Update input devices
  audioInputDeviceSelect.innerHTML = '<option value="">Default</option>';
  inputDevices.forEach(device => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label;
    audioInputDeviceSelect.appendChild(option);
  });

  // Update output devices
  audioOutputDeviceSelect.innerHTML = '<option value="">Default</option>';
  outputDevices.forEach(device => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label;
    audioOutputDeviceSelect.appendChild(option);
  });
}

/**
 * Update connection status UI
 */
function updateStatus(status: 'disconnected' | 'connecting' | 'connected', message: string) {
  statusDiv.className = `status status-${status}`;
  statusMessage.textContent = message;
  
  // Update user status
  if (status === 'connected') {
    userStatus.textContent = 'Online';
  } else if (status === 'connecting') {
    userStatus.textContent = 'Connecting...';
  } else {
    userStatus.textContent = 'Offline';
  }
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
        <div class="peer-header">
          <div class="peer-info">
            <div class="peer-indicator ${peer.connected ? (isSpeaking ? 'speaking' : 'connected') : ''}"></div>
            <span><strong>${peer.username || peer.peerId}</strong></span>
            ${isHost ? '<span class="host-badge">HOST</span>' : ''}
            ${isSpeaking ? '<span style="font-size: 12px;">🎤</span>' : ''}
          </div>
          <div class="peer-status-line">
            <span style="font-size: 11px; color: var(--text-tertiary);">
              ${peer.connected ? `${connectionLabel ? connectionIcon + ' ' + connectionLabel : '🔊 Connected'}` : '⏳ Connecting...'}
            </span>
            ${peer.connected ? qualityBars : ''}
          </div>
        </div>
        <div class="peer-actions">
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
    const deviceId = audioInputDeviceSelect.value;
    
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
    const deviceId = audioInputDeviceSelect.value;
    
    // Update user display
    currentUsername.textContent = username;

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
      playNotificationSound('join');
      updatePeersList();
    });

    meshConnection.onPeerLeft((peerId) => {
      console.log(`Peer left: ${peerId}`);
      playNotificationSound('leave');
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

    // Enable chat
    chatInput.disabled = false;
    chatInput.placeholder = 'Message #general-chat';
    chatSendBtn.disabled = false;
    chatImageBtn.disabled = false;
    chatEmptyState.classList.add('hidden');

    // Initialize button states
    updateMuteButton();
    updateDeafenButton();

    // Switch to connected view
    centeredConnection.style.display = 'none';
    leftSidebar.style.display = 'flex';
    mainContent.style.display = 'flex';
    disconnectedView.style.display = 'none';
    connectedView.style.display = 'flex';
    rightSidebar.style.display = 'flex';

    updatePeersList();
    
    // Save settings
    saveSettings(getCurrentSettings());
    
    // Start audio health check
    startAudioHealthCheck();
    
    // Start connection quality monitoring
    startConnectionQualityMonitoring();
    
    // Setup local voice activity detection
    setupLocalVoiceActivity();
    
    // Initialize chat
    initializeChat();
    
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
  
  // Stop local voice activity detection
  cleanupLocalVoiceActivity();
  
  // Cleanup chat
  cleanupChat();

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
  
  // Disable chat
  chatInput.disabled = true;
  chatInput.placeholder = 'Connect to start chatting';
  chatSendBtn.disabled = true;
  chatImageBtn.disabled = true;
  chatEmptyState.classList.remove('hidden');
  
  // Switch to disconnected view
  centeredConnection.style.display = 'flex';
  leftSidebar.style.display = 'none';
  mainContent.style.display = 'none';
  disconnectedView.style.display = 'none';
  connectedView.style.display = 'none';
  rightSidebar.style.display = 'none';
  
  // Stop screen sharing if active
  if (isScreenSharing) {
    stopScreenShare();
  }

  updatePeersList();
  
  // Clear speaking state
  peerSpeakingState.clear();
  
  // Reset user display
  currentUsername.textContent = 'User';
  
  // Clear all remote screens
  const remoteScreenPeerIds = Array.from(remoteScreens.keys());
  remoteScreenPeerIds.forEach(peerId => removeRemoteScreen(peerId));
  
  // Clear screen availability tracking
  remoteScreenAvailable.clear();
  screenViewers.clear();
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
    
    if (!quality) {
      console.error(`Invalid screen quality preset: ${screenQuality}`);
      throw new Error(`Invalid quality preset: ${screenQuality}`);
    }
    
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
  // Remove screen stream from all viewer peer connections BEFORE stopping tracks
  if (meshConnection && screenStream) {
    console.log('Removing screen stream from all viewers...');
    for (const viewerPeerId of screenViewers) {
      const peerInfo = meshConnection.getPeer(viewerPeerId);
      if (peerInfo) {
        try {
          peerInfo.connection.removeStream(screenStream);
        } catch (err) {
          console.error(`Error removing screen from ${viewerPeerId}:`, err);
        }
      }
    }
  }

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
  
  // Notify peers
  if (socket && connected && currentRoomId) {
    socket.emit('screen-unavailable', {
      roomId: currentRoomId,
      peerId: peerId
    });
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
        <button class="fullscreen-close-btn" title="Close" style="display: none;">✕</button>
      </div>
      <video autoplay playsinline></video>
    `;
    remoteScreensDiv.appendChild(screenItem);
    
    // Add full screen button handlers
    const fullscreenBtn = screenItem.querySelector('.fullscreen-btn') as HTMLButtonElement;
    const fullscreenCloseBtn = screenItem.querySelector('.fullscreen-close-btn') as HTMLButtonElement;
    const video = screenItem.querySelector('video') as HTMLVideoElement;
    
    const exitFullscreen = () => {
      console.log('Exiting fullscreen mode');
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      screenItem!.classList.remove('fullscreen-active');
      fullscreenBtn.style.display = 'block';
      fullscreenCloseBtn.style.display = 'none';
    };
    
    const enterFullscreen = () => {
      console.log('Entering fullscreen mode');
      screenItem!.classList.add('fullscreen-active');
      fullscreenBtn.style.display = 'none';
      fullscreenCloseBtn.style.display = 'block';
      // Use native Fullscreen API for true fullscreen
      screenItem!.requestFullscreen().catch((err: Error) => {
        console.warn('Could not enter fullscreen:', err);
      });
    };
    
    fullscreenBtn.addEventListener('click', () => {
      enterFullscreen();
    });
    
    fullscreenCloseBtn.addEventListener('click', () => {
      exitFullscreen();
    });
    
    // Listen for native fullscreen exit (ESC key handled by browser)
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && screenItem!.classList.contains('fullscreen-active')) {
        screenItem!.classList.remove('fullscreen-active');
        fullscreenBtn.style.display = 'block';
        fullscreenCloseBtn.style.display = 'none';
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
  
  // Add the screen stream as a separate stream (SimplePeer supports multiple streams)
  try {
    peerInfo.connection.addStream(screenStream);
    console.log(`Screen stream added for ${viewerPeerId}`);
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
  
  // Remove the screen stream from the peer connection
  try {
    peerInfo.connection.removeStream(screenStream);
    console.log(`Screen stream removed for ${viewerPeerId}`);
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

  const deviceId = audioInputDeviceSelect.value;
  
  try {
    console.log('[App] Switching audio device:', deviceId || 'default');
    
    // Switch to the new device
    const newStream = await audioManager.switchInputDevice(deviceId || undefined);
    
    // Update the mesh connection with the new stream
    meshConnection.updateStream(newStream);
    
    // Restart local voice activity detection
    setupLocalVoiceActivity();
    
    console.log('[App] Audio device switched successfully');
  } catch (err) {
    console.error('[App] Error switching audio device:', err);
    updateStatus('connected', `Error switching audio device: ${(err as Error).message}`);
  }
}

/**
 * Handle audio output device change
 */
async function handleAudioOutputDeviceChange() {
  const deviceId = audioOutputDeviceSelect.value;
  
  try {
    console.log('[App] Switching audio output device:', deviceId || 'default');
    
    if (audioManager) {
      await audioManager.setOutputDevice(deviceId || '');
    }
    
    console.log('[App] Audio output device switched successfully');
  } catch (err) {
    console.error('[App] Error switching audio output device:', err);
  }
}

let localVoiceActivityInterval: number | null = null;
let localVoiceAudioContext: AudioContext | null = null;

/**
 * Setup local voice activity detection
 */
function setupLocalVoiceActivity() {
  // Clean up existing resources
  cleanupLocalVoiceActivity();

  if (!audioManager || !connected) {
    return;
  }

  // Get the local audio stream
  const stream = audioManager.getLocalStream();
  if (!stream) return;

  try {
    localVoiceAudioContext = new AudioContext();
    const analyser = localVoiceAudioContext.createAnalyser();
    analyser.fftSize = 256;
    const source = localVoiceAudioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    // Check voice activity every 100ms
    localVoiceActivityInterval = window.setInterval(() => {
      if (isMuted || isDeafened) {
        // Hide indicator when muted/deafened
        if (speakingIndicator.style.display !== 'none') {
          speakingIndicator.style.display = 'none';
          userAvatar.classList.remove('speaking');
        }
        return;
      }

      analyser.getByteFrequencyData(dataArray);
      
      // Calculate average volume
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const average = sum / bufferLength;
      
      // Threshold for detecting speech
      const threshold = 20;
      const isSpeaking = average > threshold;
      
      if (isSpeaking) {
        speakingIndicator.style.display = 'block';
        userAvatar.classList.add('speaking');
      } else {
        speakingIndicator.style.display = 'none';
        userAvatar.classList.remove('speaking');
      }
    }, 100);
  } catch (err) {
    console.error('[App] Error setting up voice activity detection:', err);
  }
}

/**
 * Clean up local voice activity detection
 */
function cleanupLocalVoiceActivity() {
  if (localVoiceActivityInterval) {
    clearInterval(localVoiceActivityInterval);
    localVoiceActivityInterval = null;
  }
  if (localVoiceAudioContext && localVoiceAudioContext.state !== 'closed') {
    localVoiceAudioContext.close().catch(() => {});
    localVoiceAudioContext = null;
  }
  speakingIndicator.style.display = 'none';
  userAvatar.classList.remove('speaking');
}

/**
 * Toggle mute
 */
function toggleMute() {
  if (!audioManager) return;

  isMuted = audioManager.toggleMute();
  
  // Play mute sound
  if (isMuted) {
    playNotificationSound('mute');
  }
  
  updateMuteButton();
}

/**
 * Update mute button state and icon
 */
function updateMuteButton() {
  if (isMuted) {
    muteBtn.classList.add('muted');
    muteBtn.classList.remove('active');
    muteBtn.innerHTML = '<span class="voice-icon">🔇</span>'; // Muted icon
    muteBtn.title = 'Unmute';
  } else {
    muteBtn.classList.remove('muted');
    muteBtn.classList.add('active');
    muteBtn.innerHTML = '<span class="voice-icon">🎤</span>'; // Mic icon
    muteBtn.title = 'Mute';
  }
}

/**
 * Toggle deafen
 */
function toggleDeafen() {
  if (!audioManager) return;

  isDeafened = audioManager.toggleDeafen();
  
  updateDeafenButton();
}

/**
 * Update deafen button state and icon
 */
function updateDeafenButton() {
  if (isDeafened) {
    deafenBtn.classList.add('muted');
    deafenBtn.classList.remove('active');
    deafenBtn.innerHTML = '<span class="voice-icon">🔇</span>'; // Deafened icon
    deafenBtn.title = 'Undeafen';
  } else {
    deafenBtn.classList.remove('muted');
    deafenBtn.classList.add('active');
    deafenBtn.innerHTML = '<span class="voice-icon">🔊</span>'; // Speaker icon
    deafenBtn.title = 'Deafen';
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
// themeToggleBtn removed - always dark mode

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
audioInputDeviceSelect.addEventListener('change', handleAudioDeviceChange);
audioOutputDeviceSelect.addEventListener('change', handleAudioOutputDeviceChange);

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

// Settings modal
settingsBtn.addEventListener('click', () => {
  settingsModal.style.display = 'flex';
});

settingsBtnMain.addEventListener('click', () => {
  settingsModal.style.display = 'flex';
});

settingsCloseBtn.addEventListener('click', () => {
  settingsModal.style.display = 'none';
});

// Close modal on overlay click
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) {
    settingsModal.style.display = 'none';
  }
});

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsModal.style.display === 'flex') {
    settingsModal.style.display = 'none';
    e.preventDefault();
  }
});

// Chat event listeners
chatSendBtn.addEventListener('click', sendTextMessage);

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendTextMessage();
  }
});

chatImageBtn.addEventListener('click', () => {
  chatImageInput.click();
});

chatImageInput.addEventListener('change', () => {
  const file = chatImageInput.files?.[0];
  if (file) {
    sendImageMessage(file);
    chatImageInput.value = ''; // Reset input
  }
});

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
// Chat Functions
// ============================================================================

/**
 * Initialize chat manager
 */
function initializeChat() {
  if (!meshConnection || !currentRoomId) {
    console.error('Cannot initialize chat: missing mesh connection or room ID');
    return;
  }

  chatManager = new ChatManager({
    roomId: currentRoomId,
    peerId,
    username: usernameInput.value || defaultUsername,
    meshConnection,
    storageType: 'local'
  });

  // Handle incoming messages
  chatManager.onMessage(handleChatMessage);

  // Load message history
  loadChatHistory();

  // Enable chat interface
  chatInput.disabled = false;
  chatSendBtn.disabled = false;
  chatImageBtn.disabled = false;

  console.log('Chat initialized');
}

/**
 * Handle incoming chat message
 */
function handleChatMessage(message: ChatMessage) {
  addMessageToUI(message);

  // Play sound for incoming messages (not own)
  if (message.senderId !== peerId) {
    playNotificationSound('message');
  }

  // Scroll to bottom
  setTimeout(() => {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }, 100);
}

/**
 * Load chat history from storage
 */
async function loadChatHistory() {
  if (!chatManager) return;

  try {
    const messages = await chatManager.getMessages(50);
    
    // Clear existing messages
    chatMessages.innerHTML = '';

    if (messages.length === 0) {
      chatMessages.innerHTML = '<div class="chat-empty"><p>No messages yet. Start the conversation!</p></div>';
      return;
    }

    // Add messages to UI
    messages.forEach(message => addMessageToUI(message, false));

    // Scroll to bottom
    setTimeout(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }, 100);
  } catch (err) {
    console.error('Failed to load chat history:', err);
  }
}

/**
 * Add message to UI
 */
function addMessageToUI(message: ChatMessage, animate: boolean = true) {
  // Remove empty state if present
  const emptyState = chatMessages.querySelector('.chat-empty');
  if (emptyState) {
    emptyState.remove();
  }

  const messageEl = document.createElement('div');
  messageEl.className = `chat-message ${message.senderId === peerId ? 'own' : ''}`;
  if (!animate) messageEl.style.animation = 'none';

  const header = document.createElement('div');
  header.className = 'chat-message-header';

  const author = document.createElement('span');
  author.className = 'chat-message-author';
  author.textContent = message.senderUsername;

  const time = document.createElement('span');
  time.className = 'chat-message-time';
  time.textContent = formatTime(message.timestamp);

  header.appendChild(author);
  header.appendChild(time);

  const content = document.createElement('div');
  content.className = 'chat-message-content';

  if (message.type === 'text') {
    // Convert URLs to clickable links and preserve formatting
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const textWithLinks = message.content.replace(urlRegex, (url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${url}</a>`;
    });
    
    // Replace newlines with <br>
    const formattedText = textWithLinks.replace(/\n/g, '<br>');
    content.innerHTML = formattedText;
  } else if (message.type === 'image') {
    const img = document.createElement('img');
    img.src = message.content;
    img.className = 'chat-message-image';
    img.alt = message.metadata?.fileName || 'Image';
    img.onclick = () => {
      // Open image in new window
      window.open(message.content, '_blank');
    };
    content.appendChild(img);
  }

  messageEl.appendChild(header);
  messageEl.appendChild(content);

  chatMessages.appendChild(messageEl);
}

/**
 * Send text message
 */
async function sendTextMessage() {
  const text = chatInput.value.trim();
  if (!text || !chatManager) return;

  try {
    await chatManager.sendTextMessage(text);
    chatInput.value = '';
  } catch (err) {
    console.error('Failed to send message:', err);
    alert('Failed to send message');
  }
}

/**
 * Send image message
 */
async function sendImageMessage(file: File) {
  if (!chatManager) return;

  try {
    await chatManager.sendImageMessage(file);
  } catch (err: any) {
    console.error('Failed to send image:', err);
    alert(err.message || 'Failed to send image');
  }
}

/**
 * Format timestamp
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  // Less than 1 minute
  if (diff < 60000) {
    return 'Just now';
  }

  // Less than 1 hour
  if (diff < 3600000) {
    const minutes = Math.floor(diff / 60000);
    return `${minutes}m ago`;
  }

  // Today
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  // Older
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Cleanup chat
 */
function cleanupChat() {
  if (chatManager) {
    chatManager.cleanup();
    chatManager = null;
  }

  chatMessages.innerHTML = '<div class="chat-empty"><p>Connect to a room to start chatting</p></div>';
  chatInput.disabled = true;
  chatSendBtn.disabled = true;
  chatImageBtn.disabled = true;
  chatInput.value = '';
}

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

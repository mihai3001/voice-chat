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
let currentRoomId: string | null = null;
let isMuted = false;
let isDeafened = false;
let inputMonitoringNode: GainNode | null = null;

// Screen sharing state
let screenStream: MediaStream | null = null;
let isScreenSharing = false;
const remoteScreens = new Map<string, MediaStream>();
const remoteScreenAvailable = new Map<string, boolean>(); // Track who's sharing (but not necessarily streaming to us)
const screenViewers = new Set<string>(); // Track who's viewing our screen
const screenTracksAdded = new Set<string>(); // Track which peers have screen tracks added to their connection
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

// Detailed connection stats per peer
interface PeerStats {
  rtt: number;          // Round trip time in ms
  packetLoss: number;   // Packet loss rate (0-1)
  bitrate: number;      // Current bitrate in kbps
}
const peerDetailedStats = new Map<string, PeerStats>();

// Bandwidth tracking
let totalBytesSent = 0;
let totalBytesReceived = 0;
let lastBandwidthCheck = 0;
let currentUploadBandwidth = 0;   // kbps
let currentDownloadBandwidth = 0; // kbps

// Audio health check
let audioHealthCheckInterval: NodeJS.Timeout | null = null;
let isReconnectingAudio = false;

// Auto-reconnect state
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 3000; // 3 seconds
const RECONNECT_STATUS_DELAY_MS = 3000; // Only show reconnecting status after 3 seconds
let reconnectTimeout: NodeJS.Timeout | null = null;
let reconnectingStatusTimeout: NodeJS.Timeout | null = null;
let isReconnecting = false;
let reconnectData: { signalingUrl: string; roomId: string; username: string } | null = null;

// Spatial audio state
let spatialAudioEnabled = false;
let spatialAudioContext: AudioContext | null = null;
const spatialPanners = new Map<string, { panner: PannerNode; source: MediaStreamAudioSourceNode; gain: GainNode }>();

// Generate a unique peer ID
const peerId = `peer_${Math.random().toString(36).substr(2, 9)}_${Date.now()}`;
console.log('[APP] Generated peer ID:', peerId);

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
const copyLinkBtn = document.getElementById('copy-link-btn') as HTMLButtonElement;
const muteBtn = document.getElementById('mute-btn') as HTMLButtonElement;
const deafenBtn = document.getElementById('deafen-btn') as HTMLButtonElement;
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
const inputMonitoringToggle = document.getElementById('input-monitoring') as HTMLInputElement;
const voiceSensitivitySlider = document.getElementById('voice-sensitivity') as HTMLInputElement;
const voiceSensitivityValue = document.getElementById('voice-sensitivity-value') as HTMLSpanElement;
const spatialAudioToggle = document.getElementById('spatial-audio') as HTMLInputElement;
const colorSchemeSelect = document.getElementById('color-scheme') as HTMLSelectElement;
const smoothTransitionsToggle = document.getElementById('smooth-transitions') as HTMLInputElement;
const animatedWaveformsToggle = document.getElementById('animated-waveforms') as HTMLInputElement;
const fadeEffectsToggle = document.getElementById('fade-effects') as HTMLInputElement;
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
const screenSharingList = document.getElementById('screen-sharing-list') as HTMLDivElement;
const screenSharers = document.getElementById('screen-sharers') as HTMLDivElement;

// Bandwidth stats elements
const bandwidthStats = document.getElementById('bandwidth-stats') as HTMLDivElement;
const uploadBandwidth = document.getElementById('upload-bandwidth') as HTMLSpanElement;
const downloadBandwidth = document.getElementById('download-bandwidth') as HTMLSpanElement;

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
const chatEmptyState = document.getElementById('chat-empty-state') as HTMLDivElement;

// Chat state
let attachedImage: File | null = null;

// View elements
const disconnectedView = document.getElementById('disconnected-view') as HTMLDivElement;
const connectedView = document.getElementById('connected-view') as HTMLDivElement;
const rightSidebar = document.getElementById('right-sidebar') as HTMLDivElement;
const leftSidebar = document.getElementById('left-sidebar') as HTMLDivElement;
const mainContent = document.getElementById('main-content') as HTMLDivElement;
const centeredConnection = document.getElementById('centered-connection') as HTMLDivElement;
const leftResizeHandle = document.getElementById('left-resize-handle') as HTMLDivElement;
const rightResizeHandle = document.getElementById('right-resize-handle') as HTMLDivElement;

// User info elements
const currentUsername = document.getElementById('current-username') as HTMLDivElement;
const userStatus = document.getElementById('user-status') as HTMLDivElement;

// Settings modal
const settingsModal = document.getElementById('settings-modal') as HTMLDivElement;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
const settingsBtnMain = document.getElementById('settings-btn-main') as HTMLButtonElement;
const settingsCloseBtn = document.getElementById('settings-close-btn') as HTMLButtonElement;
const fabSettings = document.getElementById('fab-settings') as HTMLButtonElement;

// Connect page elements
const toggleAdvancedBtn = document.getElementById('toggle-advanced-btn') as HTMLButtonElement;
const advancedSection = document.getElementById('advanced-section') as HTMLDivElement;
const recentRoomsList = document.getElementById('recent-rooms-list') as HTMLDivElement;
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

// Theme management (deprecated - now using color scheme system)
function applyTheme(): void {
  // No-op: Color scheme is now handled by changeColorScheme() and saved settings
}

function toggleTheme(): void {
  // No-op: Theme toggle disabled
}

// Initialize theme on load (deprecated)
function initTheme(): void {
  // No-op: Color scheme is applied when loading saved settings
}

// Settings persistence
interface Settings {
  signalingUrl: string;
  username: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  voiceSensitivity: number;
  inputMonitoring: boolean;
  spatialAudio: boolean;
  colorScheme: string;
}

function loadSettings(): Settings {
  const defaults: Settings = {
    signalingUrl: 'https://voice-chat-signaling-production.up.railway.app',
    username: defaultUsername,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    voiceSensitivity: -45,
    inputMonitoring: false,
    spatialAudio: false,
    colorScheme: 'default'
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
    voiceSensitivity: parseInt(voiceSensitivitySlider.value),
    inputMonitoring: inputMonitoringToggle.checked,
    spatialAudio: spatialAudioToggle.checked,
    colorScheme: colorSchemeSelect.value
  };
}

/**
 * Save a room to recent rooms list
 */
function saveRecentRoom(roomId: string): void {
  try {
    const recentRooms = JSON.parse(localStorage.getItem('recentRooms') || '[]');
    const room = {
      id: roomId,
      timestamp: Date.now()
    };
    
    // Remove existing entry if present
    const filtered = recentRooms.filter((r: any) => r.id !== roomId);
    
    // Add to beginning and limit to 5 rooms
    filtered.unshift(room);
    const limited = filtered.slice(0, 5);
    
    localStorage.setItem('recentRooms', JSON.stringify(limited));
  } catch (err) {
    console.error('Error saving recent room:', err);
  }
}

/**
 * Load recent rooms from localStorage
 */
function loadRecentRooms(): void {
  try {
    const recentRoomsContainer = document.getElementById('recent-rooms-container');
    if (!recentRoomsContainer) return;
    
    const recentRooms = JSON.parse(localStorage.getItem('recentRooms') || '[]');
    
    if (recentRooms.length === 0) {
      recentRoomsContainer.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 2rem;">No recent rooms yet</p>';
      return;
    }
    
    recentRoomsContainer.innerHTML = recentRooms.map((room: any) => {
      const timeAgo = getTimeAgo(room.timestamp);
      
      return `
        <div class="recent-room-card" data-room-id="${room.id}">
          <div class="recent-room-header">
            <div class="recent-room-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                <circle cx="9" cy="7" r="4"></circle>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
              </svg>
            </div>
            <div class="recent-room-info">
              <div class="recent-room-name">${room.id}</div>
              <div class="recent-room-time">Last joined ${timeAgo}</div>
            </div>
          </div>
        </div>
      `;
    }).join('');
    
    // Add click handlers
    document.querySelectorAll('.recent-room-card').forEach(card => {
      card.addEventListener('click', () => {
        const roomId = card.getAttribute('data-room-id');
        if (roomId && roomIdInput) {
          roomIdInput.value = roomId;
        }
      });
    });
  } catch (err) {
    console.error('Error loading recent rooms:', err);
  }
}

/**
 * Get human-readable time ago
 */
function getTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Initialize audio manager and load devices
 */
async function initAudioManager() {
  const settings = loadSettings();
  
  audioManager = new AudioManager({
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl,
    noiseGateThreshold: settings.voiceSensitivity
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
    updateWaveform(peerId, isSpeaking);
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
  
  // Add spinner for connecting status
  if (status === 'connecting') {
    const spinner = createSpinner(false);
    statusMessage.innerHTML = '';
    statusMessage.appendChild(spinner);
    statusMessage.appendChild(document.createTextNode(' ' + message));
  } else {
    statusMessage.textContent = message;
  }
  
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
 * Show reconnecting status with delay to prevent flickering
 */
function showReconnectingStatus(message: string, immediate: boolean = false) {
  // Clear any pending status update
  if (reconnectingStatusTimeout) {
    clearTimeout(reconnectingStatusTimeout);
    reconnectingStatusTimeout = null;
  }
  
  if (immediate) {
    // Show immediately (e.g., for manual reconnect or after first few attempts)
    updateStatus('connecting', message);
  } else {
    // Delay showing the status - only show if reconnection takes > 3 seconds
    reconnectingStatusTimeout = setTimeout(() => {
      updateStatus('connecting', message);
      reconnectingStatusTimeout = null;
    }, RECONNECT_STATUS_DELAY_MS);
  }
}

/**
 * Clear reconnecting status timeout
 */
function clearReconnectingStatus() {
  if (reconnectingStatusTimeout) {
    clearTimeout(reconnectingStatusTimeout);
    reconnectingStatusTimeout = null;
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
    
    // Get detailed stats for tooltip
    const detailedStats = peerDetailedStats.get(peer.peerId);
    let tooltipText = `Connection quality: ${qualityClass}`;
    if (detailedStats) {
      tooltipText = `Ping: ${detailedStats.rtt.toFixed(0)}ms | Loss: ${(detailedStats.packetLoss * 100).toFixed(1)}% | Bitrate: ${detailedStats.bitrate}kbps`;
    }
    
    const qualityBars = `
      <div class="connection-quality ${qualityClass}" title="${tooltipText}">
        <div class="connection-bar ${quality >= 1 ? 'active' : ''}"></div>
        <div class="connection-bar ${quality >= 2 ? 'active' : ''}"></div>
        <div class="connection-bar ${quality >= 3 ? 'active' : ''}"></div>
        <div class="connection-bar ${quality >= 4 ? 'active' : ''}"></div>
      </div>
    `;

    // Waveform for speaking indicator
    const waveformId = `waveform-${peer.peerId}`;
    const waveformHTML = `
      <div id="${waveformId}" class="waveform-container" style="display: ${isSpeaking ? 'flex' : 'none'};">
        <div class="waveform-bar ${isSpeaking ? 'active' : ''}"></div>
        <div class="waveform-bar ${isSpeaking ? 'active' : ''}"></div>
        <div class="waveform-bar ${isSpeaking ? 'active' : ''}"></div>
        <div class="waveform-bar ${isSpeaking ? 'active' : ''}"></div>
        <div class="waveform-bar ${isSpeaking ? 'active' : ''}"></div>
      </div>
    `;
    
    return `
      <div class="peer-item ${peer.connected ? 'connected' : ''} ${isHost ? 'host' : ''} ${isSpeaking ? 'speaking' : ''}">
        <div class="peer-header">
          <div class="peer-info">
            <div class="peer-avatar ${isSpeaking ? 'speaking' : ''}" style="background: ${getAvatarColor(peer.username || peer.peerId)}">
              ${getInitials(peer.username || peer.peerId)}
            </div>
            <div style="display: flex; flex-direction: column; gap: 0.25rem; flex: 1;">
              <div style="display: flex; align-items: center; gap: 0.5rem;">
                <div class="peer-indicator ${peer.connected ? (isSpeaking ? 'speaking' : 'connected') : ''}"></div>
                <span><strong>${peer.username || peer.peerId}</strong></span>
                ${isHost ? '<span class="host-badge">HOST</span>' : ''}
              </div>
              <span style="font-size: 11px; color: var(--text-tertiary);">
                ${peer.connected ? `${connectionLabel ? connectionIcon + ' ' + connectionLabel : '🔊 Connected'}` : '⏳ Connecting...'}
              </span>
            </div>
            ${peer.connected ? qualityBars : ''}
          </div>
          ${waveformHTML}
        </div>
      </div>
    `;
  }).join('');
  
  // Remove old screen button event listeners (no longer needed)
  // Now we'll populate the screen sharing list instead
  updateScreenSharingList();

  // Register waveform updaters for each peer
  peers.forEach(peer => {
    const waveformId = `waveform-${peer.peerId}`;
    const waveformElement = document.getElementById(waveformId);
    if (waveformElement) {
      addWaveformToPeer(peer.peerId, waveformElement);
    }
  });
}

/**
 * Update screen sharing list in right sidebar
 */
function updateScreenSharingList() {
  if (!meshConnection) return;

  const peers = meshConnection.getPeers();
  const sharingPeers = peers.filter(peer => remoteScreenAvailable.has(peer.peerId));

  if (sharingPeers.length === 0) {
    screenSharingList.style.display = 'none';
    return;
  }

  screenSharingList.style.display = 'block';
  
  screenSharers.innerHTML = sharingPeers.map(peer => {
    const isViewing = remoteScreens.has(peer.peerId);
    const btnText = isViewing ? 'Viewing' : 'View';
    const btnClass = isViewing ? 'viewing' : '';
    
    return `
      <div class="screen-sharer-item" data-peer-id="${peer.peerId}">
        <div class="screen-sharer-avatar" style="background: ${getAvatarColor(peer.username || peer.peerId)}">
          ${getInitials(peer.username || peer.peerId)}
        </div>
        <div class="screen-sharer-info">
          <div class="screen-sharer-name">${peer.username || peer.peerId}</div>
          <div class="screen-sharer-status">
            <span class="screen-live-indicator"></span>
            Sharing screen
          </div>
        </div>
        <button class="screen-view-btn ${btnClass}" data-peer-id="${peer.peerId}">
          ${btnText}
        </button>
      </div>
    `;
  }).join('');

  // Add click event listeners
  const viewButtons = screenSharers.querySelectorAll('.screen-view-btn');
  viewButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const peerId = (e.target as HTMLButtonElement).dataset.peerId!;
      const isViewing = remoteScreens.has(peerId);
      
      if (isViewing) {
        stopViewingScreen(peerId);
      } else {
        requestScreenShare(peerId);
      }
    });
  });

  // Also make the whole item clickable
  const sharerItems = screenSharers.querySelectorAll('.screen-sharer-item');
  sharerItems.forEach(item => {
    item.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('screen-view-btn')) return;
      const peerId = (item as HTMLElement).dataset.peerId!;
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
  showReconnectingStatus('Reconnecting audio...');
  
  try {
    const deviceId = audioInputDeviceSelect.value;
    
    // Stop and restart audio
    audioManager?.stopCapture();
    const newStream = await audioManager!.startCapture(deviceId || undefined);
    
    // Update mesh connection with new stream
    if (meshConnection && newStream) {
      meshConnection.updateStream(newStream);
      console.log('✅ Audio reconnected successfully');
      clearReconnectingStatus();
      updateStatus('connected', 'Connected');
    }
  } catch (err) {
    console.error('❌ Failed to reconnect audio:', err);
    // Don't show disconnected - we're still connected to the room, just audio failed
    clearReconnectingStatus();
    updateStatus('connected', 'Connected (microphone error)');
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
    let bitrate = 0;
    let bytesSent = 0;
    let bytesReceived = 0;

    stats.forEach((report: any) => {
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        rtt = report.currentRoundTripTime ? report.currentRoundTripTime * 1000 : undefined;
      } else if (report.type === 'inbound-rtp' && report.kind === 'audio') {
        packetsLost += report.packetsLost || 0;
        packetsReceived += report.packetsReceived || 0;
        jitter = report.jitter ? report.jitter * 1000 : undefined;
        bytesReceived += report.bytesReceived || 0;
        
        // Calculate bitrate (convert bytes to kbps)
        if (report.bytesReceived && report.timestamp) {
          const previousStats = peerDetailedStats.get(peerId);
          if (previousStats && previousStats.bitrate > 0) {
            // Use stored timestamp to calculate rate
            const timeDiff = 3; // seconds (our monitoring interval)
            const bytesDiff = report.bytesReceived - bytesReceived;
            bitrate = Math.round((bytesDiff * 8) / (timeDiff * 1000)); // kbps
          }
        }
      } else if (report.type === 'outbound-rtp') {
        bytesSent += report.bytesSent || 0;
      }
    });

    // Update total bandwidth counters
    totalBytesSent += bytesSent;
    totalBytesReceived += bytesReceived;

    const quality = calculateConnectionQuality({ rtt, packetsLost, packetsReceived, jitter });
    peerConnectionQuality.set(peerId, quality);

    // Store detailed stats
    const packetLossRate = packetsReceived > 0 ? packetsLost / (packetsLost + packetsReceived) : 0;
    peerDetailedStats.set(peerId, {
      rtt: rtt || 0,
      packetLoss: packetLossRate,
      bitrate: bitrate
    });
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

    // Update bandwidth stats
    updateBandwidthStats();

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
    peerDetailedStats.clear();
    console.log('📊 Stopped connection quality monitoring');
  }
}

/**
 * Update bandwidth statistics display
 */
function updateBandwidthStats() {
  if (!connected || !meshConnection) {
    bandwidthStats.style.display = 'none';
    return;
  }

  const now = Date.now();
  const peers = meshConnection.getPeers();
  
  if (peers.length === 0) {
    bandwidthStats.style.display = 'none';
    return;
  }

  // Show bandwidth stats
  bandwidthStats.style.display = 'flex';

  // Calculate current bandwidth (aggregate all peers)
  let totalUpload = 0;
  let totalDownload = 0;

  peers.forEach(peer => {
    const stats = peerDetailedStats.get(peer.peerId);
    if (stats) {
      // Bitrate is per peer, sum them up
      totalDownload += stats.bitrate;
      // For upload, we assume symmetric for now (can be improved)
      totalUpload += stats.bitrate * 0.8; // Estimate upload as 80% of download
    }
  });

  currentUploadBandwidth = Math.round(totalUpload);
  currentDownloadBandwidth = Math.round(totalDownload);

  uploadBandwidth.textContent = currentUploadBandwidth.toFixed(0);
  downloadBandwidth.textContent = currentDownloadBandwidth.toFixed(0);
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
    
    // Update avatar with initials
    const avatarIcon = userAvatar.querySelector('.avatar-icon');
    if (avatarIcon) {
      avatarIcon.textContent = getInitials(username);
    }
    userAvatar.style.background = getAvatarColor(username);

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
        console.log('[SOCKET] Connected to signaling server');
        console.log('[SOCKET] Socket ID:', socket!.id);
        console.log('[SOCKET] Peer ID:', peerId);
        updateStatus('connecting', 'Joining room...');
        resolve();
      });

      socket!.on('connect_error', (err: Error) => {
        console.error('[SOCKET] Connection error:', err);
        console.error('Signaling server connection error:', err);
        reject(err);
      });
    });

    // Store reconnect data for auto-reconnect
    reconnectData = { signalingUrl, roomId, username };
    reconnectAttempts = 0; // Reset on successful connection
    
    // Save to recent rooms
    saveRecentRoom(roomId);

    // Set up socket event handlers for disconnection
    socket.on('disconnect', (reason) => {
      console.log('[SOCKET] ❌ DISCONNECTED');
      console.log('[SOCKET] Reason:', reason);
      console.log('[SOCKET] Peer ID:', peerId);
      console.log('[SOCKET] Room:', currentRoomId);
      console.log('[SOCKET] Connected status:', connected);
      console.log('[SOCKET] Timestamp:', new Date().toISOString());
      
      // Only auto-reconnect if it was unexpected (not user-initiated)
      if (reason === 'transport close' || reason === 'transport error' || reason === 'ping timeout') {
        console.log('[SOCKET] Unexpected disconnection - will auto-reconnect');
        updateStatus('connecting', 'Connection lost, reconnecting...');
        attemptReconnect();
      } else {
        console.log('[SOCKET] Disconnection reason does not trigger auto-reconnect:', reason);
      }
    });

    socket.on('error', (err) => {
      console.error('Socket error:', err);
    });

    // Store room ID for later use
    currentRoomId = roomId;

    // Create mesh connection
    console.log('[MESH] Creating mesh connection...');
    console.log('[MESH] Room:', roomId);
    console.log('[MESH] Peer ID:', peerId);
    console.log('[MESH] Username:', username);
    
    meshConnection = new MeshConnection({
      signalingUrl,
      roomId,
      peerId,
      username
    });

    // Set up event handlers
    meshConnection.onPeerJoined((peerId, username) => {
      console.log('[MESH] ✅ Peer joined:', peerId, '('+username+')');
      console.log('[MESH] Total peers now:', meshConnection.getPeers().length);
      playNotificationSound('join');
      updatePeersList();
    });

    meshConnection.onPeerLeft((peerId) => {
      console.log('[MESH] ❌ Peer left:', peerId);
      console.log('[MESH] Total peers now:', meshConnection.getPeers().length);
      playNotificationSound('leave');
      audioManager?.removeRemoteStream(peerId);
      removeRemoteScreen(peerId); // Also remove their screen share if any
      cleanupSpatialAudioForPeer(peerId); // Cleanup spatial audio
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
          
          // Setup spatial audio if enabled
          if (spatialAudioEnabled) {
            setTimeout(() => {
              const peers = meshConnection?.getPeers() || [];
              const peerIndex = peers.findIndex(p => p.peerId === peerId);
              if (peerIndex >= 0) {
                setupSpatialAudioForPeer(peerId, audioOnlyStream, peerIndex, peers.length);
              }
            }, 500); // Small delay to ensure audio element is created
          }
        }
      } else {
        // Audio only
        audioManager?.addRemoteStream(peerId, stream);
        
        // Setup spatial audio if enabled
        if (spatialAudioEnabled) {
          setTimeout(() => {
            const peers = meshConnection?.getPeers() || [];
            const peerIndex = peers.findIndex(p => p.peerId === peerId);
            if (peerIndex >= 0) {
              setupSpatialAudioForPeer(peerId, stream, peerIndex, peers.length);
            }
          }, 500); // Small delay to ensure audio element is created
        }
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
    console.log('[MESH] Connecting to room...');
    await meshConnection.connect(socket, stream);
    console.log('[MESH] \u2705 Successfully connected to room');

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
    
    socket.on('screen-ready', (data: { sharerPeerId: string }) => {
      console.log(`Screen ready from ${data.sharerPeerId}, extracting tracks from peer connection`);
      // Get the peer connection and extract video tracks
      if (meshConnection) {
        const peerInfo = meshConnection.getPeer(data.sharerPeerId);
        if (peerInfo?.connection) {
          // Get all receivers and find video tracks
          const receivers = peerInfo.connection.getReceivers();
          const videoTracks = receivers
            .map(receiver => receiver.track)
            .filter(track => track && track.kind === 'video' && track.readyState === 'live');
          
          if (videoTracks.length > 0) {
            console.log(`Found ${videoTracks.length} video tracks for ${data.sharerPeerId}`);
            const screenStream = new MediaStream(videoTracks);
            handleRemoteScreen(data.sharerPeerId, screenStream);
          } else {
            console.error(`No live video tracks found for ${data.sharerPeerId}`);
          }
        }
      }
    });
    
    // Update UI
    connectBtn.style.display = 'none';
    disconnectBtn.style.display = 'block';
    muteBtn.disabled = false;
    deafenBtn.disabled = false;
    screenShareBtn.disabled = false;
    signalingUrlInput.disabled = true;
    roomIdInput.disabled = true;
    usernameInput.disabled = true;

    // Enable chat
    chatInput.disabled = false;
    chatInput.placeholder = 'Message #general-chat (paste images with Ctrl+V)';
    chatSendBtn.disabled = false;
    chatEmptyState.classList.add('hidden');

    // Initialize button states
    updateMuteButton();
    updateDeafenButton();

    // Switch to connected view with smooth transition
    await transitionView(
      [centeredConnection, disconnectedView],
      [leftSidebar, mainContent, connectedView, rightSidebar]
    );
    
    // Show resize handles
    if (leftResizeHandle) leftResizeHandle.style.display = '';
    if (rightResizeHandle) rightResizeHandle.style.display = '';

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
    
    // Only show disconnected status if not auto-reconnecting
    // During auto-reconnect, let the reconnect logic handle status messages
    if (!isReconnecting) {
      updateStatus('disconnected', `Error: ${(err as Error).message}`);
      disconnect();
    } else {
      // Just throw the error back to reconnect handler
      throw err;
    }
  }
}

/**
 * Disconnect from voice chat
 */
function disconnect() {
  console.log('Disconnecting...');
  
  // Cancel any pending auto-reconnect attempts
  cancelReconnect();
  
  // Stop audio health check
  stopAudioHealthCheck();
  
  // Stop connection quality monitoring
  stopConnectionQualityMonitoring();
  
  // Stop local voice activity detection
  cleanupLocalVoiceActivity();
  
  // Cleanup spatial audio
  disableSpatialAudio();
  
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
  screenShareBtn.disabled = true;
  signalingUrlInput.disabled = false;
  roomIdInput.disabled = false;
  usernameInput.disabled = false;
  
  // Disable chat
  chatInput.disabled = true;
  chatInput.placeholder = 'Connect to start chatting (paste images with Ctrl+V)';
  chatSendBtn.disabled = true;
  chatEmptyState.classList.remove('hidden');
  
  // Switch to disconnected view with smooth transition
  transitionView(
    [leftSidebar, mainContent, connectedView, rightSidebar],
    [centeredConnection]
  );
  
  // Hide resize handles
  if (leftResizeHandle) leftResizeHandle.style.display = 'none';
  if (rightResizeHandle) rightResizeHandle.style.display = 'none';
  
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
  screenTracksAdded.clear();
}

/**
 * Attempt to auto-reconnect to the room
 */
async function attemptReconnect() {
  if (!reconnectData || isReconnecting) return;
  
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.log('Max reconnection attempts reached, giving up');
    updateStatus('disconnected', `Failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts`);
    isReconnecting = false;
    reconnectAttempts = 0;
    reconnectData = null;
    return;
  }

  reconnectAttempts++;
  isReconnecting = true;

  console.log(`Attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
  // Only show status immediately after 2nd attempt or later
  const showImmediate = reconnectAttempts > 1;
  showReconnectingStatus(`Reconnecting... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`, showImmediate);

  try {
    // Try to reconnect
    signalingUrlInput.value = reconnectData.signalingUrl;
    roomIdInput.value = reconnectData.roomId;
    usernameInput.value = reconnectData.username;

    await connect();

    // Success! Reset reconnect state
    console.log('Reconnection successful!');
    reconnectAttempts = 0;
    isReconnecting = false;
    reconnectData = null;
    clearReconnectingStatus();
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
  } catch (err) {
    console.error(`Reconnection attempt ${reconnectAttempts} failed:`, err);
    
    // Schedule next attempt
    const delay = RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1); // Exponential backoff
    // Always show countdown immediately since we're waiting
    clearReconnectingStatus();
    updateStatus('connecting', `Reconnecting in ${Math.ceil(delay / 1000)}s... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    
    reconnectTimeout = setTimeout(() => {
      attemptReconnect();
    }, delay);
  }
}

/**
 * Cancel auto-reconnect
 */
function cancelReconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  clearReconnectingStatus();
  isReconnecting = false;
  reconnectAttempts = 0;
  reconnectData = null;
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
    
    // Update button state with muted icon style
    screenShareBtn.classList.add('muted');
    screenShareBtn.classList.remove('active');
    screenShareBtn.title = 'Stop Sharing Screen';
    
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
  screenShareBtn.classList.remove('muted');
  screenShareBtn.classList.add('active');
  screenShareBtn.title = 'Share Screen';
  
  // Clear viewers and tracks tracking
  screenViewers.clear();
  screenTracksAdded.clear();
  
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
 * Open fullscreen overlay with a screen share stream
 */
function openFullscreenOverlay(stream: MediaStream | null, peerId: string) {
  const overlay = document.getElementById('fullscreen-overlay');
  const video = document.getElementById('fullscreen-video') as HTMLVideoElement;
  const label = document.getElementById('fullscreen-peer-label');
  const closeBtn = document.getElementById('fullscreen-close-overlay');

  if (!overlay || !video) return;

  video.srcObject = stream;
  if (label) label.textContent = peerId;
  overlay.classList.add('active');

  const close = () => {
    overlay.classList.remove('active');
    video.srcObject = null;
  };

  // Close button
  closeBtn?.addEventListener('click', close, { once: true });

  // ESC key
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);
}

/**
 * Handle remote screen share
 */
function handleRemoteScreen(peerId: string, stream: MediaStream) {
  remoteScreens.set(peerId, stream);
  
  // Get peer username
  let peerUsername = peerId;
  if (meshConnection) {
    const peer = meshConnection.getPeer(peerId);
    if (peer?.username) {
      peerUsername = peer.username;
    }
  }
  
  // Create or update the video element
  let screenItem = document.getElementById(`screen-${peerId}`);
  if (!screenItem) {
    screenItem = document.createElement('div');
    screenItem.id = `screen-${peerId}`;
    screenItem.className = 'remote-screen-item';
    screenItem.innerHTML = `
      <div class="screen-header">
        <span class="screen-header-title">${peerUsername}'s Screen</span>
        <div class="screen-header-actions">
          <button class="fullscreen-btn" title="Full Screen">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
            </svg>
          </button>
          <button class="disconnect-screen-btn" title="Stop Viewing">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
      <video autoplay playsinline></video>
    `;
    remoteScreensDiv.appendChild(screenItem);
    
    // Add full screen button handler — opens overlay
    const fullscreenBtn = screenItem.querySelector('.fullscreen-btn') as HTMLButtonElement;
    const disconnectBtn = screenItem.querySelector('.disconnect-screen-btn') as HTMLButtonElement;
    const video = screenItem.querySelector('video') as HTMLVideoElement;
    
    fullscreenBtn.addEventListener('click', () => {
      openFullscreenOverlay(video.srcObject as MediaStream, peerUsername);
    });

    disconnectBtn.addEventListener('click', () => {
      stopViewingScreen(peerId);
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
  const screenItem = document.getElementById(`screen-${targetPeerId}`);
  if (screenItem) {
    screenItem.remove();
  }
  
  // Remove from remoteScreens but keep in remoteScreenAvailable
  remoteScreens.delete(targetPeerId);
  
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
  
  // Update screen sharing list
  updatePeersList();
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
  
  // Check if we've already added screen tracks to this peer connection
  if (screenTracksAdded.has(viewerPeerId)) {
    console.log(`Screen tracks already added to ${viewerPeerId}, notifying viewer`);
    // Notify the viewer that the screen is ready (tracks already in connection)
    if (socket && currentRoomId) {
      socket.emit('screen-ready', {
        roomId: currentRoomId,
        viewerPeerId: viewerPeerId,
        sharerPeerId: peerId
      });
    }
    return;
  }
  
  // Check if stream tracks are active before adding
  const videoTracks = screenStream.getVideoTracks();
  if (videoTracks.length === 0 || videoTracks[0].readyState !== 'live') {
    console.error(`Screen stream tracks are not active for ${viewerPeerId}`);
    return;
  }
  
  // Add the screen stream tracks individually to avoid "track removed" errors
  try {
    let tracksAdded = false;
    // Add video tracks from screen stream
    videoTracks.forEach(track => {
      try {
        peerInfo.connection.addTrack(track, screenStream);
        console.log(`Added screen video track for ${viewerPeerId}`);
        tracksAdded = true;
      } catch (trackErr: any) {
        // If track already exists, mark as added anyway
        if (trackErr.message?.includes('already been added')) {
          console.log(`Screen track already exists for ${viewerPeerId}`);
          tracksAdded = true;
        } else {
          console.error(`Error adding screen track to viewer ${viewerPeerId}:`, trackErr);
        }
      }
    });
    
    if (tracksAdded) {
      screenTracksAdded.add(viewerPeerId);
      console.log(`Screen stream successfully added for ${viewerPeerId}`);
    }
  } catch (err) {
    console.error(`Error adding screen to viewer ${viewerPeerId}:`, err);
  }
}

/**
 * Remove screen video from a specific viewer
 */
function removeScreenFromViewer(viewerPeerId: string) {
  screenViewers.delete(viewerPeerId);
  console.log(`Viewer ${viewerPeerId} stopped viewing screen (tracks remain for re-viewing)`);
  // Note: We keep tracks in the connection (screenTracksAdded) for re-viewing
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
    // Add waveform to user avatar if not already present
    if (!userAvatar.querySelector('.waveform-container')) {
      const waveform = createWaveform();
      waveform.style.display = 'none';
      waveform.style.marginLeft = '8px';
      userAvatar.appendChild(waveform);
    }
    
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
          const waveform = userAvatar.querySelector('.waveform-container') as HTMLElement;
          if (waveform) waveform.style.display = 'none';
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
      
      const waveform = userAvatar.querySelector('.waveform-container') as HTMLElement;
      
      if (isSpeaking) {
        speakingIndicator.style.display = 'block';
        userAvatar.classList.add('speaking');
        if (waveform) {
          waveform.style.display = 'flex';
          waveform.querySelectorAll('.waveform-bar').forEach(bar => {
            bar.classList.add('active');
          });
        }
      } else {
        speakingIndicator.style.display = 'none';
        userAvatar.classList.remove('speaking');
        if (waveform) {
          waveform.style.display = 'none';
          waveform.querySelectorAll('.waveform-bar').forEach(bar => {
            bar.classList.remove('active');
          });
        }
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
  
  // Remove waveform from user avatar
  const waveform = userAvatar.querySelector('.waveform-container');
  if (waveform) {
    waveform.remove();
  }
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
  
  // Deafening should also mute the microphone
  if (isDeafened && !isMuted) {
    isMuted = audioManager.toggleMute();
    updateMuteButton();
  }
  
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
 * Update voice sensitivity threshold
 */
async function updateVoiceSensitivity() {
  if (!audioManager) return;
  
  const sensitivity = parseInt(voiceSensitivitySlider.value);
  voiceSensitivityValue.textContent = `${sensitivity} dB`;
  
  await audioManager.updateConfig({ noiseGateThreshold: sensitivity });
  saveSettings(getCurrentSettings());
  console.log('Voice sensitivity updated:', sensitivity);
}

/**
 * Toggle input monitoring (hear your own microphone)
 */
async function toggleInputMonitoring() {
  if (!audioManager) return;
  
  const enabled = inputMonitoringToggle.checked;
  
  if (enabled && !inputMonitoringNode) {
    // Create audio feedback loop
    try {
      const stream = audioManager.getLocalStream();
      if (!stream) return;
      
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const gainNode = audioContext.createGain();
      
      // Set lower volume to avoid feedback
      gainNode.gain.value = 0.3;
      
      source.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      inputMonitoringNode = gainNode;
      console.log('Input monitoring enabled');
    } catch (err) {
      console.error('Failed to enable input monitoring:', err);
      inputMonitoringToggle.checked = false;
    }
  } else if (!enabled && inputMonitoringNode) {
    // Disconnect and cleanup
    inputMonitoringNode.disconnect();
    inputMonitoringNode = null;
    console.log('Input monitoring disabled');
  }
  
  saveSettings(getCurrentSettings());
}

/**
 * Change color scheme
 */
function changeColorScheme() {
  const scheme = colorSchemeSelect.value;
  console.log('changeColorScheme called, scheme:', scheme);
  console.log('Current data-theme:', document.documentElement.getAttribute('data-theme'));
  
  if (scheme === 'default') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', scheme);
  }
  
  console.log('New data-theme:', document.documentElement.getAttribute('data-theme'));
  saveSettings(getCurrentSettings());
}

/**
 * Toggle spatial audio
 */
function toggleSpatialAudio() {
  spatialAudioEnabled = spatialAudioToggle.checked;
  
  if (spatialAudioEnabled) {
    enableSpatialAudio();
  } else {
    disableSpatialAudio();
  }
  
  saveSettings(getCurrentSettings());
  console.log('Spatial audio:', spatialAudioEnabled ? 'enabled' : 'disabled');
}

/**
 * Enable spatial audio for all connected peers
 */
function enableSpatialAudio() {
  if (!meshConnection) return;
  
  // Create audio context if not exists
  if (!spatialAudioContext) {
    spatialAudioContext = new AudioContext();
  }
  
  const peers = meshConnection.getPeers();
  peers.forEach((peer, index) => {
    if (peer.connected) {
      const audioElement = document.getElementById(`audio-${peer.peerId}`) as HTMLAudioElement;
      if (audioElement && audioElement.srcObject) {
        setupSpatialAudioForPeer(peer.peerId, audioElement.srcObject as MediaStream, index, peers.length);
        // Mute the original audio element to avoid double audio
        audioElement.muted = true;
      }
    }
  });
}

/**
 * Setup spatial audio for a specific peer
 */
function setupSpatialAudioForPeer(peerId: string, stream: MediaStream, peerIndex: number, totalPeers: number) {
  if (!spatialAudioContext) return;
  
  // Clean up existing spatial audio for this peer
  cleanupSpatialAudioForPeer(peerId);
  
  try {
    // Create audio nodes
    const source = spatialAudioContext.createMediaStreamSource(stream);
    const panner = spatialAudioContext.createPanner();
    const gainNode = spatialAudioContext.createGain();
    
    // Configure panner for 3D audio
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.maxDistance = 10;
    panner.rolloffFactor = 1;
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 0;
    panner.coneOuterGain = 0;
    
    // Position peers in a circle around the listener
    const angle = (peerIndex / totalPeers) * 2 * Math.PI;
    const radius = 2; // Distance from listener
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const y = 0; // Same height as listener
    
    panner.setPosition(x, y, z);
    
    // Connect nodes: source -> panner -> gain -> destination
    source.connect(panner);
    panner.connect(gainNode);
    gainNode.connect(spatialAudioContext.destination);
    
    // Store for later cleanup
    spatialPanners.set(peerId, { panner, source, gain: gainNode });
    
    console.log(`Spatial audio setup for ${peerId} at position (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`);
  } catch (err) {
    console.error(`Failed to setup spatial audio for ${peerId}:`, err);
  }
}

/**
 * Cleanup spatial audio for a peer
 */
function cleanupSpatialAudioForPeer(peerId: string) {
  const spatialAudio = spatialPanners.get(peerId);
  if (spatialAudio) {
    try {
      spatialAudio.source.disconnect();
      spatialAudio.panner.disconnect();
      spatialAudio.gain.disconnect();
    } catch (err) {
      // Ignore disconnect errors
    }
    spatialPanners.delete(peerId);
  }
  
  // Unmute original audio element
  const audioElement = document.getElementById(`audio-${peerId}`) as HTMLAudioElement;
  if (audioElement) {
    audioElement.muted = false;
  }
}

/**
 * Disable spatial audio for all peers
 */
function disableSpatialAudio() {
  // Cleanup all spatial audio nodes
  for (const peerId of spatialPanners.keys()) {
    cleanupSpatialAudioForPeer(peerId);
  }
  spatialPanners.clear();
  
  // Close audio context
  if (spatialAudioContext) {
    spatialAudioContext.close().catch(() => {});
    spatialAudioContext = null;
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
  
  // Only handle shortcuts with Ctrl+Shift to avoid conflicts with games
  if (!event.ctrlKey || !event.shiftKey) {
    return;
  }
  
  if (!connected) {
    return;
  }
  
  switch (event.key.toLowerCase()) {
    case 'm':
      // Ctrl+Shift+M = Mute
      toggleMute();
      event.preventDefault();
      break;
    case 'h':
      // Ctrl+Shift+H = Deafen (H for Headphones)
      toggleDeafen();
      event.preventDefault();
      break;
    case 'd':
      // Ctrl+Shift+D = Disconnect
      disconnect();
      event.preventDefault();
      break;
  }
}

// Event listeners
connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);
muteBtn.addEventListener('click', toggleMute);
deafenBtn.addEventListener('click', toggleDeafen);

// Copy room link button
copyLinkBtn.addEventListener('click', () => {
  const roomId = roomIdInput.value.trim();
  if (!roomId) {
    alert('Please enter a room ID first');
    return;
  }
  
  const roomLink = `voicelink://room/${roomId}`;
  
  // Copy to clipboard
  navigator.clipboard.writeText(roomLink).then(() => {
    // Visual feedback
    const originalHTML = copyLinkBtn.innerHTML;
    copyLinkBtn.classList.add('copied');
    copyLinkBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      Copied!
    `;
    
    setTimeout(() => {
      copyLinkBtn.classList.remove('copied');
      copyLinkBtn.innerHTML = originalHTML;
    }, 2000);
  }).catch(err => {
    console.error('Failed to copy:', err);
    alert('Failed to copy link to clipboard');
  });
});

// Handle deep link from main process
if (window.electron?.ipcRenderer) {
  window.electron.ipcRenderer.on('join-room-from-link', (roomId: string) => {
    console.log('Received room ID from deep link:', roomId);
    
    // Set the room ID and focus the window
    roomIdInput.value = roomId;
    
    // If not connected, show a notification
    if (!connected) {
      // Highlight the connect button
      connectBtn.style.animation = 'pulse 1s ease-in-out 3';
      setTimeout(() => {
        connectBtn.style.animation = '';
      }, 3000);
      
      // Optionally auto-connect (uncomment if you want automatic connection)
      // setTimeout(() => connect(), 500);
    }
  });
}

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
voiceSensitivitySlider.addEventListener('input', updateVoiceSensitivity);
inputMonitoringToggle.addEventListener('change', toggleInputMonitoring);
spatialAudioToggle.addEventListener('change', toggleSpatialAudio);
colorSchemeSelect.addEventListener('change', changeColorScheme);

// Interface effects listeners
smoothTransitionsToggle.addEventListener('change', () => {
  const enabled = smoothTransitionsToggle.checked;
  document.documentElement.style.setProperty('--transition-speed', enabled ? '0.3s' : '0s');
  console.log('Smooth transitions:', enabled);
});

animatedWaveformsToggle.addEventListener('change', () => {
  const enabled = animatedWaveformsToggle.checked;
  document.documentElement.classList.toggle('no-waveform-animation', !enabled);
  console.log('Animated waveforms:', enabled);
});

fadeEffectsToggle.addEventListener('change', () => {
  const enabled = fadeEffectsToggle.checked;
  document.documentElement.classList.toggle('no-fade-effects', !enabled);
  console.log('Fade effects:', enabled);
});

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

fabSettings.addEventListener('click', () => {
  settingsModal.style.display = 'flex';
});

// Toggle advanced settings
let advancedVisible = false;
toggleAdvancedBtn.addEventListener('click', () => {
  advancedVisible = !advancedVisible;
  advancedSection.classList.toggle('visible', advancedVisible);
  toggleAdvancedBtn.textContent = advancedVisible ? 'Advanced ▲' : 'Advanced ▼';
});

// Load recent rooms on startup
loadRecentRooms();

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

// Settings tabs switching
const settingsTabs = document.querySelectorAll('.settings-tab');
const settingsTabContents = document.querySelectorAll('.settings-tab-content');

console.log('Settings tabs found:', settingsTabs.length);
console.log('Settings tab contents found:', settingsTabContents.length);

// Verify interface-tab exists
const interfaceTab = document.getElementById('interface-tab');
const audioTab = document.getElementById('audio-tab');
console.log('audio-tab element:', audioTab);
console.log('interface-tab element:', interfaceTab);

// Log all tab buttons and content divs
settingsTabs.forEach((tab, index) => {
  const tabName = (tab as HTMLElement).dataset.tab;
  console.log(`Tab button ${index}:`, tabName, tab);
});

settingsTabContents.forEach((content, index) => {
  console.log(`Tab content ${index}:`, content.id, content);
});

settingsTabs.forEach((tab, index) => {
  const tabElement = tab as HTMLElement;
  console.log(`Adding click listener to tab ${index}:`, tabElement.dataset.tab);
  
  tabElement.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    const targetTab = tabElement.dataset.tab;
    console.log('==============================');
    console.log('Tab clicked:', targetTab);
    console.log('Event target:', e.target);
    console.log('Current element:', tabElement);
    
    // Remove active class from all tabs and contents
    settingsTabs.forEach(t => {
      t.classList.remove('active');
      console.log('Removed active from tab:', (t as HTMLElement).dataset.tab);
    });
    
    settingsTabContents.forEach(c => {
      c.classList.remove('active');
      console.log('Removed active from content:', c.id);
    });
    
    // Add active class to clicked tab
    tabElement.classList.add('active');
    console.log('Added active to tab:', targetTab);
    
    // Find and activate corresponding content
    const targetContent = document.getElementById(`${targetTab}-tab`);
    console.log('Looking for content with id:', `${targetTab}-tab`);
    console.log('Target content element:', targetContent);
    
    if (targetContent) {
      targetContent.classList.add('active');
      console.log('✓ Successfully activated tab:', targetTab);
      console.log('Content classes:', targetContent.className);
    } else {
      console.error('✗ Could not find content for tab:', targetTab);
      console.error('Expected id:', `${targetTab}-tab`);
    }
    console.log('==============================');
  });
});

// Chat event listeners
chatSendBtn.addEventListener('click', sendTextMessage);

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendTextMessage();
  }
});

// Paste event for images
chatInput.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (let i = 0; i < items.length; i++) {
    if (items[i].type.indexOf('image') !== -1) {
      e.preventDefault();
      const file = items[i].getAsFile();
      if (file) {
        attachedImage = file;
        updateChatInputVisual();
      }
      break;
    }
  }
});

// Drag and drop for images
chatInput.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
});

chatInput.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    const file = files[0];
    if (file.type.startsWith('image/')) {
      attachedImage = file;
      updateChatInputVisual();
    }
  }
});

// Remove image button
const removeImageBtn = document.getElementById('remove-image-btn');
if (removeImageBtn) {
  removeImageBtn.addEventListener('click', () => {
    attachedImage = null;
    updateChatInputVisual();
  });
}

// Load saved settings
const savedSettings = loadSettings();
signalingUrlInput.value = savedSettings.signalingUrl;
usernameInput.value = savedSettings.username || defaultUsername;
echoCancellationToggle.checked = savedSettings.echoCancellation;
noiseSuppressionToggle.checked = savedSettings.noiseSuppression;
autoGainControlToggle.checked = savedSettings.autoGainControl;
voiceSensitivitySlider.value = savedSettings.voiceSensitivity.toString();
voiceSensitivityValue.textContent = `${savedSettings.voiceSensitivity} dB`;
inputMonitoringToggle.checked = savedSettings.inputMonitoring;
spatialAudioToggle.checked = savedSettings.spatialAudio;
spatialAudioEnabled = savedSettings.spatialAudio;
colorSchemeSelect.value = savedSettings.colorScheme;
if (savedSettings.colorScheme === 'default') {
  document.documentElement.removeAttribute('data-theme');
} else {
  document.documentElement.setAttribute('data-theme', savedSettings.colorScheme);
}

// Save settings when inputs change
signalingUrlInput.addEventListener('change', () => saveSettings(getCurrentSettings()));
usernameInput.addEventListener('change', () => saveSettings(getCurrentSettings()));

// Initialize on load
initAudioManager().then(() => {
  console.log('Audio manager initialized');
  
  // Enable input monitoring if it was previously enabled
  if (savedSettings.inputMonitoring) {
    toggleInputMonitoring();
  }
}).catch((err) => {
  console.error('Failed to initialize audio manager:', err);
});

// Cleanup on window close
window.addEventListener('beforeunload', () => {
  if (connected) {
    disconnect();
  }
});

// ============================================================================
// UI Enhancements: Resizable Panels, Waveforms, Transitions
// ============================================================================

/**
 * Initialize resizable panels
 */
function initResizablePanels() {
  let isResizing = false;
  let currentHandle: HTMLElement | null = null;
  let startX = 0;
  let startWidth = 0;
  let currentWidth = 0;

  // Left sidebar resize
  leftResizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    currentHandle = leftResizeHandle;
    startX = e.clientX;
    startWidth = leftSidebar.offsetWidth;
    leftResizeHandle.classList.add('resizing');
    leftSidebar.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  // Right sidebar resize
  rightResizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    currentHandle = rightResizeHandle;
    startX = e.clientX;
    startWidth = rightSidebar.offsetWidth;
    rightResizeHandle.classList.add('resizing');
    rightSidebar.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  // Mouse move - throttled with requestAnimationFrame
  document.addEventListener('mousemove', (e) => {
    if (!isResizing || !currentHandle) return;

    const delta = e.clientX - startX;

    if (currentHandle === leftResizeHandle) {
      currentWidth = Math.max(200, Math.min(500, startWidth + delta));
      leftSidebar.style.width = `${currentWidth}px`;
    } else if (currentHandle === rightResizeHandle) {
      currentWidth = Math.max(250, Math.min(600, startWidth - delta));
      rightSidebar.style.width = `${currentWidth}px`;
    }
  });

  // Mouse up
  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      leftResizeHandle.classList.remove('resizing');
      rightResizeHandle.classList.remove('resizing');
      leftSidebar.classList.remove('resizing');
      rightSidebar.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      
      // Save to localStorage only on mouseup
      if (currentHandle === leftResizeHandle) {
        localStorage.setItem('leftSidebarWidth', currentWidth.toString());
      } else if (currentHandle === rightResizeHandle) {
        localStorage.setItem('rightSidebarWidth', currentWidth.toString());
      }
      
      currentHandle = null;
    }
  });

  // Restore saved widths
  const savedLeftWidth = localStorage.getItem('leftSidebarWidth');
  const savedRightWidth = localStorage.getItem('rightSidebarWidth');
  
  if (savedLeftWidth) {
    leftSidebar.style.width = `${savedLeftWidth}px`;
  }
  if (savedRightWidth) {
    rightSidebar.style.width = `${savedRightWidth}px`;
  }
}

/**
 * Create waveform visualization element
 */
function createWaveform(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'waveform-container';
  
  for (let i = 0; i < 5; i++) {
    const bar = document.createElement('div');
    bar.className = 'waveform-bar';
    container.appendChild(bar);
  }
  
  return container;
}

/**
 * Update waveform visualization based on audio levels
 */
const waveformUpdaters = new Map<string, (active: boolean) => void>();

function updateWaveform(peerId: string, active: boolean) {
  const updater = waveformUpdaters.get(peerId);
  if (updater) {
    updater(active);
  }
}

/**
 * Add waveform to peer
 */
function addWaveformToPeer(peerId: string, waveformElement: HTMLElement) {
  const bars = waveformElement.querySelectorAll('.waveform-bar') as NodeListOf<HTMLElement>;
  
  waveformUpdaters.set(peerId, (active: boolean) => {
    bars.forEach(bar => {
      if (active) {
        bar.classList.add('active');
      } else {
        bar.classList.remove('active');
      }
    });
  });
}

/**
 * Smooth view transition
 */
async function transitionView(hideElements: HTMLElement[], showElements: HTMLElement[]) {
  // Add exiting animation to elements being hidden
  hideElements.forEach(el => {
    if (el.style.display !== 'none') {
      el.classList.add('view-exiting');
    }
  });

  // Wait for exit animation
  await new Promise(resolve => setTimeout(resolve, 200));

  // Hide exiting elements
  hideElements.forEach(el => {
    el.style.display = 'none';
    el.classList.remove('view-exiting');
  });

  // Show new elements with transition
  showElements.forEach(el => {
    el.style.display = 'flex';
    el.classList.add('view-transition');
  });

  // Cleanup transition class
  setTimeout(() => {
    showElements.forEach(el => el.classList.remove('view-transition'));
  }, 300);
}

/**
 * Create loading spinner
 */
function createSpinner(large = false): HTMLElement {
  const spinner = document.createElement('div');
  spinner.className = large ? 'spinner spinner-large' : 'spinner';
  return spinner;
}

/**
 * Create loading dots
 */
function createLoadingDots(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'loading-dots';
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('span');
    container.appendChild(dot);
  }
  return container;
}

// Initialize resizable panels on load
initResizablePanels();

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

  console.log('Chat initialized');
}

/**
 * Update chat input visual feedback
 */
function updateChatInputVisual() {
  const previewContainer = document.getElementById('chat-image-preview');
  const previewImg = document.getElementById('preview-img') as HTMLImageElement;
  
  if (!previewContainer || !previewImg) return;

  if (attachedImage) {
    // Show preview with image
    const reader = new FileReader();
    reader.onload = (e) => {
      previewImg.src = e.target?.result as string;
      previewContainer.style.display = 'block';
    };
    reader.readAsDataURL(attachedImage);
  } else {
    previewContainer.style.display = 'none';
    previewImg.src = '';
  }
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
    // Process code blocks first
    let processedContent = message.content;
    
    // Code block regex: ```lang\ncode\n```
    const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
    const codeBlocks: Array<{placeholder: string, html: string}> = [];
    
    processedContent = processedContent.replace(codeBlockRegex, (match, lang, code) => {
      const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
      const trimmedCode = code.trim();
      const langLabel = lang || 'text';
      const html = `<div class="chat-code-block" data-lang="${langLabel}">${escapeHtml(trimmedCode)}</div>`;
      codeBlocks.push({ placeholder, html });
      return placeholder;
    });
    
    // Inline code: `code`
    const inlineCodeRegex = /`([^`]+)`/g;
    const inlineCodes: Array<{placeholder: string, html: string}> = [];
    
    processedContent = processedContent.replace(inlineCodeRegex, (match, code) => {
      const placeholder = `__INLINE_CODE_${inlineCodes.length}__`;
      const html = `<span class="chat-inline-code">${escapeHtml(code)}</span>`;
      inlineCodes.push({ placeholder, html });
      return placeholder;
    });
    
    // Convert URLs to clickable links
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const textWithLinks = processedContent.replace(urlRegex, (url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${url}</a>`;
    });
    
    // Replace newlines with <br>
    let formattedText = textWithLinks.replace(/\n/g, '<br>');
    
    // Restore code blocks and inline codes
    codeBlocks.forEach(({ placeholder, html }) => {
      formattedText = formattedText.replace(placeholder, html);
    });
    
    inlineCodes.forEach(({ placeholder, html }) => {
      formattedText = formattedText.replace(placeholder, html);
    });
    
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
 * Escape HTML to prevent XSS
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Get initials from username for avatar
 */
function getInitials(username: string): string {
  if (!username) return '?';
  const words = username.trim().split(/\s+/);
  if (words.length === 1) {
    return words[0].substring(0, 2).toUpperCase();
  }
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * Generate avatar color from username
 */
function getAvatarColor(username: string): string {
  const colors = [
    'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
    'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
    'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
    'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
    'linear-gradient(135deg, #30cfd0 0%, #330867 100%)',
    'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)',
    'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)',
  ];
  
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  return colors[Math.abs(hash) % colors.length];
}

/**
 * Send text message
 */
async function sendTextMessage() {
  const text = chatInput.value.trim();
  const imageToSend = attachedImage;
  
  if (!text && !imageToSend) return;
  if (!chatManager) return;

  try {
    // Send image if attached
    if (imageToSend) {
      await chatManager.sendImageMessage(imageToSend);
      attachedImage = null;
      updateChatInputVisual();
    }
    
    // Send text if present
    if (text) {
      await chatManager.sendTextMessage(text);
      chatInput.value = '';
    }
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
  chatInput.value = '';
  attachedImage = null;
  updateChatInputVisual();
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

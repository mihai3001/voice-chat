import { io, Socket } from 'socket.io-client';
import { MeshConnection, AudioManager } from '@voice-chat/client-core';

// State
let socket: Socket | null = null;
let meshConnection: MeshConnection | null = null;
let audioManager: AudioManager | null = null;
let connected = false;
let pushToTalkEnabled = false;
let pushToTalkActive = false;

// Voice activity state
const peerSpeakingState = new Map<string, boolean>();

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
    signalingUrl: 'http://localhost:3000',
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

  peersList.innerHTML = peers.map(peer => {
    const isHost = peer.peerId === hostPeerId;
    const isSpeaking = peerSpeakingState.get(peer.peerId) || false;
    const connectionIcon = peer.connectionType === 'turn' ? '⚡' :
                          peer.connectionType === 'stun' ? '🌐' :
                          peer.connectionType === 'direct' ? '🏠' : '';
    const connectionLabel = peer.connectionType === 'turn' ? 'TURN' :
                           peer.connectionType === 'stun' ? 'STUN' :
                           peer.connectionType === 'direct' ? 'Direct' : '';
    
    return `
      <div class="peer-item ${peer.connected ? 'connected' : ''} ${isHost ? 'host' : ''}">
        <div class="peer-info">
          <div class="peer-indicator ${peer.connected ? (isSpeaking ? 'speaking' : 'connected') : ''}"></div>
          <span><strong>${peer.username || peer.peerId}</strong></span>
          ${isHost ? '<span class="host-badge">HOST</span>' : ''}
          ${peer.connected && connectionLabel ? `<span class="connection-badge" title="${connectionLabel} connection">${connectionIcon}</span>` : ''}
          ${isSpeaking ? '<span style="font-size: 12px;">🎤</span>' : ''}
        </div>
        <span style="font-size: 12px; color: #6b7280;">
          ${peer.connected ? `🔊 Connected${connectionLabel ? ' (' + connectionLabel + ')' : ''}` : '⏳ Connecting...'}
        </span>
      </div>
    `;
  }).join('');
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
      updatePeersList();
    });

    meshConnection.onStreamReceived((peerId, stream) => {
      console.log(`Received stream from: ${peerId}`);
      audioManager?.addRemoteStream(peerId, stream);
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
    
    // Update UI
    connectBtn.style.display = 'none';
    disconnectBtn.style.display = 'block';
    muteBtn.disabled = false;
    deafenBtn.disabled = false;
    pttToggleBtn.disabled = false;
    signalingUrlInput.disabled = true;
    roomIdInput.disabled = true;
    usernameInput.disabled = true;
    audioDeviceSelect.disabled = true;

    updatePeersList();
    
    // Save settings
    saveSettings(getCurrentSettings());
    
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
  updateStatus('disconnected', 'Disconnected');

  // Update UI
  connectBtn.style.display = 'block';
  connectBtn.disabled = false;
  disconnectBtn.style.display = 'none';
  muteBtn.disabled = true;
  deafenBtn.disabled = true;
  pttToggleBtn.disabled = true;
  signalingUrlInput.disabled = false;
  roomIdInput.disabled = false;
  usernameInput.disabled = false;
  audioDeviceSelect.disabled = false;

  updatePeersList();
  
  // Clear speaking state
  peerSpeakingState.clear();
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

// Audio settings listeners
echoCancellationToggle.addEventListener('change', updateAudioSettings);
noiseSuppressionToggle.addEventListener('change', updateAudioSettings);
autoGainControlToggle.addEventListener('change', updateAudioSettings);

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

console.log('Voice Chat P2P client initialized');
console.log('Peer ID:', peerId);

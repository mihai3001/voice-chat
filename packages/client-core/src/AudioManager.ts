export interface AudioDevice {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
}

export interface AudioManagerConfig {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  sampleRate?: number;
  channelCount?: number;
}

export class AudioManager {
  private localStream?: MediaStream;
  private audioContext?: AudioContext;
  private muted = false;
  private deafened = false;
  private audioDevices: AudioDevice[] = [];
  private currentInputDevice?: string;
  
  // Remote audio elements (peerId -> HTMLAudioElement)
  private remoteAudioElements = new Map<string, HTMLAudioElement>();
  
  // Voice activity detection
  private vadAnalysers = new Map<string, { analyser: AnalyserNode; dataArray: Uint8Array<ArrayBuffer> }>();
  
  // Event handlers
  private onDevicesChangedHandler?: (devices: AudioDevice[]) => void;
  private onVoiceActivityHandler?: (peerId: string, isSpeaking: boolean) => void;
  
  constructor(private config: AudioManagerConfig = {}) {
    this.config = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 48000,
      channelCount: 1, // Mono for voice
      ...config
    };
  }
  
  /**
   * Initialize audio context
   */
  private initAudioContext(): void {
    if (!this.audioContext) {
      this.audioContext = new AudioContext({
        sampleRate: this.config.sampleRate
      });
    }
  }
  
  /**
   * Get list of available audio devices
   */
  async getAudioDevices(): Promise<AudioDevice[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.audioDevices = devices
        .filter(device => device.kind === 'audioinput' || device.kind === 'audiooutput')
        .map(device => ({
          deviceId: device.deviceId,
          label: device.label || `${device.kind} (${device.deviceId.slice(0, 8)})`,
          kind: device.kind
        }));
      
      return this.audioDevices;
    } catch (err) {
      console.error('[AudioManager] Error enumerating devices:', err);
      return [];
    }
  }
  
  /**
   * Start capturing audio from microphone
   */
  async startCapture(deviceId?: string): Promise<MediaStream> {
    try {
      this.initAudioContext();
      
      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: this.config.echoCancellation,
          noiseSuppression: this.config.noiseSuppression,
          autoGainControl: this.config.autoGainControl,
          sampleRate: this.config.sampleRate,
          channelCount: this.config.channelCount
        },
        video: false
      };
      
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.currentInputDevice = deviceId;
      
      console.log('[AudioManager] Started audio capture:', {
        deviceId: deviceId || 'default',
        tracks: this.localStream.getAudioTracks().map(t => ({
          label: t.label,
          enabled: t.enabled,
          settings: t.getSettings()
        }))
      });
      
      // Apply initial mute state
      if (this.muted) {
        this.setMuted(true);
      }
      
      return this.localStream;
    } catch (err) {
      console.error('[AudioManager] Error starting audio capture:', err);
      throw err;
    }
  }
  
  /**
   * Stop capturing audio
   */
  stopCapture(): void {
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = undefined;
      console.log('[AudioManager] Stopped audio capture');
    }
  }
  
  /**
   * Switch to a different audio input device
   */
  async switchInputDevice(deviceId: string): Promise<MediaStream> {
    this.stopCapture();
    return this.startCapture(deviceId);
  }
  
  /**
   * Get the local audio stream
   */
  getLocalStream(): MediaStream | undefined {
    return this.localStream;
  }
  
  /**
   * Mute or unmute local audio
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !muted;
      });
      console.log(`[AudioManager] Audio ${muted ? 'muted' : 'unmuted'}`);
    }
  }
  
  /**
   * Check if local audio is muted
   */
  isMuted(): boolean {
    return this.muted;
  }
  
  /**
   * Toggle mute state
   */
  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }
  
  /**
   * Set deafened state (mute output)
   */
  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    
    // Mute all remote audio elements
    this.remoteAudioElements.forEach(audio => {
      audio.muted = deafened;
    });
    
    console.log(`[AudioManager] Audio ${deafened ? 'deafened' : 'undeafened'}`);
  }
  
  /**
   * Check if audio is deafened
   */
  isDeafened(): boolean {
    return this.deafened;
  }
  
  /**
   * Toggle deafen state
   */
  toggleDeafen(): boolean {
    this.setDeafened(!this.deafened);
    return this.deafened;
  }
  
  /**
   * Add a remote audio stream and create an audio element for playback
   */
  addRemoteStream(peerId: string, stream: MediaStream): void {
    // Remove existing if any
    this.removeRemoteStream(peerId);
    
    // Create audio element
    const audio = document.createElement('audio');
    audio.srcObject = stream;
    audio.autoplay = true;
    audio.muted = this.deafened; // Apply current deafen state
    audio.id = `audio-${peerId}`;
    
    // Add to DOM (hidden)
    document.body.appendChild(audio);
    
    this.remoteAudioElements.set(peerId, audio);
    
    // Setup voice activity detection
    this.setupVoiceActivityDetection(peerId, stream);
    
    console.log(`[AudioManager] Added remote stream for peer: ${peerId}`);
  }
  
  /**
   * Setup voice activity detection for a peer
   */
  private setupVoiceActivityDetection(peerId: string, stream: MediaStream): void {
    if (!this.audioContext) {
      this.initAudioContext();
    }
    
    if (!this.audioContext) return;
    
    try {
      const source = this.audioContext.createMediaStreamSource(stream);
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.8;
      
      source.connect(analyser);
      
      const dataArray = new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
      this.vadAnalysers.set(peerId, { analyser, dataArray });
      
      // Start monitoring
      this.monitorVoiceActivity(peerId);
    } catch (err) {
      console.warn(`[AudioManager] Could not setup VAD for ${peerId}:`, err);
    }
  }
  
  /**
   * Monitor voice activity for a peer
   */
  private monitorVoiceActivity(peerId: string): void {
    const vadData = this.vadAnalysers.get(peerId);
    if (!vadData) return;
    
    const { analyser, dataArray } = vadData;
    let wasSpeaking = false;
    let lastCheck = 0;
    
    const checkActivity = () => {
      if (!this.vadAnalysers.has(peerId)) return; // Peer disconnected
      
      const now = Date.now();
      if (now - lastCheck < 50) {
        // Skip if called too frequently
        requestAnimationFrame(checkActivity);
        return;
      }
      lastCheck = now;
      
      try {
        analyser.getByteFrequencyData(dataArray);
        
        // Calculate average volume
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const average = sum / dataArray.length;
        
        // Threshold for voice activity (adjust as needed - higher = less sensitive)
        const isSpeaking = average > 15;
        
        // Trigger event on state change or periodically to ensure UI updates
        if (isSpeaking !== wasSpeaking) {
          wasSpeaking = isSpeaking;
          if (this.onVoiceActivityHandler) {
            this.onVoiceActivityHandler(peerId, isSpeaking);
          }
        }
      } catch (err) {
        console.warn(`[AudioManager] VAD error for ${peerId}:`, err);
      }
      
      // Continue monitoring with requestAnimationFrame for better performance
      requestAnimationFrame(checkActivity);
    };
    
    checkActivity();
  }
  
  /**
   * Remove a remote audio stream
   */
  removeRemoteStream(peerId: string): void {
    const audio = this.remoteAudioElements.get(peerId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
      this.remoteAudioElements.delete(peerId);
      console.log(`[AudioManager] Removed remote stream for peer: ${peerId}`);
    }
    
    // Clean up VAD
    this.vadAnalysers.delete(peerId);
  }
  
  /**
   * Set volume for a specific remote peer
   */
  setRemoteVolume(peerId: string, volume: number): void {
    const audio = this.remoteAudioElements.get(peerId);
    if (audio) {
      audio.volume = Math.max(0, Math.min(1, volume));
    }
  }
  
  /**
   * Get volume for a specific remote peer
   */
  getRemoteVolume(peerId: string): number {
    const audio = this.remoteAudioElements.get(peerId);
    return audio ? audio.volume : 0;
  }
  
  /**
   * Get audio level (for visualizations)
   */
  getAudioLevel(stream: MediaStream): number {
    if (!this.audioContext) return 0;
    
    try {
      const source = this.audioContext.createMediaStreamSource(stream);
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(dataArray);
      
      // Calculate average volume
      const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
      return average / 255; // Normalize to 0-1
    } catch (err) {
      console.error('[AudioManager] Error getting audio level:', err);
      return 0;
    }
  }
  
  /**
   * Set up device change listener
   */
  setupDeviceChangeListener(): void {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      console.log('[AudioManager] Audio devices changed');
      const devices = await this.getAudioDevices();
      
      if (this.onDevicesChangedHandler) {
        this.onDevicesChangedHandler(devices);
      }
    });
  }
  
  /**
   * Clean up resources
   */
  cleanup(): void {
    this.stopCapture();
    
    // Remove all remote audio elements
    this.remoteAudioElements.forEach((audio, peerId) => {
      this.removeRemoteStream(peerId);
    });
    
    // Close audio context
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
    
    console.log('[AudioManager] Cleaned up');
  }
  
  /**
   * Event handlers
   */
  onDevicesChanged(handler: (devices: AudioDevice[]) => void): void {
    this.onDevicesChangedHandler = handler;
  }
  
  /**
   * Listen for voice activity events
   */
  onVoiceActivity(handler: (peerId: string, isSpeaking: boolean) => void): void {
    this.onVoiceActivityHandler = handler;
  }
  
  /**
   * Update audio configuration
   */
  async updateConfig(newConfig: Partial<AudioManagerConfig>): Promise<void> {
    this.config = { ...this.config, ...newConfig };
    
    // Restart capture if active to apply new settings
    if (this.localStream) {
      const wasMuted = this.muted;
      await this.switchInputDevice(this.currentInputDevice || '');
      this.setMuted(wasMuted);
    }
  }
  
  /**
   * Get current configuration
   */
  getConfig(): AudioManagerConfig {
    return { ...this.config };
  }
}

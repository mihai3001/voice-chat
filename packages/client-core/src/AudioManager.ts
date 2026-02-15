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
  // Noise gate settings
  noiseGateEnabled?: boolean;
  noiseGateThreshold?: number; // dB, typically -50 to -30
  noiseGateAttack?: number; // ms, how fast gate opens
  noiseGateRelease?: number; // ms, how fast gate closes
}

export class AudioManager {
  private localStream?: MediaStream;
  private processedStream?: MediaStream;
  private audioContext?: AudioContext;
  private muted = false;
  private deafened = false;
  private audioDevices: AudioDevice[] = [];
  private currentInputDevice?: string;
  
  // Remote audio elements (peerId -> HTMLAudioElement)
  private remoteAudioElements = new Map<string, HTMLAudioElement>();
  
  // Voice activity detection
  private vadAnalysers = new Map<string, { analyser: AnalyserNode; dataArray: Uint8Array<ArrayBuffer> }>;
  
  // Noise gate processing nodes
  private noiseGateNodes?: {
    source: MediaStreamAudioSourceNode;
    analyser: AnalyserNode;
    gainNode: GainNode;
    destination: MediaStreamAudioDestinationNode;
  };
  
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
      noiseGateEnabled: true,
      noiseGateThreshold: -40, // dB
      noiseGateAttack: 10, // ms
      noiseGateRelease: 100, // ms
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
      
      // Apply noise gate processing if enabled
      if (this.config.noiseGateEnabled) {
        this.processedStream = this.applyNoiseGate(this.localStream);
      } else {
        this.processedStream = this.localStream;
      }
      
      // Apply initial mute state
      if (this.muted) {
        this.setMuted(true);
      }
      
      return this.processedStream;
    } catch (err) {
      console.error('[AudioManager] Error starting audio capture:', err);
      throw err;
    }
  }
  
  /**
   * Apply noise gate to filter out background noise
   */
  private applyNoiseGate(stream: MediaStream): MediaStream {
    if (!this.audioContext) {
      console.warn('[AudioManager] Audio context not initialized');
      return stream;
    }

    try {
      // Create audio nodes
      const source = this.audioContext.createMediaStreamSource(stream);
      const analyser = this.audioContext.createAnalyser();
      const gainNode = this.audioContext.createGain();
      const destination = this.audioContext.createMediaStreamDestination();

      // Configure analyser for noise gate
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;

      // Connect nodes: source -> analyser -> gain -> destination
      source.connect(analyser);
      analyser.connect(gainNode);
      gainNode.connect(destination);

      this.noiseGateNodes = { source, analyser, gainNode, destination };

      // Start noise gate processing
      this.processNoiseGate();

      console.log('[AudioManager] Noise gate enabled:', {
        threshold: this.config.noiseGateThreshold,
        attack: this.config.noiseGateAttack,
        release: this.config.noiseGateRelease
      });

      return destination.stream;
    } catch (err) {
      console.error('[AudioManager] Error applying noise gate:', err);
      return stream;
    }
  }

  /**
   * Process audio through noise gate
   */
  private processNoiseGate(): void {
    if (!this.noiseGateNodes) return;

    const { analyser, gainNode } = this.noiseGateNodes;
    const threshold = this.config.noiseGateThreshold || -40;
    const attack = (this.config.noiseGateAttack || 10) / 1000; // Convert to seconds
    const release = (this.config.noiseGateRelease || 100) / 1000;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let currentGain = 0;
    let isGateOpen = false;

    const process = () => {
      if (!this.localStream || !this.noiseGateNodes) return;

      // Get current audio level
      analyser.getByteFrequencyData(dataArray);
      
      // Calculate RMS (Root Mean Square) level
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const normalized = dataArray[i] / 255;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / dataArray.length);
      
      // Convert to decibels
      const db = 20 * Math.log10(rms || 0.0001);

      // Determine if gate should be open
      const shouldBeOpen = db > threshold;

      // Apply attack/release
      if (shouldBeOpen && !isGateOpen) {
        // Attack: Open gate quickly
        isGateOpen = true;
        currentGain = Math.min(1, currentGain + attack);
      } else if (!shouldBeOpen && isGateOpen) {
        // Release: Close gate slowly
        isGateOpen = false;
      }

      // Smooth gain changes
      if (isGateOpen) {
        currentGain = Math.min(1, currentGain + attack);
      } else {
        currentGain = Math.max(0, currentGain - release);
      }

      // Apply gain
      gainNode.gain.setValueAtTime(currentGain, this.audioContext!.currentTime);

      // Continue processing
      requestAnimationFrame(process);
    };

    process();
  }

  /**
   * Stop capturing audio
   */
  stopCapture(): void {
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = undefined;
    }
    if (this.processedStream && this.processedStream !== this.localStream) {
      this.processedStream.getTracks().forEach(track => track.stop());
      this.processedStream = undefined;
    }
    if (this.noiseGateNodes) {
      this.noiseGateNodes.source.disconnect();
      this.noiseGateNodes.analyser.disconnect();
      this.noiseGateNodes.gainNode.disconnect();
      this.noiseGateNodes = undefined;
    }
    console.log('[AudioManager] Stopped audio capture');
  }
  
  /**
   * Switch to a different audio input device
   */
  async switchInputDevice(deviceId: string): Promise<MediaStream> {
    this.stopCapture();
    return this.startCapture(deviceId);
  }
  
  /**
   * Get the local audio stream (processed with noise gate if enabled)
   */
  getLocalStream(): MediaStream | undefined {
    return this.processedStream || this.localStream;
  }
  
  /**
   * Mute or unmute local audio
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    const stream = this.processedStream || this.localStream;
    
    if (stream) {
      stream.getAudioTracks().forEach(track => {
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

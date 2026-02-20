import Store from 'electron-store';
import { logger } from './logger.js';

export interface AppSettings {
  // User preferences
  username: string | null;
  userId: string | null;
  
  // Audio settings
  audioInputDevice: string | null;
  audioOutputDevice: string | null;
  microphoneVolume: number;
  outputVolume: number;
  
  // Features
  spatialAudioEnabled: boolean;
  pushToTalkEnabled: boolean;
  pushToTalkKey: string;
  
  // UI preferences
  windowBounds: {
    width: number;
    height: number;
    x?: number;
    y?: number;
  };
  
  // Room history
  recentRooms: Array<{
    roomId: string;
    name?: string;
    lastJoined: string;
  }>;
  
  // Privacy
  analyticsEnabled: boolean;
}

const defaultSettings: AppSettings = {
  username: null,
  userId: null,
  audioInputDevice: null,
  audioOutputDevice: null,
  microphoneVolume: 1.0,
  outputVolume: 1.0,
  spatialAudioEnabled: false,
  pushToTalkEnabled: false,
  pushToTalkKey: 'Space',
  windowBounds: {
    width: 1200,
    height: 800
  },
  recentRooms: [],
  analyticsEnabled: true
};

class SettingsManager {
  private store: Store<AppSettings>;

  constructor() {
    this.store = new Store<AppSettings>({
      defaults: defaultSettings,
      name: 'settings',
      clearInvalidConfig: true
    });
    
    logger.info('Settings initialized');
    logger.debug('Settings store path:', (this.store as any).path);
  }

  // Get a setting value
  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return (this.store as any).get(key);
  }

  // Set a setting value
  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    (this.store as any).set(key, value);
    logger.debug(`Setting updated: ${key}`);
  }

  // Get all settings
  getAll(): AppSettings {
    return (this.store as any).store;
  }

  // Reset to defaults
  reset(): void {
    (this.store as any).clear();
    logger.info('Settings reset to defaults');
  }

  // Add recent room
  addRecentRoom(roomId: string, name?: string): void {
    const recent = this.get('recentRooms');
    
    // Remove if already exists
    const filtered = recent.filter(r => r.roomId !== roomId);
    
    // Add to front
    filtered.unshift({
      roomId,
      name,
      lastJoined: new Date().toISOString()
    });
    
    // Keep only last 10
    this.set('recentRooms', filtered.slice(0, 10));
  }

  // Get settings file path (for debugging)
  getPath(): string {
    return (this.store as any).path;
  }
}

// Export singleton instance
export const settings = new SettingsManager();

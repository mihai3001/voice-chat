/**
 * ChatManager - Handles P2P text/image messaging via WebRTC data channels
 */

import type { MeshConnection } from './MeshConnection.js';
import { ChatStorage, ChatMessage } from './ChatStorage.js';

export interface ChatConfig {
  roomId: string;
  peerId: string;
  username: string;
  meshConnection: MeshConnection;
  storageType?: 'local' | 'api';
  apiUrl?: string;
}

export type ChatMessageHandler = (message: ChatMessage) => void;

export class ChatManager {
  private roomId: string;
  private peerId: string;
  private username: string;
  private meshConnection: MeshConnection;
  private storage: ChatStorage;
  private messageHandlers: Set<ChatMessageHandler> = new Set();
  
  constructor(config: ChatConfig) {
    this.roomId = config.roomId;
    this.peerId = config.peerId;
    this.username = config.username;
    this.meshConnection = config.meshConnection;
    this.storage = new ChatStorage(config.storageType || 'local', config.apiUrl);
    
    this.setupDataChannelHandlers();
  }
  
  /**
   * Setup handlers for incoming data channel messages
   */
  private setupDataChannelHandlers() {
    this.meshConnection.onDataReceived((peerId: string, data: any) => {
      try {
        const message: ChatMessage = JSON.parse(data);
        
        // Validate message
        if (!message.id || !message.type || message.roomId !== this.roomId) {
          console.warn('Invalid message received:', message);
          return;
        }
        
        // Save to storage
        this.storage.saveMessage(message);
        
        // Notify handlers
        this.messageHandlers.forEach(handler => handler(message));
      } catch (err) {
        console.error('Error handling data channel message:', err);
      }
    });
  }
  
  /**
   * Send a text message
   */
  async sendTextMessage(text: string): Promise<void> {
    if (!text.trim()) return;
    
    const message: ChatMessage = {
      id: this.generateMessageId(),
      roomId: this.roomId,
      senderId: this.peerId,
      senderUsername: this.username,
      type: 'text',
      content: text,
      timestamp: Date.now()
    };
    
    // Save locally
    await this.storage.saveMessage(message);
    
    // Broadcast to all peers
    this.meshConnection.sendData(JSON.stringify(message));
    
    // Notify local handlers
    this.messageHandlers.forEach(handler => handler(message));
  }
  
  /**
   * Send an image message
   */
  async sendImageMessage(file: File): Promise<void> {
    // Validate file
    if (!file.type.startsWith('image/')) {
      throw new Error('File must be an image');
    }
    
    // Limit image size to 5MB for P2P transfer
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
      throw new Error('Image must be less than 5MB');
    }
    
    // Convert to base64
    const base64 = await this.fileToBase64(file);
    
    const message: ChatMessage = {
      id: this.generateMessageId(),
      roomId: this.roomId,
      senderId: this.peerId,
      senderUsername: this.username,
      type: 'image',
      content: base64,
      timestamp: Date.now(),
      metadata: {
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type
      }
    };
    
    // Save locally
    await this.storage.saveMessage(message);
    
    // Broadcast to all peers
    this.meshConnection.sendData(JSON.stringify(message));
    
    // Notify local handlers
    this.messageHandlers.forEach(handler => handler(message));
  }
  
  /**
   * Get message history
   */
  async getMessages(limit?: number): Promise<ChatMessage[]> {
    return this.storage.getMessages(this.roomId, limit);
  }
  
  /**
   * Clear all messages for current room
   */
  async clearMessages(): Promise<void> {
    await this.storage.clearMessages(this.roomId);
  }
  
  /**
   * Register handler for incoming messages
   */
  onMessage(handler: ChatMessageHandler): void {
    this.messageHandlers.add(handler);
  }
  
  /**
   * Remove message handler
   */
  offMessage(handler: ChatMessageHandler): void {
    this.messageHandlers.delete(handler);
  }
  
  /**
   * Cleanup
   */
  cleanup(): void {
    this.messageHandlers.clear();
  }
  
  /**
   * Generate unique message ID
   */
  private generateMessageId(): string {
    return `${this.peerId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Convert file to base64
   */
  private fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
}

/**
 * ChatStorage - Abstraction layer for message persistence
 * Can easily swap between localStorage, IndexedDB, or API calls
 */

export interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderUsername: string;
  type: 'text' | 'image';
  content: string; // Text content or base64 image data
  timestamp: number;
  metadata?: {
    fileName?: string;
    fileSize?: number;
    mimeType?: string;
  };
}

export interface ChatStorageAdapter {
  saveMessage(message: ChatMessage): Promise<void>;
  getMessages(roomId: string, limit?: number): Promise<ChatMessage[]>;
  clearMessages(roomId: string): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
}

/**
 * LocalStorage implementation
 */
export class LocalStorageChatAdapter implements ChatStorageAdapter {
  private storageKey = 'voice-chat-messages';
  
  async saveMessage(message: ChatMessage): Promise<void> {
    const messages = await this.getAllMessages();
    messages.push(message);
    
    // Keep only last 1000 messages per room to avoid storage limits
    const roomMessages = messages.filter(m => m.roomId === message.roomId);
    if (roomMessages.length > 1000) {
      const toRemove = roomMessages.slice(0, roomMessages.length - 1000);
      const filteredMessages = messages.filter(
        m => !toRemove.some(r => r.id === m.id)
      );
      localStorage.setItem(this.storageKey, JSON.stringify(filteredMessages));
    } else {
      localStorage.setItem(this.storageKey, JSON.stringify(messages));
    }
  }
  
  async getMessages(roomId: string, limit: number = 100): Promise<ChatMessage[]> {
    const messages = await this.getAllMessages();
    return messages
      .filter(m => m.roomId === roomId)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-limit);
  }
  
  async clearMessages(roomId: string): Promise<void> {
    const messages = await this.getAllMessages();
    const filtered = messages.filter(m => m.roomId !== roomId);
    localStorage.setItem(this.storageKey, JSON.stringify(filtered));
  }
  
  async deleteMessage(messageId: string): Promise<void> {
    const messages = await this.getAllMessages();
    const filtered = messages.filter(m => m.id !== messageId);
    localStorage.setItem(this.storageKey, JSON.stringify(filtered));
  }
  
  private async getAllMessages(): Promise<ChatMessage[]> {
    const data = localStorage.getItem(this.storageKey);
    return data ? JSON.parse(data) : [];
  }
}

/**
 * API implementation (placeholder for future database backend)
 */
export class ApiChatAdapter implements ChatStorageAdapter {
  private apiUrl: string;
  
  constructor(apiUrl: string) {
    this.apiUrl = apiUrl;
  }
  
  async saveMessage(message: ChatMessage): Promise<void> {
    await fetch(`${this.apiUrl}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message)
    });
  }
  
  async getMessages(roomId: string, limit: number = 100): Promise<ChatMessage[]> {
    const response = await fetch(
      `${this.apiUrl}/messages/${roomId}?limit=${limit}`
    );
    return response.json();
  }
  
  async clearMessages(roomId: string): Promise<void> {
    await fetch(`${this.apiUrl}/messages/${roomId}`, {
      method: 'DELETE'
    });
  }
  
  async deleteMessage(messageId: string): Promise<void> {
    await fetch(`${this.apiUrl}/messages/${messageId}`, {
      method: 'DELETE'
    });
  }
}

/**
 * Factory to create storage adapter based on config
 */
export class ChatStorage {
  private adapter: ChatStorageAdapter;
  
  constructor(type: 'local' | 'api' = 'local', apiUrl?: string) {
    if (type === 'api' && apiUrl) {
      this.adapter = new ApiChatAdapter(apiUrl);
    } else {
      this.adapter = new LocalStorageChatAdapter();
    }
  }
  
  saveMessage(message: ChatMessage): Promise<void> {
    return this.adapter.saveMessage(message);
  }
  
  getMessages(roomId: string, limit?: number): Promise<ChatMessage[]> {
    return this.adapter.getMessages(roomId, limit);
  }
  
  clearMessages(roomId: string): Promise<void> {
    return this.adapter.clearMessages(roomId);
  }
  
  deleteMessage(messageId: string): Promise<void> {
    return this.adapter.deleteMessage(messageId);
  }
}

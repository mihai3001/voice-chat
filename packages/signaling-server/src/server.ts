import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*', // TODO: Configure properly in production
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Store active rooms and their participants
interface Room {
  id: string;
  peers: Map<string, PeerInfo>;
  screenSharingPeers: Set<string>; // Track who is currently screen sharing
}

interface PeerInfo {
  socketId: string;
  peerId: string;
  username?: string;
}

const rooms = new Map<string, Room>();

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

io.on('connection', (socket) => {
  console.log(`[${new Date().toISOString()}] Client connected: ${socket.id}`);

  // Join a room (channel)
  socket.on('join-room', (data: { roomId: string; peerId: string; username?: string }) => {
    const { roomId, peerId, username } = data;
    
    console.log(`[${new Date().toISOString()}] ${peerId} (${username || 'anonymous'}) joining room: ${roomId}`);
    
    // Get or create room
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        id: roomId,
        peers: new Map(),
        screenSharingPeers: new Set()
      });
    }
    
    const room = rooms.get(roomId)!;
    
    // Get list of existing peers in the room
    const existingPeers = Array.from(room.peers.values()).map(p => ({
      peerId: p.peerId,
      username: p.username
    }));
    
    // Add this peer to the room
    room.peers.set(peerId, {
      socketId: socket.id,
      peerId,
      username
    });
    
    // Join socket room for broadcasting
    socket.join(roomId);
    
    // Get list of peers currently screen sharing
    const screenSharingPeers = Array.from(room.screenSharingPeers);
    
    // Send list of existing peers to the new peer
    socket.emit('room-joined', {
      roomId,
      peers: existingPeers
    });
    
    // Notify new peer about active screen shares
    screenSharingPeers.forEach(sharingPeerId => {
      socket.emit('screen-available', { peerId: sharingPeerId });
      console.log(`[${new Date().toISOString()}] Notified ${peerId} about screen share from ${sharingPeerId}`);
    });
    
    // Notify existing peers about the new peer
    socket.to(roomId).emit('peer-joined', {
      peerId,
      username
    });
    
    console.log(`[${new Date().toISOString()}] Room ${roomId} now has ${room.peers.size} peers`);
  });

  // Relay WebRTC signaling messages (offer, answer, ICE candidates)
  socket.on('signal', (data: { 
    roomId: string; 
    targetPeerId: string; 
    signal: any;
    type: 'offer' | 'answer' | 'ice-candidate';
  }) => {
    const { roomId, targetPeerId, signal, type } = data;
    
    const room = rooms.get(roomId);
    if (!room) {
      console.error(`Room ${roomId} not found`);
      return;
    }
    
    const targetPeer = room.peers.get(targetPeerId);
    if (!targetPeer) {
      console.error(`Target peer ${targetPeerId} not found in room ${roomId}`);
      return;
    }
    
    // Find sender's peer ID
    const senderEntry = Array.from(room.peers.entries()).find(
      ([_, peer]) => peer.socketId === socket.id
    );
    
    if (!senderEntry) {
      console.error(`Sender not found in room ${roomId}`);
      return;
    }
    
    const [senderPeerId] = senderEntry;
    
    // Forward signal to target peer
    io.to(targetPeer.socketId).emit('signal', {
      fromPeerId: senderPeerId,
      signal,
      type
    });
    
    console.log(`[${new Date().toISOString()}] Relayed ${type} from ${senderPeerId} to ${targetPeerId}`);
  });

  // Screen sharing events
  socket.on('screen-available', (data: { roomId: string; peerId: string }) => {
    const { roomId, peerId } = data;
    
    console.log(`[${new Date().toISOString()}] Screen available from ${peerId} in room ${roomId}`);
    
    const room = rooms.get(roomId);
    if (room) {
      room.screenSharingPeers.add(peerId);
    }
    
    // Broadcast to all other peers in the room
    socket.to(roomId).emit('screen-available', { peerId });
  });

  socket.on('screen-unavailable', (data: { roomId: string; peerId: string }) => {
    const { roomId, peerId } = data;
    
    console.log(`[${new Date().toISOString()}] Screen unavailable from ${peerId} in room ${roomId}`);
    
    const room = rooms.get(roomId);
    if (room) {
      room.screenSharingPeers.delete(peerId);
    }
    
    // Broadcast to all other peers in the room
    socket.to(roomId).emit('screen-unavailable', { peerId });
  });

  socket.on('request-screen', (data: { roomId: string; targetPeerId: string; requesterPeerId: string }) => {
    const { roomId, targetPeerId, requesterPeerId } = data;
    
    console.log(`[${new Date().toISOString()}] ${requesterPeerId} requesting screen from ${targetPeerId}`);
    
    const room = rooms.get(roomId);
    if (!room) {
      console.error(`Room ${roomId} not found`);
      return;
    }
    
    const targetPeer = room.peers.get(targetPeerId);
    if (!targetPeer) {
      console.error(`Target peer ${targetPeerId} not found in room ${roomId}`);
      return;
    }
    
    // Forward request to target peer
    io.to(targetPeer.socketId).emit('request-screen', { requesterPeerId });
  });

  socket.on('stop-request-screen', (data: { roomId: string; targetPeerId: string; requesterPeerId: string }) => {
    const { roomId, targetPeerId, requesterPeerId } = data;
    
    console.log(`[${new Date().toISOString()}] ${requesterPeerId} stopped viewing screen from ${targetPeerId}`);
    
    const room = rooms.get(roomId);
    if (!room) {
      console.error(`Room ${roomId} not found`);
      return;
    }
    
    const targetPeer = room.peers.get(targetPeerId);
    if (!targetPeer) {
      console.error(`Target peer ${targetPeerId} not found in room ${roomId}`);
      return;
    }
    
    // Forward stop request to target peer
    io.to(targetPeer.socketId).emit('stop-request-screen', { requesterPeerId });
  });

  socket.on('screen-ready', (data: { roomId: string; viewerPeerId: string; sharerPeerId: string }) => {
    const { roomId, viewerPeerId, sharerPeerId } = data;
    
    console.log(`[${new Date().toISOString()}] Screen ready from ${sharerPeerId} for viewer ${viewerPeerId}`);
    
    const room = rooms.get(roomId);
    if (!room) {
      console.error(`Room ${roomId} not found`);
      return;
    }
    
    const viewerPeer = room.peers.get(viewerPeerId);
    if (!viewerPeer) {
      console.error(`Viewer peer ${viewerPeerId} not found in room ${roomId}`);
      return;
    }
    
    // Forward screen-ready notification to viewer
    io.to(viewerPeer.socketId).emit('screen-ready', { sharerPeerId });
  });

  // Handle peer disconnect
  socket.on('disconnect', () => {
    console.log(`[${new Date().toISOString()}] Client disconnected: ${socket.id}`);
    
    // Find and remove peer from all rooms
    for (const [roomId, room] of rooms.entries()) {
      const peerEntry = Array.from(room.peers.entries()).find(
        ([_, peer]) => peer.socketId === socket.id
      );
      
      if (peerEntry) {
        const [peerId] = peerEntry;
        room.peers.delete(peerId);
        room.screenSharingPeers.delete(peerId); // Clean up screen sharing state
        
        // Notify other peers in the room
        socket.to(roomId).emit('peer-left', { peerId });
        
        console.log(`[${new Date().toISOString()}] ${peerId} left room ${roomId}`);
        
        // Remove empty rooms
        if (room.peers.size === 0) {
          rooms.delete(roomId);
          console.log(`[${new Date().toISOString()}] Room ${roomId} deleted (empty)`);
        }
      }
    }
  });

  // Explicit leave room
  socket.on('leave-room', (data: { roomId: string; peerId: string }) => {
    const { roomId, peerId } = data;
    const room = rooms.get(roomId);
    
    if (room) {
      room.peers.delete(peerId);
      room.screenSharingPeers.delete(peerId); // Clean up screen sharing state
      socket.leave(roomId);
      socket.to(roomId).emit('peer-left', { peerId });
      
      console.log(`[${new Date().toISOString()}] ${peerId} left room ${roomId}`);
      
      if (room.peers.size === 0) {
        rooms.delete(roomId);
        console.log(`[${new Date().toISOString()}] Room ${roomId} deleted (empty)`);
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   Signaling Server Started             ║
║   Port: ${PORT.toString().padEnd(30)}║
║   Time: ${new Date().toISOString().padEnd(30)}║
╚════════════════════════════════════════╝
  `);
});

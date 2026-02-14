# Voice Chat P2P

Decentralized peer-to-peer voice chat system - a Discord alternative with no central voice relay server.

## Architecture

- **Dynamic topology**: Mesh P2P for ≤4 users, host-based forwarding for 5+ users
- **Self-hosted signaling**: WebSocket server for peer discovery (you control it)
- **WebRTC**: Browser-standard voice communication with encryption
- **Monorepo**: Three packages managed with pnpm workspaces

## Packages

- **`signaling-server`**: WebSocket server for peer discovery and SDP exchange
- **`client-core`**: Shared WebRTC logic (connection management, audio handling)
- **`desktop-app`**: Electron desktop application

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 8+

### Installation

```bash
pnpm install
```

### Development

Run all packages in parallel:
```bash
pnpm dev
```

Or run individually:
```bash
pnpm dev:signaling    # Start signaling server
pnpm dev:desktop      # Start Electron app
```

**Quick start (Windows):**
```powershell
.\start.ps1           # Starts signaling server + desktop app
```

### Testing with Multiple Clients

1. **First client**: Run `.\start.ps1` or `pnpm dev:desktop`
2. **Additional clients**: Run the script again in new terminals
3. **Important**: Use the same **Room ID** in all clients
4. **Grant microphone permissions** when prompted
5. **Speak** - you should hear each other!

The app uses WebRTC mesh topology where each peer connects directly to every other peer (works great for 2-4 people).

## Deployment for Remote Friends

**Important**: The signaling server does NOT relay voice data (very low bandwidth ~1KB/s). It only helps peers find each other and exchange connection info. Voice goes directly peer-to-peer via WebRTC.

📖 **See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed deployment instructions**

**Quick options:**

1. **Railway.app** (easiest, free tier): 
   - Push to GitHub → Connect to Railway → Deploy
   - Get URL: `https://your-app.up.railway.app`

2. **Ngrok** (testing):
   ```bash
   ngrok http 3000
   ```
   Or: `.\expose-signaling.ps1`

3. **Docker**:
   ```bash
   docker-compose up -d
   ```

4. **VPS** ($5/mo DigitalOcean/Linode):
   ```bash
   pnpm build
   cd packages/signaling-server
   pm2 start dist/server.js
   ```

Everyone uses the **same signaling server URL** in the desktop app.

### Build

```bash
pnpm build
```

## Project Structure

```
voice-chat-p2p/
├── packages/
│   ├── signaling-server/    # WebSocket signaling server
│   │   ├── src/
│   │   │   └── server.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── client-core/         # Shared WebRTC logic
│   │   ├── src/
│   │   │   ├── MeshConnection.ts
│   │   │   ├── AudioManager.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── desktop-app/         # Electron app
│       ├── src/
│       │   ├── main.ts
│       │   └── renderer/
│       ├── package.json
│       └── tsconfig.json
│
├── package.json             # Root monorepo config
├── pnpm-workspace.yaml      # pnpm workspace config
└── README.md
```

## Roadmap

### Phase 1: MVP - Mesh P2P ✅ COMPLETE
- [x] WebSocket signaling server
- [x] WebRTC mesh connections (2-4 people)
- [x] Audio capture and playback
- [x] Basic Electron UI

### Phase 2: Host-Based Topology
- [ ] Dynamic topology switching
- [ ] Host election algorithm
- [ ] Audio forwarding for 5+ users

### Phase 3: NAT Traversal
- [ ] NAT type detection
- [ ] Peer-assisted TURN
- [ ] Host failover

### Phase 4: Production
- [ ] Security and encryption
- [ ] UI improvements
- [ ] Web browser support

## Technology Stack

- **WebRTC**: Real-time communication
- **Socket.io**: WebSocket signaling
- **simple-peer**: WebRTC abstraction library
- **Electron**: Desktop application framework
- **TypeScript**: Type-safe development
- **pnpm**: Fast monorepo package manager

## License

MIT

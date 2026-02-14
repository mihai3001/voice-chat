# Deployment Guide - Voice Chat P2P

This guide covers deploying the **signaling server** so friends can connect remotely.

## Important: What Gets Deployed?

**Only the signaling server needs to be deployed.** 

- ✅ Signaling server → Cloud/VPS (helps peers find each other)
- ❌ Desktop app → Stays on each user's computer
- ❌ Voice data → Goes directly peer-to-peer (WebRTC)

**Bandwidth requirements**: ~1-5 KB/s per connection (just coordination, no voice!)

---

## Option 1: Railway.app (Easiest, Free Tier)

**Steps:**

1. **Push to GitHub**:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/voice-chat-p2p.git
   git push -u origin main
   ```

2. **Deploy to Railway**:
   - Go to [railway.app](https://railway.app)
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your repository
   - Railway auto-detects and deploys
   - Copy the public URL (e.g., `https://your-app.up.railway.app`)

3. **Use in app**:
   - In desktop app, set signaling server to: `https://your-app.up.railway.app`

---

## Option 2: Render.com (Free Tier)

**Steps:**

1. Push code to GitHub (same as above)

2. **Deploy**:
   - Go to [render.com](https://render.com)
   - Click "New" → "Web Service"
   - Connect GitHub repo
   - Render uses `render.yaml` config automatically
   - Copy the URL

3. **Use**: Set signaling server to your Render URL

---

## Option 3: DigitalOcean/VPS ($5/month)

**Setup:**

```bash
# On your VPS (Ubuntu)
sudo apt update
sudo apt install -y nodejs npm

# Install pnpm
npm install -g pnpm

# Clone repo
git clone https://github.com/YOUR_USERNAME/voice-chat-p2p.git
cd voice-chat-p2p

# Install and build
pnpm install
pnpm build

# Start signaling server
cd packages/signaling-server
node dist/server.js

# Or use PM2 for production
npm install -g pm2
pm2 start dist/server.js --name signaling-server
pm2 save
pm2 startup  # Enable auto-restart on reboot
```

**Configure firewall**:
```bash
sudo ufw allow 3000
```

**Use**: `http://YOUR_VPS_IP:3000`

---

## Option 4: Docker (Any Cloud with Docker Support)

**Build and run**:

```bash
# Build Docker image
docker build -f packages/signaling-server/Dockerfile -t voice-chat-signaling .

# Run container
docker run -d -p 3000:3000 --name signaling voice-chat-signaling

# Or use Docker Compose
docker-compose up -d
```

**Deploy to**:
- AWS ECS
- Google Cloud Run
- Azure Container Instances
- Any Docker hosting

---

## Option 5: Ngrok (Testing Only)

**For quick testing with friends**:

```bash
# Install ngrok: https://ngrok.com/download
# Sign up (free) and get auth token

# Configure
ngrok config add-authtoken YOUR_TOKEN

# Start tunnel
ngrok http 3000
```

You'll get a URL like: `https://abc123.ngrok-free.app`

**OR use the helper script**:
```powershell
.\expose-signaling.ps1
```

⚠️ **Limitations**:
- URL changes each restart (paid plan for static URLs)
- Sessions time out after 2 hours (free tier)
- Not suitable for production

---

## Option 6: Cloudflare Tunnel (Free, Permanent)

**Setup**:

```bash
# Install cloudflared
# Windows: https://github.com/cloudflare/cloudflared/releases

# Login
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create voice-chat-signaling

# Configure tunnel
cloudflared tunnel route dns voice-chat-signaling signaling.yourdomain.com

# Start tunnel
cloudflared tunnel run voice-chat-signaling --url http://localhost:3000
```

**Permanent URL**: `https://signaling.yourdomain.com`

---

## Security Considerations (Before Going Public)

Current implementation is for testing. For production, add:

### 1. HTTPS/TLS
```bash
# Use Nginx reverse proxy with Let's Encrypt
sudo apt install nginx certbot python3-certbot-nginx
sudo certbot --nginx -d signaling.yourdomain.com
```

### 2. Rate Limiting
Add to `server.ts`:
```typescript
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

app.use(limiter);
```

### 3. Authentication
Add API keys or OAuth before allowing room joins.

### 4. CORS Restrictions
Update `server.ts`:
```typescript
cors: {
  origin: ['https://your-domain.com'], // Only allow your domains
  methods: ['GET', 'POST']
}
```

---

## Recommended for Different Use Cases

| Use Case | Best Option | Cost |
|----------|-------------|------|
| Testing with 1-2 friends | Ngrok | Free |
| Small group (5-10 people) | Railway/Render | Free tier |
| Community (20+ people) | DigitalOcean VPS | $5/mo |
| Permanent/Production | VPS + Domain + HTTPS | $10/mo |
| Enterprise/Large scale | AWS/GCP with load balancer | Varies |

---

## Monitoring Your Deployment

**Check if signaling server is running**:
```bash
curl https://your-deployment-url/health
```

Should return:
```json
{
  "status": "ok",
  "rooms": 0,
  "timestamp": "2026-02-14T..."
}
```

**View logs**:
- Railway: Dashboard → Logs tab
- Render: Dashboard → Logs
- VPS: `pm2 logs signaling-server`
- Docker: `docker logs signaling`

---

## Sharing with Friends

Once deployed, share:

1. **Signaling Server URL**: `https://your-deployment-url`
2. **Desktop app**: Send them the built app or instructions to build locally
3. **Room ID**: Agree on a room name (e.g., `gaming-night`)

Everyone enters the **same signaling URL** and **same Room ID** to connect!

---

## Troubleshooting

**Can't connect to signaling server:**
- Check firewall allows port 3000
- Verify server is running: `curl URL/health`
- Check CORS settings if using web version

**Peers can't connect to each other:**
- This is a NAT/firewall issue (Phase 3 will handle this)
- Try from different networks to test
- For now, works best on same network or good NAT types

**High latency:**
- Deploy signaling server closer to users geographically
- Use a VPS in the same region as most users

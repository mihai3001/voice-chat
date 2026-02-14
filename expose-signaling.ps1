# Expose Signaling Server with Ngrok

Write-Host "Installing ngrok..." -ForegroundColor Cyan

# Download and start ngrok (one-time setup)
# 1. Sign up at https://ngrok.com (free)
# 2. Get your auth token
# 3. Run: ngrok config add-authtoken YOUR_TOKEN

Write-Host ""
Write-Host "Starting ngrok tunnel on port 3000..." -ForegroundColor Yellow
Write-Host "Make sure signaling server is running first!" -ForegroundColor Red
Write-Host ""

# Start ngrok
ngrok http 3000

# You'll get a URL like: https://abc123.ngrok.io
# Share this URL with friends (they use it as signaling server URL)

# Voice Chat P2P - Quick Start

Write-Host "Starting Voice Chat P2P..." -ForegroundColor Cyan
Write-Host ""

# Check if signaling server is already running
$port3000InUse = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue

if (-not $port3000InUse) {
    Write-Host "[1/2] Starting signaling server..." -ForegroundColor Yellow
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PSScriptRoot'; cd packages\signaling-server; pnpm dev"
    Start-Sleep -Seconds 2
} else {
    Write-Host "[1/2] Signaling server already running on port 3000" -ForegroundColor Green
}

Write-Host "[2/2] Starting desktop app..." -ForegroundColor Yellow
cd packages\desktop-app
$env:NODE_ENV = 'development'
pnpm exec electron .

Write-Host ""
Write-Host "Done! To start another client, run this script again." -ForegroundColor Green

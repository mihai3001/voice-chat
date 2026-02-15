# Release Process

This document explains how to create releases and enable auto-updates for Voice Chat P2P.

## Overview

The app uses `electron-updater` to automatically check for and install updates from GitHub Releases. When you publish a new release, users will be notified and can update with one click.

## Creating a Release

### 1. Update Version

First, update the version in `packages/desktop-app/package.json`:

```json
{
  "version": "1.0.1"  // Increment this
}
```

### 2. Commit Changes

```bash
git add .
git commit -m "chore: bump version to 1.0.1"
git push origin main
```

### 3. Create and Push Tag

```bash
git tag v1.0.1
git push origin v1.0.1
```

### 4. Automatic Build

Once you push the tag, GitHub Actions will automatically:
- Build the app for Windows, macOS, and Linux
- Create installers for each platform
- Publish them to GitHub Releases
- Generate release notes

The process takes about 10-15 minutes.

## How Auto-Updates Work

### For Users

1. **Update Check**: When the app starts, it checks GitHub Releases for new versions (only in production builds, not during development)

2. **Update Notification**: If an update is available, a banner appears at the top:
   ```
   🎉 Update Available!
   Version 1.0.1 is available. Click to download.
   [Download] [Later]
   ```

3. **Download**: User clicks "Download" and the update downloads in the background with a progress bar

4. **Install**: When download completes:
   ```
   ✅ Update Ready!
   Update has been downloaded. Restart to install.
   [Restart & Install] [Later]
   ```

5. **Restart**: User clicks "Restart & Install" and the app restarts with the new version

### Technical Details

- **Update Server**: GitHub Releases (free, no server costs)
- **Update Channel**: Stable (from main branch tags)
- **Update Frequency**: Checked on app startup
- **File Format**: 
  - Windows: NSIS installer (.exe) + portable (.exe)
  - macOS: DMG (.dmg)
  - Linux: AppImage (.AppImage)
- **Auto-install**: Enabled (installs on app quit)

## Release Types

### Windows

Two formats are built:
1. **NSIS Installer** (`Voice-Chat-P2P-Setup-1.0.1.exe`): 
   - Full installer with auto-update support
   - Recommended for most users
   - Can be uninstalled via Windows Settings

2. **Portable** (`Voice-Chat-P2P-1.0.1.exe`):
   - No installation needed
   - **Does not support auto-updates**
   - Use for USB drives or temporary use

### macOS

- **DMG** (`Voice-Chat-P2P-1.0.1.dmg`):
  - Standard macOS disk image
  - Drag to Applications folder
  - Auto-update supported

### Linux

- **AppImage** (`Voice-Chat-P2P-1.0.1.AppImage`):
  - Universal Linux format
  - Make executable: `chmod +x Voice-Chat-P2P-1.0.1.AppImage`
  - Run directly, no installation needed
  - Auto-update supported

## Version Numbering

Follow [Semantic Versioning](https://semver.org/):

- **Major** (1.0.0 → 2.0.0): Breaking changes
- **Minor** (1.0.0 → 1.1.0): New features, backward compatible
- **Patch** (1.0.0 → 1.0.1): Bug fixes, backward compatible

Examples:
- `v1.0.1` - Bug fix release
- `v1.1.0` - Added text chat feature
- `v2.0.0` - Redesigned UI (breaking change)

## Testing Releases

### Test Auto-Update Locally

1. Build and package current version:
   ```bash
   cd packages/desktop-app
   pnpm build && pnpm package
   ```

2. Install the built app

3. Bump version in package.json

4. Create a GitHub release with the new version

5. Run the installed app - it should detect and offer the update

### Test Without Publishing

For testing before release:

1. Set `publish.provider` to `generic` in package.json
2. Host files on a test server
3. Point `electron-updater` to your test server

## Troubleshooting

### Update Check Fails

**Problem**: "Update error: Error: ..."

**Solutions**:
- Check internet connection
- Verify GitHub repository is public
- Check GitHub releases exist
- Ensure package.json has correct repository URL

### Update Download Fails

**Problem**: Download starts but fails

**Solutions**:
- Check available disk space
- Verify GitHub release assets are uploaded
- Check firewall/antivirus settings

### Update Not Detected

**Problem**: New release exists but app doesn't detect it

**Solutions**:
- Verify version in package.json matches tag
- Ensure version is higher than current version
- Check that release is not marked as "draft"
- Wait a few minutes for GitHub CDN to propagate

### Code Signing (Optional)

For production apps, you should code-sign your releases:

**Windows**:
```json
"win": {
  "certificateFile": "path/to/cert.pfx",
  "certificatePassword": "password"
}
```

**macOS**:
```json
"mac": {
  "identity": "Developer ID Application: Your Name",
  "hardenedRuntime": true,
  "gatekeeperAssess": false,
  "entitlements": "build/entitlements.mac.plist"
}
```

Without code signing:
- Windows: Users may see "Unknown publisher" warning
- macOS: Users need to right-click → Open first time
- Linux: No issues

## Distribution Options

### Current Setup (Recommended)
- ✅ Free hosting via GitHub Releases
- ✅ Auto-updates work seamlessly
- ✅ No server maintenance needed
- ✅ Built-in versioning and release notes

### Alternative: Custom Update Server
If you prefer to host updates yourself:

1. Build a simple update server (Express.js)
2. Serve update files and metadata
3. Point electron-updater to your server:
   ```json
   "publish": {
     "provider": "generic",
     "url": "https://your-server.com/updates"
   }
   ```

## Best Practices

1. **Test Before Release**: Always test the packaged app before creating a release
2. **Write Release Notes**: Explain what's new in each version
3. **Backup**: Keep a backup of working releases
4. **Semantic Versions**: Use clear version numbers
5. **Staged Rollout**: Consider releasing to a small group first
6. **Monitor Issues**: Watch for bug reports after release
7. **Hotfix Process**: Keep a fast path for critical bug fixes

## Commands Reference

```bash
# Build everything
pnpm -r build

# Package desktop app
cd packages/desktop-app
pnpm package

# Create release
git tag v1.0.1
git push origin v1.0.1

# Delete tag (if mistake)
git tag -d v1.0.1
git push origin :refs/tags/v1.0.1

# List all releases
gh release list

# Download release assets
gh release download v1.0.1
```

## Security Considerations

1. **Update Integrity**: electron-updater verifies checksums
2. **HTTPS**: All updates must be served over HTTPS
3. **GitHub Security**: Uses GitHub's infrastructure security
4. **No Auto-Execute**: Updates require user confirmation
5. **Rollback**: Users can reinstall previous versions if needed

## Future Improvements

Potential enhancements for the release process:

- [ ] Delta updates (only download changes)
- [ ] Beta channel for testing
- [ ] Automatic rollback on crash
- [ ] Update size optimization
- [ ] Staged rollout percentages
- [ ] Analytics on update adoption
- [ ] In-app changelog viewer
- [ ] Background downloads

## Support

If users have issues with updates:

1. They can manually download from GitHub Releases
2. Portable version always available (no auto-update)
3. Previous versions remain available on GitHub

## Links

- [electron-updater Documentation](https://www.electron.build/auto-update)
- [electron-builder Documentation](https://www.electron.build/)
- [GitHub Releases](https://github.com/mihai3001/voice-chat/releases)
- [Semantic Versioning](https://semver.org/)

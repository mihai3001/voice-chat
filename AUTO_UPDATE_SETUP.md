# Auto-Update Setup Complete! 🎉

Your Voice Chat P2P app now has automatic update capabilities via GitHub Releases.

## ✅ What Was Added

### 1. **electron-updater** Integration
- Automatically checks for updates on app startup
- Downloads updates in the background
- Notifies users when updates are ready
- One-click install and restart

### 2. **GitHub Release Configuration**
- App is configured to check GitHub releases for updates
- Supports Windows (NSIS + Portable), macOS (DMG), and Linux (AppImage)
- No server costs - uses GitHub's free infrastructure

### 3. **Update UI**
- Beautiful banner appears at top of app when update is available
- Shows download progress
- "Download" and "Restart & Install" buttons
- "Later" option to dismiss

### 4. **Automated Release Workflow**
- GitHub Actions workflow automatically builds and publishes releases
- Triggered by pushing version tags (e.g., `v1.0.1`)
- Builds for all platforms: Windows, macOS, Linux

## 🚀 How to Create Your First Release

### Step 1: Update Version
Edit `packages/desktop-app/package.json`:
```json
{
  "version": "1.0.1"  // Change from 1.0.0 to 1.0.1
}
```

### Step 2: Commit and Push
```bash
git add .
git commit -m "chore: bump version to 1.0.1"
git push origin main
```

### Step 3: Create Release Tag
```bash
git tag v1.0.1
git push origin v1.0.1
```

### Step 4: Wait for Build (10-15 minutes)
- GitHub Actions will automatically build the app
- Go to: https://github.com/mihai3001/voice-chat/actions
- Watch the "Build and Release" workflow
- When complete, check: https://github.com/mihai3001/voice-chat/releases

## 📦 What Gets Built

### Windows
- **NSIS Installer** (`Voice-Chat-P2P-Setup-1.0.1.exe`) - Recommended, supports auto-update
- **Portable** (`Voice-Chat-P2P-1.0.1.exe`) - No install, but no auto-update

### macOS
- **DMG** (`Voice-Chat-P2P-1.0.1.dmg`) - Standard Mac installer

### Linux
- **AppImage** (`Voice-Chat-P2P-1.0.1.AppImage`) - Universal Linux format

## 🎯 How Users Get Updates

1. **First Time**: 
   - Share the GitHub release link with friends
   - They download and install the NSIS installer (Windows)
   
2. **Future Updates**:
   - When you push a new tag, their apps automatically detect the update
   - They see a banner: "🎉 Update Available!"
   - Click "Download" → progress bar shows download
   - Click "Restart & Install" → app updates automatically
   - **No need to send them files anymore!**

## 🧪 Testing Updates Locally

Before releasing to friends, test the update flow:

1. Build and install current version:
   ```bash
   cd packages/desktop-app
   pnpm build && pnpm package
   # Install the generated .exe
   ```

2. Create a test release on GitHub:
   ```bash
   # Bump version to 1.0.1 in package.json
   git commit -am "test release"
   git tag v1.0.1
   git push origin v1.0.1
   ```

3. Wait for GitHub Action to complete

4. Open the installed app - it should show update banner!

5. Click through the update process

## 🔧 Important Notes

### For Development
- Update checks only work in **packaged/production** builds
- Running via `npx electron .` won't check for updates (by design)
- You'll see console message: "Updates only available in production builds"

### For Production
- Users need internet connection to check for updates
- Updates are downloaded in the background
- Old versions remain functional (users choose when to update)
- Updates install on app restart

### Distribution Methods

**Before (Manual)**:
```
You: Build .exe → Send 100MB file to each friend
Friend: Download → Install → Repeat next update
```

**After (Auto-Update)**:
```
You: Push git tag → GitHub builds & publishes
Friends: App shows "Update Available" → Click update → Done!
```

## 📝 Version Numbers

Follow this pattern:
- `v1.0.0` → `v1.0.1` = Bug fixes (patch)
- `v1.0.0` → `v1.1.0` = New features (minor)
- `v1.0.0` → `v2.0.0` = Breaking changes (major)

Examples:
- Fixed audio bug → `v1.0.1`
- Added text chat → `v1.1.0`
- Complete redesign → `v2.0.0`

## 🎨 UI Preview

When an update is available, users see:

```
┌─────────────────────────────────────────────────────────────┐
│ 🔔  🎉 Update Available!                    [Download] [Later] │
│     Version 1.0.1 is available. Click to download.          │
└─────────────────────────────────────────────────────────────┘
```

While downloading:
```
┌─────────────────────────────────────────────────────────────┐
│ 🔔  Downloading update... 67%                          [Later] │
│     ▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░                                   │
└─────────────────────────────────────────────────────────────┘
```

After download:
```
┌─────────────────────────────────────────────────────────────┐
│ 🔔  ✅ Update Ready!                  [Restart & Install] [Later] │
│     Update has been downloaded. Restart to install.         │
└─────────────────────────────────────────────────────────────┘
```

## 🏗️ Files Created/Modified

### New Files:
- `.github/workflows/release.yml` - Automated release workflow
- `RELEASE.md` - Detailed release documentation
- `AUTO_UPDATE_SETUP.md` - This file

### Modified Files:
- `packages/desktop-app/package.json` - Added electron-updater, repository, publish config
- `packages/desktop-app/src/main.ts` - Auto-updater logic, IPC handlers
- `packages/desktop-app/src/preload.ts` - Exposed update events to renderer
- `packages/desktop-app/src/renderer/app.ts` - Update UI handlers
- `packages/desktop-app/src/renderer/index.html` - Update banner UI

## 🚨 Troubleshooting

### "Update error" in console
- Check internet connection
- Verify repository URL in package.json
- Ensure at least one release exists on GitHub

### Update not detected
- Version must be higher than current version
- Release must not be marked as "draft"
- Wait a few minutes after publishing

### GitHub Action fails
- Check Actions tab for error logs
- Ensure `GITHUB_TOKEN` is available (it's automatic)
- Verify all dependencies are in package.json

## 📚 Documentation

- `RELEASE.md` - Complete release guide with all details
- GitHub Actions logs - Build process and errors
- electron-updater docs - https://www.electron.build/auto-update

## ⚡ Quick Reference

```bash
# Create a new release
# 1. Update version in package.json
# 2. Run these commands:
git commit -am "chore: bump version to 1.0.1"
git tag v1.0.1
git push origin main
git push origin v1.0.1

# Check release status
# Visit: https://github.com/mihai3001/voice-chat/actions

# View releases
# Visit: https://github.com/mihai3001/voice-chat/releases

# Delete a tag (if mistake)
git tag -d v1.0.1
git push origin :refs/tags/v1.0.1
```

## 🎯 Next Steps

1. **Test Locally**: Build and test the update flow on your machine
2. **Create First Release**: Tag v1.0.1 and let GitHub build it
3. **Share with One Friend**: Have them install the NSIS version and verify it works
4. **Make an Update**: Create v1.0.2 to test auto-update flow
5. **Share with Everyone**: Send them the initial installer link once

## 💡 Pro Tips

1. **Use NSIS installer** - It supports auto-updates (portable doesn't)
2. **Test before releasing** - Always test locally first
3. **Write release notes** - GitHub auto-generates them from commits
4. **Keep portable option** - Some users prefer no-install version
5. **Semantic versioning** - Users understand 1.0.1 vs 1.1.0 vs 2.0.0

## 🎉 Benefits

- ✅ **No more manual distribution** - One tag push updates everyone
- ✅ **No server costs** - GitHub hosts everything for free
- ✅ **Professional experience** - Like Steam, Chrome, VS Code updates
- ✅ **Version tracking** - Always know what version friends are using
- ✅ **Rollback capable** - Old versions stay available on GitHub
- ✅ **Multi-platform** - Windows, Mac, Linux all automated

---

**You're all set!** 🚀 Your friends will love the auto-update feature. No more "can you send me the latest version?" messages!

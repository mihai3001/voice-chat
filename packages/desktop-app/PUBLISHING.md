# Publishing VoiceLink

## Setup (One-time)

1. **Get GitHub Token:**
   - Go to https://github.com/settings/tokens
   - Click "Generate new token (classic)"
   - Name: `VoiceLink Releases`
   - Select scope: ✅ `repo`
   - Copy the token (starts with `ghp_`)

2. **Update .env file:**
   ```bash
   # Edit packages/desktop-app/.env
   GH_TOKEN=ghp_your_actual_token_here
   ```

## Publishing a New Version

```bash
cd packages/desktop-app

# 1. Bump version
npm version patch  # 1.3.5 → 1.3.6
# or: npm version minor  # 1.3.5 → 1.4.0
# or: npm version major  # 1.3.5 → 2.0.0

# 2. Build and publish to GitHub
npm run publish
```

This will:
- ✅ Build the app
- ✅ Create installer + blockmap
- ✅ Create GitHub release (tag: v1.3.6)
- ✅ Upload all release files
- ✅ Users get auto-update notifications

## Files Published

- `VoiceLink Setup 1.3.6.exe` - Full installer (~76 MB)
- `VoiceLink Setup 1.3.6.exe.blockmap` - For differential updates
- `latest.yml` - Update metadata

Users will only download ~10-20% of the file size on updates thanks to the blockmap!

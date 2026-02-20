# Changelog

All notable changes to VoiceLink will be documented in this file.

## [1.3.6] - 2026-02-20

### Changed
- Deafen now also mutes microphone so others can't hear you
- When undeafening, restores your previous mute state
- Improved audio control UX for better privacy

### Fixed
- Deafen behavior now properly prevents others from hearing you

## [1.3.5] - 2026-02-19

### Added
- Settings persistence with electron-store
- File-based logging with winston (7-day rotation)
- Toast notification system for user feedback
- Input validation for room IDs, usernames, and URLs
- Auto-reconnection with exponential backoff
- Error handling for microphone permissions and connection issues

### Changed
- Reduced toast notification frequency to critical events only
- Window state (position, size) now persists between sessions

### Fixed
- Screen sharing re-view functionality
- Connection error messages now more specific and helpful

## [1.3.4] - 2026-02-18

### Added
- Room links with voicelink:// protocol handler
- Copy link button for easy room sharing
- Single instance lock (prevents multiple app instances)
- Differential package updates (NSIS installer)
- Automated GitHub publishing workflow

### Fixed
- Screen sharing bugs with multiple viewers
- Protocol handler registration on Windows

---

## Release Artifacts

Each release includes:
- **VoiceLink Setup [version].exe** - NSIS installer with auto-update support
- **VoiceLink [version].exe** - Portable version (no installation required)
- **VoiceLink Setup [version].exe.blockmap** - For differential updates (10-20% download size)

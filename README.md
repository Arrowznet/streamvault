# StreamVault v1.0.0

Self-hosted media server inspired by Plex.

## Installation

1. Install [Node.js](https://nodejs.org) (v18 or newer)
2. Install [FFmpeg](https://ffmpeg.org/download.html) to `ffmpeg/bin/ffmpeg.exe`
3. Run `npm install` in this folder
4. Start the server: `node server/index.js`
5. Open `http://localhost:7000` in your browser
6. Create your admin account on first run

## Requirements

- Node.js v18+
- FFmpeg (with ffprobe)
- Windows 10/11 (Linux support coming)

## Features

- DASH streaming with hardware acceleration (AMD AMF, NVIDIA NVENC)
- TMDB metadata (posters, backdrops, cast, crew)
- Multi-user support
- Resume playback
- Fullscreen with auto-hide controls
- Automatic update notifications

## Auto-Updates

StreamVault checks for updates on GitHub automatically.
When a new version is available, a notification appears in the app.

---
Built with ❤️ by Arrowznet

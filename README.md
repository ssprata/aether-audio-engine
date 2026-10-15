# AetherPlayer - Multi-Source Music Hub & Theme Creator

AetherPlayer is a personalizable music player and streaming interface that aggregates searches and audio streams from YouTube, Spotify, and SoundCloud into a unified desktop environment. It features a real-time visual customization engine (glassmorphism, neon glow, adjustable layouts, screen filters), playlist management with automatic local backups, and cloud synchronization.

---

## Features

### Unified Multi-Source Search & Playback
- Search queries across YouTube, Spotify, and SoundCloud simultaneously from a single search interface.
- Toggle individual platform filters on or off.
- Direct embedded playback without requiring external browser tabs.

### Visual Theme Creator
- Customize colors: primary accent, text, glass backgrounds, and glowing neon edges.
- Slider adjustments: border radius, backdrop glass blur, neon glow intensity, brightness, and contrast.
- Layout switching: swap sidebar between left and right, or position the player bar at the bottom or top.
- Preset management: save and load custom visual themes.
- Custom assets: upload custom background images and profile avatars.

### Playlist Management & Backup
- Create, reorder, edit, and manage custom playlists.
- Export and import playlists to and from JSON format.
- Automated local backups (`playlists_backup.json`) with one-click restore.
- Optional Firebase Cloud Sync for multi-device access.

---

## Quick Start (Standalone Windows App)

The fastest way to use AetherPlayer on Windows is using the pre-built standalone executable:

1. Download `AetherPlayer.exe` (or the portable zip archive) from the GitHub Releases page.
2. Run `AetherPlayer.exe`.
3. If Windows SmartScreen displays a warning on first run, select **More info** and click **Run anyway**.

No Python or Node.js runtime installation is required for the standalone executable.

---

## Running from Source

If you want to run or modify the source code locally, you will need Python 3.10+ (or Node.js).

### Option A: Python Desktop Runner (Recommended)

1. Clone the repository:
   ```bash
   git clone https://github.com/ssprata/Multi-music-tool.git
   cd Multi-music-tool
   ```

2. Install the required Python dependencies:
   ```bash
   pip install pywebview ytmusicapi yt-dlp
   ```

3. Launch the desktop application:
   ```bash
   python desktop.py
   ```
   Alternatively, run `AetherPlayer.bat` or run the standalone server directly via `python server.py`.

### Option B: Node.js Runner

1. Install project dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   npm start
   ```

3. Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

---

## Spotify API Integration (Optional)

By default, Spotify searches fall back to YouTube audio for playback. To fetch direct Spotify track and album metadata:

1. Visit the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Create an application to get your **Client ID** and **Client Secret**.
3. Open the **User Profile** tab in AetherPlayer, enter your credentials, and click **Save Credentials**.

Credentials are saved locally in `config.json`, which is excluded from version control.

---

## Android Version

An Android build configuration is available under the `android/` directory. For instructions on opening and compiling the APK with Android Studio, refer to [android/README.md](android/README.md).

---

## License

This project is licensed under the MIT License.

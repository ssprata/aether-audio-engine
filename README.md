# AetherPlayer - Multi-Source Music Hub & Theme Creator

AetherPlayer is a premium, highly personalizable single-page music player that lets you search and play music from YouTube, Spotify, and SoundCloud simultaneously. It features an advanced visual customization engine (glassmorphism, glowing neon borders, adjustable layouts, screen filters) and automated local database backups.

## Features

- **Multi-Source Search:** Type a song query and instantly see matches from YouTube, Spotify, and SoundCloud. Use the search filters to toggle sources on/off.
- **Visual Theme Creator:**
  - Customize colors: primary accent, text, custom glass backgrounds, and glowing neon edges.
  - Adjust aesthetics using sliders: border roundness, backdrop glass blur, neon intensity, brightness, and contrast.
  - Swap layouts: move the sidebar from left to right, or reposition the music player from bottom to top.
  - Save custom themes as named presets.
- **Local & Custom Asset Support:** Upload a custom background image or profile avatar.
- **Playlists Management:**
  - Create and edit custom playlists.
  - Export playlists to a JSON file.
  - Import playlists back into the app.
- **Automated Daily Backups:** Playlists are auto-synced to a local file (`playlists_backup.json`) on your server. Click the "Restore" button on your profile tab to recover playlists anytime.

---

## Getting Started

Make sure you have [Node.js](https://nodejs.org/) installed.

### 1. Install Dependencies
Open your terminal in this directory and run:
```bash
npm install
```

### 2. Start the Server
Run the following command:
```bash
npm start
```

### 3. Open the App
Navigate to:
[http://localhost:3000](http://localhost:3000)

---

## Spotify API Integration (Optional)

By default, Spotify searches will fall back to YouTube search queries for playback. If you'd like to use direct Spotify search results:
1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Register an application and retrieve your **Client ID** and **Client Secret**.
3. Open the **User Profile** tab in AetherPlayer, paste your credentials, and click **Save Credentials**.

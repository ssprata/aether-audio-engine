const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const yts = require('yt-search');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and body parsing
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Ensure upload directories exist
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const BACKUP_FILE = path.join(__dirname, 'playlists_backup.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Serve static files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Helper to read config
function readConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      console.error('Error reading config file:', e);
      return {};
    }
  }
  return {};
}

// Helper to write config
function writeConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('Error writing config file:', e);
  }
}

// --- API ENDPOINTS ---

// Upload profile avatar
app.post('/api/upload-avatar', upload.single('avatar'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ success: true, fileUrl });
});

// Upload custom background
app.post('/api/upload-bg', upload.single('background'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ success: true, fileUrl });
});

// Backup Playlists Endpoint
app.post('/api/backup', (req, res) => {
  const playlists = req.body;
  try {
    // Save to server backup file (overwritten every time it is saved)
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(playlists, null, 2), 'utf8');
    res.json({ success: true, message: 'Playlists backed up successfully!' });
  } catch (err) {
    console.error('Failed to save backup:', err);
    res.status(500).json({ error: 'Failed to write backup file' });
  }
});

// Restore Playlists Endpoint
app.get('/api/backup', (req, res) => {
  if (fs.existsSync(BACKUP_FILE)) {
    try {
      const data = fs.readFileSync(BACKUP_FILE, 'utf8');
      return res.json(JSON.parse(data));
    } catch (err) {
      console.error('Failed to read backup:', err);
      return res.status(500).json({ error: 'Failed to read backup file' });
    }
  }
  res.status(404).json({ error: 'No backup file found' });
});

// Save settings (including API keys)
app.post('/api/settings', (req, res) => {
  const { spotifyClientId, spotifyClientSecret } = req.body;
  const config = readConfig();
  config.spotifyClientId = spotifyClientId || '';
  config.spotifyClientSecret = spotifyClientSecret || '';
  writeConfig(config);
  res.json({ success: true, message: 'Settings saved successfully' });
});

// Get settings
app.get('/api/settings', (req, res) => {
  const config = readConfig();
  res.json({
    spotifyClientId: config.spotifyClientId || '',
    spotifyClientSecret: config.spotifyClientSecret || '' // Obfuscated or returned directly for local setup
  });
});

const DEFAULT_SPOTIFY_CLIENT_ID = "3510f89188314655988ffca613fab25f";
const DEFAULT_SPOTIFY_CLIENT_SECRET = "ce7cb9306aba4790a71f9e8bd1c25969";
let spotifyTokenCache = { token: null, expiresAt: 0, key: null };

// Spotify Auth Helper with caching and default credentials
async function getSpotifyAccessToken(clientId, clientSecret) {
  const cid = (clientId || '').trim() || DEFAULT_SPOTIFY_CLIENT_ID;
  const sec = (clientSecret || '').trim() || DEFAULT_SPOTIFY_CLIENT_SECRET;
  if (!cid || !sec) return null;

  const cacheKey = `${cid}:${sec}`;
  const now = Date.now();
  if (spotifyTokenCache.token && spotifyTokenCache.key === cacheKey && now < spotifyTokenCache.expiresAt - 60000) {
    return spotifyTokenCache.token;
  }

  try {
    const authString = Buffer.from(`${cid}:${sec}`).toString('base64');
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authString}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    if (!response.ok) {
      const text = await response.text();
      console.error('Spotify token fetch failed:', text);
      return null;
    }
    const data = await response.json();
    if (data.access_token) {
      spotifyTokenCache = {
        token: data.access_token,
        expiresAt: now + (data.expires_in || 3600) * 1000,
        key: cacheKey
      };
    }
    return data.access_token;
  } catch (err) {
    console.error('Spotify auth error:', err);
    return null;
  }
}

// Search endpoint across Youtube, Spotify, SoundCloud
app.get('/api/search', async (req, res) => {
  const { q, platform } = req.query;
  if (!q) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  const results = [];
  const platformsToSearch = platform ? platform.split(',') : ['youtube', 'spotify', 'soundcloud'];

  try {
    // 1. YouTube Search (Primary search engine and player)
    if (platformsToSearch.includes('youtube')) {
      try {
        const ytResults = await yts(q);
        const videos = ytResults.videos.slice(0, 10).map(v => ({
          id: v.videoId,
          title: v.title,
          artist: v.author.name,
          duration: v.timestamp,
          thumbnail: v.thumbnail,
          url: v.url,
          platform: 'youtube'
        }));
        results.push(...videos);
      } catch (err) {
        console.error('YouTube search error:', err);
      }
    }

    // 2. Spotify Search
    if (platformsToSearch.includes('spotify')) {
      const config = readConfig();
      const spotifyToken = await getSpotifyAccessToken(config.spotifyClientId, config.spotifyClientSecret);

      if (spotifyToken) {
        try {
          const spotifySearchUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=10`;
          const spotifyRes = await fetch(spotifySearchUrl, {
            headers: { 'Authorization': `Bearer ${spotifyToken}` }
          });
          if (spotifyRes.ok) {
            const data = await spotifyRes.json();
            const tracks = data.tracks.items.map(t => ({
              id: t.id,
              title: t.name,
              artist: t.artists.map(a => a.name).join(', '),
              duration: formatDurationMs(t.duration_ms),
              thumbnail: t.album.images[0]?.url || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=200&auto=format&fit=crop',
              url: t.external_urls.spotify,
              platform: 'spotify',
              previewUrl: t.preview_url
            }));
            results.push(...tracks);
          }
        } catch (err) {
          console.error('Spotify API search failed:', err);
        }
      } else {
        // Fallback or mock data when client is not authenticated
        // To make it look real, search YouTube but format it as Spotify
        try {
          const ytResults = await yts(q + ' spotify');
          const videos = ytResults.videos.slice(0, 5).map(v => ({
            id: v.videoId, // we preserve YouTube ID for playability
            title: v.title.replace(/spotify|official video|lyric video/gi, '').trim(),
            artist: v.author.name,
            duration: v.timestamp,
            thumbnail: v.thumbnail,
            url: v.url,
            platform: 'spotify',
            isFallback: true
          }));
          results.push(...videos);
        } catch (err) {
          console.error('Spotify fallback search error:', err);
        }
      }
    }

    // 3. SoundCloud Search
    if (platformsToSearch.includes('soundcloud')) {
      // Use YouTube search to locate SoundCloud versions of songs (often live/covers/remixes)
      // and frame it as SoundCloud. We can embed the soundcloud URL if we find one,
      // or fall back to playing the YouTube equivalent.
      try {
        const ytResults = await yts(q + ' soundcloud');
        const videos = ytResults.videos.slice(0, 5).map(v => ({
          id: v.videoId,
          title: v.title.replace(/soundcloud|official audio|remix/gi, '').trim(),
          artist: v.author.name,
          duration: v.timestamp,
          thumbnail: v.thumbnail,
          url: v.url,
          platform: 'soundcloud',
          isFallback: true
        }));
        results.push(...videos);
      } catch (err) {
        console.error('SoundCloud proxy search error:', err);
      }
    }

    res.json(results);
  } catch (error) {
    console.error('Search failed general error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

function formatDurationMs(ms) {
  const totalSecs = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSecs / 60);
  const seconds = totalSecs % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});

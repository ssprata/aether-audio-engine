// Overwrite Page Visibility API so YouTube iframe never auto-pauses in background/when phone is locked
try {
  Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  Object.defineProperty(document, 'webkitHidden', { get: () => false, configurable: true });
  Object.defineProperty(document, 'webkitVisibilityState', { get: () => 'visible', configurable: true });
  window.addEventListener('visibilitychange', (e) => {
    e.stopImmediatePropagation();
  }, true);
  document.addEventListener('visibilitychange', (e) => {
    e.stopImmediatePropagation();
  }, true);
} catch (e) {
  console.warn("Visibility override failed:", e);
}

// Mobile Battery & Background Power Saver
let isAppVisible = true;
window.setAppVisibilityState = function(visible) {
  isAppVisible = !!visible;
  if (!isAppVisible) {
    document.body.classList.add('app-backgrounded');
  } else {
    document.body.classList.remove('app-backgrounded');
    if (state.isPlaying && typeof updateTimelineUI === 'function') {
      updateTimelineUI();
    }
  }
};

// AetherPlayer Frontend Application State
let state = {
  activeTab: 'home',
  playlists: [],
  currentPlaylistId: null,
  currentSong: null,
  playQueue: [],
  currentQueueIndex: -1,
  isPlaying: false,
  isUserPaused: false,
  isTransitioning: false,
  volume: 70,
  isMuted: false,
  playbackPosition: 0,
  duration: 0,
  shuffle: false,
  repeat: 'none', // 'none', 'one', 'all'
  searchPlatforms: ['youtube', 'spotify', 'soundcloud'],
  customThemes: [],
  downloadedTrackIds: new Set(),
  offlineTracks: [],
  offlineStats: { totalBytes: 0, cacheBytes: 0, permanentBytes: 0, cacheCount: 0, permanentCount: 0, totalCount: 0 },
  smartCacheEnabled: false,
  smartCacheLimit: 200,
  downloadingTrackIds: new Set(),
  isDownloadingPlaylist: false,
  downloadingPlaylistName: '',
  cancelPlaylistDownload: false,
  playlistDownloadAbortController: null,
  currentPlaybackType: null,
  profile: {
    username: 'Music Enthusiast',
    avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?q=80&w=200&auto=format&fit=crop'
  },
  spotifyConfigured: false,
  lyrics: null,
  lyricsSynced: false,
  lyricsOpen: false,
  cachedLyricsTrackId: null,
  lyricsDebounceTimer: null,
  playlistStyle: 'image-name', // 'image-name', 'image-only', 'name-only'
  lyricsMode: 0, // 0 = off, 1 = drawer, 2 = widget
  lyricsFontSize: 18,
  lyricsFontFamily: 'Outfit',
  lyricsCustomFont: '',
  stationAnchor: null,       // Seed song/vibe for recommendations
  isRadioSession: false,     // True if currently playing a radio/station session
  autoplayEnabled: true,     // Endless autoplay enabled by default
  activeRightTab: 'queue',   // 'queue', 'recent', 'details'
  isFetchingMoreQueue: false
};

// Player Reference variables
let ytPlayer = null;
let ytPlayerReady = false;
let pendingVideoToPlay = null;
let activeAudio = null; // for Spotify previews & Web Audio HTML5 source
let progressInterval = null;

// ============================================================================
// AETHER AUDIO ENGINE (Web Audio API Core Pipeline & DSP Graph)
// ============================================================================
const AetherAudioEngine = {
  ctx: null,
  masterGain: null,
  limiter: null,

  // Global Master EQ (3-band)
  masterEq: {
    low: null,
    mid: null,
    high: null
  },

  // Per-Track EQ (3-band)
  trackEq: {
    low: null,
    mid: null,
    high: null
  },

  audioElement: null,
  sourceNode: null,
  initialized: false,

  init() {
    if (this.initialized) {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return;
    }

    try {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtxClass) {
        console.warn('[AudioEngine] Web Audio API not supported on this platform');
        return;
      }

      this.ctx = new AudioCtxClass();

      // Master Gain Node
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(1.0, this.ctx.currentTime);

      // Limiter / Brickwall Compressor to prevent digital clipping when boosting EQ
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.setValueAtTime(-1.0, this.ctx.currentTime);
      this.limiter.knee.setValueAtTime(3.0, this.ctx.currentTime);
      this.limiter.ratio.setValueAtTime(20.0, this.ctx.currentTime);
      this.limiter.attack.setValueAtTime(0.002, this.ctx.currentTime);
      this.limiter.release.setValueAtTime(0.1, this.ctx.currentTime);

      // Global Master Equalizer (LowShelf, Peaking Mids/Vocals, HighShelf)
      this.masterEq.low = this.ctx.createBiquadFilter();
      this.masterEq.low.type = 'lowshelf';
      this.masterEq.low.frequency.setValueAtTime(100, this.ctx.currentTime);
      this.masterEq.low.gain.setValueAtTime(0, this.ctx.currentTime);

      this.masterEq.mid = this.ctx.createBiquadFilter();
      this.masterEq.mid.type = 'peaking';
      this.masterEq.mid.frequency.setValueAtTime(1500, this.ctx.currentTime);
      this.masterEq.mid.Q.setValueAtTime(1.0, this.ctx.currentTime);
      this.masterEq.mid.gain.setValueAtTime(0, this.ctx.currentTime);

      this.masterEq.high = this.ctx.createBiquadFilter();
      this.masterEq.high.type = 'highshelf';
      this.masterEq.high.frequency.setValueAtTime(8000, this.ctx.currentTime);
      this.masterEq.high.gain.setValueAtTime(0, this.ctx.currentTime);

      // Per-Track Equalizer
      this.trackEq.low = this.ctx.createBiquadFilter();
      this.trackEq.low.type = 'lowshelf';
      this.trackEq.low.frequency.setValueAtTime(120, this.ctx.currentTime);
      this.trackEq.low.gain.setValueAtTime(0, this.ctx.currentTime);

      this.trackEq.mid = this.ctx.createBiquadFilter();
      this.trackEq.mid.type = 'peaking';
      this.trackEq.mid.frequency.setValueAtTime(2000, this.ctx.currentTime);
      this.trackEq.mid.Q.setValueAtTime(1.2, this.ctx.currentTime);
      this.trackEq.mid.gain.setValueAtTime(0, this.ctx.currentTime);

      this.trackEq.high = this.ctx.createBiquadFilter();
      this.trackEq.high.type = 'highshelf';
      this.trackEq.high.frequency.setValueAtTime(7500, this.ctx.currentTime);
      this.trackEq.high.gain.setValueAtTime(0, this.ctx.currentTime);

      // Create primary playback HTMLAudioElement with anonymous CORS
      this.audioElement = new Audio();
      this.audioElement.crossOrigin = 'anonymous';
      this.audioElement.preload = 'auto';

      // Connect graph:
      // AudioElement -> Track EQ (Low -> Mid -> High) -> Master EQ (Low -> Mid -> High) -> Master Gain -> Limiter -> Destination
      this.sourceNode = this.ctx.createMediaElementSource(this.audioElement);
      this.sourceNode.connect(this.trackEq.low);
      this.trackEq.low.connect(this.trackEq.mid);
      this.trackEq.mid.connect(this.trackEq.high);
      this.trackEq.high.connect(this.masterEq.low);
      this.masterEq.low.connect(this.masterEq.mid);
      this.masterEq.mid.connect(this.masterEq.high);
      this.masterEq.high.connect(this.masterGain);
      this.masterGain.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);

      // Expose to activeAudio so existing event handlers operate seamlessly
      activeAudio = this.audioElement;

      this.initialized = true;
      console.log('[AudioEngine] Web Audio Core Graph initialized successfully');
    } catch (err) {
      console.warn('[AudioEngine] Web Audio initialization warning:', err);
    }
  },

  setMasterVolume(ratio) {
    if (this.masterGain && this.ctx) {
      const effective = ratio <= 0.001 ? 0 : Math.pow(ratio, 2.2);
      this.masterGain.gain.setTargetAtTime(effective, this.ctx.currentTime, 0.03);
    }
    if (this.audioElement) {
      try { this.audioElement.volume = Math.max(0, Math.min(1, ratio)); } catch (e) {}
    }
  },

  setMasterEq(lowDb, midDb, highDb) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (this.masterEq.low && lowDb !== undefined) this.masterEq.low.gain.setTargetAtTime(lowDb, now, 0.05);
    if (this.masterEq.mid && midDb !== undefined) this.masterEq.mid.gain.setTargetAtTime(midDb, now, 0.05);
    if (this.masterEq.high && highDb !== undefined) this.masterEq.high.gain.setTargetAtTime(highDb, now, 0.05);
  },

  setTrackEq(lowDb, midDb, highDb) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (this.trackEq.low && lowDb !== undefined) this.trackEq.low.gain.setTargetAtTime(lowDb, now, 0.05);
    if (this.trackEq.mid && midDb !== undefined) this.trackEq.mid.gain.setTargetAtTime(midDb, now, 0.05);
    if (this.trackEq.high && highDb !== undefined) this.trackEq.high.gain.setTargetAtTime(highDb, now, 0.05);
  },

  resetTrackEq() {
    this.setTrackEq(0, 0, 0);
  },

  stopPlayback() {
    if (this.audioElement) {
      try {
        this.audioElement.pause();
        this.audioElement.currentTime = 0;
      } catch (e) {}
    }
  }
};

// Global one-time unlock for AudioContext on first user interaction
document.addEventListener('pointerdown', () => {
  if (window.AetherAudioEngine) {
    AetherAudioEngine.init();
  }
}, { once: true });

// Default Fallback Visuals (Lightweight SVG Data URIs)
const DEFAULT_ALBUM_ART = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 200 200'><rect width='200' height='200' fill='%2313141f'/><circle cx='100' cy='100' r='52' fill='%231c1d2e'/><circle cx='100' cy='100' r='20' fill='%2313141f'/><path d='M95 72v34a12 12 0 1 1-6-10.4V72h22v26a12 12 0 1 1-6-10.4V68H95z' fill='%237c3aed'/></svg>";
const DEFAULT_AVATAR = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100' viewBox='0 0 100 100'><rect width='100' height='100' fill='%231a1b26'/><circle cx='50' cy='36' r='18' fill='%237c3aed'/><ellipse cx='50' cy='82' rx='28' ry='18' fill='%237c3aed'/></svg>";

// Client-side image compression for cross-device sync & offline persistence
function compressImageFile(file, maxWidth = 300, maxHeight = 300, quality = 0.8) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      return reject(new Error('Selected file is not an image'));
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > height) {
          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }
        } else {
          if (height > maxHeight) {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        let dataUrl = canvas.toDataURL('image/webp', quality);
        if (!dataUrl || !dataUrl.startsWith('data:image/webp')) {
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        resolve(dataUrl);
      };
      img.onerror = () => reject(new Error('Image decode error'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('File read error'));
    reader.readAsDataURL(file);
  });
}

// Preset Themes Definitions
const PRESET_THEMES = {
  midnight: {
    name: 'Midnight Glow',
    accent: '#7c3aed',
    text: '#ffffff',
    neon: 'rgba(167, 139, 250, 0.4)',
    glowIntensity: 12,
    borderRadius: 16,
    glassBlur: 16,
    brightness: 100,
    contrast: 100,
    glassBg: 'rgba(15, 15, 25, 0.65)',
    bgType: 'gradient',
    bgValue: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #311042 100%)',
    sidebarLayout: 'sidebar-left',
    playerLayout: 'player-bottom'
  },
  cyberpunk: {
    name: 'Cyberpunk Neon',
    accent: '#ff007f',
    text: '#00f0ff',
    neon: 'rgba(0, 240, 255, 0.8)',
    glowIntensity: 20,
    borderRadius: 0,
    glassBlur: 8,
    brightness: 110,
    contrast: 120,
    glassBg: 'rgba(10, 10, 15, 0.9)',
    bgType: 'solid',
    bgValue: '#050508',
    sidebarLayout: 'sidebar-left',
    playerLayout: 'player-bottom'
  },
  ocean: {
    name: 'Ocean Glass',
    accent: '#0d9488',
    text: '#f0fdfa',
    neon: 'rgba(45, 212, 191, 0.5)',
    glowIntensity: 15,
    borderRadius: 24,
    glassBlur: 24,
    brightness: 95,
    contrast: 100,
    glassBg: 'rgba(8, 20, 28, 0.55)',
    bgType: 'gradient',
    bgValue: 'linear-gradient(135deg, #022c22 0%, #064e3b 40%, #083344 100%)',
    sidebarLayout: 'sidebar-left',
    playerLayout: 'player-bottom'
  },
  minimalist: {
    name: 'Minimal Dark',
    accent: '#f8fafc',
    text: '#f8fafc',
    neon: 'rgba(255, 255, 255, 0.05)',
    glowIntensity: 0,
    borderRadius: 8,
    glassBlur: 10,
    brightness: 100,
    contrast: 100,
    glassBg: 'rgba(20, 20, 20, 0.8)',
    bgType: 'solid',
    bgValue: '#121212',
    sidebarLayout: 'sidebar-left',
    playerLayout: 'player-bottom'
  }
};

// Gradient list for custom backgrounds
const GRADIENTS = [
  'linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #311042 100%)',
  'linear-gradient(135deg, #0f0f13 0%, #1c1917 50%, #0c0a09 100%)',
  'linear-gradient(135deg, #1e3a8a 0%, #0f172a 100%)',
  'linear-gradient(135deg, #581c87 0%, #0f172a 100%)',
  'linear-gradient(135deg, #881337 0%, #0f172a 100%)',
  'linear-gradient(135deg, #022c22 0%, #0f172a 100%)'
];

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  loadData();
  setupUI();
  setupEventListeners();
  applyCurrentTheme();
  applyLyricsCustomizations();
  renderPlaylists();
  loadServerSettings();
  loadServerPlaylists();
  initOfflineEngine();
  switchTab('home');

  // Create first playlist if none exist
  setTimeout(() => {
    if (state.playlists.length === 0) {
      createPlaylist('My First Playlist');
    }
  }, 1000); // Wait a second for server sync to complete before falling back to default playlist

  // Trigger YouTube Player initialization if the API has already loaded asynchronously
  if (window.YT && window.YT.Player) {
    if (typeof window.onYouTubeIframeAPIReady === 'function') {
      window.onYouTubeIframeAPIReady();
    }
  }
});

// Setup YouTube Player Iframe API
window.onYouTubeIframeAPIReady = function () {
  try {
    ytPlayer = new YT.Player('ytPlayerContainer', {
      height: '1',
      width: '1',
      videoId: '',
      playerVars: {
        'playsinline': 1,
        'controls': 0,
        'disablekb': 1
      },
      events: {
        'onReady': () => {
          ytPlayerReady = true;
          console.log('[YouTube Player] Ready for instant playback');
          if (pendingVideoToPlay) {
            const vid = pendingVideoToPlay;
            pendingVideoToPlay = null;
            playYouTubeTrack(vid);
          }
        },
        'onStateChange': onPlayerStateChange,
        'onError': onPlayerError
      }
    });
  } catch (e) {
    console.warn("YouTube iframe init error:", e);
  }
};

// --- DATA PERSISTENCE & LOAD ---
function loadData() {
  state.playlistStyle = localStorage.getItem('playlist_sidebar_style') || 'image-name';
  state.lyricsFontSize = parseInt(localStorage.getItem('lyrics_font_size')) || 18;
  state.lyricsFontFamily = localStorage.getItem('lyrics_font_family') || 'Outfit';
  state.lyricsCustomFont = localStorage.getItem('lyrics_custom_font') || '';

  // Load Playlists
  const savedPlaylists = localStorage.getItem('playlists');
  if (savedPlaylists) {
    try {
      state.playlists = JSON.parse(savedPlaylists);
    } catch (e) {
      console.error('Failed to parse playlists from localstorage');
    }
  }

  // Load Custom Themes
  const savedThemes = localStorage.getItem('custom_themes');
  if (savedThemes) {
    try {
      state.customThemes = JSON.parse(savedThemes);
    } catch (e) {
      console.error('Failed to parse custom themes');
    }
  }

  // Load Profile Settings
  const savedProfile = localStorage.getItem('profile');
  if (savedProfile) {
    try {
      state.profile = JSON.parse(savedProfile);
    } catch (e) {
      console.error('Failed to parse profile data');
    }
  }

  // Load current theme
  const savedTheme = localStorage.getItem('current_theme_settings');
  if (savedTheme) {
    try {
      state.currentTheme = JSON.parse(savedTheme);
    } catch (e) {
      state.currentTheme = { ...PRESET_THEMES.midnight };
    }
  } else {
    state.currentTheme = { ...PRESET_THEMES.midnight };
  }

  // Restore previous playback queue and timestamp from local session
  restorePlaybackSession();
}

// --- PERSISTENT PLAYBACK QUEUE & SESSION RECOVERY ---
let lastSessionSaveTime = 0;
function throttledSavePlaybackSession() {
  const now = Date.now();
  if (now - lastSessionSaveTime > 3500) {
    lastSessionSaveTime = now;
    savePlaybackSession();
  }
}

function savePlaybackSession() {
  if (!state.playQueue || state.playQueue.length === 0) return;
  const session = {
    playQueue: state.playQueue,
    currentQueueIndex: state.currentQueueIndex,
    currentSong: state.currentSong,
    playbackPosition: state.playbackPosition || 0,
    duration: state.duration || 0,
    currentPlaylistId: state.currentPlaylistId || null,
    shuffle: !!state.shuffle,
    repeat: state.repeat || 'none',
    savedAt: Date.now()
  };

  try {
    localStorage.setItem('aether_playback_session', JSON.stringify(session));
  } catch (e) {
    console.warn("Failed to save playback session to localStorage:", e);
  }

  // Also persist to backend cache asynchronously without blocking
  try {
    fetch('/api/queue-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(session)
    }).catch(() => {});
  } catch (e) {}
}

async function restorePlaybackSession() {
  let session = null;
  // 1. Try localStorage for instantaneous synchronous restoration
  try {
    const raw = localStorage.getItem('aether_playback_session');
    if (raw) session = JSON.parse(raw);
  } catch (e) {
    console.warn("Error reading localStorage playback session:", e);
  }

  // 2. Fallback to server session if localStorage was cleared
  if (!session || !session.playQueue || session.playQueue.length === 0) {
    try {
      const res = await fetch('/api/queue-session');
      if (res.ok) {
        const remote = await res.json();
        if (remote && Array.isArray(remote.playQueue) && remote.playQueue.length > 0) {
          session = remote;
        }
      }
    } catch (e) {}
  }

  if (!session || !Array.isArray(session.playQueue) || session.playQueue.length === 0) {
    return;
  }

  state.playQueue = session.playQueue;
  state.currentQueueIndex = (typeof session.currentQueueIndex === 'number' && session.currentQueueIndex >= 0 && session.currentQueueIndex < session.playQueue.length)
    ? session.currentQueueIndex
    : 0;
  state.currentSong = session.currentSong || state.playQueue[state.currentQueueIndex] || null;
  // Reset restored track's playback position to 0:00 to eliminate stale stream seek errors
  state.playbackPosition = 0;
  state.duration = session.duration || 180;
  state.currentPlaylistId = session.currentPlaylistId || null;
  state.shuffle = !!session.shuffle;
  state.repeat = session.repeat || 'none';

  if (state.currentSong) {
    // Refresh audio stream URL / clear stale stream tokens so fresh tokens are acquired on resume
    delete state.currentSong._preResolvedYtId;
    if (state.currentSong.platform === 'spotify' || state.currentSong.platform === 'soundcloud') {
      delete state.currentSong.previewUrl;
    }

    // Restore UI without playing sound (ready in paused state)
    state.isPlaying = false;
    state.isUserPaused = true;
    updatePlayButtonUI(false);
    updateRepeatUI();
    
    // Update player title & artist
    const titleEl = document.getElementById('playerSongTitle');
    const artistEl = document.getElementById('playerSongArtist');
    const badgeEl = document.getElementById('playerPlatformBadge');
    const artEl = document.getElementById('playerAlbumArt');
    if (titleEl) titleEl.textContent = state.currentSong.title;
    if (artistEl) artistEl.textContent = state.currentSong.artist || 'Unknown';
    if (badgeEl) {
      badgeEl.textContent = state.currentSong.platform || 'music';
      badgeEl.style.display = 'inline-block';
    }
    if (artEl) {
      artEl.innerHTML = state.currentSong.thumbnail 
        ? `<img src="${state.currentSong.thumbnail}" alt="Art">`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
    }
    
    // Set restored time & seekbar cleanly at 0:00
    const currTime = document.getElementById('playerCurrentTime');
    const totalDur = document.getElementById('playerTotalDuration');
    const timeline = document.getElementById('playerTimeline');
    if (currTime) currTime.textContent = '0:00';
    if (totalDur) totalDur.textContent = state.currentSong.duration || formatSeconds(state.duration);
    if (timeline) {
      timeline.value = 0;
    }

    // Sync Mobile player
    const mobTitle = document.getElementById('mobileNpTitle');
    const mobArtist = document.getElementById('mobileNpArtist');
    const mobTime = document.getElementById('mobileNpCurrentTime');
    const mobDur = document.getElementById('mobileNpTotalDuration');
    const mobTimeline = document.getElementById('mobileNpTimeline');
    const mobImg = document.getElementById('mobileNpCoverImg');
    if (mobTitle) mobTitle.textContent = state.currentSong.title;
    if (mobArtist) mobArtist.textContent = state.currentSong.artist || 'Unknown';
    if (mobTime) mobTime.textContent = '0:00';
    if (mobDur) mobDur.textContent = state.currentSong.duration || formatSeconds(state.duration);
    if (mobTimeline) {
      mobTimeline.value = 0;
    }
    if (mobImg && state.currentSong.thumbnail) {
      mobImg.src = state.currentSong.thumbnail;
      mobImg.style.display = 'block';
    }

    if (typeof renderQueueUI === 'function') {
      renderQueueUI();
    }
    if (typeof updateRightSidebar === 'function') {
      updateRightSidebar(state.currentSong);
    }
  }
}

window.addEventListener('beforeunload', () => {
  savePlaybackSession();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    savePlaybackSession();
  }
});

function savePlaylists() {
  localStorage.setItem('playlists', JSON.stringify(state.playlists));
  renderPlaylists();
  if (typeof CloudSync !== 'undefined' && CloudSync._isApplyingRemote) {
    return;
  }
  debouncedSyncBackup();
  if (typeof CloudSync !== 'undefined' && CloudSync.mode === 'cloud') {
    CloudSync.debouncedPush();
  }
}

function updateUserProfileUI() {
  const avatarEl = document.getElementById('profileAvatar');
  const headerAvatarEl = document.getElementById('headerAvatar');
  const usernameInput = document.getElementById('profileUsernameInput');
  const headerUsernameEl = document.getElementById('headerUsername');
  
  const avatarSrc = (state.profile && state.profile.avatar) ? state.profile.avatar : DEFAULT_AVATAR;
  if (avatarEl) {
    avatarEl.src = avatarSrc;
    avatarEl.referrerPolicy = 'no-referrer';
    avatarEl.onerror = () => { avatarEl.src = DEFAULT_AVATAR; };
  }
  if (headerAvatarEl) {
    headerAvatarEl.src = avatarSrc;
    headerAvatarEl.referrerPolicy = 'no-referrer';
    headerAvatarEl.onerror = () => { headerAvatarEl.src = DEFAULT_AVATAR; };
  }
  if (usernameInput) usernameInput.value = state.profile.username || 'Music Enthusiast';
  if (headerUsernameEl) headerUsernameEl.textContent = state.profile.username || 'Music Enthusiast';
}

function saveProfile() {
  localStorage.setItem('profile', JSON.stringify(state.profile));
  updateUserProfileUI();
  if (typeof CloudSync !== 'undefined' && CloudSync._isApplyingRemote) {
    return;
  }
  syncSettingsToServer({ username: state.profile.username, avatar: state.profile.avatar });
  if (typeof CloudSync !== 'undefined' && CloudSync.mode === 'cloud') {
    CloudSync.debouncedPush();
  }
}

// Debounce timer for server backup
let syncTimeout = null;
function debouncedSyncBackup() {
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(async () => {
    try {
      const response = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state.playlists)
      });
      if (response.ok) {
        document.getElementById('backupStatusText').textContent = 'Daily backup successfully synchronized: ' + new Date().toLocaleTimeString();
      } else {
        console.error('Backup failed on server');
      }
    } catch (e) {
      console.error('Failed to backup playlists to backend:', e);
    }
  }, 300); // 300ms delay for instant local persistence
}

async function loadServerPlaylists() {
  try {
    const response = await fetch('/api/backup');
    if (response.ok) {
      const playlists = await response.json();
      if (playlists && Array.isArray(playlists) && playlists.length > 0) {
        state.playlists = playlists;
        localStorage.setItem('playlists', JSON.stringify(state.playlists));
        renderPlaylists();
        console.log('Playlists loaded from server backup file.');
      }
    }
  } catch (e) {
    console.error('Failed to load playlists from server:', e);
  }
}

async function syncSettingsToServer(payload) {
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('Failed to sync settings to server:', e);
  }
}

let themeSyncTimeout = null;
function debouncedSyncTheme() {
  if (themeSyncTimeout) clearTimeout(themeSyncTimeout);
  if (typeof CloudSync !== 'undefined' && CloudSync._isApplyingRemote) {
    return;
  }
  themeSyncTimeout = setTimeout(() => {
    if (typeof CloudSync !== 'undefined' && CloudSync._isApplyingRemote) return;
    syncSettingsToServer({ currentTheme: state.currentTheme });
    if (typeof CloudSync !== 'undefined' && CloudSync.mode === 'cloud') {
      CloudSync.debouncedPush();
    }
  }, 1000); // 1 second debounce
}

async function loadServerSettings() {
  try {
    const response = await fetch('/api/settings');
    if (response.ok) {
      const config = await response.json();

      // 1. Spotify Config
      state.spotifyConfigured = (config.spotifyClientId && config.spotifyClientSecret);
      state._rawSpotifySecret = config.spotifyClientSecret || '';
      document.getElementById('spotifyClientId').value = config.spotifyClientId || '';
      document.getElementById('spotifyClientSecret').value = config.spotifyClientSecret ? '••••••••••••••••' : '';

      // 2. Profile Info
      if (config.username) {
        state.profile.username = config.username;
        profileUpdated = true;
      }
      if (config.avatar) {
        state.profile.avatar = config.avatar;
        profileUpdated = true;
      }
      if (profileUpdated) {
        localStorage.setItem('profile', JSON.stringify(state.profile));
        updateUserProfileUI();
      }

      // 3. Custom Themes List
      if (config.customThemes && Array.isArray(config.customThemes)) {
        state.customThemes = config.customThemes;
        localStorage.setItem('custom_themes', JSON.stringify(state.customThemes));
        renderCustomThemesList();
      }

      // 4. Active Theme Configuration
      if (config.currentTheme) {
        state.currentTheme = config.currentTheme;
        localStorage.setItem('current_theme_settings', JSON.stringify(state.currentTheme));
        applyCurrentTheme();
        setupUI(); // refresh visual controls to match settings
      }
    }
  } catch (e) {
    console.error('Failed to load server settings:', e);
  }
}

// --- CORE UI GENERATOR & SETUP ---
function setupUI() {
  // Populate username & avatar
  updateUserProfileUI();

  // Build Preset Themes
  const presetsGrid = document.getElementById('presetsGrid');
  presetsGrid.innerHTML = '';
  Object.keys(PRESET_THEMES).forEach(key => {
    const theme = PRESET_THEMES[key];
    const btn = document.createElement('button');
    btn.className = 'btn btn-outline';
    btn.textContent = theme.name;
    btn.addEventListener('click', () => applyThemePreset(key));
    presetsGrid.appendChild(btn);
  });

  // Build Gradients
  const gradientsGrid = document.getElementById('gradientsGrid');
  gradientsGrid.innerHTML = '';
  GRADIENTS.forEach((grad, index) => {
    const swatch = document.createElement('div');
    swatch.className = 'gradient-swatch';
    swatch.style.background = grad;
    if (state.currentTheme.bgType === 'gradient' && state.currentTheme.bgValue === grad) {
      swatch.classList.add('active');
    }
    swatch.addEventListener('click', () => {
      document.querySelectorAll('.gradient-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      updateThemeProperty('bgType', 'gradient');
      updateThemeProperty('bgValue', grad);
    });
    gradientsGrid.appendChild(swatch);
  });

  // Customizer control syncs
  const theme = state.currentTheme;
  document.getElementById('slideBorderRadius').value = theme.borderRadius;
  document.getElementById('slideGlassBlur').value = theme.glassBlur;
  document.getElementById('slideGlowIntensity').value = theme.glowIntensity;
  document.getElementById('slideBrightness').value = theme.brightness;
  document.getElementById('slideContrast').value = theme.contrast;
  document.getElementById('pickerAccent').value = theme.accent;
  document.getElementById('pickerText').value = theme.text;
  document.getElementById('pickerNeon').value = theme.neon;
  document.getElementById('pickerGlassBg').value = rgbToHex(theme.glassBg) || '#ffffff';

  // Sync playlist layout selector
  document.querySelectorAll('#playlistStyleSelector button').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-playliststyle') === state.playlistStyle);
  });

  // Synchronize dynamic slider value text
  updateSliderTextValues();

  // Populate Custom Themes List
  renderCustomThemesList();
}

function updateSliderTextValues() {
  const theme = state.currentTheme;
  document.getElementById('valBorderRadius').textContent = `${theme.borderRadius}px`;
  document.getElementById('valGlassBlur').textContent = `${theme.glassBlur}px`;
  document.getElementById('valGlowIntensity').textContent = `${theme.glowIntensity}px`;
  document.getElementById('valBrightness').textContent = `${theme.brightness}%`;
  document.getElementById('valContrast').textContent = `${theme.contrast}%`;
}

// Helper to convert rgb string to hex
function rgbToHex(rgbStr) {
  if (!rgbStr || !rgbStr.startsWith('rgba')) return null;
  const match = rgbStr.match(/\d+/g);
  if (!match) return null;
  const r = parseInt(match[0]);
  const g = parseInt(match[1]);
  const b = parseInt(match[2]);
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

// Settings Sub-Tabs Management
function switchProfileSubtab(subtabId) {
  const nav = document.getElementById('settingsSubtabsNav');
  if (!nav) return;
  const buttons = nav.querySelectorAll('.settings-subtab-pill');
  const panes = document.querySelectorAll('.settings-subtab-content');

  buttons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.subtab === subtabId);
  });

  panes.forEach(pane => {
    const isTarget = pane.id === `settingsPane-${subtabId}`;
    pane.classList.toggle('active', isTarget);
    pane.style.display = isTarget ? 'block' : 'none';
  });

  try {
    localStorage.setItem('aether_settings_subtab', subtabId);
  } catch (e) {}
}

function setupProfileSubtabs() {
  const nav = document.getElementById('settingsSubtabsNav');
  if (!nav) return;

  nav.querySelectorAll('.settings-subtab-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const subtab = btn.dataset.subtab;
      if (subtab) switchProfileSubtab(subtab);
    });
  });

  const btnExportPlaylistsProfile = document.getElementById('btnExportPlaylistsProfile');
  if (btnExportPlaylistsProfile) {
    btnExportPlaylistsProfile.addEventListener('click', () => {
      const btnExport = document.getElementById('btnExportPlaylists');
      if (btnExport) btnExport.click();
    });
  }

  const savedSubtab = localStorage.getItem('aether_settings_subtab') || 'profile';
  switchProfileSubtab(savedSubtab);
}

// --- EVENT LISTENERS SYSTEM ---
function setupEventListeners() {
  // Navigation Tabs Switching
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.getAttribute('data-tab');
      switchTab(tabName);
    });
  });

  // Dedicated Go Back Button
  const btnGoBack = document.getElementById('btnGoBack');
  if (btnGoBack) {
    btnGoBack.addEventListener('click', () => {
      handleGoBack();
    });
  }

  // Platform filters selection
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const platform = chip.getAttribute('data-platform');
      if (chip.classList.contains('active')) {
        // Must leave at least one active
        const activeCount = document.querySelectorAll('.filter-chip.active').length;
        if (activeCount > 1) {
          chip.classList.remove('active');
          state.searchPlatforms = state.searchPlatforms.filter(p => p !== platform);
          applySearchFilters();
        } else {
          showToast('Select at least one search platform!');
        }
      } else {
        chip.classList.add('active');
        state.searchPlatforms.push(platform);
        applySearchFilters();
      }
    });
  });

  // Search trigger
  document.getElementById('btnSearch').addEventListener('click', performSearch);
  document.getElementById('searchInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') performSearch();
  });

  // Customizer slider changes
  document.getElementById('slideBorderRadius').addEventListener('input', (e) => {
    updateThemeProperty('borderRadius', parseInt(e.target.value));
  });
  document.getElementById('slideGlassBlur').addEventListener('input', (e) => {
    updateThemeProperty('glassBlur', parseInt(e.target.value));
  });
  document.getElementById('slideGlowIntensity').addEventListener('input', (e) => {
    updateThemeProperty('glowIntensity', parseInt(e.target.value));
  });
  document.getElementById('slideBrightness').addEventListener('input', (e) => {
    updateThemeProperty('brightness', parseInt(e.target.value));
  });
  document.getElementById('slideContrast').addEventListener('input', (e) => {
    updateThemeProperty('contrast', parseInt(e.target.value));
  });

  // Color Picker Changes
  document.getElementById('pickerAccent').addEventListener('input', (e) => {
    updateThemeProperty('accent', e.target.value);
  });
  document.getElementById('pickerText').addEventListener('input', (e) => {
    updateThemeProperty('text', e.target.value);
  });
  document.getElementById('pickerNeon').addEventListener('input', (e) => {
    updateThemeProperty('neon', e.target.value);
  });
  document.getElementById('pickerGlassBg').addEventListener('input', (e) => {
    // Glassbg color hex is converted to transparent rgba
    const hex = e.target.value;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const rgba = `rgba(${r}, ${g}, ${b}, 0.65)`;
    updateThemeProperty('glassBg', rgba);
  });

  // Background style select (Gradient vs Solid vs Image)
  document.querySelectorAll('[data-bgtype]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const type = e.target.getAttribute('data-bgtype');
      document.querySelectorAll('[data-bgtype]').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');

      document.getElementById('bgGradientPicker').style.display = type === 'gradient' ? 'flex' : 'none';
      document.getElementById('bgSolidPicker').style.display = type === 'solid' ? 'flex' : 'none';
      document.getElementById('bgImagePicker').style.display = type === 'image' ? 'flex' : 'none';

      if (type === 'solid') {
        const val = document.getElementById('pickerBgSolid').value;
        updateThemeProperty('bgType', 'solid');
        updateThemeProperty('bgValue', val);
      } else if (type === 'gradient') {
        updateThemeProperty('bgType', 'gradient');
        // fallback to first preset gradient
        updateThemeProperty('bgValue', GRADIENTS[0]);
      } else if (type === 'image') {
        updateThemeProperty('bgType', 'image');
      }
    });
  });

  document.getElementById('pickerBgSolid').addEventListener('input', (e) => {
    document.getElementById('valBgSolid').textContent = e.target.value.toUpperCase();
    updateThemeProperty('bgValue', e.target.value);
  });

  // Apply Background Image from URL
  document.getElementById('btnApplyBgUrl').addEventListener('click', () => {
    const url = document.getElementById('bgUrlInput').value.trim();
    if (url) {
      updateThemeProperty('bgType', 'image');
      updateThemeProperty('bgValue', `url('${url}')`);
      showToast('Custom background URL applied!');
    }
  });

  // Background Image Upload Trigger
  document.getElementById('bgUploadArea').addEventListener('click', () => {
    document.getElementById('bgFileInput').click();
  });

  document.getElementById('bgFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function (evt) {
      const base64Data = evt.target.result;
      try {
        const response = await fetch('/api/upload-bg', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64Data, filename: file.name })
        });
        if (response.ok) {
          const result = await response.json();
          updateThemeProperty('bgType', 'image');
          updateThemeProperty('bgValue', `url('${result.fileUrl}')`);
          showToast('Background image uploaded successfully!');
        }
      } catch (err) {
        console.error('Failed to upload background:', err);
        showToast('Image upload failed');
      }
    };
    reader.readAsDataURL(file);
  });

  // Profile Avatar Upload
  document.getElementById('avatarUploadTrigger').addEventListener('click', () => {
    document.getElementById('avatarFileInput').click();
  });

  document.getElementById('avatarFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      showToast('Compressing avatar...');
      const dataUrl = await compressImageFile(file, 220, 220, 0.8);
      state.profile.avatar = dataUrl;
      const avatarEl = document.getElementById('profileAvatar');
      const headerAvatar = document.getElementById('headerAvatar');
      if (avatarEl) avatarEl.src = dataUrl;
      if (headerAvatar) headerAvatar.src = dataUrl;
      saveProfile();
      showToast('Avatar updated & synced!');
    } catch (err) {
      console.error('Failed to compress avatar:', err);
      showToast('Avatar compression failed');
    }
  });

  // Playlist Cover Image Change (URL or file upload)
  document.getElementById('detailPlaylistImg').addEventListener('click', async () => {
    const res = await showPromptModal('Change Cover Image', 'Enter cover image URL, or leave blank to upload a file:');
    if (res === null) return;

    if (res.trim() !== '') {
      const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
      if (pl) {
        pl.cover = res.trim();
        savePlaylists();
        openPlaylistDetails(state.currentPlaylistId);
        showToast('Playlist cover image updated!');
      }
    } else {
      document.getElementById('playlistCoverFileInput').click();
    }
  });

  document.getElementById('playlistCoverFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      showToast('Compressing cover...');
      const dataUrl = await compressImageFile(file, 320, 320, 0.82);
      const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
      if (pl) {
        pl.cover = dataUrl;
        savePlaylists();
        openPlaylistDetails(state.currentPlaylistId);
        showToast('Playlist cover updated & synced!');
      }
    } catch (err) {
      console.error('Failed to compress cover:', err);
      showToast('Cover compression failed');
    }
  });

  // Playlist sidebar display style selector
  document.querySelectorAll('#playlistStyleSelector button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const style = e.target.getAttribute('data-playliststyle');
      document.querySelectorAll('#playlistStyleSelector button').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');

      state.playlistStyle = style;
      localStorage.setItem('playlist_sidebar_style', style);
      renderPlaylists();
      showToast(`Sidebar style updated to ${style === 'image-name' ? 'Image + Name' : (style === 'image-only' ? 'Just Image' : 'Just Name')}!`);
    });
  });

  // Live Lyrics Font Size slider
  document.getElementById('slideLyricsSize').addEventListener('input', (e) => {
    state.lyricsFontSize = parseInt(e.target.value);
    localStorage.setItem('lyrics_font_size', state.lyricsFontSize);
    applyLyricsCustomizations();
  });

  // Live Lyrics Font Family selection
  document.getElementById('selectLyricsFont').addEventListener('change', (e) => {
    state.lyricsFontFamily = e.target.value;
    localStorage.setItem('lyrics_font_family', state.lyricsFontFamily);
    applyLyricsCustomizations();
  });

  // Custom Font Name input change
  document.getElementById('inputCustomLyricsFont').addEventListener('input', (e) => {
    state.lyricsCustomFont = e.target.value.trim();
    localStorage.setItem('lyrics_custom_font', state.lyricsCustomFont);
    applyLyricsCustomizations();
  });

  // Username edit
  document.getElementById('btnSaveUsername').addEventListener('click', () => {
    const name = document.getElementById('profileUsernameInput').value.trim();
    if (name) {
      state.profile.username = name;
      saveProfile();
      showToast('Profile name updated!');
    }
  });

  // Layout Configuration
  document.querySelectorAll('[data-layout]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const config = e.target.getAttribute('data-layout');
      const container = document.getElementById('appContainer');

      if (config.startsWith('sidebar-')) {
        btn.parentElement.querySelectorAll('[data-layout^="sidebar-"]').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        updateThemeProperty('sidebarLayout', config);
      } else if (config.startsWith('player-')) {
        btn.parentElement.querySelectorAll('[data-layout^="player-"]').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        updateThemeProperty('playerLayout', config);
      }
    });
  });

  // Create Playlist Action
  document.getElementById('btnCreatePlaylist').addEventListener('click', async () => {
    const name = await showPromptModal('Create Playlist', 'Enter new playlist name:');
    if (name) {
      createPlaylist(name);
    }
  });

  // Import Playlist from URL Action
  document.getElementById('btnImportPlaylistUrl').addEventListener('click', async () => {
    let link = await showPromptModal('Import Playlist or Mix', 'Paste a YouTube Mix, Playlist, or Track link:');
    if (!link) return;

    link = link.trim();
    if (!link.startsWith('http://') && !link.startsWith('https://')) {
      link = 'https://' + link;
    }

    // Check if the link is an infinite YouTube Mix or Radio
    const isMixUrl = /list=RD|start_radio=1|radio=1|list=UL/i.test(link);
    let limit = 100;

    // Only prompt for song limit if importing an infinite YouTube Mix
    if (isMixUrl) {
      const limitInput = await showPromptModal(
        'Import Song Limit',
        'How many songs would you like to import from this YouTube Mix? (Default: 100):',
        '100'
      );
      if (limitInput === null) return; // User cancelled

      const parsedLimit = parseInt(limitInput, 10);
      if (!isNaN(parsedLimit) && parsedLimit > 0) {
        limit = Math.min(parsedLimit, 300);
      }
    }

    showToast(isMixUrl ? `Importing YouTube Mix (up to ${limit} songs)...` : 'Analyzing playlist link...');

    try {
      const response = await fetch(`/api/resolve-link?url=${encodeURIComponent(link)}&limit=${limit}&allow_mix=1`);
      if (response.ok) {
        const data = await response.json();
        if (data.error) {
          showToast(data.error);
          return;
        }

        if (data.type === 'playlist') {
          if (data.songs && data.songs.length > 0) {
            importPlaylistFromData(data.name, data.songs);
          } else {
            showToast('This playlist contains no playable songs.');
          }
        } else if (data.type === 'track') {
          const wantMix = await showConfirmModal(
            'Single Track Detected',
            `"${data.song.title}" is a single track. Would you like to generate and import a YouTube Mix based on it?`
          );
          if (wantMix) {
            const mixLimitInput = await showPromptModal(
              'Import Song Limit',
              'How many songs would you like to generate in this Mix? (Default: 100):',
              '100'
            );
            if (mixLimitInput === null) return;
            let mixLimit = parseInt(mixLimitInput, 10);
            if (isNaN(mixLimit) || mixLimit <= 0) mixLimit = 100;
            mixLimit = Math.min(mixLimit, 300);

            showToast(`Generating mix from "${data.song.title}"...`);
            const mixResp = await fetch(`/api/resolve-link?url=${encodeURIComponent(link)}&limit=${mixLimit}&allow_mix=1`);
            if (mixResp.ok) {
              const mixData = await mixResp.json();
              if (mixData.type === 'playlist' && mixData.songs && mixData.songs.length > 0) {
                importPlaylistFromData(mixData.name, mixData.songs);
                return;
              }
            }
          }
          // Otherwise import single track into new playlist
          importPlaylistFromData(data.song.title, [data.song]);
        } else {
          showToast('Failed to resolve media from this link.');
        }
      } else {
        showToast('Failed to resolve playlist link.');
      }
    } catch (e) {
      console.error(e);
      showToast('An error occurred while importing.');
    }
  });

  // Import Playlist from search results banner
  document.getElementById('btnImportSearchPlaylist').addEventListener('click', () => {
    if (state.tempSearchPlaylist) {
      importPlaylistFromData(state.tempSearchPlaylist.name, state.tempSearchPlaylist.songs);
      document.getElementById('searchPlaylistBanner').style.display = 'none';
      state.tempSearchPlaylist = null;
    }
  });

  // Save Custom Theme action
  document.getElementById('btnSaveCustomTheme').addEventListener('click', () => {
    const input = document.getElementById('customThemeNameInput');
    const name = input.value.trim();
    if (!name) {
      showToast('Please enter a theme name');
      return;
    }
    const newTheme = {
      ...state.currentTheme,
      name: name
    };
    state.customThemes.push(newTheme);
    localStorage.setItem('custom_themes', JSON.stringify(state.customThemes));
    syncSettingsToServer({ customThemes: state.customThemes });
    input.value = '';
    renderCustomThemesList();
    showToast(`Custom theme "${name}" saved!`);
  });

  // Playlist Header Edit Name
  document.getElementById('detailPlaylistName').addEventListener('blur', (e) => {
    const newName = e.target.textContent.trim();
    if (newName && state.currentPlaylistId) {
      const idx = state.playlists.findIndex(p => p.id === state.currentPlaylistId);
      if (idx !== -1) {
        state.playlists[idx].name = newName;
        savePlaylists();
        showToast('Playlist renamed');
      }
    }
  });

  // Delete playlist
  document.getElementById('btnDeletePlaylist').addEventListener('click', async () => {
    if (state.currentPlaylistId) {
      const confirmDelete = await showConfirmModal('Delete Playlist', 'Are you sure you want to delete this playlist?');
      if (confirmDelete) {
        state.playlists = state.playlists.filter(p => p.id !== state.currentPlaylistId);
        savePlaylists();
        showToast('Playlist deleted');
        switchTab('search');
      }
    }
  });

  // Heart button like song / add to playlist
  document.getElementById('btnAddToFavorites').addEventListener('click', () => {
    if (state.currentSong) {
      openPlaylistSelectModal(state.currentSong);
    } else {
      showToast('No song currently playing');
    }
  });

  // Play Playlist songs
  document.getElementById('btnPlayPlaylist').addEventListener('click', () => {
    if (state.currentPlaylistId === 'system_downloaded') {
      if (state.offlineTracks && state.offlineTracks.length > 0) {
        playSongList(state.offlineTracks, 0);
      } else {
        showToast('No downloaded songs yet');
      }
      return;
    }
    const plist = state.playlists.find(p => p.id === state.currentPlaylistId);
    if (plist && plist.songs.length > 0) {
      playSongList(plist.songs, 0);
    } else {
      showToast('Playlist is empty');
    }
  });

  // Export/Import Playlist files
  document.getElementById('btnExportPlaylists').addEventListener('click', async () => {
    try {
      showToast('Exporting playlists...');
      const response = await fetch('/api/export-playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state.playlists)
      });
      const resData = await response.json();
      if (resData.success && resData.savedToDownloads) {
        showToast(`Saved to Downloads: ${resData.filename}`);
      } else {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state.playlists, null, 2));
        const downloadAnchor = document.createElement('a');
        downloadAnchor.setAttribute("href", dataStr);
        downloadAnchor.setAttribute("download", resData.filename || `playlists_backup_${new Date().toISOString().slice(0, 10)}.json`);
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
        showToast('Playlists exported to JSON');
      }
    } catch (err) {
      console.error('Export error:', err);
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state.playlists, null, 2));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute("href", dataStr);
      downloadAnchor.setAttribute("download", `playlists_backup_${new Date().toISOString().slice(0, 10)}.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      showToast('Playlists exported to JSON');
    }
  });

  document.getElementById('btnImportPlaylists').addEventListener('click', () => {
    document.getElementById('importFileInput').click();
  });

  document.getElementById('importFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function (evt) {
      try {
        const imported = JSON.parse(evt.target.result);
        if (Array.isArray(imported)) {
          // Merge or overwrite
          const merge = await showConfirmModal('Import Playlists', 'Do you want to MERGE with existing playlists? Select "Cancel" to OVERWRITE.');
          if (merge) {
            state.playlists = [...state.playlists, ...imported];
          } else {
            state.playlists = imported;
          }
          savePlaylists();
          showToast('Playlists imported successfully!');
        } else {
          showToast('Invalid playlists backup file format');
        }
      } catch (err) {
        showToast('Failed to parse file');
      }
    };
    reader.readAsText(file);
  });

  // Profile manual Sync/Restore Backup
  document.getElementById('btnForceBackup').addEventListener('click', async () => {
    try {
      const response = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state.playlists)
      });
      if (response.ok) {
        showToast('Backup successfully synced!');
      } else {
        showToast('Backup failed');
      }
    } catch (e) {
      showToast('Backup sync error');
    }
  });

  document.getElementById('btnRestoreBackup').addEventListener('click', async () => {
    try {
      const response = await fetch('/api/backup');
      if (response.ok) {
        const playlists = await response.json();
        state.playlists = playlists;
        savePlaylists();
        showToast('Backup playlists restored successfully!');
      } else {
        showToast('No backup file found on server');
      }
    } catch (e) {
      showToast('Backup restoration failed');
    }
  });

  // Spotify setting credentials save
  document.getElementById('btnSaveSpotifySettings').addEventListener('click', async () => {
    const clientId = document.getElementById('spotifyClientId').value.trim();
    const inputSecret = document.getElementById('spotifyClientSecret').value.trim();
    const effectiveSecret = (inputSecret.includes('•') && state._rawSpotifySecret)
      ? state._rawSpotifySecret
      : inputSecret;

    if (!inputSecret.includes('•')) {
      state._rawSpotifySecret = inputSecret;
    }

    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spotifyClientId: clientId, spotifyClientSecret: effectiveSecret })
      });
      if (response.ok) {
        state.spotifyConfigured = Boolean(clientId && effectiveSecret);
        if (effectiveSecret) {
          document.getElementById('spotifyClientSecret').value = '••••••••••••••••';
        }
        showToast('Spotify settings saved!');
        if (typeof CloudSync !== 'undefined' && CloudSync.mode === 'cloud') {
          CloudSync.debouncedPush();
        }
      } else {
        showToast('Failed to save Spotify settings');
      }
    } catch (e) {
      console.error('Error saving Spotify settings:', e);
      showToast('Failed to save Spotify settings');
    }
  });

  // Player Playback controls triggers
  document.getElementById('btnPlayPause').addEventListener('click', togglePlayPause);
  document.getElementById('btnNext').addEventListener('click', playNext);
  document.getElementById('btnPrev').addEventListener('click', playPrev);

  document.getElementById('btnShuffle').addEventListener('click', (e) => {
    state.shuffle = !state.shuffle;
    e.currentTarget.classList.toggle('active', state.shuffle);
    showToast(state.shuffle ? 'Shuffle enabled' : 'Shuffle disabled');
  });

  document.getElementById('btnRepeat').addEventListener('click', () => {
    if (state.repeat === 'none') {
      state.repeat = 'all';
      showToast('Repeat all');
    } else if (state.repeat === 'all') {
      state.repeat = 'one';
      showToast('Repeat one');
    } else {
      state.repeat = 'none';
      showToast('Repeat disabled');
    }
    updateRepeatUI();
  });

  // Artist Platform chips click handler
  document.querySelectorAll('[data-artist-platform]').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetPlatform = chip.getAttribute('data-artist-platform');
      if (state.tempArtist && state.tempArtist.name) {
        openArtistProfile(state.tempArtist.name, targetPlatform, null);
      }
    });
  });

  // Volume slider control & bubble feedback
  const volSlider = document.getElementById('playerVolume');
  const volWrapper = document.getElementById('volumeSliderWrapper');
  const volContainer = document.getElementById('playerVolumeContainer');

  if (volSlider) {
    volSlider.value = state.volume;
    updateVolumeBubble(state.volume);
    setTimeout(() => updateVolumeBubble(state.volume), 100);
    window.addEventListener('resize', () => updateVolumeBubble(state.volume));

    volSlider.addEventListener('input', (e) => {
      const vol = parseInt(e.target.value, 10);
      state.volume = vol;
      updateVolumeBubble(vol);
      applyVolume();
    });

    volSlider.addEventListener('mousedown', () => volWrapper?.classList.add('is-sliding'));
    volSlider.addEventListener('touchstart', () => volWrapper?.classList.add('is-sliding'), { passive: true });
    window.addEventListener('mouseup', () => volWrapper?.classList.remove('is-sliding'));
    window.addEventListener('touchend', () => volWrapper?.classList.remove('is-sliding'));
  }

  // Right-click custom volume dialog
  if (volContainer) {
    volContainer.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const input = await showPromptModal(
        'Set Volume',
        'Enter exact volume level (0 - 100):',
        (state.volume || 70).toString()
      );
      if (input !== null && input !== '') {
        const val = parseInt(input.trim(), 10);
        if (!isNaN(val)) {
          const clamped = Math.max(0, Math.min(100, val));
          state.volume = clamped;
          if (volSlider) volSlider.value = clamped;
          updateVolumeBubble(clamped);
          applyVolume();
          showToast(`Volume set to ${clamped}%`);
        } else {
          showToast('Please enter a valid number between 0 and 100');
        }
      }
    });
  }

  document.getElementById('btnMute').addEventListener('click', () => {
    state.isMuted = !state.isMuted;
    document.getElementById('volumeOnIcon').style.display = state.isMuted ? 'none' : 'block';
    document.getElementById('volumeOffIcon').style.display = state.isMuted ? 'block' : 'none';
    applyVolume();
  });

  // Timeline seek controls (with debounce & desync prevention)
  const timelineEl = document.getElementById('playerTimeline');
  if (timelineEl) {
    timelineEl.addEventListener('mousedown', () => { isUserSeeking = true; });
    timelineEl.addEventListener('touchstart', () => { isUserSeeking = true; }, { passive: true });
    timelineEl.addEventListener('input', (e) => {
      isUserSeeking = true;
      const pct = parseFloat(e.target.value) / 100;
      const seekSecs = pct * state.duration;
      const currTime = document.getElementById('playerCurrentTime');
      if (currTime) currTime.textContent = formatSeconds(seekSecs);
      updateLyricsHighlight(seekSecs);
      seekToPercentage(pct);
    });

    timelineEl.addEventListener('change', (e) => {
      const pct = parseFloat(e.target.value) / 100;
      seekToPercentage(pct);
    });
  }

  // Modal Playlist Select Closes
  document.getElementById('btnCloseModal').addEventListener('click', () => {
    document.getElementById('playlistModal').classList.remove('active');
  });

  // Mobile Mini Player click -> Open Full Now Playing Sheet
  const playerBar = document.getElementById('appPlayerBar');
  if (playerBar) {
    playerBar.addEventListener('click', (e) => {
      // Don't open sheet if user clicked on a control button
      if (e.target.closest('.control-btn') || e.target.closest('.play-btn') || e.target.closest('button') || e.target.closest('input')) {
        return;
      }
      if (window.innerWidth <= 768) {
        openMobileNowPlaying();
      }
    });
  }

  // Mobile Now Playing Sheet close button
  const btnCloseNp = document.getElementById('btnCloseMobileNowPlaying');
  if (btnCloseNp) {
    btnCloseNp.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMobileNowPlaying();
    });
  }

  // Mobile Now Playing Controls
  document.getElementById('btnMobileNpPlayPause')?.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlayPause();
  });
  document.getElementById('btnMobileNpNext')?.addEventListener('click', (e) => {
    e.stopPropagation();
    playNext();
  });
  document.getElementById('btnMobileNpPrev')?.addEventListener('click', (e) => {
    e.stopPropagation();
    playPrev();
  });
  document.getElementById('btnMobileNpShuffle')?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.shuffle = !state.shuffle;
    document.getElementById('btnShuffle')?.classList.toggle('active', state.shuffle);
    document.getElementById('btnMobileNpShuffle')?.classList.toggle('active', state.shuffle);
    showToast(state.shuffle ? 'Shuffle enabled' : 'Shuffle disabled');
  });
  document.getElementById('btnMobileNpRepeat')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('btnRepeat')?.click();
  });
  document.getElementById('btnMobileNpFavorite')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.currentSong) openPlaylistSelectModal(state.currentSong);
  });
  document.getElementById('mobileNpLyricsCard')?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.lyricsMode = 1;
    const drawer = document.getElementById('lyricsDrawer');
    if (drawer) drawer.classList.add('active');
    if (state.currentSong) ensureLyricsLoaded(state.currentSong);
    closeMobileNowPlaying();
  });
  document.getElementById('btnExpandLyricsModal')?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.lyricsMode = 1;
    const drawer = document.getElementById('lyricsDrawer');
    if (drawer) drawer.classList.add('active');
    if (state.currentSong) ensureLyricsLoaded(state.currentSong);
    closeMobileNowPlaying();
  });
  document.getElementById('btnMobileNpFollowArtist')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('btnFollowArtist')?.click();
  });
  document.getElementById('mobileNpCoverWrapper')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.currentSong) {
      goToAlbumOfSong(state.currentSong);
      closeMobileNowPlaying();
    }
  });
  document.getElementById('mobileNpArtist')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.currentSong && state.currentSong.artist) {
      openArtistProfile(state.currentSong.artist, state.currentSong.platform || 'youtube');
      closeMobileNowPlaying();
    }
  });

  // Mobile timeline scrubber
  document.getElementById('mobileNpTimeline')?.addEventListener('input', (e) => {
    e.stopPropagation();
    const pct = parseFloat(e.target.value) / 100;
    const seekSecs = pct * state.duration;
    document.getElementById('mobileNpCurrentTime').textContent = formatSeconds(seekSecs);
    document.getElementById('playerCurrentTime').textContent = formatSeconds(seekSecs);
    updateLyricsHighlight(seekSecs);
  });
  document.getElementById('mobileNpTimeline')?.addEventListener('change', (e) => {
    e.stopPropagation();
    const pct = parseFloat(e.target.value) / 100;
    seekToPercentage(pct);
  });

  // Lyrics drawer toggle controls (Three-state toggle: Off -> Drawer -> Live Widget -> Off)
  document.getElementById('btnToggleLyrics').addEventListener('click', () => {
    state.lyricsMode = (state.lyricsMode + 1) % 3;

    const drawer = document.getElementById('lyricsDrawer');
    const widget = document.getElementById('liveLyricsWidget');
    const btn = document.getElementById('btnToggleLyrics');

    drawer.classList.remove('active');
    widget.style.display = 'none';
    btn.classList.remove('active');
    btn.style.color = '';

    if (state.lyricsMode === 1) {
      drawer.classList.add('active');
      btn.classList.add('active');
      state.lyricsOpen = true;
      if (state.currentSong) ensureLyricsLoaded(state.currentSong);
    } else if (state.lyricsMode === 2) {
      widget.style.display = 'flex';
      btn.classList.add('active');
      btn.style.color = 'var(--accent-color)';
      state.lyricsOpen = true;
      if (state.currentSong) {
        ensureLyricsLoaded(state.currentSong);
      } else {
        updateLyricsHighlight(0); // Show song info placeholder
      }
    } else {
      state.lyricsOpen = false;
    }
  });

  document.getElementById('btnCloseLyrics').addEventListener('click', () => {
    state.lyricsMode = 0;
    state.lyricsOpen = false;
    document.getElementById('lyricsDrawer').classList.remove('active');
    document.getElementById('liveLyricsWidget').style.display = 'none';
    document.getElementById('btnToggleLyrics').classList.remove('active');
    document.getElementById('btnToggleLyrics').style.color = '';
  });

  // Search results subtabs clicks (Tracks, Albums, Artists)
  document.querySelectorAll('.search-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.search-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const searchTab = btn.getAttribute('data-search-tab');
      state.activeSearchTab = searchTab;
      
      // Update grid visibility
      document.getElementById('searchResultsGrid').style.display = searchTab === 'tracks' ? 'grid' : 'none';
      document.getElementById('searchAlbumsGrid').style.display = searchTab === 'albums' ? 'grid' : 'none';
      document.getElementById('searchArtistsGrid').style.display = searchTab === 'artists' ? 'grid' : 'none';
    });
  });

  // Artist platform selector chips clicks
  document.querySelectorAll('[data-artist-platform]').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('[data-artist-platform]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      const selectedPlatform = chip.getAttribute('data-artist-platform');
      if (state.tempArtist) {
        state.tempArtist.platform = selectedPlatform;
        fetchArtistProfileDetails(state.tempArtist.name, selectedPlatform, state.tempArtist.id);
      }
    });
  });

  // Click current playing artist in player bar
  document.getElementById('playerSongArtist').addEventListener('click', () => {
    if (state.currentSong) {
      openArtistProfile(state.currentSong.artist, state.currentSong.platform, state.currentSong.artistId || state.currentSong.artist_id);
    }
  });

  // Click current playing song title in player bar to go to the album
  document.getElementById('playerSongTitle').addEventListener('click', () => {
    if (state.currentSong) {
      goToAlbumOfSong(state.currentSong);
    }
  });

  // Click AetherPlayer brand logo to go back to Home
  const brandLogo = document.getElementById('brandLogoBtn');
  if (brandLogo) {
    brandLogo.addEventListener('click', () => {
      switchTab('home');
    });
  }

  // Click player album art to go to the album
  const playerArt = document.getElementById('playerAlbumArt');
  if (playerArt) {
    playerArt.addEventListener('click', () => {
      if (state.currentSong) {
        goToAlbumOfSong(state.currentSong);
      }
    });
  }

  // Click right panel album art to go to the album
  const rightArt = document.getElementById('rightAlbumArtImg');
  if (rightArt) {
    rightArt.addEventListener('click', () => {
      if (state.currentSong) {
        goToAlbumOfSong(state.currentSong);
      }
    });
  }

  // Toggle Queue & Track Details in Right Sidebar
  const toggleQueueBtn = document.getElementById('btnToggleQueue');
  const toggleRightSidebarBtn = document.getElementById('btnToggleRightSidebar');
  const mobileQueueBtn = document.getElementById('btnMobileNpQueue');
  const closeRightSidebarBtn = document.getElementById('btnCloseRightSidebar');

  // Initial active state setup
  const isCollapsed = localStorage.getItem('rightSidebarCollapsed') === 'true';
  const container = document.getElementById('appContainer');
  if (isCollapsed) {
    container.classList.add('right-sidebar-collapsed');
    if (toggleRightSidebarBtn) toggleRightSidebarBtn.classList.remove('active');
    if (toggleQueueBtn) toggleQueueBtn.classList.remove('active');
  } else {
    container.classList.remove('right-sidebar-collapsed');
    if (toggleQueueBtn) toggleQueueBtn.classList.add('active');
  }

  if (toggleQueueBtn) {
    toggleQueueBtn.addEventListener('click', toggleQueuePanel);
  }
  if (toggleRightSidebarBtn) {
    toggleRightSidebarBtn.addEventListener('click', toggleDetailsPanel);
  }
  if (mobileQueueBtn) {
    mobileQueueBtn.addEventListener('click', toggleQueuePanel);
  }
  if (closeRightSidebarBtn) {
    closeRightSidebarBtn.style.display = 'block';
    closeRightSidebarBtn.addEventListener('click', closeRightSidebarPanel);
  }

  // Sidebar Tab buttons
  document.querySelectorAll('.queue-nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.dataset.tab;
      if (tabName) switchRightSidebarTab(tabName);
    });
  });

  // Autoplay toggle button
  const autoplayBtn = document.getElementById('btnToggleAutoplay');
  if (autoplayBtn) {
    autoplayBtn.addEventListener('click', () => {
      state.autoplayEnabled = !state.autoplayEnabled;
      autoplayBtn.classList.toggle('active', state.autoplayEnabled);
      autoplayBtn.innerHTML = `<span class="autoplay-dot"></span> Autoplay: ${state.autoplayEnabled ? 'ON' : 'OFF'}`;
      showToast(`Autoplay ${state.autoplayEnabled ? 'Enabled' : 'Disabled'}`);
      renderQueueUI();
    });
  }

  // Clear upcoming queue
  const clearQueueBtn = document.getElementById('btnClearQueue');
  if (clearQueueBtn) {
    clearQueueBtn.addEventListener('click', () => {
      if (state.playQueue && state.playQueue.length > state.currentQueueIndex + 1) {
        state.playQueue = state.playQueue.slice(0, state.currentQueueIndex + 1);
        renderQueueUI();
        showToast('Upcoming queue cleared');
      } else {
        showToast('Queue is already empty');
      }
    });
  }

  // Refresh listening history
  const refreshHistoryBtn = document.getElementById('btnRefreshHistory');
  if (refreshHistoryBtn) {
    refreshHistoryBtn.addEventListener('click', () => {
      renderRecentUI(true);
    });
  }

  // --- CLOUD SYNC & ACCOUNTS EVENT LISTENERS ---
  const headerCloudBtn = document.getElementById('btnHeaderCloud');
  if (headerCloudBtn) {
    headerCloudBtn.addEventListener('click', () => {
      switchTab('profile');
      switchProfileSubtab('cloud');
      const cloudCard = document.getElementById('cloudSyncCard');
      if (cloudCard) {
        cloudCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        cloudCard.style.outline = '2px solid var(--accent-color)';
        setTimeout(() => { cloudCard.style.outline = 'none'; }, 1500);
      }
    });
  }

  const btnCreateCloud = document.getElementById('btnCreateCloudAccount');
  if (btnCreateCloud) {
    btnCreateCloud.addEventListener('click', async () => {
      try {
        btnCreateCloud.disabled = true;
        btnCreateCloud.innerHTML = `<span>⏳ Generating & Encrypting...</span>`;
        await CloudSync.createAccount();
      } catch (e) {
        console.error(e);
      } finally {
        btnCreateCloud.disabled = false;
        btnCreateCloud.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
          </svg>
          <span>✨ Generate 1-Click Sync Passkey</span>`;
      }
    });
  }

  const btnConnectCloud = document.getElementById('btnConnectCloudAccount');
  const inputConnectKey = document.getElementById('inputConnectKey');
  if (btnConnectCloud && inputConnectKey) {
    const handleConnect = async () => {
      const key = inputConnectKey.value.trim();
      if (!key) {
        showToast('Please enter your Sync Key first');
        inputConnectKey.focus();
        return;
      }
      try {
        btnConnectCloud.disabled = true;
        btnConnectCloud.innerHTML = `<span>Connecting...</span>`;
        await CloudSync.connectAccount(key);
        inputConnectKey.value = '';
      } catch (e) {
        console.error(e);
      } finally {
        btnConnectCloud.disabled = false;
        btnConnectCloud.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>
          </svg>
          Connect & Sync`;
      }
    };

    btnConnectCloud.addEventListener('click', handleConnect);
    inputConnectKey.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleConnect();
    });
  }

  const btnCopyCloudKey = document.getElementById('btnCopyCloudKey');
  if (btnCopyCloudKey) {
    btnCopyCloudKey.addEventListener('click', () => {
      const fullKey = (CloudSync && CloudSync.syncKey) || localStorage.getItem('aether_cloud_sync_key');
      if (fullKey) {
        navigator.clipboard.writeText(fullKey).then(() => {
          const txt = document.getElementById('btnCopyCloudKeyText');
          if (txt) txt.textContent = 'Copied!';
          showToast('Passkey copied to clipboard!');
          setTimeout(() => {
            if (txt) txt.textContent = 'Copy';
          }, 2000);
        }).catch(() => {
          showToast('Could not copy automatically. Passkey: ' + fullKey);
        });
      }
    });
  }

  const btnManualSync = document.getElementById('btnManualCloudSync');
  if (btnManualSync) {
    btnManualSync.addEventListener('click', async () => {
      showToast('Syncing with cloud...');
      await CloudSync.pushToCloud();
      showToast('Synced successfully!');
    });
  }

  const btnDisconnectCloud = document.getElementById('btnDisconnectCloud');
  if (btnDisconnectCloud) {
    btnDisconnectCloud.addEventListener('click', async () => {
      const confirmed = await showConfirmModal(
        'Disconnect Cloud Sync',
        'Disconnect from Cloud Sync? Your local playlists and settings will remain safely on this device.',
        {
          confirmText: 'Disconnect',
          cancelText: 'Cancel',
          isDanger: true
        }
      );
      if (confirmed) {
        CloudSync.disconnect();
      }
    });
  }

  // Profile Settings Sub-Tabs
  setupProfileSubtabs();
}

// --- DYNAMIC THEME SYSTEM IMPLEMENTATION ---
function applyCurrentTheme() {
  const theme = state.currentTheme;
  const root = document.documentElement;

  // Colors
  root.style.setProperty('--accent-color', theme.accent);
  root.style.setProperty('--accent-rgb', hexToRgbValues(theme.accent));
  root.style.setProperty('--text-color', theme.text);
  root.style.setProperty('--neon-glow-color', theme.neon);
  root.style.setProperty('--glass-bg', theme.glassBg);

  // Sliders/Ranges
  root.style.setProperty('--border-radius', `${theme.borderRadius}px`);
  root.style.setProperty('--glass-blur', `${theme.glassBlur}px`);
  root.style.setProperty('--neon-glow-intensity', `${theme.glowIntensity}px`);
  root.style.setProperty('--brightness', `${theme.brightness}%`);
  root.style.setProperty('--contrast', `${theme.contrast}%`);

  // Layout Styles
  const container = document.getElementById('appContainer');
  const wasCollapsed = container.classList.contains('right-sidebar-collapsed') || localStorage.getItem('rightSidebarCollapsed') === 'true';
  // clear previous layouts
  container.className = 'app-container';
  container.classList.add(theme.sidebarLayout || 'sidebar-left');
  container.classList.add(theme.playerLayout || 'player-bottom');
  if (wasCollapsed) {
    container.classList.add('right-sidebar-collapsed');
  }

  // Background
  const wrapper = document.getElementById('appBgWrapper');
  wrapper.style.background = '';
  wrapper.style.backgroundImage = '';
  root.style.setProperty('--app-bg', theme.bgValue);

  // Update customize settings sidebar options if on screen
  updateSliderTextValues();
  localStorage.setItem('current_theme_settings', JSON.stringify(theme));
  debouncedSyncTheme();
}

function loadGoogleFont(fontName) {
  if (!fontName) return;
  const linkId = `gfont-${fontName.replace(/\s+/g, '-').toLowerCase()}`;
  if (document.getElementById(linkId)) return; // already loaded

  const link = document.createElement('link');
  link.id = linkId;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;600;700&display=swap`;
  document.head.appendChild(link);
}

function applyLyricsCustomizations() {
  const root = document.documentElement;
  root.style.setProperty('--lyrics-font-size', `${state.lyricsFontSize}px`);

  let fontFamily = state.lyricsFontFamily;
  if (fontFamily === 'custom' && state.lyricsCustomFont) {
    fontFamily = state.lyricsCustomFont;
    loadGoogleFont(state.lyricsCustomFont);
  }

  root.style.setProperty('--lyrics-font-family', `'${fontFamily}', sans-serif`);

  // Update Customizer elements if they exist in DOM
  const slide = document.getElementById('slideLyricsSize');
  const display = document.getElementById('valLyricsSize');
  const select = document.getElementById('selectLyricsFont');
  const input = document.getElementById('inputCustomLyricsFont');

  if (slide) slide.value = state.lyricsFontSize;
  if (display) display.textContent = `${state.lyricsFontSize}px`;
  if (select) select.value = state.lyricsFontFamily;
  if (input) {
    input.value = state.lyricsCustomFont;
    input.style.display = state.lyricsFontFamily === 'custom' ? 'block' : 'none';
  }
}


function updateThemeProperty(key, val) {
  state.currentTheme[key] = val;
  applyCurrentTheme();
}

function applyThemePreset(presetKey) {
  const preset = PRESET_THEMES[presetKey];
  if (preset) {
    state.currentTheme = { ...preset };
    applyCurrentTheme();
    setupUI();
    showToast(`Preset "${preset.name}" applied!`);
  }
}

function applyCustomTheme(index) {
  const theme = state.customThemes[index];
  if (theme) {
    state.currentTheme = { ...theme };
    applyCurrentTheme();
    setupUI();
    showToast(`Theme "${theme.name}" loaded!`);
  }
}

function deleteCustomTheme(index, e) {
  e.stopPropagation();
  const theme = state.customThemes[index];
  if (theme) {
    state.customThemes.splice(index, 1);
    localStorage.setItem('custom_themes', JSON.stringify(state.customThemes));
    syncSettingsToServer({ customThemes: state.customThemes });
    renderCustomThemesList();
    showToast('Theme deleted');
  }
}

function renderCustomThemesList() {
  const list = document.getElementById('customThemesList');
  list.innerHTML = '';
  state.customThemes.forEach((theme, index) => {
    const li = document.createElement('li');
    li.className = 'custom-theme-item';

    const span = document.createElement('span');
    span.textContent = theme.name;
    span.addEventListener('click', () => applyCustomTheme(index));

    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', (e) => deleteCustomTheme(index, e));

    li.appendChild(span);
    li.appendChild(delBtn);
    list.appendChild(li);
  });
}

// Helpers
function hexToRgbValues(hex) {
  if (hex.startsWith('#')) hex = hex.slice(1);
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

// --- NAVIGATION MANAGER ---
let navHistory = [];

function updateBackButtonVisibility() {
  const backNav = document.getElementById('mainBackNav');
  if (!backNav) return;
  if (navHistory.length > 0 || (state.activeTab && state.activeTab !== 'home')) {
    backNav.style.display = 'flex';
  } else {
    backNav.style.display = 'none';
  }
}

function handleGoBack() {
  if (navHistory.length > 0) {
    const prev = navHistory.pop();
    if (prev.tab === 'playlist-detail' && prev.playlistId) {
      openPlaylistDetails(prev.playlistId, { isBack: true });
    } else {
      switchTab(prev.tab, { isBack: true });
    }
  } else {
    switchTab('home', { isBack: true });
  }
  updateBackButtonVisibility();
}

function switchTab(tabName, options = {}) {
  const previousTab = state.activeTab;
  if (!options.isBack && previousTab && previousTab !== tabName) {
    navHistory.push({
      tab: previousTab,
      playlistId: state.currentPlaylistId
    });
    if (navHistory.length > 30) navHistory.shift();
  }

  state.activeTab = tabName;
  updateBackButtonVisibility();

  // Update sidebar active highlights
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
  });

  // Toggle tab contents
  document.querySelectorAll('.tab-content').forEach(tc => {
    tc.classList.remove('active');
  });

  if (['home', 'search', 'customizer', 'profile', 'playlists', 'album-detail', 'artist-profile'].includes(tabName)) {
    document.getElementById(`tab-${tabName}`).classList.add('active');
    if (tabName === 'home') {
      loadHomeDashboard();
    }
    if (tabName === 'profile') {
      const activeSubtab = localStorage.getItem('aether_settings_subtab') || 'profile';
      switchProfileSubtab(activeSubtab);
    }
    if (tabName !== 'album-detail' && tabName !== 'artist-profile' && tabName !== 'home') {
      // de-highlight lists active states
      document.querySelectorAll('#playlistsList li').forEach(li => li.classList.remove('active'));
      state.currentPlaylistId = null;
    }
  } else {
    // Rendering details view for a custom playlist
    document.getElementById('tab-playlist-detail').classList.add('active');
  }
}

// --- MUSIC SEARCH FUNCTIONALITY ---
async function performSearch() {
  const query = document.getElementById('searchInput').value.trim();
  if (!query) {
    showToast('Enter a search term');
    return;
  }

  switchTab('search');

  const loader = document.getElementById('searchLoader');
  const emptyState = document.getElementById('searchEmptyState');
  const grid = document.getElementById('searchResultsGrid');
  const albumsGrid = document.getElementById('searchAlbumsGrid');
  const artistsGrid = document.getElementById('searchArtistsGrid');
  const banner = document.getElementById('searchPlaylistBanner');
  const resultsTabs = document.getElementById('searchResultsTabs');

  loader.style.display = 'flex';
  emptyState.style.display = 'none';
  grid.style.display = 'none';
  albumsGrid.style.display = 'none';
  artistsGrid.style.display = 'none';
  banner.style.display = 'none';
  resultsTabs.style.display = 'none';
  state.tempSearchPlaylist = null;

  let isUrl = query.startsWith('http://') || query.startsWith('https://') ||
    query.includes('youtube.com') || query.includes('youtu.be') ||
    query.includes('spotify.com') || query.includes('soundcloud.com');

  let finalQuery = query;
  if (isUrl && !query.startsWith('http://') && !query.startsWith('https://')) {
    finalQuery = 'https://' + query;
  }

  try {
    if (isUrl) {
      const response = await fetch(`/api/resolve-link?url=${encodeURIComponent(finalQuery)}&limit=100`);
      if (response.ok) {
        const data = await response.json();
        loader.style.display = 'none';

        if (data.error) {
          showToast(data.error);
          emptyState.style.display = 'flex';
          emptyState.querySelector('h3').textContent = 'Resolve failed';
          emptyState.querySelector('p').textContent = data.error;
          return;
        }

        if (data.type === 'track') {
          renderSearchResults([data.song]);
        } else if (data.type === 'playlist') {
          if (!data.songs || data.songs.length === 0) {
            emptyState.style.display = 'flex';
            emptyState.querySelector('h3').textContent = 'Empty playlist';
            emptyState.querySelector('p').textContent = 'No playable songs were found in this playlist.';
            return;
          }

          document.getElementById('searchPlaylistBannerTitle').textContent = `Found Playlist: "${data.name}"`;
          document.getElementById('searchPlaylistBannerSubtitle').textContent = `Contains ${data.songs.length} tracks. Click the button to import it.`;
          banner.style.display = 'flex';
          state.tempSearchPlaylist = data;

          renderSearchResults(data.songs);
        } else {
          throw new Error('Unknown resolved data type');
        }
      } else {
        throw new Error('Link resolution failed');
      }
    } else {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&platform=${state.searchPlatforms.join(',')}&type=all`);
      if (response.ok) {
        const results = await response.json();
        loader.style.display = 'none';

        if (results.tracks.length === 0 && results.albums.length === 0 && results.artists.length === 0) {
          emptyState.style.display = 'flex';
          emptyState.querySelector('h3').textContent = 'No results found';
          emptyState.querySelector('p').textContent = 'Try adjusting your platform filters or checking your query details.';
        } else {
          // Render all sub-sections
          renderSearchResults(results.tracks);
          renderAlbumsSearchResults(results.albums);
          renderArtistsSearchResults(results.artists);
          
          resultsTabs.style.display = 'flex';
          const activeTab = state.activeSearchTab || 'tracks';
          document.querySelectorAll('.search-tab-btn').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-search-tab') === activeTab);
          });
          
          document.getElementById('searchResultsGrid').style.display = activeTab === 'tracks' ? 'grid' : 'none';
          document.getElementById('searchAlbumsGrid').style.display = activeTab === 'albums' ? 'grid' : 'none';
          document.getElementById('searchArtistsGrid').style.display = activeTab === 'artists' ? 'grid' : 'none';
        }
      } else {
        throw new Error('Search API returned error');
      }
    }
  } catch (err) {
    console.error(err);
    loader.style.display = 'none';
    emptyState.style.display = 'flex';
    emptyState.querySelector('h3').textContent = 'Resolution failed';
    emptyState.querySelector('p').textContent = 'There was an issue connecting to the link resolution server.';
  }
}

function createSongCard(song, queueContext) {
  const card = document.createElement('div');
  card.className = 'song-card';
  card.dataset.platform = song.platform;
  const handleCardPlayback = () => {
    state.currentPlaylistId = null; // Clear playlist context when playing from search
    if (queueContext && queueContext.length > 1) {
      state.playQueue = queueContext.map(s => ({ ...s }));
      state.stationAnchor = song;
      state.isRadioSession = false;
      const index = queueContext.findIndex(s => s.id === song.id);
      playSong(song, index !== -1 ? index : 0);
    } else {
      // Single track search discovery - start endless vibe radio station anchored to this song!
      state.stationAnchor = song;
      state.isRadioSession = true;
      state.playQueue = [{ ...song }];
      state.currentQueueIndex = 0;
      playSong(song, 0);
      fetchStationVibesForSong(song, { isInitial: true });
    }
  };

  card.addEventListener('click', handleCardPlayback);

  const imgWrapper = document.createElement('div');
  imgWrapper.className = 'song-card-img-wrapper';

  const img = document.createElement('img');
  img.src = song.thumbnail || DEFAULT_ALBUM_ART;
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.alt = '';
  img.onerror = function() {
    this.onerror = null;
    this.src = DEFAULT_ALBUM_ART;
  };
  imgWrapper.appendChild(img);

  const info = document.createElement('div');
  info.className = 'song-card-info';

  const title = document.createElement('div');
  title.className = 'song-card-title';
  title.textContent = song.title;
  title.title = song.title;

  const artist = document.createElement('div');
  artist.className = 'song-card-artist clickable-artist';
  artist.textContent = song.artist || 'Unknown Artist';
  artist.addEventListener('click', (e) => {
    e.stopPropagation();
    openArtistProfile(song.artist, song.platform, song.artistId || song.artist_id);
  });

  info.appendChild(title);
  info.appendChild(artist);

  const actions = document.createElement('div');
  actions.className = 'song-card-actions';

  const badge = document.createElement('span');
  badge.className = `song-card-badge badge-${song.platform}`;
  badge.textContent = song.platform;

  const playActionBtn = document.createElement('button');
  playActionBtn.className = 'song-card-play-action-btn';
  playActionBtn.title = 'Play Track';
  playActionBtn.innerHTML = `<svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
  playActionBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleCardPlayback();
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'song-card-add-btn';
  addBtn.title = 'Add to Playlist';
  addBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPlaylistSelectModal(song);
  });

  actions.appendChild(badge);
  actions.appendChild(playActionBtn);
  actions.appendChild(addBtn);

  card.appendChild(imgWrapper);
  card.appendChild(info);
  card.appendChild(actions);

  return card;
}

function renderSearchResults(songs) {
  const grid = document.getElementById('searchResultsGrid');
  grid.innerHTML = '';
  grid.style.display = 'grid';

  songs.forEach(song => {
    const card = createSongCard(song, [song]);
    grid.appendChild(card);
  });

  applySearchFilters();
}

function applySearchFilters() {
  const cards = document.querySelectorAll('#searchResultsGrid .song-card');
  cards.forEach(card => {
    const platform = card.dataset.platform;
    if (state.searchPlatforms.includes(platform)) {
      card.style.display = '';
    } else {
      card.style.display = 'none';
    }
  });
}

// --- CUSTOM MODALS ENGINE ---
function showPromptModal(title, message, defaultValue = '') {
  return new Promise((resolve) => {
    const modal = document.getElementById('promptModal');
    const titleEl = document.getElementById('promptModalTitle');
    const msgEl = document.getElementById('promptModalMessage');
    const inputEl = document.getElementById('promptModalInput');
    const btnCancel = document.getElementById('btnPromptCancel');
    const btnConfirm = document.getElementById('btnPromptConfirm');

    titleEl.textContent = title;
    msgEl.textContent = message;
    inputEl.value = defaultValue;

    modal.classList.add('active');
    inputEl.focus();

    const cleanup = () => {
      modal.classList.remove('active');
      btnConfirm.removeEventListener('click', onConfirm);
      btnCancel.removeEventListener('click', onCancel);
      inputEl.removeEventListener('keypress', onKeyPress);
    };

    const onConfirm = () => {
      cleanup();
      resolve(inputEl.value.trim());
    };

    const onCancel = () => {
      cleanup();
      resolve(null);
    };

    const onKeyPress = (e) => {
      if (e.key === 'Enter') onConfirm();
    };

    btnConfirm.addEventListener('click', onConfirm);
    btnCancel.addEventListener('click', onCancel);
    inputEl.addEventListener('keypress', onKeyPress);
  });
}

function showConfirmModal(title, message, options = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirmModal');
    const titleEl = document.getElementById('confirmModalTitle');
    const msgEl = document.getElementById('confirmModalMessage');
    const btnCancel = document.getElementById('btnConfirmCancel');
    const btnConfirm = document.getElementById('btnConfirmConfirm');
    const btnClose = document.getElementById('btnCloseConfirmModal');

    if (!modal) {
      resolve(false);
      return;
    }

    titleEl.textContent = title || 'Are you sure?';
    msgEl.textContent = message || '';

    btnConfirm.textContent = options.confirmText || 'Confirm';
    btnCancel.textContent = options.cancelText || 'Cancel';

    if (options.isDanger) {
      btnConfirm.className = 'btn btn-danger btn-sm';
    } else {
      btnConfirm.className = 'btn btn-primary btn-sm';
    }

    modal.classList.add('active');

    let resolved = false;
    const cleanup = () => {
      modal.classList.remove('active');
      btnConfirm.removeEventListener('click', onConfirm);
      btnCancel.removeEventListener('click', onCancel);
      if (btnClose) btnClose.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeyDown);
    };

    const onConfirm = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(true);
    };

    const onCancel = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(false);
    };

    const onOverlayClick = (e) => {
      if (e.target === modal) {
        onCancel();
      }
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };

    btnConfirm.addEventListener('click', onConfirm);
    btnCancel.addEventListener('click', onCancel);
    if (btnClose) btnClose.addEventListener('click', onCancel);
    modal.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeyDown);
  });
}
window.openConfirmModal = showConfirmModal;

// --- PLAYLIST CONTROLLER ---
function createPlaylist(name) {
  const newPlaylist = {
    id: 'pl-' + Date.now(),
    name: name,
    songs: [],
    createdAt: new Date().toLocaleDateString()
  };
  state.playlists.push(newPlaylist);
  savePlaylists();
  showToast(`Playlist "${name}" created!`);
}

function importPlaylistFromData(name, songs, cover = null) {
  const playlistCover = cover || (songs && songs.length > 0 && songs[0].thumbnail ? songs[0].thumbnail : null);
  const newPlaylist = {
    id: 'pl-' + Date.now(),
    name: name,
    songs: songs,
    cover: playlistCover,
    createdAt: new Date().toLocaleDateString()
  };
  state.playlists.push(newPlaylist);
  savePlaylists();
  renderPlaylists();
  showToast(`Playlist "${name}" imported with ${songs.length} songs!`);
}


function renderPlaylists() {
  const list = document.getElementById('playlistsList');
  list.innerHTML = '';
  list.className = `playlists-list style-${state.playlistStyle}`;

  state.playlists.forEach(pl => {
    const li = document.createElement('li');
    li.dataset.playlistId = pl.id;
    li.classList.toggle('active', state.currentPlaylistId === pl.id);

    if (state.playlistStyle === 'image-name') {
      const thumb = document.createElement('div');
      thumb.className = 'playlist-thumb';
      if (pl.cover) {
        const img = document.createElement('img');
        img.src = pl.cover;
        img.alt = 'Cover';
        img.referrerPolicy = 'no-referrer';
        img.onerror = () => {
          thumb.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
        };
        thumb.appendChild(img);
      } else {
        thumb.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
      }
      li.appendChild(thumb);

      const span = document.createElement('span');
      span.textContent = pl.name;
      span.style.overflow = 'hidden';
      span.style.textOverflow = 'ellipsis';
      span.style.whiteSpace = 'nowrap';
      li.appendChild(span);

    } else if (state.playlistStyle === 'image-only') {
      li.title = pl.name;
      const thumb = document.createElement('div');
      thumb.className = 'playlist-thumb';
      if (pl.cover) {
        const img = document.createElement('img');
        img.src = pl.cover;
        img.alt = 'Cover';
        img.referrerPolicy = 'no-referrer';
        img.onerror = () => {
          thumb.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
        };
        thumb.appendChild(img);
      } else {
        thumb.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
      }
      li.appendChild(thumb);

    } else {
      const span = document.createElement('span');
      span.textContent = pl.name;
      span.style.overflow = 'hidden';
      span.style.textOverflow = 'ellipsis';
      span.style.whiteSpace = 'nowrap';
      li.appendChild(span);
    }

    li.addEventListener('click', () => {
      openPlaylistDetails(pl.id);
    });

    list.appendChild(li);
  });
}

function openPlaylistDetails(playlistId, options = {}) {
  state.currentPlaylistId = playlistId;
  const pl = state.playlists.find(p => p.id === playlistId);
  if (!pl) return;

  switchTab('playlist-detail', options);

  // Reset system playlist overrides
  const deleteBtn = document.getElementById('btnDeletePlaylist');
  const downloadBtn = document.getElementById('btnDownloadPlaylist');
  const downloadBtnText = document.getElementById('btnDownloadPlaylistText');
  if (deleteBtn) deleteBtn.style.display = '';
  if (downloadBtn) downloadBtn.style.display = '';

  const pinnedItem = document.getElementById('btnOpenDownloadedPlaylist');
  if (pinnedItem) pinnedItem.classList.remove('active');

  const detailTitleEl = document.getElementById('detailPlaylistName');
  if (detailTitleEl) detailTitleEl.contentEditable = "true";

  // Check if all songs in this playlist are already downloaded
  if (downloadBtn && downloadBtnText && pl.songs && pl.songs.length > 0) {
    const allDownloaded = pl.songs.every(s => state.downloadedTrackIds && state.downloadedTrackIds.has(s.id));
    if (allDownloaded) {
      downloadBtn.classList.add('is-downloaded');
      downloadBtnText.textContent = "Downloaded";
    } else {
      downloadBtn.classList.remove('is-downloaded');
      downloadBtnText.textContent = "Download Playlist";
    }
  } else if (downloadBtnText) {
    downloadBtnText.textContent = "Download Playlist";
    if (downloadBtn) downloadBtn.classList.remove('is-downloaded');
  }

  // Highlight active playlist item
  document.querySelectorAll('#playlistsList li').forEach(li => {
    li.classList.toggle('active', li.dataset.playlistId === playlistId);
  });

  document.getElementById('detailPlaylistName').textContent = pl.name;
  document.getElementById('detailPlaylistStats').textContent = `${pl.songs.length} songs • Created ${pl.createdAt}`;

  const imgContent = document.getElementById('detailPlaylistImgContent');
  if (pl.cover) {
    const img = document.createElement('img');
    img.src = pl.cover;
    img.alt = 'Cover';
    img.referrerPolicy = 'no-referrer';
    img.style.cssText = 'width:100%; height:100%; object-fit:cover;';
    img.onerror = () => {
      imgContent.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 48px; height: 48px;"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
    };
    imgContent.innerHTML = '';
    imgContent.appendChild(img);
  } else {
    imgContent.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 48px; height: 48px;"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
  }

  // Configure In-Playlist Search Bar
  const searchContainer = document.getElementById('playlistSearchContainer');
  const searchInput = document.getElementById('playlistSearchInput');
  const clearBtn = document.getElementById('btnClearPlaylistSearch');
  const countBadge = document.getElementById('playlistSearchBadge');

  if (searchContainer) {
    searchContainer.style.display = (pl.songs && pl.songs.length > 0) ? 'flex' : 'none';
  }

  if (searchInput) {
    searchInput.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    if (countBadge) countBadge.style.display = 'none';

    searchInput.oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      if (!q) {
        if (clearBtn) clearBtn.style.display = 'none';
        if (countBadge) countBadge.style.display = 'none';
        renderPlaylistSongRows(pl, pl.songs);
        return;
      }
      if (clearBtn) clearBtn.style.display = 'block';
      const filtered = pl.songs.filter(s => {
        const titleMatch = (s.title || '').toLowerCase().includes(q);
        const artistMatch = (s.artist || '').toLowerCase().includes(q);
        return titleMatch || artistMatch;
      });
      if (countBadge) {
        countBadge.textContent = `${filtered.length} of ${pl.songs.length} songs`;
        countBadge.style.display = 'inline-block';
      }
      renderPlaylistSongRows(pl, filtered);
    };

    if (clearBtn) {
      clearBtn.onclick = () => {
        searchInput.value = '';
        clearBtn.style.display = 'none';
        if (countBadge) countBadge.style.display = 'none';
        renderPlaylistSongRows(pl, pl.songs);
        searchInput.focus();
      };
    }
  }

  // Initial render of all songs
  renderPlaylistSongRows(pl, pl.songs);
}

function renderPlaylistSongRows(pl, songsToDisplay) {
  const container = document.getElementById('playlistSongsContainer');
  if (!container) return;
  container.innerHTML = '';

  if (pl.songs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>This playlist has no songs yet</h3>
        <p>Search for songs and add them using the "+" button!</p>
      </div>
    `;
    return;
  }

  if (songsToDisplay.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>No matching songs found</h3>
        <p>Try searching for a different title or artist name.</p>
      </div>
    `;
    return;
  }

  songsToDisplay.forEach((song, displayIdx) => {
    // Locate the song's real position in the full playlist
    const realIdx = pl.songs.findIndex(s => s.id === song.id);
    const resolvedOriginalIdx = realIdx !== -1 ? realIdx : displayIdx;

    const row = document.createElement('div');
    row.className = 'song-row';
    row.dataset.songId = song.id;
    if (state.currentSong && state.currentSong.id === song.id) {
      row.classList.add('active');
    }

    row.addEventListener('click', () => {
      // PROPER PLAYLIST CONTEXT: Always populate playQueue with the entire playlist array!
      state.playQueue = pl.songs.map(s => ({ ...s }));
      state.stationAnchor = pl.songs[pl.songs.length - 1] || song;
      state.isRadioSession = false;
      playSong(song, resolvedOriginalIdx);
    });

    const isDownloaded = state.downloadedTrackIds && state.downloadedTrackIds.has(song.id);

    const colNum = document.createElement('div');
    colNum.className = 'col-num';
    colNum.textContent = resolvedOriginalIdx + 1;

    const colTitle = document.createElement('div');
    colTitle.className = 'col-title';
    colTitle.innerHTML = `
      <img src="${song.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=200&auto=format&fit=crop'}" alt="Thumb">
      <div class="song-col-text">
        <div class="song-col-title" title="${song.title}">
          ${song.title}
          ${isDownloaded ? '<span class="download-check-icon" title="Downloaded on device"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg></span>' : ''}
        </div>
        <div class="song-col-artist clickable-artist">${song.artist || 'Unknown'}</div>
      </div>
    `;

    const colArtist = document.createElement('div');
    colArtist.className = 'col-artist';
    const artistSpan = document.createElement('span');
    artistSpan.className = 'clickable-artist';
    artistSpan.textContent = song.artist || 'Unknown';
    artistSpan.title = 'View artist profile';
    artistSpan.addEventListener('click', (e) => {
      e.stopPropagation();
      openArtistProfile(song.artist, song.platform, song.artistId || song.artist_id);
    });
    colArtist.appendChild(artistSpan);

    const colSource = document.createElement('div');
    colSource.className = 'col-source';
    colSource.innerHTML = `<span class="song-card-badge badge-${song.platform}">${song.platform}</span>`;

    const colDuration = document.createElement('div');
    colDuration.className = 'col-duration';
    colDuration.textContent = song.duration || '3:30';

    const colActions = document.createElement('div');
    colActions.className = 'col-actions';

    // Download/Offline Button on individual song
    const dlBtn = document.createElement('button');
    dlBtn.className = `icon-btn btn-track-download ${isDownloaded ? 'downloaded' : ''}`;
    dlBtn.title = isDownloaded ? 'Downloaded on device (Click to remove)' : 'Download song offline';
    dlBtn.innerHTML = isDownloaded 
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #10b981;"><polyline points="20 6 9 17 4 12"></polyline></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadSingleTrack(song);
    });
    colActions.appendChild(dlBtn);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'icon-btn';
    removeBtn.title = 'Remove song';
    removeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeSongFromPlaylist(pl.id, resolvedOriginalIdx);
    });

    colActions.appendChild(removeBtn);

    row.appendChild(colNum);
    row.appendChild(colTitle);
    row.appendChild(colArtist);
    row.appendChild(colSource);
    row.appendChild(colDuration);
    row.appendChild(colActions);

    container.appendChild(row);
  });
}

function removeSongFromPlaylist(playlistId, index) {
  const plIdx = state.playlists.findIndex(p => p.id === playlistId);
  if (plIdx !== -1) {
    state.playlists[plIdx].songs.splice(index, 1);
    savePlaylists();
    showToast('Song removed from playlist');
    openPlaylistDetails(playlistId);
  }
}

// Modal select methods
let songToAdd = null;
function openPlaylistSelectModal(song) {
  songToAdd = song;
  const list = document.getElementById('modalPlaylistSelect');
  list.innerHTML = '';

  state.playlists.forEach(pl => {
    const li = document.createElement('li');
    li.textContent = pl.name;
    li.addEventListener('click', () => {
      if (songToAdd) {
        addSongToPlaylist(pl.id, songToAdd);
      } else if (state.tempModalAddSongs && state.tempModalAddSongs.length > 0) {
        let addedCount = 0;
        state.tempModalAddSongs.forEach(s => {
          const duplicate = state.playlists.find(p => p.id === pl.id).songs.some(existing => existing.id === s.id);
          if (!duplicate) {
            state.playlists.find(p => p.id === pl.id).songs.push(s);
            addedCount++;
          }
        });
        savePlaylists();
        showToast(`Added ${addedCount} tracks to "${state.playlists.find(p => p.id === pl.id).name}"`);
        if (state.currentPlaylistId === pl.id) {
          openPlaylistDetails(pl.id);
        }
        state.tempModalAddSongs = null;
      }
      document.getElementById('playlistModal').classList.remove('active');
    });
    list.appendChild(li);
  });

  document.getElementById('playlistModal').classList.add('active');
}

function addSongToPlaylist(playlistId, song) {
  const plIdx = state.playlists.findIndex(p => p.id === playlistId);
  if (plIdx !== -1) {
    // Avoid double inserts for identical IDs
    const duplicate = state.playlists[plIdx].songs.some(s => s.id === song.id);
    if (duplicate) {
      showToast('Song is already in this playlist');
      return;
    }

    state.playlists[plIdx].songs.push(song);
    savePlaylists();
    showToast(`Added to "${state.playlists[plIdx].name}"`);
    if (state.currentPlaylistId === playlistId) {
      openPlaylistDetails(playlistId);
    }
  }
}

// --- MULTI-SOURCE AUDIO PLAYBACK ENGINE ---
function playSongList(songs, startIndex) {
  state.playQueue = songs.map(s => ({ ...s }));
  if (songs.length > 0 && startIndex < songs.length) {
    state.stationAnchor = songs[songs.length - 1] || songs[startIndex];
    state.isRadioSession = false;
    playSong(songs[startIndex], startIndex);
  }
}

function playSong(song, index) {
  // Stop existing playback
  stopActivePlayback();

  state.currentSong = song;
  state.currentQueueIndex = index;
  state.isPlaying = true;
  state.isUserPaused = false;
  state.isTransitioning = true;
  state.transitionStartTime = Date.now();
  setTimeout(() => {
    state.isTransitioning = false;
  }, 1200);

  // Persist session state across crashes / restarts
  savePlaybackSession();

  // Log listening history
  logPlayHistory(song);

  // Sync right-side detail sidebar
  updateRightSidebar(song);
  updateFavoriteUI(song);
  updateRepeatUI();

  // Sync Spotify-style Queue UI
  renderQueueUI();

  // Update UI Player Details
  document.getElementById('playerSongTitle').textContent = song.title;
  document.getElementById('playerSongArtist').textContent = song.artist || 'Unknown';
  document.getElementById('playerPlatformBadge').textContent = song.platform;
  document.getElementById('playerPlatformBadge').style.display = 'inline-block';

  if (song.thumbnail) {
    document.getElementById('playerAlbumArt').innerHTML = `<img src="${song.thumbnail}" alt="Art">`;
  } else {
    document.getElementById('playerAlbumArt').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
  }

  // Parse Duration
  const durationParts = (song.duration || '3:00').split(':');
  if (durationParts.length === 2) {
    state.duration = parseInt(durationParts[0]) * 60 + parseInt(durationParts[1]);
  } else {
    state.duration = 180; // fallback 3 minutes
  }
  document.getElementById('playerTotalDuration').textContent = song.duration || '3:00';
  document.getElementById('playerCurrentTime').textContent = '0:00';
  document.getElementById('playerTimeline').value = 0;

  // Sync Mobile Now Playing Modal
  const mobileNpTitle = document.getElementById('mobileNpTitle');
  const mobileNpArtist = document.getElementById('mobileNpArtist');
  const mobileNpSource = document.getElementById('mobileNpSource');
  const mobileNpCoverImg = document.getElementById('mobileNpCoverImg');
  const mobileNpCoverPlaceholder = document.getElementById('mobileNpCoverPlaceholder');
  const mobileNpTotalDuration = document.getElementById('mobileNpTotalDuration');
  const mobileNpCurrentTime = document.getElementById('mobileNpCurrentTime');
  const mobileNpTimeline = document.getElementById('mobileNpTimeline');

  if (mobileNpTitle) mobileNpTitle.textContent = song.title;
  if (mobileNpArtist) mobileNpArtist.textContent = song.artist || 'Unknown Artist';
  if (mobileNpSource) mobileNpSource.textContent = (song.platform ? song.platform.toUpperCase() : 'AETHER MUSIC');
  if (mobileNpTotalDuration) mobileNpTotalDuration.textContent = song.duration || '3:00';
  if (mobileNpCurrentTime) mobileNpCurrentTime.textContent = '0:00';
  if (mobileNpTimeline) mobileNpTimeline.value = 0;

  if (mobileNpCoverImg && mobileNpCoverPlaceholder) {
    if (song.thumbnail) {
      mobileNpCoverImg.src = song.thumbnail;
      mobileNpCoverImg.style.display = 'block';
      mobileNpCoverPlaceholder.style.display = 'none';
    } else {
      mobileNpCoverImg.style.display = 'none';
      mobileNpCoverPlaceholder.style.display = 'flex';
    }
  }

  // Update Native MediaSession Metadata for Android Lockscreen & Notification tray
  if ('mediaSession' in navigator) {
    try {
      const artUrl = song.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=256&auto=format&fit=crop';
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title,
        artist: song.artist || 'AetherPlayer',
        album: song.album || 'Aether Music',
        artwork: [
          { src: artUrl, sizes: '96x96', type: 'image/png' },
          { src: artUrl, sizes: '128x128', type: 'image/png' },
          { src: artUrl, sizes: '256x256', type: 'image/png' },
          { src: artUrl, sizes: '512x512', type: 'image/png' }
        ]
      });

      navigator.mediaSession.playbackState = 'playing';

      // Attach Native notification control handlers
      navigator.mediaSession.setActionHandler('play', () => togglePlayPause());
      navigator.mediaSession.setActionHandler('pause', () => togglePlayPause());
      navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
      navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined && state.duration) {
          seekToPercentage(details.seekTime / state.duration);
        }
      });
    } catch (e) {
      console.warn("MediaSession API error:", e);
    }
  }

  // Reset lyrics index and trigger debounced fetch for lyrics box
  activeLyricIndex = -1;
  ensureLyricsLoaded(song);

  // Initialize playback: check if downloaded locally or device is offline
  const isLocalOffline = (state.downloadedTrackIds && state.downloadedTrackIds.has(song.id)) || !navigator.onLine;
  if (isLocalOffline) {
    playOfflineTrack(song);
  } else if (song.platform === 'youtube' || song.isFallback) {
    playYouTubeTrack(song.id);
    if (state.smartCacheEnabled && navigator.onLine) {
      cacheStreamTrack(song);
    }
  } else if (song.platform === 'spotify') {
    if (song.previewUrl) {
      playPreviewTrack(song.previewUrl);
    } else {
      playProxyFallback(song);
    }
    if (state.smartCacheEnabled && navigator.onLine) {
      cacheStreamTrack(song);
    }
  } else if (song.platform === 'soundcloud') {
    playProxyFallback(song);
    if (state.smartCacheEnabled && navigator.onLine) {
      cacheStreamTrack(song);
    }
  }

  // Update Play Button Icon
  updatePlayButtonUI(true);
  playerErrorRetryCount = 0;

  // Sync native Android system notification & lockscreen media widget
  if (window.AndroidAudio && typeof window.AndroidAudio.updateMetadata === 'function') {
    try {
      window.AndroidAudio.updateMetadata(song.title || 'Aether Track', song.artist || 'Unknown Artist', song.thumbnail || '', true);
    } catch (e) { }
  }

  // If user is currently looking at playlist details, update the active row highlight only
  if (state.activeTab === 'playlist-detail') {
    document.querySelectorAll('#playlistSongsContainer .song-row').forEach((row, rIdx) => {
      row.classList.toggle('active', rIdx === index);
    });
  }

  // Fetch and display similar song recommendations
  fetchAndRenderRecommendations(song);

  // Preload / pre-resolve the upcoming track in the queue to minimize startup latency
  preloadNextTrackInQueue(index);
}

async function playYouTubeTrack(videoId, startTime = 0) {
  if (!videoId) return;

  // 1. Attempt Direct Audio Stream Pipeline (Web Audio API Core)
  try {
    AetherAudioEngine.init();
    if (AetherAudioEngine.initialized && AetherAudioEngine.audioElement) {
      // Pause iframe if running
      if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
        try { ytPlayer.pauseVideo(); } catch (e) {}
      }

      state.currentPlaybackType = 'audio';
      const audio = AetherAudioEngine.audioElement;
      activeAudio = audio;
      audio.src = `/api/stream/proxy?id=${encodeURIComponent(videoId)}`;

      audio.onloadedmetadata = () => {
        if (audio.duration && isFinite(audio.duration)) {
          state.duration = Math.floor(audio.duration);
          document.getElementById('playerTotalDuration').textContent = formatSeconds(state.duration);
          const mobileNpTotalDuration = document.getElementById('mobileNpTotalDuration');
          if (mobileNpTotalDuration) mobileNpTotalDuration.textContent = formatSeconds(state.duration);
        }
        if (startTime > 0) {
          audio.currentTime = startTime;
        }
      };

      audio.onended = () => {
        playNext();
      };

      audio.onerror = () => {
        console.warn('[AudioEngine] Direct stream failed, falling back to YouTube IFrame');
        playYouTubeIFrameFallback(videoId, startTime);
      };

      await audio.play();
      state.isPlaying = true;
      updatePlayButtonUI(true);
      startProgressTimer('audio');
      applyVolume();
      return;
    }
  } catch (err) {
    console.warn('[AudioEngine] Direct stream exception, falling back to YouTube IFrame:', err);
  }

  // 2. Fallback to legacy YouTube iframe
  playYouTubeIFrameFallback(videoId, startTime);
}

function playYouTubeIFrameFallback(videoId, startTime = 0) {
  state.currentPlaybackType = 'youtube';
  if (ytPlayer && ytPlayerReady && typeof ytPlayer.loadVideoById === 'function') {
    try {
      ytPlayer.loadVideoById(videoId, startTime);
      ytPlayer.playVideo();
      applyVolume();
      startProgressTimer('youtube');
    } catch (e) {
      console.warn("Could not play video immediately:", e);
    }
  } else {
    // Queue it so as soon as YouTube is ready, it starts automatically on the FIRST click!
    pendingVideoToPlay = videoId;
    if (window.YT && window.YT.Player && !ytPlayer) {
      window.onYouTubeIframeAPIReady();
    }
  }
}

function playPreviewTrack(previewUrl) {
  state.currentPlaybackType = 'audio';
  AetherAudioEngine.init();
  const audio = (AetherAudioEngine.initialized && AetherAudioEngine.audioElement) ? AetherAudioEngine.audioElement : new Audio();
  activeAudio = audio;
  audio.src = previewUrl;
  audio.onended = () => {
    playNext();
  };
  audio.play().then(() => {
    state.isPlaying = true;
    updatePlayButtonUI(true);
    startProgressTimer('audio');
    applyVolume();
  }).catch(e => console.warn('[AudioEngine] Preview play error:', e));
}

async function preloadNextTrackInQueue(currentIndex) {
  if (!state.playQueue || state.playQueue.length <= currentIndex + 1) return;
  const nextTrack = state.playQueue[currentIndex + 1];
  if (!nextTrack) return;

  // 1. If next track is Spotify / SoundCloud without a YouTube ID, pre-resolve it in the background
  if ((nextTrack.platform === 'spotify' || nextTrack.platform === 'soundcloud') && !nextTrack._preResolvedYtId) {
    try {
      const q = `${nextTrack.title} ${nextTrack.artist}`;
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&platform=youtube`);
      if (res.ok) {
        const results = await res.json();
        if (results && results.length > 0) {
          nextTrack._preResolvedYtId = results[0].id;
          nextTrack._preResolvedThumb = results[0].thumbnail;
          console.log(`[Preload] Next track "${nextTrack.title}" pre-resolved -> ${results[0].id}`);
        }
      }
    } catch (e) {}
  }

  // 2. If next track is offline/downloaded, pre-warm audio stream in memory
  const isNextOffline = (state.downloadedTrackIds && state.downloadedTrackIds.has(nextTrack.id));
  if (isNextOffline) {
    try {
      const warmAudio = new Audio();
      warmAudio.preload = 'auto';
      warmAudio.src = `/api/offline/stream?id=${encodeURIComponent(nextTrack.id)}`;
    } catch (e) {}
  }
}

async function playProxyFallback(song) {
  // If we already pre-resolved the YouTube ID in the background, skip network search and play immediately!
  if (song._preResolvedYtId) {
    if (song._preResolvedThumb && (!song.thumbnail || song.thumbnail.includes('unsplash.com'))) {
      song.thumbnail = song._preResolvedThumb;
      const albumArtEl = document.getElementById('playerAlbumArt');
      if (albumArtEl) albumArtEl.innerHTML = `<img src="${song.thumbnail}" alt="" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src=DEFAULT_ALBUM_ART;">`;
      const mobileCover = document.getElementById('mobileNpCoverImg');
      if (mobileCover) mobileCover.src = song.thumbnail;
    }
    playYouTubeTrack(song._preResolvedYtId);
    return;
  }

  // Queries server search API for a YouTube equivalent of Spotify/SoundCloud items
  try {
    const query = `${song.title} ${song.artist}`;
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&platform=youtube`);
    if (response.ok) {
      const results = await response.json();
      if (results && results.length > 0) {
        // If current track has broken or missing artwork, adopt YouTube match's artwork immediately
        if (results[0].thumbnail && (!song.thumbnail || song.thumbnail.includes('unsplash.com'))) {
          song.thumbnail = results[0].thumbnail;
          const albumArtEl = document.getElementById('playerAlbumArt');
          if (albumArtEl) albumArtEl.innerHTML = `<img src="${song.thumbnail}" alt="" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src=DEFAULT_ALBUM_ART;">`;
          const mobileCover = document.getElementById('mobileNpCoverImg');
          if (mobileCover) mobileCover.src = song.thumbnail;
        }
        // play the best YouTube match but keep Spotify/SoundCloud UI metadata
        playYouTubeTrack(results[0].id);
      } else {
        showToast('Playback file not found');
        state.isPlaying = false;
        updatePlayButtonUI(false);
      }
    }
  } catch (e) {
    console.error('Proxy play lookup failed:', e);
    showToast('Failed to load proxy playback');
  }
}

function stopActivePlayback() {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }

  // Stop YouTube iframe
  if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
    try {
      ytPlayer.stopVideo();
    } catch (e) { }
  }

  // Stop Web Audio Engine / HTML5 Audio
  if (window.AetherAudioEngine && AetherAudioEngine.initialized) {
    AetherAudioEngine.stopPlayback();
  } else if (activeAudio) {
    try {
      activeAudio.pause();
      activeAudio.src = '';
    } catch (e) {}
    activeAudio = null;
  }

  state.currentPlaybackType = null;
  state.isPlaying = false;
}

function togglePlayPause() {
  if (!state.currentSong) {
    if (state.playQueue && state.playQueue.length > 0) {
      playSong(state.playQueue[0], 0);
      return;
    }
    const currentPl = state.playlists.find(p => p.id === state.currentPlaylistId);
    if (currentPl && currentPl.songs && currentPl.songs.length > 0) {
      playSongList(currentPl.songs, 0);
      return;
    }
    showToast("Choose a song to play");
    return;
  }

  if (state.isPlaying) {
    // User explicitly paused
    state.isPlaying = false;
    state.isUserPaused = true;

    if (activeAudio) {
      try { activeAudio.pause(); } catch (e) {}
    }
    if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
      try { ytPlayer.pauseVideo(); } catch (e) {}
    }
    if (window.AndroidAudio && typeof window.AndroidAudio.pauseTrack === 'function') {
      try { window.AndroidAudio.pauseTrack(); } catch (e) {}
    }
    updatePlayButtonUI(false);
  } else {
    // If resuming from a restored saved session where the player hasn't loaded the stream yet:
    const isPlaybackActive = (activeAudio && activeAudio.src) || (ytPlayer && typeof ytPlayer.getPlayerState === 'function' && ytPlayer.getPlayerState() !== -1);
    if (!isPlaybackActive && state.currentSong) {
      playSong(state.currentSong, state.currentQueueIndex >= 0 ? state.currentQueueIndex : 0, state.playbackPosition || 0);
      return;
    }

    // User explicitly played
    state.isPlaying = true;
    state.isUserPaused = false;

    if (window.AetherAudioEngine && AetherAudioEngine.ctx && AetherAudioEngine.ctx.state === 'suspended') {
      AetherAudioEngine.ctx.resume().catch(() => {});
    }

    if ((state.currentPlaybackType === 'offline' || state.currentPlaybackType === 'audio') && activeAudio) {
      activeAudio.play().catch(e => console.warn("Audio resume error:", e));
    } else if (ytPlayer && typeof ytPlayer.playVideo === 'function') {
      try { ytPlayer.playVideo(); } catch (e) {}
    } else if (activeAudio) {
      activeAudio.play().catch(e => console.warn("Audio resume error:", e));
    }
    if (window.AndroidAudio && typeof window.AndroidAudio.resumeTrack === 'function') {
      try { window.AndroidAudio.resumeTrack(); } catch (e) {}
    }
    updatePlayButtonUI(true);
  }
}

// Native Android Audio Bridge Callbacks
window.onNativeAudioProgress = function(currentSec, totalSec) {
  if (!state.isPlaying) return;
  state.playbackPosition = currentSec;
  if (totalSec && totalSec > 0) state.duration = totalSec;
  throttledSavePlaybackSession();

  updateLyricsHighlight(currentSec);

  const pct = (currentSec / state.duration) * 100;
  const boundedPct = Math.min(100, Math.max(0, pct));
  const timeFormatted = formatSeconds(currentSec);

  const timeline = document.getElementById('playerTimeline');
  if (timeline) timeline.value = boundedPct;
  const currTime = document.getElementById('playerCurrentTime');
  if (currTime) currTime.textContent = timeFormatted;

  const mobileTimeline = document.getElementById('mobileNpTimeline');
  if (mobileTimeline) mobileTimeline.value = boundedPct;
  const mobileTime = document.getElementById('mobileNpCurrentTime');
  if (mobileTime) mobileTime.textContent = timeFormatted;
  const miniProg = document.getElementById('miniPlayerProgress');
  if (miniProg) miniProg.style.width = `${boundedPct}%`;
};

window.onNativeAudioEnded = function() {
  playNext();
};

window.onNativeAudioStateChange = function(isPlaying) {
  state.isPlaying = isPlaying;
  updatePlayButtonUI(isPlaying);
};

function playNext() {
  const now = Date.now();
  if (state.isTransitioning && (now - (state.transitionStartTime || 0) < 1800)) {
    console.log("Ignoring playNext() during rapid transition...");
    return;
  }
  state.isTransitioning = true;
  state.transitionStartTime = now;
  if (state.playQueue.length === 0) return;

  // Seamless pre-fetch: if within 4 tracks of queue end, fetch more from anchor!
  if (state.autoplayEnabled && (state.stationAnchor || state.currentSong) && !state.isFetchingMoreQueue) {
    if (state.currentQueueIndex >= state.playQueue.length - 4) {
      extendStationQueue(false);
    }
  }

  let nextIndex = state.currentQueueIndex + 1;
  if (state.shuffle) {
    nextIndex = Math.floor(Math.random() * state.playQueue.length);
  } else if (state.repeat === 'one') {
    nextIndex = state.currentQueueIndex;
  } else if (nextIndex >= state.playQueue.length) {
    if (state.repeat === 'all') {
      nextIndex = 0;
    } else if (state.autoplayEnabled && (state.stationAnchor || state.currentSong)) {
      showToast('Finding more similar vibes...');
      extendStationQueue(true);
      return;
    } else {
      showToast('End of queue');
      state.isPlaying = false;
      updatePlayButtonUI(false);
      if (window.AndroidAudio && typeof window.AndroidAudio.stop === 'function') {
        try { window.AndroidAudio.stop(); } catch(e) {}
      }
      return;
    }
  }

  playSong(state.playQueue[nextIndex], nextIndex);
}

let lastPrevClickTimestamp = 0;

function playPrev() {
  if (!state.playQueue || state.playQueue.length === 0) return;

  const now = Date.now();
  const isRapidSecondClick = (now - lastPrevClickTimestamp < 1800);
  lastPrevClickTimestamp = now;

  // Standard media player logic:
  // 1. If currently playing beyond 3 seconds and not a double-click: restart current song from 0:00
  // 2. If within first 3 seconds OR rapid second click: navigate to actual previous track
  if (state.playbackPosition > 3 && !isRapidSecondClick) {
    seekToPercentage(0);
    state.playbackPosition = 0;
    if (!state.isPlaying) {
      togglePlayPause();
    }
    return;
  }

  let prevIndex = state.currentQueueIndex - 1;
  if (prevIndex < 0) {
    prevIndex = state.playQueue.length - 1;
  }
  playSong(state.playQueue[prevIndex], prevIndex);
}

function updateVolumeBubble(val) {
  const bubble = document.getElementById('volumeBubble');
  const slider = document.getElementById('playerVolume');
  if (!bubble) return;
  const clamped = Math.max(0, Math.min(100, val));
  bubble.textContent = `${clamped}%`;

  if (slider && slider.offsetWidth) {
    const sliderWidth = slider.offsetWidth;
    // Standard input[type=range] thumb width is ~15px
    const thumbWidth = 15;
    const ratio = clamped / 100;
    const centerPx = (thumbWidth / 2) + ratio * (sliderWidth - thumbWidth);
    bubble.style.left = `${centerPx}px`;
    bubble.style.transform = 'translateX(-50%)';
  } else {
    // Dynamic calc compensation for thumb edge margins
    bubble.style.left = `calc(${clamped}% + ${(0.5 - clamped / 100) * 15}px)`;
    bubble.style.transform = 'translateX(-50%)';
  }
}

function applyVolume() {
  const vol = state.isMuted ? 0 : state.volume;
  let effectiveRatio = 0;
  let effectiveYtVolume = 0;

  if (vol > 0) {
    // Perceptual dynamic curve down to 1% without cutoffs
    // Eliminates silent dropout below 7% while retaining natural quiet scaling
    const ratio = vol / 100;
    effectiveRatio = Math.max(0.005, Math.pow(ratio, 2.2));
    effectiveYtVolume = Math.max(1, Math.min(100, Math.round(Math.pow(ratio, 2.2) * 99 + 1)));
  }

  if (window.AndroidAudio && typeof window.AndroidAudio.setVolume === 'function') {
    try { window.AndroidAudio.setVolume(effectiveRatio); } catch (e) {}
  }
  if (ytPlayer && typeof ytPlayer.setVolume === 'function') {
    try { ytPlayer.setVolume(effectiveYtVolume); } catch (e) {}
  }
  if (window.AetherAudioEngine && AetherAudioEngine.initialized) {
    AetherAudioEngine.setMasterVolume(effectiveRatio);
  } else if (activeAudio) {
    try { activeAudio.volume = effectiveRatio; } catch (e) {}
  }
}

let seekDebounceTimer = null;
let isUserSeeking = false;

function seekToPercentage(pct) {
  const boundedPct = Math.min(1, Math.max(0, pct));
  const seekSeconds = boundedPct * state.duration;

  // Immediately reflect timestamp in UI without waiting
  state.playbackPosition = seekSeconds;
  const timeFormatted = formatSeconds(seekSeconds);
  const currTime = document.getElementById('playerCurrentTime');
  if (currTime) currTime.textContent = timeFormatted;
  const mobileTime = document.getElementById('mobileNpCurrentTime');
  if (mobileTime) mobileTime.textContent = timeFormatted;

  isUserSeeking = true;
  if (seekDebounceTimer) {
    clearTimeout(seekDebounceTimer);
  }

  // Throttle rapid click/drag spamming into a single clean seek instruction
  seekDebounceTimer = setTimeout(() => {
    if (window.AndroidAudio && typeof window.AndroidAudio.seekTo === 'function') {
      try { window.AndroidAudio.seekTo(seekSeconds); } catch (e) {}
    } else if ((state.currentPlaybackType === 'offline' || state.currentPlaybackType === 'audio') && activeAudio) {
      try { activeAudio.currentTime = seekSeconds; } catch (e) {}
    } else if (ytPlayer && typeof ytPlayer.seekTo === 'function') {
      try { ytPlayer.seekTo(seekSeconds, true); } catch (e) {}
    } else if (activeAudio) {
      try { activeAudio.currentTime = seekSeconds; } catch (e) {}
    }
    // Allow small cooldown before resume timer takes back timeline slider control
    setTimeout(() => {
      isUserSeeking = false;
    }, 250);
  }, 100);
}

function updateTimelineUI(currentSec) {
  if (isUserSeeking) return; // Never fight or jerk slider thumb while user is scrubbing!
  if (currentSec === undefined) currentSec = state.playbackPosition;
  const pct = state.duration > 0 ? (currentSec / state.duration) * 100 : 0;
  const boundedPct = Math.min(100, Math.max(0, pct));
  const timeFormatted = formatSeconds(currentSec);

  const timeline = document.getElementById('playerTimeline');
  if (timeline) timeline.value = boundedPct;
  const currentTime = document.getElementById('playerCurrentTime');
  if (currentTime) currentTime.textContent = timeFormatted;

  // Update Mobile Scrubber & Mini progress bar
  const mobileTimeline = document.getElementById('mobileNpTimeline');
  if (mobileTimeline) mobileTimeline.value = boundedPct;
  const mobileTime = document.getElementById('mobileNpCurrentTime');
  if (mobileTime) mobileTime.textContent = timeFormatted;
  const miniProg = document.getElementById('miniPlayerProgress');
  if (miniProg) miniProg.style.width = `${boundedPct}%`;

  // Update synced lyrics line
  updateLyricsHighlight(currentSec);
}

function startProgressTimer(platform) {
  if (progressInterval) clearInterval(progressInterval);

  progressInterval = setInterval(() => {
    if (!state.isPlaying) return;

    let currentSec = 0;
    if (platform === 'youtube' && ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
      currentSec = ytPlayer.getCurrentTime();
    } else if ((platform === 'preview' || platform === 'audio') && activeAudio) {
      currentSec = activeAudio.currentTime;
    }

    state.playbackPosition = currentSec;
    throttledSavePlaybackSession();

    // Background track-end detector:
    // When the phone is locked, YouTube IFrame API can occasionally fail to dispatch onStateChange: ENDED.
    // If current playback timestamp reaches the duration, automatically trigger the next track!
    if (state.duration > 0 && currentSec >= state.duration - 0.75) {
      const now = Date.now();
      if (!state.isTransitioning || (now - (state.transitionStartTime || 0) > 3000)) {
        console.log("Track completion detected by background ticker, advancing queue...");
        state.isTransitioning = true;
        state.transitionStartTime = now;
        playNext();
        return;
      }
    }

    // BATTERY SAVER: If screen is off or app is minimized, do NOT touch DOM / layout
    if (!isAppVisible) return;

    updateTimelineUI(currentSec);
  }, 500);
}

// YT State Change Monitor
function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.PLAYING) {
    state.isTransitioning = false;
    state.isPlaying = true;
    state.isUserPaused = false;
    updatePlayButtonUI(true);
  }
  if (event.data === YT.PlayerState.PAUSED) {
    // If the user did not click pause, but Android OS or browser tried to pause it in the background:
    if (state.isPlaying && !state.isUserPaused) {
      setTimeout(() => {
        if (state.isPlaying && !state.isUserPaused && ytPlayer && typeof ytPlayer.playVideo === 'function') {
          ytPlayer.playVideo();
        }
      }, 80);
    }
  }
  if (event.data === YT.PlayerState.ENDED) {
    state.isTransitioning = false;
    playNext();
  }
}

let playerErrorRetryCount = 0;

function onPlayerError(event) {
  console.error('YouTube player error:', event.data);
  // Auto-recovery: if stream URL/token is stale or expired, attempt fallback search once
  if (playerErrorRetryCount < 1 && state.currentSong) {
    playerErrorRetryCount++;
    console.log("Attempting fallback stream resolution due to player error...");
    showToast('Reconnecting audio stream...');
    delete state.currentSong._preResolvedYtId;
    playProxyFallback(state.currentSong);
    return;
  }
  playerErrorRetryCount = 0;
  showToast('Playback error, skipping song...');
  setTimeout(playNext, 1500);
}

// UI State utilities
function updatePlayButtonUI(isPlaying) {
  document.getElementById('playIcon').style.display = isPlaying ? 'none' : 'block';
  document.getElementById('pauseIcon').style.display = isPlaying ? 'block' : 'none';

  const mobilePlayIcon = document.getElementById('mobileNpPlayIcon');
  const mobilePauseIcon = document.getElementById('mobileNpPauseIcon');
  if (mobilePlayIcon) mobilePlayIcon.style.display = isPlaying ? 'none' : 'block';
  if (mobilePauseIcon) mobilePauseIcon.style.display = isPlaying ? 'block' : 'none';

  const queueBars = document.getElementById('queueNowPlayingBars');
  if (queueBars) queueBars.style.display = isPlaying ? 'flex' : 'none';

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    } catch (e) { }
  }

  if (window.AndroidAudio && typeof window.AndroidAudio.updatePlaybackState === 'function') {
    try {
      window.AndroidAudio.updatePlaybackState(isPlaying);
    } catch (e) { }
  }
}

function updateRepeatUI() {
  const desktopBtn = document.getElementById('btnRepeat');
  const mobileBtn = document.getElementById('btnMobileNpRepeat');
  
  if (state.repeat === 'none') {
    if (desktopBtn) {
      desktopBtn.classList.remove('active');
      desktopBtn.style.color = '';
    }
    if (mobileBtn) {
      mobileBtn.classList.remove('active', 'repeat-one');
    }
  } else if (state.repeat === 'all') {
    if (desktopBtn) {
      desktopBtn.classList.add('active');
      desktopBtn.style.color = 'var(--accent-color)';
    }
    if (mobileBtn) {
      mobileBtn.classList.add('active');
      mobileBtn.classList.remove('repeat-one');
    }
  } else if (state.repeat === 'one') {
    if (desktopBtn) {
      desktopBtn.classList.add('active');
      desktopBtn.style.color = 'var(--accent-color)';
    }
    if (mobileBtn) {
      mobileBtn.classList.add('active', 'repeat-one');
    }
  }
}

function updateFavoriteUI(song) {
  if (!song) return;
  const isFav = state.playlists.some(p => p.songs && p.songs.some(s => s.id === song.id));
  const favBtn = document.getElementById('btnAddToFavorites');
  const mobileFavBtn = document.getElementById('btnMobileNpFavorite');
  if (favBtn) favBtn.classList.toggle('active', isFav);
  if (mobileFavBtn) mobileFavBtn.classList.toggle('active', isFav);
}

function openMobileNowPlaying() {
  const modal = document.getElementById('mobileNowPlayingModal');
  if (modal) {
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
}

function closeMobileNowPlaying() {
  const modal = document.getElementById('mobileNowPlayingModal');
  if (modal) {
    modal.classList.remove('active');
    document.body.style.overflow = '';
  }
}

// --- UTILITY SERVICES ---
function formatSeconds(seconds) {
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  return `${min}:${sec < 10 ? '0' : ''}${sec}`;
}

function showToast(message) {
  const toast = document.getElementById('appToast');
  toast.textContent = message;
  toast.classList.add('active');
  setTimeout(() => {
    toast.classList.remove('active');
  }, 2500);
}

// --- LYRICS ENGINE ---
function ensureLyricsLoaded(song, force = false) {
  if (!song) return;
  const container = document.getElementById('lyricsDrawerBody');
  // If we already have lyrics loaded for this specific song and not forcing a re-fetch:
  if (!force && state.cachedLyricsTrackId === song.id && state.lyrics !== null) {
    if (state.lyricsSynced && Array.isArray(state.lyrics)) {
      renderSyncedLyrics(state.lyrics);
    } else if (container && typeof state.lyrics === 'string') {
      container.innerHTML = `<div class="lyric-plain-text">${state.lyrics}</div>`;
    }
    updateLyricsHighlight(state.playbackPosition || 0);
    return;
  }

  // Debounce the actual network fetch so skipping tracks doesn't flood the API
  clearTimeout(state.lyricsDebounceTimer);
  state.lyricsDebounceTimer = setTimeout(() => {
    fetchLyricsForTrack(song);
  }, 400);
}

async function fetchLyricsForTrack(song) {
  if (!song) return;
  const container = document.getElementById('lyricsDrawerBody');
  if (container) {
    container.innerHTML = '<div class="lyrics-placeholder">Loading lyrics...</div>';
  }

  state.lyrics = null;
  state.lyricsSynced = false;
  state.cachedLyricsTrackId = song.id;

  try {
    const response = await fetch(`/api/lyrics?title=${encodeURIComponent(song.title)}&artist=${encodeURIComponent(song.artist || '')}`);
    if (!response.ok) throw new Error('Network response not ok');

    const data = await response.json();
    if (data.error) {
      if (container) {
        container.innerHTML = `<div class="lyrics-placeholder">${data.error}</div>`;
      }
      return;
    }

    if (data.synced && data.syncedLyrics) {
      // Synced lyrics exist
      state.lyrics = parseLrc(data.syncedLyrics);
      state.lyricsSynced = true;
      renderSyncedLyrics(state.lyrics);
    } else if (data.lyrics) {
      // Plain lyrics exist
      state.lyrics = data.lyrics;
      state.lyricsSynced = false;
      if (container) {
        container.innerHTML = `<div class="lyric-plain-text">${data.lyrics}</div>`;
      }
    } else {
      if (container) {
        container.innerHTML = '<div class="lyrics-placeholder">No lyrics found for this song.</div>';
      }
    }
  } catch (err) {
    console.error('Failed to fetch lyrics:', err);
    if (container) {
      container.innerHTML = '<div class="lyrics-placeholder">Failed to load lyrics.</div>';
    }
  } finally {
    updateLyricsHighlight(state.playbackPosition || 0);
  }
}

function parseLrc(lrcText) {
  const lines = lrcText.split('\n');
  const result = [];
  const regex = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/;

  for (let line of lines) {
    line = line.trim();
    const match = line.match(regex);
    if (match) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseFloat(match[2]);
      const text = match[3].trim();
      const totalTime = minutes * 60 + seconds;
      result.push({ time: totalTime, text: text });
    }
  }

  // Sort lines by time
  result.sort((a, b) => a.time - b.time);
  return result;
}

function renderSyncedLyrics(lyricsArray) {
  const container = document.getElementById('lyricsDrawerBody');
  container.innerHTML = '';

  lyricsArray.forEach((line, index) => {
    const div = document.createElement('div');
    div.className = 'lyric-line';
    div.textContent = line.text || '• • •';
    div.dataset.index = index;
    div.dataset.time = line.time;

    // Clicking a line seeks player to that line's timestamp!
    div.addEventListener('click', () => {
      seekToPercentage(line.time / state.duration);
      // update highlight immediately
      updateLyricsHighlight(line.time);
    });

    container.appendChild(div);
  });

  // Also render inside the live lyrics widget scroll container!
  const liveContainer = document.getElementById('liveLyricsScrollContainer');
  if (liveContainer) {
    liveContainer.innerHTML = '';

    // Top spacer
    const spacerTop = document.createElement('div');
    spacerTop.className = 'live-line spacer';
    liveContainer.appendChild(spacerTop);

    lyricsArray.forEach((line, index) => {
      const div = document.createElement('div');
      div.className = 'live-line';
      div.textContent = line.text || '• • •';
      liveContainer.appendChild(div);
    });

    // Bottom spacer
    const spacerBottom = document.createElement('div');
    spacerBottom.className = 'live-line spacer';
    liveContainer.appendChild(spacerBottom);
  }
}

let activeLyricIndex = -1;
function updateLyricsHighlight(currentTime) {
  // 1. Update Mobile Embedded Spotify Lyrics Card
  const mobileCurrent = document.getElementById('mobileNpLyricsCurrentLine');
  const mobileNext = document.getElementById('mobileNpLyricsNextLine');
  if (mobileCurrent) {
    if (state.lyrics && state.lyricsSynced && Array.isArray(state.lyrics)) {
      const lines = state.lyrics;
      let activeIndex = -1;
      const adjustedTime = currentTime + 0.35;
      for (let i = 0; i < lines.length; i++) {
        if (adjustedTime >= lines[i].time) {
          activeIndex = i;
        } else {
          break;
        }
      }
      if (activeIndex !== -1) {
        mobileCurrent.textContent = lines[activeIndex].text || '• • •';
        if (mobileNext) {
          mobileNext.textContent = (lines[activeIndex + 1] ? lines[activeIndex + 1].text : '');
        }
      } else {
        mobileCurrent.textContent = lines[0] ? lines[0].text : '• • •';
        if (mobileNext) mobileNext.textContent = lines[1] ? lines[1].text : '';
      }
    } else if (state.lyrics && typeof state.lyrics === 'string') {
      const firstLine = state.lyrics.split('\n').filter(l => l.trim())[0];
      mobileCurrent.textContent = firstLine || 'Plain lyrics available';
      if (mobileNext) mobileNext.textContent = 'Tap card to expand full lyrics';
    } else {
      mobileCurrent.textContent = state.currentSong ? "Lyrics aren't available for this song" : "Start playing a song to view lyrics";
      if (mobileNext) mobileNext.textContent = '';
    }
  }

  // 2. Update Synced Lyrics Drawer if open
  if (state.lyricsOpen && state.lyricsSynced && state.lyrics) {
    const lines = state.lyrics;
    let activeIndex = -1;

    // Add 350ms anticipation offset to match singer's entry timing
    const adjustedTime = currentTime + 0.35;

    for (let i = 0; i < lines.length; i++) {
      if (adjustedTime >= lines[i].time) {
        activeIndex = i;
      } else {
        break;
      }
    }

    if (activeIndex !== -1 && activeIndex !== activeLyricIndex) {
      activeLyricIndex = activeIndex;

      // 1. Highlight drawer line
      const lineEls = document.querySelectorAll('.lyric-line');
      lineEls.forEach((el, index) => {
        if (index === activeIndex) {
          el.classList.add('active');
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          el.classList.remove('active');
        }
      });

      // 2. Scroll live lyrics widget
      const liveContainer = document.getElementById('liveLyricsScrollContainer');
      if (liveContainer && liveContainer.children.length > 2) {
        // Reset classes on all children
        Array.from(liveContainer.children).forEach(child => {
          const isSpacer = child.classList.contains('spacer');
          child.className = 'live-line';
          if (isSpacer) child.classList.add('spacer');
        });

        const targetIdx = activeIndex + 1; // +1 offset because of top spacer
        const prevChild = liveContainer.children[targetIdx - 1];
        const activeChild = liveContainer.children[targetIdx];
        const nextChild = liveContainer.children[targetIdx + 1];

        if (prevChild && !prevChild.classList.contains('spacer')) prevChild.classList.add('prev');
        if (activeChild) activeChild.classList.add('current');
        if (nextChild && !nextChild.classList.contains('spacer')) nextChild.classList.add('next');

        // Slide container up/down using offsetTop centering math
        const widgetHeight = 90;
        const offset = activeChild.offsetTop - (widgetHeight / 2 - activeChild.offsetHeight / 2);
        liveContainer.style.transform = `translateY(${-offset}px)`;
      }
    }
  } else {
    // Fallback: no synced lyrics or not loaded yet
    const liveContainer = document.getElementById('liveLyricsScrollContainer');
    if (liveContainer) {
      liveContainer.style.transform = 'translateY(0)';

      let text = 'No Song Playing';
      if (state.currentSong) {
        text = state.lyricsOpen && !state.lyricsSynced && state.lyrics
          ? 'Synced lyrics unavailable'
          : `${state.currentSong.title} - ${state.currentSong.artist}`;
      }

      liveContainer.innerHTML = `
        <div class="live-line spacer"></div>
        <div class="live-line current">${text}</div>
        <div class="live-line spacer"></div>
      `;
    }
    activeLyricIndex = -1;
  }
}

const BANNED_VIBE_TERMS = [
  'slowed', 'reverb', 'sped up', 'speed up', 'speedup', 'spedup',
  'nightcore', 'daycore', 'bass boosted', 'bassboost', '8d audio',
  '1 hour', '10 hours', 'extended loop', 'loop', 'instrumental',
  'karaoke', 'backing track', 'acapella', 'cover', 'remake', 'tribute',
  'mashup', 'pitch shifted', 'reaction'
];

function isDuplicateTrack(track, seedTrack) {
  if (!track || !seedTrack) return false;
  if (track.id && seedTrack.id && track.id === seedTrack.id) return true;
  
  const titleLower = (track.title || '').toLowerCase();
  for (const term of BANNED_VIBE_TERMS) {
    if (titleLower.includes(term)) return true;
  }
  
  const clean = (str) => {
    return (str || '').toLowerCase()
      .replace(/\s*[\(\[][^\]\)]*[\)\]]\s*/g, '')
      .replace(/[^a-z0-9]/g, '')
      .trim();
  };
  
  const cleanTitle1 = clean(track.title);
  const cleanTitle2 = clean(seedTrack.title);
  
  if (cleanTitle1 === cleanTitle2) return true;
  if (cleanTitle1.length >= 5 && cleanTitle2.length >= 5) {
    if (cleanTitle1.includes(cleanTitle2) || cleanTitle2.includes(cleanTitle1)) {
      return true;
    }
  }
  return false;
}

async function fetchAndRenderRecommendations(song) {
  const section = document.getElementById('recommendationsSection');
  const grid = document.getElementById('recommendationsGrid');
  const seedText = document.getElementById('recommendationSeedText');
  const rightVibesSec = document.getElementById('rightVibesSection');
  const rightVibesList = document.getElementById('rightVibesList');
  
  if (section && seedText) {
    section.style.display = 'block';
    seedText.textContent = `${song.title} - ${song.artist || 'Unknown'}`;
  }
  if (grid) {
    grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-secondary); padding: 20px;">Curating similar vibes...</div>';
  }
  if (rightVibesSec && rightVibesList) {
    rightVibesSec.style.display = 'block';
    rightVibesList.innerHTML = '<div style="font-size: 0.75rem; color: var(--text-secondary); text-align: center; padding: 10px;">Finding vibes...</div>';
  }
  
  try {
    const url = `/api/recommendations?title=${encodeURIComponent(song.title)}&artist=${encodeURIComponent(song.artist || '')}&platform=${song.platform}&track_id=${song.id || ''}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to fetch recommendations');
    
    const data = await response.json();
    if (grid) grid.innerHTML = '';
    if (rightVibesList) rightVibesList.innerHTML = '';
    
    if (!data || data.length === 0) {
      if (grid) grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-secondary); padding: 20px;">No similar vibes found.</div>';
      if (rightVibesSec) rightVibesSec.style.display = 'none';
      return;
    }
    
    const filteredTracks = data.filter(track => !isDuplicateTrack(track, song));
    
    if (filteredTracks.length === 0) {
      if (grid) grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-secondary); padding: 20px;">No similar vibes found.</div>';
      if (rightVibesSec) rightVibesSec.style.display = 'none';
      return;
    }
    
    state.currentVibeTracks = filteredTracks;
    
    // Render search tab grid cards with filteredTracks as queue context
    if (grid) {
      filteredTracks.forEach(track => {
        const card = createSongCard(track, filteredTracks);
        grid.appendChild(card);
      });
    }

    // Set up Play Vibe Radio button on Search tab
    const btnPlayAll = document.getElementById('btnPlayAllRecommendations');
    if (btnPlayAll) {
      btnPlayAll.onclick = () => {
        if (state.currentVibeTracks && state.currentVibeTracks.length > 0) {
          state.playQueue = [...state.currentVibeTracks];
          playSong(state.currentVibeTracks[0], 0);
          showToast(`Playing Similar Vibes radio (${state.currentVibeTracks.length} tracks)`);
        }
      };
    }

    // Render Right Sidebar mini vibe rows
    if (rightVibesSec && rightVibesList) {
      rightVibesSec.style.display = 'block';
      filteredTracks.slice(0, 5).forEach((track, idx) => {
        const row = document.createElement('div');
        row.className = 'right-vibe-row';
        row.title = `Play: ${track.title} - ${track.artist}`;
        row.innerHTML = `
          <div class="right-vibe-thumb">
            <img src="${track.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=100'}" alt="Thumb" loading="lazy">
          </div>
          <div class="right-vibe-info">
            <div class="right-vibe-title">${track.title}</div>
            <div class="right-vibe-artist">${track.artist || 'Unknown'}</div>
          </div>
          <div class="right-vibe-play-icon">
            <svg viewBox="0 0 24 24" fill="currentColor" style="width: 12px; height: 12px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          </div>
        `;
        row.onclick = () => {
          playSongList(filteredTracks, idx);
        };
        rightVibesList.appendChild(row);
      });

      const btnRightPlay = document.getElementById('btnRightPlayAllVibes');
      if (btnRightPlay) {
        btnRightPlay.onclick = () => {
          if (state.currentVibeTracks && state.currentVibeTracks.length > 0) {
            playSongList(state.currentVibeTracks, 0);
          }
        };
      }
    }
  } catch (err) {
    console.error("Vibe recommendations error:", err);
    if (grid) grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-secondary); padding: 20px;">Failed to load similar vibes.</div>';
    if (rightVibesSec) rightVibesSec.style.display = 'none';
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- SPOTIFY-STYLE QUEUE & ANCHOR STATION ENGINE ---
async function fetchStationVibesForSong(seedSong, options = {}) {
  if (!seedSong) return;
  state.stationAnchor = seedSong;
  renderQueueUI();

  try {
    const excludeIds = (state.playQueue || []).map(s => s.id).filter(Boolean).join(',');
    const url = `/api/recommendations?title=${encodeURIComponent(seedSong.title)}&artist=${encodeURIComponent(seedSong.artist || '')}&platform=${seedSong.platform || 'youtube'}&track_id=${seedSong.id || ''}&limit=20&exclude_ids=${encodeURIComponent(excludeIds)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Recommendations request failed");
    const data = await res.json();

    if (Array.isArray(data) && data.length > 0) {
      const filtered = data.filter(track => {
        const notInQueue = !state.playQueue.some(q => q.id === track.id);
        const notDupeOfSeed = !isDuplicateTrack(track, seedSong);
        return notInQueue && notDupeOfSeed;
      });

      filtered.forEach(track => {
        state.playQueue.push(track);
      });

      state.currentVibeTracks = filtered;

      // Keep Search tab recommendations UI updated
      const section = document.getElementById('recommendationsSection');
      const grid = document.getElementById('recommendationsGrid');
      const seedText = document.getElementById('recommendationSeedText');
      if (section && grid && seedText) {
        section.style.display = 'block';
        seedText.textContent = `${seedSong.title} - ${seedSong.artist || 'Unknown'}`;
        grid.innerHTML = '';
        filtered.forEach(track => {
          grid.appendChild(createSongCard(track, filtered));
        });
      }
    }
  } catch (err) {
    console.error("Error fetching initial station queue:", err);
  } finally {
    renderQueueUI();
  }
}

async function extendStationQueue(playImmediately = false) {
  if (state.isFetchingMoreQueue) return;
  const seed = state.stationAnchor || state.currentSong;
  if (!seed) return;

  state.isFetchingMoreQueue = true;
  try {
    const excludeIds = (state.playQueue || []).map(s => s.id).filter(Boolean).slice(-50).join(',');
    const url = `/api/recommendations?title=${encodeURIComponent(seed.title)}&artist=${encodeURIComponent(seed.artist || '')}&platform=${seed.platform || 'youtube'}&track_id=${seed.id || ''}&limit=15&exclude_ids=${encodeURIComponent(excludeIds)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Extend queue request failed");
    const data = await res.json();

    if (Array.isArray(data) && data.length > 0) {
      const filtered = data.filter(track => {
        const notInQueue = !state.playQueue.some(q => q.id === track.id);
        const notDupeOfSeed = !isDuplicateTrack(track, seed);
        return notInQueue && notDupeOfSeed;
      });

      if (filtered.length > 0) {
        const insertIndex = state.playQueue.length;
        filtered.forEach(track => {
          state.playQueue.push(track);
        });
        renderQueueUI();

        if (playImmediately) {
          playSong(state.playQueue[insertIndex], insertIndex);
          return;
        }
      } else if (playImmediately) {
        showToast('End of queue');
        state.isPlaying = false;
        updatePlayButtonUI(false);
      }
    } else if (playImmediately) {
      showToast('End of queue');
      state.isPlaying = false;
      updatePlayButtonUI(false);
    }
  } catch (err) {
    console.error("Error extending station queue:", err);
    if (playImmediately) {
      showToast('End of queue');
      state.isPlaying = false;
      updatePlayButtonUI(false);
    }
  } finally {
    state.isFetchingMoreQueue = false;
    renderQueueUI();
  }
}

function renderQueueUI() {
  // 1. Update Now Playing Card in Right Sidebar
  const nowThumbImg = document.getElementById('queueNowThumbImg');
  const nowThumbPlaceholder = document.getElementById('queueNowThumbPlaceholder');
  const nowTitle = document.getElementById('queueNowTitle');
  const nowArtist = document.getElementById('queueNowArtist');
  const nowBars = document.getElementById('queueNowPlayingBars');
  const bannerSeed = document.getElementById('queueStationSeedText');

  if (state.currentSong) {
    if (nowTitle) nowTitle.textContent = state.currentSong.title;
    if (nowArtist) nowArtist.textContent = state.currentSong.artist || 'Unknown Artist';
    if (nowThumbImg && nowThumbPlaceholder) {
      if (state.currentSong.thumbnail) {
        nowThumbImg.src = state.currentSong.thumbnail;
        nowThumbImg.style.display = 'block';
        nowThumbPlaceholder.style.display = 'none';
      } else {
        nowThumbImg.style.display = 'none';
        nowThumbPlaceholder.style.display = 'flex';
      }
    }
    if (nowBars) {
      nowBars.style.display = state.isPlaying ? 'flex' : 'none';
    }
  } else {
    if (nowTitle) nowTitle.textContent = 'No Song Playing';
    if (nowArtist) nowArtist.textContent = 'Select a song to start listening';
    if (nowThumbImg) nowThumbImg.style.display = 'none';
    if (nowThumbPlaceholder) nowThumbPlaceholder.style.display = 'flex';
    if (nowBars) nowBars.style.display = 'none';
  }

  // Update Seed status banner
  if (bannerSeed) {
    if (state.stationAnchor) {
      bannerSeed.textContent = `Station: ${state.stationAnchor.title}`;
      bannerSeed.title = `Continuous vibe locked to: ${state.stationAnchor.title} by ${state.stationAnchor.artist || 'Unknown'}`;
    } else {
      bannerSeed.textContent = 'Continuous Similar Vibe Radio';
    }
  }

  // 2. Update Next Up List
  const queueList = document.getElementById('spotifyQueueList');
  const queueCount = document.getElementById('queueTrackCount');
  if (!queueList) return;

  const upcomingTracks = (state.playQueue || []).slice(state.currentQueueIndex + 1);
  if (queueCount) {
    queueCount.textContent = `${upcomingTracks.length} tracks`;
  }

  if (upcomingTracks.length === 0) {
    queueList.innerHTML = `<div class="spotify-queue-empty">Queue is empty.${state.autoplayEnabled ? ' Similar vibes will play when this track ends.' : ''}</div>`;
    return;
  }

  queueList.innerHTML = '';
  upcomingTracks.forEach((track, offset) => {
    const queueIndex = state.currentQueueIndex + 1 + offset;
    const item = document.createElement('div');
    item.className = 'spotify-queue-item';
    item.title = `Play next: ${track.title} - ${track.artist || ''}`;

    const thumbHtml = track.thumbnail
      ? `<img src="${track.thumbnail}" alt="Cover" loading="lazy">`
      : `<div class="spotify-queue-thumb-placeholder"><svg viewBox="0 0 24 24" fill="currentColor" style="width:16px;height:16px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></div>`;

    item.innerHTML = `
      <div class="queue-item-thumb">
        ${thumbHtml}
        <div class="queue-item-hover-play">
          <svg viewBox="0 0 24 24" fill="currentColor" style="width: 14px; height: 14px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
        </div>
      </div>
      <div class="queue-item-info">
        <div class="queue-item-title">${escapeHtml(track.title)}</div>
        <div class="queue-item-artist">${escapeHtml(track.artist || 'Unknown')}</div>
      </div>
      <div class="queue-item-right">
        <span class="queue-item-duration">${track.duration || '3:00'}</span>
        <button class="queue-item-remove-btn" title="Remove from queue">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.closest('.queue-item-remove-btn')) return;
      playSong(track, queueIndex);
    });

    const removeBtn = item.querySelector('.queue-item-remove-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.playQueue.splice(queueIndex, 1);
        renderQueueUI();
        showToast('Removed from queue');
      });
    }

    queueList.appendChild(item);
  });
}

async function renderRecentUI(forceRefresh = false) {
  const recentList = document.getElementById('spotifyRecentList');
  if (!recentList) return;

  recentList.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 18px 0; font-size: 0.8rem;">Loading recent tracks...</div>';

  try {
    const res = await fetch('/api/history');
    if (!res.ok) throw new Error("Failed to fetch history");
    const history = await res.json();

    if (!Array.isArray(history) || history.length === 0) {
      recentList.innerHTML = '<div class="spotify-queue-empty">No recent listening history yet</div>';
      return;
    }

    const uniqueHistory = [];
    const seen = new Set();
    for (const item of history) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        uniqueHistory.push(item);
      }
      if (uniqueHistory.length >= 30) break;
    }

    recentList.innerHTML = '';
    uniqueHistory.forEach(track => {
      const item = document.createElement('div');
      item.className = 'spotify-queue-item';
      item.title = `Play: ${track.title} - ${track.artist || ''}`;

      const thumbHtml = track.thumbnail
        ? `<img src="${track.thumbnail}" alt="Cover" loading="lazy">`
        : `<div class="spotify-queue-thumb-placeholder"><svg viewBox="0 0 24 24" fill="currentColor" style="width:16px;height:16px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></div>`;

      item.innerHTML = `
        <div class="queue-item-thumb">
          ${thumbHtml}
          <div class="queue-item-hover-play">
            <svg viewBox="0 0 24 24" fill="currentColor" style="width: 14px; height: 14px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          </div>
        </div>
        <div class="queue-item-info">
          <div class="queue-item-title">${escapeHtml(track.title)}</div>
          <div class="queue-item-artist">${escapeHtml(track.artist || 'Unknown')}</div>
        </div>
        <div class="queue-item-right">
          <span class="queue-item-duration">${track.duration || ''}</span>
        </div>
      `;

      item.addEventListener('click', () => {
        state.stationAnchor = track;
        state.isRadioSession = true;
        state.playQueue = [track];
        state.currentQueueIndex = 0;
        playSong(track, 0);
        fetchStationVibesForSong(track, { isInitial: true });
        switchRightSidebarTab('queue');
      });

      recentList.appendChild(item);
    });
  } catch (err) {
    console.error("Error loading recent tracks:", err);
    recentList.innerHTML = '<div class="spotify-queue-empty">Failed to load recent history</div>';
  }
}

function switchRightSidebarTab(tabName) {
  state.activeRightTab = tabName;

  document.querySelectorAll('.queue-nav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  const viewQueue = document.getElementById('viewQueueTab');
  const viewRecent = document.getElementById('viewRecentTab');
  const viewDetails = document.getElementById('viewDetailsTab');

  if (viewQueue) {
    viewQueue.style.display = tabName === 'queue' ? 'block' : 'none';
    viewQueue.classList.toggle('active', tabName === 'queue');
  }
  if (viewRecent) {
    viewRecent.style.display = tabName === 'recent' ? 'block' : 'none';
    viewRecent.classList.toggle('active', tabName === 'recent');
  }
  if (viewDetails) {
    viewDetails.style.display = tabName === 'details' ? 'block' : 'none';
    viewDetails.classList.toggle('active', tabName === 'details');
  }

  const toggleQueueBtn = document.getElementById('btnToggleQueue');
  const toggleSidebarBtn = document.getElementById('btnToggleRightSidebar');
  const container = document.getElementById('appContainer');
  const isOpen = !container.classList.contains('right-sidebar-collapsed');

  if (toggleQueueBtn) {
    toggleQueueBtn.classList.toggle('active', isOpen && tabName === 'queue');
  }
  if (toggleSidebarBtn) {
    toggleSidebarBtn.classList.toggle('active', isOpen && tabName === 'details');
  }

  if (tabName === 'queue') {
    renderQueueUI();
  } else if (tabName === 'recent') {
    renderRecentUI();
  }
}

function toggleQueuePanel() {
  const container = document.getElementById('appContainer');
  const sidebar = document.getElementById('rightSidebar');
  const isMobile = window.innerWidth <= 1024;

  if (isMobile) {
    if (sidebar.classList.contains('mobile-open') && state.activeRightTab === 'queue') {
      sidebar.classList.remove('mobile-open');
    } else {
      sidebar.classList.add('mobile-open');
      switchRightSidebarTab('queue');
    }
    return;
  }

  const isCollapsed = container.classList.contains('right-sidebar-collapsed');
  if (isCollapsed) {
    container.classList.remove('right-sidebar-collapsed');
    localStorage.setItem('rightSidebarCollapsed', 'false');
    switchRightSidebarTab('queue');
  } else if (state.activeRightTab === 'queue') {
    container.classList.add('right-sidebar-collapsed');
    localStorage.setItem('rightSidebarCollapsed', 'true');
    const toggleQueueBtn = document.getElementById('btnToggleQueue');
    if (toggleQueueBtn) toggleQueueBtn.classList.remove('active');
  } else {
    switchRightSidebarTab('queue');
  }
}

function toggleDetailsPanel() {
  const container = document.getElementById('appContainer');
  const sidebar = document.getElementById('rightSidebar');
  const isMobile = window.innerWidth <= 1024;

  if (isMobile) {
    if (sidebar.classList.contains('mobile-open') && state.activeRightTab === 'details') {
      sidebar.classList.remove('mobile-open');
    } else {
      sidebar.classList.add('mobile-open');
      switchRightSidebarTab('details');
    }
    return;
  }

  const isCollapsed = container.classList.contains('right-sidebar-collapsed');
  if (isCollapsed) {
    container.classList.remove('right-sidebar-collapsed');
    localStorage.setItem('rightSidebarCollapsed', 'false');
    switchRightSidebarTab('details');
  } else if (state.activeRightTab === 'details') {
    container.classList.add('right-sidebar-collapsed');
    localStorage.setItem('rightSidebarCollapsed', 'true');
    const toggleSidebarBtn = document.getElementById('btnToggleRightSidebar');
    if (toggleSidebarBtn) toggleSidebarBtn.classList.remove('active');
  } else {
    switchRightSidebarTab('details');
  }
}

function closeRightSidebarPanel() {
  const container = document.getElementById('appContainer');
  const sidebar = document.getElementById('rightSidebar');
  sidebar.classList.remove('mobile-open');
  container.classList.add('right-sidebar-collapsed');
  localStorage.setItem('rightSidebarCollapsed', 'true');

  const toggleQueueBtn = document.getElementById('btnToggleQueue');
  const toggleSidebarBtn = document.getElementById('btnToggleRightSidebar');
  if (toggleQueueBtn) toggleQueueBtn.classList.remove('active');
  if (toggleSidebarBtn) toggleSidebarBtn.classList.remove('active');
}

// --- ALBUM & ARTIST RENDERING LOGIC ---
function renderAlbumsSearchResults(albums) {
  const grid = document.getElementById('searchAlbumsGrid');
  grid.innerHTML = '';
  
  if (!albums || albums.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column: 1/-1;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><path d="M8 12h8"></path></svg>
        <h3>No albums found</h3>
        <p>Try searching for a different title or adjusting your platforms.</p>
      </div>
    `;
    return;
  }
  
  albums.forEach(album => {
    const card = document.createElement('div');
    card.className = 'song-card clickable-album';
    card.addEventListener('click', () => {
      openAlbumDetails(album.id, album.platform);
    });
    
    const imgWrapper = document.createElement('div');
    imgWrapper.className = 'song-card-img-wrapper';
    
    const img = document.createElement('img');
    img.src = album.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=200&auto=format&fit=crop';
    img.loading = 'lazy';
    
    imgWrapper.appendChild(img);
    
    const info = document.createElement('div');
    info.className = 'song-card-info';
    
    const title = document.createElement('div');
    title.className = 'song-card-title';
    title.textContent = album.title;
    title.title = album.title;
    
    const artist = document.createElement('div');
    artist.className = 'song-card-artist';
    artist.textContent = album.artist || 'Unknown Artist';
    
    info.appendChild(title);
    info.appendChild(artist);
    
    const footer = document.createElement('div');
    footer.className = 'song-card-footer';
    
    const badge = document.createElement('span');
    badge.className = `song-card-badge badge-${album.platform}`;
    badge.textContent = album.platform + (album.isFallback ? ' (fallback)' : '');
    
    const yearSpan = document.createElement('span');
    yearSpan.style.fontSize = '0.8rem';
    yearSpan.style.color = 'var(--text-secondary)';
    yearSpan.textContent = album.year || '';
    
    footer.appendChild(badge);
    footer.appendChild(yearSpan);
    
    card.appendChild(imgWrapper);
    card.appendChild(info);
    card.appendChild(footer);
    
    grid.appendChild(card);
  });
}

function renderArtistsSearchResults(artists) {
  const grid = document.getElementById('searchArtistsGrid');
  grid.innerHTML = '';
  
  if (!artists || artists.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column: 1/-1;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><path d="M8 12h8"></path></svg>
        <h3>No artists found</h3>
        <p>Try searching for a different artist name.</p>
      </div>
    `;
    return;
  }
  
  artists.forEach(artist => {
    const card = document.createElement('div');
    card.className = 'song-card';
    card.style.textAlign = 'center';
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => {
      openArtistProfile(artist.title, artist.platform, artist.id);
    });
    
    const imgWrapper = document.createElement('div');
    imgWrapper.className = 'song-card-img-wrapper';
    imgWrapper.style.borderRadius = '50%';
    imgWrapper.style.width = '120px';
    imgWrapper.style.height = '120px';
    imgWrapper.style.margin = '16px auto';
    imgWrapper.style.overflow = 'hidden';
    imgWrapper.style.border = '2px solid var(--accent-color)';
    imgWrapper.style.aspectRatio = '1';
    
    const img = document.createElement('img');
    img.src = artist.thumbnail || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?q=80&w=200&auto=format&fit=crop';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'cover';
    img.loading = 'lazy';
    
    imgWrapper.appendChild(img);
    
    const info = document.createElement('div');
    info.className = 'song-card-info';
    info.style.paddingBottom = '8px';
    
    const title = document.createElement('div');
    title.className = 'song-card-title';
    title.style.textAlign = 'center';
    title.style.fontSize = '1rem';
    title.style.fontWeight = '600';
    title.textContent = artist.title;
    title.title = artist.title;
    
    info.appendChild(title);
    
    const footer = document.createElement('div');
    footer.className = 'song-card-footer';
    footer.style.justifyContent = 'center';
    
    const badge = document.createElement('span');
    badge.className = `song-card-badge badge-${artist.platform}`;
    badge.textContent = artist.platform;
    
    footer.appendChild(badge);
    
    card.appendChild(imgWrapper);
    card.appendChild(info);
    card.appendChild(footer);
    
    grid.appendChild(card);
  });
}

// --- ALBUM RESOLUTION HELPER ---
async function goToAlbumOfSong(song) {
  if (!song) return;
  const albumId = song.albumId;
  const platform = song.platform || 'youtube';

  if (albumId) {
    openAlbumDetails(albumId, platform);
    return;
  }

  // Fallback: search for the track to retrieve its metadata (including albumId)
  showToast("Finding album...");
  try {
    const q = `${song.title} ${song.artist || ''}`;
    const response = await fetch(`/api/search?q=${encodeURIComponent(q)}&platform=${platform}&type=all`);
    if (response.ok) {
      const data = await response.json();
      
      // 1. Look in the tracks search results first
      const tracks = data.tracks || [];
      const matchingTrack = tracks.find(t => 
        t.title.toLowerCase().includes(song.title.toLowerCase()) || 
        song.title.toLowerCase().includes(t.title.toLowerCase())
      ) || tracks[0];
      
      if (matchingTrack && matchingTrack.albumId) {
        openAlbumDetails(matchingTrack.albumId, matchingTrack.platform || platform);
        return;
      }
      
      // 2. Fallback to albums matches, checking that the artist matches to avoid random albums
      const albums = data.albums || [];
      if (albums.length > 0) {
        const artistMatch = albums.find(al => {
          if (!song.artist) return true;
          return al.artist.toLowerCase().includes(song.artist.toLowerCase()) || 
                 song.artist.toLowerCase().includes(al.artist.toLowerCase());
        });
        const finalAlbum = artistMatch || albums[0];
        openAlbumDetails(finalAlbum.id, finalAlbum.platform || platform);
        return;
      }
      
      showToast("No album found for this track");
    } else {
      showToast("Could not find album");
    }
  } catch (err) {
    console.error("Failed to find album for song:", err);
    showToast("Error searching for album");
  }
}

// --- ALBUM DETAILS PAGE ---
async function openAlbumDetails(albumId, platform) {
  switchTab('album-detail');
  
  const container = document.getElementById('albumSongsContainer');
  container.innerHTML = `
    <div class="loader" style="display: flex; margin-top: 40px;">
      <div class="spinner"></div>
      <p>Loading album tracks...</p>
    </div>
  `;
  
  document.getElementById('detailAlbumName').textContent = 'Loading...';
  document.getElementById('detailAlbumStats').textContent = '';
  document.getElementById('detailAlbumImgContent').innerHTML = '<div class="spinner"></div>';
  
  try {
    const response = await fetch(`/api/album?id=${albumId}&platform=${platform}`);
    if (response.ok) {
      const album = await response.json();
      
      if (album.error) {
        showToast(album.error);
        container.innerHTML = `<div class="empty-state"><h3>Failed to load</h3><p>${album.error}</p></div>`;
        return;
      }
      
      document.getElementById('detailAlbumName').textContent = album.title;
      document.getElementById('detailAlbumPlatform').textContent = `${platform.charAt(0).toUpperCase() + platform.slice(1)} Album`;
      document.getElementById('detailAlbumPlatform').className = `badge badge-${platform}`;
      document.getElementById('detailAlbumStats').textContent = `${album.artist} • ${album.year || 'Unknown Year'} • ${album.tracks.length} songs`;
      
      if (album.thumbnail) {
        document.getElementById('detailAlbumImgContent').innerHTML = `<img src="${album.thumbnail}" alt="Cover" style="width:100%; height:100%; object-fit:cover;">`;
      } else {
        document.getElementById('detailAlbumImgContent').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 48px; height: 48px;"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
      }
      
      // Store current album tracks so we can play all or add all
      state.tempAlbumTracks = album.tracks;
      
      // Render Tracks List
      container.innerHTML = '';
      album.tracks.forEach((song, idx) => {
        const row = document.createElement('div');
        row.className = 'song-row';
        if (state.currentSong && state.currentSong.id === song.id) {
          row.classList.add('active');
        }
        
        row.addEventListener('click', () => {
          state.currentPlaylistId = null;
          state.playQueue = album.tracks.map(s => ({ ...s }));
          state.stationAnchor = album.tracks[album.tracks.length - 1] || song;
          state.isRadioSession = false;
          playSong(song, idx);
        });
        
        const colNum = document.createElement('div');
        colNum.className = 'col-num';
        colNum.textContent = idx + 1;
        
        const colTitle = document.createElement('div');
        colTitle.className = 'col-title';
        colTitle.innerHTML = `
          <div class="song-col-text">
            <div class="song-col-title" title="${song.title}">${song.title}</div>
            <div class="song-col-artist clickable-artist">${song.artist || 'Unknown'}</div>
          </div>
        `;
        
        const colArtist = document.createElement('div');
        colArtist.className = 'col-artist';
        const artistSpan = document.createElement('span');
        artistSpan.className = 'clickable-artist';
        artistSpan.textContent = song.artist || 'Unknown';
        artistSpan.addEventListener('click', (e) => {
          e.stopPropagation();
          openArtistProfile(song.artist, platform, song.artistId || song.artist_id);
        });
        colArtist.appendChild(artistSpan);
        
        const colDuration = document.createElement('div');
        colDuration.className = 'col-duration';
        colDuration.textContent = song.duration || '3:00';
        
        const colActions = document.createElement('div');
        colActions.className = 'col-actions';
        
        const addBtn = document.createElement('button');
        addBtn.className = 'icon-btn';
        addBtn.title = 'Add to Playlist';
        addBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openPlaylistSelectModal(song);
        });
        
        colActions.appendChild(addBtn);
        
        row.appendChild(colNum);
        row.appendChild(colTitle);
        row.appendChild(colArtist);
        row.appendChild(colDuration);
        row.appendChild(colActions);
        
        container.appendChild(row);
      });
    } else {
      throw new Error('Server returned error response');
    }
  } catch (err) {
    console.error(err);
    container.innerHTML = `<div class="empty-state"><h3>Failed to load</h3><p>Could not fetch album details. Please check your connection.</p></div>`;
  }
}

// Play all tracks from currently loaded album
document.getElementById('btnPlayAlbum').addEventListener('click', () => {
  if (state.tempAlbumTracks && state.tempAlbumTracks.length > 0) {
    state.currentPlaylistId = null;
    playSongList(state.tempAlbumTracks, 0);
  }
});

// Add all tracks from currently loaded album to a playlist
document.getElementById('btnAddAlbumToPlaylist').addEventListener('click', () => {
  if (state.tempAlbumTracks && state.tempAlbumTracks.length > 0) {
    state.tempModalAddSongs = state.tempAlbumTracks;
    openPlaylistSelectModal(null);
  }
});

// --- ARTIST PROFILE PAGE ---
async function openArtistProfile(artistName, platform, artistId) {
  if (!artistName) return;
  switchTab('artist-profile');
  
  // Store artist query parameters for platform switching
  state.tempArtist = { name: artistName, platform: platform, id: artistId };
  
  // Set active platform toggle chip in UI
  document.querySelectorAll('[data-artist-platform]').forEach(chip => {
    chip.classList.toggle('active', chip.getAttribute('data-artist-platform') === platform);
  });
  
  await fetchArtistProfileDetails(artistName, platform, artistId);
}

async function fetchArtistProfileDetails(artistName, platform, artistId) {
  const tracksGrid = document.getElementById('artistTracksGrid');
  const albumsGrid = document.getElementById('artistAlbumsGrid');
  
  tracksGrid.innerHTML = `<div class="loader" style="grid-column: 1/-1; display: flex; margin-top: 20px;"><div class="spinner"></div><p>Fetching popular tracks...</p></div>`;
  albumsGrid.innerHTML = `<div class="loader" style="grid-column: 1/-1; display: flex; margin-top: 20px;"><div class="spinner"></div><p>Fetching albums...</p></div>`;
  
  document.getElementById('detailArtistName').textContent = artistName;
  document.getElementById('detailArtistStats').textContent = 'Loading profile details...';
  document.getElementById('detailArtistDesc').textContent = '';
  document.getElementById('detailArtistAvatarContent').innerHTML = '<div class="spinner"></div>';
  
  // SoundCloud does not have albums, so hide section header and grid
  const albumsHeader = document.getElementById('artistAlbumsHeader');
  if (platform === 'soundcloud') {
    albumsHeader.style.display = 'none';
    albumsGrid.style.display = 'none';
  } else {
    albumsHeader.style.display = 'block';
    albumsGrid.style.display = 'grid';
  }
  
  try {
    const response = await fetch(`/api/artist?name=${encodeURIComponent(artistName)}&platform=${platform}&id=${artistId || ''}`);
    if (response.ok) {
      const artist = await response.json();
      
      document.getElementById('detailArtistName').textContent = artist.name || artistName;
      document.getElementById('detailArtistStats').textContent = artist.followers || 'Artist Profile';
      document.getElementById('detailArtistDesc').textContent = artist.description || '';
      
      if (artist.thumbnail) {
        document.getElementById('detailArtistAvatarContent').innerHTML = `<img src="${artist.thumbnail}" alt="Artist" class="artist-avatar-img">`;
      } else {
        document.getElementById('detailArtistAvatarContent').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 64px; height: 64px; color: var(--text-secondary);"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;
      }
      
      // Render popular tracks
      tracksGrid.innerHTML = '';
      if (!artist.tracks || artist.tracks.length === 0) {
        tracksGrid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><h3>No songs found</h3></div>`;
      } else {
        artist.tracks.forEach((song, idx) => {
          const card = createSongCard(song, artist.tracks);
          tracksGrid.appendChild(card);
        });
      }
      
      // Render albums (for Spotify/YouTube Music)
      if (platform !== 'soundcloud') {
        albumsGrid.innerHTML = '';
        if (!artist.albums || artist.albums.length === 0) {
          albumsGrid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><h3>No albums found</h3></div>`;
        } else {
          artist.albums.forEach(album => {
            const card = document.createElement('div');
            card.className = 'song-card clickable-album';
            card.addEventListener('click', () => {
              openAlbumDetails(album.id, album.platform);
            });
            
            const imgWrapper = document.createElement('div');
            imgWrapper.className = 'song-card-img-wrapper';
            
            const img = document.createElement('img');
            img.src = album.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=200&auto=format&fit=crop';
            img.loading = 'lazy';
            
            imgWrapper.appendChild(img);
            
            const info = document.createElement('div');
            info.className = 'song-card-info';
            
            const title = document.createElement('div');
            title.className = 'song-card-title';
            title.textContent = album.title;
            
            const artistNameDiv = document.createElement('div');
            artistNameDiv.className = 'song-card-artist';
            artistNameDiv.textContent = album.artist || artist.name;
            
            info.appendChild(title);
            info.appendChild(artistNameDiv);
            
            const footer = document.createElement('div');
            footer.className = 'song-card-footer';
            
            const badge = document.createElement('span');
            badge.className = `song-card-badge badge-${album.platform}`;
            badge.textContent = album.platform;
            
            const yearSpan = document.createElement('span');
            yearSpan.style.fontSize = '0.8rem';
            yearSpan.style.color = 'var(--text-secondary)';
            yearSpan.textContent = album.year || '';
            
            footer.appendChild(badge);
            footer.appendChild(yearSpan);
            
            card.appendChild(imgWrapper);
            card.appendChild(info);
            card.appendChild(footer);
            
            albumsGrid.appendChild(card);
          });
        }
      }
    }
  } catch (err) {
    console.error(err);
    tracksGrid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><h3>Error fetching popular tracks</h3></div>`;
    if (platform !== 'soundcloud') {
      albumsGrid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><h3>Error fetching albums</h3></div>`;
    }
  }
}

// --- LISTEN HISTORY LOGGING ---
function logPlayHistory(song) {
  if (!song || !song.id) return;
  fetch('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(song)
  })
  .catch(err => console.error("Failed to log play history:", err));
}

// --- RIGHT-SIDE PANEL SYNCHRONIZATION ---
async function updateRightSidebar(song) {
  if (!song) {
    document.getElementById('rightNowPlayingSection').style.display = 'none';
    document.getElementById('aboutArtistSection').style.display = 'none';
    return;
  }

  // 1. Show Now Playing Details
  document.getElementById('rightNowPlayingSection').style.display = 'block';
  document.getElementById('rightSongTitleText').textContent = song.title;
  document.getElementById('rightSongArtistText').textContent = song.artist || 'Unknown Artist';
  if (song.thumbnail) {
    document.getElementById('rightAlbumArtImg').src = song.thumbnail;
    document.getElementById('rightAlbumArtImg').style.display = 'block';
  } else {
    document.getElementById('rightAlbumArtImg').style.display = 'none';
  }

  // 2. Fetch Artist Details for About the Artist Section
  const artistSec = document.getElementById('aboutArtistSection');
  const mobileArtistSec = document.getElementById('mobileNpArtistSection');
  if (song.artist) {
    artistSec.style.display = 'block';
    if (mobileArtistSec) mobileArtistSec.style.display = 'block';

    document.getElementById('aboutArtistNameText').textContent = song.artist;
    document.getElementById('aboutArtistFollowersText').textContent = 'Fetching profile...';
    document.getElementById('aboutArtistAvatarImg').src = '';

    const mobileArtistName = document.getElementById('mobileNpArtistNameText');
    if (mobileArtistName) mobileArtistName.textContent = song.artist;
    const mobileFollowers = document.getElementById('mobileNpArtistFollowersText');
    if (mobileFollowers) mobileFollowers.textContent = 'Fetching profile...';
    const mobileAvatar = document.getElementById('mobileNpArtistAvatarImg');
    if (mobileAvatar) mobileAvatar.src = '';
    
    // Set follow button to initial state
    const followBtn = document.getElementById('btnFollowArtist');
    const mobileFollowBtn = document.getElementById('btnMobileNpFollowArtist');
    if (followBtn) {
      followBtn.textContent = 'Follow';
      followBtn.style.background = 'transparent';
      followBtn.style.color = 'var(--text-color)';
      
      followBtn.onclick = (e) => {
        e.stopPropagation();
        if (followBtn.textContent === 'Follow') {
          followBtn.textContent = 'Following';
          followBtn.style.background = 'var(--accent-color)';
          followBtn.style.color = '#fff';
          if (mobileFollowBtn) {
            mobileFollowBtn.textContent = 'Following';
            mobileFollowBtn.style.background = 'var(--accent-color)';
            mobileFollowBtn.style.color = '#fff';
          }
          showToast(`Following ${song.artist || 'Artist'}`);
        } else {
          followBtn.textContent = 'Follow';
          followBtn.style.background = 'transparent';
          followBtn.style.color = 'var(--text-color)';
          if (mobileFollowBtn) {
            mobileFollowBtn.textContent = 'Follow';
            mobileFollowBtn.style.background = 'transparent';
            mobileFollowBtn.style.color = 'var(--text-color)';
          }
        }
      };
    }

    try {
      const artistRes = await fetch(`/api/artist?name=${encodeURIComponent(song.artist)}&platform=${song.platform || 'youtube'}`);
      if (artistRes.ok) {
        const artist = await artistRes.json();
        const followersText = artist.followers || 'Artist Profile';
        document.getElementById('aboutArtistFollowersText').textContent = followersText;
        if (mobileFollowers) mobileFollowers.textContent = followersText;
        
        // Show verified badge for Spotify platform
        const badge = document.getElementById('artistVerifiedBadge');
        const mobileBadge = document.getElementById('mobileNpArtistVerifiedBadge');
        const showBadge = (artist.platform === 'spotify' || song.platform === 'spotify');
        if (badge) badge.style.display = showBadge ? 'inline-block' : 'none';
        if (mobileBadge) mobileBadge.style.display = showBadge ? 'inline-block' : 'none';

        if (artist.thumbnail) {
          document.getElementById('aboutArtistAvatarImg').src = artist.thumbnail;
          document.getElementById('aboutArtistAvatarImg').style.display = 'block';
          if (mobileAvatar) {
            mobileAvatar.src = artist.thumbnail;
            mobileAvatar.style.display = 'block';
          }
        } else {
          document.getElementById('aboutArtistAvatarImg').style.display = 'none';
          if (mobileAvatar) mobileAvatar.style.display = 'none';
        }
      } else {
        document.getElementById('aboutArtistFollowersText').textContent = 'Artist Profile';
        if (mobileFollowers) mobileFollowers.textContent = 'Artist Profile';
      }
    } catch (err) {
      console.error("Error loading sidebar artist details:", err);
    }
  } else {
    artistSec.style.display = 'none';
    if (mobileArtistSec) mobileArtistSec.style.display = 'none';
  }
}

// --- HOME DASHBOARD LOAD & RENDER ---
async function loadHomeDashboard() {
  const hours = new Date().getHours();
  let greeting = "Good evening";
  if (hours < 12) greeting = "Good morning";
  else if (hours < 18) greeting = "Good afternoon";
  document.getElementById('homeGreetingText').textContent = greeting;

  const quickGrid = document.getElementById('quickRecentsGrid');
  const madeGrid = document.getElementById('madeForYouGrid');
  const recGrid = document.getElementById('recommendedTodayGrid');

  quickGrid.innerHTML = '<div class="spinner" style="grid-column:1/-1; margin:20px auto;"></div>';
  madeGrid.innerHTML = '<div class="spinner" style="grid-column:1/-1; margin:20px auto;"></div>';
  recGrid.innerHTML = '<div class="spinner" style="grid-column:1/-1; margin:20px auto;"></div>';

  // 1. Fetch Most Listened This Week (Recency-Weighted Momentum)
  try {
    let weeklyTracks = [];
    try {
      const weekRes = await fetch('/api/most-listened-week');
      if (weekRes.ok) {
        weeklyTracks = await weekRes.json();
      }
    } catch (e) {
      console.warn("Could not fetch weekly momentum, falling back to history:", e);
    }

    // Fallback to recent history if no weekly plays are logged yet
    if (!weeklyTracks || weeklyTracks.length === 0) {
      const histRes = await fetch('/api/history');
      if (histRes.ok) {
        const history = await histRes.json();
        const seen = new Set();
        for (const item of (history || [])) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            weeklyTracks.push(item);
          }
          if (weeklyTracks.length === 8) break;
        }
      }
    }

    quickGrid.innerHTML = '';
    
    if (weeklyTracks && weeklyTracks.length > 0) {
      weeklyTracks.forEach(song => {
        const card = document.createElement('div');
        card.className = 'quick-recent-card';
        card.innerHTML = `
          <img src="${song.thumbnail || DEFAULT_ALBUM_ART}" class="quick-recent-art" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src=DEFAULT_ALBUM_ART;">
          <div class="quick-recent-info">
            <div class="quick-recent-title">${song.title}</div>
            <div class="quick-recent-subtitle">${song.artist || 'Unknown'}</div>
          </div>
          <div class="quick-recent-play-btn">
            <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          </div>
        `;
        card.addEventListener('click', () => {
          state.currentPlaylistId = null;
          state.stationAnchor = song;
          state.isRadioSession = true;
          state.playQueue = [{ ...song }];
          state.currentQueueIndex = 0;
          playSong(song, 0);
          fetchStationVibesForSong(song, { isInitial: true });
        });
        quickGrid.appendChild(card);
      });
    } else {
      quickGrid.innerHTML = `
        <div class="empty-state" style="grid-column: 1/-1; text-align: center; padding: 20px;">
          <p>Your weekly leaderboard will appear here. Start playing songs!</p>
        </div>
      `;
    }
  } catch (e) {
    console.error("Failed to load weekly momentum:", e);
    quickGrid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">Could not load weekly tracks.</div>';
  }

  // 2. Fetch Made For You Mixes
  try {
    const res = await fetch('/api/mixes');
    if (res.ok) {
      const mixes = await res.json();
      madeGrid.innerHTML = '';
      if (mixes && mixes.length > 0) {
        mixes.forEach(mix => {
          const card = document.createElement('div');
          card.className = 'home-card';
          card.innerHTML = `
            <div class="home-card-art-wrapper">
              <img src="${mix.thumbnail || DEFAULT_ALBUM_ART}" class="home-card-art" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src=DEFAULT_ALBUM_ART;">
              <div class="home-card-play-btn" title="Play Vibe Mix">
                <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              </div>
            </div>
            <div class="home-card-title">${mix.name}</div>
            <div class="home-card-desc">${mix.description}</div>
          `;
          card.addEventListener('click', () => {
            if (mix.tracks && mix.tracks.length > 0) {
              state.currentPlaylistId = null;
              playSongList(mix.tracks, 0);
            } else {
              showToast('Fetching mix tracks...');
            }
          });
          madeGrid.appendChild(card);
        });
      }
    }
  } catch (e) {
    console.error("Failed to load mixes:", e);
    madeGrid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">Error loading mixes</div>';
  }

  // 3. Fetch Recommendations
  try {
    const res = await fetch('/api/dashboard-recommendations');
    if (res.ok) {
      const tracks = await res.json();
      recGrid.innerHTML = '';
      if (tracks && tracks.length > 0) {
        tracks.slice(0, 10).forEach(song => {
          const card = document.createElement('div');
          card.className = 'home-card';
          card.innerHTML = `
            <div class="home-card-art-wrapper">
              <img src="${song.thumbnail || DEFAULT_ALBUM_ART}" class="home-card-art" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src=DEFAULT_ALBUM_ART;">
              <div class="home-card-play-btn">
                <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              </div>
            </div>
            <div class="home-card-title">${song.title}</div>
            <div class="home-card-desc">${song.artist}</div>
          `;
          card.addEventListener('click', () => {
            state.currentPlaylistId = null;
            state.stationAnchor = song;
            state.isRadioSession = true;
            state.playQueue = [{ ...song }];
            state.currentQueueIndex = 0;
            playSong(song, 0);
            fetchStationVibesForSong(song, { isInitial: true });
          });
          recGrid.appendChild(card);
        });
      } else {
        recGrid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">No recommendations available</div>';
      }
    }
  } catch (e) {
    console.error("Failed to load recommendations:", e);
    recGrid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">Error loading recommendations</div>';
  }
}

// ========================================================
// OFFLINE ENGINE, STORAGE METER & SMART STREAM CACHE
// ========================================================

async function initOfflineEngine() {
  setupOfflineEventListeners();
  try {
    const res = await fetch('/api/offline/tracks');
    if (res.ok) {
      const data = await res.json();
      const tracks = data.tracks || [];
      state.offlineTracks = tracks;
      state.downloadedTrackIds = new Set(tracks.map(t => t.id));

      if (data.settings) {
        state.smartCacheEnabled = !!data.settings.smartCacheEnabled;
        state.smartCacheLimit = data.settings.smartCacheLimit || 200;
        const toggle = document.getElementById('toggleSmartCache');
        if (toggle) toggle.checked = state.smartCacheEnabled;
      }

      updateStorageMeterUI(data.stats);
      updateOfflineUIBadges();
    }
  } catch (e) {
    console.warn("Could not load offline tracks on startup:", e);
  }

  // Check if first-run modal should be shown
  checkSmartCacheFirstRunPrompt();
}

function updateOfflineVisibility(enabled) {
  if (typeof enabled !== 'boolean') {
    enabled = localStorage.getItem('offline_music_enabled') !== 'false';
  }
  const pinnedItem = document.getElementById('btnOpenDownloadedPlaylist');
  if (pinnedItem) {
    pinnedItem.style.display = enabled ? 'flex' : 'none';
  }

  const offlineBody = document.getElementById('offlineCardBody');
  if (offlineBody) {
    offlineBody.style.opacity = enabled ? '1' : '0.45';
    offlineBody.style.pointerEvents = enabled ? 'auto' : 'none';
  }

  // If user was viewing Downloaded Music playlist and disables the feature, switch away
  if (!enabled && state.currentPlaylistId === 'system_downloaded') {
    if (state.playlists && state.playlists.length > 0) {
      selectPlaylist(state.playlists[0].id);
    } else {
      showTab('home');
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => updateOfflineVisibility());
} else {
  updateOfflineVisibility();
}

let offlineListenersAttached = false;
function setupOfflineEventListeners() {
  if (offlineListenersAttached) return;
  offlineListenersAttached = true;

  // Master switch: Enable/Disable Offline Music & Storage
  const toggleOffline = document.getElementById('toggleOfflineMusicEnabled');
  if (toggleOffline) {
    const isOfflineEnabled = localStorage.getItem('offline_music_enabled') !== 'false';
    toggleOffline.checked = isOfflineEnabled;
    updateOfflineVisibility(isOfflineEnabled);

    toggleOffline.addEventListener('change', () => {
      const enabled = toggleOffline.checked;
      localStorage.setItem('offline_music_enabled', enabled ? 'true' : 'false');
      updateOfflineVisibility(enabled);
      showToast(enabled ? 'Offline Music & Storage enabled' : 'Offline Music & Storage disabled');
    });
  } else {
    updateOfflineVisibility();
  }

  // Pinned sidebar item: Downloaded Music
  const btnOpenDownloaded = document.getElementById('btnOpenDownloadedPlaylist');
  if (btnOpenDownloaded) {
    btnOpenDownloaded.addEventListener('click', () => {
      openDownloadedMusicPlaylist();
    });
  }

  // Download Playlist button
  const btnDownloadPlaylist = document.getElementById('btnDownloadPlaylist');
  if (btnDownloadPlaylist) {
    btnDownloadPlaylist.addEventListener('click', () => {
      downloadCurrentPlaylist();
    });
  }

  // Cancel Playlist Download buttons (detail view and profile view)
  const btnCancelDownloadPlaylist = document.getElementById('btnCancelDownloadPlaylist');
  if (btnCancelDownloadPlaylist) {
    btnCancelDownloadPlaylist.addEventListener('click', () => {
      cancelCurrentPlaylistDownload();
    });
  }

  const btnProfileCancelDownload = document.getElementById('btnProfileCancelDownload');
  if (btnProfileCancelDownload) {
    btnProfileCancelDownload.addEventListener('click', () => {
      cancelCurrentPlaylistDownload();
    });
  }

  // Smart Stream Cache toggle in Profile
  const toggleSmartCache = document.getElementById('toggleSmartCache');
  if (toggleSmartCache) {
    toggleSmartCache.addEventListener('change', async () => {
      state.smartCacheEnabled = toggleSmartCache.checked;
      try {
        await fetch('/api/offline/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ smartCacheEnabled: toggleSmartCache.checked, smartCacheLimit: state.smartCacheLimit || 200 })
        });
        showToast(toggleSmartCache.checked ? 'Smart Stream Cache enabled' : 'Smart Stream Cache disabled');
      } catch (e) {
        showToast('Failed to update settings');
      }
    });
  }

  // Clear Stream Cache button
  const btnClearStreamCache = document.getElementById('btnClearStreamCache');
  if (btnClearStreamCache) {
    btnClearStreamCache.addEventListener('click', async () => {
      const confirmed = await showConfirmModal(
        'Clear Stream Cache?',
        'This will remove all automatically cached streamed songs. Playlist downloads will NOT be removed.'
      );
      if (confirmed) {
        try {
          const res = await fetch('/api/offline/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'cache' })
          });
          const result = await res.json();
          showToast(`Cache cleared (${result.deletedCount || 0} songs removed)`);
          await refreshOfflineStatsSilently();
          updateOfflineUIBadges();
          if (state.currentPlaylistId === 'system_downloaded') {
            openDownloadedMusicPlaylist();
          }
        } catch (e) {
          showToast('Failed to clear stream cache');
        }
      }
    });
  }

  // Remove All Downloads button
  const btnClearAllDownloads = document.getElementById('btnClearAllDownloads');
  if (btnClearAllDownloads) {
    btnClearAllDownloads.addEventListener('click', async () => {
      const confirmed = await showConfirmModal(
        'Remove All Downloads?',
        'This will delete ALL downloaded music and stream cache from this device. Are you sure?'
      );
      if (confirmed) {
        try {
          const res = await fetch('/api/offline/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'all' })
          });
          const result = await res.json();
          state.downloadedTrackIds.clear();
          const btn = document.getElementById('btnDownloadPlaylist');
          const btnText = document.getElementById('btnDownloadPlaylistText');
          if (btn) btn.classList.remove('is-downloaded');
          if (btnText) btnText.textContent = "Download Playlist";
          updateOfflineUIBadges();
          await refreshOfflineStatsSilently();
          showToast(`All downloads removed (${result.deletedCount || 0} songs deleted)`);
          if (state.currentPlaylistId === 'system_downloaded') {
            openDownloadedMusicPlaylist();
          }
        } catch (e) {
          showToast('Failed to remove downloads');
        }
      }
    });
  }

  // First-run welcome modal actions
  const btnEnableModal = document.getElementById('btnSmartCacheEnable');
  if (btnEnableModal) {
    btnEnableModal.addEventListener('click', async () => {
      localStorage.setItem('aether_smart_cache_prompted', 'true');
      const modal = document.getElementById('smartCacheFirstRunModal');
      if (modal) modal.style.display = 'none';

      state.smartCacheEnabled = true;
      const toggle = document.getElementById('toggleSmartCache');
      if (toggle) toggle.checked = true;

      try {
        await fetch('/api/offline/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ smartCacheEnabled: true, smartCacheLimit: 200 })
        });
        showToast('Smart Stream Cache enabled! Songs will auto-save as you listen.');
      } catch (e) {
        console.warn('Failed to update smart cache settings:', e);
      }
    });
  }

  const btnKeepDisabledModal = document.getElementById('btnSmartCacheKeepDisabled');
  if (btnKeepDisabledModal) {
    btnKeepDisabledModal.addEventListener('click', () => {
      localStorage.setItem('aether_smart_cache_prompted', 'true');
      const modal = document.getElementById('smartCacheFirstRunModal');
      if (modal) modal.style.display = 'none';
    });
  }
}

function checkSmartCacheFirstRunPrompt() {
  const prompted = localStorage.getItem('aether_smart_cache_prompted');
  if (!prompted) {
    const modal = document.getElementById('smartCacheFirstRunModal');
    if (modal) {
      modal.style.display = 'flex';
    }
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return (mb / 1024).toFixed(2) + ' GB';
  }
  return mb.toFixed(1) + ' MB';
}

function updateStorageMeterUI(stats) {
  if (!stats) return;
  state.offlineStats = stats;

  const badge = document.getElementById('offlineStorageBadge');
  const barPerm = document.getElementById('storageBarPerm');
  const barCache = document.getElementById('storageBarCache');
  const permLabel = document.getElementById('storagePermLabel');
  const cacheLabel = document.getElementById('storageCacheLabel');
  const sidebarBadge = document.getElementById('downloadedSidebarBadge');

  const totalBytes = stats.totalBytes || 0;
  const permBytes = stats.permanentBytes || 0;
  const cacheBytes = stats.cacheBytes || 0;
  const permCount = stats.permanentCount || 0;
  const cacheCount = stats.cacheCount || 0;
  const totalCount = stats.totalCount || 0;
  const cacheLimit = (stats.settings && stats.settings.smartCacheLimit) || 200;

  if (badge) badge.textContent = formatBytes(totalBytes);
  if (sidebarBadge) sidebarBadge.textContent = `${totalCount} ${totalCount === 1 ? 'song' : 'songs'}`;

  const scaleBase = Math.max(totalBytes, 300 * 1024 * 1024);
  const permPct = Math.min(100, (permBytes / scaleBase) * 100);
  const cachePct = Math.min(100, (cacheBytes / scaleBase) * 100);

  if (barPerm) barPerm.style.width = `${permPct}%`;
  if (barCache) barCache.style.width = `${cachePct}%`;

  if (permLabel) {
    permLabel.textContent = `${formatBytes(permBytes)} (${permCount} ${permCount === 1 ? 'song' : 'songs'})`;
  }
  if (cacheLabel) {
    cacheLabel.textContent = `${formatBytes(cacheBytes)} (${cacheCount} / ${cacheLimit} songs)`;
  }
}

async function refreshOfflineStatsSilently() {
  try {
    const res = await fetch('/api/offline/tracks');
    if (res.ok) {
      const data = await res.json();
      const tracks = data.tracks || [];
      state.offlineTracks = tracks;
      state.downloadedTrackIds = new Set(tracks.map(t => t.id));
      updateStorageMeterUI(data.stats);
      updateOfflineUIBadges();
    }
  } catch (e) {
    console.warn("Could not refresh offline stats:", e);
  }
}

function updateOfflineUIBadges() {
  const downloadBtn = document.getElementById('btnDownloadPlaylist');
  const downloadBtnText = document.getElementById('btnDownloadPlaylistText');
  if (downloadBtn && downloadBtnText && state.currentPlaylistId && state.currentPlaylistId !== 'system_downloaded') {
    const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
    if (pl && pl.songs && pl.songs.length > 0) {
      const allDownloaded = pl.songs.every(s => state.downloadedTrackIds.has(s.id));
      if (allDownloaded) {
        downloadBtn.classList.add('is-downloaded');
        if (!state.isDownloadingPlaylist) {
          downloadBtnText.textContent = "Downloaded";
        }
      } else {
        downloadBtn.classList.remove('is-downloaded');
        if (!state.isDownloadingPlaylist) {
          downloadBtnText.textContent = "Download Playlist";
        }
      }
    } else {
      downloadBtn.classList.remove('is-downloaded');
      if (!state.isDownloadingPlaylist) {
        downloadBtnText.textContent = "Download Playlist";
      }
    }
  }

  document.querySelectorAll('#playlistSongsContainer .song-row').forEach(row => {
    const songId = row.dataset.songId;
    if (!songId) return;
    const isDownloaded = state.downloadedTrackIds.has(songId);
    const dlBtn = row.querySelector('.btn-track-download');
    if (dlBtn) {
      dlBtn.classList.toggle('downloaded', isDownloaded);
      dlBtn.title = isDownloaded ? 'Downloaded on device (Click to remove)' : 'Download song offline';
      dlBtn.innerHTML = isDownloaded
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #10b981;"><polyline points="20 6 9 17 4 12"></polyline></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
    }
    const checkIcon = row.querySelector('.download-check-icon');
    if (checkIcon) {
      checkIcon.style.display = isDownloaded ? 'inline-flex' : 'none';
    }
  });
}

function playOfflineTrack(song) {
  stopActivePlayback();
  state.currentPlaybackType = 'offline';

  AetherAudioEngine.init();
  const audioUrl = `/api/offline/audio?id=${encodeURIComponent(song.id)}`;
  if (AetherAudioEngine.initialized && AetherAudioEngine.audioElement) {
    activeAudio = AetherAudioEngine.audioElement;
  } else {
    activeAudio = new Audio();
  }
  activeAudio.src = audioUrl;

  activeAudio.onloadedmetadata = () => {
    if (activeAudio.duration && isFinite(activeAudio.duration)) {
      state.duration = Math.floor(activeAudio.duration);
      document.getElementById('playerTotalDuration').textContent = formatSeconds(state.duration);
      const mobileNpTotalDuration = document.getElementById('mobileNpTotalDuration');
      if (mobileNpTotalDuration) mobileNpTotalDuration.textContent = formatSeconds(state.duration);
    }
  };

  activeAudio.onended = () => {
    playNext();
  };

  activeAudio.play().then(() => {
    state.isPlaying = true;
    updatePlayButtonUI(true);
    startProgressTimer('audio');
    applyVolume();
  }).catch(err => {
    console.warn("Offline playback failed, attempting fallback:", err);
    state.currentPlaybackType = null;
    activeAudio = null;
    if (navigator.onLine) {
      if (song.platform === 'youtube' || song.isFallback) {
        playYouTubeTrack(song.id);
      } else {
        playProxyFallback(song);
      }
    } else {
      showToast("Cannot play: Track not found offline and device is disconnected");
    }
  });

  activeAudio.onended = () => {
    playNext();
  };
}

async function cacheStreamTrack(song) {
  if (!state.smartCacheEnabled || !song || !song.id) return;
  if (state.downloadedTrackIds.has(song.id) || state.downloadingTrackIds.has(song.id)) return;

  state.downloadingTrackIds.add(song.id);
  try {
    const res = await fetch('/api/offline/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ song, isCache: true })
    });
    if (res.ok) {
      const result = await res.json();
      if (result.success && result.track) {
        state.downloadedTrackIds.add(song.id);
        updateOfflineUIBadges();
        refreshOfflineStatsSilently();
      }
    }
  } catch (e) {
    console.warn("Smart cache error for track:", song.title, e);
  } finally {
    state.downloadingTrackIds.delete(song.id);
  }
}

async function downloadSingleTrack(song) {
  if (!song || !song.id) return;

  if (state.downloadedTrackIds.has(song.id)) {
    const confirmed = await showConfirmModal(
      "Remove Download?",
      `Do you want to remove "${song.title}" from your device storage?`
    );
    if (confirmed) {
      await removeDownloadedTrack(song.id);
    }
    return;
  }

  showToast(`Downloading "${song.title}"...`);
  state.downloadingTrackIds.add(song.id);
  updateOfflineUIBadges();

  try {
    const res = await fetch('/api/offline/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ song, isCache: false })
    });
    const result = await res.json();
    if (result.success) {
      state.downloadedTrackIds.add(song.id);
      showToast(`Downloaded "${song.title}"!`);
      updateOfflineUIBadges();
      refreshOfflineStatsSilently();
    } else {
      showToast(`Download failed: ${result.error || 'Unknown error'}`);
    }
  } catch (e) {
    showToast(`Download failed: ${e.message}`);
  } finally {
    state.downloadingTrackIds.delete(song.id);
    updateOfflineUIBadges();
  }
}

async function removeDownloadedTrack(songId) {
  try {
    const res = await fetch('/api/offline/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: songId })
    });
    const result = await res.json();
    if (result.success) {
      state.downloadedTrackIds.delete(songId);
      showToast('Track removed from device storage');
      updateOfflineUIBadges();
      await refreshOfflineStatsSilently();
      if (state.currentPlaylistId === 'system_downloaded') {
        openDownloadedMusicPlaylist();
      }
    } else {
      showToast('Failed to remove track');
    }
  } catch (e) {
    showToast('Failed to remove track');
  }
}

function renderProfileDownloadBanner(show, playlistName = '', currentIdx = 0, total = 0, currentTitle = '') {
  const banner = document.getElementById('profileActiveDownloadBanner');
  if (!banner) return;

  if (!show) {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = 'flex';
  const nameEl = document.getElementById('profileDownloadPlName');
  const songEl = document.getElementById('profileDownloadCurrentSong');
  const countEl = document.getElementById('profileDownloadCount');
  const pctEl = document.getElementById('profileDownloadPct');
  const fillEl = document.getElementById('profileDownloadProgressFill');

  if (nameEl) nameEl.textContent = `Downloading Playlist: ${playlistName || 'Playlist'}`;
  if (songEl) songEl.textContent = currentTitle ? `Song ${currentIdx} of ${total}: ${currentTitle}` : 'Downloading tracks...';
  if (countEl) countEl.textContent = `${currentIdx} / ${total} songs`;

  const pct = total > 0 ? Math.round((currentIdx / total) * 100) : 0;
  if (pctEl) pctEl.textContent = `${pct}%`;
  if (fillEl) fillEl.style.width = `${pct}%`;
}

function cancelCurrentPlaylistDownload() {
  if (!state.isDownloadingPlaylist) return;
  state.cancelPlaylistDownload = true;
  if (state.playlistDownloadAbortController) {
    try {
      state.playlistDownloadAbortController.abort();
    } catch (e) {}
  }
  const btnText = document.getElementById('btnDownloadPlaylistText');
  if (btnText) btnText.textContent = 'Stopping...';
  const songEl = document.getElementById('profileDownloadCurrentSong');
  if (songEl) songEl.textContent = 'Stopping download...';
  showToast('Cancelling download...');
}

async function downloadCurrentPlaylist() {
  const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
  if (!pl || !pl.songs || pl.songs.length === 0) {
    showToast("This playlist has no songs to download");
    return;
  }

  const btn = document.getElementById('btnDownloadPlaylist');
  const btnText = document.getElementById('btnDownloadPlaylistText');
  const cancelBtn = document.getElementById('btnCancelDownloadPlaylist');
  if (state.isDownloadingPlaylist) {
    showToast("Download already in progress");
    return;
  }

  state.isDownloadingPlaylist = true;
  state.downloadingPlaylistName = pl.name;
  state.cancelPlaylistDownload = false;
  state.playlistDownloadAbortController = new AbortController();

  if (btn) btn.classList.add('is-downloading');
  if (cancelBtn) cancelBtn.style.display = 'inline-flex';

  const total = pl.songs.length;
  let downloadedCount = 0;
  let failCount = 0;

  renderProfileDownloadBanner(true, pl.name, 0, total, 'Starting...');

  for (let i = 0; i < total; i++) {
    if (state.cancelPlaylistDownload) {
      break;
    }

    const s = pl.songs[i];
    if (btnText) btnText.textContent = `Downloading (${i + 1}/${total})...`;
    renderProfileDownloadBanner(true, pl.name, i + 1, total, s.title);

    try {
      const res = await fetch('/api/offline/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ song: s, isCache: false }),
        signal: state.playlistDownloadAbortController ? state.playlistDownloadAbortController.signal : undefined
      });
      const result = await res.json();
      if (result.success) {
        state.downloadedTrackIds.add(s.id);
        downloadedCount++;
      } else {
        failCount++;
      }
    } catch (e) {
      if (e.name === 'AbortError' || state.cancelPlaylistDownload) {
        break;
      }
      failCount++;
    }
    updateOfflineUIBadges();
  }

  const wasCancelled = state.cancelPlaylistDownload;
  state.isDownloadingPlaylist = false;
  state.cancelPlaylistDownload = false;
  state.playlistDownloadAbortController = null;

  if (btn) {
    btn.classList.remove('is-downloading');
  }
  if (cancelBtn) {
    cancelBtn.style.display = 'none';
  }
  renderProfileDownloadBanner(false);

  updateOfflineUIBadges();
  await refreshOfflineStatsSilently();

  if (wasCancelled) {
    showToast(`Playlist download stopped (${downloadedCount} saved)`);
  } else {
    showToast(`Playlist download complete! (${downloadedCount} saved${failCount > 0 ? `, ${failCount} failed` : ''})`);
  }
}

async function openDownloadedMusicPlaylist() {
  state.currentPlaylistId = 'system_downloaded';
  switchTab('playlist-detail');

  document.getElementById('detailPlaylistName').textContent = "Downloaded Music";
  document.getElementById('detailPlaylistName').contentEditable = "false";

  const imgContent = document.getElementById('detailPlaylistImgContent');
  imgContent.innerHTML = `
    <div style="background: linear-gradient(135deg, #10b981 0%, #06b6d4 100%); width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: white;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 48px; height: 48px;">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
    </div>
  `;

  // Hide Delete Playlist and Download Playlist buttons for system playlist
  const deleteBtn = document.getElementById('btnDeletePlaylist');
  const downloadBtn = document.getElementById('btnDownloadPlaylist');
  if (deleteBtn) deleteBtn.style.display = 'none';
  if (downloadBtn) downloadBtn.style.display = 'none';

  // Highlight pinned item in sidebar
  document.querySelectorAll('#playlistsList li').forEach(li => li.classList.remove('active'));
  const pinnedItem = document.getElementById('btnOpenDownloadedPlaylist');
  if (pinnedItem) pinnedItem.classList.add('active');

  const container = document.getElementById('playlistSongsContainer');
  container.innerHTML = '<div class="empty-state">Loading downloaded songs...</div>';

  try {
    const res = await fetch('/api/offline/tracks');
    if (res.ok) {
      const data = await res.json();
      const tracks = data.tracks || [];
      state.offlineTracks = tracks;
      state.downloadedTrackIds = new Set(tracks.map(t => t.id));

      const stats = data.stats || {};
      const totalMb = (stats.totalBytes / (1024 * 1024)).toFixed(1);
      document.getElementById('detailPlaylistStats').textContent = `${tracks.length} songs • ${totalMb} MB stored on this device`;

      renderDownloadedSongsList(tracks);
    }
  } catch (err) {
    console.error("Error loading offline tracks:", err);
    container.innerHTML = '<div class="empty-state">Failed to load downloaded music</div>';
  }
}

function renderDownloadedSongsList(tracks) {
  const container = document.getElementById('playlistSongsContainer');
  container.innerHTML = '';

  if (!tracks || tracks.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>No downloaded music yet</h3>
        <p>Click "Download Playlist" on any playlist or tap the download icon on individual tracks to save them for offline listening.</p>
      </div>
    `;
    return;
  }

  tracks.forEach((song, idx) => {
    const row = document.createElement('div');
    row.className = 'song-row';
    row.dataset.songId = song.id;
    if (state.currentSong && state.currentSong.id === song.id) {
      row.classList.add('active');
    }

    row.addEventListener('click', () => {
      state.playQueue = tracks.map(s => ({ ...s }));
      state.stationAnchor = tracks[tracks.length - 1] || song;
      state.isRadioSession = false;
      playSong(song, idx);
    });

    const colNum = document.createElement('div');
    colNum.className = 'col-num';
    colNum.textContent = idx + 1;

    const colTitle = document.createElement('div');
    colTitle.className = 'col-title';
    colTitle.innerHTML = `
      <img src="${song.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=200&auto=format&fit=crop'}" alt="Thumb">
      <div class="song-col-text">
        <div class="song-col-title" title="${song.title}">
          ${song.title}
          <span class="download-check-icon" title="Downloaded on device"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg></span>
        </div>
        <div class="song-col-artist clickable-artist">${song.artist || 'Unknown'}</div>
      </div>
    `;

    const colArtist = document.createElement('div');
    colArtist.className = 'col-artist';
    const artistSpan = document.createElement('span');
    artistSpan.className = 'clickable-artist';
    artistSpan.textContent = song.artist || 'Unknown';
    artistSpan.title = 'View artist profile';
    artistSpan.addEventListener('click', (e) => {
      e.stopPropagation();
      openArtistProfile(song.artist, song.platform, song.artistId || song.artist_id);
    });
    colArtist.appendChild(artistSpan);

    const colSource = document.createElement('div');
    colSource.className = 'col-source';
    const sizeStr = song.size ? formatBytes(song.size) : '';
    const cacheTag = song.isCache ? '<span class="badge" style="background: rgba(168, 85, 247, 0.2); color: #c084fc; font-size: 0.68rem; margin-left: 4px;">Cache</span>' : '';
    colSource.innerHTML = `<span class="song-card-badge badge-${song.platform}">${song.platform}</span>${cacheTag} ${sizeStr ? `<span style="font-size: 0.72rem; color: var(--text-secondary); margin-left: 6px;">${sizeStr}</span>` : ''}`;

    const colDuration = document.createElement('div');
    colDuration.className = 'col-duration';
    colDuration.textContent = song.duration || '3:30';

    const colActions = document.createElement('div');
    colActions.className = 'col-actions';

    const removeBtn = document.createElement('button');
    removeBtn.className = 'icon-btn';
    removeBtn.title = 'Remove from device storage';
    removeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const confirmed = await showConfirmModal("Remove Song?", `Remove "${song.title}" from device storage?`);
      if (confirmed) {
        await removeDownloadedTrack(song.id);
      }
    });

    colActions.appendChild(removeBtn);

    row.appendChild(colNum);
    row.appendChild(colTitle);
    row.appendChild(colArtist);
    row.appendChild(colSource);
    row.appendChild(colDuration);
    row.appendChild(colActions);

    container.appendChild(row);
  });
}


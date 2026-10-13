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
  profile: {
    username: 'Music Enthusiast',
    avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?q=80&w=200&auto=format&fit=crop'
  },
  spotifyConfigured: false,
  lyrics: null,
  lyricsSynced: false,
  lyricsOpen: false,
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
let activeAudio = null; // for Spotify previews
let progressInterval = null;

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
      'onStateChange': onPlayerStateChange,
      'onError': onPlayerError
    }
  });
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
}

function savePlaylists() {
  localStorage.setItem('playlists', JSON.stringify(state.playlists));
  renderPlaylists();
  debouncedSyncBackup();
}

function updateUserProfileUI() {
  const avatarEl = document.getElementById('profileAvatar');
  const headerAvatarEl = document.getElementById('headerAvatar');
  const usernameInput = document.getElementById('profileUsernameInput');
  const headerUsernameEl = document.getElementById('headerUsername');
  
  if (avatarEl) avatarEl.src = state.profile.avatar;
  if (headerAvatarEl) headerAvatarEl.src = state.profile.avatar;
  if (usernameInput) usernameInput.value = state.profile.username;
  if (headerUsernameEl) headerUsernameEl.textContent = state.profile.username;
}

function saveProfile() {
  localStorage.setItem('profile', JSON.stringify(state.profile));
  syncSettingsToServer({ username: state.profile.username, avatar: state.profile.avatar });
  updateUserProfileUI();
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
  themeSyncTimeout = setTimeout(() => {
    syncSettingsToServer({ currentTheme: state.currentTheme });
  }, 1000); // 1 second debounce
}

async function loadServerSettings() {
  try {
    const response = await fetch('/api/settings');
    if (response.ok) {
      const config = await response.json();

      // 1. Spotify Config
      state.spotifyConfigured = (config.spotifyClientId && config.spotifyClientSecret);
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

// --- EVENT LISTENERS SYSTEM ---
function setupEventListeners() {
  // Navigation Tabs Switching
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.getAttribute('data-tab');
      switchTab(tabName);
    });
  });

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

  document.getElementById('avatarFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function (evt) {
      const base64Data = evt.target.result;
      try {
        const response = await fetch('/api/upload-avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64Data, filename: file.name })
        });
        if (response.ok) {
          const result = await response.json();
          state.profile.avatar = result.fileUrl;
          document.getElementById('profileAvatar').src = result.fileUrl;
          saveProfile();
          showToast('Avatar updated!');
        }
      } catch (err) {
        console.error('Failed to upload avatar:', err);
        showToast('Avatar upload failed');
      }
    };
    reader.readAsDataURL(file);
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

  document.getElementById('playlistCoverFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function (evt) {
      const base64Data = evt.target.result;
      try {
        const response = await fetch('/api/upload-avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64Data, filename: file.name })
        });
        if (response.ok) {
          const result = await response.json();
          const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
          if (pl) {
            pl.cover = result.fileUrl;
            savePlaylists();
            openPlaylistDetails(state.currentPlaylistId);
            showToast('Playlist cover image uploaded!');
          }
        }
      } catch (err) {
        console.error('Failed to upload cover:', err);
        showToast('Cover upload failed');
      }
    };
    reader.readAsDataURL(file);
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
    let link = await showPromptModal('Import Playlist from Link', 'Paste a YouTube, Spotify, or SoundCloud playlist link:');
    if (!link) return;

    link = link.trim();
    if (!link.startsWith('http://') && !link.startsWith('https://')) {
      link = 'https://' + link;
    }

    showToast('Analyzing playlist link...');

    try {
      const response = await fetch(`/api/resolve-link?url=${encodeURIComponent(link)}`);
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
        } else {
          showToast('This link resolves to a single track. Try pasting it in the search bar instead!');
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
    const plist = state.playlists.find(p => p.id === state.currentPlaylistId);
    if (plist && plist.songs.length > 0) {
      playSongList(plist.songs, 0);
    } else {
      showToast('Playlist is empty');
    }
  });

  // Export/Import Playlist files
  document.getElementById('btnExportPlaylists').addEventListener('click', () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state.playlists));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `playlists_backup_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    showToast('Playlists exported to JSON');
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
    const clientSecret = document.getElementById('spotifyClientSecret').value.trim();

    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spotifyClientId: clientId, spotifyClientSecret: clientSecret })
      });
      if (response.ok) {
        showToast('Spotify settings saved!');
        checkSpotifyConfig();
      }
    } catch (e) {
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

  // Volume slider control
  document.getElementById('playerVolume').addEventListener('input', (e) => {
    const vol = parseInt(e.target.value);
    state.volume = vol;
    applyVolume();
  });

  document.getElementById('btnMute').addEventListener('click', () => {
    state.isMuted = !state.isMuted;
    document.getElementById('volumeOnIcon').style.display = state.isMuted ? 'none' : 'block';
    document.getElementById('volumeOffIcon').style.display = state.isMuted ? 'block' : 'none';
    applyVolume();
  });

  // Timeline seek control
  document.getElementById('playerTimeline').addEventListener('input', (e) => {
    // update current time label while dragging
    const pct = parseFloat(e.target.value) / 100;
    const seekSecs = pct * state.duration;
    document.getElementById('playerCurrentTime').textContent = formatSeconds(seekSecs);
    updateLyricsHighlight(seekSecs);
  });

  document.getElementById('playerTimeline').addEventListener('change', (e) => {
    const pct = parseFloat(e.target.value) / 100;
    seekToPercentage(pct);
  });

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
    if (state.currentSong) fetchLyricsForTrack(state.currentSong);
    closeMobileNowPlaying();
  });
  document.getElementById('btnExpandLyricsModal')?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.lyricsMode = 1;
    const drawer = document.getElementById('lyricsDrawer');
    if (drawer) drawer.classList.add('active');
    if (state.currentSong) fetchLyricsForTrack(state.currentSong);
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
      if (state.currentSong) fetchLyricsForTrack(state.currentSong);
    } else if (state.lyricsMode === 2) {
      widget.style.display = 'flex';
      btn.classList.add('active');
      btn.style.color = 'var(--accent-color)';
      state.lyricsOpen = true;
      if (state.currentSong) {
        fetchLyricsForTrack(state.currentSong);
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
function switchTab(tabName) {
  state.activeTab = tabName;

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
      const response = await fetch(`/api/resolve-link?url=${encodeURIComponent(finalQuery)}`);
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
  img.src = song.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=200&auto=format&fit=crop';
  img.loading = 'lazy';
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

function showConfirmModal(title, message) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirmModal');
    const titleEl = document.getElementById('confirmModalTitle');
    const msgEl = document.getElementById('confirmModalMessage');
    const btnCancel = document.getElementById('btnConfirmCancel');
    const btnConfirm = document.getElementById('btnConfirmConfirm');

    titleEl.textContent = title;
    msgEl.textContent = message;

    modal.classList.add('active');

    const cleanup = () => {
      modal.classList.remove('active');
      btnConfirm.removeEventListener('click', onConfirm);
      btnCancel.removeEventListener('click', onCancel);
    };

    const onConfirm = () => {
      cleanup();
      resolve(true);
    };

    const onCancel = () => {
      cleanup();
      resolve(false);
    };

    btnConfirm.addEventListener('click', onConfirm);
    btnCancel.addEventListener('click', onCancel);
  });
}

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

function importPlaylistFromData(name, songs) {
  const newPlaylist = {
    id: 'pl-' + Date.now(),
    name: name,
    songs: songs,
    createdAt: new Date().toLocaleDateString()
  };
  state.playlists.push(newPlaylist);
  savePlaylists();
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
        thumb.innerHTML = `<img src="${pl.cover}" alt="Cover">`;
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
        thumb.innerHTML = `<img src="${pl.cover}" alt="Cover">`;
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

function openPlaylistDetails(playlistId) {
  state.currentPlaylistId = playlistId;
  const pl = state.playlists.find(p => p.id === playlistId);
  if (!pl) return;

  switchTab('playlist-detail');

  // Highlight active playlist item
  document.querySelectorAll('#playlistsList li').forEach(li => {
    li.classList.toggle('active', li.dataset.playlistId === playlistId);
  });

  document.getElementById('detailPlaylistName').textContent = pl.name;
  document.getElementById('detailPlaylistStats').textContent = `${pl.songs.length} songs • Created ${pl.createdAt}`;

  const imgContent = document.getElementById('detailPlaylistImgContent');
  if (pl.cover) {
    imgContent.innerHTML = `<img src="${pl.cover}" alt="Cover" style="width:100%; height:100%; object-fit:cover;">`;
  } else {
    imgContent.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 48px; height: 48px;"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
  }

  const container = document.getElementById('playlistSongsContainer');
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

  pl.songs.forEach((song, idx) => {
    const row = document.createElement('div');
    row.className = 'song-row';
    if (state.currentSong && state.currentSong.id === song.id) {
      row.classList.add('active');
    }

    row.addEventListener('click', () => {
      // Clone playlist songs to ensure recommendations NEVER pollute the playlist
      state.playQueue = pl.songs.map(s => ({ ...s }));
      state.stationAnchor = pl.songs[pl.songs.length - 1] || song;
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
        <div class="song-col-title" title="${song.title}">${song.title}</div>
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

    const removeBtn = document.createElement('button');
    removeBtn.className = 'icon-btn';
    removeBtn.title = 'Remove song';
    removeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeSongFromPlaylist(playlistId, idx);
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
  state.isTransitioning = true;
  setTimeout(() => {
    state.isTransitioning = false;
  }, 1500);

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

  // Reset lyrics index and trigger fetch for lyrics box
  activeLyricIndex = -1;
  fetchLyricsForTrack(song);

  // Initialize playback depending on platform source
  if (song.platform === 'youtube' || song.isFallback) {
    playYouTubeTrack(song.id);
  } else if (song.platform === 'spotify') {
    if (song.previewUrl) {
      playPreviewTrack(song.previewUrl);
    } else {
      playProxyFallback(song);
    }
  } else if (song.platform === 'soundcloud') {
    playProxyFallback(song);
  }

  // Update Play Button Icon
  updatePlayButtonUI(true);

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
}

function playYouTubeTrack(videoId) {
  if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
    ytPlayer.loadVideoById(videoId);
    ytPlayer.playVideo();
    applyVolume();
    startProgressTimer('youtube');
  } else {
    // Check if YouTube API is loaded globally, if so, initialize player on-demand
    if (window.YT && window.YT.Player) {
      console.log('Initializing YouTube player on-demand...');
      ytPlayer = new YT.Player('ytPlayerContainer', {
        height: '1',
        width: '1',
        videoId: videoId,
        playerVars: {
          'playsinline': 1,
          'controls': 0,
          'disablekb': 1
        },
        events: {
          'onStateChange': onPlayerStateChange,
          'onError': onPlayerError,
          'onReady': (event) => {
            event.target.playVideo();
            applyVolume();
            startProgressTimer('youtube');
          }
        }
      });
    } else {
      console.error('YouTube player is not fully loaded yet');
    }
  }
}

function playPreviewTrack(previewUrl) {
  activeAudio = new Audio(previewUrl);
  activeAudio.volume = state.isMuted ? 0 : state.volume / 100;
  activeAudio.play();
  startProgressTimer('audio');

  activeAudio.onended = () => {
    playNext();
  };
}

async function playProxyFallback(song) {
  // Queries server search API for a YouTube equivalent of Spotify/SoundCloud items
  try {
    const query = `${song.title} ${song.artist}`;
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&platform=youtube`);
    if (response.ok) {
      const results = await response.json();
      if (results && results.length > 0) {
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
  if (window.AndroidAudio && typeof window.AndroidAudio.stop === 'function') {
    try { window.AndroidAudio.stop(); } catch(e) {}
  }

  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }

  // Stop YouTube
  if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
    try {
      ytPlayer.stopVideo();
    } catch (e) { }
  }

  // Stop HTML5 Audio
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.src = '';
    activeAudio = null;
  }

  state.isPlaying = false;
}

function togglePlayPause() {
  if (!state.currentSong) return;

  if (state.isPlaying) {
    // User explicitly paused
    state.isPlaying = false;
    state.isUserPaused = true;

    if (state.currentSong.platform === 'youtube' || !state.currentSong.previewUrl) {
      if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
        ytPlayer.pauseVideo();
      }
    } else if (activeAudio) {
      activeAudio.pause();
    }
    updatePlayButtonUI(false);
  } else {
    // User explicitly played
    state.isPlaying = true;
    state.isUserPaused = false;

    if (state.currentSong.platform === 'youtube' || !state.currentSong.previewUrl) {
      if (ytPlayer && typeof ytPlayer.playVideo === 'function') {
        ytPlayer.playVideo();
      }
    } else if (activeAudio) {
      activeAudio.play();
    }
    updatePlayButtonUI(true);
  }
}

// Native Android Audio Bridge Callbacks
window.onNativeAudioProgress = function(currentSec, totalSec) {
  if (!state.isPlaying) return;
  state.playbackPosition = currentSec;
  if (totalSec && totalSec > 0) state.duration = totalSec;

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
  if (state.isTransitioning) {
    console.log("Ignoring playNext() during transition...");
    return;
  }
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
      return;
    }
  }

  playSong(state.playQueue[nextIndex], nextIndex);
}

function playPrev() {
  if (state.playQueue.length === 0) return;
  let prevIndex = state.currentQueueIndex - 1;
  if (prevIndex < 0) {
    prevIndex = state.playQueue.length - 1;
  }
  playSong(state.playQueue[prevIndex], prevIndex);
}

function applyVolume() {
  const vol = state.isMuted ? 0 : state.volume;
  if (window.AndroidAudio && typeof window.AndroidAudio.setVolume === 'function') {
    window.AndroidAudio.setVolume(vol / 100);
  }
  if (ytPlayer && typeof ytPlayer.setVolume === 'function') {
    ytPlayer.setVolume(vol);
  }
  if (activeAudio) {
    activeAudio.volume = vol / 100;
  }
}

function seekToPercentage(pct) {
  const seekSeconds = pct * state.duration;
  if (window.AndroidAudio && typeof window.AndroidAudio.seekTo === 'function') {
    window.AndroidAudio.seekTo(seekSeconds);
  } else if (state.currentSong && (state.currentSong.platform === 'youtube' || !state.currentSong.previewUrl)) {
    if (ytPlayer && typeof ytPlayer.seekTo === 'function') {
      ytPlayer.seekTo(seekSeconds, true);
    }
  } else if (activeAudio) {
    activeAudio.currentTime = seekSeconds;
  }
}

function startProgressTimer(platform) {
  if (progressInterval) clearInterval(progressInterval);

  progressInterval = setInterval(() => {
    if (!state.isPlaying) return;

    let currentSec = 0;
    if (platform === 'youtube' && ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
      currentSec = ytPlayer.getCurrentTime();
    } else if (platform === 'preview' && activeAudio) {
      currentSec = activeAudio.currentTime;
    }

    state.playbackPosition = currentSec;

    // Update synced lyrics line
    updateLyricsHighlight(currentSec);

    // Update UI Progress slider & timestamps
    const pct = (currentSec / state.duration) * 100;
    const boundedPct = Math.min(100, Math.max(0, pct));
    const timeFormatted = formatSeconds(currentSec);

    document.getElementById('playerTimeline').value = boundedPct;
    document.getElementById('playerCurrentTime').textContent = timeFormatted;

    // Update Mobile Scrubber & Mini progress bar
    const mobileTimeline = document.getElementById('mobileNpTimeline');
    if (mobileTimeline) mobileTimeline.value = boundedPct;
    const mobileTime = document.getElementById('mobileNpCurrentTime');
    if (mobileTime) mobileTime.textContent = timeFormatted;
    const miniProg = document.getElementById('miniPlayerProgress');
    if (miniProg) miniProg.style.width = `${boundedPct}%`;
  }, 500);
}

// YT State Change Monitor
function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.PLAYING) {
    state.isTransitioning = false;
    state.isPlaying = true;
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
    playNext();
  }
}

function onPlayerError(event) {
  console.error('YouTube player error:', event.data);
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
async function fetchLyricsForTrack(song) {
  const container = document.getElementById('lyricsDrawerBody');
  container.innerHTML = '<div class="lyrics-placeholder">Loading lyrics...</div>';

  state.lyrics = null;
  state.lyricsSynced = false;

  try {
    const response = await fetch(`/api/lyrics?title=${encodeURIComponent(song.title)}&artist=${encodeURIComponent(song.artist || '')}`);
    if (!response.ok) throw new Error('Network response not ok');

    const data = await response.json();
    if (data.error) {
      container.innerHTML = `<div class="lyrics-placeholder">${data.error}</div>`;
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
      container.innerHTML = `<div class="lyric-plain-text">${data.lyrics}</div>`;
    } else {
      container.innerHTML = '<div class="lyrics-placeholder">No lyrics found for this song.</div>';
    }
  } catch (err) {
    console.error('Failed to fetch lyrics:', err);
    container.innerHTML = '<div class="lyrics-placeholder">Failed to load lyrics.</div>';
  } finally {
    updateLyricsHighlight(state.playbackPosition);
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
  .then(res => res.json())
  .then(data => {
    if (data.success && state.activeTab === 'home') {
      loadHomeDashboard();
    }
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

  // 1. Fetch History
  try {
    const res = await fetch('/api/history');
    if (res.ok) {
      const history = await res.json();
      quickGrid.innerHTML = '';
      
      if (history && history.length > 0) {
        const uniqueRecents = [];
        const seen = new Set();
        for (const item of history) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            uniqueRecents.push(item);
          }
          if (uniqueRecents.length === 8) break;
        }

        uniqueRecents.forEach(song => {
          const card = document.createElement('div');
          card.className = 'quick-recent-card';
          card.innerHTML = `
            <img src="${song.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=150&auto=format&fit=crop'}" class="quick-recent-art" alt="Art">
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
            <p>Your listening history will appear here. Start playing songs!</p>
          </div>
        `;
      }
    }
  } catch (e) {
    console.error("Failed to load history:", e);
    quickGrid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">Error loading history</div>';
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
              <img src="${mix.thumbnail}" class="home-card-art" alt="Art">
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
              <img src="${song.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=200&auto=format&fit=crop'}" class="home-card-art" alt="Art">
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

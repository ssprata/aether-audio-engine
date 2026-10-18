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
  isFetchingMoreQueue: false,
  trackEqCache: {},          // In-memory cache for track EQ: { [songId]: { low, mid, high, updatedAt } }
  trackAnalysisCache: {},    // In-memory cache for audio analysis: { [songId]: { bpm, camelot, peaks, ... } }
  trackTransitionsCache: {}, // In-memory cache for DJ transitions: { [key]: { bars, curveType, durationSeconds } }
  isExecutingTransition: false,
  djTransitionEnabled: localStorage.getItem('aether_dj_transition_enabled') !== 'false',
  djTransitionSettings: { bars: 8, curveType: 'bass_swap', durationSeconds: 16 },
  masterEqSettings: { low: 0, mid: 0, high: 0, preset: 'flat' }
};

// Player Reference variables
let ytPlayer = null;
let ytPlayerReady = false;
let pendingVideoToPlay = null;
let activeAudio = null; // for Spotify previews & Web Audio HTML5 source
let progressInterval = null;

// ============================================================================
// AETHER AUDIO ENGINE (Web Audio API Core Pipeline & Dual-Deck DSP Graph)
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

  // Dual Decks (Pacemaker DJ Engine)
  deckA: {
    id: 'A',
    audio: null,
    sourceNode: null,
    gainNode: null,
    eq: { low: null, mid: null, high: null }
  },
  deckB: {
    id: 'B',
    audio: null,
    sourceNode: null,
    gainNode: null,
    eq: { low: null, mid: null, high: null }
  },
  activeDeckId: 'A',
  crossfadeTimer: null,
  initialized: false,

  get audioElement() {
    return this.getActiveDeck().audio;
  },

  get trackEq() {
    return this.getActiveDeck().eq;
  },

  getActiveDeck() {
    return this.activeDeckId === 'A' ? this.deckA : this.deckB;
  },

  getInactiveDeck() {
    return this.activeDeckId === 'A' ? this.deckB : this.deckA;
  },

  switchActiveDeck() {
    this.activeDeckId = (this.activeDeckId === 'A' ? 'B' : 'A');
    activeAudio = this.getActiveDeck().audio;
    return this.getActiveDeck();
  },

  _createDeckGraph(id) {
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.preload = 'auto';

    const sourceNode = this.ctx.createMediaElementSource(audio);

    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(id === 'A' ? 1.0 : 0.0, this.ctx.currentTime);

    // Per-Track EQ Filters for this deck (Low, Mid, High)
    const low = this.ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.setValueAtTime(120, this.ctx.currentTime);
    low.gain.setValueAtTime(0, this.ctx.currentTime);

    const mid = this.ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.setValueAtTime(2000, this.ctx.currentTime);
    mid.Q.setValueAtTime(1.2, this.ctx.currentTime);
    mid.gain.setValueAtTime(0, this.ctx.currentTime);

    const high = this.ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.setValueAtTime(7500, this.ctx.currentTime);
    high.gain.setValueAtTime(0, this.ctx.currentTime);

    // Filter / FX Node (for live transition sweeps & effects)
    const fx = this.ctx.createBiquadFilter();
    fx.type = 'allpass';
    fx.frequency.setValueAtTime(20000, this.ctx.currentTime);

    // Connect audio -> low -> mid -> high -> fx -> gainNode -> masterEq.low
    sourceNode.connect(low);
    low.connect(mid);
    mid.connect(high);
    high.connect(fx);
    fx.connect(gainNode);
    gainNode.connect(this.masterEq.low);

    return {
      id,
      audio,
      sourceNode,
      gainNode,
      eq: { low, mid, high },
      fx
    };
  },

  async resumeContext() {
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch (e) {}
    }
  },

  init() {
    if (this.initialized) {
      this.resumeContext();
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
      const initVol = (state.isMuted ? 0 : (state.volume || 70)) / 100;
      const initEffective = initVol > 0 ? Math.max(0.005, Math.pow(initVol, 2.2)) : 0;
      this.masterGain.gain.setValueAtTime(initEffective, this.ctx.currentTime);

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

      // Connect Master Pipeline:
      // masterEq.low -> masterEq.mid -> masterEq.high -> masterGain -> limiter -> destination
      this.masterEq.low.connect(this.masterEq.mid);
      this.masterEq.mid.connect(this.masterEq.high);
      this.masterEq.high.connect(this.masterGain);
      this.masterGain.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);

      // Initialize Dual Decks (Deck A and Deck B)
      this.deckA = this._createDeckGraph('A');
      this.deckB = this._createDeckGraph('B');
      this.activeDeckId = 'A';

      // Expose to activeAudio so existing event handlers operate seamlessly
      activeAudio = this.deckA.audio;

      this.initialized = true;
      console.log('[AudioEngine] Dual-Deck Web Audio Core Graph initialized successfully');

      if (typeof window.applyVolume === 'function') {
        window.applyVolume();
      }

      if (state.masterEqSettings) {
        this.setMasterEq(
          state.masterEqSettings.low,
          state.masterEqSettings.mid,
          state.masterEqSettings.high
        );
      }
      if (state.currentSong && state.trackEqCache && state.trackEqCache[state.currentSong.id]) {
        const trk = state.trackEqCache[state.currentSong.id];
        this.setTrackEq(trk.low, trk.mid, trk.high);
      }
    } catch (err) {
      console.warn('[AudioEngine] Web Audio initialization warning:', err);
    }
  },

  setMasterVolume(ratio) {
    if (this.masterGain && this.ctx) {
      const effective = ratio <= 0.001 ? 0 : Math.max(0, Math.min(1, ratio));
      this.masterGain.gain.setTargetAtTime(effective, this.ctx.currentTime, 0.03);
    }
    if (this.deckA && this.deckA.audio) {
      try { this.deckA.audio.volume = 1.0; } catch (e) {}
    }
    if (this.deckB && this.deckB.audio) {
      try { this.deckB.audio.volume = 1.0; } catch (e) {}
    }
  },

  setDeckFx(type, value, targetDeckId = null) {
    if (!this.ctx) return;
    const deck = targetDeckId ? (targetDeckId === 'A' ? this.deckA : this.deckB) : this.getActiveDeck();
    if (!deck || !deck.fx) return;
    const now = this.ctx.currentTime;
    if (type === 'hipass_sweep') {
      deck.fx.type = 'highpass';
      const freq = Math.max(20, Math.min(12000, 20 + Math.pow(value, 2.5) * 8000));
      deck.fx.frequency.setTargetAtTime(freq, now, 0.03);
    } else if (type === 'lowpass_sweep') {
      deck.fx.type = 'lowpass';
      const freq = Math.max(200, Math.min(20000, 20000 - Math.pow(value, 2) * 19500));
      deck.fx.frequency.setTargetAtTime(freq, now, 0.03);
    } else if (type === 'resonant_peak') {
      deck.fx.type = 'peaking';
      deck.fx.Q.setTargetAtTime(4.0, now, 0.03);
      deck.fx.gain.setTargetAtTime(value * 12, now, 0.03);
    } else {
      deck.fx.type = 'allpass';
    }
  },

  resetDeckFx(targetDeckId = null) {
    const deck = targetDeckId ? (targetDeckId === 'A' ? this.deckA : this.deckB) : this.getActiveDeck();
    if (!deck || !deck.fx || !this.ctx) return;
    deck.fx.type = 'allpass';
  },

  setMasterEq(lowDb, midDb, highDb) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (this.masterEq.low && lowDb !== undefined) this.masterEq.low.gain.setTargetAtTime(lowDb, now, 0.05);
    if (this.masterEq.mid && midDb !== undefined) this.masterEq.mid.gain.setTargetAtTime(midDb, now, 0.05);
    if (this.masterEq.high && highDb !== undefined) this.masterEq.high.gain.setTargetAtTime(highDb, now, 0.05);
  },

  setTrackEq(lowDb, midDb, highDb, targetDeckId = null) {
    if (!this.ctx) return;
    const deck = targetDeckId ? (targetDeckId === 'A' ? this.deckA : this.deckB) : this.getActiveDeck();
    if (!deck || !deck.eq) return;
    const now = this.ctx.currentTime;
    if (deck.eq.low && lowDb !== undefined) deck.eq.low.gain.setTargetAtTime(lowDb, now, 0.05);
    if (deck.eq.mid && midDb !== undefined) deck.eq.mid.gain.setTargetAtTime(midDb, now, 0.05);
    if (deck.eq.high && highDb !== undefined) deck.eq.high.gain.setTargetAtTime(highDb, now, 0.05);
  },

  resetTrackEq(targetDeckId = null) {
    this.setTrackEq(0, 0, 0, targetDeckId);
  },

  cancelCrossfade() {
    if (this.crossfadeTimer) {
      clearTimeout(this.crossfadeTimer);
      this.crossfadeTimer = null;
    }
  },

  executeCrossfade({ duration = 12, curveType = 'bass_swap', outgoingDeck = null, incomingDeck = null, onComplete = null } = {}) {
    if (!this.ctx || !this.initialized) {
      if (typeof onComplete === 'function') onComplete();
      return;
    }

    this.cancelCrossfade();

    const outgoing = outgoingDeck || this.getActiveDeck();
    const incoming = incomingDeck || this.getInactiveDeck();
    const startTime = this.ctx.currentTime;
    const dur = Math.max(1, duration);

    // Cancel scheduled parameter changes
    outgoing.gainNode.gain.cancelScheduledValues(startTime);
    incoming.gainNode.gain.cancelScheduledValues(startTime);
    outgoing.gainNode.gain.setValueAtTime(1.0, startTime);
    incoming.gainNode.gain.setValueAtTime(0.0, startTime);

    const steps = 60;
    const outCurve = new Float32Array(steps);
    const inCurve = new Float32Array(steps);

    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      if (curveType === 'equal_power' || curveType === 'bass_swap') {
        outCurve[i] = Math.cos(t * 0.5 * Math.PI);
        inCurve[i] = Math.sin(t * 0.5 * Math.PI);
      } else if (curveType === 'smooth') {
        outCurve[i] = 1 - t;
        inCurve[i] = t;
      } else if (curveType === 'drop_cut') {
        outCurve[i] = t < 0.95 ? 1.0 : (1.0 - (t - 0.95) / 0.05);
        inCurve[i] = t > 0.05 ? 1.0 : (t / 0.05);
      } else {
        outCurve[i] = Math.cos(t * 0.5 * Math.PI);
        inCurve[i] = Math.sin(t * 0.5 * Math.PI);
      }
    }

    outgoing.gainNode.gain.setValueCurveAtTime(outCurve, startTime, dur);
    incoming.gainNode.gain.setValueCurveAtTime(inCurve, startTime, dur);

    // Bass Swap: frequency crossover at 50% midpoint
    if (curveType === 'bass_swap') {
      const midTime = startTime + (dur * 0.5);
      const swapDuration = Math.min(2.5, dur * 0.25);

      outgoing.eq.low.gain.cancelScheduledValues(startTime);
      outgoing.eq.low.gain.setValueAtTime(0, startTime);
      outgoing.eq.low.gain.setTargetAtTime(-24, Math.max(startTime, midTime - swapDuration), swapDuration * 0.5);

      incoming.eq.low.gain.cancelScheduledValues(startTime);
      incoming.eq.low.gain.setValueAtTime(-24, startTime);
      incoming.eq.low.gain.setTargetAtTime(0, midTime, swapDuration * 0.5);
    }

    this.crossfadeTimer = setTimeout(() => {
      try {
        const now = this.ctx.currentTime;
        outgoing.gainNode.gain.setValueAtTime(0.0, now);
        incoming.gainNode.gain.setValueAtTime(1.0, now);
        outgoing.eq.low.gain.setValueAtTime(0, now);
        incoming.eq.low.gain.setValueAtTime(0, now);
        if (outgoing.audio) {
          outgoing.audio.pause();
          outgoing.audio.currentTime = 0;
        }
      } catch (e) {}

      if (typeof window.applyVolume === 'function') {
        window.applyVolume();
      }

      if (typeof onComplete === 'function') {
        onComplete();
      }
    }, dur * 1000);
  },

  stopPlayback() {
    this.cancelCrossfade();
    if (this.deckA && this.deckA.audio) {
      try {
        this.deckA.audio.pause();
        this.deckA.audio.currentTime = 0;
      } catch (e) {}
    }
    if (this.deckB && this.deckB.audio) {
      try {
        this.deckB.audio.pause();
        this.deckB.audio.currentTime = 0;
      } catch (e) {}
    }
    if (this.ctx && this.deckA && this.deckB) {
      try {
        const now = this.ctx.currentTime;
        this.deckA.gainNode.gain.cancelScheduledValues(now);
        this.deckB.gainNode.gain.cancelScheduledValues(now);
        this.deckA.gainNode.gain.setValueAtTime(this.activeDeckId === 'A' ? 1.0 : 0.0, now);
        this.deckB.gainNode.gain.setValueAtTime(this.activeDeckId === 'B' ? 1.0 : 0.0, now);
        this.deckA.eq.low.gain.setValueAtTime(0, now);
        this.deckB.eq.low.gain.setValueAtTime(0, now);
      } catch (e) {}
    }
  }
};

// ============================================================================
// AETHER AUDIO PERSISTENCE & DUAL EQUALIZER SYSTEM (v2.0.0)
// ============================================================================
const MASTER_EQ_PRESETS = {
  flat: { low: 0, mid: 0, high: 0 },
  bass_boost: { low: 6.0, mid: 0.0, high: 2.0 },
  vocal: { low: -2.0, mid: 4.5, high: 2.0 },
  electronic: { low: 5.5, mid: 1.0, high: 4.0 },
  rock: { low: 4.0, mid: -1.5, high: 3.5 },
  hiphop: { low: 6.5, mid: 1.5, high: 1.0 },
  acoustic: { low: 2.0, mid: 3.0, high: 2.5 },
  night: { low: -4.0, mid: 1.0, high: -3.0 }
};

const AetherAudioDB = {
  db: null,
  initPromise: null,

  init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = new Promise((resolve) => {
      if (!window.indexedDB) {
        console.warn('[AudioDB] IndexedDB unavailable, using in-memory cache');
        return resolve(null);
      }
      try {
        const req = window.indexedDB.open('aether_audio_db', 3);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('track_eq')) {
            db.createObjectStore('track_eq', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('track_analysis')) {
            db.createObjectStore('track_analysis', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('track_transitions')) {
            db.createObjectStore('track_transitions', { keyPath: 'key' });
          }
        };
        req.onsuccess = (e) => {
          this.db = e.target.result;
          resolve(this.db);
        };
        req.onerror = (e) => {
          console.warn('[AudioDB] IndexedDB open error:', e);
          resolve(null);
        };
      } catch (err) {
        console.warn('[AudioDB] IndexedDB exception:', err);
        resolve(null);
      }
    });
    return this.initPromise;
  },

  async getTrackEq(trackId) {
    if (!trackId) return null;
    if (state.trackEqCache[trackId]) return state.trackEqCache[trackId];
    try {
      const db = await this.init();
      if (!db) return null;
      return new Promise((resolve) => {
        const tx = db.transaction('track_eq', 'readonly');
        const store = tx.objectStore('track_eq');
        const req = store.get(trackId);
        req.onsuccess = () => {
          const res = req.result;
          if (res) {
            state.trackEqCache[trackId] = res;
          }
          resolve(res || null);
        };
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      console.warn('[AudioDB] getTrackEq error:', e);
      return null;
    }
  },

  async saveTrackEq(trackId, eqData) {
    if (!trackId) return;
    state.trackEqCache[trackId] = { id: trackId, ...eqData, updatedAt: Date.now() };
    try {
      const db = await this.init();
      if (!db) return;
      const tx = db.transaction('track_eq', 'readwrite');
      const store = tx.objectStore('track_eq');
      store.put({ id: trackId, ...eqData, updatedAt: Date.now() });
    } catch (e) {
      console.warn('[AudioDB] saveTrackEq error:', e);
    }
  },

  async deleteTrackEq(trackId) {
    if (!trackId) return;
    delete state.trackEqCache[trackId];
    try {
      const db = await this.init();
      if (!db) return;
      const tx = db.transaction('track_eq', 'readwrite');
      const store = tx.objectStore('track_eq');
      store.delete(trackId);
    } catch (e) {
      console.warn('[AudioDB] deleteTrackEq error:', e);
    }
  },

  async getTrackAnalysis(trackId) {
    if (!trackId) return null;
    if (state.trackAnalysisCache && state.trackAnalysisCache[trackId]) {
      return state.trackAnalysisCache[trackId];
    }
    try {
      const db = await this.init();
      if (!db) return null;
      return new Promise((resolve) => {
        const tx = db.transaction('track_analysis', 'readonly');
        const store = tx.objectStore('track_analysis');
        const req = store.get(trackId);
        req.onsuccess = () => {
          const res = req.result;
          if (res) {
            if (!state.trackAnalysisCache) state.trackAnalysisCache = {};
            state.trackAnalysisCache[trackId] = res;
          }
          resolve(res || null);
        };
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      console.warn('[AudioDB] getTrackAnalysis error:', e);
      return null;
    }
  },

  async saveTrackAnalysis(trackId, analysisData) {
    if (!trackId || !analysisData) return;
    if (!state.trackAnalysisCache) state.trackAnalysisCache = {};
    state.trackAnalysisCache[trackId] = { id: trackId, ...analysisData, updatedAt: Date.now() };
    try {
      const db = await this.init();
      if (!db) return;
      const tx = db.transaction('track_analysis', 'readwrite');
      const store = tx.objectStore('track_analysis');
      store.put({ id: trackId, ...analysisData, updatedAt: Date.now() });
    } catch (e) {
      console.warn('[AudioDB] saveTrackAnalysis error:', e);
    }
  },

  async getTransition(key) {
    if (!key) return null;
    if (state.trackTransitionsCache && state.trackTransitionsCache[key]) {
      return state.trackTransitionsCache[key];
    }
    try {
      const db = await this.init();
      if (!db) return null;
      return new Promise((resolve) => {
        const tx = db.transaction('track_transitions', 'readonly');
        const store = tx.objectStore('track_transitions');
        const req = store.get(key);
        req.onsuccess = () => {
          const res = req.result;
          if (res) {
            if (!state.trackTransitionsCache) state.trackTransitionsCache = {};
            state.trackTransitionsCache[key] = res;
          }
          resolve(res || null);
        };
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      console.warn('[AudioDB] getTransition error:', e);
      return null;
    }
  },

  async saveTransition(key, data) {
    if (!key || !data) return;
    if (!state.trackTransitionsCache) state.trackTransitionsCache = {};
    const record = { key, ...data, updatedAt: Date.now() };
    state.trackTransitionsCache[key] = record;
    try {
      const db = await this.init();
      if (!db) return;
      const tx = db.transaction('track_transitions', 'readwrite');
      const store = tx.objectStore('track_transitions');
      store.put(record);
    } catch (e) {
      console.warn('[AudioDB] saveTransition error:', e);
    }
  }
};

let trackEqSaveDebounceTimer = null;

function loadMasterEqSettings() {
  try {
    const raw = localStorage.getItem('aether_master_eq');
    if (raw) {
      const parsed = JSON.parse(raw);
      state.masterEqSettings = {
        low: typeof parsed.low === 'number' ? parsed.low : parseFloat(parsed.low) || 0,
        mid: typeof parsed.mid === 'number' ? parsed.mid : parseFloat(parsed.mid) || 0,
        high: typeof parsed.high === 'number' ? parsed.high : parseFloat(parsed.high) || 0,
        preset: parsed.preset || 'custom'
      };
    }
  } catch (e) {}

  if (window.AetherAudioEngine && AetherAudioEngine.initialized) {
    AetherAudioEngine.setMasterEq(
      state.masterEqSettings.low,
      state.masterEqSettings.mid,
      state.masterEqSettings.high
    );
  }

  const bassSlider = document.getElementById('sliderMasterEqBass');
  const midSlider = document.getElementById('sliderMasterEqMid');
  const highSlider = document.getElementById('sliderMasterEqHigh');
  if (bassSlider) bassSlider.value = state.masterEqSettings.low;
  if (midSlider) midSlider.value = state.masterEqSettings.mid;
  if (highSlider) highSlider.value = state.masterEqSettings.high;

  const valBass = document.getElementById('valMasterEqBass');
  const valMid = document.getElementById('valMasterEqMid');
  const valHigh = document.getElementById('valMasterEqHigh');
  if (valBass) valBass.textContent = `${state.masterEqSettings.low >= 0 ? '+' : ''}${state.masterEqSettings.low.toFixed(1)} dB`;
  if (valMid) valMid.textContent = `${state.masterEqSettings.mid >= 0 ? '+' : ''}${state.masterEqSettings.mid.toFixed(1)} dB`;
  if (valHigh) valHigh.textContent = `${state.masterEqSettings.high >= 0 ? '+' : ''}${state.masterEqSettings.high.toFixed(1)} dB`;

  document.querySelectorAll('#masterEqPresetsList .preset-pill').forEach(pill => {
    pill.classList.toggle('active', pill.getAttribute('data-preset') === state.masterEqSettings.preset);
  });
}

function saveMasterEqSettings(settings) {
  state.masterEqSettings = { ...state.masterEqSettings, ...settings };
  try {
    localStorage.setItem('aether_master_eq', JSON.stringify(state.masterEqSettings));
  } catch (e) {}
}

function updateTrackEqUI(low, mid, high, isSaved) {
  const bassSlider = document.getElementById('sliderTrackEqBass');
  const midSlider = document.getElementById('sliderTrackEqMid');
  const highSlider = document.getElementById('sliderTrackEqHigh');
  if (bassSlider) bassSlider.value = low;
  if (midSlider) midSlider.value = mid;
  if (highSlider) highSlider.value = high;

  const numLow = parseFloat(low) || 0;
  const numMid = parseFloat(mid) || 0;
  const numHigh = parseFloat(high) || 0;

  const valBass = document.getElementById('valTrackEqBass');
  const valMid = document.getElementById('valTrackEqMid');
  const valHigh = document.getElementById('valTrackEqHigh');
  if (valBass) valBass.textContent = `${numLow >= 0 ? '+' : ''}${numLow.toFixed(1)} dB`;
  if (valMid) valMid.textContent = `${numMid >= 0 ? '+' : ''}${numMid.toFixed(1)} dB`;
  if (valHigh) valHigh.textContent = `${numHigh >= 0 ? '+' : ''}${numHigh.toFixed(1)} dB`;

  const dot = document.getElementById('mixerActiveDot');
  const indicator = document.getElementById('trackEqActiveIndicator');
  const hasCustomEq = isSaved || Math.abs(numLow) > 0.05 || Math.abs(numMid) > 0.05 || Math.abs(numHigh) > 0.05;

  if (dot) dot.style.display = hasCustomEq ? 'block' : 'none';
  if (indicator) indicator.style.display = hasCustomEq ? 'inline-block' : 'none';
}

function syncMixerModalTrackInfo(song) {
  const thumbEl = document.getElementById('mixerTrackThumb');
  const titleEl = document.getElementById('mixerTrackTitle');
  const artistEl = document.getElementById('mixerTrackArtist');

  if (!song) {
    if (titleEl) titleEl.textContent = 'No Song Playing';
    if (artistEl) artistEl.textContent = 'Play a song to customize its specific EQ';
    if (thumbEl) {
      thumbEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
    }
    updateTrackEqUI(0, 0, 0, false);
    return;
  }

  if (titleEl) titleEl.textContent = song.title || 'Unknown Title';
  if (artistEl) artistEl.textContent = song.artist || 'Unknown Artist';
  if (thumbEl) {
    if (song.thumbnail) {
      thumbEl.innerHTML = `<img src="${song.thumbnail}" alt="Art">`;
    } else {
      thumbEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
    }
  }

  AetherAudioDB.getTrackEq(song.id).then((saved) => {
    if (saved && (saved.low !== undefined || saved.mid !== undefined || saved.high !== undefined)) {
      const low = parseFloat(saved.low) || 0;
      const mid = parseFloat(saved.mid) || 0;
      const high = parseFloat(saved.high) || 0;
      AetherAudioEngine.setTrackEq(low, mid, high);
      updateTrackEqUI(low, mid, high, true);
    } else {
      AetherAudioEngine.resetTrackEq();
      updateTrackEqUI(0, 0, 0, false);
    }
  });
}

function openAudioMixerModal() {
  const modal = document.getElementById('modalAudioMixer');
  if (modal) {
    modal.classList.add('active');
    syncMixerModalTrackInfo(state.currentSong);
    loadMasterEqSettings();
    if (state.currentSong && typeof renderTrackDjAnalysis === 'function') {
      setTimeout(() => renderTrackDjAnalysis(state.currentSong), 50);
    }
  }
}

function closeAudioMixerModal() {
  const modal = document.getElementById('modalAudioMixer');
  if (modal) {
    modal.classList.remove('active');
  }
}

function setupAudioMixerEventListeners() {
  const btnToggleMixer = document.getElementById('btnToggleMixer');
  if (btnToggleMixer) {
    btnToggleMixer.addEventListener('click', (e) => {
      e.stopPropagation();
      openAudioMixerModal();
    });
  }

  const btnMobileNpMixer = document.getElementById('btnMobileNpMixer');
  if (btnMobileNpMixer) {
    btnMobileNpMixer.addEventListener('click', (e) => {
      e.stopPropagation();
      openAudioMixerModal();
    });
  }

  const btnCloseAudioMixer = document.getElementById('btnCloseAudioMixer');
  if (btnCloseAudioMixer) {
    btnCloseAudioMixer.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAudioMixerModal();
    });
  }

  const modalAudioMixer = document.getElementById('modalAudioMixer');
  if (modalAudioMixer) {
    modalAudioMixer.addEventListener('click', (e) => {
      if (e.target === modalAudioMixer) {
        closeAudioMixerModal();
      }
    });
  }

  // Keydown Escape to close mixer modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalAudioMixer && modalAudioMixer.classList.contains('active')) {
      closeAudioMixerModal();
    }
  });

  // Mixer Subtabs switching
  document.querySelectorAll('.mixer-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mixer-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.getAttribute('data-mixertab');
      const paneTrack = document.getElementById('mixerPaneTrack');
      const paneMaster = document.getElementById('mixerPaneMaster');
      if (tab === 'track') {
        if (paneTrack) paneTrack.style.display = 'block';
        if (paneMaster) paneMaster.style.display = 'none';
      } else {
        if (paneTrack) paneTrack.style.display = 'none';
        if (paneMaster) paneMaster.style.display = 'block';
      }
    });
  });

  // Track EQ Sliders (Real-time Web Audio DSP + Debounced Persistence)
  function handleTrackSliderInput() {
    const low = parseFloat(document.getElementById('sliderTrackEqBass')?.value || 0);
    const mid = parseFloat(document.getElementById('sliderTrackEqMid')?.value || 0);
    const high = parseFloat(document.getElementById('sliderTrackEqHigh')?.value || 0);

    AetherAudioEngine.setTrackEq(low, mid, high);
    updateTrackEqUI(low, mid, high, true);

    if (state.currentSong) {
      clearTimeout(trackEqSaveDebounceTimer);
      trackEqSaveDebounceTimer = setTimeout(() => {
        AetherAudioDB.saveTrackEq(state.currentSong.id, { low, mid, high });
      }, 250);
    }
  }

  ['sliderTrackEqBass', 'sliderTrackEqMid', 'sliderTrackEqHigh'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', handleTrackSliderInput);
    }
  });

  // Reset Track EQ
  const btnResetTrackEq = document.getElementById('btnResetTrackEq');
  if (btnResetTrackEq) {
    btnResetTrackEq.addEventListener('click', () => {
      AetherAudioEngine.resetTrackEq();
      updateTrackEqUI(0, 0, 0, false);
      if (state.currentSong) {
        clearTimeout(trackEqSaveDebounceTimer);
        AetherAudioDB.deleteTrackEq(state.currentSong.id);
        showToast('Track EQ reset to flat');
      }
    });
  }

  // Master EQ Sliders (Real-time Web Audio DSP + LocalStorage Persistence)
  function handleMasterSliderInput() {
    const low = parseFloat(document.getElementById('sliderMasterEqBass')?.value || 0);
    const mid = parseFloat(document.getElementById('sliderMasterEqMid')?.value || 0);
    const high = parseFloat(document.getElementById('sliderMasterEqHigh')?.value || 0);

    AetherAudioEngine.setMasterEq(low, mid, high);

    const valBass = document.getElementById('valMasterEqBass');
    const valMid = document.getElementById('valMasterEqMid');
    const valHigh = document.getElementById('valMasterEqHigh');
    if (valBass) valBass.textContent = `${low >= 0 ? '+' : ''}${low.toFixed(1)} dB`;
    if (valMid) valMid.textContent = `${mid >= 0 ? '+' : ''}${mid.toFixed(1)} dB`;
    if (valHigh) valHigh.textContent = `${high >= 0 ? '+' : ''}${high.toFixed(1)} dB`;

    document.querySelectorAll('#masterEqPresetsList .preset-pill').forEach(p => p.classList.remove('active'));

    saveMasterEqSettings({ low, mid, high, preset: 'custom' });
  }

  ['sliderMasterEqBass', 'sliderMasterEqMid', 'sliderMasterEqHigh'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', handleMasterSliderInput);
    }
  });

  // Master EQ Preset Pills
  document.querySelectorAll('#masterEqPresetsList .preset-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const presetKey = pill.getAttribute('data-preset');
      const preset = MASTER_EQ_PRESETS[presetKey];
      if (!preset) return;

      document.querySelectorAll('#masterEqPresetsList .preset-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');

      const bassSlider = document.getElementById('sliderMasterEqBass');
      const midSlider = document.getElementById('sliderMasterEqMid');
      const highSlider = document.getElementById('sliderMasterEqHigh');
      if (bassSlider) bassSlider.value = preset.low;
      if (midSlider) midSlider.value = preset.mid;
      if (highSlider) highSlider.value = preset.high;

      const valBass = document.getElementById('valMasterEqBass');
      const valMid = document.getElementById('valMasterEqMid');
      const valHigh = document.getElementById('valMasterEqHigh');
      if (valBass) valBass.textContent = `${preset.low >= 0 ? '+' : ''}${preset.low.toFixed(1)} dB`;
      if (valMid) valMid.textContent = `${preset.mid >= 0 ? '+' : ''}${preset.mid.toFixed(1)} dB`;
      if (valHigh) valHigh.textContent = `${preset.high >= 0 ? '+' : ''}${preset.high.toFixed(1)} dB`;

      AetherAudioEngine.setMasterEq(preset.low, preset.mid, preset.high);
      saveMasterEqSettings({ low: preset.low, mid: preset.mid, high: preset.high, preset: presetKey });
      showToast(`Master EQ: ${pill.textContent}`);
    });
  });

  // Attach interactive seeking to all waveform canvases
  setupWaveformScrubbers();
}

// ============================================================================
// AETHER MULTI-BAND WAVEFORM & DJ AUDIO ENGINE (v2.0.0)
// ============================================================================
const CAMELOT_KEY_MAP = {
  // Minor Keys (A)
  'Abm': { camelot: '1A', name: 'G# Minor' },
  'G#m': { camelot: '1A', name: 'G# Minor' },
  'Ebm': { camelot: '2A', name: 'D# Minor' },
  'D#m': { camelot: '2A', name: 'D# Minor' },
  'Bbm': { camelot: '3A', name: 'Bb Minor' },
  'A#m': { camelot: '3A', name: 'Bb Minor' },
  'Fm':  { camelot: '4A', name: 'F Minor' },
  'Cm':  { camelot: '5A', name: 'C Minor' },
  'Gm':  { camelot: '6A', name: 'G Minor' },
  'Dm':  { camelot: '7A', name: 'D Minor' },
  'Am':  { camelot: '8A', name: 'A Minor' },
  'Em':  { camelot: '9A', name: 'E Minor' },
  'Bm':  { camelot: '10A', name: 'B Minor' },
  'F#m': { camelot: '11A', name: 'F# Minor' },
  'Gbm': { camelot: '11A', name: 'F# Minor' },
  'C#m': { camelot: '12A', name: 'C# Minor' },
  'Dbm': { camelot: '12A', name: 'C# Minor' },

  // Major Keys (B)
  'B':   { camelot: '1B', name: 'B Major' },
  'F#':  { camelot: '2B', name: 'F# Major' },
  'Gb':  { camelot: '2B', name: 'F# Major' },
  'Db':  { camelot: '3B', name: 'Db Major' },
  'C#':  { camelot: '3B', name: 'Db Major' },
  'Ab':  { camelot: '4B', name: 'Ab Major' },
  'G#':  { camelot: '4B', name: 'Ab Major' },
  'Eb':  { camelot: '5B', name: 'Eb Major' },
  'D#':  { camelot: '5B', name: 'Eb Major' },
  'Bb':  { camelot: '6B', name: 'Bb Major' },
  'A#':  { camelot: '6B', name: 'Bb Major' },
  'F':   { camelot: '7B', name: 'F Major' },
  'C':   { camelot: '8B', name: 'C Major' },
  'G':   { camelot: '9B', name: 'G Major' },
  'D':   { camelot: '10B', name: 'D Major' },
  'A':   { camelot: '11B', name: 'A Major' },
  'E':   { camelot: '12B', name: 'E Major' }
};

const CAMELOT_COLORS = {
  '1': '#06b6d4',
  '2': '#10b981',
  '3': '#84cc16',
  '4': '#eab308',
  '5': '#f97316',
  '6': '#ea580c',
  '7': '#ef4444',
  '8': '#ec4899',
  '9': '#d946ef',
  '10': '#8b5cf6',
  '11': '#6366f1',
  '12': '#3b82f6'
};

function getCamelotColor(camelotCode) {
  if (!camelotCode) return '#704bf4';
  const num = camelotCode.replace(/[^0-9]/g, '');
  return CAMELOT_COLORS[num] || '#704bf4';
}

const AetherAudioAnalyzer = {
  getCamelotInfo(keyName, mode = 1) {
    if (!keyName) return { camelot: '8B', name: 'C Major', key: 'C', mode: 'major' };
    const cleanKey = keyName.trim();
    if (CAMELOT_KEY_MAP[cleanKey]) {
      return { ...CAMELOT_KEY_MAP[cleanKey], key: cleanKey };
    }
    const isMinor = cleanKey.toLowerCase().includes('m') || mode === 0;
    const root = cleanKey.replace(/[mMinormajor\s]/gi, '');
    const lookup = isMinor ? `${root}m` : root;
    return CAMELOT_KEY_MAP[lookup] || { camelot: '8B', name: `${cleanKey} Major`, key: cleanKey, mode: isMinor ? 'minor' : 'major' };
  },

  getHarmonicCompatibility(camelotA, camelotB) {
    if (!camelotA || !camelotB) return { type: 'neutral', label: 'Neutral', score: 0 };
    if (camelotA === camelotB) return { type: 'perfect', label: 'Harmonic Match (Same Key)', score: 100 };

    const numA = parseInt(camelotA, 10);
    const letA = camelotA.slice(-1).toUpperCase();
    const numB = parseInt(camelotB, 10);
    const letB = camelotB.slice(-1).toUpperCase();

    if (letA === letB && ((numA % 12) + 1) === numB) {
      return { type: 'lift', label: 'Harmonic Match (+1 Energy)', score: 90 };
    }
    if (letA === letB && (((numA - 2 + 12) % 12) + 1) === numB) {
      return { type: 'drop', label: 'Harmonic Match (-1 Energy)', score: 85 };
    }
    if (numA === numB && letA !== letB) {
      return { type: 'mode_shift', label: 'Harmonic Match (Mode Shift)', score: 88 };
    }
    if (letA === letB && (((numA + 1) % 12) + 1) === numB) {
      return { type: 'surge', label: 'Harmonic Boost (+2 Surge)', score: 75 };
    }

    return { type: 'clash', label: 'Key Shift', score: 40 };
  },

  generateDeterministicPeaks(seedStr, numBins = 300) {
    let hash = 0;
    for (let i = 0; i < seedStr.length; i++) {
      hash = ((hash << 5) - hash) + seedStr.charCodeAt(i);
      hash |= 0;
    }
    const seed = Math.abs(hash) || 1234567;

    function pseudo(n) {
      const x = Math.sin(seed + n * 12.9898) * 43758.5453;
      return x - Math.floor(x);
    }

    const lows = new Float32Array(numBins);
    const mids = new Float32Array(numBins);
    const highs = new Float32Array(numBins);

    for (let i = 0; i < numBins; i++) {
      const pos = i / numBins;
      let macroEnergy = 0.5;

      if (pos < 0.15) {
        macroEnergy = 0.25 + (pos / 0.15) * 0.45;
      } else if (pos < 0.45) {
        macroEnergy = 0.75 + pseudo(i * 3) * 0.22;
      } else if (pos < 0.58) {
        macroEnergy = 0.35 + pseudo(i * 2) * 0.25;
      } else if (pos < 0.88) {
        macroEnergy = 0.82 + pseudo(i * 4) * 0.18;
      } else {
        macroEnergy = 0.65 * (1 - (pos - 0.88) / 0.12);
      }

      const noise = pseudo(i * 7);
      const beat = (i % 8 === 0 || i % 8 === 4) ? 0.25 : 0;

      lows[i] = Math.min(1.0, Math.max(0.08, macroEnergy * (0.6 + noise * 0.3) + beat));
      mids[i] = Math.min(1.0, Math.max(0.12, macroEnergy * (0.7 + pseudo(i * 11) * 0.28)));
      highs[i] = Math.min(1.0, Math.max(0.05, macroEnergy * (0.5 + pseudo(i * 13) * 0.45)));
    }

    const bpmEstimate = 95 + (Math.abs(hash) % 55);
    const camelotKeys = [
      '1A', '2A', '3A', '4A', '5A', '6A', '7A', '8A', '9A', '10A', '11A', '12A',
      '1B', '2B', '3B', '4B', '5B', '6B', '7B', '8B', '9B', '10B', '11B', '12B'
    ];
    const keyIndex = Math.abs(hash >> 3) % camelotKeys.length;
    const camelotKey = camelotKeys[keyIndex];

    return {
      bpm: bpmEstimate,
      camelot: camelotKey,
      keyName: camelotKey,
      peaks: {
        lows: Array.from(lows),
        mids: Array.from(mids),
        highs: Array.from(highs)
      },
      isEstimated: true
    };
  },

  async getOrAnalyzeTrack(song) {
    if (!song || !song.id) return null;
    const trackId = song.id;

    if (state.trackAnalysisCache && state.trackAnalysisCache[trackId]) {
      return state.trackAnalysisCache[trackId];
    }

    const saved = await AetherAudioDB.getTrackAnalysis(trackId);
    if (saved && saved.peaks && saved.bpm) {
      if (!state.trackAnalysisCache) state.trackAnalysisCache = {};
      state.trackAnalysisCache[trackId] = saved;
      return saved;
    }

    const seed = `${song.id}_${song.title || ''}_${song.artist || ''}`;
    const estimated = this.generateDeterministicPeaks(seed, 300);

    if (!state.trackAnalysisCache) state.trackAnalysisCache = {};
    state.trackAnalysisCache[trackId] = estimated;

    AetherAudioDB.saveTrackAnalysis(trackId, estimated);

    return estimated;
  }
};

function drawMultiBandWaveform(canvas, analysis, progressPct = 0) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const targetW = Math.round(rect.width * dpr);
  const targetH = Math.round(rect.height * dpr);

  if (targetW > 0 && targetH > 0 && (canvas.width !== targetW || canvas.height !== targetH)) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  if (!analysis || !analysis.peaks || !analysis.peaks.lows) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    return;
  }

  const { lows, mids, highs } = analysis.peaks;
  const count = lows.length;
  if (count === 0) return;

  const barWidth = Math.max(1.8, width / count);
  const gap = 1;
  const midY = height / 2;
  const maxBarH = midY * 0.92;

  const playheadX = Math.max(0, Math.min(width, progressPct * width));

  for (let i = 0; i < count; i++) {
    const x = i * (width / count);
    const isPlayed = x <= playheadX;

    const lowH = Math.max(2, (lows[i] || 0.1) * maxBarH);
    const midH = Math.max(3, (mids[i] || 0.15) * maxBarH * 0.85);
    const highH = Math.max(4, (highs[i] || 0.2) * maxBarH * 0.7);

    // 1. High frequencies (outer top/bottom, cyan/blue)
    ctx.fillStyle = isPlayed ? 'rgba(56, 189, 248, 0.9)' : 'rgba(56, 189, 248, 0.22)';
    ctx.fillRect(x, midY - highH, barWidth - gap, highH * 2);

    // 2. Mid frequencies (warm amber/orange)
    ctx.fillStyle = isPlayed ? 'rgba(245, 158, 11, 0.95)' : 'rgba(245, 158, 11, 0.25)';
    ctx.fillRect(x, midY - midH, barWidth - gap, midH * 2);

    // 3. Low frequencies (center core, crisp white)
    ctx.fillStyle = isPlayed ? '#ffffff' : 'rgba(255, 255, 255, 0.35)';
    ctx.fillRect(x, midY - lowH, barWidth - gap, lowH * 2);
  }

  // Draw Glowing Playhead Cursor Line
  if (progressPct >= 0 && progressPct <= 1) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2 * dpr;
    ctx.shadowColor = 'rgba(124, 58, 237, 0.9)';
    ctx.shadowBlur = 8 * dpr;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

let currentAnalysisTrackId = null;

async function renderTrackDjAnalysis(song) {
  if (!song) return;
  currentAnalysisTrackId = song.id;

  const analysis = await AetherAudioAnalyzer.getOrAnalyzeTrack(song);
  if (!analysis || currentAnalysisTrackId !== song.id) return;

  const color = getCamelotColor(analysis.camelot);

  // 1. Right Sidebar Details
  const rightSec = document.getElementById('rightDjAnalysisSection');
  if (rightSec) rightSec.style.display = 'block';

  const valRightBpm = document.getElementById('valRightBpm');
  if (valRightBpm) valRightBpm.textContent = `${analysis.bpm} BPM`;

  const valRightKey = document.getElementById('valRightKey');
  if (valRightKey) valRightKey.textContent = `${analysis.camelot} • ${analysis.keyName || analysis.camelot}`;

  const badgeRightKey = document.getElementById('badgeRightKey');
  if (badgeRightKey) {
    badgeRightKey.style.borderColor = `${color}88`;
    badgeRightKey.style.background = `${color}1a`;
    badgeRightKey.style.color = '#ffffff';
  }

  const valRightEnergy = document.getElementById('valRightEnergy');
  if (valRightEnergy) {
    const energyLabel = analysis.bpm >= 130 ? 'High' : (analysis.bpm >= 105 ? 'Medium' : 'Chilled');
    valRightEnergy.textContent = energyLabel;
  }

  const rightMatchPill = document.getElementById('rightDjMatchPill');
  if (rightMatchPill && state.playQueue && state.currentQueueIndex > 0) {
    const prevSong = state.playQueue[state.currentQueueIndex - 1];
    if (prevSong && state.trackAnalysisCache && state.trackAnalysisCache[prevSong.id]) {
      const prevAnalysis = state.trackAnalysisCache[prevSong.id];
      const match = AetherAudioAnalyzer.getHarmonicCompatibility(prevAnalysis.camelot, analysis.camelot);
      if (match.type !== 'clash') {
        rightMatchPill.textContent = match.label;
        rightMatchPill.style.display = 'inline-block';
        rightMatchPill.style.background = `${color}33`;
        rightMatchPill.style.borderColor = color;
      } else {
        rightMatchPill.style.display = 'none';
      }
    } else {
      rightMatchPill.style.display = 'none';
    }
  }

  // 2. Mixer Modal
  const valMixerBpm = document.getElementById('valMixerBpm');
  if (valMixerBpm) valMixerBpm.textContent = `${analysis.bpm}`;

  const valMixerKey = document.getElementById('valMixerKey');
  if (valMixerKey) valMixerKey.textContent = `${analysis.camelot}`;

  const mixerKeyBadge = document.getElementById('mixerKeyBadge');
  if (mixerKeyBadge) {
    mixerKeyBadge.style.borderColor = `${color}88`;
    mixerKeyBadge.style.background = `${color}20`;
  }

  // 3. Mobile Now Playing
  const valMobileBpm = document.getElementById('valMobileNpBpm');
  if (valMobileBpm) valMobileBpm.textContent = `${analysis.bpm}`;

  const valMobileKey = document.getElementById('valMobileNpKey');
  if (valMobileKey) valMobileKey.textContent = `${analysis.camelot}`;

  const mobileKeyPill = document.getElementById('mobileNpKeyPill');
  if (mobileKeyPill) {
    mobileKeyPill.style.borderColor = `${color}88`;
    mobileKeyPill.style.background = `${color}20`;
  }

  // 4. Initial Waveform Render
  const currentRatio = state.duration > 0 ? (state.playbackPosition / state.duration) : 0;
  updateActiveWaveformsPlayhead(currentRatio, analysis);
}

function updateActiveWaveformsPlayhead(ratio, analysisOverride = null) {
  if (!state.currentSong) return;
  const analysis = analysisOverride || (state.trackAnalysisCache && state.trackAnalysisCache[state.currentSong.id]);
  if (!analysis) return;

  const rightCanvas = document.getElementById('rightWaveformCanvas');
  if (rightCanvas && rightCanvas.offsetParent !== null) {
    drawMultiBandWaveform(rightCanvas, analysis, ratio);
  }

  const mixerCanvas = document.getElementById('mixerWaveformCanvas');
  const mixerModal = document.getElementById('modalAudioMixer');
  if (mixerCanvas && mixerModal && mixerModal.classList.contains('active')) {
    drawMultiBandWaveform(mixerCanvas, analysis, ratio);
  }

  const mobileCanvas = document.getElementById('mobileNpWaveformCanvas');
  const mobileSheet = document.getElementById('mobileNowPlayingModal');
  if (mobileCanvas && mobileSheet && mobileSheet.classList.contains('active')) {
    drawMultiBandWaveform(mobileCanvas, analysis, ratio);
  }
}

function setupWaveformScrubbers() {
  ['rightWaveformCanvas', 'mixerWaveformCanvas', 'mobileNpWaveformCanvas'].forEach(canvasId => {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    let isPointerDown = false;

    function handleScrub(e) {
      const rect = canvas.getBoundingClientRect();
      const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const pct = rect.width > 0 ? x / rect.width : 0;
      seekToPercentage(pct);
      updateActiveWaveformsPlayhead(pct);
    }

    canvas.addEventListener('pointerdown', (e) => {
      isPointerDown = true;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      handleScrub(e);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (isPointerDown) {
        handleScrub(e);
      }
    });

    const endScrub = (e) => {
      if (isPointerDown) {
        isPointerDown = false;
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
      }
    };

    canvas.addEventListener('pointerup', endScrub);
    canvas.addEventListener('pointercancel', endScrub);
  });
}

// ============================================================================
// AETHER DJ TRANSITION STUDIO (Pacemaker DJ Architecture v2.0.0)
// ============================================================================
// ============================================================================
// AETHER DJ TRANSITION STUDIO (Pacemaker DJ Architecture v2.0.0)
// ============================================================================
const AetherDjStudio = {
  isAuditioning: false,
  auditionRafId: null,
  auditionStartTime: 0,
  playheadProgress: 0.0,
  analysisA: null,
  analysisB: null,
  draggingHandle: null,

  // Curve control points (normalized 0.0 to 1.0)
  curves: {
    // Deck A volume (outgoing): starts at 1.0, ramps down to 0.0
    outVolume: [
      { x: 0.0, y: 1.0, fixed: true },
      { x: 0.65, y: 0.95 },
      { x: 1.0, y: 0.0, fixed: true }
    ],
    // Deck B volume (incoming): starts at 0.0, ramps up to 1.0
    inVolume: [
      { x: 0.0, y: 0.0, fixed: true },
      { x: 0.35, y: 0.05 },
      { x: 1.0, y: 1.0, fixed: true }
    ],
    // EQ Bass crossover X position (0.15 to 0.85)
    bassCrossover: 0.50,
    // Filter / FX automation points (Purple)
    filterFx: [
      { x: 0.0, y: 0.0, fixed: true },
      { x: 0.50, y: 0.15 },
      { x: 0.80, y: 0.75 },
      { x: 1.0, y: 0.0, fixed: true }
    ]
  },

  openModal() {
    const modal = document.getElementById('modalDjTransition');
    if (!modal) return;
    modal.classList.add('active');

    // Deck A: currently playing track
    const outgoing = state.currentSong;

    // Deck B: upcoming track in queue
    let incoming = null;
    if (state.playQueue && state.playQueue.length > state.currentQueueIndex + 1) {
      incoming = state.playQueue[state.currentQueueIndex + 1];
    } else if (state.playQueue && state.playQueue.length > 0 && state.currentQueueIndex === state.playQueue.length - 1) {
      incoming = state.playQueue[0];
    }

    this.renderStudioUI(outgoing, incoming);
  },

  closeModal() {
    const modal = document.getElementById('modalDjTransition');
    if (modal) {
      modal.classList.remove('active');
    }
    this.stopAudition();
  },

  async renderStudioUI(songA, songB) {
    // 1. Deck A Pill Render
    const titleA = document.getElementById('deckATitle');
    const artistA = document.getElementById('deckAArtist');
    const thumbA = document.getElementById('deckAThumb');
    const bpmValA = document.getElementById('valDeckABpm');
    const keyValA = document.getElementById('valDeckAKey');
    const keyBadgeA = document.getElementById('deckAKeyBadge');

    this.analysisA = null;
    if (songA) {
      if (titleA) titleA.textContent = songA.title || 'Unknown Title';
      if (artistA) artistA.textContent = songA.artist || 'Unknown Artist';
      if (thumbA) {
        if (songA.thumbnail) {
          thumbA.innerHTML = `<img src="${songA.thumbnail}" alt="Art">`;
        } else {
          thumbA.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
        }
      }
      this.analysisA = await AetherAudioAnalyzer.getOrAnalyzeTrack(songA);
      if (this.analysisA) {
        if (bpmValA) bpmValA.textContent = this.analysisA.bpm;
        if (keyValA) keyValA.textContent = this.analysisA.camelot;
        if (keyBadgeA) {
          const color = getCamelotColor(this.analysisA.camelot);
          keyBadgeA.style.borderColor = `${color}88`;
          keyBadgeA.style.background = `${color}20`;
        }
      }
    } else {
      if (titleA) titleA.textContent = 'No Outgoing Track';
      if (artistA) artistA.textContent = 'Play a song to configure transitions';
      if (bpmValA) bpmValA.textContent = '--';
      if (keyValA) keyValA.textContent = '--';
    }

    // 2. Deck B Pill Render
    const titleB = document.getElementById('deckBTitle');
    const artistB = document.getElementById('deckBArtist');
    const thumbB = document.getElementById('deckBThumb');
    const bpmValB = document.getElementById('valDeckBBpm');
    const keyValB = document.getElementById('valDeckBKey');
    const keyBadgeB = document.getElementById('deckBKeyBadge');

    this.analysisB = null;
    if (songB) {
      if (titleB) titleB.textContent = songB.title || 'Unknown Title';
      if (artistB) artistB.textContent = songB.artist || 'Unknown Artist';
      if (thumbB) {
        if (songB.thumbnail) {
          thumbB.innerHTML = `<img src="${songB.thumbnail}" alt="Art">`;
        } else {
          thumbB.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
        }
      }
      this.analysisB = await AetherAudioAnalyzer.getOrAnalyzeTrack(songB);
      if (this.analysisB) {
        if (bpmValB) bpmValB.textContent = this.analysisB.bpm;
        if (keyValB) keyValB.textContent = this.analysisB.camelot;
        if (keyBadgeB) {
          const color = getCamelotColor(this.analysisB.camelot);
          keyBadgeB.style.borderColor = `${color}88`;
          keyBadgeB.style.background = `${color}20`;
        }
      }
    } else {
      if (titleB) titleB.textContent = 'No Next Track';
      if (artistB) artistB.textContent = 'Queue a second song to audition transition';
      if (bpmValB) bpmValB.textContent = '--';
      if (keyValB) keyValB.textContent = '--';
    }

    // 3. Load Saved Transition (if any exists)
    if (songA) {
      const transKey = songB ? `${songA.id}_to_${songB.id}` : `${songA.id}_default`;
      const saved = await AetherAudioDB.getTransition(transKey) || await AetherAudioDB.getTransition(`${songA.id}_default`);
      if (saved) {
        state.djTransitionSettings.bars = saved.bars || state.djTransitionSettings.bars;
        state.djTransitionSettings.curveType = saved.curveType || state.djTransitionSettings.curveType;
        if (saved.curves) {
          this.curves = saved.curves;
        } else {
          this.applyPreset(state.djTransitionSettings.curveType, false);
        }
        if (saved.filterVolume) {
          const selVol = document.getElementById('selFilterVolume');
          if (selVol) selVol.value = saved.filterVolume;
        }
        if (saved.filterEq) {
          const selEq = document.getElementById('selFilterEq');
          if (selEq) selEq.value = saved.filterEq;
        }
        if (saved.filterFx) {
          const selFx = document.getElementById('selFilterFx');
          if (selFx) selFx.value = saved.filterFx;
        }
      } else {
        this.applyPreset(state.djTransitionSettings.curveType || 'bass_swap', false);
      }
    } else {
      this.applyPreset(state.djTransitionSettings.curveType || 'bass_swap', false);
    }

    // 4. Update Preset Selector, Toggle UI, and Duration
    const topPresetSel = document.getElementById('selTransitionPreset');
    if (topPresetSel) {
      topPresetSel.value = state.djTransitionSettings.curveType || 'bass_swap';
    }

    this.updateToggleUI();
    this.updateDuration(this.analysisA);
    this.updateBarPills();
    this.drawStage();
  },

  updateDuration(analysisA = null) {
    const bpm = (analysisA && analysisA.bpm) ? analysisA.bpm : 120;
    const durSecs = parseFloat((state.djTransitionSettings.bars * (240 / bpm)).toFixed(1));
    state.djTransitionSettings.durationSeconds = durSecs;

    const valDuration = document.getElementById('valTransitionDuration');
    if (valDuration) {
      valDuration.textContent = `${durSecs}s`;
    }
  },

  updateBarPills() {
    document.querySelectorAll('#transitionBarSelector .dj-selector-pill').forEach(pill => {
      const b = parseInt(pill.getAttribute('data-bars'), 10);
      pill.classList.toggle('active', b === state.djTransitionSettings.bars);
    });
  },

  applyPreset(presetKey, updatePresetDropdown = true) {
    state.djTransitionSettings.curveType = presetKey;
    const selVol = document.getElementById('selFilterVolume');
    const selEq = document.getElementById('selFilterEq');
    const selFx = document.getElementById('selFilterFx');

    if (presetKey === 'bass_swap') {
      this.curves.outVolume = [
        { x: 0.0, y: 1.0, fixed: true },
        { x: 0.60, y: 0.85 },
        { x: 1.0, y: 0.0, fixed: true }
      ];
      this.curves.inVolume = [
        { x: 0.0, y: 0.0, fixed: true },
        { x: 0.40, y: 0.15 },
        { x: 1.0, y: 1.0, fixed: true }
      ];
      this.curves.bassCrossover = 0.50;
      this.curves.filterFx = [
        { x: 0.0, y: 0.0, fixed: true },
        { x: 0.50, y: 0.0 },
        { x: 0.80, y: 0.0 },
        { x: 1.0, y: 0.0, fixed: true }
      ];
      if (selVol) selVol.value = 'equal_power';
      if (selEq) selEq.value = 'bass_swap';
      if (selFx) selFx.value = 'none';
    } else if (presetKey === 'equal_power') {
      this.curves.outVolume = [
        { x: 0.0, y: 1.0, fixed: true },
        { x: 0.50, y: 0.707 },
        { x: 1.0, y: 0.0, fixed: true }
      ];
      this.curves.inVolume = [
        { x: 0.0, y: 0.0, fixed: true },
        { x: 0.50, y: 0.707 },
        { x: 1.0, y: 1.0, fixed: true }
      ];
      this.curves.bassCrossover = 0.50;
      this.curves.filterFx = [
        { x: 0.0, y: 0.0, fixed: true },
        { x: 0.50, y: 0.0 },
        { x: 0.80, y: 0.0 },
        { x: 1.0, y: 0.0, fixed: true }
      ];
      if (selVol) selVol.value = 'equal_power';
      if (selEq) selEq.value = 'neutral';
      if (selFx) selFx.value = 'none';
    } else if (presetKey === 'drop_cut') {
      this.curves.outVolume = [
        { x: 0.0, y: 1.0, fixed: true },
        { x: 0.88, y: 1.0 },
        { x: 1.0, y: 0.0, fixed: true }
      ];
      this.curves.inVolume = [
        { x: 0.0, y: 0.0, fixed: true },
        { x: 0.88, y: 0.0 },
        { x: 1.0, y: 1.0, fixed: true }
      ];
      this.curves.bassCrossover = 0.88;
      this.curves.filterFx = [
        { x: 0.0, y: 0.0, fixed: true },
        { x: 0.50, y: 0.0 },
        { x: 0.80, y: 0.0 },
        { x: 1.0, y: 0.0, fixed: true }
      ];
      if (selVol) selVol.value = 'drop_cut';
      if (selEq) selEq.value = 'bass_swap';
      if (selFx) selFx.value = 'none';
    } else if (presetKey === 'hipass_sweep') {
      this.curves.outVolume = [
        { x: 0.0, y: 1.0, fixed: true },
        { x: 0.65, y: 0.90 },
        { x: 1.0, y: 0.0, fixed: true }
      ];
      this.curves.inVolume = [
        { x: 0.0, y: 0.0, fixed: true },
        { x: 0.40, y: 0.20 },
        { x: 1.0, y: 1.0, fixed: true }
      ];
      this.curves.bassCrossover = 0.50;
      this.curves.filterFx = [
        { x: 0.0, y: 0.0, fixed: true },
        { x: 0.45, y: 0.25 },
        { x: 0.85, y: 0.85 },
        { x: 1.0, y: 0.0, fixed: true }
      ];
      if (selVol) selVol.value = 'equal_power';
      if (selEq) selEq.value = 'low_cut';
      if (selFx) selFx.value = 'hipass_sweep';
    } else if (presetKey === 'smooth_blend') {
      this.curves.outVolume = [
        { x: 0.0, y: 1.0, fixed: true },
        { x: 0.50, y: 0.50 },
        { x: 1.0, y: 0.0, fixed: true }
      ];
      this.curves.inVolume = [
        { x: 0.0, y: 0.0, fixed: true },
        { x: 0.50, y: 0.50 },
        { x: 1.0, y: 1.0, fixed: true }
      ];
      this.curves.bassCrossover = 0.50;
      this.curves.filterFx = [
        { x: 0.0, y: 0.0, fixed: true },
        { x: 0.50, y: 0.0 },
        { x: 0.80, y: 0.0 },
        { x: 1.0, y: 0.0, fixed: true }
      ];
      if (selVol) selVol.value = 'linear';
      if (selEq) selEq.value = 'neutral';
      if (selFx) selFx.value = 'none';
    }

    if (updatePresetDropdown) {
      const topPresetSel = document.getElementById('selTransitionPreset');
      if (topPresetSel) topPresetSel.value = presetKey;
    }

    this.drawStage();
  },

  // Synthesize realistic rhythmic multi-band waveform peaks if raw peaks aren't ready
  _synthesizePeaks(seedStr, count = 160) {
    let hash = 0;
    for (let i = 0; i < seedStr.length; i++) {
      hash = ((hash << 5) - hash) + seedStr.charCodeAt(i);
      hash |= 0;
    }
    const seed = Math.abs(hash) || 7654321;
    function pseudo(n) {
      const x = Math.sin(seed + n * 12.9898) * 43758.5453;
      return x - Math.floor(x);
    }

    const lows = new Float32Array(count);
    const mids = new Float32Array(count);
    const highs = new Float32Array(count);

    const isDeckA = seedStr.includes('deckA') || seedStr.includes('outgoing');

    for (let i = 0; i < count; i++) {
      const frac = i / (count - 1);
      // Macro dynamic energy curve:
      // Outgoing track: high energy verse/drop fading into transitional breakdown
      // Incoming track: rhythmic kick build swelling into full drop
      let macroEnergy = 0.65;
      if (isDeckA) {
        macroEnergy = 0.88 - Math.pow(frac, 1.4) * 0.28 + pseudo(i * 3) * 0.15;
      } else {
        macroEnergy = 0.55 + Math.pow(frac, 1.2) * 0.38 + pseudo(i * 3) * 0.15;
      }

      // 4/4 Beat transient pattern (16 subdivisions per phrase)
      const beatStep = i % 16;
      const isKick = (beatStep === 0 || beatStep === 4 || beatStep === 8 || beatStep === 12);
      const isSnare = (beatStep === 4 || beatStep === 12);
      const isHat = (beatStep % 2 === 0);

      const kickPunch = isKick ? (0.35 + pseudo(i * 5) * 0.25) : 0;
      const snareSnap = isSnare ? (0.30 + pseudo(i * 7) * 0.22) : 0;
      const hatFlutter = isHat ? (0.22 + pseudo(i * 11) * 0.18) : 0.05;

      const randomMelody = pseudo(i * 13) * 0.25;

      // Lows (Deep bass and kick drums - bright white core)
      lows[i] = Math.max(0.12, Math.min(1.0, (macroEnergy * 0.55) + kickPunch + randomMelody * 0.2));
      // Mids (Vocals, guitars, brass - rich golden bronze)
      mids[i] = Math.max(0.18, Math.min(1.0, (macroEnergy * 0.62) + snareSnap + randomMelody * 0.35));
      // Highs (Hi-hats, cymbals, air - electric blue outer body)
      highs[i] = Math.max(0.25, Math.min(1.0, (macroEnergy * 0.70) + hatFlutter + randomMelody * 0.4));
    }

    // 3-point smoothing to make envelope continuous and organic
    for (let i = 1; i < count - 1; i++) {
      lows[i] = (lows[i - 1] * 0.25) + (lows[i] * 0.5) + (lows[i + 1] * 0.25);
      mids[i] = (mids[i - 1] * 0.25) + (mids[i] * 0.5) + (mids[i + 1] * 0.25);
      highs[i] = (highs[i - 1] * 0.25) + (highs[i] * 0.5) + (highs[i + 1] * 0.25);
    }

    return { lows, mids, highs };
  },

  // Draw unified dual-deck stage with last 15s of Deck A & first 15s of Deck B
  drawStage() {
    const canvas = document.getElementById('canvasDjStage');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const targetW = Math.round(rect.width * dpr);
    const targetH = Math.round(rect.height * dpr);

    if (targetW > 0 && targetH > 0 && (canvas.width !== targetW || canvas.height !== targetH)) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const halfH = h / 2;
    const barColumns = 160;
    const colW = w / barColumns;
    const pad = 8 * dpr;

    // 1. Draw 16 Vertical Beat-Grid Lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1 * dpr;
    const gridDivs = 16;
    for (let i = 1; i < gridDivs; i++) {
      const gx = (i / gridDivs) * w;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, h);
      ctx.stroke();
    }

    // Helper to draw rounded bars cleanly
    const drawPillBar = (x, y, bw, bh, radius) => {
      if (bh <= 0) return;
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(x, y, bw, bh, Math.min(radius, bw / 2, bh / 2));
        ctx.fill();
      } else {
        ctx.fillRect(x, y, bw, bh);
      }
    };

    // 2. Draw Top Waveform: DECK A (Last 15 seconds)
    const midYA = halfH / 2;
    const maxBarHA = (halfH / 2) - 5 * dpr; // Fills 90% of upper deck lane

    const durA = (state.duration > 0 ? state.duration : 180);
    const slicePctA = Math.min(1.0, 15.0 / durA);
    const startFracA = 1.0 - slicePctA;

    let peaksA = (this.analysisA && this.analysisA.peaks && this.analysisA.peaks.lows)
      ? this.analysisA.peaks
      : this._synthesizePeaks((state.currentSong ? state.currentSong.title : 'deckA') + '_outgoing', barColumns);

    const totalBinsA = peaksA.lows.length;
    for (let i = 0; i < barColumns; i++) {
      const sampleFrac = startFracA + (i / barColumns) * slicePctA;
      const binIdx = Math.max(0, Math.min(totalBinsA - 1, Math.floor(sampleFrac * totalBinsA)));

      const lowVal = peaksA.lows[binIdx] || 0.2;
      const midVal = peaksA.mids[binIdx] || 0.25;
      const highVal = peaksA.highs[binIdx] || 0.3;

      const x = i * colW;
      const bw = Math.max(1.8 * dpr, colW - (0.9 * dpr));

      // Outer Layer - Highs / Full Waveform Body (Electric Blue, Print 3)
      const hH = Math.max(2.5 * dpr, highVal * maxBarHA);
      ctx.fillStyle = 'rgba(37, 99, 235, 0.92)';
      drawPillBar(x, midYA - hH, bw, hH * 2, 2 * dpr);

      // Middle Layer - Mids / Vocal warmth (Golden Bronze Amber, Print 3)
      const mH = Math.max(1.8 * dpr, midVal * maxBarHA * 0.72);
      ctx.fillStyle = 'rgba(217, 119, 6, 0.95)';
      drawPillBar(x, midYA - mH, bw, mH * 2, 1.5 * dpr);

      // Core Layer - Lows / Transients (Crisp White / Pale Gold, Print 3)
      const lH = Math.max(1.2 * dpr, lowVal * maxBarHA * 0.44);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
      drawPillBar(x, midYA - lH, bw, lH * 2, 1.0 * dpr);
    }

    // 3. Center Deck Divider
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, halfH);
    ctx.lineTo(w, halfH);
    ctx.stroke();

    // 4. Draw Bottom Waveform: DECK B (First 15 seconds)
    const midYB = halfH + (halfH / 2);
    const maxBarHB = (halfH / 2) - 5 * dpr; // Fills 90% of lower deck lane

    const nextSong = (state.playQueue && state.playQueue.length > state.currentQueueIndex + 1)
      ? state.playQueue[state.currentQueueIndex + 1]
      : null;
    const durB = 180;
    const slicePctB = Math.min(1.0, 15.0 / durB);

    let peaksB = (this.analysisB && this.analysisB.peaks && this.analysisB.peaks.lows)
      ? this.analysisB.peaks
      : this._synthesizePeaks((nextSong ? nextSong.title : 'deckB') + '_incoming', barColumns);

    const totalBinsB = peaksB.lows.length;
    for (let i = 0; i < barColumns; i++) {
      const sampleFrac = (i / barColumns) * slicePctB;
      const binIdx = Math.max(0, Math.min(totalBinsB - 1, Math.floor(sampleFrac * totalBinsB)));

      const lowVal = peaksB.lows[binIdx] || 0.2;
      const midVal = peaksB.mids[binIdx] || 0.25;
      const highVal = peaksB.highs[binIdx] || 0.3;

      const x = i * colW;
      const bw = Math.max(1.8 * dpr, colW - (0.9 * dpr));

      // Outer Layer - Highs / Full Waveform Body (Electric Blue, Print 3)
      const hH = Math.max(2.5 * dpr, highVal * maxBarHB);
      ctx.fillStyle = 'rgba(37, 99, 235, 0.92)';
      drawPillBar(x, midYB - hH, bw, hH * 2, 2 * dpr);

      // Middle Layer - Mids / Vocal warmth (Golden Bronze Amber, Print 3)
      const mH = Math.max(1.8 * dpr, midVal * maxBarHB * 0.72);
      ctx.fillStyle = 'rgba(217, 119, 6, 0.95)';
      drawPillBar(x, midYB - mH, bw, mH * 2, 1.5 * dpr);

      // Core Layer - Lows / Transients (Crisp White / Pale Gold, Print 3)
      const lH = Math.max(1.2 * dpr, lowVal * maxBarHB * 0.44);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
      drawPillBar(x, midYB - lH, bw, lH * 2, 1.0 * dpr);
    }

    // 5. OVERLAID INTERACTIVE AUTOMATION CURVES (Prints 3 & 4)

    // Helper functions to map normalized curve Y (0.0 to 1.0) into canvas coordinates
    const mapTopY = (normY) => pad + (1.0 - normY) * (halfH - pad * 2);
    const mapBotY = (normY) => halfH + pad + (1.0 - normY) * (halfH - pad * 2);

    // 5.1 Volume Curve: Deck A (Cyan)
    ctx.beginPath();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.8 * dpr;
    ctx.shadowColor = 'rgba(56, 189, 248, 0.7)';
    ctx.shadowBlur = 6 * dpr;
    this.curves.outVolume.forEach((pt, idx) => {
      const cx = pt.x * w;
      const cy = mapTopY(pt.y);
      if (idx === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    });
    ctx.stroke();

    // 5.2 Volume Curve: Deck B (Cyan)
    ctx.beginPath();
    this.curves.inVolume.forEach((pt, idx) => {
      const cx = pt.x * w;
      const cy = mapBotY(pt.y);
      if (idx === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 5.3 EQ / Bass Curve (Yellow / Amber)
    // Deck A bass drops at crossover point, Deck B bass steps up
    const crossX = this.curves.bassCrossover * w;
    ctx.beginPath();
    ctx.strokeStyle = '#eab308';
    ctx.lineWidth = 2.5 * dpr;
    ctx.shadowColor = 'rgba(234, 179, 8, 0.7)';
    ctx.shadowBlur = 6 * dpr;

    // Deck A Yellow line: center of top deck, then drops to bottom of top deck at crossX
    ctx.moveTo(0, midYA);
    ctx.lineTo(crossX, midYA);
    ctx.lineTo(crossX, halfH - pad);
    ctx.lineTo(w, halfH - pad);
    ctx.stroke();

    // Deck B Yellow line: bottom of bottom deck, then steps up to center of bottom deck at crossX
    ctx.beginPath();
    ctx.moveTo(0, h - pad);
    ctx.lineTo(crossX, h - pad);
    ctx.lineTo(crossX, midYB);
    ctx.lineTo(w, midYB);
    ctx.stroke();

    // Vertical dashed yellow crossover connector
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.moveTo(crossX, midYA);
    ctx.lineTo(crossX, h - pad);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    // 5.4 Filter / FX Curve (Purple / Violet)
    ctx.beginPath();
    ctx.strokeStyle = '#c084fc';
    ctx.lineWidth = 2.5 * dpr;
    ctx.shadowColor = 'rgba(192, 132, 252, 0.7)';
    ctx.shadowBlur = 6 * dpr;
    this.curves.filterFx.forEach((pt, idx) => {
      const cx = pt.x * w;
      // Filter curve spans middle of stage
      const cy = (h * 0.75) - (pt.y * (h * 0.5));
      if (idx === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 6. DRAW DRAGGABLE HANDLES
    const drawHandle = (x, y, color, isCross = false) => {
      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2 * dpr;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8 * dpr;
      ctx.beginPath();
      ctx.arc(x, y, (isCross ? 6.5 : 5.5) * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };

    // Volume handles (Cyan)
    this.curves.outVolume.forEach((pt, idx) => {
      if (!pt.fixed) drawHandle(pt.x * w, mapTopY(pt.y), '#38bdf8');
    });
    this.curves.inVolume.forEach((pt, idx) => {
      if (!pt.fixed) drawHandle(pt.x * w, mapBotY(pt.y), '#38bdf8');
    });

    // Yellow Bass crossover handle (at center divider)
    drawHandle(crossX, halfH, '#eab308', true);

    // Filter FX handles (Purple)
    this.curves.filterFx.forEach((pt, idx) => {
      if (!pt.fixed) {
        const cy = (h * 0.75) - (pt.y * (h * 0.5));
        drawHandle(pt.x * w, cy, '#c084fc');
      }
    });

    // 7. NEON GREEN VERTICAL PLAYHEAD NEEDLE `|` (Print 3 style)
    let needleProgress = -1;
    if (this.isAuditioning && this.playheadProgress >= 0.0 && this.playheadProgress <= 1.0) {
      needleProgress = this.playheadProgress;
    } else if (state.isPlaying && activeAudio && state.duration > 0) {
      const transSecs = (state.djTransitionSettings && state.djTransitionSettings.durationSeconds) ? state.djTransitionSettings.durationSeconds : 16;
      const windowStart = state.duration - transSecs;
      if (activeAudio.currentTime >= windowStart && activeAudio.currentTime <= state.duration) {
        needleProgress = Math.max(0, Math.min(1.0, (activeAudio.currentTime - windowStart) / transSecs));
      }
    }

    if (needleProgress >= 0.0 && needleProgress <= 1.0) {
      const needleX = needleProgress * w;
      ctx.save();
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 2.8 * dpr;
      ctx.shadowColor = '#22c55e';
      ctx.shadowBlur = 10 * dpr;
      ctx.beginPath();
      ctx.moveTo(needleX, 0);
      ctx.lineTo(needleX, h);
      ctx.stroke();
      ctx.restore();
    }
  },

  // Toggle live audition playback
  async toggleAudition() {
    if (this.isAuditioning) {
      this.stopAudition();
    } else {
      await this.startAudition();
    }
  },

  async startAudition() {
    const songA = state.currentSong;
    let songB = null;
    if (state.playQueue && state.playQueue.length > state.currentQueueIndex + 1) {
      songB = state.playQueue[state.currentQueueIndex + 1];
    } else if (state.playQueue && state.playQueue.length > 0) {
      songB = state.playQueue[0];
    }

    if (!songA || !songB) {
      showToast('Need at least 2 tracks in queue to audition transition');
      return;
    }

    AetherAudioEngine.init();
    if (AetherAudioEngine.resumeContext) {
      await AetherAudioEngine.resumeContext();
    }

    this.isAuditioning = true;
    this.playheadProgress = 0.0;
    this.auditionStartTime = performance.now();

    // Ensure volume is set accurately for auditioning
    applyVolume();

    // Update Audition button icons (center button & footer button)
    const btnCenter = document.getElementById('btnCenterAudition');
    const iconPlay = document.getElementById('iconAuditionPlay');
    const iconStop = document.getElementById('iconAuditionStop');
    const btnPreview = document.getElementById('btnPreviewTransition');
    const txtPreview = document.getElementById('txtPreviewTransition');

    if (btnCenter) btnCenter.classList.add('auditioning');
    if (iconPlay) iconPlay.style.display = 'none';
    if (iconStop) iconStop.style.display = 'block';
    if (btnPreview) btnPreview.classList.add('btn-primary');
    if (txtPreview) txtPreview.textContent = 'Stop Audition';

    const transSecs = (state.djTransitionSettings && state.djTransitionSettings.durationSeconds) ? state.djTransitionSettings.durationSeconds : 16;
    const deckA = AetherAudioEngine.deckA;
    const deckB = AetherAudioEngine.deckB;

    // Ensure Deck A has the outgoing track source loaded
    let srcA = '';
    const isOfflineA = (state.downloadedTrackIds && state.downloadedTrackIds.has(songA.id));
    if (isOfflineA) {
      srcA = `/api/offline/audio?id=${encodeURIComponent(songA.id)}`;
    } else {
      const vidA = songA._preResolvedYtId || songA.id;
      srcA = `/api/stream/proxy?id=${encodeURIComponent(vidA)}`;
    }
    const tokenA = songA._preResolvedYtId || songA.id;
    if (!deckA.audio.src || !deckA.audio.src.includes(encodeURIComponent(tokenA))) {
      deckA.audio.crossOrigin = 'anonymous';
      deckA.audio.src = srcA;
    }

    // Ensure Deck B has the incoming track source loaded
    let srcB = '';
    const isOfflineB = (state.downloadedTrackIds && state.downloadedTrackIds.has(songB.id));
    if (isOfflineB) {
      srcB = `/api/offline/audio?id=${encodeURIComponent(songB.id)}`;
    } else {
      const vidB = songB._preResolvedYtId || songB.id;
      srcB = `/api/stream/proxy?id=${encodeURIComponent(vidB)}`;
    }
    const tokenB = songB._preResolvedYtId || songB.id;
    if (!deckB.audio.src || !deckB.audio.src.includes(encodeURIComponent(tokenB))) {
      deckB.audio.crossOrigin = 'anonymous';
      deckB.audio.src = srcB;
    }

    deckB.audio.currentTime = 0;

    // Deck A seek position: last transSecs of the track
    const durA = (state.duration > 0 ? state.duration : 180);
    try {
      deckA.audio.currentTime = Math.max(0, durA - transSecs);
    } catch (e) {}

    // Launch audio playback asynchronously without blocking the visual animation loop
    deckA.audio.play().catch(e => console.warn('[DJ Studio] Deck A play warning:', e));
    deckB.audio.play().catch(e => console.warn('[DJ Studio] Deck B play warning:', e));

    showToast(`Auditioning ${state.djTransitionSettings.bars || 8} Bars Transition...`);

    // Animation frame loop for needle movement and live Web Audio DSP sweeps
    const filterType = document.getElementById('selFilterFx') ? document.getElementById('selFilterFx').value : 'none';

    const loop = (now) => {
      if (!this.isAuditioning) return;

      const elapsed = (now - this.auditionStartTime) / 1000;
      const progress = Math.min(1.0, elapsed / transSecs);
      this.playheadProgress = progress;

      // Evaluate Volume A & B at current progress
      const volA = this._evaluateCurve(this.curves.outVolume, progress);
      const volB = this._evaluateCurve(this.curves.inVolume, progress);

      if (AetherAudioEngine.ctx) {
        const ct = AetherAudioEngine.ctx.currentTime;
        deckA.gainNode.gain.setValueAtTime(Math.max(0, Math.min(1, volA)), ct);
        deckB.gainNode.gain.setValueAtTime(Math.max(0, Math.min(1, volB)), ct);

        // EQ / Bass Swap crossover
        if (progress < this.curves.bassCrossover) {
          deckA.eq.low.gain.setValueAtTime(0, ct);
          deckB.eq.low.gain.setValueAtTime(-24, ct);
        } else {
          deckA.eq.low.gain.setValueAtTime(-24, ct);
          deckB.eq.low.gain.setValueAtTime(0, ct);
        }

        // Live Filter / FX Sweep
        if (filterType !== 'none') {
          const fxVal = this._evaluateCurve(this.curves.filterFx, progress);
          AetherAudioEngine.setDeckFx(filterType, fxVal, 'A');
        }
      }

      this.drawStage();

      if (progress < 1.0) {
        this.auditionRafId = requestAnimationFrame(loop);
      } else {
        this.stopAudition();
        showToast('Audition Complete');
      }
    };

    // Kick off animation loop immediately
    this.auditionRafId = requestAnimationFrame(loop);
  },

  // Helper to linearly interpolate curve points at time t
  _evaluateCurve(points, t) {
    if (!points || points.length === 0) return 0;
    if (t <= points[0].x) return points[0].y;
    if (t >= points[points.length - 1].x) return points[points.length - 1].y;

    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      if (t >= p1.x && t <= p2.x) {
        const span = p2.x - p1.x;
        const frac = span > 0 ? (t - p1.x) / span : 0;
        return p1.y + frac * (p2.y - p1.y);
      }
    }
    return points[points.length - 1].y;
  },

  stopAudition() {
    this.isAuditioning = false;
    if (this.auditionRafId) {
      cancelAnimationFrame(this.auditionRafId);
      this.auditionRafId = null;
    }
    this.playheadProgress = 0.0;

    // Reset button states
    const btnCenter = document.getElementById('btnCenterAudition');
    const iconPlay = document.getElementById('iconAuditionPlay');
    const iconStop = document.getElementById('iconAuditionStop');
    const btnPreview = document.getElementById('btnPreviewTransition');
    const txtPreview = document.getElementById('txtPreviewTransition');

    if (btnCenter) btnCenter.classList.remove('auditioning');
    if (iconPlay) iconPlay.style.display = 'block';
    if (iconStop) iconStop.style.display = 'none';
    if (btnPreview) btnPreview.classList.remove('btn-primary');
    if (txtPreview) txtPreview.textContent = 'Audition Transition';

    try {
      const actId = AetherAudioEngine.activeDeckId || 'A';
      const now = AetherAudioEngine.ctx ? AetherAudioEngine.ctx.currentTime : 0;

      if (AetherAudioEngine.deckB && AetherAudioEngine.deckB.audio) {
        if (actId !== 'B') {
          AetherAudioEngine.deckB.audio.pause();
        }
        if (AetherAudioEngine.ctx) {
          AetherAudioEngine.deckB.gainNode.gain.cancelScheduledValues(now);
          AetherAudioEngine.deckB.gainNode.gain.setValueAtTime(actId === 'B' ? 1.0 : 0.0, now);
          AetherAudioEngine.deckB.eq.low.gain.setValueAtTime(0, now);
        }
      }
      if (AetherAudioEngine.deckA && AetherAudioEngine.deckA.audio) {
        if (actId !== 'A') {
          AetherAudioEngine.deckA.audio.pause();
        }
        if (AetherAudioEngine.ctx) {
          AetherAudioEngine.deckA.gainNode.gain.cancelScheduledValues(now);
          AetherAudioEngine.deckA.gainNode.gain.setValueAtTime(actId === 'A' ? 1.0 : 0.0, now);
          AetherAudioEngine.deckA.eq.low.gain.setValueAtTime(0, now);
        }
      }
      AetherAudioEngine.resetDeckFx('A');
      AetherAudioEngine.resetDeckFx('B');
    } catch (e) {}

    this.drawStage();
  },

  async saveCurrentTransition() {
    const songA = state.currentSong;
    let songB = null;
    if (state.playQueue && state.playQueue.length > state.currentQueueIndex + 1) {
      songB = state.playQueue[state.currentQueueIndex + 1];
    }

    if (!songA) {
      showToast('No active song to save transition for');
      return;
    }

    const selVol = document.getElementById('selFilterVolume');
    const selEq = document.getElementById('selFilterEq');
    const selFx = document.getElementById('selFilterFx');

    const payload = {
      bars: state.djTransitionSettings.bars,
      curveType: state.djTransitionSettings.curveType,
      durationSeconds: state.djTransitionSettings.durationSeconds,
      curves: this.curves,
      filterVolume: selVol ? selVol.value : 'equal_power',
      filterEq: selEq ? selEq.value : 'bass_swap',
      filterFx: selFx ? selFx.value : 'none'
    };

    const transKey = songB ? `${songA.id}_to_${songB.id}` : `${songA.id}_default`;
    await AetherAudioDB.saveTransition(transKey, payload);
    await AetherAudioDB.saveTransition(`${songA.id}_default`, payload);

    updateDjTransitionIndicator(songA);

    showToast(`DJ Transition Saved (${payload.bars} Bars • ${payload.curveType.replace('_', ' ')})`);
    this.closeModal();
  },

  toggleDjTransitionMaster(forcedValue) {
    if (typeof forcedValue === 'boolean') {
      state.djTransitionEnabled = forcedValue;
    } else {
      state.djTransitionEnabled = !state.djTransitionEnabled;
    }
    localStorage.setItem('aether_dj_transition_enabled', state.djTransitionEnabled ? 'true' : 'false');
    this.updateToggleUI();
    updateDjTransitionIndicator(state.currentSong);
    showToast(state.djTransitionEnabled ? 'DJ Transitions: ON (Smooth Crossfade)' : 'DJ Transitions: OFF (Quick Cut Mode)');
  },

  updateToggleUI() {
    const isEnabled = !!state.djTransitionEnabled;
    const btnToggle = document.getElementById('btnToggleDjActive');
    const txtToggle = document.getElementById('txtDjToggleState');
    if (btnToggle) {
      btnToggle.classList.toggle('active', isEnabled);
      btnToggle.setAttribute('aria-pressed', isEnabled ? 'true' : 'false');
    }
    if (txtToggle) {
      txtToggle.textContent = isEnabled ? 'ON' : 'OFF';
    }
  }
};

async function updateDjTransitionIndicator(song) {
  const isEnabled = !!state.djTransitionEnabled;
  const dot = document.getElementById('transitionActiveDot');
  const btn = document.getElementById('btnToggleDjTransition');
  const btnMobile = document.getElementById('btnMobileNpTransition');

  if (btn) {
    btn.classList.toggle('active', isEnabled);
    btn.classList.toggle('disabled', !isEnabled);
    btn.title = isEnabled
      ? 'DJ Auto-Transitions: ON (Click to toggle OFF, Right-click or Double-click for Studio)'
      : 'DJ Auto-Transitions: OFF (Click to toggle ON, Right-click or Double-click for Studio)';
  }

  if (btnMobile) {
    btnMobile.classList.toggle('active', isEnabled);
    btnMobile.classList.toggle('disabled', !isEnabled);
  }

  if (dot) {
    dot.style.display = isEnabled ? 'block' : 'none';
  }

  const btnToggleActive = document.getElementById('btnToggleDjActive');
  const txtToggleState = document.getElementById('txtDjToggleState');
  if (btnToggleActive) {
    btnToggleActive.classList.toggle('active', isEnabled);
    btnToggleActive.setAttribute('aria-pressed', isEnabled ? 'true' : 'false');
  }
  if (txtToggleState) {
    txtToggleState.textContent = isEnabled ? 'ON' : 'OFF';
  }
}

function setupDjStudioEventListeners() {
  const btnToggle = document.getElementById('btnToggleDjTransition');
  if (btnToggle) {
    btnToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      AetherDjStudio.toggleDjTransitionMaster();
    });
    btnToggle.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      AetherDjStudio.openModal();
    });
    btnToggle.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      AetherDjStudio.openModal();
    });
  }

  const btnMobileNp = document.getElementById('btnMobileNpTransition');
  if (btnMobileNp) {
    btnMobileNp.addEventListener('click', (e) => {
      e.stopPropagation();
      AetherDjStudio.toggleDjTransitionMaster();
    });
    btnMobileNp.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      AetherDjStudio.openModal();
    });
    btnMobileNp.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      AetherDjStudio.openModal();
    });
  }

  const btnClose = document.getElementById('btnCloseDjTransition');
  if (btnClose) {
    btnClose.addEventListener('click', (e) => {
      e.stopPropagation();
      AetherDjStudio.closeModal();
    });
  }

  const modal = document.getElementById('modalDjTransition');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        AetherDjStudio.closeModal();
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && modal.classList.contains('active')) {
      AetherDjStudio.closeModal();
    }
  });

  // Top Clean Preset Selector (Print 4)
  const selPreset = document.getElementById('selTransitionPreset');
  if (selPreset) {
    selPreset.addEventListener('change', () => {
      const val = selPreset.value;
      if (val !== 'custom') {
        AetherDjStudio.applyPreset(val, false);
      }
    });
  }

  // Floating Center Audition Button (Print 3)
  const btnCenterAudition = document.getElementById('btnCenterAudition');
  if (btnCenterAudition) {
    btnCenterAudition.addEventListener('click', (e) => {
      e.stopPropagation();
      AetherDjStudio.toggleAudition();
    });
  }

  // Bar selector pills
  document.querySelectorAll('#transitionBarSelector .dj-selector-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const bars = parseInt(pill.getAttribute('data-bars'), 10);
      state.djTransitionSettings.bars = bars;
      AetherDjStudio.updateDuration(AetherDjStudio.analysisA);
      AetherDjStudio.updateBarPills();
      AetherDjStudio.drawStage();
    });
  });

  // Bottom Filter Selectors (Print 4)
  const selFilterVolume = document.getElementById('selFilterVolume');
  if (selFilterVolume) {
    selFilterVolume.addEventListener('change', () => {
      const v = selFilterVolume.value;
      if (v === 'equal_power') {
        AetherDjStudio.curves.outVolume[1] = { x: 0.5, y: 0.707 };
        AetherDjStudio.curves.inVolume[1] = { x: 0.5, y: 0.707 };
      } else if (v === 'drop_cut') {
        AetherDjStudio.curves.outVolume[1] = { x: 0.88, y: 1.0 };
        AetherDjStudio.curves.inVolume[1] = { x: 0.88, y: 0.0 };
      } else if (v === 'linear') {
        AetherDjStudio.curves.outVolume[1] = { x: 0.5, y: 0.5 };
        AetherDjStudio.curves.inVolume[1] = { x: 0.5, y: 0.5 };
      } else if (v === 'slow_fade') {
        AetherDjStudio.curves.outVolume[1] = { x: 0.35, y: 0.4 };
        AetherDjStudio.curves.inVolume[1] = { x: 0.65, y: 0.6 };
      }
      if (selPreset) selPreset.value = 'custom';
      AetherDjStudio.drawStage();
    });
  }

  const selFilterEq = document.getElementById('selFilterEq');
  if (selFilterEq) {
    selFilterEq.addEventListener('change', () => {
      const eqVal = selFilterEq.value;
      if (eqVal === 'bass_swap') {
        AetherDjStudio.curves.bassCrossover = 0.50;
      } else if (eqVal === 'low_cut') {
        AetherDjStudio.curves.bassCrossover = 0.25;
      }
      if (selPreset) selPreset.value = 'custom';
      AetherDjStudio.drawStage();
    });
  }

  const selFilterFx = document.getElementById('selFilterFx');
  if (selFilterFx) {
    selFilterFx.addEventListener('change', () => {
      const fxVal = selFilterFx.value;
      if (fxVal === 'hipass_sweep') {
        AetherDjStudio.curves.filterFx = [
          { x: 0.0, y: 0.0, fixed: true },
          { x: 0.45, y: 0.25 },
          { x: 0.85, y: 0.85 },
          { x: 1.0, y: 0.0, fixed: true }
        ];
      } else if (fxVal === 'none') {
        AetherDjStudio.curves.filterFx = [
          { x: 0.0, y: 0.0, fixed: true },
          { x: 0.50, y: 0.0 },
          { x: 0.80, y: 0.0 },
          { x: 1.0, y: 0.0, fixed: true }
        ];
      }
      if (selPreset) selPreset.value = 'custom';
      AetherDjStudio.drawStage();
    });
  }

  // Interactive Drag & Drop on Stage Canvas
  const canvasStage = document.getElementById('canvasDjStage');
  if (canvasStage) {
    let activeDrag = null;

    canvasStage.addEventListener('pointerdown', (e) => {
      const rect = canvasStage.getBoundingClientRect();
      const normX = (e.clientX - rect.left) / rect.width;
      const normY = (e.clientY - rect.top) / rect.height;
      const w = rect.width;
      const h = rect.height;
      const halfH = h / 2;
      const pad = 8;

      const mapTopY = (y) => pad + (1.0 - y) * (halfH - pad * 2);
      const mapBotY = (y) => halfH + pad + (1.0 - y) * (halfH - pad * 2);

      const hitRadius = 16;
      let found = null;

      // 1. Check Yellow Bass Crossover Handle
      const crossCanvasX = AetherDjStudio.curves.bassCrossover * w;
      const distCross = Math.hypot(e.clientX - rect.left - crossCanvasX, e.clientY - rect.top - halfH);
      if (distCross <= hitRadius + 4) {
        found = { type: 'bassCrossover' };
      }

      // 2. Check Volume Out Handles (Deck A)
      if (!found) {
        AetherDjStudio.curves.outVolume.forEach((pt, idx) => {
          if (!pt.fixed) {
            const hx = pt.x * w;
            const hy = mapTopY(pt.y);
            if (Math.hypot(e.clientX - rect.left - hx, e.clientY - rect.top - hy) <= hitRadius) {
              found = { type: 'outVolume', idx };
            }
          }
        });
      }

      // 3. Check Volume In Handles (Deck B)
      if (!found) {
        AetherDjStudio.curves.inVolume.forEach((pt, idx) => {
          if (!pt.fixed) {
            const hx = pt.x * w;
            const hy = mapBotY(pt.y);
            if (Math.hypot(e.clientX - rect.left - hx, e.clientY - rect.top - hy) <= hitRadius) {
              found = { type: 'inVolume', idx };
            }
          }
        });
      }

      // 4. Check Filter FX Handles
      if (!found) {
        AetherDjStudio.curves.filterFx.forEach((pt, idx) => {
          if (!pt.fixed) {
            const hx = pt.x * w;
            const hy = (h * 0.75) - (pt.y * (h * 0.5));
            if (Math.hypot(e.clientX - rect.left - hx, e.clientY - rect.top - hy) <= hitRadius) {
              found = { type: 'filterFx', idx };
            }
          }
        });
      }

      if (found) {
        activeDrag = found;
        try { canvasStage.setPointerCapture(e.pointerId); } catch (err) {}
      } else {
        // Scrub playhead if clicking outside handles
        AetherDjStudio.playheadProgress = Math.max(0.0, Math.min(1.0, normX));
        AetherDjStudio.drawStage();
      }
    });

    canvasStage.addEventListener('pointermove', (e) => {
      if (!activeDrag) return;
      const rect = canvasStage.getBoundingClientRect();
      const normX = Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width));
      const normY = Math.max(0.0, Math.min(1.0, (e.clientY - rect.top) / rect.height));

      if (activeDrag.type === 'bassCrossover') {
        AetherDjStudio.curves.bassCrossover = normX;
      } else if (activeDrag.type === 'outVolume') {
        const pt = AetherDjStudio.curves.outVolume[activeDrag.idx];
        pt.x = normX;
        // Invert for top track volume: 0 at middle divider, 1 at top
        pt.y = Math.max(0.0, Math.min(1.0, 1.0 - (normY * 2.0)));
      } else if (activeDrag.type === 'inVolume') {
        const pt = AetherDjStudio.curves.inVolume[activeDrag.idx];
        pt.x = normX;
        // Invert for bottom track volume: 0 at bottom, 1 at middle divider
        pt.y = Math.max(0.0, Math.min(1.0, 1.0 - ((normY - 0.5) * 2.0)));
      } else if (activeDrag.type === 'filterFx') {
        const pt = AetherDjStudio.curves.filterFx[activeDrag.idx];
        pt.x = normX;
        pt.y = Math.max(0.0, Math.min(1.0, 1.0 - normY));
      }

      if (selPreset) selPreset.value = 'custom';
      AetherDjStudio.drawStage();
    });

    const endDrag = (e) => {
      if (activeDrag) {
        activeDrag = null;
        try { canvasStage.releasePointerCapture(e.pointerId); } catch (err) {}
      }
    };

    canvasStage.addEventListener('pointerup', endDrag);
    canvasStage.addEventListener('pointercancel', endDrag);
  }

  // Audition button (Footer)
  const btnPreview = document.getElementById('btnPreviewTransition');
  if (btnPreview) {
    btnPreview.addEventListener('click', () => {
      AetherDjStudio.toggleAudition();
    });
  }

  // Save button (Footer)
  const btnSave = document.getElementById('btnSaveDjTransition');
  if (btnSave) {
    btnSave.addEventListener('click', () => {
      AetherDjStudio.saveCurrentTransition();
    });
  }

  // Master DJ Transition Active Toggle Button in Header
  const btnToggleDjActive = document.getElementById('btnToggleDjActive');
  if (btnToggleDjActive) {
    btnToggleDjActive.addEventListener('click', (e) => {
      e.stopPropagation();
      AetherDjStudio.toggleDjTransitionMaster();
    });
  }

  // Initial sync of DJ transition state
  AetherDjStudio.updateToggleUI();
  updateDjTransitionIndicator(state.currentSong);
}

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
  AetherAudioDB.init();
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

  // Load Global Master Equalizer settings
  loadMasterEqSettings();

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
    if (typeof syncMixerModalTrackInfo === 'function') {
      syncMixerModalTrackInfo(state.currentSong);
    }
    if (typeof renderTrackDjAnalysis === 'function') {
      renderTrackDjAnalysis(state.currentSong);
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

  // Dual Audio Mixer & Equalizer Event Listeners
  setupAudioMixerEventListeners();

  // DJ Transition Studio Event Listeners (v2.0.0)
  setupDjStudioEventListeners();
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

  const isReorderable = pl.id !== 'system_downloaded' && songsToDisplay.length === pl.songs.length;

  // Shared placeholder element for smooth drop preview expansion
  let placeholder = document.getElementById('playlistDragPlaceholder');
  if (!placeholder) {
    placeholder = document.createElement('div');
    placeholder.className = 'drag-drop-placeholder';
    placeholder.id = 'playlistDragPlaceholder';
    placeholder.innerHTML = `
      <div class="drag-drop-placeholder-inner">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        <span>Drop track here</span>
      </div>
    `;
  }

  let dragHoverTimer = null;
  let activeDropBeforeNode = null;

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  container.addEventListener('dragleave', (e) => {
    if (!container.contains(e.relatedTarget)) {
      if (dragHoverTimer) clearTimeout(dragHoverTimer);
      placeholder.classList.remove('active');
      activeDropBeforeNode = null;
    }
  });

  songsToDisplay.forEach((song, displayIdx) => {
    // Locate the song's real position in the full playlist
    const realIdx = pl.songs.findIndex(s => s.id === song.id);
    const resolvedOriginalIdx = realIdx !== -1 ? realIdx : displayIdx;

    const row = document.createElement('div');
    row.className = 'song-row';
    row.dataset.songId = song.id;
    row.dataset.index = resolvedOriginalIdx;
    if (state.currentSong && state.currentSong.id === song.id) {
      row.classList.add('active');
    }

    if (isReorderable) {
      row.draggable = true;
      row.classList.add('is-draggable');

      row.addEventListener('dragstart', (e) => {
        // Disallow dragging if started on interactive buttons or links
        if (e.target.closest('button, .clickable-artist, .clickable-album')) {
          e.preventDefault();
          return;
        }
        window._playlistDragSrcIdx = resolvedOriginalIdx;
        window._playlistDragSrcSong = song;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(resolvedOriginalIdx));

        requestAnimationFrame(() => {
          row.classList.add('is-dragging');
        });
      });

      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        if (window._playlistDragSrcIdx === undefined || window._playlistDragSrcIdx === null) return;

        const rect = row.getBoundingClientRect();
        const isLowerHalf = (e.clientY - rect.top) > (rect.height / 2);
        const insertBeforeNode = isLowerHalf ? row.nextSibling : row;

        if (activeDropBeforeNode !== insertBeforeNode) {
          activeDropBeforeNode = insertBeforeNode;
          if (dragHoverTimer) clearTimeout(dragHoverTimer);

          // Smooth 300ms gap preview animation
          dragHoverTimer = setTimeout(() => {
            if (window._playlistDragSrcIdx === null || window._playlistDragSrcIdx === undefined) return;
            if (insertBeforeNode) {
              container.insertBefore(placeholder, insertBeforeNode);
            } else {
              container.appendChild(placeholder);
            }
            requestAnimationFrame(() => {
              placeholder.classList.add('active');
            });
          }, 300);
        }
      });

      row.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (dragHoverTimer) clearTimeout(dragHoverTimer);

        const srcIdx = window._playlistDragSrcIdx;
        if (srcIdx === null || srcIdx === undefined) return;

        const rect = row.getBoundingClientRect();
        const isLowerHalf = (e.clientY - rect.top) > (rect.height / 2);
        let targetIdx = resolvedOriginalIdx + (isLowerHalf ? 1 : 0);

        if (targetIdx > srcIdx) {
          targetIdx -= 1;
        }

        if (targetIdx !== srcIdx && targetIdx >= 0 && targetIdx < pl.songs.length) {
          const [movedTrack] = pl.songs.splice(srcIdx, 1);
          pl.songs.splice(targetIdx, 0, movedTrack);
          savePlaylists();

          if (!state.isRadioSession && state.playQueue && state.playQueue.length > 0) {
            state.playQueue = pl.songs.map(s => ({ ...s }));
          }

          showToast(`Track moved to #${targetIdx + 1}`);
        }

        placeholder.classList.remove('active');
        if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
        window._playlistDragSrcIdx = null;
        window._playlistDragSrcSong = null;
        activeDropBeforeNode = null;

        renderPlaylistSongRows(pl, pl.songs);
      });

      row.addEventListener('dragend', () => {
        if (dragHoverTimer) clearTimeout(dragHoverTimer);
        row.classList.remove('is-dragging');
        document.querySelectorAll('#playlistSongsContainer .song-row').forEach(r => r.classList.remove('is-dragging'));
        placeholder.classList.remove('active');
        if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
        window._playlistDragSrcIdx = null;
        window._playlistDragSrcSong = null;
        activeDropBeforeNode = null;
      });
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

// --- TRACK METADATA ANIMATION HELPER ---
let metadataAnimTimer1 = null;
let metadataAnimTimer2 = null;

function animateTrackMetadataUpdate(song, isDjTransition = false) {
  if (!song) return;

  const artEl = document.getElementById('playerAlbumArt');
  const detailsEl = document.querySelector('.player-song-details');
  const badgeEl = document.getElementById('playerPlatformBadge');
  const mobileCover = document.getElementById('mobileNpCoverWrapper');
  const mobileTitles = document.querySelector('.mobile-np-titles');

  const animTargets = [artEl, detailsEl, badgeEl, mobileCover, mobileTitles].filter(Boolean);

  if (metadataAnimTimer1) clearTimeout(metadataAnimTimer1);
  if (metadataAnimTimer2) clearTimeout(metadataAnimTimer2);

  const cleanAllAnimClasses = () => {
    animTargets.forEach(el => {
      el.classList.remove(
        'track-anim-smooth-out', 'track-anim-smooth-in-init', 'track-anim-smooth-in-active',
        'track-anim-quick-out', 'track-anim-quick-in-init', 'track-anim-quick-in-active'
      );
    });
  };

  const applyDomUpdates = () => {
    const titleEl = document.getElementById('playerSongTitle');
    const artistEl = document.getElementById('playerSongArtist');
    if (titleEl) titleEl.textContent = song.title || 'Unknown Title';
    if (artistEl) artistEl.textContent = song.artist || 'Unknown';
    if (badgeEl) {
      badgeEl.textContent = song.platform || 'music';
      badgeEl.style.display = 'inline-block';
    }
    if (artEl) {
      if (song.thumbnail) {
        artEl.innerHTML = `<img src="${song.thumbnail}" alt="Art">`;
      } else {
        artEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
      }
    }

    const mobileNpTitle = document.getElementById('mobileNpTitle');
    const mobileNpArtist = document.getElementById('mobileNpArtist');
    const mobileNpSource = document.getElementById('mobileNpSource');
    const mobileNpCoverImg = document.getElementById('mobileNpCoverImg');
    const mobileNpCoverPlaceholder = document.getElementById('mobileNpCoverPlaceholder');

    if (mobileNpTitle) mobileNpTitle.textContent = song.title || 'Unknown Title';
    if (mobileNpArtist) mobileNpArtist.textContent = song.artist || 'Unknown Artist';
    if (mobileNpSource) mobileNpSource.textContent = (song.platform ? song.platform.toUpperCase() : 'AETHER MUSIC');
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
  };

  // If initial load or idle player, apply immediately without exit transition
  const currentTitle = document.getElementById('playerSongTitle')?.textContent;
  if (!currentTitle || currentTitle === 'No Song Playing') {
    cleanAllAnimClasses();
    applyDomUpdates();
    return;
  }

  // Smooth mode when DJ Transition is ON and this is a DJ transition; otherwise Quick Cut mode
  const useSmooth = !!(isDjTransition && state.djTransitionEnabled);

  cleanAllAnimClasses();

  if (useSmooth) {
    // Smooth DJ Transition (soft blur, scale & glide out, then in)
    animTargets.forEach(el => el.classList.add('track-anim-smooth-out'));

    metadataAnimTimer1 = setTimeout(() => {
      applyDomUpdates();
      animTargets.forEach(el => {
        el.classList.remove('track-anim-smooth-out');
        el.classList.add('track-anim-smooth-in-init');
        void el.offsetWidth;
        el.classList.remove('track-anim-smooth-in-init');
        el.classList.add('track-anim-smooth-in-active');
      });

      metadataAnimTimer2 = setTimeout(() => {
        cleanAllAnimClasses();
      }, 380);
    }, 220);
  } else {
    // Quick Cut mode (crisp, snappy micro-transition)
    animTargets.forEach(el => el.classList.add('track-anim-quick-out'));

    metadataAnimTimer1 = setTimeout(() => {
      applyDomUpdates();
      animTargets.forEach(el => {
        el.classList.remove('track-anim-quick-out');
        el.classList.add('track-anim-quick-in-init');
        void el.offsetWidth;
        el.classList.remove('track-anim-quick-in-init');
        el.classList.add('track-anim-quick-in-active');
      });

      metadataAnimTimer2 = setTimeout(() => {
        cleanAllAnimClasses();
      }, 120);
    }, 70);
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
  // Cancel active DJ transition if any
  if (state.isExecutingTransition) {
    state.isExecutingTransition = false;
    if (window.AetherAudioEngine) {
      AetherAudioEngine.cancelCrossfade();
    }
  }

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

  // Sync Audio Mixer Modal and restore Per-Track EQ settings
  syncMixerModalTrackInfo(song);

  // Sync DJ Transition Indicator Dot
  if (typeof updateDjTransitionIndicator === 'function') {
    updateDjTransitionIndicator(song);
  }

  // Extract or load DJ analysis (BPM, Camelot Key, Multi-band waveform)
  if (typeof renderTrackDjAnalysis === 'function') {
    renderTrackDjAnalysis(song);
  }

  // Sync Spotify-style Queue UI
  renderQueueUI();

  // Update UI Player Details with animation (Quick Cut by default when DJ transition is off / manual song select)
  animateTrackMetadataUpdate(song, false);

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

  // Sync Mobile Now Playing Modal Timeline
  const mobileNpTotalDuration = document.getElementById('mobileNpTotalDuration');
  const mobileNpCurrentTime = document.getElementById('mobileNpCurrentTime');
  const mobileNpTimeline = document.getElementById('mobileNpTimeline');

  if (mobileNpTotalDuration) mobileNpTotalDuration.textContent = song.duration || '3:00';
  if (mobileNpCurrentTime) mobileNpCurrentTime.textContent = '0:00';
  if (mobileNpTimeline) mobileNpTimeline.value = 0;

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

      // Attach Native notification and taskbar media control handlers
      navigator.mediaSession.setActionHandler('play', () => togglePlayPause());
      navigator.mediaSession.setActionHandler('pause', () => togglePlayPause());
      navigator.mediaSession.setActionHandler('stop', () => togglePlayPause());
      navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
      navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined && state.duration) {
          seekToPercentage(details.seekTime / state.duration);
        }
      });
      try {
        navigator.mediaSession.setActionHandler('seekbackward', (details) => {
          const skip = (details && details.seekOffset) || 10;
          if (state.duration) seekToPercentage(Math.max(0, (state.playbackPosition - skip) / state.duration));
        });
        navigator.mediaSession.setActionHandler('seekforward', (details) => {
          const skip = (details && details.seekOffset) || 10;
          if (state.duration) seekToPercentage(Math.min(state.duration, (state.playbackPosition + skip) / state.duration));
        });
      } catch (err) {}
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

      if (AetherAudioEngine.resumeContext) {
        await AetherAudioEngine.resumeContext();
      }

      state.currentPlaybackType = 'audio';
      const audio = AetherAudioEngine.audioElement;
      activeAudio = audio;
      audio.crossOrigin = 'anonymous';
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
        if (audio === activeAudio && !state.isExecutingTransition) {
          playNext();
        }
      };

      audio.onerror = (e) => {
        // Only fall back if this audio element is currently active and legitimately failed
        if (!audio.src || audio !== activeAudio || !state.isPlaying) return;
        console.warn('[AudioEngine] Direct stream failed, falling back to YouTube IFrame:', e);
        playYouTubeIFrameFallback(videoId, startTime);
      };

      try {
        await audio.play();
      } catch (playErr) {
        console.warn('[AudioEngine] audio.play() was prevented, attempting resume:', playErr);
        if (AetherAudioEngine.resumeContext) await AetherAudioEngine.resumeContext();
        await audio.play();
      }

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
window.applyVolume = applyVolume;

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

  // Update Multi-Band Frequency Waveforms active playhead
  if (typeof updateActiveWaveformsPlayhead === 'function') {
    updateActiveWaveformsPlayhead(boundedPct / 100);
  }

  // Update OS System Media Transport Controls & Taskbar position
  if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
    try {
      if (state.duration > 0 && typeof currentSec === 'number' && !isNaN(currentSec)) {
        navigator.mediaSession.setPositionState({
          duration: Math.max(1, state.duration),
          playbackRate: 1,
          position: Math.min(state.duration, Math.max(0, currentSec))
        });
      }
    } catch (e) {}
  }
}

async function triggerAutomatedQueueTransition(nextSong, transConfig) {
  if (!state.djTransitionEnabled || state.isExecutingTransition) return;
  state.isExecutingTransition = true;
  state.isTransitioning = true;
  state.transitionStartTime = Date.now();

  const dur = Math.max(2, transConfig.durationSeconds || 16);
  const curve = transConfig.curveType || 'bass_swap';

  console.log(`[DJ Engine] Triggering automated transition into "${nextSong.title}" (${transConfig.bars || 8} bars, ${dur}s, ${curve})`);
  showToast(`DJ Transition: ${nextSong.title}`);

  // Resolve incoming track stream source
  let incomingSrc = '';
  const isOffline = (state.downloadedTrackIds && state.downloadedTrackIds.has(nextSong.id));
  if (isOffline) {
    incomingSrc = `/api/offline/stream?id=${encodeURIComponent(nextSong.id)}`;
  } else {
    const videoId = nextSong._preResolvedYtId || nextSong.id;
    incomingSrc = `/api/stream/proxy?id=${encodeURIComponent(videoId)}`;
  }

  // Pre-load incoming track on inactive deck
  const outgoingDeck = AetherAudioEngine.getActiveDeck();
  const incomingDeck = AetherAudioEngine.getInactiveDeck();

  // Clean old event listeners from incoming deck before loading new source
  incomingDeck.audio.onended = null;
  incomingDeck.audio.onerror = null;
  incomingDeck.audio.onloadedmetadata = null;

  incomingDeck.audio.crossOrigin = 'anonymous';
  incomingDeck.audio.src = incomingSrc;
  incomingDeck.audio.currentTime = 0;

  // Restore or reset Per-Track EQ for incoming track
  const incomingEq = await AetherAudioDB.getTrackEq(nextSong.id);
  if (incomingEq) {
    AetherAudioEngine.setTrackEq(incomingEq.low || 0, incomingEq.mid || 0, incomingEq.high || 0, incomingDeck.id);
  } else {
    AetherAudioEngine.resetTrackEq(incomingDeck.id);
  }

  // Bind lifecycle listeners for incoming deck
  const incomingVideoId = nextSong._preResolvedYtId || nextSong.id;
  incomingDeck.audio.onloadedmetadata = () => {
    if (incomingDeck.audio.duration && isFinite(incomingDeck.audio.duration)) {
      state.duration = Math.floor(incomingDeck.audio.duration);
      const durEl = document.getElementById('playerTotalDuration');
      if (durEl) durEl.textContent = formatSeconds(state.duration);
      const mobileNpTotalDuration = document.getElementById('mobileNpTotalDuration');
      if (mobileNpTotalDuration) mobileNpTotalDuration.textContent = formatSeconds(state.duration);
    }
  };
  incomingDeck.audio.onended = () => {
    if (incomingDeck.audio === activeAudio && !state.isExecutingTransition) {
      playNext();
    }
  };
  incomingDeck.audio.onerror = () => {
    if (!incomingDeck.audio.src || incomingDeck.audio !== activeAudio || !state.isPlaying) return;
    console.warn('[DJ Engine] Incoming deck stream error, falling back to YouTube IFrame');
    playYouTubeIFrameFallback(incomingVideoId, 0);
  };

  let playSuccess = false;
  try {
    await incomingDeck.audio.play();
    playSuccess = true;
  } catch (err) {
    console.warn('[DJ Engine] Inactive deck play error:', err);
  }

  if (!playSuccess) {
    console.warn('[DJ Engine] Incoming track could not start on inactive deck, falling back to playNext');
    state.isExecutingTransition = false;
    state.isTransitioning = false;
    playNext();
    return;
  }

  // Seamlessly switch active deck reference immediately so progress timer and volume sync to incoming song
  AetherAudioEngine.activeDeckId = incomingDeck.id;
  activeAudio = incomingDeck.audio;
  state.currentSong = nextSong;
  state.currentQueueIndex++;
  state.playbackPosition = 0;

  // Parse new track duration
  const durationParts = (nextSong.duration || '3:00').split(':');
  if (durationParts.length === 2) {
    state.duration = parseInt(durationParts[0]) * 60 + parseInt(durationParts[1]);
  } else {
    state.duration = Math.floor(incomingDeck.audio.duration || 180);
  }

  // Apply volume immediately to ensure no volume reset pop
  applyVolume();

  // Update UI components immediately for incoming track (eliminates metadata delay and time jumps)
  savePlaybackSession();
  logPlayHistory(nextSong);
  updateRightSidebar(nextSong);
  updateFavoriteUI(nextSong);
  syncMixerModalTrackInfo(nextSong);
  if (typeof updateDjTransitionIndicator === 'function') {
    updateDjTransitionIndicator(nextSong);
  }
  if (typeof renderTrackDjAnalysis === 'function') {
    renderTrackDjAnalysis(nextSong);
  }
  renderQueueUI();

  // Trigger smooth cinematic metadata transition
  animateTrackMetadataUpdate(nextSong, true);

  const durEl = document.getElementById('playerTotalDuration');
  const curEl = document.getElementById('playerCurrentTime');
  const timeSlider = document.getElementById('playerTimeline');

  if (durEl) durEl.textContent = formatSeconds(state.duration);
  if (curEl) curEl.textContent = '0:00';
  if (timeSlider) timeSlider.value = 0;

  const mobileNpTotalDuration = document.getElementById('mobileNpTotalDuration');
  const mobileNpCurrentTime = document.getElementById('mobileNpCurrentTime');
  const mobileNpTimeline = document.getElementById('mobileNpTimeline');
  if (mobileNpTotalDuration) mobileNpTotalDuration.textContent = formatSeconds(state.duration);
  if (mobileNpCurrentTime) mobileNpCurrentTime.textContent = '0:00';
  if (mobileNpTimeline) mobileNpTimeline.value = 0;

  // Android notification sync
  if (window.AndroidAudio && typeof window.AndroidAudio.updateMetadata === 'function') {
    try {
      window.AndroidAudio.updateMetadata(nextSong.title || 'Aether Track', nextSong.artist || 'Unknown Artist', nextSong.thumbnail || '', true);
    } catch (e) {}
  }

  // Execute hardware-clock crossfade on Web Audio graph
  AetherAudioEngine.executeCrossfade({
    duration: dur,
    curveType: curve,
    outgoingDeck: outgoingDeck,
    incomingDeck: incomingDeck,
    onComplete: () => {
      state.isExecutingTransition = false;
      state.isTransitioning = false;

      // Unbind all event listeners on outgoing deck before pausing/stopping to prevent false replay of previous track
      if (outgoingDeck && outgoingDeck.audio) {
        try {
          outgoingDeck.audio.onended = null;
          outgoingDeck.audio.onerror = null;
          outgoingDeck.audio.onloadedmetadata = null;
          outgoingDeck.audio.pause();
          outgoingDeck.audio.currentTime = 0;
          outgoingDeck.audio.removeAttribute('src');
          outgoingDeck.audio.load();
        } catch (e) {}
      }

      applyVolume();
      preloadNextTrackInQueue(state.currentQueueIndex);
    }
  });
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

    // Clamp currentSec so it NEVER exceeds the track duration
    if (state.duration > 0 && currentSec > state.duration) {
      currentSec = state.duration;
    }

    state.playbackPosition = currentSec;
    throttledSavePlaybackSession();

    // DJ Transition Engine (Pacemaker style) - only triggers when DJ Transition toggle is enabled
    if (state.djTransitionEnabled && state.duration > 0 && !state.isExecutingTransition && state.currentSong && state.playQueue && state.currentQueueIndex + 1 < state.playQueue.length) {
      const nextSong = state.playQueue[state.currentQueueIndex + 1];
      const transKey = `${state.currentSong.id}_to_${nextSong.id}`;
      const savedTrans = state.trackTransitionsCache[transKey] || state.trackTransitionsCache[`${state.currentSong.id}_default`] || state.djTransitionSettings;
      const transSecs = (savedTrans && savedTrans.durationSeconds) ? savedTrans.durationSeconds : 16;

      if (currentSec >= state.duration - transSecs && currentSec < state.duration - 0.5) {
        if (state.currentPlaybackType === 'audio' || state.currentPlaybackType === 'offline' || state.currentPlaybackType === 'preview') {
          triggerAutomatedQueueTransition(nextSong, savedTrans);
          return;
        }
      }
    }

    // Background track-end detector:
    // Only fire when NOT executing an active transition to prevent interrupting crossfades!
    if (!state.isExecutingTransition && state.duration > 0 && currentSec >= state.duration - 0.75) {
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
    if (state.currentSong && typeof renderTrackDjAnalysis === 'function') {
      setTimeout(() => renderTrackDjAnalysis(state.currentSong), 50);
    }
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

  // 1.1 Render DJ Audio Analysis & Waveform
  if (typeof renderTrackDjAnalysis === 'function') {
    renderTrackDjAnalysis(song);
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
        const isOfflineEnabled = localStorage.getItem('offline_music_enabled') !== 'false';
        state.smartCacheEnabled = isOfflineEnabled ? !!data.settings.smartCacheEnabled : false;
        state.smartCacheLimit = data.settings.smartCacheLimit || 200;
        const toggle = document.getElementById('toggleSmartCache');
        if (toggle) {
          toggle.checked = state.smartCacheEnabled;
          toggle.disabled = !isOfflineEnabled;
        }
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

  const toggleSmartCache = document.getElementById('toggleSmartCache');
  if (toggleSmartCache) {
    if (!enabled) {
      toggleSmartCache.checked = false;
      toggleSmartCache.disabled = true;
      state.smartCacheEnabled = false;
    } else {
      toggleSmartCache.disabled = false;
    }
  }

  const offlineBody = document.getElementById('offlineCardBody');
  if (offlineBody) {
    offlineBody.style.opacity = enabled ? '1' : '0.5';
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
  const toggleSmartCache = document.getElementById('toggleSmartCache');

  if (toggleOffline) {
    const isOfflineEnabled = localStorage.getItem('offline_music_enabled') !== 'false';
    toggleOffline.checked = isOfflineEnabled;
    updateOfflineVisibility(isOfflineEnabled);

    toggleOffline.addEventListener('change', async () => {
      const enabled = toggleOffline.checked;
      localStorage.setItem('offline_music_enabled', enabled ? 'true' : 'false');
      updateOfflineVisibility(enabled);

      // Top to bottom connection:
      // If user disables the offline playlist feature, turn off stream cache immediately
      // because there is no need to cache anything if offline listening is turned off.
      if (!enabled) {
        if (toggleSmartCache) {
          toggleSmartCache.checked = false;
          toggleSmartCache.disabled = true;
        }
        state.smartCacheEnabled = false;
        try {
          await fetch('/api/offline/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ smartCacheEnabled: false, smartCacheLimit: state.smartCacheLimit || 200 })
          });
        } catch (e) {}
      } else {
        if (toggleSmartCache) {
          toggleSmartCache.disabled = false;
        }
      }

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
  if (toggleSmartCache) {
    toggleSmartCache.addEventListener('change', async () => {
      // Bottom to top connection:
      // If user turns on Smart Stream Cache, ensure top switch is active.
      // If user turns OFF Smart Stream Cache, KEEP top switch on! (keep downloaded playlist)
      if (toggleSmartCache.checked) {
        if (toggleOffline && !toggleOffline.checked) {
          toggleOffline.checked = true;
          localStorage.setItem('offline_music_enabled', 'true');
          updateOfflineVisibility(true);
        }
      }

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

// ========================================================
// GLOBAL MEDIA SHORTCUTS & FOCUS MANAGEMENT
// ========================================================

// Spacebar Play/Pause Shortcut:
// When the app is active/focused, pressing Space plays or pauses playback instead of repeating the last button click.
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.key === ' ') {
    const activeEl = document.activeElement;
    const tagName = activeEl ? activeEl.tagName : '';
    const isTextInput = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
    const isEditable = activeEl && (activeEl.isContentEditable || (activeEl.getAttribute && activeEl.getAttribute('contenteditable') === 'true'));

    // Allow normal typing inside input fields, textareas, contenteditable elements
    if (isTextInput || isEditable) {
      return;
    }

    // Intercept spacebar to toggle play/pause cleanly
    e.preventDefault();
    e.stopPropagation();
    togglePlayPause();
  }
}, true); // Capture phase to intercept before focused buttons react

// Auto-blur buttons after click so pressing Space never re-triggers the last clicked button
document.addEventListener('mouseup', (e) => {
  const btn = e.target && e.target.closest('button, [role="button"]');
  if (btn && typeof btn.blur === 'function') {
    btn.blur();
  }
});

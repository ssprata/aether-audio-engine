/**
 * AetherPlayer Cloud Sync Engine
 * 
 * Features:
 * - Guest Mode (Offline/Local first) vs Cloud Synced Mode
 * - Client-Side Zero-Knowledge Encryption (AES-256-GCM via Web Crypto API)
 *   Spotify credentials, playlists, and themes are encrypted locally before reaching Firestore.
 * - Anonymous Passkey Auth (e.g. AETH-XXXX-XXXX-XXXX) - zero personal password reuse danger!
 * - Automatic debounced 2-way sync across Desktop and Android.
 */

const CloudSync = {
  syncKey: null,
  mode: 'guest', // 'guest' | 'cloud'
  status: 'idle', // 'idle' | 'syncing' | 'synced' | 'error' | 'offline'
  lastSyncTime: null,
  _debounceTimer: null,
  _unsubscribeRealtime: null,
  deviceId: null,

  getDeviceId() {
    if (!this.deviceId) {
      let id = localStorage.getItem('aether_device_id');
      if (!id) {
        id = 'dev_' + Math.random().toString(36).substring(2, 10);
        localStorage.setItem('aether_device_id', id);
      }
      this.deviceId = id;
    }
    return this.deviceId;
  },

  async startRealtimeListener() {
    if (this._unsubscribeRealtime) {
      this._unsubscribeRealtime();
      this._unsubscribeRealtime = null;
    }
    if (this.mode !== 'cloud' || !this.syncKey) return;

    try {
      await this.ensureFirebaseAuth();
      const hashedKey = await this.hashPasskey(this.syncKey);
      const docRef = fbDb.collection('accounts').doc(hashedKey);

      this._unsubscribeRealtime = docRef.onSnapshot(async (snapshot) => {
        if (!snapshot.exists) return;
        const data = snapshot.data();
        if (!data || !data.encryptedPayload) return;

        // Skip updates triggered by this same device
        if (data.lastDeviceId === this.getDeviceId()) {
          return;
        }

        console.log('[CloudSync] Live update received from another device!');
        try {
          const decryptedData = await this.decryptPayload(data.encryptedPayload, this.syncKey);
          await this.applyCloudData(decryptedData);
          this.status = 'synced';
          this.lastSyncTime = new Date();
          this.updateUI();
          if (typeof showToast === 'function') {
            showToast('Cloud playlists & settings updated live!');
          }
        } catch (e) {
          console.warn('[CloudSync] Failed to decrypt realtime update:', e);
        }
      }, (err) => {
        console.warn('[CloudSync] Realtime listener error:', err);
      });
      console.log('[CloudSync] Realtime sync listener attached');
    } catch (e) {
      console.warn('[CloudSync] Could not start realtime listener:', e);
    }
  },

  stopRealtimeListener() {
    if (this._unsubscribeRealtime) {
      this._unsubscribeRealtime();
      this._unsubscribeRealtime = null;
    }
  },

  // --- INITIALIZATION ---

  async init() {
    const savedKey = localStorage.getItem('aether_cloud_sync_key');
    if (savedKey) {
      this.syncKey = savedKey;
      this.mode = 'cloud';
      this.status = 'syncing';
      this.updateUI();

      // Attempt initial fetch from cloud and start live listener
      try {
        await this.ensureFirebaseAuth();
        await this.pullFromCloud({ silent: true });
        this.startRealtimeListener();
      } catch (err) {
        console.warn('[CloudSync] Initial fetch failed (possibly offline):', err);
        this.status = 'offline';
        this.updateUI();
      }
    } else {
      this.mode = 'guest';
      this.status = 'idle';
      this.updateUI();
    }
  },

  // Generate a random, human-friendly passkey (e.g. AETH-7K2M-9P4Q-R8X2)
  generateSyncKey() {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // base32 avoiding ambiguous 0/O, 1/I
    const chunk = (len) => {
      const vals = new Uint8Array(len);
      crypto.getRandomValues(vals);
      let s = '';
      for (let i = 0; i < len; i++) {
        s += chars[vals[i] % chars.length];
      }
      return s;
    };
    return `AETH-${chunk(4)}-${chunk(4)}-${chunk(4)}`;
  },

  // Compute SHA-256 hex hash of passkey to use as Firestore document ID
  async hashPasskey(key) {
    const cleanKey = (key || '').trim().toUpperCase();
    const enc = new TextEncoder();
    const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(cleanKey));
    const arr = Array.from(new Uint8Array(hashBuf));
    return arr.map(b => b.toString(16).padStart(2, '0')).join('');
  },

  // Derive AES-256 key from passkey and salt using PBKDF2
  async deriveKey(passkey, salt) {
    const enc = new TextEncoder();
    const cleanKey = (passkey || '').trim().toUpperCase();
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(cleanKey),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  },

  // Encrypt JSON object to Base64 ciphertext
  async encryptPayload(dataObj, passkey) {
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.deriveKey(passkey, salt);
    const jsonString = JSON.stringify(dataObj);

    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      enc.encode(jsonString)
    );

    return {
      salt: this._bufToBase64(salt),
      iv: this._bufToBase64(iv),
      ciphertext: this._bufToBase64(cipherBuf),
      version: 1
    };
  },

  // Decrypt Base64 ciphertext back to JSON object
  async decryptPayload(encryptedObj, passkey) {
    if (!encryptedObj || !encryptedObj.salt || !encryptedObj.iv || !encryptedObj.ciphertext) {
      throw new Error('Invalid encrypted payload structure');
    }
    const salt = this._base64ToBuf(encryptedObj.salt);
    const iv = this._base64ToBuf(encryptedObj.iv);
    const cipherBuf = this._base64ToBuf(encryptedObj.ciphertext);
    const key = await this.deriveKey(passkey, salt);

    const dec = new TextDecoder();
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      cipherBuf
    );

    const jsonString = dec.decode(plainBuf);
    return JSON.parse(jsonString);
  },

  _bufToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  },

  _base64ToBuf(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  },

  // --- FIREBASE AUTHENTICATION ---

  async ensureFirebaseAuth() {
    if (typeof firebase === 'undefined' || !fbAuth) {
      if (typeof initFirebase === 'function') initFirebase();
    }
    if (!fbAuth) {
      throw new Error('Firebase Auth is not available. Please check network connection.');
    }
    if (!fbAuth.currentUser) {
      await fbAuth.signInAnonymously();
    }
    return fbAuth.currentUser;
  },

  // --- INITIALIZATION ---

  async init() {
    const savedKey = localStorage.getItem('aether_cloud_sync_key');
    if (savedKey) {
      this.syncKey = savedKey;
      this.mode = 'cloud';
      this.status = 'syncing';
      this.updateUI();

      // Attempt initial fetch from cloud
      try {
        await this.ensureFirebaseAuth();
        await this.pullFromCloud({ silent: true });
      } catch (err) {
        console.warn('[CloudSync] Initial fetch failed (possibly offline):', err);
        this.status = 'offline';
        this.updateUI();
      }
    } else {
      this.mode = 'guest';
      this.status = 'idle';
      this.updateUI();
    }
  },

  // --- GUEST / CLOUD MODE ACTIONS ---

  // Create a brand new cloud account with a generated (or custom) key
  async createAccount(customKey = null) {
    try {
      this.status = 'syncing';
      this.updateUI();

      const key = (customKey || this.generateSyncKey()).trim().toUpperCase();
      if (key.length < 6) {
        throw new Error('Sync Key must be at least 6 characters long.');
      }

      await this.ensureFirebaseAuth();

      const hashedKey = await this.hashPasskey(key);
      const payload = this.gatherLocalData();
      const encrypted = await this.encryptPayload(payload, key);

      // Save to Firestore
      await fbDb.collection('accounts').doc(hashedKey).set({
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        deviceInfo: navigator.userAgent.substring(0, 100),
        encryptedPayload: encrypted
      });

      this.syncKey = key;
      this.mode = 'cloud';
      this.status = 'synced';
      this.lastSyncTime = new Date();
      localStorage.setItem('aether_cloud_sync_key', key);

      this.updateUI();
      this.startRealtimeListener();
      if (typeof showToast === 'function') {
        showToast('Cloud Account Created! Key: ' + key);
      }
      return { success: true, key };
    } catch (err) {
      console.error('[CloudSync] createAccount error:', err);
      this.status = 'error';
      this.updateUI();
      if (typeof showToast === 'function') {
        showToast('Failed to create cloud account: ' + err.message);
      }
      throw err;
    }
  },

  // Connect this device using an existing sync key
  async connectAccount(key) {
    try {
      const cleanKey = (key || '').trim().toUpperCase();
      if (!cleanKey) {
        throw new Error('Please enter a valid Sync Key.');
      }

      this.status = 'syncing';
      this.updateUI();

      await this.ensureFirebaseAuth();

      const hashedKey = await this.hashPasskey(cleanKey);
      const docSnap = await fbDb.collection('accounts').doc(hashedKey).get();

      if (!docSnap.exists) {
        throw new Error('No account found for this Sync Key. Double-check your code.');
      }

      const docData = docSnap.data();
      if (!docData.encryptedPayload) {
        throw new Error('Account data is empty or invalid.');
      }

      // Decrypt with user's key
      let decryptedData;
      try {
        decryptedData = await this.decryptPayload(docData.encryptedPayload, cleanKey);
      } catch (decErr) {
        throw new Error('Decryption failed! Incorrect Sync Key or passkey.');
      }

      // Restore data onto this device
      await this.applyCloudData(decryptedData);

      this.syncKey = cleanKey;
      this.mode = 'cloud';
      this.status = 'synced';
      this.lastSyncTime = new Date();
      localStorage.setItem('aether_cloud_sync_key', cleanKey);

      this.updateUI();
      this.startRealtimeListener();
      if (typeof showToast === 'function') {
        showToast('Successfully connected & synced from Cloud!');
      }
      return { success: true };
    } catch (err) {
      console.error('[CloudSync] connectAccount error:', err);
      this.status = this.syncKey ? 'error' : 'idle';
      this.updateUI();
      if (typeof showToast === 'function') {
        showToast(err.message);
      }
      throw err;
    }
  },

  // Disconnect from cloud and revert back to local guest mode
  disconnect() {
    this.stopRealtimeListener();
    this.syncKey = null;
    this.mode = 'guest';
    this.status = 'idle';
    this.lastSyncTime = null;
    localStorage.removeItem('aether_cloud_sync_key');
    this.updateUI();
    if (typeof showToast === 'function') {
      showToast('Switched to Guest mode (Local only).');
    }
  },

  // --- DATA PULL & PUSH ---

  // Pull latest data from cloud
  async pullFromCloud(options = {}) {
    if (this.mode !== 'cloud' || !this.syncKey) return;
    try {
      this.status = 'syncing';
      this.updateUI();

      await this.ensureFirebaseAuth();
      const hashedKey = await this.hashPasskey(this.syncKey);
      const docSnap = await fbDb.collection('accounts').doc(hashedKey).get();

      if (!docSnap.exists) {
        throw new Error('Account document not found on server.');
      }

      const docData = docSnap.data();
      const decryptedData = await this.decryptPayload(docData.encryptedPayload, this.syncKey);

      await this.applyCloudData(decryptedData);

      this.status = 'synced';
      this.lastSyncTime = new Date();
      this.updateUI();

      if (!options.silent && typeof showToast === 'function') {
        showToast('Cloud data synchronized!');
      }
    } catch (err) {
      console.error('[CloudSync] pullFromCloud error:', err);
      this.status = 'error';
      this.updateUI();
      if (!options.silent && typeof showToast === 'function') {
        showToast('Sync error: ' + err.message);
      }
    }
  },

  // Push latest local data to cloud (immediate)
  async pushToCloud() {
    if (this.mode !== 'cloud' || !this.syncKey) return;
    try {
      this.status = 'syncing';
      this.updateUI();

      await this.ensureFirebaseAuth();
      const hashedKey = await this.hashPasskey(this.syncKey);
      const payload = this.gatherLocalData();
      const encrypted = await this.encryptPayload(payload, this.syncKey);

      await fbDb.collection('accounts').doc(hashedKey).set({
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        lastDeviceId: this.getDeviceId(),
        deviceInfo: navigator.userAgent.substring(0, 100),
        encryptedPayload: encrypted
      }, { merge: true });

      this.status = 'synced';
      this.lastSyncTime = new Date();
      this.updateUI();
    } catch (err) {
      console.error('[CloudSync] pushToCloud error:', err);
      this.status = 'error';
      this.updateUI();
    }
  },

  // Debounced push to avoid hammering Firestore during fast actions
  debouncedPush(delayMs = 1200) {
    if (this.mode !== 'cloud' || !this.syncKey) return;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this.status = 'syncing';
    this.updateUI();

    this._debounceTimer = setTimeout(() => {
      this.pushToCloud();
    }, delayMs);
  },

  // --- LOCAL DATA GATHERING & RESTORATION ---

  gatherLocalData() {
    const spotifyClientId = document.getElementById('spotifyClientId')?.value.trim() || '';
    const spotifySecretInput = document.getElementById('spotifyClientSecret')?.value.trim() || '';
    // Use raw in-memory secret if input only shows bullet mask dots
    const spotifyClientSecret = (spotifySecretInput && !spotifySecretInput.includes('•'))
      ? spotifySecretInput
      : (state._rawSpotifySecret || '');

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      playlists: state.playlists || [],
      customThemes: state.customThemes || [],
      currentTheme: state.currentTheme || null,
      profile: {
        username: state.profile?.username || 'Music Enthusiast',
        avatar: state.profile?.avatar || ''
      },
      spotify: {
        clientId: spotifyClientId,
        clientSecret: spotifyClientSecret
      }
    };
  },

  async applyCloudData(data) {
    if (!data) return;

    // 1. Playlists
    if (Array.isArray(data.playlists)) {
      state.playlists = data.playlists;
      localStorage.setItem('playlists', JSON.stringify(state.playlists));
      if (typeof renderPlaylists === 'function') renderPlaylists();
      // Also update local server.py backup file
      try {
        await fetch('/api/backup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state.playlists)
        });
      } catch (e) {
        console.warn('Could not forward backup to local server:', e);
      }
    }

    // 2. Custom Themes
    if (Array.isArray(data.customThemes)) {
      state.customThemes = data.customThemes;
      localStorage.setItem('custom_themes', JSON.stringify(state.customThemes));
      if (typeof renderCustomThemesList === 'function') renderCustomThemesList();
    }

    // 3. Current Theme
    if (data.currentTheme) {
      state.currentTheme = data.currentTheme;
      localStorage.setItem('current_theme_settings', JSON.stringify(state.currentTheme));
      if (typeof applyCurrentTheme === 'function') applyCurrentTheme();
    }

    // 4. Profile
    if (data.profile) {
      if (data.profile.username) state.profile.username = data.profile.username;
      if (data.profile.avatar) state.profile.avatar = data.profile.avatar;
      localStorage.setItem('profile', JSON.stringify(state.profile));
      if (typeof updateUserProfileUI === 'function') updateUserProfileUI();
    }

    // 5. Spotify Credentials
    if (data.spotify) {
      const clientId = data.spotify.clientId || '';
      const clientSecret = data.spotify.clientSecret || '';

      if (clientId || clientSecret) {
        state.spotifyConfigured = (clientId && clientSecret);
        state._rawSpotifySecret = clientSecret;

        const idEl = document.getElementById('spotifyClientId');
        const secEl = document.getElementById('spotifyClientSecret');
        if (idEl) idEl.value = clientId;
        if (secEl) secEl.value = clientSecret ? '••••••••••••••••' : '';

        // Forward decrypted credentials to local Python server.py
        try {
          await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              spotifyClientId: clientId,
              spotifyClientSecret: clientSecret
            })
          });
          console.log('[CloudSync] Forwarded decrypted Spotify keys to local server.py');
        } catch (e) {
          console.warn('Could not push Spotify settings to local server:', e);
        }
      }
    }
  },

  // --- UI UPDATE SYNC ---

  updateUI() {
    // 1. Header Cloud Status Pill
    const pill = document.getElementById('btnHeaderCloud');
    const pillText = document.getElementById('headerCloudStatus');
    const pillDot = document.getElementById('headerCloudDot');

    if (pill && pillText) {
      pill.classList.remove('status-guest', 'status-synced', 'status-syncing', 'status-error', 'status-offline');
      if (this.mode === 'guest') {
        pill.classList.add('status-guest');
        pillText.textContent = 'Guest';
      } else {
        if (this.status === 'syncing') {
          pill.classList.add('status-syncing');
          pillText.textContent = 'Syncing...';
        } else if (this.status === 'error') {
          pill.classList.add('status-error');
          pillText.textContent = 'Sync Error';
        } else if (this.status === 'offline') {
          pill.classList.add('status-offline');
          pillText.textContent = 'Offline';
        } else {
          pill.classList.add('status-synced');
          // Shorten key for display: e.g. AETH-7K2M...
          const shortKey = this.syncKey ? this.syncKey.split('-').slice(0, 2).join('-') : 'Cloud';
          pillText.textContent = shortKey;
        }
      }
    }

    // 2. Profile Tab Cloud Card elements
    const cardStatusBadge = document.getElementById('cloudCardStatusBadge');
    const keyDisplayBox = document.getElementById('cloudKeyDisplayBox');
    const currentKeyText = document.getElementById('cloudCurrentKeyText');
    const guestActions = document.getElementById('cloudGuestActions');
    const connectedActions = document.getElementById('cloudConnectedActions');
    const lastSyncEl = document.getElementById('cloudLastSyncTime');

    if (cardStatusBadge) {
      if (this.mode === 'guest') {
        cardStatusBadge.textContent = 'Guest Mode (Local Only)';
        cardStatusBadge.className = 'badge badge-guest';
        if (keyDisplayBox) keyDisplayBox.style.display = 'none';
        if (guestActions) guestActions.style.display = 'flex';
        if (connectedActions) connectedActions.style.display = 'none';
      } else {
        cardStatusBadge.textContent = 'Cloud Synced (Encrypted)';
        cardStatusBadge.className = 'badge badge-success';
        if (keyDisplayBox) keyDisplayBox.style.display = 'flex';
        if (currentKeyText) currentKeyText.textContent = this.syncKey || '';
        if (guestActions) guestActions.style.display = 'none';
        if (connectedActions) connectedActions.style.display = 'flex';
        if (lastSyncEl) {
          lastSyncEl.textContent = this.lastSyncTime
            ? 'Last synced: ' + this.lastSyncTime.toLocaleTimeString()
            : 'Synchronized with cloud';
        }
      }
    }
  }
};

// Initialize CloudSync after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Give Firebase a short tick to initialize
  setTimeout(() => {
    CloudSync.init();
  }, 100);
});

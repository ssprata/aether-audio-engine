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
  _isApplyingRemote: false,
  _lastToastTime: 0,
  _cachedKey: null,
  _cachedSaltStr: null,
  _cachedPasskey: null,
  _isKeyMasked: false,
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

          const now = Date.now();
          if (now - this._lastToastTime > 8000) {
            this._lastToastTime = now;
            if (typeof showToast === 'function') {
              showToast('Cloud playlists & settings updated live!');
            }
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
    this._isKeyMasked = localStorage.getItem('aether_cloud_key_masked') === 'true';
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

  // Derive AES-256 key from passkey and salt using PBKDF2 (with fast in-memory cache)
  async deriveKey(passkey, salt) {
    const cleanKey = (passkey || '').trim().toUpperCase();
    const saltStr = this._bufToBase64(salt);
    if (this._cachedKey && this._cachedPasskey === cleanKey && this._cachedSaltStr === saltStr) {
      return this._cachedKey;
    }

    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(cleanKey),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    const derived = await crypto.subtle.deriveKey(
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

    this._cachedKey = derived;
    this._cachedPasskey = cleanKey;
    this._cachedSaltStr = saltStr;
    return derived;
  },

  // Get or persist account salt so key derivation doesn't need to re-run on every push
  getAccountSalt(passkey) {
    const cleanKey = (passkey || '').trim().toUpperCase();
    let savedSalt = localStorage.getItem('aether_sync_salt_' + cleanKey);
    if (!savedSalt) {
      const saltBuf = crypto.getRandomValues(new Uint8Array(16));
      savedSalt = this._bufToBase64(saltBuf);
      localStorage.setItem('aether_sync_salt_' + cleanKey, savedSalt);
    }
    return this._base64ToBuf(savedSalt);
  },

  // Encrypt JSON object to Base64 ciphertext
  async encryptPayload(dataObj, passkey) {
    const enc = new TextEncoder();
    const salt = this.getAccountSalt(passkey);
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
    this._cachedKey = null;
    this._cachedSaltStr = null;
    this._cachedPasskey = null;
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
    if (this.mode !== 'cloud' || !this.syncKey || this._isApplyingRemote) return;
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
    if (this.mode !== 'cloud' || !this.syncKey || this._isApplyingRemote) return;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this.status = 'syncing';
    this.updateUI();

    this._debounceTimer = setTimeout(() => {
      if (this._isApplyingRemote) return;
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
    this._isApplyingRemote = true;

    try {
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
    } finally {
      // Keep guard active for 1500ms so any queued timeouts from applyCurrentTheme die silently
      setTimeout(() => {
        this._isApplyingRemote = false;
      }, 1500);
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
        this.updatePasskeyDisplay();
        if (guestActions) guestActions.style.display = 'none';
        if (connectedActions) connectedActions.style.display = 'flex';
        if (lastSyncEl) {
          lastSyncEl.textContent = this.lastSyncTime
            ? 'Last synced: ' + this.lastSyncTime.toLocaleTimeString()
            : 'Synchronized with cloud';
        }
      }
    }
  },

  toggleKeyMask() {
    this._isKeyMasked = !this._isKeyMasked;
    localStorage.setItem('aether_cloud_key_masked', this._isKeyMasked ? 'true' : 'false');
    this.updatePasskeyDisplay();
    if (typeof showToast === 'function') {
      showToast(this._isKeyMasked ? 'Passkey masked (stream-safe)' : 'Passkey revealed');
    }
  },

  updatePasskeyDisplay() {
    const currentKeyText = document.getElementById('cloudCurrentKeyText');
    const btnToggleMask = document.getElementById('btnToggleCloudKeyMask');
    const maskTextSpan = document.getElementById('btnToggleCloudKeyMaskText');
    if (!currentKeyText) return;

    const fullKey = (this.syncKey || localStorage.getItem('aether_cloud_sync_key') || '').trim();
    if (!fullKey) {
      currentKeyText.textContent = 'AETH-••••-••••-••••';
      return;
    }

    if (this._isKeyMasked) {
      const parts = fullKey.split('-');
      if (parts.length === 4) {
        currentKeyText.textContent = `${parts[0]}-••••-••••-••••`;
      } else {
        currentKeyText.textContent = '••••-••••-••••-••••';
      }
      if (btnToggleMask) {
        btnToggleMask.title = 'Show Passkey';
        btnToggleMask.setAttribute('aria-label', 'Show Passkey');
      }
      if (maskTextSpan) {
        maskTextSpan.textContent = 'Show';
      }
      const iconContainer = btnToggleMask ? btnToggleMask.querySelector('svg') : null;
      if (iconContainer) {
        iconContainer.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
      }
    } else {
      currentKeyText.textContent = fullKey;
      if (btnToggleMask) {
        btnToggleMask.title = 'Hide Passkey (Streamer Mode)';
        btnToggleMask.setAttribute('aria-label', 'Hide Passkey');
      }
      if (maskTextSpan) {
        maskTextSpan.textContent = 'Hide';
      }
      const iconContainer = btnToggleMask ? btnToggleMask.querySelector('svg') : null;
      if (iconContainer) {
        iconContainer.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
      }
    }
  },

  // --- QR CODE DISPLAY & SCANNER METHODS ---
  _scannerStream: null,
  _scanAnimId: null,

  setupCardCollapse() {
    const card = document.getElementById('cloudSyncCard');
    const toggleBtn = document.getElementById('btnToggleCloudCard');
    if (!card || !toggleBtn) return;

    // Check persisted state
    const isCollapsed = localStorage.getItem('cloud_sync_card_collapsed') === 'true';
    if (isCollapsed) {
      card.classList.add('is-collapsed');
    }

    toggleBtn.addEventListener('click', () => {
      const currentlyCollapsed = card.classList.toggle('is-collapsed');
      localStorage.setItem('cloud_sync_card_collapsed', currentlyCollapsed ? 'true' : 'false');
    });
  },

  showPasskeyQr(passkey = null) {
    const savedKey = localStorage.getItem('aether_cloud_sync_key');
    const domKeyEl = document.getElementById('cloudCurrentKeyText');
    const cleanDomKey = (domKeyEl && !domKeyEl.textContent.includes('•')) ? domKeyEl.textContent : '';
    const key = (passkey || this.syncKey || savedKey || cleanDomKey || '').trim().toUpperCase();
    const modal = document.getElementById('modalCloudQrDisplay');
    const container = document.getElementById('cloudQrContainer');
    const keyText = document.getElementById('cloudQrPasskeyText');

    if (!key) {
      if (typeof showToast === 'function') {
        showToast('Generate or connect a Cloud Passkey first to view QR code');
      }
      return;
    }

    if (keyText) keyText.textContent = key;
    if (container) {
      container.innerHTML = '';
      if (typeof QRCode !== 'undefined') {
        try {
          new QRCode(container, {
            text: key,
            width: 200,
            height: 200,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
          });
        } catch (e) {
          console.warn('[CloudSync] QRCode library error, fallback:', e);
          this._renderQrFallback(container, key);
        }
      } else {
        this._renderQrFallback(container, key);
      }
    }

    if (modal) {
      modal.style.display = 'flex';
      modal.classList.add('active');
    }
  },

  _renderQrFallback(container, key) {
    const img = document.createElement('img');
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(key)}`;
    img.alt = `QR Code for ${key}`;
    img.style.width = '200px';
    img.style.height = '200px';
    container.appendChild(img);
  },

  hidePasskeyQr() {
    const modal = document.getElementById('modalCloudQrDisplay');
    if (modal) {
      modal.classList.remove('active');
      modal.style.display = 'none';
    }
  },

  async startQrScanner() {
    const modal = document.getElementById('modalCloudQrScanner');
    const video = document.getElementById('cloudQrVideo');
    const canvas = document.getElementById('cloudQrCanvas');
    const statusText = document.getElementById('cloudQrScanStatus');

    if (modal) {
      modal.style.display = 'flex';
      modal.classList.add('active');
    }
    if (statusText) statusText.textContent = 'Starting camera...';

    try {
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } }
        });
      } catch (e1) {
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      }

      this._scannerStream = stream;
      if (video) {
        video.muted = true;
        video.defaultMuted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', 'true');
        video.setAttribute('webkit-playsinline', 'true');
        video.setAttribute('autoplay', 'true');
        video.setAttribute('muted', 'true');
        video.srcObject = stream;

        video.onloadedmetadata = () => {
          video.play().catch(e => console.warn('[CloudSync] Play on metadata error:', e));
          if (statusText) statusText.textContent = 'Point camera at Passkey QR code';
        };

        try {
          await video.play();
        } catch (playErr) {
          console.warn('[CloudSync] Initial play error:', playErr);
        }
      }

      const viewport = document.getElementById('qrScannerViewport');
      if (viewport && video) {
        viewport.onclick = () => {
          if (video.paused) {
            video.play().catch(e => console.warn('[CloudSync] User tap play error:', e));
          }
        };
      }

      if (statusText) statusText.textContent = 'Point camera at Passkey QR code';

      // Check for native BarcodeDetector
      let barcodeDetector = null;
      if ('BarcodeDetector' in window) {
        try {
          barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
        } catch (e) {
          barcodeDetector = null;
        }
      }

      const scanLoop = async () => {
        if (!this._scannerStream) return;

        if (video && video.readyState >= video.HAVE_CURRENT_DATA) {
          let detectedText = null;

          if (barcodeDetector) {
            try {
              const barcodes = await barcodeDetector.detect(video);
              if (barcodes && barcodes.length > 0) {
                detectedText = barcodes[0].rawValue;
              }
            } catch (err) {}
          }

          if (!detectedText && typeof jsQR !== 'undefined' && canvas) {
            canvas.width = video.videoWidth || 320;
            canvas.height = video.videoHeight || 240;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imgData.data, imgData.width, imgData.height, {
              inversionAttempts: 'dontInvert'
            });
            if (code && code.data) {
              detectedText = code.data;
            }
          }

          if (detectedText) {
            this._handleDetectedPasskey(detectedText);
            return;
          }
        }

        this._scanAnimId = requestAnimationFrame(scanLoop);
      };

      this._scanAnimId = requestAnimationFrame(scanLoop);

    } catch (err) {
      console.warn('[CloudSync] Camera access failed:', err);
      if (statusText) {
        statusText.innerHTML = `
          <span style="color: #f87171;">Camera permission or device unavailable.</span><br>
          <span style="font-size: 0.78rem; opacity: 0.8;">Check Android camera permission or choose an image below.</span>
        `;
      }
    }
  },

  stopQrScanner() {
    if (this._scanAnimId) {
      cancelAnimationFrame(this._scanAnimId);
      this._scanAnimId = null;
    }
    if (this._scannerStream) {
      this._scannerStream.getTracks().forEach(track => track.stop());
      this._scannerStream = null;
    }
    const video = document.getElementById('cloudQrVideo');
    if (video) video.srcObject = null;

    const modal = document.getElementById('modalCloudQrScanner');
    if (modal) {
      modal.classList.remove('active');
      modal.style.display = 'none';
    }
  },

  _handleDetectedPasskey(rawText) {
    if (!rawText) return;
    let clean = rawText.trim().toUpperCase();

    // Extract AETH-XXXX-XXXX-XXXX if present
    const aethMatch = clean.match(/AETH-[A-Z0-9]{3,5}-[A-Z0-9]{3,5}-[A-Z0-9]{3,5}/);
    if (aethMatch) {
      clean = aethMatch[0];
    }

    if (navigator.vibrate) {
      try { navigator.vibrate([100, 50, 100]); } catch (e) {}
    }

    this.stopQrScanner();

    const inputKey = document.getElementById('inputConnectKey');
    if (inputKey) {
      inputKey.value = clean;
    }

    if (typeof showToast === 'function') {
      showToast(`Passkey scanned: ${clean}`);
    }

    const btnConnect = document.getElementById('btnConnectCloudAccount');
    if (btnConnect) {
      setTimeout(() => btnConnect.click(), 300);
    }
  },

  scanFromImageFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        let detected = null;
        if ('BarcodeDetector' in window) {
          try {
            const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
            const barcodes = await detector.detect(canvas);
            if (barcodes && barcodes.length > 0) {
              detected = barcodes[0].rawValue;
            }
          } catch (err) {}
        }

        if (!detected && typeof jsQR !== 'undefined') {
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imgData.data, imgData.width, imgData.height);
          if (code && code.data) detected = code.data;
        }

        if (detected) {
          this._handleDetectedPasskey(detected);
        } else {
          if (typeof showToast === 'function') {
            showToast('No QR code could be found in that image.');
          }
        }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  },

  setupQrAndCollapseEvents() {
    this.setupCardCollapse();

    // Toggle Passkey Mask (Hide/Show)
    const btnToggleMask = document.getElementById('btnToggleCloudKeyMask');
    if (btnToggleMask) {
      btnToggleMask.addEventListener('click', () => this.toggleKeyMask());
    }

    // Show QR modal triggers
    const btnShowQr = document.getElementById('btnShowCloudQr');
    if (btnShowQr) {
      btnShowQr.addEventListener('click', () => this.showPasskeyQr());
    }

    const btnCloseQrDisplay = document.getElementById('btnCloseCloudQrDisplay');
    const btnDoneQrDisplay = document.getElementById('btnDoneCloudQrDisplay');
    if (btnCloseQrDisplay) btnCloseQrDisplay.addEventListener('click', () => this.hidePasskeyQr());
    if (btnDoneQrDisplay) btnDoneQrDisplay.addEventListener('click', () => this.hidePasskeyQr());

    // Scanner triggers
    const btnScanQr = document.getElementById('btnScanCloudQr');
    if (btnScanQr) {
      btnScanQr.addEventListener('click', () => this.startQrScanner());
    }

    const btnCloseScanner = document.getElementById('btnCloseCloudQrScanner');
    const btnCancelScanner = document.getElementById('btnCancelCloudQrScanner');
    if (btnCloseScanner) btnCloseScanner.addEventListener('click', () => this.stopQrScanner());
    if (btnCancelScanner) btnCancelScanner.addEventListener('click', () => this.stopQrScanner());

    // File input fallback
    const fileInput = document.getElementById('inputQrImageFile');
    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
          this.scanFromImageFile(e.target.files[0]);
        }
      });
    }
  }
};

// Initialize CloudSync after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Give Firebase a short tick to initialize
  setTimeout(() => {
    CloudSync.init();
    CloudSync.setupQrAndCollapseEvents();
  }, 100);
});

/**
 * AetherJam - Real-Time Collaborative Jam Session Engine (v2.5.0)
 * 
 * Features:
 * - Spotify Jam-style synchronized music listening with friends
 * - Anchor Timestamp Playback Synchronization (zero continuous DB ticks/bloat)
 * - Shared real-time queue (add, reorder, vote/skip)
 * - Multi-device support: Desktop PC, Mobile browser, Android app
 * - Instant connection via 6-character room codes (JAM-XXXX) & live QR codes
 * - URL invite links (?jam=JAM-XXXX) with auto-join
 * - Powered by Firebase Firestore realtime listeners (onSnapshot)
 */

const AetherJam = {
  isActive: false,
  isHost: false,
  jamCode: null,
  controlMode: 'everyone', // 'everyone' | 'host_only'
  participants: [],
  currentSong: null,
  isPlaying: false,
  trackOffset: 0,
  serverTimestamp: 0,
  
  // Internal control flags
  _unsubscribe: null,
  _isApplyingRemote: false,
  _heartbeatTimer: null,
  _driftCheckTimer: null,
  _lastBroadcastTime: 0,
  _lastToastMessage: '',
  _lastToastTime: 0,
  _myParticipantId: null,

  // --- INITIALIZATION ---

  init() {
    this._myParticipantId = this.getParticipantId();
    this.setupUIEventListeners();
    this.checkUrlForJamInvite();
    this.updatePillUI();
    console.log('[AetherJam] Engine initialized. Device ID:', this._myParticipantId);
  },

  getParticipantId() {
    let id = localStorage.getItem('aether_jam_device_id');
    if (!id) {
      if (typeof CloudSync !== 'undefined' && typeof CloudSync.getDeviceId === 'function') {
        id = CloudSync.getDeviceId();
      } else {
        id = 'jam_dev_' + Math.random().toString(36).substring(2, 9);
      }
      localStorage.setItem('aether_jam_device_id', id);
    }
    return id;
  },

  getUserInfo() {
    let username = 'Music Friend';
    let avatar = '';
    if (typeof state !== 'undefined' && state.profile) {
      if (state.profile.username) username = state.profile.username;
      if (state.profile.avatar) avatar = state.profile.avatar;
    }
    return { username, avatar };
  },

  // --- ROOM CODE GENERATOR ---

  generateRoomCode() {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // exclude ambiguous 0/O, 1/I
    let code = 'JAM-';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  },

  // --- CREATE JAM SESSION (HOST) ---

  async createJam() {
    if (typeof fbDb === 'undefined' || !fbDb) {
      showToast('Firebase connection is offline');
      return;
    }

    const { username, avatar } = this.getUserInfo();
    const code = this.generateRoomCode();
    this.jamCode = code;
    this.isHost = true;
    this.controlMode = 'everyone';

    const currentTrack = (typeof state !== 'undefined' && state.currentSong) ? state.currentSong : null;
    const currentQueue = (typeof state !== 'undefined' && Array.isArray(state.playQueue)) ? state.playQueue : [];
    const queueIdx = (typeof state !== 'undefined' && typeof state.currentQueueIndex === 'number') ? state.currentQueueIndex : 0;
    const isPlaying = (typeof state !== 'undefined' && state.isPlaying);
    const playbackPos = (typeof state !== 'undefined' && state.playbackPosition) ? state.playbackPosition : 0;

    const sessionData = {
      code: code,
      hostId: this._myParticipantId,
      hostName: username,
      controlMode: 'everyone',
      status: 'active',
      currentSong: currentTrack,
      isPlaying: isPlaying,
      trackOffset: playbackPos,
      serverTimestamp: Date.now(),
      playQueue: currentQueue,
      currentQueueIndex: queueIdx,
      participants: [
        {
          id: this._myParticipantId,
          name: username,
          avatar: avatar,
          isHost: true,
          lastPing: Date.now()
        }
      ],
      createdAt: Date.now(),
      lastUpdated: Date.now()
    };

    try {
      showToast('Creating Jam room...');
      await fbDb.collection('jam_sessions').doc(code).set(sessionData);
      
      this.isActive = true;
      this.participants = sessionData.participants;
      this.currentSong = currentTrack;
      this.isPlaying = isPlaying;
      this.trackOffset = playbackPos;
      this.serverTimestamp = sessionData.serverTimestamp;

      this.startRealtimeListener(code);
      this.startHeartbeat(code);
      this.startDriftCorrection();
      this.updatePillUI();
      this.renderJamModal();

      showToast(`🎉 Jam ${code} started! Share code with friends.`);
    } catch (err) {
      console.error('[AetherJam] Error creating jam session:', err);
      showToast('Failed to create Jam: ' + (err.message || 'Network error'));
    }
  },

  // --- JOIN JAM SESSION (GUEST) ---

  async joinJam(rawCode) {
    if (!rawCode) return;
    let code = rawCode.trim().toUpperCase();
    if (!code.startsWith('JAM-') && code.length === 4) {
      code = 'JAM-' + code;
    }

    if (typeof fbDb === 'undefined' || !fbDb) {
      showToast('Firebase connection is offline');
      return;
    }

    try {
      showToast('Connecting to Jam...');
      const docRef = fbDb.collection('jam_sessions').doc(code);
      const snapshot = await docRef.get();

      if (!snapshot.exists) {
        showToast(`Jam room "${code}" not found.`);
        return;
      }

      const data = snapshot.data();
      if (data.status === 'ended') {
        showToast('This Jam session has ended.');
        return;
      }

      const { username, avatar } = this.getUserInfo();
      this.jamCode = code;
      this.isHost = (data.hostId === this._myParticipantId);
      this.controlMode = data.controlMode || 'everyone';
      this.isActive = true;

      // Add self to participants list if not already there
      const participants = Array.isArray(data.participants) ? [...data.participants] : [];
      const existingIdx = participants.findIndex(p => p.id === this._myParticipantId);
      const myParticipantObj = {
        id: this._myParticipantId,
        name: username,
        avatar: avatar,
        isHost: this.isHost,
        lastPing: Date.now()
      };

      if (existingIdx !== -1) {
        participants[existingIdx] = myParticipantObj;
      } else {
        participants.push(myParticipantObj);
      }

      await docRef.update({
        participants: participants,
        lastUpdated: Date.now()
      });

      this.participants = participants;
      this.startRealtimeListener(code);
      this.startHeartbeat(code);
      this.startDriftCorrection();
      this.updatePillUI();
      this.renderJamModal();

      // Immediately synchronize state from host snapshot
      this.applyRemoteUpdate(data, true);

      showToast(`Joined Jam ${code}! Listening with ${data.hostName || 'friends'}`);
    } catch (err) {
      console.error('[AetherJam] Error joining jam session:', err);
      showToast('Could not join Jam: ' + (err.message || 'Check connection'));
    }
  },

  // --- LEAVE JAM SESSION ---

  async leaveJam() {
    if (!this.isActive || !this.jamCode) return;
    const code = this.jamCode;

    // Clean up timers & listener first
    this.stopRealtimeListener();
    this.stopHeartbeat();
    this.stopDriftCorrection();

    // If host, offer to either transfer or end
    if (this.isHost) {
      await this.endJam();
      return;
    }

    try {
      if (typeof fbDb !== 'undefined' && fbDb) {
        const docRef = fbDb.collection('jam_sessions').doc(code);
        const snapshot = await docRef.get();
        if (snapshot.exists) {
          const data = snapshot.data();
          const updated = (data.participants || []).filter(p => p.id !== this._myParticipantId);
          await docRef.update({
            participants: updated,
            lastUpdated: Date.now()
          });
        }
      }
    } catch (err) {
      console.warn('[AetherJam] Error leaving room:', err);
    }

    this.isActive = false;
    this.isHost = false;
    this.jamCode = null;
    this.participants = [];
    this.updatePillUI();
    this.renderJamModal();
    showToast('Left Jam session');
  },

  // --- END JAM SESSION (HOST ONLY) ---

  async endJam() {
    if (!this.jamCode) return;
    const code = this.jamCode;

    try {
      if (typeof fbDb !== 'undefined' && fbDb) {
        await fbDb.collection('jam_sessions').doc(code).update({
          status: 'ended',
          isPlaying: false,
          lastUpdated: Date.now()
        });
      }
    } catch (err) {
      console.warn('[AetherJam] Error ending room:', err);
    }

    this.stopRealtimeListener();
    this.stopHeartbeat();
    this.stopDriftCorrection();
    this.isActive = false;
    this.isHost = false;
    this.jamCode = null;
    this.participants = [];
    this.updatePillUI();
    this.renderJamModal();
    showToast('Jam session ended');
  },

  // --- REALTIME FIRESTORE LISTENER ---

  startRealtimeListener(code) {
    this.stopRealtimeListener();
    if (typeof fbDb === 'undefined' || !fbDb) return;

    const docRef = fbDb.collection('jam_sessions').doc(code);
    this._unsubscribe = docRef.onSnapshot((doc) => {
      if (!doc.exists) {
        showToast('Jam session was closed');
        this.leaveJam();
        return;
      }

      const data = doc.data();
      if (!data) return;

      if (data.status === 'ended') {
        showToast('Jam session was ended by the host');
        this.leaveJam();
        return;
      }

      // Update local participants cache
      if (Array.isArray(data.participants)) {
        this.participants = data.participants;
        this.updatePillUI();
        this.updateParticipantsUI();
      }

      if (data.controlMode) {
        this.controlMode = data.controlMode;
      }

      // Skip remote update application if this device triggered the last broadcast
      if (data.lastUpdatedBy === this._myParticipantId) {
        return;
      }

      this.applyRemoteUpdate(data, false);
    }, (err) => {
      console.warn('[AetherJam] Realtime listener error:', err);
    });
  },

  stopRealtimeListener() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  },

  // --- APPLY REMOTE UPDATE (ANCHOR TIMESTAMP SYNC) ---

  applyRemoteUpdate(data, isInitial = false) {
    if (!data) return;
    this._isApplyingRemote = true;

    try {
      const now = Date.now();
      const serverTime = data.serverTimestamp || now;
      const baseOffset = (typeof data.trackOffset === 'number') ? data.trackOffset : 0;
      const isRemotePlaying = !!data.isPlaying;

      // Calculate exact expected current playback timestamp
      let expectedSeconds = baseOffset;
      if (isRemotePlaying) {
        const elapsedSinceAnchor = Math.max(0, (now - serverTime) / 1000);
        expectedSeconds = baseOffset + elapsedSinceAnchor;
      }

      this.isPlaying = isRemotePlaying;
      this.trackOffset = baseOffset;
      this.serverTimestamp = serverTime;

      // 1. Shared Queue Sync
      if (Array.isArray(data.playQueue) && typeof state !== 'undefined') {
        // Compare queue length or IDs to avoid re-rendering if unchanged
        const currentQueueIds = (state.playQueue || []).map(s => s.id).join(',');
        const remoteQueueIds = data.playQueue.map(s => s.id).join(',');
        if (currentQueueIds !== remoteQueueIds) {
          state.playQueue = data.playQueue;
          if (state.unshuffledQueue) state.unshuffledQueue = [...data.playQueue];
          if (typeof renderQueueUI === 'function') renderQueueUI();
        }
      }

      // 2. Track Change Sync
      const remoteSong = data.currentSong;
      const localSong = (typeof state !== 'undefined') ? state.currentSong : null;
      const isDifferentSong = remoteSong && (!localSong || localSong.id !== remoteSong.id);

      if (isDifferentSong || (isInitial && remoteSong)) {
        console.log('[AetherJam] Remote track change to:', remoteSong.title, 'at', expectedSeconds);
        this.currentSong = remoteSong;
        if (typeof playSong === 'function') {
          const qIndex = (typeof data.currentQueueIndex === 'number') ? data.currentQueueIndex : 0;
          playSong(remoteSong, qIndex);

          // Fast forward to anchor timestamp after stream initializes
          setTimeout(() => {
            this.forceSeekTo(expectedSeconds);
            if (!isRemotePlaying) {
              this.forcePause();
            }
          }, 350);
        }
        this._showSyncToast(`Now playing: ${remoteSong.title}`);
        return;
      }

      // 3. Play / Pause State Sync
      if (typeof state !== 'undefined' && localSong) {
        if (isRemotePlaying && !state.isPlaying) {
          console.log('[AetherJam] Remote resumed playback at', expectedSeconds);
          this.forceSeekTo(expectedSeconds);
          this.forcePlay();
          this._showSyncToast('Playback resumed');
        } else if (!isRemotePlaying && state.isPlaying) {
          console.log('[AetherJam] Remote paused playback at', expectedSeconds);
          this.forceSeekTo(expectedSeconds);
          this.forcePause();
          this._showSyncToast('Playback paused');
        } else if (isRemotePlaying && state.isPlaying) {
          // Both playing: check for clock drift
          const currentLocalSec = state.playbackPosition || 0;
          const drift = Math.abs(currentLocalSec - expectedSeconds);
          if (drift > 0.45) {
            console.log(`[AetherJam] Correcting drift (${drift.toFixed(2)}s) -> seeking to ${expectedSeconds.toFixed(2)}s`);
            this.forceSeekTo(expectedSeconds);
          }
        }
      }
    } catch (err) {
      console.warn('[AetherJam] Error applying remote update:', err);
    } finally {
      // Cooldown before unlocking local actions
      setTimeout(() => {
        this._isApplyingRemote = false;
      }, 400);
    }
  },

  // --- LOCAL FORCED PLAYBACK HELPERS ---

  forceSeekTo(seconds) {
    if (typeof state === 'undefined' || !state.duration) return;
    const boundedSec = Math.max(0, Math.min(state.duration, seconds));
    const pct = boundedSec / state.duration;

    if (typeof seekToPercentage === 'function') {
      seekToPercentage(pct);
    }
  },

  forcePlay() {
    if (typeof state === 'undefined') return;
    state.isPlaying = true;
    state.isUserPaused = false;

    if (window.AetherAudioEngine && AetherAudioEngine.ctx && AetherAudioEngine.ctx.state === 'suspended') {
      AetherAudioEngine.ctx.resume().catch(() => {});
    }

    if (typeof activeAudio !== 'undefined' && activeAudio) {
      activeAudio.play().catch(() => {});
    } else if (typeof ytPlayer !== 'undefined' && ytPlayer && typeof ytPlayer.playVideo === 'function') {
      try { ytPlayer.playVideo(); } catch (e) {}
    }

    if (typeof updatePlayButtonUI === 'function') {
      updatePlayButtonUI(true);
    }
  },

  forcePause() {
    if (typeof state === 'undefined') return;
    state.isPlaying = false;
    state.isUserPaused = true;

    if (typeof activeAudio !== 'undefined' && activeAudio) {
      try { activeAudio.pause(); } catch (e) {}
    }
    if (typeof ytPlayer !== 'undefined' && ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
      try { ytPlayer.pauseVideo(); } catch (e) {}
    }

    if (typeof updatePlayButtonUI === 'function') {
      updatePlayButtonUI(false);
    }
  },

  // --- OUTBOUND BROADCAST (ANCHOR TIMESTAMP SENDER) ---

  canControl() {
    if (!this.isActive) return false;
    if (this.isHost) return true;
    return (this.controlMode === 'everyone');
  },

  async broadcastPlay(song, queueIndex, position) {
    if (!this.isActive || !this.canControl() || this._isApplyingRemote) return;
    const now = Date.now();
    this._lastBroadcastTime = now;

    try {
      const docRef = fbDb.collection('jam_sessions').doc(this.jamCode);
      await docRef.update({
        currentSong: song,
        currentQueueIndex: queueIndex || 0,
        isPlaying: true,
        trackOffset: position || 0,
        serverTimestamp: now,
        lastUpdated: now,
        lastUpdatedBy: this._myParticipantId
      });
      console.log('[AetherJam] Broadcast PLAY event:', song.title, 'at', position);
    } catch (err) {
      console.warn('[AetherJam] Broadcast play failed:', err);
    }
  },

  async broadcastPause(position) {
    if (!this.isActive || !this.canControl() || this._isApplyingRemote) return;
    const now = Date.now();
    this._lastBroadcastTime = now;

    try {
      const docRef = fbDb.collection('jam_sessions').doc(this.jamCode);
      await docRef.update({
        isPlaying: false,
        trackOffset: position || 0,
        serverTimestamp: now,
        lastUpdated: now,
        lastUpdatedBy: this._myParticipantId
      });
      console.log('[AetherJam] Broadcast PAUSE event at', position);
    } catch (err) {
      console.warn('[AetherJam] Broadcast pause failed:', err);
    }
  },

  async broadcastSeek(position) {
    if (!this.isActive || !this.canControl() || this._isApplyingRemote) return;
    const now = Date.now();
    this._lastBroadcastTime = now;

    try {
      const docRef = fbDb.collection('jam_sessions').doc(this.jamCode);
      await docRef.update({
        trackOffset: position || 0,
        serverTimestamp: now,
        lastUpdated: now,
        lastUpdatedBy: this._myParticipantId
      });
      console.log('[AetherJam] Broadcast SEEK event to', position);
    } catch (err) {
      console.warn('[AetherJam] Broadcast seek failed:', err);
    }
  },

  async broadcastQueue(queue) {
    if (!this.isActive || !this.canControl() || this._isApplyingRemote) return;
    const now = Date.now();

    try {
      const docRef = fbDb.collection('jam_sessions').doc(this.jamCode);
      await docRef.update({
        playQueue: queue || [],
        lastUpdated: now,
        lastUpdatedBy: this._myParticipantId
      });
      console.log('[AetherJam] Broadcast QUEUE update');
    } catch (err) {
      console.warn('[AetherJam] Broadcast queue failed:', err);
    }
  },

  async setControlMode(mode) {
    if (!this.isActive || !this.isHost) return;
    this.controlMode = mode;
    try {
      const docRef = fbDb.collection('jam_sessions').doc(this.jamCode);
      await docRef.update({
        controlMode: mode,
        lastUpdated: Date.now()
      });
      showToast(mode === 'everyone' ? 'All guests can now control playback' : 'Only host can control playback');
    } catch (err) {
      console.warn('[AetherJam] Could not update control mode:', err);
    }
  },

  // --- BACKGROUND DRIFT CHECKER ---

  startDriftCorrection() {
    this.stopDriftCorrection();
    // Steady, gentle 4-second drift alignment check (0 network calls, purely local calculation)
    this._driftCheckTimer = setInterval(() => {
      if (!this.isActive || this._isApplyingRemote) return;
      if (typeof state === 'undefined' || !state.isPlaying || !this.isPlaying) return;

      const now = Date.now();
      const elapsed = Math.max(0, (now - this.serverTimestamp) / 1000);
      const expected = this.trackOffset + elapsed;
      const current = state.playbackPosition || 0;
      const drift = Math.abs(current - expected);

      // If drift is significant (>0.55s), smoothly realign
      if (drift > 0.55 && state.duration && expected < state.duration - 2) {
        console.log(`[AetherJam Drift Check] Aligning playhead drift: ${drift.toFixed(2)}s`);
        this.forceSeekTo(expected);
      }
    }, 4000);
  },

  stopDriftCorrection() {
    if (this._driftCheckTimer) {
      clearInterval(this._driftCheckTimer);
      this._driftCheckTimer = null;
    }
  },

  // --- HEARTBEAT & PARTICIPANT REFRESH ---

  startHeartbeat(code) {
    this.stopHeartbeat();
    // Update participant ping every 45s so stale sessions are easily identified
    this._heartbeatTimer = setInterval(async () => {
      if (!this.isActive || !this.jamCode) return;
      try {
        const docRef = fbDb.collection('jam_sessions').doc(code);
        const snapshot = await docRef.get();
        if (snapshot.exists) {
          const data = snapshot.data();
          const participants = Array.isArray(data.participants) ? [...data.participants] : [];
          const idx = participants.findIndex(p => p.id === this._myParticipantId);
          if (idx !== -1) {
            participants[idx].lastPing = Date.now();
            await docRef.update({ participants: participants });
          }
        }
      } catch (e) {}
    }, 45000);
  },

  stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  },

  // --- URL INVITE CHECK (?jam=JAM-XXXX) ---

  checkUrlForJamInvite() {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const jamParam = urlParams.get('jam') || (window.location.hash.includes('jam=') ? window.location.hash.split('jam=')[1] : null);
      if (jamParam) {
        const cleanCode = jamParam.trim().toUpperCase();
        console.log('[AetherJam] Found Jam invite in URL:', cleanCode);
        setTimeout(() => {
          this.joinJam(cleanCode);
        }, 1200);
      }
    } catch (e) {
      console.warn('[AetherJam] URL invite parse error:', e);
    }
  },

  getInviteLink() {
    const origin = window.location.origin + window.location.pathname;
    return `${origin}?jam=${this.jamCode}`;
  },

  _showSyncToast(msg) {
    const now = Date.now();
    if (msg === this._lastToastMessage && (now - this._lastToastTime < 5000)) return;
    this._lastToastMessage = msg;
    this._lastToastTime = now;
    if (typeof showToast === 'function') {
      showToast(msg);
    }
  },

  // --- UI INTEGRATION & MODAL RENDERING ---

  updatePillUI() {
    const headerBtn = document.getElementById('btnHeaderJam');
    const headerTxt = document.getElementById('txtHeaderJam');
    const playerIndicator = document.getElementById('playerJamIndicator');

    if (!headerBtn) return;

    if (this.isActive) {
      headerBtn.classList.add('is-active-jam');
      const count = this.participants.length || 1;
      if (headerTxt) {
        headerTxt.textContent = `Jam (${count})`;
      }
      if (playerIndicator) {
        playerIndicator.style.display = 'inline-flex';
        playerIndicator.textContent = `Jam • ${count} in sync`;
      }
    } else {
      headerBtn.classList.remove('is-active-jam');
      if (headerTxt) {
        headerTxt.textContent = 'Jam';
      }
      if (playerIndicator) {
        playerIndicator.style.display = 'none';
      }
    }
  },

  renderJamModal() {
    const modal = document.getElementById('modalJamSession');
    if (!modal) return;

    const idleView = document.getElementById('jamViewIdle');
    const activeView = document.getElementById('jamViewActive');

    if (this.isActive) {
      if (idleView) idleView.style.display = 'none';
      if (activeView) activeView.style.display = 'block';

      // Render Active Room Code & QR
      const codeDisplay = document.getElementById('jamActiveCodeDisplay');
      if (codeDisplay) codeDisplay.textContent = this.jamCode;

      const qrContainer = document.getElementById('jamQrContainer');
      if (qrContainer) {
        qrContainer.innerHTML = '';
        const inviteUrl = this.getInviteLink();
        if (typeof QRCode !== 'undefined') {
          try {
            new QRCode(qrContainer, {
              text: inviteUrl,
              width: 180,
              height: 180,
              colorDark: '#0d0b18',
              colorLight: '#ffffff',
              correctLevel: QRCode.CorrectLevel.M
            });
          } catch (e) {
            this._renderQrFallback(qrContainer, inviteUrl);
          }
        } else {
          this._renderQrFallback(qrContainer, inviteUrl);
        }
      }

      // Host controls switch
      const toggleHostOnly = document.getElementById('toggleJamHostOnly');
      if (toggleHostOnly) {
        toggleHostOnly.checked = (this.controlMode === 'host_only');
        toggleHostOnly.disabled = !this.isHost;
      }

      this.updateParticipantsUI();
    } else {
      if (idleView) idleView.style.display = 'block';
      if (activeView) activeView.style.display = 'none';
    }
  },

  _renderQrFallback(container, text) {
    const img = document.createElement('img');
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(text)}`;
    img.alt = 'QR Code';
    img.style.width = '180px';
    img.style.height = '180px';
    img.style.borderRadius = '8px';
    container.appendChild(img);
  },

  updateParticipantsUI() {
    const listEl = document.getElementById('jamParticipantsList');
    if (!listEl) return;

    listEl.innerHTML = '';
    const participants = this.participants.length > 0 ? this.participants : [
      { id: this._myParticipantId, name: 'You', isHost: this.isHost }
    ];

    participants.forEach(p => {
      const isMe = (p.id === this._myParticipantId);
      const row = document.createElement('div');
      row.className = 'jam-participant-row';
      
      const avatarSrc = p.avatar || DEFAULT_AVATAR;
      row.innerHTML = `
        <div class="jam-participant-avatar-wrap">
          <img src="${avatarSrc}" class="jam-participant-avatar" alt="" onerror="this.src=DEFAULT_AVATAR;">
          <span class="jam-live-pulse-ring"></span>
        </div>
        <div class="jam-participant-info">
          <div class="jam-participant-name">
            ${escapeHtml(p.name || 'Friend')}
            ${isMe ? '<span class="jam-tag tag-you">You</span>' : ''}
            ${p.isHost ? '<span class="jam-tag tag-host">Host</span>' : ''}
          </div>
          <div class="jam-participant-status">Listening along • Synced</div>
        </div>
        <div class="jam-equalizer-bars">
          <span class="bar bar-1"></span>
          <span class="bar bar-2"></span>
          <span class="bar bar-3"></span>
        </div>
      `;
      listEl.appendChild(row);
    });

    const badge = document.getElementById('jamListenerCountBadge');
    if (badge) {
      badge.textContent = `${participants.length} ${participants.length === 1 ? 'Listener' : 'Listeners'}`;
    }
  },

  openModal() {
    const modal = document.getElementById('modalJamSession');
    if (modal) {
      this.renderJamModal();
      modal.style.display = 'flex';
      modal.classList.add('active');
    }
  },

  closeModal() {
    const modal = document.getElementById('modalJamSession');
    if (modal) {
      modal.classList.remove('active');
      modal.style.display = 'none';
    }
  },

  setupUIEventListeners() {
    // Header Jam Pill click -> open Jam modal
    const btnHeaderJam = document.getElementById('btnHeaderJam');
    if (btnHeaderJam) {
      btnHeaderJam.addEventListener('click', () => {
        this.openModal();
      });
    }

    // Modal Close button
    const btnClose = document.getElementById('btnCloseJamModal');
    if (btnClose) {
      btnClose.addEventListener('click', () => this.closeModal());
    }

    const modal = document.getElementById('modalJamSession');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) this.closeModal();
      });
    }

    // Start Jam Button (in Idle view)
    const btnStart = document.getElementById('btnStartJamSession');
    if (btnStart) {
      btnStart.addEventListener('click', () => {
        this.createJam();
      });
    }

    // Join Jam Button (in Idle view)
    const btnJoin = document.getElementById('btnJoinJamSession');
    const inputCode = document.getElementById('inputJamCode');
    if (btnJoin && inputCode) {
      const doJoin = () => {
        const val = inputCode.value.trim();
        if (!val) {
          showToast('Please enter a room code');
          inputCode.focus();
          return;
        }
        this.joinJam(val);
      };
      btnJoin.addEventListener('click', doJoin);
      inputCode.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doJoin();
      });
    }

    // Copy Room Code Button
    const btnCopyCode = document.getElementById('btnCopyJamCode');
    if (btnCopyCode) {
      btnCopyCode.addEventListener('click', () => {
        if (!this.jamCode) return;
        navigator.clipboard.writeText(this.jamCode).then(() => {
          showToast(`Room code ${this.jamCode} copied!`);
        }).catch(() => {
          showToast(`Room code: ${this.jamCode}`);
        });
      });
    }

    // Copy Invite Link Button
    const btnCopyLink = document.getElementById('btnCopyJamLink');
    if (btnCopyLink) {
      btnCopyLink.addEventListener('click', () => {
        if (!this.jamCode) return;
        const link = this.getInviteLink();
        navigator.clipboard.writeText(link).then(() => {
          showToast('Jam invite link copied to clipboard!');
        }).catch(() => {
          showToast(`Invite link: ${link}`);
        });
      });
    }

    // Leave Jam Button
    const btnLeave = document.getElementById('btnLeaveJamSession');
    if (btnLeave) {
      btnLeave.addEventListener('click', async () => {
        const confirmed = await showConfirmModal(
          this.isHost ? 'End Jam Session?' : 'Leave Jam Session?',
          this.isHost ? 'Ending the Jam will disconnect all listening friends.' : 'You will disconnect from the shared playback room.'
        );
        if (confirmed) {
          if (this.isHost) {
            await this.endJam();
          } else {
            await this.leaveJam();
          }
          this.closeModal();
        }
      });
    }

    // Host Only toggle checkbox
    const toggleHostOnly = document.getElementById('toggleJamHostOnly');
    if (toggleHostOnly) {
      toggleHostOnly.addEventListener('change', (e) => {
        const isHostOnly = e.target.checked;
        this.setControlMode(isHostOnly ? 'host_only' : 'everyone');
      });
    }

    // Scan Jam QR Code button (opens existing camera scanner modal with Jam callback)
    const btnScanJamQr = document.getElementById('btnScanJamQr');
    if (btnScanJamQr) {
      btnScanJamQr.addEventListener('click', () => {
        this.closeModal();
        if (typeof CloudSync !== 'undefined' && typeof CloudSync.startQrScanner === 'function') {
          // Temporarily attach custom scanner hook
          window._jamQrScanHook = (scannedText) => {
            console.log('[AetherJam] Scanned QR text:', scannedText);
            let codeToJoin = scannedText;
            if (scannedText.includes('jam=')) {
              codeToJoin = scannedText.split('jam=')[1].split('&')[0];
            }
            window._jamQrScanHook = null;
            if (typeof CloudSync.stopQrScanner === 'function') CloudSync.stopQrScanner();
            this.joinJam(codeToJoin);
          };
          CloudSync.startQrScanner();
        } else {
          showToast('Camera scanner unavailable');
        }
      });
    }
  }
};

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => AetherJam.init());
} else {
  AetherJam.init();
}
window.AetherJam = AetherJam;

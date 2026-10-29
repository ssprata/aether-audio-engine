/**
 * AetherJam - Modular Collaborative Jam Session Engine (v2.5.0)
 * 
 * Features:
 * - Real-time synchronized music listening with friends
 * - Pre-roll Readiness Handshake (ensures both players buffer before playing)
 * - Universal Play / Pause synchronization across all participants
 * - Multi-user track selection & shared queue
 * - Autoplay blocker detection with 1-tap sync banner
 * - Event-driven modular architecture using window.AetherPlayer
 * - Powered by Firebase Firestore realtime listeners (onSnapshot)
 */

window.AetherJam = {
  isActive: false,
  isHost: false,
  jamCode: null,
  controlMode: 'everyone', // 'everyone' | 'host_only'
  participants: [],
  currentSong: null,
  isPlaying: false,
  trackOffset: 0,
  serverTimestamp: 0,

  // Internal control flags & timers
  _unsubscribe: null,
  _isApplyingRemote: false,
  _heartbeatTimer: null,
  _driftCheckTimer: null,
  _handshakeTimer: null,
  _startScheduleTimer: null,
  _lastBroadcastTime: 0,
  _lastAppliedTimestamp: 0,
  _lastToastMessage: '',
  _lastToastTime: 0,
  _myParticipantId: null,
  _isAudioReadyForCurrentTrack: false,
  _roomStatus: 'idle', // 'idle' | 'buffering' | 'playing' | 'paused'
  _isBufferingHandshake: false,
  _myAudioReady: false,
  _clockOffset: 0,
  _isNaturalTrackEnd: false,
  _lastUserClickTime: 0,
  _playbackStartTime: 0,

  // --- INITIALIZATION ---

  init() {
    this._myParticipantId = this.getParticipantId();
    this.setupPlayerEventListeners();
    this.setupAudioEngineHooks();
    this.setupUIEventListeners();
    this.checkUrlForJamInvite();
    this.updatePillUI();
    console.log('[AetherJam] Modular engine initialized. Device ID:', this._myParticipantId);
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

  canControl() {
    if (!this.isActive) return false;
    if (this.isHost) return true;
    return (this.controlMode === 'everyone');
  },

  // --- CLOCK OFFSET CALIBRATION (SYSTEM CLOCK DRIFT NEUTRALIZATION) ---

  updateClockOffset(hostTimestamp) {
    if (!hostTimestamp || this.isHost) {
      this._clockOffset = 0;
      return;
    }
    const now = Date.now();
    const rawDiff = now - hostTimestamp;
    // If the difference is under 1200ms, clocks are local or well-synchronized: no artificial offset needed
    if (Math.abs(rawDiff) < 1200) {
      this._clockOffset = 0;
      return;
    }
    // Only compensate if there is a genuine multi-second system clock skew
    if (this._clockOffset === null || this._clockOffset === undefined || this._clockOffset === 0) {
      this._clockOffset = rawDiff;
    } else {
      this._clockOffset = Math.round(this._clockOffset * 0.8 + rawDiff * 0.2);
    }
  },

  toLocalTime(hostTimestamp) {
    if (!hostTimestamp) return Date.now();
    if (this.isHost) return hostTimestamp;
    return hostTimestamp + (this._clockOffset || 0);
  },

  // --- AUDIO ENGINE HOOKS (PRE-ROLL HOLD AT 0:00 & NATURAL END DETECTION) ---

  setupAudioEngineHooks() {
    const hook = () => {
      const audio = window.AetherAudioEngine && window.AetherAudioEngine.audioElement;
      if (audio && !audio._jamHooked) {
        audio._jamHooked = true;

        // Intercept play/playing event during buffering handshake
        const handlePlaying = () => {
          if (this.isActive && (this._roomStatus === 'buffering' || this._isBufferingHandshake)) {
            console.log('[AetherJam] Audio fired playing during buffering handshake: holding paused at 0:00');
            audio.pause();
            audio.currentTime = 0;
            if (typeof state !== 'undefined') {
              state.isPlaying = false;
              state.isUserPaused = true;
            }
            if (typeof updatePlayButtonUI === 'function') {
              updatePlayButtonUI(false);
            }
            this._myAudioReady = true;
          }
        };

        audio.addEventListener('playing', handlePlaying);

        // Track natural completion of track
        audio.addEventListener('ended', () => {
          if (this.isActive) {
            console.log('[AetherJam] Audio element ended naturally');
            this._isNaturalTrackEnd = true;
            setTimeout(() => {
              this._isNaturalTrackEnd = false;
            }, 3000);
          }
        });
      }
    };

    hook();
    setInterval(hook, 2000);
  },

  // --- SANITIZE FOR FIRESTORE (NO UNDEFINED VALUES) ---

  sanitizeTrack(song) {
    if (!song || typeof song !== 'object') return null;
    return {
      id: String(song.id || ''),
      title: String(song.title || 'Unknown Track'),
      artist: String(song.artist || 'Unknown Artist'),
      album: String(song.album || song.albumName || ''),
      thumbnail: String(song.thumbnail || ''),
      duration: String(song.duration || '3:00'),
      platform: String(song.platform || 'youtube'),
      url: String(song.url || ''),
      previewUrl: song.previewUrl ? String(song.previewUrl) : null,
      _preResolvedYtId: song._preResolvedYtId ? String(song._preResolvedYtId) : null
    };
  },

  // --- EVENT-DRIVEN HOOKS (LISTENS TO AETHER CUSTOM EVENTS) ---

  setupPlayerEventListeners() {
    // 1. Playback State Change (Play / Pause from click, spacebar, taskbar, SMTC, etc.)
    window.addEventListener('aether:playbackstate', (e) => {
      if (!this.isActive || this._isApplyingRemote || this._roomStatus === 'buffering' || this._isBufferingHandshake) return;
      if (!this.canControl()) {
        // Listening-only mode: revert local player state and inform guest
        const incomingPlaying = !!(e.detail && e.detail.isPlaying);
        if (this.isPlaying !== incomingPlaying) {
          if (this.isPlaying) {
            this.executePlaybackResume();
          } else {
            this.executePlaybackPause();
          }
          if (typeof showToast === 'function') {
            showToast('Controls locked: Only the Host can change playback');
          }
        }
        return;
      }
      const { isPlaying, position } = e.detail || {};
      const pos = typeof position === 'number' ? position : (typeof state !== 'undefined' ? state.playbackPosition || 0 : 0);

      if (isPlaying) {
        this.broadcastPlay(this.currentSong || (typeof state !== 'undefined' ? state.currentSong : null), pos);
      } else {
        this.broadcastPause(pos);
      }
    });

    // 2. Track Change (Song clicked in playlist, search, queue, etc. or natural track end)
    window.addEventListener('aether:trackchange', async (e) => {
      if (!this.isActive || this._isApplyingRemote) return;
      if (!this.canControl()) {
        // Listening-only mode: guest cannot change tracks
        const changedSong = e.detail && e.detail.song;
        if (this.currentSong && changedSong && changedSong.id !== this.currentSong.id) {
          if (typeof showToast === 'function') {
            showToast('Controls locked: Only the Host can change music');
          }
          this._isApplyingRemote = true;
          if (window.AetherPlayer && typeof window.AetherPlayer.playTrack === 'function') {
            window.AetherPlayer.playTrack(this.currentSong, 0, this.trackOffset || 0);
          }
          setTimeout(() => { this._isApplyingRemote = false; }, 800);
        }
        return;
      }

      const isNatural = this._isNaturalTrackEnd || (e.detail && e.detail.isNaturalEnd);
      this._isNaturalTrackEnd = false;

      // Natural End: If guest audio ends, Guest must NOT advance the room. Wait for Host!
      if (!this.isHost && isNatural) {
        console.log('[AetherJam] Guest natural track end detected: waiting for Host to advance queue...');
        this.executePlaybackPause();
        return;
      }

      // Natural End: If Host audio ends, provide a 600ms grace period for listeners before broadcasting next song
      if (this.isHost && isNatural) {
        console.log('[AetherJam] Host natural track end detected: waiting 600ms grace for listeners...');
        await new Promise(r => setTimeout(r, 600));
      }

      const { song, index } = e.detail || {};
      if (song) {
        this.broadcastTrackChange(song, index || 0);
      }
    });

    // 3. User Seek (Timeline scrubber drag/click)
    window.addEventListener('aether:seek', (e) => {
      if (!this.isActive || this._isApplyingRemote || this._roomStatus === 'buffering' || this._isBufferingHandshake) return;
      if (!this.canControl()) {
        // Revert seek if guest has no control
        if (typeof state !== 'undefined' && state.duration) {
          this.executeSeek(this.trackOffset || 0);
        }
        return;
      }
      const { position } = e.detail || {};
      if (typeof position === 'number') {
        this.broadcastSeek(position);
      }
    });

    // 4. Track Ready (Audio engine loaded metadata / buffered)
    window.addEventListener('aether:trackready', (e) => {
      if (!this.isActive) return;
      this.onTrackReady(e.detail || {});
    });
  },

  // --- READINESS HANDSHAKE (PRE-ROLL SYNC) ---

  async onTrackReady(detail) {
    this._myAudioReady = true;
    this._isAudioReadyForCurrentTrack = true;
    if (!this.isActive || !this.jamCode) return;

    console.log('[AetherJam] Local player buffered and ready for track. Status:', this._roomStatus);

    // If currently in buffering handshake, keep audio held at 0:00
    if (this._roomStatus === 'buffering' || this._isBufferingHandshake) {
      this.executePlaybackPause();
      this.executeSeek(0);
    }

    // Update readiness in Firestore participants list
    try {
      if (typeof fbDb === 'undefined' || !fbDb) return;
      const docRef = fbDb.collection('jam_sessions').doc(this.jamCode);
      const snapshot = await docRef.get();
      if (!snapshot.exists) return;

      const data = snapshot.data();
      const participants = Array.isArray(data.participants) ? [...data.participants] : [];
      let allReady = true;

      participants.forEach(p => {
        if (p.id === this._myParticipantId) {
          p.ready = true;
        }
        if (!p.ready) {
          allReady = false;
        }
      });

      const updatePayload = {
        participants: participants,
        lastUpdated: Date.now(),
        lastUpdatedBy: this._myParticipantId
      };

      if (typeof state !== 'undefined' && state.currentSong && state.currentSong._preResolvedYtId) {
        if (this.currentSong) this.currentSong._preResolvedYtId = state.currentSong._preResolvedYtId;
        updatePayload.currentSong = this.sanitizeTrack(state.currentSong);
      }

      // Host checks if all participants are ready to start playing together ONLY if room is actively buffering
      if (this.isHost && data.status === 'buffering' && (allReady || participants.length <= 1)) {
        console.log('[AetherJam] All participants ready! Triggering synchronized playback');
        const startAnchor = Date.now() + 350;
        updatePayload.status = 'playing';
        updatePayload.isPlaying = true;
        updatePayload.trackOffset = 0;
        updatePayload.serverTimestamp = startAnchor;
        updatePayload.scheduledStartTime = startAnchor;
        updatePayload.lastAction = 'play';
        await docRef.update(updatePayload);
        this.schedulePlaybackStart(startAnchor);
      } else {
        await docRef.update(updatePayload);
      }
    } catch (err) {
      console.warn('[AetherJam] Error updating readiness:', err);
    }
  },

  schedulePlaybackStart(scheduledTime) {
    this._roomStatus = 'playing';
    this._isBufferingHandshake = false;
    this._playbackStartTime = scheduledTime || Date.now();
    clearTimeout(this._startScheduleTimer);

    const audio = window.AetherAudioEngine && window.AetherAudioEngine.audioElement;
    if (audio && audio.playbackRate !== 1.0) {
      audio.playbackRate = 1.0;
    }

    const delay = Math.max(0, scheduledTime - Date.now());
    console.log(`[AetherJam] Scheduling synchronized playback start in ${delay}ms`);
    this._startScheduleTimer = setTimeout(() => {
      if (this.isActive) {
        this.executePlaybackResume();
      }
    }, delay);
  },

  // --- ROOM CODE GENERATOR ---

  generateRoomCode() {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = 'JAM-';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  },

  // --- CREATE JAM SESSION (HOST) ---

  async createJam() {
    if (typeof fbDb === 'undefined' || !fbDb) {
      if (typeof showToast === 'function') showToast('Firebase connection is offline');
      return;
    }

    const { username, avatar } = this.getUserInfo();
    const code = this.generateRoomCode();
    this.jamCode = code;
    this.isHost = true;
    this.controlMode = 'everyone';
    this.isActive = true;

    const currentTrack = (typeof state !== 'undefined' && state.currentSong) ? this.sanitizeTrack(state.currentSong) : null;
    const rawQueue = (typeof state !== 'undefined' && Array.isArray(state.playQueue)) ? state.playQueue : [];
    const sanitizedQueue = rawQueue.slice(0, 50).map(t => this.sanitizeTrack(t)).filter(Boolean);
    const queueIdx = (typeof state !== 'undefined' && typeof state.currentQueueIndex === 'number') ? state.currentQueueIndex : 0;
    const isPlaying = (typeof state !== 'undefined' && state.isPlaying);
    const playbackPos = (typeof state !== 'undefined' && state.playbackPosition) ? state.playbackPosition : 0;

    const myParticipant = {
      id: this._myParticipantId,
      name: username,
      avatar: avatar,
      isHost: true,
      ready: true,
      lastPing: Date.now()
    };

    const sessionData = {
      code: code,
      hostId: this._myParticipantId,
      hostName: username,
      hostAvatar: avatar,
      status: isPlaying ? 'playing' : 'paused',
      controlMode: 'everyone',
      currentSong: currentTrack,
      currentQueueIndex: queueIdx,
      playQueue: sanitizedQueue,
      isPlaying: !!isPlaying,
      trackOffset: playbackPos,
      serverTimestamp: Date.now(),
      scheduledStartTime: null,
      lastAction: 'create',
      lastUpdated: Date.now(),
      lastUpdatedBy: this._myParticipantId,
      participants: [myParticipant]
    };

    try {
      if (typeof showToast === 'function') showToast('Creating Jam Session...');
      await fbDb.collection('jam_sessions').doc(code).set(sessionData);

      this.participants = [myParticipant];
      this.currentSong = currentTrack;
      this.isPlaying = !!isPlaying;

      this.startRealtimeListener(code);
      this.startHeartbeat(code);
      this.updatePillUI();
      this.renderJamModal();

      if (typeof showToast === 'function') showToast(`Jam Session ${code} active!`);
    } catch (err) {
      console.error('[AetherJam] Error creating jam:', err);
      this.isActive = false;
      this.isHost = false;
      this.jamCode = null;
      if (typeof showToast === 'function') showToast('Failed to create Jam: ' + (err.message || 'Check connection'));
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
      if (typeof showToast === 'function') showToast('Firebase connection is offline');
      return;
    }

    try {
      if (typeof showToast === 'function') showToast('Connecting to Jam...');
      const docRef = fbDb.collection('jam_sessions').doc(code);
      const snapshot = await docRef.get();

      if (!snapshot.exists) {
        if (typeof showToast === 'function') showToast(`Jam room "${code}" not found.`);
        return;
      }

      const data = snapshot.data();
      if (data.status === 'ended') {
        if (typeof showToast === 'function') showToast('This Jam session has ended.');
        return;
      }

      const { username, avatar } = this.getUserInfo();
      this.jamCode = code;
      this.isHost = (data.hostId === this._myParticipantId);
      this.controlMode = data.controlMode || 'everyone';
      this.isActive = true;
      this._isApplyingRemote = true;

      // Stop and clear any local playback and queue from before joining
      if (window.AetherPlayer && typeof window.AetherPlayer.stop === 'function') {
        window.AetherPlayer.stop();
      }
      if (window.AetherPlayer && typeof window.AetherPlayer.setQueue === 'function') {
        window.AetherPlayer.setQueue(data.playQueue || []);
      }

      const participants = Array.isArray(data.participants) ? [...data.participants] : [];
      const existingIdx = participants.findIndex(p => p.id === this._myParticipantId);
      const myParticipantObj = {
        id: this._myParticipantId,
        name: username,
        avatar: avatar,
        isHost: this.isHost,
        ready: false,
        lastPing: Date.now()
      };

      if (existingIdx !== -1) {
        participants[existingIdx] = myParticipantObj;
      } else {
        participants.push(myParticipantObj);
      }

      await docRef.update({
        participants: participants,
        lastUpdated: Date.now(),
        lastUpdatedBy: this._myParticipantId
      });

      this.participants = participants;
      this.startRealtimeListener(code);
      this.startHeartbeat(code);
      if (!this.isHost) {
        this.startDriftCorrection();
      }
      this.updatePillUI();
      this.renderJamModal();

      // Synchronize immediately from initial room snapshot
      this.applyRemoteUpdate(data, true);

      if (typeof showToast === 'function') showToast(`Joined Jam ${code}! Listening with ${data.hostName || 'friends'}`);
    } catch (err) {
      console.error('[AetherJam] Error joining jam:', err);
      if (typeof showToast === 'function') showToast('Could not join Jam: ' + (err.message || 'Check connection'));
    }
  },

  // --- LEAVE / END JAM SESSION ---

  async leaveJam() {
    if (!this.isActive || !this.jamCode) return;
    const code = this.jamCode;

    this.stopRealtimeListener();
    this.stopHeartbeat();
    this.stopDriftCorrection();
    this.hideAutoplayBanner();
    clearTimeout(this._handshakeTimer);
    clearTimeout(this._startScheduleTimer);
    this._roomStatus = 'idle';
    this._isBufferingHandshake = false;
    this._clockOffset = 0;
    const audio = window.AetherAudioEngine && window.AetherAudioEngine.audioElement;
    if (audio && audio.playbackRate !== 1.0) audio.playbackRate = 1.0;

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
            lastUpdated: Date.now(),
            lastUpdatedBy: this._myParticipantId
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
    if (typeof showToast === 'function') showToast('Left Jam session');
  },

  async endJam() {
    if (!this.jamCode) return;
    const code = this.jamCode;

    try {
      if (typeof fbDb !== 'undefined' && fbDb) {
        await fbDb.collection('jam_sessions').doc(code).update({
          status: 'ended',
          isPlaying: false,
          lastUpdated: Date.now(),
          lastUpdatedBy: this._myParticipantId,
          lastAction: 'end'
        });
      }
    } catch (err) {
      console.warn('[AetherJam] Error ending room:', err);
    }

    this.stopRealtimeListener();
    this.stopHeartbeat();
    this.stopDriftCorrection();
    this.hideAutoplayBanner();
    clearTimeout(this._handshakeTimer);
    clearTimeout(this._startScheduleTimer);
    this._roomStatus = 'idle';
    this._isBufferingHandshake = false;
    this._clockOffset = 0;
    if (audio && audio.playbackRate !== 1.0) audio.playbackRate = 1.0;
    this.isActive = false;
    this.isHost = false;
    this.jamCode = null;
    this.participants = [];
    this.updatePillUI();
    this.renderJamModal();
    if (typeof showToast === 'function') showToast('Jam session ended');
  },

  // --- REALTIME FIRESTORE LISTENER ---

  startRealtimeListener(code) {
    this.stopRealtimeListener();
    if (typeof fbDb === 'undefined' || !fbDb) return;

    const docRef = fbDb.collection('jam_sessions').doc(code);
    this._unsubscribe = docRef.onSnapshot((doc) => {
      if (!doc.exists) {
        if (typeof showToast === 'function') showToast('Jam session was closed');
        this.leaveJam();
        return;
      }

      const data = doc.data();
      if (!data) return;

      if (data.status === 'ended') {
        if (typeof showToast === 'function') showToast('Jam session ended by the host');
        this.leaveJam();
        return;
      }

      if (Array.isArray(data.participants)) {
        this.participants = data.participants;
        this.updatePillUI();
        this.updateParticipantsUI();
      }

      if (data.controlMode) {
        this.controlMode = data.controlMode;
      }

      // If this device triggered this update, ignore to prevent feedback loops
      if (data.lastUpdatedBy === this._myParticipantId) {
        return;
      }

      const remoteSong = data.currentSong;
      const localSong = (typeof state !== 'undefined') ? state.currentSong : null;
      const isDifferentSong = remoteSong && (!localSong || localSong.id !== remoteSong.id);

      // Always apply remote update first so Host switches track when Guest picks a song!
      this.applyRemoteUpdate(data, false);

      // HOST HANDSHAKE ARBITER:
      // If room is buffering and Host sees all active participants are ready (and Host has loaded the track), transition to playing!
      if (this.isHost && data.status === 'buffering' && !isDifferentSong) {
        const parts = Array.isArray(data.participants) ? data.participants : [];
        const allReady = parts.length > 0 && parts.every(p => p.ready);
        if (allReady && this._myAudioReady) {
          console.log('[AetherJam] Host detected all participants ready! Triggering synchronized playback');
          const startAnchor = Date.now() + 350;
          docRef.update({
            status: 'playing',
            isPlaying: true,
            trackOffset: 0,
            serverTimestamp: startAnchor,
            scheduledStartTime: startAnchor,
            lastAction: 'play',
            lastUpdated: Date.now(),
            lastUpdatedBy: this._myParticipantId
          }).catch(() => {});
          this.schedulePlaybackStart(startAnchor);
        }
      }
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

  // --- APPLY REMOTE UPDATE ---

  applyRemoteUpdate(data, isInitial = false) {
    if (!data) return;
    this._isApplyingRemote = true;

    try {
      this.updateClockOffset(data.lastUpdated || data.serverTimestamp);

      const now = Date.now();
      const hostNow = now - (this._clockOffset || 0);
      const serverTime = data.serverTimestamp || hostNow;
      const baseOffset = (typeof data.trackOffset === 'number') ? data.trackOffset : 0;
      const isRemotePlaying = !!data.isPlaying;

      if (data.status === 'buffering') {
        this._roomStatus = 'buffering';
        this._isBufferingHandshake = true;
      } else if (data.status === 'playing') {
        this._roomStatus = 'playing';
        this._isBufferingHandshake = false;
      } else if (data.status === 'paused') {
        this._roomStatus = 'paused';
        this._isBufferingHandshake = false;
      }

      let expectedSeconds = baseOffset;
      if (isRemotePlaying && data.status === 'playing') {
        const elapsed = Math.max(0, (hostNow - serverTime) / 1000);
        expectedSeconds = baseOffset + elapsed;
      }

      this.isPlaying = isRemotePlaying && data.status === 'playing';
      this.trackOffset = baseOffset;
      this.serverTimestamp = serverTime;

      // 1. Synchronize Shared Queue
      if (Array.isArray(data.playQueue) && data.playQueue.length > 0) {
        if (window.AetherPlayer && typeof window.AetherPlayer.setQueue === 'function') {
          const currentQueue = (typeof state !== 'undefined' && Array.isArray(state.playQueue)) ? state.playQueue : [];
          const currentIds = currentQueue.map(s => s.id).join(',');
          const remoteIds = data.playQueue.map(s => s.id).join(',');
          if (currentIds !== remoteIds || isInitial) {
            console.log('[AetherJam] Synchronizing shared queue from host:', data.playQueue.length, 'tracks');
            window.AetherPlayer.setQueue(data.playQueue);
          }
        }
      }

      const remoteSong = data.currentSong;
      const localSong = (typeof state !== 'undefined') ? state.currentSong : null;
      const isDifferentSong = remoteSong && (!localSong || localSong.id !== remoteSong.id);

      // 2. Track Change Execution (Universal for Host & all Guests)
      if (isDifferentSong || (isInitial && remoteSong)) {
        console.log('[AetherJam] Remote track change to:', remoteSong.title, 'at', expectedSeconds, 'status:', data.status);
        this.currentSong = remoteSong;
        this._isAudioReadyForCurrentTrack = false;
        this._myAudioReady = false;

        const qIndex = (typeof data.currentQueueIndex === 'number') ? data.currentQueueIndex : 0;
        if (data.status === 'paused' || !isRemotePlaying) {
          // Host is paused: load track in paused state and do NOT start playing
          if (window.AetherPlayer && typeof window.AetherPlayer.loadPausedTrack === 'function') {
            window.AetherPlayer.loadPausedTrack(remoteSong, qIndex, expectedSeconds);
          } else if (window.AetherPlayer && typeof window.AetherPlayer.playTrack === 'function') {
            window.AetherPlayer.playTrack(remoteSong, qIndex, expectedSeconds);
            setTimeout(() => { this.executePlaybackPause(); }, 50);
          }
          this._showSyncToast(`Paused: ${remoteSong.title}`);
          return;
        }

        // Room is buffering or playing: load track to buffer
        if (data.status === 'buffering') {
          this._roomStatus = 'buffering';
          this._isBufferingHandshake = true;
        }

        if (window.AetherPlayer && typeof window.AetherPlayer.playTrack === 'function') {
          window.AetherPlayer.playTrack(remoteSong, qIndex, expectedSeconds);
        } else if (typeof playSong === 'function') {
          playSong(remoteSong, qIndex);
        }

        if (data.status === 'buffering') {
          this._showSyncToast(`Syncing: ${remoteSong.title}`);
        } else {
          this._showSyncToast(`Now playing: ${remoteSong.title}`);
        }

        // Check if browser blocked autoplay on this tab
        this.verifyAutoplay();
        return;
      }

      // 3. Play / Pause Synchronization
      const isLocalPlaying = typeof state !== 'undefined' ? !!state.isPlaying : false;

      // Check if scheduled start is pending
      if (data.status === 'playing' && data.scheduledStartTime) {
        const localScheduled = this.toLocalTime(data.scheduledStartTime);
        if (localScheduled > now) {
          this.schedulePlaybackStart(localScheduled);
          this._showSyncToast('Synced playback started');
          return;
        }
      }

      if (isRemotePlaying && !isLocalPlaying && data.status === 'playing') {
        console.log('[AetherJam] Remote resumed playback at', expectedSeconds);
        this.executeSeek(expectedSeconds);
        this.executePlaybackResume();
        this._playbackStartTime = Date.now();
        this._showSyncToast('Playback resumed');
      } else if (!isRemotePlaying && isLocalPlaying) {
        console.log('[AetherJam] Remote paused playback at', expectedSeconds);
        this.executeSeek(expectedSeconds);
        this.executePlaybackPause();
        const audio = window.AetherAudioEngine && window.AetherAudioEngine.audioElement;
        if (audio && audio.playbackRate !== 1.0) audio.playbackRate = 1.0;
        this._showSyncToast('Playback paused');
      } else if (isRemotePlaying && isLocalPlaying && !this.isHost && data.status === 'playing') {
        // Guest clock drift check: only hard-seek if severe desync (> 2.0s), otherwise drift timer micro-syncs smoothly
        const currentLocalSec = typeof state !== 'undefined' ? (state.playbackPosition || 0) : 0;
        const drift = Math.abs(currentLocalSec - expectedSeconds);
        if (drift > 2.0 && typeof state !== 'undefined' && state.duration && expectedSeconds < state.duration - 1) {
          console.log(`[AetherJam] Severe drift recovery (${drift.toFixed(2)}s) -> seeking to ${expectedSeconds.toFixed(2)}s`);
          this.executeSeek(expectedSeconds);
          this._playbackStartTime = Date.now();
        }
      }
    } catch (err) {
      console.warn('[AetherJam] Error applying remote update:', err);
    } finally {
      // Cooldown before unlocking outbound broadcasts
      setTimeout(() => {
        this._isApplyingRemote = false;
      }, 500);
    }
  },

  // --- OUTBOUND BROADCAST METHODS ---

  async broadcastTrackChange(song, queueIndex) {
    if (!this.isActive || !this.canControl() || this._isApplyingRemote) return;
    const now = Date.now();
    const sanitizedSong = this.sanitizeTrack(song);
    this.currentSong = sanitizedSong;
    this.trackOffset = 0;
    this.serverTimestamp = now;
    this._roomStatus = 'buffering';
    this._isBufferingHandshake = true;
    this._myAudioReady = false;

    // Reset readiness on ALL participants so everyone handshakes!
    const updatedParticipants = (this.participants || []).map(p => ({
      ...p,
      ready: false
    }));

    const rawQueue = (typeof state !== 'undefined' && Array.isArray(state.playQueue)) ? state.playQueue : [];
    const sanitizedQueue = rawQueue.slice(0, 50).map(t => this.sanitizeTrack(t)).filter(Boolean);

    try {
      const docRef = fbDb.collection('jam_sessions').doc(this.jamCode);
      await docRef.update({
        currentSong: sanitizedSong,
        currentQueueIndex: queueIndex || 0,
        playQueue: sanitizedQueue,
        status: 'buffering',
        isPlaying: false,
        trackOffset: 0,
        serverTimestamp: now,
        scheduledStartTime: null,
        participants: updatedParticipants,
        lastUpdated: now,
        lastUpdatedBy: this._myParticipantId,
        lastAction: 'track_change'
      });
      console.log('[AetherJam] Broadcast track change (buffering):', sanitizedSong.title);

      // Host safety timeout: force playback after 3.5s if a slow guest hasn't responded
      if (this.isHost) {
        clearTimeout(this._handshakeTimer);
        this._handshakeTimer = setTimeout(async () => {
          if (this.isActive && this.jamCode) {
            try {
              const snap = await docRef.get();
              if (snap.exists && snap.data().status === 'buffering') {
                console.log('[AetherJam] Handshake safety timer fired: starting playback');
                const startAnchor = Date.now() + 150;
                await docRef.update({
                  status: 'playing',
                  isPlaying: true,
                  serverTimestamp: startAnchor,
                  scheduledStartTime: startAnchor,
                  lastAction: 'play',
                  lastUpdated: Date.now(),
                  lastUpdatedBy: this._myParticipantId
                });
                this.schedulePlaybackStart(startAnchor);
              }
            } catch (e) {}
          }
        }, 3500);
      }
    } catch (err) {
      console.warn('[AetherJam] Broadcast track change error:', err);
    }
  },

  async broadcastPlay(song, position) {
    if (!this.isActive || !this.canControl() || this._isApplyingRemote) return;
    const now = Date.now();
    const startAnchor = now + 250;
    this.isPlaying = true;
    this.trackOffset = position || 0;
    this.serverTimestamp = startAnchor;
    this._playbackStartTime = startAnchor;

    // Pause briefly locally so initiator waits 250ms for the synchronized anchor with listeners
    this.executePlaybackPause();
    this.schedulePlaybackStart(startAnchor);

    try {
      const docRef = fbDb.collection('jam_sessions').doc(this.jamCode);
      await docRef.update({
        status: 'playing',
        isPlaying: true,
        trackOffset: position || 0,
        serverTimestamp: startAnchor,
        scheduledStartTime: startAnchor,
        lastUpdated: now,
        lastUpdatedBy: this._myParticipantId,
        lastAction: 'play'
      });
      console.log('[AetherJam] Broadcast PLAY event at', position, 'scheduled for anchor in 250ms');
    } catch (err) {
      console.warn('[AetherJam] Broadcast play error:', err);
    }
  },

  async broadcastPause(position) {
    if (!this.isActive || !this.canControl() || this._isApplyingRemote) return;
    const now = Date.now();
    this.isPlaying = false;
    this.trackOffset = position || 0;
    this.serverTimestamp = now;
    clearTimeout(this._startScheduleTimer);

    const audio = window.AetherAudioEngine && window.AetherAudioEngine.audioElement;
    if (audio && audio.playbackRate !== 1.0) audio.playbackRate = 1.0;

    try {
      const docRef = fbDb.collection('jam_sessions').doc(this.jamCode);
      await docRef.update({
        status: 'paused',
        isPlaying: false,
        trackOffset: position || 0,
        serverTimestamp: now,
        scheduledStartTime: null,
        lastUpdated: now,
        lastUpdatedBy: this._myParticipantId,
        lastAction: 'pause'
      });
      console.log('[AetherJam] Broadcast PAUSE event at', position);
    } catch (err) {
      console.warn('[AetherJam] Broadcast pause error:', err);
    }
  },

  async broadcastSeek(position) {
    if (!this.isActive || !this.canControl() || this._isApplyingRemote) return;
    const now = Date.now();
    this.trackOffset = position || 0;
    this.serverTimestamp = now;

    try {
      const docRef = fbDb.collection('jam_sessions').doc(this.jamCode);
      await docRef.update({
        trackOffset: position || 0,
        serverTimestamp: now,
        lastUpdated: now,
        lastUpdatedBy: this._myParticipantId,
        lastAction: 'seek'
      });
      console.log('[AetherJam] Broadcast SEEK event to', position);
    } catch (err) {
      console.warn('[AetherJam] Broadcast seek error:', err);
    }
  },

  // --- LOCAL EXECUTION HELPERS (USES WINDOW.AETHERPLAYER) ---

  executeSeek(seconds) {
    const prevApplying = this._isApplyingRemote;
    this._isApplyingRemote = true;
    try {
      if (window.AetherPlayer && typeof window.AetherPlayer.seek === 'function') {
        window.AetherPlayer.seek(seconds);
      } else if (typeof state !== 'undefined' && state.duration && typeof seekToPercentage === 'function') {
        seekToPercentage(seconds / state.duration);
      }
    } finally {
      setTimeout(() => {
        this._isApplyingRemote = prevApplying;
      }, 400);
    }
  },

  executePlaybackResume() {
    const prevApplying = this._isApplyingRemote;
    this._isApplyingRemote = true;
    try {
      if (window.AetherPlayer && typeof window.AetherPlayer.resume === 'function') {
        window.AetherPlayer.resume();
      } else if (typeof togglePlayPause === 'function') {
        togglePlayPause();
      }
    } finally {
      setTimeout(() => {
        this._isApplyingRemote = prevApplying;
      }, 400);
    }
  },

  executePlaybackPause() {
    const prevApplying = this._isApplyingRemote;
    this._isApplyingRemote = true;
    try {
      if (window.AetherPlayer && typeof window.AetherPlayer.pause === 'function') {
        window.AetherPlayer.pause();
      } else if (typeof togglePlayPause === 'function') {
        togglePlayPause();
      }
    } finally {
      setTimeout(() => {
        this._isApplyingRemote = prevApplying;
      }, 400);
    }
  },

  // --- AUTOPLAY DETECTION & BANNER ---

  verifyAutoplay() {
    setTimeout(() => {
      // If audio context is suspended, or audio element is paused while room is playing, show tap-to-sync banner
      const isSuspended = window.AetherAudioEngine && AetherAudioEngine.ctx && AetherAudioEngine.ctx.state === 'suspended';
      const audioEl = window.AetherAudioEngine && AetherAudioEngine.audioElement;
      const isAudioBlocked = this.isPlaying && (
        (audioEl && audioEl.paused) ||
        (typeof state !== 'undefined' && !state.isPlaying)
      );

      if (isSuspended || isAudioBlocked) {
        this.showAutoplayBanner();
      } else {
        this.hideAutoplayBanner();
      }
    }, 1200);
  },

  showAutoplayBanner() {
    let banner = document.getElementById('jamAutoplayBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'jamAutoplayBanner';
      banner.className = 'jam-autoplay-banner';
      banner.innerHTML = `
        <div class="jam-autoplay-content">
          <span class="jam-autoplay-icon">🔊</span>
          <span>Tap to sync audio with Jam session</span>
          <button class="btn btn-sm btn-primary" id="btnJamTapToSync">Tune In</button>
        </div>
      `;
      document.body.appendChild(banner);
      banner.querySelector('#btnJamTapToSync').addEventListener('click', async () => {
        if (window.AetherAudioEngine && AetherAudioEngine.ctx && AetherAudioEngine.ctx.state === 'suspended') {
          await AetherAudioEngine.ctx.resume().catch(() => {});
        }
        if (window.AetherAudioEngine && AetherAudioEngine.audioElement) {
          try {
            await AetherAudioEngine.audioElement.play();
          } catch (e) {}
        }
        this.executePlaybackResume();
        if (this.currentSong && this.isPlaying) {
          const now = Date.now();
          const elapsed = (now - this.serverTimestamp) / 1000;
          const target = this.trackOffset + Math.max(0, elapsed);
          this.executeSeek(target);
        }
        this.hideAutoplayBanner();
      });
    }
    banner.style.display = 'flex';
  },

  hideAutoplayBanner() {
    const banner = document.getElementById('jamAutoplayBanner');
    if (banner) banner.style.display = 'none';
  },

  // --- BACKGROUND MAINTENANCE (HEARTBEAT & DRIFT) ---

  startHeartbeat(code) {
    this.stopHeartbeat();
    this._heartbeatTimer = setInterval(async () => {
      if (!this.isActive || !this.jamCode || typeof fbDb === 'undefined' || !fbDb) return;
      try {
        const docRef = fbDb.collection('jam_sessions').doc(code);
        const snapshot = await docRef.get();
        if (snapshot.exists) {
          const data = snapshot.data();
          const now = Date.now();
          const participants = (data.participants || []).filter(p => (now - (p.lastPing || 0)) < 45000);
          const selfIdx = participants.findIndex(p => p.id === this._myParticipantId);
          if (selfIdx !== -1) {
            participants[selfIdx].lastPing = now;
          }
          await docRef.update({ participants });
        }
      } catch (e) {}
    }, 20000);
  },

  stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  },

  startDriftCorrection() {
    this.stopDriftCorrection();
    this._driftCheckTimer = setInterval(() => {
      if (!this.isActive || this.isHost || !this.isPlaying || this._roomStatus === 'buffering' || this._isBufferingHandshake) return;
      if (typeof state === 'undefined' || !state.isPlaying) return;

      // 4-second stabilization grace window after track start or resume:
      // allows the audio element to ramp up currentTime without premature seeking/restarts
      if (Date.now() - (this._playbackStartTime || 0) < 4000) {
        return;
      }

      const now = Date.now();
      const hostNow = now - (this._clockOffset || 0);
      const elapsed = Math.max(0, (hostNow - this.serverTimestamp) / 1000);
      const expected = this.trackOffset + elapsed;
      const current = state.playbackPosition || 0;
      const drift = current - expected; // positive: Guest ahead, negative: Guest behind
      const absDrift = Math.abs(drift);

      const audio = window.AetherAudioEngine && window.AetherAudioEngine.audioElement;

      if (absDrift <= 0.25) {
        // In tight sync: maintain normal 1.0x playback rate
        if (audio && audio.playbackRate !== 1.0) {
          audio.playbackRate = 1.0;
        }
      } else if (absDrift > 0.25 && absDrift <= 1.8 && state.duration && expected < state.duration - 2) {
        // Mild drift: gently adjust playbackRate by ±4% to seamlessly catch up or wait WITHOUT seeking or restarting audio
        if (audio) {
          if (drift < -0.25) {
            // Guest is slightly behind: speed up slightly by 4% to close the gap
            if (audio.playbackRate !== 1.04) {
              console.log(`[AetherJam] Smooth micro-sync: Guest is ${absDrift.toFixed(2)}s behind -> speed 1.04x`);
              audio.playbackRate = 1.04;
            }
          } else if (drift > 0.25) {
            // Guest is slightly ahead: slow down slightly by 4% to let Host catch up
            if (audio.playbackRate !== 0.96) {
              console.log(`[AetherJam] Smooth micro-sync: Guest is ${absDrift.toFixed(2)}s ahead -> speed 0.96x`);
              audio.playbackRate = 0.96;
            }
          }
        }
      } else if (absDrift > 1.8 && state.duration && expected < state.duration - 2) {
        // Severe desync (e.g. manual scrub or prolonged buffer freeze): hard seek to expected
        console.log(`[AetherJam] Hard drift recovery (${absDrift.toFixed(2)}s drift) -> seeking to ${expected.toFixed(2)}s`);
        if (audio && audio.playbackRate !== 1.0) audio.playbackRate = 1.0;
        this.executeSeek(expected);
        this._playbackStartTime = Date.now(); // Reset stabilization window
      }
    }, 1500);
  },

  stopDriftCorrection() {
    if (this._driftCheckTimer) {
      clearInterval(this._driftCheckTimer);
      this._driftCheckTimer = null;
    }
  },

  // --- UI EVENT LISTENERS & RENDERING ---

  setupUIEventListeners() {
    // Intercept track clicks and playback controls in capture phase when listening-only guest tries to change music
    const trackSelector = '.song-row, .search-result-item, .search-track-item, .track-item, .song-card, .queue-item, .queue-row, .vibe-card, .vibe-track-card, .quick-recent-card, .quick-mix-card, .playlist-card, .artist-top-track-row, .top-track-item, .history-item, .rec-track-item, .recommendation-card, .album-track-row, [data-song-id]';
    const controlSelector = '#playerPlayPause, #btnPlayPause, #playPauseBtn, #btnNext, #btnPrev, #mobileNpPlayPause, #mobileNpNext, #mobileNpPrev, #playerTimeline, #mobileNpTimeline, #btnShuffle, #btnRepeat';

    document.addEventListener('click', (e) => {
      if (this.isActive) {
        this._lastUserClickTime = Date.now();
        this._isNaturalTrackEnd = false;
      }
      if (!this.isActive || this.canControl()) return;

      const trackEl = e.target.closest(trackSelector);
      if (trackEl) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (typeof showToast === 'function') {
          showToast('Controls locked: Only the Host can change music');
        }
        return;
      }

      const controlEl = e.target.closest(controlSelector);
      if (controlEl) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (typeof showToast === 'function') {
          showToast('Controls locked: Only the Host can manage playback');
        }
        return;
      }
    }, true); // Capture phase intercepts BEFORE child listeners run

    // Intercept timeline scrubbing in capture phase
    document.addEventListener('input', (e) => {
      if (this.isActive) {
        this._lastUserClickTime = Date.now();
      }
      if (!this.isActive || this.canControl()) return;
      if (e.target && (e.target.id === 'playerTimeline' || e.target.id === 'mobileNpTimeline')) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (typeof state !== 'undefined' && state.duration) {
          e.target.value = ((this.trackOffset || 0) / state.duration) * 100;
        }
      }
    }, true);

    // Intercept spacebar hotkey for play/pause toggle
    document.addEventListener('keydown', (e) => {
      if (this.isActive) {
        this._lastUserClickTime = Date.now();
      }
      if (!this.isActive || this.canControl()) return;
      if (e.code === 'Space' && (e.target === document.body || e.target.id === 'app')) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (typeof showToast === 'function') {
          showToast('Controls locked: Only the Host can manage playback');
        }
      }
    }, true);

    // Top bar header Jam button
    const btnHeaderJam = document.getElementById('btnHeaderJam');
    if (btnHeaderJam) {
      btnHeaderJam.addEventListener('click', () => {
        this.openJamModal();
      });
    }

    // Modal close button
    const btnCloseJam = document.getElementById('btnCloseJamModal');
    if (btnCloseJam) {
      btnCloseJam.addEventListener('click', () => {
        this.closeJamModal();
      });
    }

    // Modal background click
    const modalJam = document.getElementById('modalJamSession');
    if (modalJam) {
      modalJam.addEventListener('click', (e) => {
        if (e.target === modalJam) this.closeJamModal();
      });
    }

    // Start Jam Button
    const btnStart = document.getElementById('btnStartJamSession');
    if (btnStart) {
      btnStart.addEventListener('click', () => {
        this.createJam();
      });
    }

    // Join Jam Button
    const btnJoin = document.getElementById('btnJoinJamSession');
    const inputCode = document.getElementById('inputJamCode');
    if (btnJoin && inputCode) {
      btnJoin.addEventListener('click', () => {
        this.joinJam(inputCode.value);
      });
      inputCode.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') this.joinJam(inputCode.value);
      });
    }

    // Copy Code Button
    const btnCopyCode = document.getElementById('btnCopyJamCode');
    if (btnCopyCode) {
      btnCopyCode.addEventListener('click', () => {
        if (this.jamCode) {
          navigator.clipboard.writeText(this.jamCode).then(() => {
            if (typeof showToast === 'function') showToast(`Copied ${this.jamCode}`);
          });
        }
      });
    }

    // Copy Link Button
    const btnCopyLink = document.getElementById('btnCopyJamLink');
    if (btnCopyLink) {
      btnCopyLink.addEventListener('click', () => {
        if (this.jamCode) {
          const url = `${window.location.origin}${window.location.pathname}?jam=${this.jamCode}`;
          navigator.clipboard.writeText(url).then(() => {
            if (typeof showToast === 'function') showToast('Copied Jam Invite Link!');
          });
        }
      });
    }

    // Leave Button
    const btnLeave = document.getElementById('btnLeaveJamSession');
    if (btnLeave) {
      btnLeave.addEventListener('click', () => {
        this.leaveJam();
      });
    }

    // Host Controls Only Toggle
    const toggleHostOnly = document.getElementById('toggleJamHostOnly');
    if (toggleHostOnly) {
      toggleHostOnly.addEventListener('change', async (e) => {
        if (!this.isHost || !this.jamCode) return;
        const newMode = e.target.checked ? 'host_only' : 'everyone';
        this.controlMode = newMode;
        try {
          if (typeof fbDb !== 'undefined' && fbDb) {
            await fbDb.collection('jam_sessions').doc(this.jamCode).update({
              controlMode: newMode,
              lastUpdated: Date.now()
            });
          }
        } catch (err) {}
      });
    }
  },

  openJamModal() {
    const modal = document.getElementById('modalJamSession');
    if (modal) {
      modal.classList.add('active');
      modal.style.display = 'flex';
      this.renderJamModal();
    }
  },

  closeJamModal() {
    const modal = document.getElementById('modalJamSession');
    if (modal) {
      modal.classList.remove('active');
      modal.style.display = 'none';
    }
  },

  renderJamModal() {
    const idleView = document.getElementById('jamViewIdle');
    const activeView = document.getElementById('jamViewActive');
    const displayCode = document.getElementById('jamActiveCodeDisplay');
    const toggleHost = document.getElementById('toggleJamHostOnly');

    if (!this.isActive) {
      if (idleView) idleView.style.display = 'block';
      if (activeView) activeView.style.display = 'none';
    } else {
      if (idleView) idleView.style.display = 'none';
      if (activeView) activeView.style.display = 'block';
      if (displayCode) displayCode.textContent = this.jamCode || 'JAM-XXXX';
      if (toggleHost) {
        toggleHost.checked = (this.controlMode === 'host_only');
        toggleHost.disabled = !this.isHost;
      }
      this.updateParticipantsUI();
      this.renderQrCode();
    }
  },

  renderQrCode() {
    const qrContainer = document.getElementById('jamQrContainer');
    if (!qrContainer || !this.jamCode) return;
    qrContainer.innerHTML = '';

    const url = `${window.location.origin}${window.location.pathname}?jam=${this.jamCode}`;
    if (typeof QRCode !== 'undefined') {
      try {
        new QRCode(qrContainer, {
          text: url,
          width: 140,
          height: 140,
          colorDark: '#0f0c1c',   // Dark QR squares
          colorLight: '#ffffff',  // Crisp white background
          correctLevel: QRCode.CorrectLevel.M
        });
      } catch (e) {
        console.warn('[AetherJam] QR code render failed:', e);
      }
    }
  },

  updatePillUI() {
    const pill = document.getElementById('btnHeaderJam');
    const txt = document.getElementById('txtHeaderJam');
    const playerIndicator = document.getElementById('playerJamIndicator');

    if (!pill) return;
    if (this.isActive) {
      pill.classList.add('jam-active');
      const count = this.participants.length || 1;
      if (txt) txt.textContent = `Jam (${count})`;
      if (playerIndicator) {
        playerIndicator.style.display = 'inline-flex';
        playerIndicator.textContent = `Jam • ${count} in sync`;
      }
    } else {
      pill.classList.remove('jam-active');
      if (txt) txt.textContent = 'Jam';
      if (playerIndicator) {
        playerIndicator.style.display = 'none';
      }
    }
  },

  updateParticipantsUI() {
    const list = document.getElementById('jamParticipantsList');
    const countBadge = document.getElementById('jamListenerCountBadge');
    if (countBadge) {
      const c = this.participants.length || 1;
      countBadge.textContent = `${c} Listener${c > 1 ? 's' : ''}`;
    }
    if (!list) return;

    list.innerHTML = '';
    this.participants.forEach(p => {
      const row = document.createElement('div');
      row.className = 'jam-participant-row';

      const isMe = (p.id === this._myParticipantId);
      const nameText = (p.name || 'Friend') + (isMe ? ' (You)' : '');
      const roleText = p.isHost ? 'Host' : 'Guest';
      const statusIcon = p.ready ? '🟢 Ready' : '🟡 Syncing';

      row.innerHTML = `
        <div class="jam-participant-info">
          <div class="jam-participant-avatar">
            ${p.avatar ? `<img src="${p.avatar}" alt="">` : `<div class="jam-avatar-letter">${(p.name || 'M').charAt(0).toUpperCase()}</div>`}
          </div>
          <div>
            <span class="jam-participant-name">${nameText}</span>
            <span class="jam-participant-role">${roleText} • <span class="jam-ready-tag">${statusIcon}</span></span>
          </div>
        </div>
      `;
      list.appendChild(row);
    });
  },

  checkUrlForJamInvite() {
    try {
      const params = new URLSearchParams(window.location.search);
      const jamParam = params.get('jam');
      if (jamParam) {
        setTimeout(() => {
          this.joinJam(jamParam);
        }, 800);
      }
    } catch (e) {}
  },

  _showSyncToast(msg) {
    const now = Date.now();
    if (msg === this._lastToastMessage && (now - this._lastToastTime < 3000)) return;
    this._lastToastMessage = msg;
    this._lastToastTime = now;
    if (typeof showToast === 'function') {
      showToast(msg);
    }
  }
};

// Auto-initialize when script loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.AetherJam.init());
} else {
  window.AetherJam.init();
}

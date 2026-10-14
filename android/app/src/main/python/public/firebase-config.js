// Firebase Configuration & Initialization for AetherPlayer
const firebaseConfig = {
  apiKey: "AIzaSyDBvH4WMyERUE7K_cU33_eOgECfRoYHPHo",
  authDomain: "aether-music-player-9df80.firebaseapp.com",
  projectId: "aether-music-player-9df80",
  storageBucket: "aether-music-player-9df80.firebasestorage.app",
  messagingSenderId: "845066209128",
  appId: "1:845066209128:web:0cc628406e9f0163ddf8dd",
  measurementId: "G-BZWL13CC9K"
};

let fbApp = null;
let fbAuth = null;
let fbDb = null;

function initFirebase() {
  if (typeof firebase === 'undefined') {
    console.warn('[Firebase] SDK scripts not loaded (offline or blocked). Cloud sync in local-only mode.');
    return false;
  }
  try {
    if (!firebase.apps.length) {
      fbApp = firebase.initializeApp(firebaseConfig);
    } else {
      fbApp = firebase.app();
    }
    fbAuth = firebase.auth();
    fbDb = firebase.firestore();
    console.log('[Firebase] Initialized successfully for project:', firebaseConfig.projectId);
    return true;
  } catch (err) {
    console.error('[Firebase] Initialization error:', err);
    return false;
  }
}

// Auto initialize on script load
initFirebase();

# Project Rules: AetherPlayer (Multi-Music-Tool)

## 1. Protected Core Code (Do Not Modify)
The following subsystems are the rock-solid foundation of the player. 
**Never edit, refactor, reorganize, or "clean up" these components unless explicitly asked by name.**

- **Web Audio Engine**: `AetherAudioEngine` in `public/app.js` (Web Audio context, EQ, gain nodes, crossfade graphs).
- **Core Playback Pipeline**: `playSong()`, `playYouTubeTrack()`, `playPreviewTrack()`, `playProxyFallback()` in `public/app.js`.
- **Queue & Transition State Machine**: `playNext()`, `preloadNextTrackInQueue()`, and DJ transition timers in `public/app.js`.
- **Backend Streaming & Auth**: `/api/stream`, `/api/stream-url`, `/api/stream/proxy`, and Spotify token caching in `server.py`.
- **Desktop Window & SMTC**: Taskbar controls, media keys, and PyWebView wrapper in `desktop.py`.

> If a new feature appears to need changes in any of the above: **STOP. Explain why to the user, propose an alternative (e.g. event hook), and wait for explicit approval.**

---

## 2. Feature Architecture (Modular Isolation)
- **Zero-Footprint New Features**: Any new feature (e.g. social listening, visualizers, lyrics parsers) **MUST** live in its own independent file (e.g., `public/features/xyz.js`).
- **Event-Driven Hooking**: New features must listen to clean player events (`aether:trackchange`, `aether:playbackstate`, `aether:seek`) rather than monkey-patching or rewriting core playback functions.
- **Android Mirror Awareness**: Files in `public/` are mirrored in `android/app/src/main/python/public/`. Changes to core UI/JS must consider both or use `android/copy_sources.ps1`.

---

## 3. How to Make Changes
1. **Minimal Diffs**: Make the smallest surgical change that solves the task. Never rewrite or reformat an entire file when a targeted edit works.
2. **Prefer Addition over Modification**: Prefer adding new helper files/functions over altering existing, tested logic.
3. **No Unsolicited Refactoring**: No renaming, no dependency upgrades, no style reformatting, and no "optimizations" unless explicitly requested.
4. **Preserve Behavior**: Never change function signatures, return shapes, or event formats without asking first.

---

## 4. Workflow: Before Coding
- **Read Live Files**: Always read the latest file contents before touching them. Never assume past state.
- **Plan First**: Present a clear plan specifying **which exact files** and **which functions** will be modified, and wait for approval if the change touches core behavior.
- **Clarify Uncertainties**: If a requirement has risky side effects, ask before making assumptions.

---

## 5. Workflow: After Coding & Verification
- **Run & Verify**: Verify syntax (`python -m py_compile`, `node -c`) and test the local server before declaring done.
- **Summarize Diffs**: Summarize specifically which files and functions changed.
- **Never claim a feature works without verifiable proof.**

---

## 6. Git & Branching Hygiene
- **Never run destructive git commands** (`reset --hard`, `push -f`, `clean -fd`) unless the user explicitly instructs you to do so.
- **Big Features Get Branches**: Any complex multi-step feature must be developed on a dedicated branch (`feature/<name>`), never directly on `main`.
- **Suggest Commit Messages**: At the completion of each verified task, suggest a concise commit message so progress is checkpointed cleanly.

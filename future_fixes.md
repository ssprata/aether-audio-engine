# Future Fixes - SoundCloud Playlist Import

This file details the known issues with SoundCloud playlist imports and how to resolve them in the future.

## Current Issue
SoundCloud playlist links (e.g. `https://soundcloud.com/spr4t4/sets/gym-hardstyle`) fail to import tracks properly on the Python backend.

### Technical Analysis
1. **Dynamic Client Side Rendering (CSR)**: SoundCloud's public web interface relies heavily on client-side React rendering. The raw HTML response fetched by `urllib.request` (without Javascript execution) may contain only an empty layout skeleton or simplified meta tags, missing the `<noscript>` track list or rendering them in a highly nested JSON structure inside a `<script>` tag.
2. **innerTube/OAuth Restrictions**: Unlike YouTube which has client API endpoints, SoundCloud blocks access to its public catalog endpoints without a valid Client ID (`client_id`).

---

## Proposed Solutions for the Future

### Option A: Extract from JSON Payload (Recommended)
SoundCloud embeds its initial state inside a JS script tag containing `window.__sc_hydration` or `window.__PRELOADED_STATE__`.
1. Fetch the playlist page: `https://soundcloud.com/username/sets/set-name`
2. Search the HTML for:
   ```javascript
   window.__sc_hydration = [...];
   ```
3. Parse this JSON array. It typically contains hydration models for the playlist (`playlist` type) and a list of nested track objects including titles, artist names, durations, and artwork URLs.

### Option B: SoundCloud API Integration
Require users to provide a SoundCloud Client ID/API Key in the User Profile tab, similar to the Spotify API integration.
1. Fetch playlist details using:
   ```
   GET https://api.soundcloud.com/playlists/{playlist_id}?client_id={client_id}
   ```
2. Parse the track list directly from the JSON API response.

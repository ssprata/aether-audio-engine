import os
import sys
import re
import json
import base64
import time
import urllib.request
import urllib.parse
try:
    from http.server import ThreadingHTTPServer as BaseHTTPServer, SimpleHTTPRequestHandler
except ImportError:
    from http.server import HTTPServer as BaseHTTPServer, SimpleHTTPRequestHandler
# ytmusicapi is lazy-loaded on demand below to eliminate startup delay

PORT = 3000

# Check if running on Android (Chaquopy)
IS_ANDROID = False
try:
    from android.os import Build
    IS_ANDROID = True
except ImportError:
    pass

def _migrate_legacy_data(legacy_dir, new_data_dir):
    """Automatically move existing user data from previous exe folder to AppData."""
    if not legacy_dir or legacy_dir == new_data_dir:
        return
    import shutil
    try:
        os.makedirs(new_data_dir, exist_ok=True)
        # Migrate files
        for fname in ['config.json', 'playlists_backup.json', 'history.json']:
            old_p = os.path.join(legacy_dir, fname)
            new_p = os.path.join(new_data_dir, fname)
            if os.path.exists(old_p):
                if not os.path.exists(new_p):
                    shutil.move(old_p, new_p)
                else:
                    try:
                        os.remove(old_p)
                    except Exception:
                        pass
        # Migrate folders (uploads, downloads)
        for dname in ['uploads', 'downloads']:
            old_d = os.path.join(legacy_dir, dname)
            new_d = os.path.join(new_data_dir, dname)
            if os.path.exists(old_d) and os.path.isdir(old_d):
                os.makedirs(new_d, exist_ok=True)
                for item in os.listdir(old_d):
                    s = os.path.join(old_d, item)
                    d = os.path.join(new_d, item)
                    if not os.path.exists(d):
                        shutil.move(s, d)
                try:
                    if not os.listdir(old_d):
                        os.rmdir(old_d)
                except Exception:
                    pass
    except Exception as e:
        print("[Migration Warning]", e)

# Handle PyInstaller frozen executable environment
if getattr(sys, 'frozen', False):
    BUNDLE_DIR = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    appdata = os.getenv('APPDATA')
    if appdata:
        DATA_DIR = os.path.join(appdata, 'AetherPlayer')
    else:
        DATA_DIR = os.path.join(os.path.expanduser('~'), '.aetherplayer')
    
    # Auto-migrate any stray files from the exe directory
    exe_dir = os.path.dirname(sys.executable)
    _migrate_legacy_data(exe_dir, DATA_DIR)
else:
    BUNDLE_DIR = os.path.dirname(os.path.abspath(__file__))
    DATA_DIR = BUNDLE_DIR

PUBLIC_DIR = os.path.join(BUNDLE_DIR, 'public')

if IS_ANDROID:
    # Under Chaquopy, redirect config and writeable uploads to application files storage
    from com.chaquo.python import Python
    context = Python.getPlatform().getApplication()
    android_files_dir = context.getFilesDir().getAbsolutePath()
    
    CONFIG_FILE = os.path.join(android_files_dir, 'config.json')
    BACKUP_FILE = os.path.join(android_files_dir, 'playlists_backup.json')
    UPLOADS_DIR = os.path.join(android_files_dir, 'uploads')
    HISTORY_FILE = os.path.join(android_files_dir, 'history.json')
    DOWNLOADS_DIR = os.path.join(android_files_dir, 'downloads')
    WEEKLY_PLAYS_FILE = os.path.join(android_files_dir, 'weekly_plays.json')
    WEEKLY_RANKING_FILE = os.path.join(android_files_dir, 'weekly_ranking_cache.json')
    QUEUE_SESSION_FILE = os.path.join(android_files_dir, 'queue_session.json')
else:
    CONFIG_FILE = os.path.join(DATA_DIR, 'config.json')
    BACKUP_FILE = os.path.join(DATA_DIR, 'playlists_backup.json')
    UPLOADS_DIR = os.path.join(DATA_DIR, 'uploads')
    HISTORY_FILE = os.path.join(DATA_DIR, 'history.json')
    DOWNLOADS_DIR = os.path.join(DATA_DIR, 'downloads')
    WEEKLY_PLAYS_FILE = os.path.join(DATA_DIR, 'weekly_plays.json')
    WEEKLY_RANKING_FILE = os.path.join(DATA_DIR, 'weekly_ranking_cache.json')
    QUEUE_SESSION_FILE = os.path.join(DATA_DIR, 'queue_session.json')

OFFLINE_INDEX_FILE = os.path.join(DOWNLOADS_DIR, 'offline_index.json')
os.makedirs(DOWNLOADS_DIR, exist_ok=True)
os.makedirs(UPLOADS_DIR, exist_ok=True)

# In-memory lyrics cache & rate-limit cooldown
LYRICS_CACHE = {}
LYRICS_RATE_LIMIT_COOLDOWN = 0

def clean_track_metadata_for_lyrics(raw_title, raw_artist):
    """Clean noisy YouTube/platform metadata into clean artist and track title for LrcLib."""
    t = raw_title or ''
    # Strip common bracketed tags e.g. [Official Video], (4K 60fps), (Lyric Video), [MV]
    noise_patterns = [
        r'\(.*?(?:official|video|audio|lyric|visualizer|remaster|live|version|edit|prod|feat|ft\.).*?\)',
        r'\[.*?(?:official|video|audio|lyric|visualizer|remaster|live|version|edit|prod|feat|ft\.).*?\]',
        r'\(.*?\)',
        r'\[.*?\]',
        r'(?i)\b(?:official\s*(?:video|audio|music\s*video)|lyric\s*video|visualizer|remastered|remaster|hd|4k)\b'
    ]
    for pat in noise_patterns:
        t = re.sub(pat, '', t, flags=re.I).strip()

    a = raw_artist or ''
    # Strip YouTube topic channel tags (e.g. "Dua Lipa - Topic" -> "Dua Lipa")
    a = re.sub(r'\s*-\s*topic\b', '', a, flags=re.I).strip()
    a = re.sub(r'\(.*?\)|\[.*?\]', '', a).strip()

    # If title has "Artist - Title", split it
    if ' - ' in t:
        parts = t.split(' - ', 1)
        potential_artist = parts[0].strip()
        potential_title = parts[1].strip()
        if potential_artist and potential_title:
            if not a or 'topic' in (raw_artist or '').lower() or 'vevo' in (raw_artist or '').lower() or a.lower() in potential_artist.lower():
                a = potential_artist
            t = potential_title

    t = re.sub(r'\s+', ' ', t).strip()
    a = re.sub(r'\s+', ' ', a).strip()
    return t, a

def get_cached_lyrics(clean_t, clean_a):
    key = f"{clean_t.lower()}|{clean_a.lower()}"
    return LYRICS_CACHE.get(key)

def set_cached_lyrics(clean_t, clean_a, lyrics_obj):
    key = f"{clean_t.lower()}|{clean_a.lower()}"
    LYRICS_CACHE[key] = lyrics_obj
    if len(LYRICS_CACHE) > 500:
        first_key = next(iter(LYRICS_CACHE))
        del LYRICS_CACHE[first_key]

def read_history():
    print("Reading history from:", HISTORY_FILE)
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                print("History loaded successfully, count:", len(data))
                return data
        except Exception as e:
            print("Failed to read history:", e)
            return []
    print("History file does not exist at path")
    return []

def write_history(history):
    try:
        with open(HISTORY_FILE, 'w', encoding='utf-8') as f:
            json.dump(history, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print("Failed to write history:", e)

def append_weekly_play(song_data):
    """Store track play event with timestamp in local cache directory. Prunes entries older than 8 days."""
    if not song_data or not song_data.get('id'):
        return
    now = int(time.time())
    entry = {
        'id': song_data.get('id'),
        'title': song_data.get('title') or 'Unknown Title',
        'artist': song_data.get('artist') or 'Unknown Artist',
        'thumbnail': song_data.get('thumbnail') or '',
        'duration': song_data.get('duration') or '3:00',
        'platform': song_data.get('platform') or 'youtube',
        'timestamp': now
    }
    plays = []
    if os.path.exists(WEEKLY_PLAYS_FILE):
        try:
            with open(WEEKLY_PLAYS_FILE, 'r', encoding='utf-8') as f:
                plays = json.load(f)
        except Exception:
            plays = []
    
    # Prune plays older than 8 days (8 * 86400 = 691200 seconds)
    cutoff = now - 691200
    plays = [p for p in plays if isinstance(p, dict) and p.get('timestamp', 0) >= cutoff]
    plays.append(entry)
    
    # Cap maximum history count to 3000 to keep file fast
    if len(plays) > 3000:
        plays = plays[-3000:]
        
    try:
        with open(WEEKLY_PLAYS_FILE, 'w', encoding='utf-8') as f:
            json.dump(plays, f, ensure_ascii=False)
    except Exception as e:
        print("Failed to write weekly plays:", e)

def get_most_listened_this_week():
    """Calculate and update the ranking once per day (or at app startup) using recency-weighted decay:
    Weight(delta_t) = 2^(-delta_t / 1.8), where recent listens weigh significantly heavier than older ones."""
    import datetime
    today_str = datetime.date.today().isoformat()
    
    # 1. Check if ranking was already computed today
    if os.path.exists(WEEKLY_RANKING_FILE):
        try:
            with open(WEEKLY_RANKING_FILE, 'r', encoding='utf-8') as f:
                cached = json.load(f)
                if isinstance(cached, dict) and cached.get('date') == today_str and cached.get('tracks'):
                    return cached.get('tracks')
        except Exception:
            pass
            
    # 2. Recalculate ranking once for today
    plays = []
    if os.path.exists(WEEKLY_PLAYS_FILE):
        try:
            with open(WEEKLY_PLAYS_FILE, 'r', encoding='utf-8') as f:
                plays = json.load(f)
        except Exception:
            plays = []
            
    now = int(time.time())
    scores = {}
    track_meta = {}
    
    for p in plays:
        if not isinstance(p, dict) or not p.get('id'):
            continue
        ts = p.get('timestamp', now)
        delta_days = (now - ts) / 86400.0
        if delta_days <= 7.0:
            # Recency-weighted decay: half-life ~1.8 days
            weight = 2.0 ** (-max(0.0, delta_days) / 1.8)
            tid = p['id']
            scores[tid] = scores.get(tid, 0.0) + weight
            if tid not in track_meta:
                track_meta[tid] = {
                    'id': tid,
                    'title': p.get('title', 'Unknown'),
                    'artist': p.get('artist', 'Unknown'),
                    'thumbnail': p.get('thumbnail', ''),
                    'duration': p.get('duration', '3:00'),
                    'platform': p.get('platform', 'youtube')
                }
                
    # Sort tracks descending by momentum score
    ranked_ids = sorted(scores.keys(), key=lambda k: scores[k], reverse=True)
    top_tracks = [track_meta[k] for k in ranked_ids[:8]]
    
    # If fewer than 8 tracks have been logged this week, supplement with recent history
    if len(top_tracks) < 8:
        history = read_history()
        seen_ids = set(t['id'] for t in top_tracks)
        for h in history:
            if h.get('id') and h['id'] not in seen_ids:
                seen_ids.add(h['id'])
                top_tracks.append(h)
                if len(top_tracks) >= 8:
                    break
                    
    # Cache today's calculated ranking
    try:
        with open(WEEKLY_RANKING_FILE, 'w', encoding='utf-8') as f:
            json.dump({'date': today_str, 'tracks': top_tracks}, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print("Failed to cache weekly ranking:", e)
        
    return top_tracks

def read_queue_session():
    if os.path.exists(QUEUE_SESSION_FILE):
        try:
            with open(QUEUE_SESSION_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return None
    return None

def write_queue_session(session_data):
    try:
        with open(QUEUE_SESSION_FILE, 'w', encoding='utf-8') as f:
            json.dump(session_data, f, ensure_ascii=False)
        return True
    except Exception as e:
        print("Failed to save queue session:", e)
        return False

# Initialize YouTube Music API client lazily to eliminate startup block
_ytmusic_instance = None

def get_ytmusic():
    global _ytmusic_instance
    if _ytmusic_instance is None:
        try:
            from ytmusicapi import YTMusic
            _ytmusic_instance = YTMusic()
        except Exception as e:
            print("Failed to initialize YTMusic:", e)
    return _ytmusic_instance

class LazyYTMusic:
    def __getattr__(self, name):
        inst = get_ytmusic()
        if inst is None:
            raise RuntimeError("YTMusic client is not initialized")
        return getattr(inst, name)

ytmusic = LazyYTMusic()

# Create necessary folders
os.makedirs(UPLOADS_DIR, exist_ok=True)

# Helper to read config
def read_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

# Helper to write config
def write_config(config):
    try:
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print("Error writing config:", e)

# Helper to extract all videoRenderers from YouTube search JSON
def find_video_renderers(data, results):
    if isinstance(data, dict):
        if 'videoRenderer' in data:
            results.append(data['videoRenderer'])
        else:
            for val in data.values():
                find_video_renderers(val, results)
    elif isinstance(data, list):
        for item in data:
            find_video_renderers(item, results)

# Helper to format duration in ms to M:SS
def format_duration_ms(ms):
    total_secs = int(ms / 1000)
    minutes = total_secs // 60
    seconds = total_secs % 60
    return f"{minutes}:{seconds:02d}"

# Default Spotify client credentials so search & metadata work out-of-the-box without manual setup
DEFAULT_SPOTIFY_CLIENT_ID = "3510f89188314655988ffca613fab25f"
DEFAULT_SPOTIFY_CLIENT_SECRET = "ce7cb9306aba4790a71f9e8bd1c25969"

_spotify_token_cache = {
    'token': None,
    'expires_at': 0,
    'key': None
}

# Spotify Auth helper with in-memory caching and fallback credentials
def get_spotify_access_token(client_id=None, client_secret=None):
    cid = (client_id or '').strip() if client_id else ''
    sec = (client_secret or '').strip() if client_secret else ''
    if not cid or not sec:
        cid = DEFAULT_SPOTIFY_CLIENT_ID
        sec = DEFAULT_SPOTIFY_CLIENT_SECRET
    if not cid or not sec:
        return None

    cache_key = f"{cid}:{sec}"
    now = time.time()
    if _spotify_token_cache['token'] and _spotify_token_cache['key'] == cache_key and now < _spotify_token_cache['expires_at'] - 60:
        return _spotify_token_cache['token']

    try:
        auth_bytes = f"{cid}:{sec}".encode('utf-8')
        auth_string = base64.b64encode(auth_bytes).decode('utf-8')
        url = 'https://accounts.spotify.com/api/token'
        headers = {
            'Authorization': f'Basic {auth_string}',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
        data = urllib.parse.urlencode({'grant_type': 'client_credentials'}).encode('utf-8')
        req = urllib.request.Request(url, data=data, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as res:
            response_data = json.loads(res.read().decode('utf-8'))
            token = response_data.get('access_token')
            expires_in = response_data.get('expires_in', 3600)
            if token:
                _spotify_token_cache['token'] = token
                _spotify_token_cache['expires_at'] = now + expires_in
                _spotify_token_cache['key'] = cache_key
            return token
    except Exception as err:
        print("Spotify auth error:", err)
        return None

# Banned modifiers, remix memes, loops, and junk keywords for true music vibe discovery
BANNED_VIBE_KEYWORDS = {
    'slowed', 'reverb', 'sped up', 'speed up', 'speedup', 'spedup',
    'nightcore', 'daycore', 'bass boosted', 'bassboost', 'bassboosted',
    '8d audio', '16d audio', '3d audio',
    '1 hour', '10 hours', '10hr', '1hr', 'extended loop', 'loop version',
    'instrumental', 'karaoke', 'backing track', 'acapella', 'a cappella',
    'cover version', 'acoustic cover', 'guitar cover', 'piano cover', 'drum cover',
    'tribute', 'parody', 'mashup', 'pitch shifted', 'pitched',
    'reaction video', 'reaction', 'tutorial', 'how to play', 'clean version'
}

def clean_title_tokens(title_text):
    if not title_text:
        return set()
    # Strip bracketed tags (e.g. [Official Video], (Live at ...), etc.)
    text = re.sub(r'[\(\[][^\)\]]*[\)\]]', '', title_text)
    text = re.sub(r'[^a-zA-Z0-9\s]', ' ', text).lower()
    stop_words = {'the', 'and', 'official', 'video', 'audio', 'feat', 'ft', 'music', 'version', 'remaster', 'remastered', 'single', 'album', 'edit', 'radio'}
    return set(w for w in text.split() if len(w) > 2 and w not in stop_words)

def is_vibe_polluted(title, seed_title='', seed_artist=''):
    title_lower = title.lower()
    
    # 1. Banned modifier/meme keywords
    for keyword in BANNED_VIBE_KEYWORDS:
        if keyword in title_lower:
            return True
            
    # Check common regex patterns for slowed & reverb, sped up, and hour loops
    if re.search(r'slowed\s*[\+&/]?\s*reverb', title_lower):
        return True
    if re.search(r'sped\s*up|speed\s*up', title_lower):
        return True
    if re.search(r'1\s*hour|10\s*hour|loop\b', title_lower):
        return True
    if re.search(r'\b(cover|remake|karaoke|instrumental|acapella)\b', title_lower):
        return True

    # 2. Check for duplicate / same song name as the seed track
    if seed_title:
        seed_tokens = clean_title_tokens(seed_title)
        cand_tokens = clean_title_tokens(title)
        
        # Exact token match (e.g. "After Dark" vs "After Dark")
        if seed_tokens and cand_tokens and seed_tokens == cand_tokens:
            return True
            
        # Seed tokens subset of candidate with high coverage (e.g. "After Dark" in "After Dark Extended")
        if seed_tokens and len(seed_tokens) >= 2 and seed_tokens.issubset(cand_tokens):
            return True
            
        # Single distinctive seed word (e.g. "Starboy")
        if len(seed_tokens) == 1:
            seed_word = list(seed_tokens)[0]
            if len(seed_word) >= 5 and seed_word in cand_tokens:
                return True

    return False

# Get related tracks from YouTube Music algorithmic radio (same vibe, no duplicates/slowed/reverb)
def get_related_tracks(video_id, platform='youtube', seed_title='', seed_artist='', limit=15, exclude_ids=None):
    try:
        # Invoking radio=True triggers YouTube Music's machine-learned song radio algorithm
        # We fetch up to 50 candidates so we can strictly filter out all junk, duplicates, and already-played tracks
        playlist = ytmusic.get_watch_playlist(videoId=video_id, radio=True, limit=50)
        tracks = playlist.get('tracks', [])
        
        if not tracks:
            playlist = ytmusic.get_watch_playlist(videoId=video_id, limit=30)
            tracks = playlist.get('tracks', [])
            
        related = []
        artist_counts = {}
        seen_ids = {video_id}
        if exclude_ids:
            if isinstance(exclude_ids, str):
                seen_ids.update(x.strip() for x in exclude_ids.split(',') if x.strip())
            elif isinstance(exclude_ids, (list, set)):
                seen_ids.update(exclude_ids)
        
        for item in tracks:
            item_id = item.get('videoId')
            if not item_id or item_id in seen_ids:
                continue
            seen_ids.add(item_id)
            
            raw_title = item.get('title', 'Unknown Track')
            
            # Filter out slowed/reverb, speedups, memes, and duplicate song titles
            if is_vibe_polluted(raw_title, seed_title=seed_title, seed_artist=seed_artist):
                continue
                
            artists = item.get('artists', [])
            artist_name = ", ".join([a.get('name', 'Unknown Artist') for a in artists]) if artists else item.get('author', 'Unknown Artist')
            
            # Artist diversity cap: max 1 other song by the seed artist, max 2 by any other artist
            main_artist = artists[0].get('name', '').lower() if artists else artist_name.lower()
            if seed_artist and main_artist == seed_artist.lower():
                if artist_counts.get(main_artist, 0) >= 1:
                    continue
            if artist_counts.get(main_artist, 0) >= 2:
                continue
            artist_counts[main_artist] = artist_counts.get(main_artist, 0) + 1
            
            duration = item.get('length', '3:00')
            
            thumbnail = ''
            thumbnails = item.get('thumbnail', [])
            if isinstance(thumbnails, list) and thumbnails:
                thumbnail = thumbnails[-1].get('url', '')
            elif isinstance(thumbnails, dict):
                thumbnail = thumbnails.get('url', '')
                
            clean_title = re.sub(r'\s*[\(\[][^\]\)]*(official|video|lyric|audio|hd|4k|hq)[^\]\)]*[\)\]]\s*', '', raw_title, flags=re.I).strip()
            clean_title = re.sub(r'\s*-\s*topic\s*$', '', clean_title, flags=re.I).strip()
            
            track_data = {
                'id': item_id,
                'title': clean_title or raw_title,
                'artist': artist_name,
                'duration': duration,
                'thumbnail': thumbnail,
                'url': f"https://music.youtube.com/watch?v={item_id}",
                'platform': platform if platform in ('youtube', 'spotify') else 'youtube'
            }
            if platform == 'spotify':
                track_data['isFallback'] = True
                
            related.append(track_data)
            if len(related) >= limit:
                break
                
        return related
    except Exception as e:
        print(f"Error fetching related vibe tracks for video {video_id}: {e}")
        return []

# Search YouTube
def search_youtube(query, limit=20):
    try:
        raw_results = ytmusic.search(query, filter="songs", limit=limit)
        results = []
        for item in raw_results:
            video_id = item.get('videoId')
            if not video_id:
                continue
            
            artists = item.get('artists', [])
            artist_name = ", ".join([a.get('name', 'Unknown Artist') for a in artists]) if artists else 'Unknown Artist'
            
            duration = item.get('duration', '3:00')
            
            thumbnail = ''
            thumbnails = item.get('thumbnails', [])
            if thumbnails:
                thumbnail = thumbnails[-1].get('url', '')
                
            album = item.get('album', {})
            album_id = album.get('id') if isinstance(album, dict) else None
            album_name = album.get('name') if isinstance(album, dict) else None

            results.append({
                'id': video_id,
                'title': item.get('title', 'Unknown Track'),
                'artist': artist_name,
                'duration': duration,
                'thumbnail': thumbnail,
                'url': f"https://music.youtube.com/watch?v={video_id}",
                'platform': 'youtube',
                'albumId': album_id,
                'albumName': album_name
            })
        return results
    except Exception as e:
        print("YouTube Music search error:", e)
        return []

# Search Spotify
def search_spotify(query):
    config = read_config()
    client_id = config.get('spotifyClientId')
    client_secret = config.get('spotifyClientSecret')
    token = get_spotify_access_token(client_id, client_secret)
    
    if not token:
        # Fallback to YouTube proxy
        yt_results = search_youtube(query + ' spotify', limit=15)
        for song in yt_results:
            song['platform'] = 'spotify'
            song['isFallback'] = True
            # Clean title
            song['title'] = re.sub(r'spotify|official video|lyric video|audio', '', song['title'], flags=re.I).strip()
        return yt_results

    try:
        url = f"https://api.spotify.com/v1/search?q={urllib.parse.quote(query)}&type=track&limit=20"
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
        with urllib.request.urlopen(req) as res:
            data = json.loads(res.read().decode('utf-8'))
            
        tracks = []
        for t in data.get('tracks', {}).get('items', []):
            artists = ", ".join([a['name'] for a in t['artists']])
            thumbnail = t['album']['images'][0]['url'] if t['album']['images'] else 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=200&auto=format&fit=crop'
            tracks.append({
                'id': t['id'],
                'title': t['name'],
                'artist': artists,
                'duration': format_duration_ms(t['duration_ms']),
                'thumbnail': thumbnail,
                'url': t['external_urls']['spotify'],
                'platform': 'spotify',
                'previewUrl': t.get('preview_url'),
                'albumId': t.get('album', {}).get('id'),
                'albumName': t.get('album', {}).get('name')
            })
        return tracks
    except Exception as err:
        print("Spotify API search failed:", err)
        return []


# Regex to match URLs
YOUTUBE_VIDEO_RE = re.compile(r'(?:youtube\.com/watch\S*v=|youtu\.be/|youtube\.com/shorts/|music\.youtube\.com/watch\S*v=)([a-zA-Z0-9_-]{11})')
YOUTUBE_PLAYLIST_RE = re.compile(r'[&?]list=([a-zA-Z0-9_-]+)')

SPOTIFY_TRACK_RE = re.compile(r'open\.spotify\.com/track/([a-zA-Z0-9]+)')
SPOTIFY_PLAYLIST_RE = re.compile(r'open\.spotify\.com/playlist/([a-zA-Z0-9]+)')

SOUNDCLOUD_TRACK_RE = re.compile(r'soundcloud\.com/([a-zA-Z0-9_-]+)/(?!sets/|discover|stream|upload|search|terms|privacy|pages)([a-zA-Z0-9_-]+)')
SOUNDCLOUD_PLAYLIST_RE = re.compile(r'soundcloud\.com/([a-zA-Z0-9_-]+)/sets/([a-zA-Z0-9_-]+)')

def resolve_redirect(url):
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        })
        with urllib.request.urlopen(req) as res:
            return res.geturl()
    except Exception as e:
        print("Redirect resolve error:", e)
        return url

def resolve_youtube_video(video_id):
    try:
        data = ytmusic.get_song(video_id)
        video_details = data.get('videoDetails', {})
        if video_details:
            title = video_details.get('title', 'Unknown Track')
            author = video_details.get('author', 'Unknown Artist')
            length_sec = int(video_details.get('lengthSeconds', 180))
            
            minutes = length_sec // 60
            seconds = length_sec % 60
            duration = f"{minutes}:{seconds:02d}"
            
            thumbnails = video_details.get('thumbnail', {}).get('thumbnails', [])
            thumbnail = thumbnails[-1].get('url') if thumbnails else ''
            
            return {
                'id': video_id,
                'title': title,
                'artist': author,
                'duration': duration,
                'thumbnail': thumbnail,
                'url': f"https://music.youtube.com/watch?v={video_id}",
                'platform': 'youtube'
            }
    except Exception as e:
        print("YouTube Music video resolve error:", e)
        
    try:
        results = search_youtube(video_id, limit=1)
        if results:
            return results[0]
    except Exception:
        pass
        
    return {
        'id': video_id,
        'title': 'YouTube Video',
        'artist': 'YouTube',
        'duration': '3:00',
        'thumbnail': f"https://img.youtube.com/vi/{video_id}/0.jpg",
        'url': f"https://music.youtube.com/watch?v={video_id}",
        'platform': 'youtube'
    }

def find_youtube_playlist_videos(data):
    videos = []
    
    def traverse(obj):
        if isinstance(obj, dict):
            if 'playlistVideoRenderer' in obj:
                r = obj['playlistVideoRenderer']
                title = 'Unknown'
                if 'title' in r:
                    runs = r['title'].get('runs', [])
                    if runs: title = runs[0].get('text', 'Unknown')
                artist = 'Unknown'
                if 'shortBylineText' in r:
                    runs = r['shortBylineText'].get('runs', [])
                    if runs: artist = runs[0].get('text', 'Unknown')
                duration = r.get('lengthText', {}).get('simpleText', '3:00')
                vid = r.get('videoId')
                thumb = ''
                if 'thumbnail' in r and 'thumbnails' in r['thumbnail']:
                    thumb = r['thumbnail']['thumbnails'][0].get('url', '')
                if vid:
                    videos.append({
                        'id': vid,
                        'title': title,
                        'artist': artist,
                        'duration': duration,
                        'thumbnail': thumb,
                        'url': f"https://www.youtube.com/watch?v={vid}",
                        'platform': 'youtube'
                    })
            elif 'lockupViewModel' in obj:
                lvm = obj['lockupViewModel']
                vid = lvm.get('contentId')
                contentType = lvm.get('contentType')
                if vid and contentType == 'LOCKUP_CONTENT_TYPE_VIDEO':
                    label = lvm.get('rendererContext', {}).get('accessibilityContext', {}).get('label', '')
                    title = "YouTube Video"
                    artist = "Unknown Artist"
                    duration = "3:00"
                    
                    if label:
                        hour_match = re.search(r'(?:(\d+)\s*hours?,\s*)?(\d+)\s*minutes?,?\s*(?:(\d+)\s*seconds?)?$', label)
                        if hour_match:
                            h = int(hour_match.group(1)) if hour_match.group(1) else 0
                            m = int(hour_match.group(2)) if hour_match.group(2) else 0
                            s = int(hour_match.group(3)) if hour_match.group(3) else 0
                            if h > 0:
                                duration = f"{h}:{m:02d}:{s:02d}"
                            else:
                                duration = f"{m}:{s:02d}"
                            clean_label = label[:hour_match.start()].strip()
                        else:
                            clean_label = label
                            
                        if " - " in clean_label:
                            parts = clean_label.split(" - ", 1)
                            artist = parts[0].strip()
                            title = parts[1].strip()
                        else:
                            title = clean_label
                    
                    thumb = f"https://img.youtube.com/vi/{vid}/0.jpg"
                    img_data = lvm.get('contentImage', {})
                    def find_thumb(o):
                        if isinstance(o, dict):
                            if 'url' in o and o['url'].startswith('http'):
                                return o['url']
                            for val in o.values():
                                res = find_thumb(val)
                                if res: return res
                        elif isinstance(o, list):
                            for item in o:
                                res = find_thumb(item)
                                if res: return res
                        return None
                    extracted_thumb = find_thumb(img_data)
                    if extracted_thumb:
                        thumb = extracted_thumb
                        
                    videos.append({
                        'id': vid,
                        'title': title,
                        'artist': artist,
                        'duration': duration,
                        'thumbnail': thumb,
                        'url': f"https://www.youtube.com/watch?v={vid}",
                        'platform': 'youtube'
                    })
            else:
                for val in obj.values():
                    traverse(val)
        elif isinstance(obj, list):
            for item in obj:
                traverse(item)
                
    traverse(data)
    return videos

def find_playlist_title(data):
    def traverse(obj):
        if isinstance(obj, dict):
            if 'playlistMetadataRenderer' in obj:
                return obj['playlistMetadataRenderer'].get('title')
            if 'playlistSidebarPrimaryInfoRenderer' in obj:
                runs = obj['playlistSidebarPrimaryInfoRenderer'].get('title', {}).get('runs', [])
                if runs: return runs[0].get('text')
            for val in obj.values():
                res = traverse(val)
                if res: return res
        elif isinstance(obj, list):
            for item in obj:
                res = traverse(item)
                if res: return res
        return None
    return traverse(data) or "Imported YouTube Playlist"

def resolve_youtube_mix(playlist_id=None, video_id=None, limit=100):
    try:
        kwargs = {'limit': limit}
        if playlist_id:
            kwargs['playlistId'] = playlist_id
        if video_id:
            kwargs['videoId'] = video_id
        elif playlist_id and playlist_id.startswith('RDAMVM'):
            potential_vid = playlist_id[6:]
            if len(potential_vid) == 11:
                kwargs['videoId'] = potential_vid
        elif playlist_id and playlist_id.startswith('RD') and len(playlist_id) == 13:
            potential_vid = playlist_id[2:]
            if len(potential_vid) == 11:
                kwargs['videoId'] = potential_vid

        if not playlist_id and video_id:
            kwargs['radio'] = True

        res = ytmusic.get_watch_playlist(**kwargs)
        raw_tracks = res.get('tracks', [])
        tracks = []
        for item in raw_tracks:
            vid = item.get('videoId')
            if not vid:
                continue
            title = item.get('title', 'Unknown Track')
            artists = item.get('artists', [])
            artist_name = ", ".join([a.get('name', '') for a in artists if isinstance(a, dict) and a.get('name')]) if artists else item.get('author', 'Unknown Artist')
            duration = item.get('length', '3:00')
            thumb = ''
            thumbnails = item.get('thumbnail', [])
            if isinstance(thumbnails, list) and thumbnails:
                thumb = thumbnails[-1].get('url', '')
            elif isinstance(thumbnails, dict):
                thumb = thumbnails.get('url', '')
            if not thumb:
                thumb = f"https://img.youtube.com/vi/{vid}/0.jpg"
                
            tracks.append({
                'id': vid,
                'title': title,
                'artist': artist_name,
                'duration': duration,
                'thumbnail': thumb,
                'url': f"https://www.youtube.com/watch?v={vid}",
                'platform': 'youtube'
            })
            if len(tracks) >= limit:
                break
                
        mix_title = res.get('title')
        if not mix_title or mix_title == 'None':
            if tracks:
                mix_title = f"Mix - {tracks[0]['title']}"
            else:
                mix_title = "YouTube Mix"

        return {
            'name': mix_title,
            'tracks': tracks
        }
    except Exception as e:
        print("YouTube Mix resolve error:", e)
        return None

def resolve_youtube_playlist(playlist_id, video_id=None, limit=100):
    is_mix = False
    if playlist_id:
        if playlist_id.startswith('RD') or playlist_id.startswith('RDAMVM') or playlist_id.startswith('RDMM') or playlist_id.startswith('RDEM') or playlist_id.startswith('RDCLAK') or playlist_id.startswith('RDQM'):
            is_mix = True
    if is_mix or (video_id and not playlist_id):
        mix_res = resolve_youtube_mix(playlist_id=playlist_id, video_id=video_id, limit=limit)
        if mix_res and mix_res.get('tracks'):
            return mix_res

    try:
        url = f"https://www.youtube.com/playlist?list={playlist_id}"
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
        }
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as res:
            html = res.read().decode('utf-8')
            
        start_str = 'var ytInitialData = '
        start_idx = html.find(start_str)
        if start_idx == -1:
            start_str = 'ytInitialData = '
            start_idx = html.find(start_str)
            
        if start_idx != -1:
            # extract json
            idx = html.find('{', start_idx)
            brace_count = 0
            in_string = False
            escape = False
            raw_json = None
            for i in range(idx, len(html)):
                char = html[i]
                if escape:
                    escape = False
                    continue
                if char == '\\':
                    escape = True
                    continue
                if char == '"':
                    in_string = not in_string
                    continue
                if not in_string:
                    if char == '{':
                        brace_count += 1
                    elif char == '}':
                        brace_count -= 1
                        if brace_count == 0:
                            raw_json = html[idx:i+1]
                            break
            if raw_json:
                data = json.loads(raw_json)
                title = find_playlist_title(data)
                tracks = find_youtube_playlist_videos(data)
                if tracks:
                    return {
                        'name': title,
                        'tracks': tracks[:limit]
                    }
    except Exception as e:
        print("YouTube playlist resolve error:", e)

    # Fallback to get_watch_playlist
    mix_res = resolve_youtube_mix(playlist_id=playlist_id, video_id=video_id, limit=limit)
    if mix_res and mix_res.get('tracks'):
        return mix_res

    return None


def resolve_spotify_track(track_id):
    config = read_config()
    client_id = config.get('spotifyClientId')
    client_secret = config.get('spotifyClientSecret')
    token = get_spotify_access_token(client_id, client_secret)
    
    if token:
        try:
            url = f"https://api.spotify.com/v1/tracks/{track_id}"
            req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
            with urllib.request.urlopen(req) as res:
                t = json.loads(res.read().decode('utf-8'))
            artists = ", ".join([a['name'] for a in t['artists']])
            thumbnail = t['album']['images'][0]['url'] if t['album']['images'] else ''
            return {
                'id': t['id'],
                'title': t['name'],
                'artist': artists,
                'duration': format_duration_ms(t['duration_ms']),
                'thumbnail': thumbnail,
                'url': t['external_urls']['spotify'],
                'platform': 'spotify',
                'previewUrl': t.get('preview_url'),
                'albumId': t.get('album', {}).get('id'),
                'albumName': t.get('album', {}).get('name')
            }
        except Exception as e:
            print("Spotify API track fetch failed, falling back to scrape:", e)
            
    # Fallback 1: Try Spotify Embed track scraping (requires no credentials)
    try:
        embed_url = f"https://open.spotify.com/embed/track/{track_id}"
        embed_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        req_embed = urllib.request.Request(embed_url, headers=embed_headers)
        with urllib.request.urlopen(req_embed, timeout=8) as res_embed:
            html_embed = res_embed.read().decode('utf-8')
        m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html_embed, re.DOTALL)
        if m:
            data = json.loads(m.group(1))
            entity = data.get('props', {}).get('pageProps', {}).get('state', {}).get('data', {}).get('entity', {})
            if entity:
                title = entity.get('title', 'Spotify Track')
                artist = entity.get('subtitle', 'Unknown Artist')
                duration_ms = entity.get('duration', 180000)
                cover_art = entity.get('coverArt', {}).get('sources', [{}])[0].get('url', '')
                preview_url = entity.get('audioPreview', {}).get('url') if entity.get('audioPreview') else None
                return {
                    'id': track_id,
                    'title': title,
                    'artist': artist,
                    'duration': format_duration_ms(duration_ms),
                    'thumbnail': cover_art,
                    'url': f"https://open.spotify.com/track/{track_id}",
                    'platform': 'spotify',
                    'previewUrl': preview_url
                }
    except Exception as e:
        print("Spotify embed track scrape fallback error:", e)

    # Fallback 2: scrape Spotify track page
    try:
        url = f"https://open.spotify.com/track/{track_id}"
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as res:
            html = res.read().decode('utf-8')
            
        title_match = re.search(r'<meta\s+property="og:title"\s+content="([^"]+)"', html)
        desc_match = re.search(r'<meta\s+property="og:description"\s+content="([^"]+)"', html)
        image_match = re.search(r'<meta\s+property="og:image"\s+content="([^"]+)"', html)
        
        title = title_match.group(1) if title_match else 'Spotify Track'
        desc = desc_match.group(1) if desc_match else ''
        thumbnail = image_match.group(1) if image_match else ''
        
        artist = 'Unknown Artist'
        if desc:
            parts = desc.split(" · ")
            if len(parts) >= 2:
                artist = parts[1]
            elif "by " in desc:
                artist = desc.split("by ")[1].split(" on Spotify")[0].strip()
                
        return {
            'id': track_id,
            'title': title,
            'artist': artist,
            'duration': '3:00',
            'thumbnail': thumbnail,
            'url': url,
            'platform': 'spotify'
        }
    except Exception as e:
        print("Spotify scrape resolve error:", e)
        return None

YOUTUBE_AUDIO_CACHE = {}

def get_youtube_audio_url(video_id, force_refresh=False):
    if not video_id:
        return None
    now = time.time()
    if not force_refresh and video_id in YOUTUBE_AUDIO_CACHE:
        cached_url, exp = YOUTUBE_AUDIO_CACHE[video_id]
        if now < exp:
            return cached_url

    # Candidate cookie paths
    cookie_candidates = [
        os.path.join(DATA_DIR, 'cookies.txt'),
        os.path.join(BUNDLE_DIR, 'cookies.txt'),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cookies.txt')
    ]
    cookie_file = None
    for cand in cookie_candidates:
        if cand and os.path.exists(cand) and os.path.getsize(cand) > 100:
            cookie_file = cand
            break

    # Primary: yt-dlp fast stream extraction
    try:
        import yt_dlp
        ydl_opts = {
            'format': 'bestaudio[ext=m4a]/bestaudio/best',
            'quiet': True,
            'no_warnings': True,
            'skip_download': True,
            'noplaylist': True,
            'extract_flat': False,
            'remote_components': ['ejs:github']
        }
        if cookie_file:
            ydl_opts['cookiefile'] = cookie_file

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f'https://www.youtube.com/watch?v={video_id}', download=False)
            if info and 'url' in info:
                url = info['url']
                YOUTUBE_AUDIO_CACHE[video_id] = (url, now + 3600)
                return url
    except Exception as e:
        print(f"[get_youtube_audio_url yt_dlp error] {e}")

    # Fallback: Android client player payload
    try:
        url = "https://www.youtube.com/youtubei/v1/player"
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "com.google.android.youtube/19.09.37 (Linux; U; Android 14) gzip"
        }
        payload = {
            "context": {
                "client": {
                    "clientName": "ANDROID",
                    "clientVersion": "19.09.37",
                    "androidSdkVersion": 34,
                    "hl": "en",
                    "gl": "US"
                }
            },
            "videoId": video_id
        }
        req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers)
        with urllib.request.urlopen(req, timeout=6) as res:
            data = json.loads(res.read().decode('utf-8'))
        formats = data.get('streamingData', {}).get('adaptiveFormats', [])
        audio_formats = [f for f in formats if f.get('mimeType', '').startswith('audio/')]
        if audio_formats:
            audio_formats.sort(key=lambda x: x.get('bitrate', 0), reverse=True)
            for af in audio_formats:
                if 'url' in af:
                    u = af['url']
                    YOUTUBE_AUDIO_CACHE[video_id] = (u, now + 3600)
                    return u
    except Exception as e:
        print(f"[get_youtube_audio_url fallback error] {e}")

    return None

def scrape_spotify_embed_playlist(playlist_id, limit=100):
    try:
        url = f"https://open.spotify.com/embed/playlist/{playlist_id}"
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as res:
            html = res.read().decode('utf-8')

        m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
        if not m:
            return None

        data = json.loads(m.group(1))
        entity = data.get('props', {}).get('pageProps', {}).get('state', {}).get('data', {}).get('entity', {})
        if not entity:
            return None

        name = entity.get('title') or entity.get('name') or 'Imported Spotify Playlist'
        cover_art = entity.get('coverArt', {}).get('sources', [{}])[0].get('url', '')
        track_list = entity.get('trackList', [])

        tracks = []
        for t in track_list:
            t_id = t.get('uri', '').replace('spotify:track:', '') or t.get('id', '')
            t_title = t.get('title', '')
            t_artist = t.get('subtitle', 'Unknown Artist')
            duration_ms = t.get('duration', 180000)
            preview_url = t.get('audioPreview', {}).get('url') if t.get('audioPreview') else None

            tracks.append({
                'id': t_id,
                'title': t_title,
                'artist': t_artist,
                'duration': format_duration_ms(duration_ms),
                'thumbnail': cover_art or 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=200&auto=format&fit=crop',
                'url': f"https://open.spotify.com/track/{t_id}",
                'platform': 'spotify',
                'previewUrl': preview_url
            })
            if len(tracks) >= limit:
                break

        if tracks:
            return {
                'name': name,
                'tracks': tracks
            }
    except Exception as e:
        print("Spotify embed playlist scrape failed:", e)
    return None

def resolve_spotify_playlist(playlist_id, limit=100):
    config = read_config()
    client_id = config.get('spotifyClientId')
    client_secret = config.get('spotifyClientSecret')
    token = get_spotify_access_token(client_id, client_secret)
    
    if token:
        try:
            url = f"https://api.spotify.com/v1/playlists/{playlist_id}"
            req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
            with urllib.request.urlopen(req) as res:
                playlist_data = json.loads(res.read().decode('utf-8'))
                
            name = playlist_data.get('name', 'Imported Spotify Playlist')
            tracks = []
            
            tracks_obj = playlist_data.get('tracks', {})
            items = tracks_obj.get('items', [])
            next_url = tracks_obj.get('next')
            
            while True:
                for item in items:
                    t = item.get('track')
                    if not t:
                        continue
                    artists = ", ".join([a['name'] for a in t.get('artists', [])])
                    thumbnail = t.get('album', {}).get('images', [{}])[0].get('url', 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=200&auto=format&fit=crop')
                    
                    tracks.append({
                        'id': t.get('id'),
                        'title': t.get('name'),
                        'artist': artists,
                        'duration': format_duration_ms(t.get('duration_ms', 180000)),
                        'thumbnail': thumbnail,
                        'url': t.get('external_urls', {}).get('spotify', ''),
                        'platform': 'spotify',
                        'previewUrl': t.get('preview_url'),
                        'albumId': t.get('album', {}).get('id') if t.get('album') else None,
                        'albumName': t.get('album', {}).get('name') if t.get('album') else None
                    })
                    if len(tracks) >= limit:
                        break
                
                if len(tracks) >= limit or not next_url:
                    break
                    
                try:
                    req_next = urllib.request.Request(next_url, headers={'Authorization': f'Bearer {token}'})
                    with urllib.request.urlopen(req_next) as res_next:
                        next_data = json.loads(res_next.read().decode('utf-8'))
                    items = next_data.get('items', [])
                    next_url = next_data.get('next')
                except Exception:
                    break
                    
            if tracks:
                return {
                    'name': name,
                    'tracks': tracks
                }
        except Exception as e:
            print("Spotify API playlist fetch failed, falling back to embed scrape:", e)

    # Fallback: scrape Spotify playlist via embed without requiring API credentials
    embed_res = scrape_spotify_embed_playlist(playlist_id, limit=limit)
    if embed_res and embed_res.get('tracks'):
        return embed_res

    return None

def resolve_soundcloud_track(url):
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as res:
            html = res.read().decode('utf-8')
            
        title_match = re.search(r'<meta\s+property="og:title"\s+content="([^"]+)"', html)
        artist_match = re.search(r'<meta\s+property="twitter:creator"\s+content="([^"]+)"', html)
        image_match = re.search(r'<meta\s+property="og:image"\s+content="([^"]+)"', html)
        
        title = title_match.group(1) if title_match else 'SoundCloud Track'
        artist = artist_match.group(1) if artist_match else 'SoundCloud Uploader'
        thumbnail = image_match.group(1) if image_match else ''
        
        yt_search_query = f"{title} {artist} soundcloud"
        yt_results = search_youtube(yt_search_query, limit=1)
        
        if yt_results:
            song = yt_results[0]
            song['title'] = title
            song['artist'] = artist
            song['thumbnail'] = thumbnail or song['thumbnail']
            song['platform'] = 'soundcloud'
            song['url'] = url
            song['isFallback'] = True
            return song
        else:
            return {
                'id': url.split('/')[-1],
                'title': title,
                'artist': artist,
                'duration': '3:00',
                'thumbnail': thumbnail,
                'url': url,
                'platform': 'soundcloud',
                'isFallback': True
            }
    except Exception as e:
        print("SoundCloud track resolve error:", e)
        return None

def resolve_soundcloud_playlist(url, limit=100):
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as res:
            html = res.read().decode('utf-8')
            
        name_match = re.search(r'<meta\s+property="og:title"\s+content="([^"]+)"', html)
        playlist_name = name_match.group(1) if name_match else 'SoundCloud Playlist'
        
        # Tracks inside noscript look like: <a href="/username/track-slug">Track Title</a>
        tracks = []
        links = re.findall(r'<a\s+href="\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)">([^<]+)<\/a>', html)
        
        seen_urls = set()
        for artist_slug, track_slug, title in links:
            if artist_slug in ['discover', 'stream', 'upload', 'search', 'terms', 'privacy', 'pages']:
                continue
            if track_slug in ['sets']:
                continue
                
            track_url = f"https://soundcloud.com/{artist_slug}/{track_slug}"
            if track_url in seen_urls:
                continue
            seen_urls.add(track_url)
            
            title = re.sub(r'soundcloud|official audio|remix', '', title, flags=re.I).strip()
            
            tracks.append({
                'id': track_slug,
                'title': title,
                'artist': artist_slug.replace('-', ' ').title(),
                'duration': '3:00',
                'thumbnail': 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=200&auto=format&fit=crop',
                'url': track_url,
                'platform': 'soundcloud',
                'isFallback': True
            })
            if len(tracks) >= limit:
                break
            
        return {
            'name': playlist_name,
            'tracks': tracks
        }
    except Exception as e:
        print("SoundCloud playlist resolve error:", e)
        return None

# --- OFFLINE ENGINE HELPERS ---

def read_offline_index():
    if os.path.exists(OFFLINE_INDEX_FILE):
        try:
            with open(OFFLINE_INDEX_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if not isinstance(data, dict):
                    data = {}
                if 'settings' not in data:
                    data['settings'] = {'smartCacheEnabled': False, 'smartCacheLimit': 200}
                if 'tracks' not in data:
                    data['tracks'] = {}
                return data
        except Exception as e:
            print("Failed to read offline index:", e)
    return {
        'settings': {'smartCacheEnabled': False, 'smartCacheLimit': 200},
        'tracks': {}
    }

def write_offline_index(data):
    try:
        temp_file = OFFLINE_INDEX_FILE + '.tmp'
        with open(temp_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        if os.path.exists(OFFLINE_INDEX_FILE):
            os.replace(temp_file, OFFLINE_INDEX_FILE)
        else:
            os.rename(temp_file, OFFLINE_INDEX_FILE)
    except Exception as e:
        print("Failed to write offline index:", e)

def evict_lru_cache(index_data):
    settings = index_data.get('settings', {})
    limit = int(settings.get('smartCacheLimit', 200))
    tracks = index_data.get('tracks', {})
    
    cached_items = [(k, v) for k, v in tracks.items() if v.get('isCache', False)]
    if len(cached_items) > limit:
        cached_items.sort(key=lambda item: item[1].get('lastPlayedAt', 0))
        num_to_remove = len(cached_items) - limit
        for i in range(num_to_remove):
            song_id, track_info = cached_items[i]
            filepath = track_info.get('filepath')
            if filepath and os.path.exists(filepath):
                try:
                    os.remove(filepath)
                except Exception as err:
                    print(f"Error removing cached file {filepath}:", err)
            if song_id in tracks:
                del tracks[song_id]

def get_offline_stats():
    index = read_offline_index()
    tracks = index.get('tracks', {})
    total_bytes = 0
    cache_bytes = 0
    perm_bytes = 0
    cache_count = 0
    perm_count = 0
    
    to_delete = []
    for sid, t in tracks.items():
        fp = t.get('filepath')
        if fp and os.path.exists(fp):
            try:
                size = os.path.getsize(fp)
                t['size'] = size
                total_bytes += size
                if t.get('isCache', False):
                    cache_bytes += size
                    cache_count += 1
                else:
                    perm_bytes += size
                    perm_count += 1
            except Exception:
                pass
        else:
            to_delete.append(sid)
            
    if to_delete:
        for sid in to_delete:
            del tracks[sid]
        write_offline_index(index)
        
    return {
        'totalBytes': total_bytes,
        'cacheBytes': cache_bytes,
        'permanentBytes': perm_bytes,
        'cacheCount': cache_count,
        'permanentCount': perm_count,
        'totalCount': len(tracks),
        'settings': index.get('settings', {'smartCacheEnabled': False, 'smartCacheLimit': 200})
    }

def download_track_offline(song_data, is_cache=False):
    import yt_dlp
    import time
    
    song_id = song_data.get('id')
    if not song_id:
        return {'success': False, 'error': 'Track ID is required'}

    index = read_offline_index()
    existing = index.get('tracks', {}).get(song_id)

    # Check if already downloaded on disk
    if existing and existing.get('filepath') and os.path.exists(existing['filepath']):
        if existing.get('isCache', False) and not is_cache:
            existing['isCache'] = False
        existing['lastPlayedAt'] = int(time.time())
        write_offline_index(index)
        return {'success': True, 'track': existing, 'alreadyDownloaded': True}

    target_url = None
    platform = song_data.get('platform', 'youtube')
    url = song_data.get('url', '')

    if platform == 'youtube' and song_id:
        target_url = f"https://www.youtube.com/watch?v={song_id}"
    elif url and 'soundcloud.com' in url:
        title = song_data.get('title', '')
        artist = song_data.get('artist', '')
        yt_match = search_youtube(f"{title} {artist}", limit=1)
        if yt_match and yt_match[0].get('id'):
            target_url = f"https://www.youtube.com/watch?v={yt_match[0]['id']}"
        else:
            target_url = url
    else:
        title = song_data.get('title', '')
        artist = song_data.get('artist', '')
        yt_match = search_youtube(f"{title} {artist}", limit=1)
        if yt_match and yt_match[0].get('id'):
            target_url = f"https://www.youtube.com/watch?v={yt_match[0]['id']}"
        else:
            target_url = f"ytsearch1:{title} {artist}"

    safe_id = re.sub(r'[^a-zA-Z0-9_-]', '_', str(song_id))
    outtmpl = os.path.join(DOWNLOADS_DIR, f"{safe_id}.%(ext)s")

    cookie_candidates = [
        os.path.join(DATA_DIR, 'cookies.txt'),
        os.path.join(BUNDLE_DIR, 'cookies.txt'),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cookies.txt')
    ]
    cookie_file = None
    for cand in cookie_candidates:
        if cand and os.path.exists(cand) and os.path.getsize(cand) > 100:
            cookie_file = cand
            break

    ydl_opts = {
        'format': 'ba/b',
        'outtmpl': outtmpl,
        'quiet': True,
        'no_warnings': True,
        'noplaylist': True,
        'remote_components': ['ejs:github']
    }
    if cookie_file:
        ydl_opts['cookiefile'] = cookie_file

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(target_url, download=True)
            if isinstance(info, dict) and 'entries' in info and info['entries']:
                info = info['entries'][0]
            
            ext = info.get('ext', 'mp4') if isinstance(info, dict) else 'mp4'
            actual_filename = f"{safe_id}.{ext}"
            actual_filepath = os.path.join(DOWNLOADS_DIR, actual_filename)
            
            if not os.path.exists(actual_filepath):
                import glob
                matches = glob.glob(os.path.join(DOWNLOADS_DIR, f"{safe_id}.*"))
                matches = [m for m in matches if not m.endswith('.json') and not m.endswith('.tmp')]
                if matches:
                    actual_filepath = matches[0]
                    actual_filename = os.path.basename(actual_filepath)
                else:
                    return {'success': False, 'error': 'Downloaded file not found on disk'}

            file_size = os.path.getsize(actual_filepath)
            now = int(time.time())

            track_record = {
                'id': song_id,
                'title': song_data.get('title') or (info.get('title') if isinstance(info, dict) else 'Unknown Track'),
                'artist': song_data.get('artist') or (info.get('uploader') or info.get('channel') if isinstance(info, dict) else 'Unknown Artist'),
                'duration': song_data.get('duration') or (format_duration_ms(info.get('duration', 180) * 1000) if isinstance(info, dict) else '3:00'),
                'thumbnail': song_data.get('thumbnail') or (info.get('thumbnail') if isinstance(info, dict) else ''),
                'platform': platform,
                'url': url or target_url,
                'filename': actual_filename,
                'filepath': actual_filepath,
                'size': file_size,
                'isCache': bool(is_cache),
                'downloadedAt': now,
                'lastPlayedAt': now
            }

            index['tracks'][song_id] = track_record
            if is_cache:
                evict_lru_cache(index)
            write_offline_index(index)

            return {'success': True, 'track': track_record}
    except Exception as e:
        print(f"Error downloading track {song_id}:", e)
        return {'success': False, 'error': str(e)}

def delete_offline_track(song_id):
    index = read_offline_index()
    song_id = str(song_id)
    tracks = index.get('tracks', {})
    found_key = None
    if song_id in tracks:
        found_key = song_id
    else:
        for k in tracks:
            if str(k) == song_id:
                found_key = k
                break
    if found_key:
        track_info = tracks[found_key]
        filepath = track_info.get('filepath')
        if filepath and os.path.exists(filepath):
            try:
                os.remove(filepath)
            except Exception as e:
                print(f"Error deleting file {filepath}:", e)
        # Also clean up any possible leftover files with safe_id
        safe_id = re.sub(r'[^a-zA-Z0-9_-]', '_', song_id)
        import glob
        for extra in glob.glob(os.path.join(DOWNLOADS_DIR, f"{safe_id}.*")):
            if not extra.endswith('.json'):
                try:
                    os.remove(extra)
                except Exception:
                    pass
        del tracks[found_key]
        write_offline_index(index)
        return True
    return False

def clear_offline_storage(clear_type='cache'):
    index = read_offline_index()
    tracks = index.get('tracks', {})
    to_delete = []
    
    for sid, t in list(tracks.items()):
        is_cache = t.get('isCache', False)
        if clear_type == 'all' or (clear_type == 'cache' and is_cache) or (clear_type == 'permanent' and not is_cache):
            fp = t.get('filepath')
            if fp and os.path.exists(fp):
                try:
                    os.remove(fp)
                except Exception as e:
                    print(f"Error deleting file {fp}:", e)
            safe_id = re.sub(r'[^a-zA-Z0-9_-]', '_', str(sid))
            import glob
            for extra in glob.glob(os.path.join(DOWNLOADS_DIR, f"{safe_id}.*")):
                if not extra.endswith('.json'):
                    try:
                        os.remove(extra)
                    except Exception:
                        pass
            to_delete.append(sid)
            
    for sid in to_delete:
        if sid in tracks:
            del tracks[sid]

    # If all, clean up any stray media files in DOWNLOADS_DIR
    if clear_type == 'all':
        import glob
        for extra in glob.glob(os.path.join(DOWNLOADS_DIR, "*")):
            if os.path.isfile(extra) and not extra.endswith('.json'):
                try:
                    os.remove(extra)
                except Exception:
                    pass
        
    write_offline_index(index)
    return len(to_delete)

# HTTP Request Handler Class
class AetherPlayerHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Serve static files from 'public' folder directly
        root = PUBLIC_DIR
        # Remove query parameters if present
        parsed_path = urllib.parse.urlparse(path).path
        return os.path.join(root, *parsed_path.split('/'))

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, HEAD')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')
        self.end_headers()

    def do_HEAD(self):
        url_parsed = urllib.parse.urlparse(self.path)
        path = url_parsed.path
        if path == '/api/stream/proxy':
            query_params = urllib.parse.parse_qs(url_parsed.query)
            video_id = query_params.get('id', [''])[0].strip()
            audio_url = get_youtube_audio_url(video_id)
            if audio_url:
                self.send_response(200)
                self.send_header('Content-Type', 'audio/mp4')
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                return
        super().do_HEAD()

    def do_GET(self):
        url_parsed = urllib.parse.urlparse(self.path)
        query_params = urllib.parse.parse_qs(url_parsed.query)
        path = url_parsed.path

        # Intercept and serve uploaded assets manually (safeguards writeable directory paths on Android)
        if path.startswith('/uploads/'):
            filename = os.path.basename(path.split('/uploads/', 1)[1])
            filepath = os.path.join(UPLOADS_DIR, filename)
            if os.path.exists(filepath):
                self.send_response(200)
                self.send_header('Access-Control-Allow-Origin', '*')
                if filepath.lower().endswith('.png'):
                    self.send_header('Content-Type', 'image/png')
                elif filepath.lower().endswith(('.jpg', '.jpeg')):
                    self.send_header('Content-Type', 'image/jpeg')
                else:
                    self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', os.path.getsize(filepath))
                self.end_headers()
                with open(filepath, 'rb') as f:
                    self.wfile.write(f.read())
            else:
                self.send_error(404, "File not found")
            return

        # Offline Audio Streaming & Tracks Management
        if path == '/api/offline/tracks':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            stats = get_offline_stats()
            index = read_offline_index()
            track_list = list(index.get('tracks', {}).values())
            track_list.sort(key=lambda t: t.get('lastPlayedAt', 0), reverse=True)
            res = {
                'tracks': track_list,
                'stats': stats,
                'settings': stats.get('settings', {'smartCacheEnabled': False, 'smartCacheLimit': 200})
            }
            self.wfile.write(json.dumps(res, ensure_ascii=False).encode('utf-8'))
            return

        elif path == '/api/offline/audio' or path == '/api/offline/stream':
            song_id = query_params.get('id', [''])[0].strip()
            if not song_id:
                self.send_error(400, "Track ID required")
                return

            index = read_offline_index()
            track_info = index.get('tracks', {}).get(song_id)
            if not track_info or not track_info.get('filepath') or not os.path.exists(track_info['filepath']):
                safe_id = re.sub(r'[^a-zA-Z0-9_-]', '_', str(song_id))
                import glob
                matches = glob.glob(os.path.join(DOWNLOADS_DIR, f"{safe_id}.*"))
                matches = [m for m in matches if not m.endswith('.json') and not m.endswith('.tmp')]
                if matches and os.path.exists(matches[0]):
                    filepath = matches[0]
                else:
                    self.send_error(404, "Offline audio file not found")
                    return
            else:
                filepath = track_info['filepath']

            import time
            if track_info:
                track_info['lastPlayedAt'] = int(time.time())
                write_offline_index(index)

            ext = os.path.splitext(filepath)[1].lower()
            if ext in ('.mp4', '.m4a'):
                content_type = 'audio/mp4'
            elif ext == '.webm':
                content_type = 'audio/webm'
            elif ext == '.mp3':
                content_type = 'audio/mpeg'
            elif ext == '.ogg':
                content_type = 'audio/ogg'
            elif ext == '.opus':
                content_type = 'audio/opus'
            else:
                content_type = 'application/octet-stream'

            file_size = os.path.getsize(filepath)
            range_header = self.headers.get('Range')

            if range_header:
                range_match = re.match(r'bytes=(\d+)-(\d*)', range_header)
                if range_match:
                    start = int(range_match.group(1))
                    end = int(range_match.group(2)) if range_match.group(2) else file_size - 1
                    end = min(end, file_size - 1)
                    length = end - start + 1

                    self.send_response(206)
                    self.send_header('Content-Type', content_type)
                    self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
                    self.send_header('Content-Length', str(length))
                    self.send_header('Accept-Ranges', 'bytes')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()

                    with open(filepath, 'rb') as f:
                        f.seek(start)
                        chunk_size = 65536
                        remaining = length
                        while remaining > 0:
                            to_read = min(remaining, chunk_size)
                            chunk = f.read(to_read)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            remaining -= len(chunk)
                    return

            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(file_size))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()

            with open(filepath, 'rb') as f:
                chunk_size = 65536
                while True:
                    chunk = f.read(chunk_size)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            return

        # API Endpoints
        elif path == '/api/settings':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            config = read_config()
            # Send config with all settings included
            res = {
                'spotifyClientId': config.get('spotifyClientId', ''),
                'spotifyClientSecret': config.get('spotifyClientSecret', ''),
                'username': config.get('username', 'Music Enthusiast'),
                'avatar': config.get('avatar', 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?q=80&w=200&auto=format&fit=crop'),
                'currentTheme': config.get('currentTheme', None),
                'customThemes': config.get('customThemes', [])
            }
            self.wfile.write(json.dumps(res).encode('utf-8'))
            return
            
        elif path == '/api/backup':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            if os.path.exists(BACKUP_FILE):
                try:
                    with open(BACKUP_FILE, 'r', encoding='utf-8') as f:
                        self.wfile.write(f.read().encode('utf-8'))
                except Exception:
                    self.wfile.write(b'[]')
            else:
                self.wfile.write(b'[]')
            return

        elif path == '/api/ping':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(b'{"status": "ok", "app": "AetherPlayer"}')
            return

        elif path == '/api/lyrics':
            title = query_params.get('title', [''])[0].strip()
            artist = query_params.get('artist', [''])[0].strip()

            if not title:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error": "Title required"}')
                return

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()

            # Clean noisy YouTube/platform metadata into clean artist and track title
            clean_title, clean_artist = clean_track_metadata_for_lyrics(title, artist)

            # 1. Check in-memory cache first
            cached = get_cached_lyrics(clean_title, clean_artist)
            if cached:
                self.wfile.write(json.dumps(cached).encode('utf-8'))
                return

            import time
            global LYRICS_RATE_LIMIT_COOLDOWN
            now = time.time()
            if now < LYRICS_RATE_LIMIT_COOLDOWN:
                # Still in cooldown period from previous 429
                self.wfile.write(b'{"error": "Lyrics service is temporarily busy. Will retry shortly...", "isRateLimited": true}')
                return

            lrclib_headers = {
                'User-Agent': 'AetherPlayer/1.0 (https://github.com/ssprata/Multi-music-tool; contact: desktop-app)'
            }

            try:
                # 2. Try exact matching using LrcLib API /api/get
                get_url = f"https://lrclib.net/api/get?track_name={urllib.parse.quote(clean_title)}"
                if clean_artist:
                    get_url += f"&artist_name={urllib.parse.quote(clean_artist)}"
                
                req = urllib.request.Request(get_url, headers=lrclib_headers)
                try:
                    with urllib.request.urlopen(req, timeout=5) as res:
                        data = json.loads(res.read().decode('utf-8'))
                        result = {
                            'synced': bool(data.get('syncedLyrics')),
                            'lyrics': data.get('plainLyrics', ''),
                            'syncedLyrics': data.get('syncedLyrics', '')
                        }
                        set_cached_lyrics(clean_title, clean_artist, result)
                        self.wfile.write(json.dumps(result).encode('utf-8'))
                        return
                except urllib.error.HTTPError as he:
                    if he.code == 429:
                        LYRICS_RATE_LIMIT_COOLDOWN = time.time() + 45
                        self.wfile.write(b'{"error": "Lyrics service is busy right now. Will retry shortly...", "isRateLimited": true}')
                        return
                    elif he.code != 404:
                        raise he

                # 3. Try search/fuzzy matching if exact match was 404
                search_query = f"{clean_title} {clean_artist}".strip()
                search_url = f"https://lrclib.net/api/search?q={urllib.parse.quote(search_query)}"
                req_search = urllib.request.Request(search_url, headers=lrclib_headers)
                try:
                    with urllib.request.urlopen(req_search, timeout=6) as res_search:
                        search_results = json.loads(res_search.read().decode('utf-8'))
                        if search_results and len(search_results) > 0:
                            best_match = search_results[0]
                            result = {
                                'synced': bool(best_match.get('syncedLyrics')),
                                'lyrics': best_match.get('plainLyrics', ''),
                                'syncedLyrics': best_match.get('syncedLyrics', '')
                            }
                            set_cached_lyrics(clean_title, clean_artist, result)
                            self.wfile.write(json.dumps(result).encode('utf-8'))
                            return
                except urllib.error.HTTPError as he:
                    if he.code == 429:
                        LYRICS_RATE_LIMIT_COOLDOWN = time.time() + 45
                        self.wfile.write(b'{"error": "Lyrics service is busy right now. Will retry shortly...", "isRateLimited": true}')
                        return

                self.wfile.write(b'{"error": "No lyrics found for this song."}')
            except Exception as err:
                print("Lyrics search error:", err)
                if "429" in str(err):
                    LYRICS_RATE_LIMIT_COOLDOWN = time.time() + 45
                    self.wfile.write(b'{"error": "Lyrics service is busy right now. Will retry shortly...", "isRateLimited": true}')
                else:
                    self.wfile.write(b'{"error": "Could not retrieve lyrics."}')
            return


        elif path == '/api/recommendations':
            title = query_params.get('title', [''])[0].strip()
            artist = query_params.get('artist', [''])[0].strip()
            platform = query_params.get('platform', [''])[0].strip()
            track_id = query_params.get('track_id', [''])[0].strip()
            try:
                limit_val = int(query_params.get('limit', ['15'])[0])
            except ValueError:
                limit_val = 15
            exclude_ids = query_params.get('exclude_ids', [''])[0].strip()
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            recommendations = []
            
            # Try Spotify Recommendations API only if playing platform is Spotify
            if platform == 'spotify':
                config = read_config()
                client_id = config.get('spotifyClientId')
                client_secret = config.get('spotifyClientSecret')
                if client_id and client_secret:
                    try:
                        token = get_spotify_access_token(client_id, client_secret)
                        if token:
                            seed_id = track_id
                            # If seed track is not a valid 22-character Spotify ID (e.g. it is a YouTube fallback ID), search Spotify first to get seed id
                            if not seed_id or not (len(seed_id) == 22 and seed_id.isalnum()):
                                search_url = f"https://api.spotify.com/v1/search?q={urllib.parse.quote(title + ' ' + artist)}&type=track&limit=1"
                                req = urllib.request.Request(search_url, headers={'Authorization': f'Bearer {token}'})
                                with urllib.request.urlopen(req) as res:
                                    search_data = json.loads(res.read().decode('utf-8'))
                                    tracks = search_data.get('tracks', {}).get('items', [])
                                    if tracks:
                                        seed_id = tracks[0].get('id')
                            
                            if seed_id and len(seed_id) == 22 and seed_id.isalnum():
                                recommend_url = f"https://api.spotify.com/v1/recommendations?seed_tracks={seed_id}&limit=20"
                                req = urllib.request.Request(recommend_url, headers={'Authorization': f'Bearer {token}'})
                                with urllib.request.urlopen(req) as res:
                                    recommend_data = json.loads(res.read().decode('utf-8'))
                                    for track in recommend_data.get('tracks', []):
                                        t_name = track.get('name', '')
                                        t_id = track.get('id', '')
                                        if exclude_ids and t_id in exclude_ids:
                                            continue
                                        if is_vibe_polluted(t_name, seed_title=title, seed_artist=artist):
                                            continue
                                        artists = [a.get('name') for a in track.get('artists', [])]
                                        artist_str = ", ".join(artists) if artists else 'Unknown Artist'
                                        duration_ms = track.get('duration_ms', 0)
                                        images = track.get('album', {}).get('images', [])
                                        thumbnail = images[0].get('url') if images else ''
                                        
                                        recommendations.append({
                                            'id': t_id,
                                            'title': t_name,
                                            'artist': artist_str,
                                            'duration': format_duration_ms(duration_ms),
                                            'thumbnail': thumbnail,
                                            'url': f"https://open.spotify.com/track/{track.get('id')}",
                                            'platform': 'spotify'
                                        })
                                        if len(recommendations) >= limit_val:
                                            break
                    except Exception as e:
                        print("Spotify recommendations failed:", e)
                    
            # Fallback for Spotify failures, or default for YouTube/SoundCloud
            if not recommendations:
                try:
                    target_video_id = None
                    if track_id and len(track_id) == 11:
                        target_video_id = track_id
                    
                    if not target_video_id and (title or artist):
                        search_results = search_youtube(f"{title} {artist}", limit=1)
                        if search_results:
                            target_video_id = search_results[0].get('id')
                            
                    if target_video_id:
                        recommendations = get_related_tracks(target_video_id, platform=platform, seed_title=title, seed_artist=artist, limit=limit_val, exclude_ids=exclude_ids)
                except Exception as e:
                    print("YouTube Music related vibe recommendations failed:", e)
                    
            self.wfile.write(json.dumps(recommendations).encode('utf-8'))
            return

        elif path == '/api/resolve-link':
            url = query_params.get('url', [''])[0].strip()
            if not url:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error": "URL required"}')
                return
            
            limit_val = 100
            if 'limit' in query_params:
                try:
                    limit_val = int(query_params.get('limit')[0])
                    if limit_val <= 0:
                        limit_val = 100
                    if limit_val > 300:
                        limit_val = 300
                except (ValueError, TypeError):
                    limit_val = 100

            # Resolve redirects first (e.g. mobile soundcloud or youtu.be links)
            if 'on.soundcloud.com' in url or 'youtu.be' in url:
                url = resolve_redirect(url)
                
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            # 1. Spotify Track Link
            if SPOTIFY_TRACK_RE.search(url):
                track_id = SPOTIFY_TRACK_RE.search(url).group(1)
                res_track = resolve_spotify_track(track_id)
                if res_track:
                    self.wfile.write(json.dumps({'type': 'track', 'song': res_track}).encode('utf-8'))
                else:
                    self.wfile.write(b'{"error": "Failed to resolve Spotify track"}')
                return
                
            # 2. Spotify Playlist Link
            elif SPOTIFY_PLAYLIST_RE.search(url):
                playlist_id = SPOTIFY_PLAYLIST_RE.search(url).group(1)
                res_playlist = resolve_spotify_playlist(playlist_id, limit=limit_val)
                if res_playlist:
                    self.wfile.write(json.dumps({
                        'type': 'playlist', 
                        'name': res_playlist['name'], 
                        'songs': res_playlist['tracks'], 
                        'error': res_playlist.get('error')
                    }).encode('utf-8'))
                else:
                    self.wfile.write(b'{"error": "Failed to resolve Spotify playlist"}')
                return
                
            # 3. YouTube Playlist / Mix Link
            elif 'list=' in url or YOUTUBE_PLAYLIST_RE.search(url):
                playlist_match = YOUTUBE_PLAYLIST_RE.search(url)
                playlist_id = playlist_match.group(1) if playlist_match else None
                if not playlist_id:
                    parsed_qs = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
                    playlist_id = parsed_qs.get('list', [None])[0]
                    
                video_id = None
                v_match = YOUTUBE_VIDEO_RE.search(url)
                if v_match:
                    video_id = v_match.group(1)
                else:
                    parsed_qs = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
                    video_id = parsed_qs.get('v', [None])[0]

                if playlist_id:
                    res_playlist = resolve_youtube_playlist(playlist_id, video_id=video_id, limit=limit_val)
                    if res_playlist and res_playlist.get('tracks'):
                        self.wfile.write(json.dumps({
                            'type': 'playlist', 
                            'name': res_playlist['name'], 
                            'songs': res_playlist['tracks']
                        }).encode('utf-8'))
                    else:
                        self.wfile.write(b'{"error": "Failed to resolve YouTube playlist/mix"}')
                else:
                    self.wfile.write(b'{"error": "Invalid YouTube playlist ID"}')
                return
                
            # 4. YouTube Video Link
            elif YOUTUBE_VIDEO_RE.search(url):
                video_id = YOUTUBE_VIDEO_RE.search(url).group(1)
                allow_mix = query_params.get('allow_mix', ['0'])[0] in ('1', 'true', 'True')
                if allow_mix:
                    res_mix = resolve_youtube_mix(playlist_id=None, video_id=video_id, limit=limit_val)
                    if res_mix and res_mix.get('tracks'):
                        self.wfile.write(json.dumps({
                            'type': 'playlist', 
                            'name': res_mix['name'], 
                            'songs': res_mix['tracks']
                        }).encode('utf-8'))
                        return

                res_track = resolve_youtube_video(video_id)
                if res_track:
                    self.wfile.write(json.dumps({'type': 'track', 'song': res_track, 'can_mix': True}).encode('utf-8'))
                else:
                    self.wfile.write(b'{"error": "Failed to resolve YouTube video"}')
                return
                
            # 5. SoundCloud Playlist Link
            elif SOUNDCLOUD_PLAYLIST_RE.search(url):
                res_playlist = resolve_soundcloud_playlist(url, limit=limit_val)
                if res_playlist:
                    self.wfile.write(json.dumps({
                        'type': 'playlist', 
                        'name': res_playlist['name'], 
                        'songs': res_playlist['tracks']
                    }).encode('utf-8'))
                else:
                    self.wfile.write(b'{"error": "Failed to resolve SoundCloud playlist"}')
                return
                
            # 6. SoundCloud Track Link
            elif SOUNDCLOUD_TRACK_RE.search(url):
                res_track = resolve_soundcloud_track(url)
                if res_track:
                    self.wfile.write(json.dumps({'type': 'track', 'song': res_track}).encode('utf-8'))
                else:
                    self.wfile.write(b'{"error": "Failed to resolve SoundCloud track"}')
                return
                
            else:
                self.wfile.write(b'{"error": "Unsupported URL format. Please paste a valid YouTube, Spotify, or SoundCloud track/playlist link."}')
                return

        elif path == '/api/search':
            q = query_params.get('q', [''])[0]
            platform_str = query_params.get('platform', ['youtube,spotify,soundcloud'])[0]
            search_type = query_params.get('type', ['track'])[0]
            platforms = platform_str.split(',')

            if not q:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error": "Query required"}')
                return

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()

            if search_type == 'track':
                results = []
                
                # YouTube search
                if 'youtube' in platforms:
                    results.extend(search_youtube(q))
                    
                # Spotify search
                if 'spotify' in platforms:
                    results.extend(search_spotify(q))

                # SoundCloud proxy search
                if 'soundcloud' in platforms:
                    sc_results = search_youtube(q + ' soundcloud', limit=15)
                    for song in sc_results:
                        song['platform'] = 'soundcloud'
                        song['isFallback'] = True
                        song['title'] = re.sub(r'soundcloud|official audio|remix', '', song['title'], flags=re.I).strip()
                    results.extend(sc_results)

                self.wfile.write(json.dumps(results).encode('utf-8'))
                return
                
            elif search_type == 'all':
                tracks = []
                albums = []
                artists = []
                
                # Spotify search
                if 'spotify' in platforms:
                    config = read_config()
                    client_id = config.get('spotifyClientId')
                    client_secret = config.get('spotifyClientSecret')
                    token = get_spotify_access_token(client_id, client_secret)
                    
                    if token:
                        try:
                            url = f"https://api.spotify.com/v1/search?q={urllib.parse.quote(q)}&type=track,album,artist&limit=15"
                            req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
                            with urllib.request.urlopen(req) as res:
                                data = json.loads(res.read().decode('utf-8'))
                                
                            for t in data.get('tracks', {}).get('items', []):
                                artists_str = ", ".join([a['name'] for a in t['artists']])
                                thumbnail = t['album']['images'][0]['url'] if t['album']['images'] else ''
                                tracks.append({
                                    'id': t['id'],
                                    'title': t['name'],
                                    'artist': artists_str,
                                    'duration': format_duration_ms(t['duration_ms']),
                                    'thumbnail': thumbnail,
                                    'url': t['external_urls']['spotify'],
                                    'platform': 'spotify',
                                    'previewUrl': t.get('preview_url'),
                                    'albumId': t.get('album', {}).get('id'),
                                    'albumName': t.get('album', {}).get('name')
                                })
                                
                            for al in data.get('albums', {}).get('items', []):
                                al_artists = ", ".join([a['name'] for a in al['artists']])
                                al_thumb = al['images'][0]['url'] if al['images'] else ''
                                albums.append({
                                    'id': al['id'],
                                    'title': al['name'],
                                    'artist': al_artists,
                                    'thumbnail': al_thumb,
                                    'url': al['external_urls']['spotify'],
                                    'platform': 'spotify',
                                    'year': al.get('release_date', '')[:4],
                                    'type': 'album'
                                })
                                
                            for art in data.get('artists', {}).get('items', []):
                                art_thumb = art['images'][0]['url'] if art['images'] else ''
                                artists.append({
                                    'id': art['id'],
                                    'title': art['name'],
                                    'thumbnail': art_thumb,
                                    'url': art['external_urls']['spotify'],
                                    'platform': 'spotify',
                                    'type': 'artist'
                                })
                        except Exception as e:
                            print("Spotify type=all search failed:", e)
                    else:
                        # Fallback for Spotify when credentials not set - fallback to YouTube Music
                        try:
                            yt_tracks = search_youtube(q + ' spotify', limit=15)
                            for song in yt_tracks:
                                song['platform'] = 'spotify'
                                song['isFallback'] = True
                                song['title'] = re.sub(r'spotify|official video|lyric video|audio', '', song['title'], flags=re.I).strip()
                                tracks.append(song)
                            
                            yt_albums = ytmusic.search(q, filter="albums", limit=10)
                            for al in yt_albums:
                                al_artists = ", ".join([a['name'] for a in al.get('artists', [])])
                                al_thumb = al.get('thumbnails', [{}])[-1].get('url', '') if al.get('thumbnails') else ''
                                albums.append({
                                    'id': al.get('browseId'),
                                    'title': al.get('title'),
                                    'artist': al_artists,
                                    'thumbnail': al_thumb,
                                    'url': f"https://music.youtube.com/browse/{al.get('browseId')}",
                                    'platform': 'spotify',
                                    'year': al.get('year', ''),
                                    'type': 'album',
                                    'isFallback': True
                                })
                                
                            yt_artists = ytmusic.search(q, filter="artists", limit=10)
                            for art in yt_artists:
                                art_thumb = art.get('thumbnails', [{}])[-1].get('url', '') if art.get('thumbnails') else ''
                                artists.append({
                                    'id': art.get('browseId'),
                                    'title': art.get('artist'),
                                    'thumbnail': art_thumb,
                                    'url': f"https://music.youtube.com/channel/{art.get('browseId')}",
                                    'platform': 'spotify',
                                    'type': 'artist',
                                    'isFallback': True
                                })
                        except Exception as e:
                            print("Spotify fallback type=all search failed:", e)

                # YouTube Music
                if 'youtube' in platforms:
                    try:
                        yt_tracks = search_youtube(q, limit=15)
                        tracks.extend(yt_tracks)
                        
                        yt_albums = ytmusic.search(q, filter="albums", limit=10)
                        for al in yt_albums:
                            al_artists = ", ".join([a['name'] for a in al.get('artists', [])])
                            al_thumb = al.get('thumbnails', [{}])[-1].get('url', '') if al.get('thumbnails') else ''
                            albums.append({
                                'id': al.get('browseId'),
                                'title': al.get('title'),
                                'artist': al_artists,
                                'thumbnail': al_thumb,
                                'url': f"https://music.youtube.com/browse/{al.get('browseId')}",
                                'platform': 'youtube',
                                'year': al.get('year', ''),
                                'type': 'album'
                            })
                            
                        yt_artists = ytmusic.search(q, filter="artists", limit=10)
                        for art in yt_artists:
                            art_thumb = art.get('thumbnails', [{}])[-1].get('url', '') if art.get('thumbnails') else ''
                            artists.append({
                                'id': art.get('browseId'),
                                'title': art.get('artist'),
                                'thumbnail': art_thumb,
                                'url': f"https://music.youtube.com/channel/{art.get('browseId')}",
                                'platform': 'youtube',
                                'type': 'artist'
                            })
                    except Exception as e:
                        print("YouTube Music type=all search failed:", e)

                # SoundCloud
                if 'soundcloud' in platforms:
                    try:
                        sc_results = search_youtube(q + ' soundcloud', limit=15)
                        for song in sc_results:
                            song['platform'] = 'soundcloud'
                            song['isFallback'] = True
                            song['title'] = re.sub(r'soundcloud|official audio|remix', '', song['title'], flags=re.I).strip()
                            tracks.append(song)
                    except Exception as e:
                        print("SoundCloud fallback search failed:", e)
                        
                res_payload = {
                    'tracks': tracks,
                    'albums': albums,
                    'artists': artists
                }
                self.wfile.write(json.dumps(res_payload).encode('utf-8'))
                return

        elif path == '/api/history':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            history = read_history()
            self.wfile.write(json.dumps(history).encode('utf-8'))
            return

        elif path == '/api/most-listened-week':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            top_tracks = get_most_listened_this_week()
            self.wfile.write(json.dumps(top_tracks).encode('utf-8'))
            return

        elif path == '/api/queue-session':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            session = read_queue_session()
            self.wfile.write(json.dumps(session or {}).encode('utf-8'))
            return

        elif path == '/api/dashboard-recommendations':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            history = read_history()
            tracks = []
            
            # Get Spotify token if credentials exist
            config = read_config()
            client_id = config.get('spotifyClientId')
            token = get_spotify_access_token(client_id, client_secret)
            
            # Extract recently played tracks/artists
            recent_spotify_tracks = [t for t in history if t.get('platform') == 'spotify'][:3]
            recent_yt_tracks = [t for t in history if t.get('platform') == 'youtube'][:3]
            recent_artists = list(set([t.get('artist') for t in history if t.get('artist')]))[:3]
            
            print(f"Recommendations request: recent_spotify={len(recent_spotify_tracks)}, recent_yt={len(recent_yt_tracks)}, token={token is not None}")
            
            if token and recent_spotify_tracks:
                try:
                    seed_tracks = ",".join([t['id'] for t in recent_spotify_tracks])
                    url = f"https://api.spotify.com/v1/recommendations?seed_tracks={seed_tracks}&limit=20"
                    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
                    with urllib.request.urlopen(req) as res:
                        rec_data = json.loads(res.read().decode('utf-8'))
                    for t in rec_data.get('tracks', []):
                        artists_str = ", ".join([a['name'] for a in t['artists']])
                        thumbnail = t['album']['images'][0]['url'] if t['album']['images'] else ''
                        tracks.append({
                            'id': t['id'],
                            'title': t['name'],
                            'artist': artists_str,
                            'duration': format_duration_ms(t['duration_ms']),
                            'thumbnail': thumbnail,
                            'url': t['external_urls']['spotify'],
                            'platform': 'spotify',
                            'previewUrl': t.get('preview_url'),
                            'albumId': t['album']['id'],
                            'albumName': t['album']['name']
                        })
                except Exception as e:
                    print("Spotify recommendations failed, falling back:", e)
            
            if not tracks and recent_yt_tracks:
                print("Running YouTube Music recommendations for:", recent_yt_tracks[0]['id'])
                try:
                    recent_vid = recent_yt_tracks[0]['id']
                    recent_title = recent_yt_tracks[0].get('title', '')
                    recent_artist = recent_yt_tracks[0].get('artist', '')
                    watch_list = ytmusic.get_watch_playlist(videoId=recent_vid, radio=True, limit=25)
                    print("Watch playlist returned tracks count:", len(watch_list.get('tracks', [])))
                    for t in watch_list.get('tracks', []):
                        if t.get('videoId') == recent_vid:
                            continue
                        t_title = t.get('title', 'Unknown Track')
                        if is_vibe_polluted(t_title, seed_title=recent_title, seed_artist=recent_artist):
                            continue
                        t_thumb = ''
                        t_thumbs = t.get('thumbnail', [])
                        if isinstance(t_thumbs, list) and t_thumbs:
                            t_thumb = t_thumbs[-1].get('url', '')
                        elif isinstance(t_thumbs, dict):
                            t_thumb = t_thumbs.get('url', '')
                            
                        t_artists = t.get('artists', [])
                        t_artist = ", ".join([a['name'] for a in t_artists]) if isinstance(t_artists, list) else t.get('author', 'Unknown')
                        
                        t_dur = t.get('length', '3:00')
                        
                        t_album = t.get('album', {})
                        t_album_id = t_album.get('id') if isinstance(t_album, dict) else None
                        t_album_name = t_album.get('name') if isinstance(t_album, dict) else None
                        
                        clean_title = re.sub(r'\s*[\(\[][^\]\)]*(official|video|lyric|audio|hd|4k|hq)[^\]\)]*[\)\]]\s*', '', t_title, flags=re.I).strip()
                        clean_title = re.sub(r'\s*-\s*topic\s*$', '', clean_title, flags=re.I).strip()
                        
                        tracks.append({
                            'id': t.get('videoId'),
                            'title': clean_title or t_title,
                            'artist': t_artist,
                            'duration': t_dur,
                            'thumbnail': t_thumb,
                            'url': f"https://music.youtube.com/watch?v={t.get('videoId')}",
                            'platform': 'youtube',
                            'albumId': t_album_id,
                            'albumName': t_album_name
                        })
                        if len(tracks) >= 15:
                            break
                except Exception as e:
                    print("YouTube Music related watch playlist recommendations failed:", e)
                    
            if not tracks:
                try:
                    query_term = recent_artists[0] + " songs" if recent_artists else "popular songs hits"
                    trending = search_youtube(query_term, limit=15)
                    tracks.extend(trending)
                except Exception as e:
                    print("Trending fallback recommendations failed:", e)
                    
            self.wfile.write(json.dumps(tracks).encode('utf-8'))
            return

        elif path == '/api/mixes':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            history = read_history()
            
            artists = [t.get('artist', '') for t in history if t.get('artist')]
            from collections import Counter
            artist_counts = Counter(artists)
            top_artists = [item[0] for item in artist_counts.most_common(5)]
            
            seed_artists_1 = ["Daft Punk", "Disclosure", "Fred again.."]
            seed_artists_2 = ["Kendrick Lamar", "Drake", "Travis Scott"]
            seed_artists_3 = ["Coldplay", "The Neighbourhood", "Arctic Monkeys"]
            
            if top_artists:
                if len(top_artists) > 0: seed_artists_1 = [top_artists[0]]
                if len(top_artists) > 1: seed_artists_2 = [top_artists[1]]
                if len(top_artists) > 2: seed_artists_3 = [top_artists[2]]
                
            mix1_tracks = []
            mix2_tracks = []
            mix3_tracks = []
            discover_tracks = []
            
            try:
                mix1_tracks = search_youtube(f"{seed_artists_1[0]} mix", limit=10)
            except Exception:
                pass
            try:
                mix2_tracks = search_youtube(f"{seed_artists_2[0]} mix", limit=10)
            except Exception:
                pass
            try:
                mix3_tracks = search_youtube(f"{seed_artists_3[0]} mix", limit=10)
            except Exception:
                pass
                
            if not mix1_tracks: mix1_tracks = search_youtube("Electronic mix", limit=10)
            if not mix2_tracks: mix2_tracks = search_youtube("Rap mix", limit=10)
            if not mix3_tracks: mix3_tracks = search_youtube("Indie Pop mix", limit=10)
            
            try:
                discover_query = f"{top_artists[0] if top_artists else 'Daft Punk'} recommendations"
                discover_tracks = search_youtube(discover_query, limit=12)
            except Exception:
                discover_tracks = search_youtube("new discover music weekly", limit=12)
                
            mixes = [
                {
                    'id': 'daily-mix-1',
                    'name': 'Daily Mix 1',
                    'description': f"Featuring {', '.join(seed_artists_1[:2]) if len(seed_artists_1) > 1 else seed_artists_1[0]} and more.",
                    'thumbnail': 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=250&auto=format&fit=crop',
                    'tracks': mix1_tracks
                },
                {
                    'id': 'daily-mix-2',
                     'name': 'Daily Mix 2',
                     'description': f"Featuring {', '.join(seed_artists_2[:2]) if len(seed_artists_2) > 1 else seed_artists_2[0]} and more.",
                     'thumbnail': 'https://images.unsplash.com/photo-1571172703734-4322a669acf9?q=80&w=250&auto=format&fit=crop',
                     'tracks': mix2_tracks
                },
                {
                     'id': 'daily-mix-3',
                     'name': 'Daily Mix 3',
                     'description': f"Featuring {', '.join(seed_artists_3[:2]) if len(seed_artists_3) > 1 else seed_artists_3[0]} and more.",
                     'thumbnail': 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?q=80&w=250&auto=format&fit=crop',
                     'tracks': mix3_tracks
                },
                {
                     'id': 'discover-weekly',
                     'name': 'Discover Weekly',
                     'description': "Your weekly mixtape of fresh vibes and hidden gems.",
                     'thumbnail': 'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?q=80&w=250&auto=format&fit=crop',
                     'tracks': discover_tracks
                }
            ]
            
            self.wfile.write(json.dumps(mixes).encode('utf-8'))
            return

        elif path == '/api/related-videos':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            title = query_params.get('title', [''])[0].strip()
            artist = query_params.get('artist', [''])[0].strip()
            
            videos = []
            if title:
                try:
                    search_query = f"{title} {artist} official music video"
                    yt_videos = ytmusic.search(search_query, filter="videos", limit=5)
                    for v in yt_videos:
                        v_artists = ", ".join([a['name'] for a in v.get('artists', [])]) if v.get('artists') else 'YouTube'
                        v_thumb = v.get('thumbnails', [{}])[-1].get('url', '') if v.get('thumbnails') else ''
                        videos.append({
                            'id': v.get('videoId'),
                            'title': v.get('title'),
                            'artist': v_artists,
                            'thumbnail': v_thumb,
                            'duration': v.get('duration') or '4:00',
                            'views': v.get('views', '1M views')
                        })
                except Exception as e:
                    print("Failed to fetch related videos:", e)
            
            self.wfile.write(json.dumps(videos).encode('utf-8'))
            return

        elif path == '/api/album':
            album_id = query_params.get('id', [''])[0].strip()
            platform = query_params.get('platform', [''])[0].strip()
            
            if not album_id or not platform:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error": "id and platform required"}')
                return
                
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            # Fetch Spotify album if credentials are set and it is a Spotify ID
            if platform == 'spotify':
                config = read_config()
                client_id = config.get('spotifyClientId')
                client_secret = config.get('spotifyClientSecret')
                token = get_spotify_access_token(client_id, client_secret)
                
                is_spotify_id = len(album_id) == 22 and album_id.isalnum()
                
                if token and is_spotify_id:
                    try:
                        url = f"https://api.spotify.com/v1/albums/{album_id}"
                        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
                        with urllib.request.urlopen(req) as res:
                            album_data = json.loads(res.read().decode('utf-8'))
                            
                        artists = ", ".join([a['name'] for a in album_data['artists']])
                        thumbnail = album_data['images'][0]['url'] if album_data['images'] else ''
                        
                        tracks = []
                        for t in album_data.get('tracks', {}).get('items', []):
                            t_artists = ", ".join([a['name'] for a in t['artists']])
                            tracks.append({
                                'id': t['id'],
                                'title': t['name'],
                                'artist': t_artists,
                                'duration': format_duration_ms(t['duration_ms']),
                                'thumbnail': thumbnail,
                                'url': t['external_urls']['spotify'],
                                'platform': 'spotify',
                                'previewUrl': t.get('preview_url'),
                                'album': album_data['name'],
                                'albumId': album_data['id'],
                                'albumName': album_data['name']
                            })
                            
                        res_obj = {
                            'title': album_data['name'],
                            'artist': artists,
                            'thumbnail': thumbnail,
                            'platform': 'spotify',
                            'year': album_data.get('release_date', '')[:4],
                            'tracks': tracks
                        }
                        self.wfile.write(json.dumps(res_obj).encode('utf-8'))
                        return
                    except Exception as e:
                        print("Failed to fetch Spotify album:", e)
                        self.wfile.write(json.dumps({'error': f'Failed to fetch Spotify album: {str(e)}'}).encode('utf-8'))
                        return
                elif is_spotify_id:
                    self.wfile.write(b'{"error": "Spotify API credentials are required to load this Spotify album."}')
                    return
                
            # YouTube Music album retrieval (also fallback for proxied Spotify albums)
            try:
                album_data = ytmusic.get_album(album_id)
                artists = ", ".join([a['name'] for a in album_data.get('artists', [])])
                thumbnail = album_data.get('thumbnails', [{}])[-1].get('url', '') if album_data.get('thumbnails') else ''
                
                tracks = []
                for t in album_data.get('tracks', []):
                    t_artists = ", ".join([a['name'] for a in t.get('artists', [])]) if t.get('artists') else artists
                    duration_sec = t.get('duration_seconds')
                    duration_str = t.get('duration') or (format_duration_ms(duration_sec * 1000) if duration_sec else '3:00')
                    
                    tracks.append({
                        'id': t.get('videoId'),
                        'title': t.get('title', 'Unknown Track'),
                        'artist': t_artists,
                        'duration': duration_str,
                        'thumbnail': thumbnail,
                        'url': f"https://music.youtube.com/watch?v={t.get('videoId')}",
                        'platform': platform if platform == 'spotify' else 'youtube',
                        'album': album_data.get('title'),
                        'albumId': album_data.get('albumId') or album_id,
                        'albumName': album_data.get('title')
                    })
                    
                res_obj = {
                    'title': album_data.get('title'),
                    'artist': artists,
                    'thumbnail': thumbnail,
                    'platform': platform,
                    'year': album_data.get('year', ''),
                    'tracks': tracks
                }
                self.wfile.write(json.dumps(res_obj).encode('utf-8'))
            except Exception as e:
                print("Failed to fetch YouTube Music album:", e)
                self.wfile.write(json.dumps({'error': f'Failed to fetch album details: {str(e)}'}).encode('utf-8'))
            return

        elif path == '/api/artist':
            name = query_params.get('name', [''])[0].strip()
            platform = query_params.get('platform', ['spotify'])[0].strip()
            artist_id = query_params.get('id', [''])[0].strip()
            
            if not name and not artist_id:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error": "name or id required"}')
                return
                
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            # 1. SPOTIFY
            if platform == 'spotify':
                config = read_config()
                client_id = config.get('spotifyClientId')
                client_secret = config.get('spotifyClientSecret')
                token = get_spotify_access_token(client_id, client_secret)
                
                is_spotify_id = artist_id and len(artist_id) == 22 and artist_id.isalnum()
                
                if token:
                    try:
                        # Find Spotify Artist ID if not given
                        if not is_spotify_id and name:
                            search_url = f"https://api.spotify.com/v1/search?q=artist:{urllib.parse.quote(name)}&type=artist&limit=1"
                            req = urllib.request.Request(search_url, headers={'Authorization': f'Bearer {token}'})
                            with urllib.request.urlopen(req) as res:
                                search_data = json.loads(res.read().decode('utf-8'))
                            items = search_data.get('artists', {}).get('items', [])
                            if items:
                                artist_id = items[0].get('id')
                                is_spotify_id = True
                                
                        if is_spotify_id:
                            # Get Artist Details
                            detail_url = f"https://api.spotify.com/v1/artists/{artist_id}"
                            req_det = urllib.request.Request(detail_url, headers={'Authorization': f'Bearer {token}'})
                            with urllib.request.urlopen(req_det) as res_det:
                                artist_det = json.loads(res_det.read().decode('utf-8'))
                                
                            name = artist_det.get('name')
                            thumbnail = artist_det.get('images', [{}])[0].get('url', '') if artist_det.get('images') else ''
                            followers = artist_det.get('followers', {}).get('total', 0)
                            genres = ", ".join(artist_det.get('genres', []))
                            
                            # Get Top Tracks
                            tracks_url = f"https://api.spotify.com/v1/artists/{artist_id}/top-tracks?market=US"
                            req_tr = urllib.request.Request(tracks_url, headers={'Authorization': f'Bearer {token}'})
                            with urllib.request.urlopen(req_tr) as res_tr:
                                tracks_data = json.loads(res_tr.read().decode('utf-8'))
                                
                            tracks = []
                            for t in tracks_data.get('tracks', []):
                                t_artists = ", ".join([a['name'] for a in t['artists']])
                                t_thumb = t['album']['images'][0]['url'] if t['album']['images'] else thumbnail
                                tracks.append({
                                    'id': t['id'],
                                    'title': t['name'],
                                    'artist': t_artists,
                                    'duration': format_duration_ms(t['duration_ms']),
                                    'thumbnail': t_thumb,
                                    'url': t['external_urls']['spotify'],
                                    'platform': 'spotify',
                                    'previewUrl': t.get('preview_url'),
                                    'album': t['album']['name'],
                                    'albumId': t.get('album', {}).get('id'),
                                    'albumName': t.get('album', {}).get('name')
                                })
                                
                            # Get Albums (up to 50 albums & singles)
                            albums_url = f"https://api.spotify.com/v1/artists/{artist_id}/albums?limit=50&include_groups=album,single"
                            req_al = urllib.request.Request(albums_url, headers={'Authorization': f'Bearer {token}'})
                            with urllib.request.urlopen(req_al) as res_al:
                                albums_data = json.loads(res_al.read().decode('utf-8'))
                                
                            albums = []
                            for al in albums_data.get('items', []):
                                al_artists = ", ".join([a['name'] for a in al['artists']])
                                al_thumb = al['images'][0]['url'] if al['images'] else ''
                                albums.append({
                                    'id': al['id'],
                                    'title': al['name'],
                                    'artist': al_artists,
                                    'thumbnail': al_thumb,
                                    'url': al['external_urls']['spotify'],
                                    'platform': 'spotify',
                                    'year': al.get('release_date', '')[:4],
                                    'type': 'album'
                                })
                                
                            res_obj = {
                                'id': artist_id,
                                'name': name,
                                'thumbnail': thumbnail,
                                'platform': 'spotify',
                                'followers': f"{followers:,} followers" if followers else "",
                                'description': f"Genres: {genres}" if genres else "Spotify Artist",
                                'tracks': tracks,
                                'albums': albums
                            }
                            self.wfile.write(json.dumps(res_obj).encode('utf-8'))
                            return
                    except Exception as e:
                        print("Spotify artist fetch failed:", e)
                        
                # Fallback: Spotify not configured or failed - fetch using YouTube Music and label as Spotify
                try:
                    # Search YTMusic for artist by name
                    search_results = ytmusic.search(name, filter="artists", limit=1)
                    if search_results:
                        yt_artist_id = search_results[0].get('browseId')
                        artist_data = ytmusic.get_artist(yt_artist_id)
                        
                        tracks = []
                        songs_list = artist_data.get('songs', {}).get('results', [])
                        for t in songs_list:
                            t_artists = ", ".join([a['name'] for a in t.get('artists', [])]) if t.get('artists') else name
                            album = t.get('album', {})
                            album_id = album.get('id') if isinstance(album, dict) else None
                            album_name = album.get('name') if isinstance(album, dict) else None
                            tracks.append({
                                'id': t.get('videoId'),
                                'title': t.get('title'),
                                'artist': t_artists,
                                'duration': t.get('duration') or '3:00',
                                'thumbnail': t.get('thumbnails', [{}])[-1].get('url', '') if t.get('thumbnails') else '',
                                'url': f"https://music.youtube.com/watch?v={t.get('videoId')}",
                                'platform': 'spotify',
                                'isFallback': True,
                                'albumId': album_id,
                                'albumName': album_name
                            })
                            
                        albums = []
                        albums_list = artist_data.get('albums', {}).get('results', [])
                        for al in albums_list:
                            albums.append({
                                'id': al.get('browseId'),
                                'title': al.get('title'),
                                'artist': name,
                                'thumbnail': al.get('thumbnails', [{}])[-1].get('url', '') if al.get('thumbnails') else '',
                                'url': f"https://music.youtube.com/browse/{al.get('browseId')}",
                                'platform': 'spotify',
                                'year': al.get('year', ''),
                                'type': 'album',
                                'isFallback': True
                            })
                            
                        res_obj = {
                            'id': yt_artist_id,
                            'name': artist_data.get('name', name),
                            'thumbnail': artist_data.get('thumbnails', [{}])[-1].get('url', '') if artist_data.get('thumbnails') else '',
                            'platform': 'spotify',
                            'followers': artist_data.get('subscribers', 'Fallback Profile'),
                            'description': artist_data.get('description', 'Spotify proxy profile via YouTube Music'),
                            'tracks': tracks,
                            'albums': albums
                        }
                        self.wfile.write(json.dumps(res_obj).encode('utf-8'))
                        return
                except Exception as fallback_err:
                    print("Artist spotify fallback error:", fallback_err)
                
                # Ultimate fallback
                self.wfile.write(json.dumps({
                    'name': name,
                    'thumbnail': '',
                    'platform': 'spotify',
                    'description': 'Could not retrieve Spotify profile.',
                    'tracks': [],
                    'albums': []
                }).encode('utf-8'))
                return

            # 2. YOUTUBE MUSIC
            elif platform == 'youtube':
                try:
                    is_yt_id = artist_id and (artist_id.startswith('UC') or artist_id.startswith('FE') or artist_id.startswith('MP'))
                    if not is_yt_id and name:
                        # Search for artist first
                        search_results = ytmusic.search(name, filter="artists", limit=1)
                        if search_results:
                            artist_id = search_results[0].get('browseId')
                            
                    if artist_id:
                        artist_data = ytmusic.get_artist(artist_id)
                        
                        tracks = []
                        songs_list = artist_data.get('songs', {}).get('results', [])
                        for t in songs_list:
                            t_artists = ", ".join([a['name'] for a in t.get('artists', [])]) if t.get('artists') else artist_data.get('name')
                            album = t.get('album', {})
                            album_id = album.get('id') if isinstance(album, dict) else None
                            album_name = album.get('name') if isinstance(album, dict) else None
                            tracks.append({
                                'id': t.get('videoId'),
                                'title': t.get('title'),
                                'artist': t_artists,
                                'duration': t.get('duration') or '3:00',
                                'thumbnail': t.get('thumbnails', [{}])[-1].get('url', '') if t.get('thumbnails') else '',
                                'url': f"https://music.youtube.com/watch?v={t.get('videoId')}",
                                'platform': 'youtube',
                                'albumId': album_id,
                                'albumName': album_name
                            })
                            
                        albums = []
                        albums_list = artist_data.get('albums', {}).get('results', [])
                        for al in albums_list:
                            albums.append({
                                'id': al.get('browseId'),
                                'title': al.get('title'),
                                'artist': artist_data.get('name'),
                                'thumbnail': al.get('thumbnails', [{}])[-1].get('url', '') if al.get('thumbnails') else '',
                                'url': f"https://music.youtube.com/browse/{al.get('browseId')}",
                                'platform': 'youtube',
                                'year': al.get('year', ''),
                                'type': 'album'
                            })
                            
                        singles_list = artist_data.get('singles', {}).get('results', [])
                        for sg in singles_list:
                            albums.append({
                                'id': sg.get('browseId'),
                                'title': sg.get('title'),
                                'artist': artist_data.get('name'),
                                'thumbnail': sg.get('thumbnails', [{}])[-1].get('url', '') if sg.get('thumbnails') else '',
                                'url': f"https://music.youtube.com/browse/{sg.get('browseId')}",
                                'platform': 'youtube',
                                'year': sg.get('year', ''),
                                'type': 'single'
                            })
                            
                        res_obj = {
                            'id': artist_id,
                            'name': artist_data.get('name'),
                            'thumbnail': artist_data.get('thumbnails', [{}])[-1].get('url', '') if artist_data.get('thumbnails') else '',
                            'platform': 'youtube',
                            'followers': artist_data.get('subscribers', ''),
                            'description': artist_data.get('description', 'YouTube Music Artist'),
                            'tracks': tracks,
                            'albums': albums
                        }
                        self.wfile.write(json.dumps(res_obj).encode('utf-8'))
                        return
                except Exception as e:
                    print("YouTube Music artist fetch error:", e)
                    
                # Fail
                self.wfile.write(json.dumps({
                    'name': name,
                    'thumbnail': '',
                    'platform': 'youtube',
                    'description': 'Could not retrieve YouTube Music profile.',
                    'tracks': [],
                    'albums': []
                }).encode('utf-8'))
                return

            # 3. SOUNDCLOUD
            elif platform == 'soundcloud':
                try:
                    sc_results = search_youtube(name + ' soundcloud', limit=15)
                    tracks = []
                    for song in sc_results:
                        song['platform'] = 'soundcloud'
                        song['isFallback'] = True
                        song['title'] = re.sub(r'soundcloud|official audio|remix', '', song['title'], flags=re.I).strip()
                        tracks.append(song)
                        
                    thumb = tracks[0].get('thumbnail', '') if tracks else ''
                    res_obj = {
                        'name': name,
                        'thumbnail': thumb,
                        'platform': 'soundcloud',
                        'followers': 'SoundCloud Artist',
                        'description': 'SoundCloud proxy tracks via YouTube search',
                        'tracks': tracks,
                        'albums': []
                    }
                    self.wfile.write(json.dumps(res_obj).encode('utf-8'))
                except Exception as e:
                    print("SoundCloud artist fetch error:", e)
                    self.wfile.write(json.dumps({
                        'name': name,
                        'thumbnail': '',
                        'platform': 'soundcloud',
                        'description': 'Could not retrieve SoundCloud profile.',
                        'tracks': [],
                        'albums': []
                    }).encode('utf-8'))
                return

        elif path == '/api/stream/proxy':
            video_id = query_params.get('id', [''])[0].strip()
            if not video_id:
                self.send_error(400, "Video ID required")
                return

            audio_url = get_youtube_audio_url(video_id)
            if not audio_url:
                self.send_error(404, "Audio stream not found")
                return

            req_headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
            range_header = self.headers.get('Range')
            if range_header:
                req_headers["Range"] = range_header

            # Two-attempt loop: if upstream returns 403 / 410 (URL expired), re-resolve stream URL automatically
            for attempt in range(2):
                try:
                    upstream_req = urllib.request.Request(audio_url, headers=req_headers)
                    with urllib.request.urlopen(upstream_req, timeout=12) as upstream_resp:
                        status_code = upstream_resp.status
                        self.send_response(status_code)
                        for header_name in ['Content-Type', 'Content-Range', 'Content-Length', 'Accept-Ranges']:
                            val = upstream_resp.headers.get(header_name)
                            if val:
                                self.send_header(header_name, val)
                        self.send_header('Access-Control-Allow-Origin', '*')
                        self.send_header('Access-Control-Allow-Headers', 'Range, Content-Type')
                        self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
                        self.end_headers()

                        chunk_size = 65536
                        while True:
                            try:
                                chunk = upstream_resp.read(chunk_size)
                                if not chunk:
                                    break
                                self.wfile.write(chunk)
                            except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
                                # Client closed connection or sought elsewhere
                                return
                    return
                except urllib.error.HTTPError as he:
                    if he.code in (403, 404, 410) and attempt == 0:
                        print(f"[Stream Proxy] Upstream returned {he.code} for {video_id}, re-resolving fresh stream URL...")
                        YOUTUBE_AUDIO_CACHE.pop(video_id, None)
                        audio_url = get_youtube_audio_url(video_id, force_refresh=True)
                        if audio_url:
                            continue
                    print(f"[Stream Proxy HTTPError] {he.code}: {he}")
                    break
                except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
                    # Client closed connection during request initialization
                    return
                except Exception as e:
                    print(f"[Stream Proxy Error] {e}")
                    if attempt == 0:
                        YOUTUBE_AUDIO_CACHE.pop(video_id, None)
                        audio_url = get_youtube_audio_url(video_id, force_refresh=True)
                        if audio_url:
                            continue
                    break

            if not self.wfile.closed:
                try:
                    self.send_error(502, "Proxy stream error")
                except Exception:
                    pass
            return

        elif path == '/api/stream-url' or path == '/api/stream':
            video_id = query_params.get('id', [''])[0].strip()
            if not video_id:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error": "Video ID required"}')
                return

            audio_url = get_youtube_audio_url(video_id)
            if not audio_url:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b'{"error": "Audio stream not found"}')
                return

            if path == '/api/stream':
                # Redirect to direct audio stream URL
                self.send_response(302)
                self.send_header('Location', audio_url)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                return
            else:
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'url': audio_url}).encode('utf-8'))
                return

        # Serve static file using standard class
        super().do_GET()

    def do_POST(self):
        path = self.path
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length).decode('utf-8')

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

        if path == '/api/history':
            try:
                data = json.loads(post_data)
                
                # Append to rolling weekly play history with timestamp for momentum decay ranking
                append_weekly_play(data)

                history = read_history()
                
                # Remove prior entries of the same item ID to bubble it to the top of recents
                item_id = data.get('id')
                if item_id:
                    history = [h for h in history if h.get('id') != item_id]
                
                import time
                data['timestamp'] = int(time.time())
                history.insert(0, data)
                
                # Cap history log length
                history = history[:200]
                
                write_history(history)
                self.wfile.write(b'{"success": true}')
            except Exception as e:
                print("Failed to save history:", e)
                self.wfile.write(f'{{"success": false, "error": "{str(e)}"}}'.encode('utf-8'))
            return

        elif path == '/api/queue-session':
            try:
                data = json.loads(post_data)
                write_queue_session(data)
                self.wfile.write(b'{"success": true}')
            except Exception as e:
                self.wfile.write(f'{{"success": false, "error": "{str(e)}"}}'.encode('utf-8'))
            return

        elif path == '/api/settings':
            try:
                data = json.loads(post_data)
                config = read_config()
                if 'spotifyClientId' in data: config['spotifyClientId'] = data['spotifyClientId']
                if 'spotifyClientSecret' in data: config['spotifyClientSecret'] = data['spotifyClientSecret']
                if 'username' in data: config['username'] = data['username']
                if 'avatar' in data: config['avatar'] = data['avatar']
                if 'currentTheme' in data: config['currentTheme'] = data['currentTheme']
                if 'customThemes' in data: config['customThemes'] = data['customThemes']
                write_config(config)
                self.wfile.write(b'{"success": true, "message": "Settings saved"}')
            except Exception as e:
                self.wfile.write(f'{{"success": false, "error": "{str(e)}"}}'.encode('utf-8'))

        elif path == '/api/backup':
            try:
                data = json.loads(post_data)
                with open(BACKUP_FILE, 'w', encoding='utf-8') as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
                self.wfile.write(b'{"success": true, "message": "Backup stored"}')
            except Exception as e:
                self.wfile.write(f'{{"success": false, "error": "{str(e)}"}}'.encode('utf-8'))

        elif path == '/api/export-playlists':
            try:
                import datetime
                date_str = datetime.date.today().isoformat()
                filename = f"playlists_backup_{date_str}.json"
                
                playlists_data = None
                if post_data and post_data.strip():
                    try:
                        playlists_data = json.loads(post_data)
                    except Exception:
                        pass
                if playlists_data is None and os.path.exists(BACKUP_FILE):
                    try:
                        with open(BACKUP_FILE, 'r', encoding='utf-8') as bf:
                            playlists_data = json.load(bf)
                    except Exception:
                        pass
                if playlists_data is None:
                    playlists_data = []

                saved_to_disk = False
                saved_path = ""
                # In standalone desktop mode, save directly to user's standard Downloads folder
                try:
                    downloads_folder = os.path.join(os.path.expanduser('~'), 'Downloads')
                    if os.path.exists(downloads_folder) and os.path.isdir(downloads_folder):
                        target_path = os.path.join(downloads_folder, filename)
                        with open(target_path, 'w', encoding='utf-8') as out_f:
                            json.dump(playlists_data, out_f, indent=2, ensure_ascii=False)
                        saved_to_disk = True
                        saved_path = target_path
                except Exception as ex:
                    print("Could not write to user Downloads folder:", ex)

                res_obj = {
                    'success': True,
                    'filename': filename,
                    'savedToDownloads': saved_to_disk,
                    'savedPath': saved_path
                }
                self.wfile.write(json.dumps(res_obj, ensure_ascii=False).encode('utf-8'))
            except Exception as e:
                self.wfile.write(json.dumps({'success': False, 'error': str(e)}).encode('utf-8'))

        elif path == '/api/upload-bg' or path == '/api/upload-avatar':
            try:
                data = json.loads(post_data)
                img_data_url = data.get('image', '')
                orig_filename = data.get('filename', 'upload.jpg')
                
                # Split off data:image/png;base64, header
                header, base64_data = img_data_url.split(',', 1)
                img_bytes = base64.b64decode(base64_data)
                
                # Generate safe unique filename
                ext = os.path.splitext(orig_filename)[1]
                if not ext:
                    ext = '.jpg'
                import time, random
                safe_name = f"{'bg' if 'bg' in path else 'avatar'}-{int(time.time())}-{random.randint(1000,9999)}{ext}"
                dest_path = os.path.join(UPLOADS_DIR, safe_name)
                
                with open(dest_path, 'wb') as f:
                    f.write(img_bytes)
                
                file_url = f"/uploads/{safe_name}"
                res = {'success': True, 'fileUrl': file_url}
                self.wfile.write(json.dumps(res).encode('utf-8'))
            except Exception as e:
                print("Upload failed:", e)
                self.wfile.write(f'{{"success": false, "error": "{str(e)}"}}'.encode('utf-8'))

        elif path == '/api/offline/download':
            try:
                data = json.loads(post_data)
                song = data.get('song', {})
                is_cache = bool(data.get('isCache', False))
                res = download_track_offline(song, is_cache=is_cache)
                self.wfile.write(json.dumps(res, ensure_ascii=False).encode('utf-8'))
            except Exception as e:
                self.wfile.write(json.dumps({'success': False, 'error': str(e)}).encode('utf-8'))
            return

        elif path == '/api/offline/settings':
            try:
                data = json.loads(post_data)
                index = read_offline_index()
                if 'smartCacheEnabled' in data:
                    index['settings']['smartCacheEnabled'] = bool(data['smartCacheEnabled'])
                if 'smartCacheLimit' in data:
                    index['settings']['smartCacheLimit'] = int(data['smartCacheLimit'])
                write_offline_index(index)
                self.wfile.write(b'{"success": true}')
            except Exception as e:
                self.wfile.write(json.dumps({'success': False, 'error': str(e)}).encode('utf-8'))
            return

        elif path == '/api/offline/delete':
            try:
                data = json.loads(post_data)
                song_id = data.get('id')
                if song_id and delete_offline_track(song_id):
                    self.wfile.write(b'{"success": true}')
                else:
                    self.wfile.write(b'{"success": false, "error": "Track not found or failed to delete"}')
            except Exception as e:
                self.wfile.write(json.dumps({'success': False, 'error': str(e)}).encode('utf-8'))
            return

        elif path == '/api/offline/clear':
            try:
                data = json.loads(post_data)
                clear_type = data.get('type', 'cache')
                count = clear_offline_storage(clear_type)
                self.wfile.write(json.dumps({'success': True, 'deletedCount': count}).encode('utf-8'))
            except Exception as e:
                self.wfile.write(json.dumps({'success': False, 'error': str(e)}).encode('utf-8'))
            return

    def do_DELETE(self):
        url_parsed = urllib.parse.urlparse(self.path)
        path = url_parsed.path
        query_params = urllib.parse.parse_qs(url_parsed.query)

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

        if path == '/api/offline/track':
            song_id = query_params.get('id', [''])[0].strip()
            if song_id and delete_offline_track(song_id):
                self.wfile.write(b'{"success": true}')
            else:
                self.wfile.write(b'{"success": false, "error": "Track not found"}')
            return

        self.wfile.write(b'{"error": "Endpoint not found"}')

def get_local_ip():
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def start_android_server():
    try:
        class ReusableServer(BaseHTTPServer):
            allow_reuse_address = True
            daemon_threads = True

        server_address = ('127.0.0.1', PORT)
        httpd = ReusableServer(server_address, AetherPlayerHandler)
        print("AetherPlayer Android server is running!")
        httpd.serve_forever()
    except OSError as e:
        if e.errno == 98 or "already in use" in str(e).lower():
            print("Server is already running on port", PORT)
            return
        raise e

def run_server(port=None):
    if port is None:
        port = int(os.environ.get('PORT', PORT))
    
    class ReusableServer(BaseHTTPServer):
        allow_reuse_address = True
        daemon_threads = True

    server_address = ('', port)
    httpd = ReusableServer(server_address, AetherPlayerHandler)
    print(f"AetherPlayer server is running on port {port}!")
    print(f"  - Local access:   http://localhost:{port}")
    print(f"  - Network access: http://{get_local_ip()}:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
        httpd.server_close()

if __name__ == '__main__':
    run_server()

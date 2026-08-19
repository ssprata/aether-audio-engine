import os
import re
import json
import base64
import urllib.request
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler
from ytmusicapi import YTMusic

PORT = 3000

# Check if running on Android (Chaquopy)
IS_ANDROID = False
try:
    from android.os import Build
    IS_ANDROID = True
except ImportError:
    pass

PUBLIC_DIR = os.path.join(os.path.dirname(__file__), 'public')

if IS_ANDROID:
    # Under Chaquopy, redirect config and writeable uploads to application files storage
    from com.chaquo.python import Python
    context = Python.getPlatform().getApplication()
    android_files_dir = context.getFilesDir().getAbsolutePath()
    
    CONFIG_FILE = os.path.join(android_files_dir, 'config.json')
    BACKUP_FILE = os.path.join(android_files_dir, 'playlists_backup.json')
    UPLOADS_DIR = os.path.join(android_files_dir, 'uploads')
    HISTORY_FILE = os.path.join(android_files_dir, 'history.json')
else:
    CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'config.json')
    BACKUP_FILE = os.path.join(os.path.dirname(__file__), 'playlists_backup.json')
    UPLOADS_DIR = os.path.join(PUBLIC_DIR, 'uploads')
    HISTORY_FILE = os.path.join(os.path.dirname(__file__), 'history.json')

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

# Initialize YouTube Music API client
ytmusic = YTMusic()

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

# Spotify Auth helper
def get_spotify_access_token(client_id, client_secret):
    if not client_id or not client_secret:
        return None
    try:
        auth_bytes = f"{client_id}:{client_secret}".encode('utf-8')
        auth_string = base64.b64encode(auth_bytes).decode('utf-8')
        url = 'https://accounts.spotify.com/api/token'
        headers = {
            'Authorization': f'Basic {auth_string}',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
        data = urllib.parse.urlencode({'grant_type': 'client_credentials'}).encode('utf-8')
        req = urllib.request.Request(url, data=data, headers=headers)
        with urllib.request.urlopen(req) as res:
            response_data = json.loads(res.read().decode('utf-8'))
            return response_data.get('access_token')
    except Exception as err:
        print("Spotify auth error:", err)
        return None

# Get related tracks from YouTube Music watch playlist
def get_related_tracks(video_id, platform):
    try:
        playlist = ytmusic.get_watch_playlist(videoId=video_id, limit=10)
        tracks = playlist.get('tracks', [])
        related = []
        for item in tracks:
            item_id = item.get('videoId')
            # Skip the seed track itself
            if not item_id or item_id == video_id:
                continue
                
            artists = item.get('artists', [])
            artist_name = ", ".join([a.get('name', 'Unknown Artist') for a in artists]) if artists else 'Unknown Artist'
            
            duration = item.get('length', '3:00')
            
            thumbnail = ''
            thumbnails = item.get('thumbnail', [])
            if thumbnails:
                thumbnail = thumbnails[-1].get('url', '')
                
            track_data = {
                'id': item_id,
                'title': item.get('title', 'Unknown Track'),
                'artist': artist_name,
                'duration': duration,
                'thumbnail': thumbnail,
                'url': f"https://music.youtube.com/watch?v={item_id}",
                'platform': platform
            }
            if platform == 'spotify':
                track_data['isFallback'] = True
                track_data['title'] = re.sub(r'\s*[\(\[][^\]\)]*(official|video|lyric|audio|dubstep|slowed)[^\]\)]*[\)\]]\s*', '', track_data['title'], flags=re.I)
                track_data['title'] = re.sub(r'\s*-\s*topic\s*$', '', track_data['title'], flags=re.I).strip()
                
            related.append(track_data)
        return related[:6]
    except Exception as e:
        print(f"Error fetching related tracks for video {video_id}: {e}")
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

def resolve_youtube_playlist(playlist_id):
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
                return {
                    'name': title,
                    'tracks': tracks
                }
    except Exception as e:
        print("YouTube playlist resolve error:", e)
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
            
    # Fallback: scrape Spotify track page
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

def get_youtube_audio_url(video_id):
    try:
        url = "https://www.youtube.com/youtubei/v1/player"
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "com.google.android.apps.youtube.music/6.20.51 (Linux; U; Android 11; en_US) gzip",
            "X-YouTube-Client-Name": "67",
            "X-YouTube-Client-Version": "6.20.51"
        }
        payload = {
            "context": {
                "client": {
                    "clientName": "ANDROID_MUSIC",
                    "clientVersion": "6.20.51",
                    "androidSdkVersion": 30,
                    "hl": "en",
                    "gl": "US"
                }
            },
            "videoId": video_id
        }
        req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers)
        with urllib.request.urlopen(req, timeout=8) as res:
            data = json.loads(res.read().decode('utf-8'))
        
        streaming_data = data.get('streamingData', {})
        formats = streaming_data.get('adaptiveFormats', []) + streaming_data.get('formats', [])
        
        audio_formats = [f for f in formats if f.get('mimeType', '').startswith('audio/')]
        if audio_formats:
            audio_formats.sort(key=lambda x: x.get('bitrate', 0), reverse=True)
            for af in audio_formats:
                if 'url' in af:
                    return af['url']
        
        # Web client fallback
        payload_web = {
            "context": {
                "client": {
                    "clientName": "WEB",
                    "clientVersion": "2.20231201.00.00",
                    "hl": "en",
                    "gl": "US"
                }
            },
            "videoId": video_id
        }
        req_web = urllib.request.Request(url, data=json.dumps(payload_web).encode('utf-8'), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req_web, timeout=8) as res_web:
            data_web = json.loads(res_web.read().decode('utf-8'))
        streaming_data_web = data_web.get('streamingData', {})
        formats_web = streaming_data_web.get('adaptiveFormats', []) + streaming_data_web.get('formats', [])
        audio_formats_web = [f for f in formats_web if f.get('mimeType', '').startswith('audio/')]
        if audio_formats_web:
            audio_formats_web.sort(key=lambda x: x.get('bitrate', 0), reverse=True)
            for af in audio_formats_web:
                if 'url' in af:
                    return af['url']
    except Exception as e:
        print("YouTube audio stream extraction error:", e)
    return None

def resolve_spotify_playlist(playlist_id):
    config = read_config()
    client_id = config.get('spotifyClientId')
    client_secret = config.get('spotifyClientSecret')
    token = get_spotify_access_token(client_id, client_secret)
    
    if not token:
        try:
            url = f"https://open.spotify.com/playlist/{playlist_id}"
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req) as res:
                html = res.read().decode('utf-8')
            
            name_match = re.search(r'<meta\s+property="og:title"\s+content="([^"]+)"', html)
            name = name_match.group(1) if name_match else 'Imported Spotify Playlist'
            
            return {
                'name': name,
                'tracks': [],
                'error': 'Spotify API Credentials are required to import playlists. Please add them in the User Profile tab.'
            }
        except Exception as e:
            return None

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
            
            if not next_url:
                break
                
            try:
                req_next = urllib.request.Request(next_url, headers={'Authorization': f'Bearer {token}'})
                with urllib.request.urlopen(req_next) as res_next:
                    next_data = json.loads(res_next.read().decode('utf-8'))
                items = next_data.get('items', [])
                next_url = next_data.get('next')
            except Exception:
                break
                
        return {
            'name': name,
            'tracks': tracks
        }
    except Exception as e:
        print("Spotify playlist resolve error:", e)
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

def resolve_soundcloud_playlist(url):
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
            
        return {
            'name': playlist_name,
            'tracks': tracks
        }
    except Exception as e:
        print("SoundCloud playlist resolve error:", e)
        return None

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
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

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

        # API Endpoints
        if path == '/api/settings':
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

            # Clean query strings to improve search matching on LrcLib
            # Remove terms like (Official Video), (Lyric Video), [MV], etc.
            clean_title = re.sub(r'\(.*?\)|\[.*?\]|official video|official audio|lyric video|video|mv|audio', '', title, flags=re.I).strip()
            clean_artist = re.sub(r'\(.*?\)|\[.*?\]', '', artist, flags=re.I).strip() if artist else ''

            try:
                # 1. Try exact matching using LrcLib API /api/get
                get_url = f"https://lrclib.net/api/get?track_name={urllib.parse.quote(clean_title)}&artist_name={urllib.parse.quote(clean_artist)}"
                req = urllib.request.Request(get_url, headers={'User-Agent': 'AetherPlayer/1.0'})
                try:
                    with urllib.request.urlopen(req) as res:
                        data = json.loads(res.read().decode('utf-8'))
                        self.wfile.write(json.dumps({
                            'synced': bool(data.get('syncedLyrics')),
                            'lyrics': data.get('plainLyrics', ''),
                            'syncedLyrics': data.get('syncedLyrics', '')
                        }).encode('utf-8'))
                        return
                except urllib.error.HTTPError as he:
                    if he.code != 404:
                        raise he

                # 2. Try search/fuzzy matching if exact match was 404
                search_url = f"https://lrclib.net/api/search?q={urllib.parse.quote(clean_title + ' ' + clean_artist)}"
                req_search = urllib.request.Request(search_url, headers={'User-Agent': 'AetherPlayer/1.0'})
                with urllib.request.urlopen(req_search) as res_search:
                    search_results = json.loads(res_search.read().decode('utf-8'))
                    if search_results and len(search_results) > 0:
                        best_match = search_results[0]
                        self.wfile.write(json.dumps({
                            'synced': bool(best_match.get('syncedLyrics')),
                            'lyrics': best_match.get('plainLyrics', ''),
                            'syncedLyrics': best_match.get('syncedLyrics', '')
                        }).encode('utf-8'))
                        return

                self.wfile.write(b'{"error": "No lyrics found"}')
            except Exception as err:
                print("Lyrics search error:", err)
                self.wfile.write(f'{{"error": "{str(err)}"}}'.encode('utf-8'))
            return


        elif path == '/api/recommendations':
            title = query_params.get('title', [''])[0].strip()
            artist = query_params.get('artist', [''])[0].strip()
            platform = query_params.get('platform', [''])[0].strip()
            track_id = query_params.get('track_id', [''])[0].strip()
            
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
                                recommend_url = f"https://api.spotify.com/v1/recommendations?seed_tracks={seed_id}&limit=6"
                                req = urllib.request.Request(recommend_url, headers={'Authorization': f'Bearer {token}'})
                                with urllib.request.urlopen(req) as res:
                                    recommend_data = json.loads(res.read().decode('utf-8'))
                                    for track in recommend_data.get('tracks', []):
                                        artists = [a.get('name') for a in track.get('artists', [])]
                                        artist_str = ", ".join(artists) if artists else 'Unknown Artist'
                                        duration_ms = track.get('duration_ms', 0)
                                        images = track.get('album', {}).get('images', [])
                                        thumbnail = images[0].get('url') if images else ''
                                        
                                        recommendations.append({
                                            'id': track.get('id'),
                                            'title': track.get('name'),
                                            'artist': artist_str,
                                            'duration': format_duration_ms(duration_ms),
                                            'thumbnail': thumbnail,
                                            'url': f"https://open.spotify.com/track/{track.get('id')}",
                                            'platform': 'spotify'
                                        })
                    except Exception as e:
                        print("Spotify recommendations failed:", e)
                    
            # Fallback for Spotify failures, or default for YouTube/SoundCloud
            if not recommendations:
                try:
                    target_video_id = None
                    if track_id and len(track_id) == 11:
                        target_video_id = track_id
                    
                    if not target_video_id and title:
                        search_results = search_youtube(f"{title} {artist}", limit=1)
                        if search_results:
                            target_video_id = search_results[0].get('id')
                            
                    if target_video_id:
                        recommendations = get_related_tracks(target_video_id, platform)
                except Exception as e:
                    print("YouTube Music related recommendations failed:", e)
                    
            self.wfile.write(json.dumps(recommendations).encode('utf-8'))
            return

        elif path == '/api/resolve-link':
            url = query_params.get('url', [''])[0].strip()
            if not url:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error": "URL required"}')
                return
            
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
                res_playlist = resolve_spotify_playlist(playlist_id)
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
                
            # 3. YouTube Playlist Link
            elif 'list=' in url or YOUTUBE_PLAYLIST_RE.search(url):
                playlist_match = YOUTUBE_PLAYLIST_RE.search(url)
                playlist_id = playlist_match.group(1) if playlist_match else None
                if not playlist_id:
                    parsed_qs = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
                    playlist_id = parsed_qs.get('list', [None])[0]
                    
                if playlist_id:
                    res_playlist = resolve_youtube_playlist(playlist_id)
                    if res_playlist:
                        self.wfile.write(json.dumps({
                            'type': 'playlist', 
                            'name': res_playlist['name'], 
                            'songs': res_playlist['tracks']
                        }).encode('utf-8'))
                    else:
                        self.wfile.write(b'{"error": "Failed to resolve YouTube playlist"}')
                else:
                    self.wfile.write(b'{"error": "Invalid YouTube playlist ID"}')
                return
                
            # 4. YouTube Video Link
            elif YOUTUBE_VIDEO_RE.search(url):
                video_id = YOUTUBE_VIDEO_RE.search(url).group(1)
                res_track = resolve_youtube_video(video_id)
                if res_track:
                    self.wfile.write(json.dumps({'type': 'track', 'song': res_track}).encode('utf-8'))
                else:
                    self.wfile.write(b'{"error": "Failed to resolve YouTube video"}')
                return
                
            # 5. SoundCloud Playlist Link
            elif SOUNDCLOUD_PLAYLIST_RE.search(url):
                res_playlist = resolve_soundcloud_playlist(url)
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
            client_secret = config.get('spotifyClientSecret')
            token = get_spotify_access_token(client_id, client_secret) if (client_id and client_secret) else None
            
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
                    watch_list = ytmusic.get_watch_playlist(videoId=recent_vid, limit=15)
                    print("Watch playlist returned tracks count:", len(watch_list.get('tracks', [])))
                    for t in watch_list.get('tracks', []):
                        if t.get('videoId') == recent_vid:
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
                        
                        tracks.append({
                            'id': t.get('videoId'),
                            'title': t.get('title', 'Unknown Track'),
                            'artist': t_artist,
                            'duration': t_dur,
                            'thumbnail': t_thumb,
                            'url': f"https://music.youtube.com/watch?v={t.get('videoId')}",
                            'platform': 'youtube',
                            'albumId': t_album_id,
                            'albumName': t_album_name
                        })
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
    server_address = ('127.0.0.1', PORT)
    httpd = HTTPServer(server_address, AetherPlayerHandler)
    print("AetherPlayer Android server is running!")
    httpd.serve_forever()

def run_server():
    server_address = ('', PORT)
    httpd = HTTPServer(server_address, AetherPlayerHandler)
    print("AetherPlayer server is running!")
    print(f"  - Local access:   http://localhost:{PORT}")
    print(f"  - Network access: http://{get_local_ip()}:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
        httpd.server_close()

if __name__ == '__main__':
    run_server()

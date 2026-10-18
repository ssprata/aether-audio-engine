import os
import sys

# Safeguard stdout/stderr for PyInstaller --noconsole mode
if sys.stdout is None:
    sys.stdout = open(os.devnull, 'w')
if sys.stderr is None:
    sys.stderr = open(os.devnull, 'w')

import time
import socket
import subprocess

import threading
import server

WINMM_WAVEOUT_HANDLE = None

def init_windows_audio_session():
    """Ensure an active Windows audio session (WASAPI / standard endpoint) is tied to AetherPlayer
    so Windows Volume Mixer exposes an independent volume slider for the process."""
    global WINMM_WAVEOUT_HANDLE
    if sys.platform != 'win32':
        return
    try:
        import ctypes
        import struct
        # WAVEFORMATEX structure: 44.1kHz, 16-bit, stereo
        wfx = struct.pack('<HHIIHHH', 1, 2, 44100, 44100 * 4, 4, 16, 0)
        h_waveout = ctypes.c_void_p()
        res = ctypes.windll.winmm.waveOutOpen(ctypes.byref(h_waveout), -1, wfx, 0, 0, 0)
        if res == 0:
            WINMM_WAVEOUT_HANDLE = h_waveout
            print("Windows Audio Session initialized (WASAPI/WinMM endpoint active for Volume Mixer).")
    except Exception as e:
        print("Note: Could not init direct winmm audio endpoint:", e)

# Route WebView2 audio sessions directly to host process and enable Windows MediaSession/SMTC
if sys.platform == 'win32':
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID('AetherPlayer.DesktopApp')
    except Exception:
        pass
    existing_args = os.environ.get('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', '')
    flags_to_add = [
        '--disable-features=AudioServiceOutOfProcess',
        '--enable-features=HardwareMediaKeyHandling,MediaSessionService'
    ]
    for flag in flags_to_add:
        if flag not in existing_args:
            existing_args = (existing_args + ' ' + flag).strip()
    os.environ['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = existing_args

DEFAULT_START_PORT = 38241
ACTIVE_PORT = DEFAULT_START_PORT
SERVER_PROCESS = None

def is_port_in_use(port):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            return s.connect_ex(('localhost', port)) == 0
    except Exception:
        return False

def is_aether_server(port):
    """Check if the service on the port is genuinely an AetherPlayer server."""
    import urllib.request
    import json
    try:
        req = urllib.request.Request(f'http://localhost:{port}/api/ping', headers={'User-Agent': 'AetherDesktop'})
        with urllib.request.urlopen(req, timeout=0.8) as res:
            if res.status == 200:
                data = json.loads(res.read().decode('utf-8'))
                return data.get('app') == 'AetherPlayer'
    except Exception:
        pass
    return False

def determine_active_port(start_port=38241, max_scan=50):
    # First: check if an existing AetherPlayer server is already running on any scanned port
    for p in range(start_port, start_port + max_scan):
        if is_port_in_use(p) and is_aether_server(p):
            print(f"Discovered already running AetherPlayer instance on port {p}")
            return p, True

    # Second: find the first available free port
    for p in range(start_port, start_port + max_scan):
        if not is_port_in_use(p):
            return p, False

    # Fallback: OS assigned dynamic port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', 0))
        return s.getsockname()[1], False

def start_server():
    global SERVER_PROCESS, ACTIVE_PORT
    port, already_running = determine_active_port(DEFAULT_START_PORT)
    ACTIVE_PORT = port

    if not already_running:
        print(f"Starting AetherPlayer server on port {ACTIVE_PORT}...")
        try:
            server_thread = threading.Thread(target=server.run_server, args=(ACTIVE_PORT,), daemon=True)
            server_thread.start()
        except Exception as e:
            print("Failed to start server in thread, falling back to subprocess:", e)
            script_dir = os.path.dirname(os.path.abspath(__file__))
            server_path = os.path.join(script_dir, 'server.py')
            env = os.environ.copy()
            env['PORT'] = str(ACTIVE_PORT)
            SERVER_PROCESS = subprocess.Popen([sys.executable, server_path], cwd=script_dir, env=env)
        
        # Wait a moment for server to bind
        for _ in range(40):
            if is_aether_server(ACTIVE_PORT) or is_port_in_use(ACTIVE_PORT):
                print(f"Server started successfully on port {ACTIVE_PORT}.")
                break
            time.sleep(0.1)
    else:
        print(f"Connecting to existing AetherPlayer server on port {ACTIVE_PORT}.")

def launch_desktop():
    # 1. First choice: Use native system WebView (via pywebview) if available
    try:
        import webview
        print("Launching native desktop window frame (Edge WebView2)...")
        
        # Create webview window
        window = webview.create_window(
            title='AetherPlayer',
            url=f'http://localhost:{ACTIVE_PORT}',
            width=1280,
            height=800,
            resizable=True,
            min_size=(900, 600)
        )
        # Start webview loop (blocks until window is closed)
        webview.start()
        print("Desktop window closed.")
        return
    except ImportError:
        print("pywebview library not found. Falling back to browser app mode...")
    except Exception as e:
        print("Error launching pywebview window, falling back:", e)

    # 2. Second choice: Open in standalone Application Mode using Chrome/Edge/Brave
    # Common paths for browsers on Windows
    paths = [
        "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ]
    
    browser_path = None
    for p in paths:
        if os.path.exists(p):
            browser_path = p
            break
            
    if browser_path:
        print(f"Launching standalone app window using: {os.path.basename(browser_path)}")
        # App mode opens a clean, borderless browser window frame with no URL bars or tabs
        browser_process = subprocess.Popen([browser_path, f"--app=http://localhost:{ACTIVE_PORT}"])
        browser_process.wait()
        print("App window closed.")
    else:
        # 3. Third choice: Fallback to standard web browser tab
        import webbrowser
        print("No native window wrapper found. Opening in default browser tab...")
        webbrowser.open(f"http://localhost:{ACTIVE_PORT}")
        # Keep launcher process alive for a bit so they can see the tab open
        time.sleep(5)

def main():
    try:
        init_windows_audio_session()
        start_server()
        launch_desktop()
    except Exception as e:
        print("Error launching desktop app:", e)
    finally:
        if WINMM_WAVEOUT_HANDLE:
            try:
                import ctypes
                ctypes.windll.winmm.waveOutClose(WINMM_WAVEOUT_HANDLE)
            except Exception:
                pass
        if SERVER_PROCESS:
            print("Shutting down background server...")
            SERVER_PROCESS.terminate()
            try:
                SERVER_PROCESS.wait(timeout=3)
            except subprocess.TimeoutExpired:
                SERVER_PROCESS.kill()
            print("Background server shut down.")

if __name__ == '__main__':
    main()

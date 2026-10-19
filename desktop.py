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

def get_process_tree_pids(root_pid):
    """Retrieve the set containing root_pid and all child process IDs (e.g., msedgewebview2.exe)."""
    pids = {root_pid}
    if sys.platform != 'win32':
        return pids
    try:
        import ctypes
        from ctypes import wintypes

        class PROCESSENTRY32(ctypes.Structure):
            _fields_ = [
                ('dwSize', wintypes.DWORD),
                ('cntUsage', wintypes.DWORD),
                ('th32ProcessID', wintypes.DWORD),
                ('th32DefaultHeapID', ctypes.c_size_t),
                ('th32ModuleID', wintypes.DWORD),
                ('cntThreads', wintypes.DWORD),
                ('th32ParentProcessID', wintypes.DWORD),
                ('pcPriClassBase', ctypes.c_long),
                ('dwFlags', wintypes.DWORD),
                ('szExeFile', ctypes.c_char * 260)
            ]

        h_snap = ctypes.windll.kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
        if h_snap != -1:
            pe = PROCESSENTRY32()
            pe.dwSize = ctypes.sizeof(PROCESSENTRY32)
            if ctypes.windll.kernel32.Process32First(h_snap, ctypes.byref(pe)):
                more = True
                while more:
                    if pe.th32ParentProcessID in pids:
                        pids.add(pe.th32ProcessID)
                    more = ctypes.windll.kernel32.Process32Next(h_snap, ctypes.byref(pe))
            ctypes.windll.kernel32.CloseHandle(h_snap)
    except Exception:
        pass
    return pids

def rename_windows_audio_sessions(icon_path):
    """Ensure the active WebView2 audio session is branded as AetherPlayer with its icon in the Volume Mixer."""
    if sys.platform != 'win32':
        return
    try:
        import ctypes
        from ctypes import wintypes

        ole32 = ctypes.windll.ole32
        ole32.CoInitialize(None)

        class GUID(ctypes.Structure):
            _fields_ = [
                ('Data1', wintypes.DWORD),
                ('Data2', wintypes.WORD),
                ('Data3', wintypes.WORD),
                ('Data4', ctypes.c_byte * 8)
            ]

        def get_guid(s):
            g = GUID()
            ole32.IIDFromString(ctypes.c_wchar_p(s), ctypes.byref(g))
            return g

        clsid_enum = get_guid('{BCDE0395-E52F-467C-8E3D-C4579291692E}')
        iid_enum = get_guid('{A95664D2-9614-4F35-A746-DE8DB63617E6}')
        iid_mgr = get_guid('{77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F}')
        iid_ctrl2 = get_guid('{bfb7ff88-7239-4fc9-8fa2-07c950be9c6d}')

        p_enum = ctypes.c_void_p()
        hr = ole32.CoCreateInstance(ctypes.byref(clsid_enum), None, 1, ctypes.byref(iid_enum), ctypes.byref(p_enum))
        if hr != 0 or not p_enum:
            return

        vt_enum = ctypes.cast(p_enum, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        GetDefaultEndpoint_fn = ctypes.WINFUNCTYPE(
            ctypes.c_long, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)
        )(vt_enum[4])

        p_device = ctypes.c_void_p()
        if GetDefaultEndpoint_fn(p_enum, 0, 1, ctypes.byref(p_device)) != 0 or not p_device:
            return

        vt_dev = ctypes.cast(p_device, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        Activate_fn = ctypes.WINFUNCTYPE(
            ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(GUID), wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)
        )(vt_dev[3])

        p_mgr = ctypes.c_void_p()
        if Activate_fn(p_device, ctypes.byref(iid_mgr), 1, None, ctypes.byref(p_mgr)) != 0 or not p_mgr:
            return

        vt_mgr = ctypes.cast(p_mgr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        GetSessionEnum_fn = ctypes.WINFUNCTYPE(
            ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)
        )(vt_mgr[5])

        p_sess_enum = ctypes.c_void_p()
        if GetSessionEnum_fn(p_mgr, ctypes.byref(p_sess_enum)) != 0 or not p_sess_enum:
            return

        vt_se = ctypes.cast(p_sess_enum, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        GetCount_fn = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int))(vt_se[3])
        GetSession_fn = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p))(vt_se[4])

        count = ctypes.c_int(0)
        GetCount_fn(p_sess_enum, ctypes.byref(count))

        app_pids = get_process_tree_pids(os.getpid())

        for i in range(count.value):
            p_ctrl = ctypes.c_void_p()
            GetSession_fn(p_sess_enum, i, ctypes.byref(p_ctrl))
            if not p_ctrl:
                continue
            vt_ctrl = ctypes.cast(p_ctrl, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
            QI_fn = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)
            )(vt_ctrl[0])
            p_ctrl2 = ctypes.c_void_p()
            QI_fn(p_ctrl, ctypes.byref(iid_ctrl2), ctypes.byref(p_ctrl2))
            if p_ctrl2:
                vt_c2 = ctypes.cast(p_ctrl2, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
                GetPid_fn = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD))(vt_c2[14])
                pid = wintypes.DWORD(0)
                GetPid_fn(p_ctrl2, ctypes.byref(pid))
                if pid.value in app_pids and pid.value != 0:
                    SetDN_fn = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_void_p)(vt_c2[5])
                    SetDN_fn(p_ctrl2, 'AetherPlayer', None)
                    if icon_path and os.path.exists(icon_path):
                        SetIP_fn = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_void_p)(vt_c2[6])
                        SetIP_fn(p_ctrl2, icon_path, None)
    except Exception:
        pass

def start_audio_session_monitor(icon_path):
    def loop():
        while True:
            try:
                rename_windows_audio_sessions(icon_path)
            except Exception:
                pass
            time.sleep(1.5)
    t = threading.Thread(target=loop, daemon=True)
    t.start()

def start_global_media_key_listener(window):
    try:
        from pynput import keyboard
        def on_press(key):
            try:
                if key == keyboard.Key.media_play_pause:
                    window.evaluate_js("if (typeof togglePlayPause === 'function') togglePlayPause();")
                elif key == keyboard.Key.media_next:
                    window.evaluate_js("if (typeof playNext === 'function') playNext();")
                elif key == keyboard.Key.media_previous:
                    window.evaluate_js("if (typeof playPrev === 'function') playPrev();")
                elif getattr(key, 'name', '') == 'media_volume_mute':
                    window.evaluate_js("if (typeof toggleMute === 'function') toggleMute();")
            except Exception:
                pass

        listener = keyboard.Listener(on_press=on_press)
        listener.daemon = True
        listener.start()
        print("Global keyboard media keys listener started.")
        return listener
    except Exception as e:
        print("Note: Could not start global keyboard media key listener:", e)
        return None

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
    script_dir = os.path.dirname(os.path.abspath(__file__))
    icon_path = os.path.join(script_dir, 'icon.ico')

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

        def on_app_ready():
            # Brand WebView2 audio session as AetherPlayer with its icon in Volume Mixer
            start_audio_session_monitor(icon_path)
            # Enable hardware keyboard media keys (Play/Pause, Next, Prev) globally
            start_global_media_key_listener(window)

        # Start webview loop with private_mode=False so Chromium passes full MediaSession metadata to Windows SMTC
        webview.start(on_app_ready, private_mode=False, icon=icon_path if os.path.exists(icon_path) else None)
        print("Desktop window closed.")
        return
    except ImportError:
        print("pywebview library not found. Falling back to browser app mode...")
    except Exception as e:
        print("Error launching pywebview window, falling back:", e)

    # 2. Second choice: Open in standalone Application Mode using Chrome/Edge/Brave
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
        browser_process = subprocess.Popen([browser_path, f"--app=http://localhost:{ACTIVE_PORT}"])
        browser_process.wait()
        print("App window closed.")
    else:
        # 3. Third choice: Fallback to standard web browser tab
        import webbrowser
        print("No native window wrapper found. Opening in default browser tab...")
        webbrowser.open(f"http://localhost:{ACTIVE_PORT}")
        time.sleep(5)

def main():
    try:
        start_server()
        launch_desktop()
    except Exception as e:
        print("Error launching desktop app:", e)
    finally:
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

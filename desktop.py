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
        '--enable-features=HardwareMediaKeyHandling,MediaSessionService',
        '--disk-cache-size=33554432',
        '--media-cache-size=33554432'
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

def rename_windows_audio_sessions(icon_path, app_pids=None):
    """Ensure the active WebView2 audio session is branded as AetherPlayer with its icon in the Volume Mixer."""
    if sys.platform != 'win32':
        return False
    branded_any = False
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
            return False

        vt_enum = ctypes.cast(p_enum, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        GetDefaultEndpoint_fn = ctypes.WINFUNCTYPE(
            ctypes.c_long, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)
        )(vt_enum[4])

        p_device = ctypes.c_void_p()
        if GetDefaultEndpoint_fn(p_enum, 0, 1, ctypes.byref(p_device)) != 0 or not p_device:
            return False

        vt_dev = ctypes.cast(p_device, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        Activate_fn = ctypes.WINFUNCTYPE(
            ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(GUID), wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)
        )(vt_dev[3])

        p_mgr = ctypes.c_void_p()
        if Activate_fn(p_device, ctypes.byref(iid_mgr), 1, None, ctypes.byref(p_mgr)) != 0 or not p_mgr:
            return False

        vt_mgr = ctypes.cast(p_mgr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        GetSessionEnum_fn = ctypes.WINFUNCTYPE(
            ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)
        )(vt_mgr[5])

        p_sess_enum = ctypes.c_void_p()
        if GetSessionEnum_fn(p_mgr, ctypes.byref(p_sess_enum)) != 0 or not p_sess_enum:
            return False

        vt_se = ctypes.cast(p_sess_enum, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        GetCount_fn = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int))(vt_se[3])
        GetSession_fn = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p))(vt_se[4])

        count = ctypes.c_int(0)
        GetCount_fn(p_sess_enum, ctypes.byref(count))

        if app_pids is None:
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
                    branded_any = True
    except Exception:
        pass
    return branded_any

def start_audio_session_monitor(icon_path):
    def loop():
        pids_cache = None
        last_pid_scan = 0
        consecutive_success = 0
        while True:
            try:
                now = time.time()
                if pids_cache is None or (now - last_pid_scan) > 20.0:
                    pids_cache = get_process_tree_pids(os.getpid())
                    last_pid_scan = now
                branded = rename_windows_audio_sessions(icon_path, app_pids=pids_cache)
                if branded:
                    consecutive_success += 1
                else:
                    consecutive_success = 0
            except Exception:
                pass
            time.sleep(8.0 if consecutive_success >= 2 else 2.0)
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

def log_tb(msg):
    try:
        line = f"{time.strftime('%H:%M:%S')} {msg}"
        print(f"[AetherTaskbar] {line}", flush=True)
        log_dir = os.path.dirname(os.path.abspath(sys.executable if getattr(sys, 'frozen', False) else __file__))
        with open(os.path.join(log_dir, 'taskbar_debug.log'), 'a', encoding='utf-8') as f:
            f.write(line + "\n")
            f.flush()
    except Exception:
        pass

_taskbar_toolbar_initialized = False
_global_subclass_cb = None

def start_taskbar_thumbnail_toolbar(window):
    """Attach native Windows Taskbar Thumbnail Toolbar buttons ([Prev] [Play/Pause] [Next])
    to AetherPlayer's native window frame (ITaskbarList3::ThumbBarAddButtons)."""
    global _taskbar_toolbar_initialized
    if sys.platform != 'win32' or _taskbar_toolbar_initialized:
        return
    _taskbar_toolbar_initialized = True

    def run_setup():
        log_tb("run_setup started")
        try:
            import ctypes
            from ctypes import wintypes
            import webview.platforms.winforms as wf
            import System
            import System.Drawing as SD
            from System.Drawing.Drawing2D import SmoothingMode
            import traceback

            user32 = ctypes.windll.user32
            comctl32 = ctypes.windll.comctl32
            ole32 = ctypes.windll.ole32

            # Ensure thread is bound to interactive Windows desktop station so Explorer shell APIs succeed
            h_winsta = user32.OpenWindowStationW('WinSta0', False, 0x10000000)
            if h_winsta:
                user32.SetProcessWindowStation(h_winsta)
            h_desk = user32.OpenDesktopW('Default', 0, False, 0x10000000)
            if h_desk:
                user32.SetThreadDesktop(h_desk)

            ole32.CoInitialize(None)

            comctl32.DefSubclassProc.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
            comctl32.DefSubclassProc.restype = ctypes.c_ssize_t

            SUBCLASSPROC = ctypes.WINFUNCTYPE(
                ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM, ctypes.c_size_t, ctypes.c_size_t
            )

            class THUMBBUTTON(ctypes.Structure):
                _fields_ = [
                    ('dwMask', wintypes.DWORD),      # THB_ICON | THB_TOOLTIP | THB_FLAGS
                    ('iId', wintypes.UINT),
                    ('iBitmap', wintypes.UINT),
                    ('hIcon', wintypes.HICON),
                    ('szTip', wintypes.WCHAR * 260),
                    ('dwFlags', wintypes.DWORD)
                ]

            class GUID(ctypes.Structure):
                _fields_ = [
                    ('Data1', wintypes.DWORD),
                    ('Data2', wintypes.WORD),
                    ('Data3', wintypes.WORD),
                    ('Data4', ctypes.c_byte * 8)
                ]

            def _get_guid(s):
                g = GUID()
                ole32.IIDFromString(ctypes.c_wchar_p(s), ctypes.byref(g))
                return g

            CLSID_TaskbarList = _get_guid('{56FDF344-FD6D-11D0-958A-006097C9A090}')
            IID_ITaskbarList3 = _get_guid('{EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF}')

            p_tb = ctypes.c_void_p()
            hr_create = ole32.CoCreateInstance(
                ctypes.byref(CLSID_TaskbarList), None, 1, ctypes.byref(IID_ITaskbarList3), ctypes.byref(p_tb)
            )
            if hr_create != 0 or not p_tb:
                print(f"Note: CoCreateInstance for ITaskbarList3 returned {hex(hr_create & 0xffffffff)}")
                return

            vt = ctypes.cast(p_tb, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents

            # Vtable indices: 15 is ThumbBarAddButtons, 16 is ThumbBarUpdateButtons
            AddButtons_fn = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_void_p, wintypes.HWND, wintypes.UINT, ctypes.POINTER(THUMBBUTTON)
            )(vt[15])
            UpdateButtons_fn = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_void_p, wintypes.HWND, wintypes.UINT, ctypes.POINTER(THUMBBUTTON)
            )(vt[16])

            def create_media_icon(icon_type, size=20):
                bmp = SD.Bitmap(size, size)
                g = SD.Graphics.FromImage(bmp)
                g.SmoothingMode = SmoothingMode.AntiAlias
                g.Clear(SD.Color.Transparent)
                brush = SD.SolidBrush(SD.Color.FromArgb(245, 245, 245))
                if icon_type == 'play':
                    pts = [SD.PointF(5.0, 3.0), SD.PointF(5.0, 17.0), SD.PointF(16.5, 10.0)]
                    g.FillPolygon(brush, pts)
                elif icon_type == 'pause':
                    g.FillRectangle(brush, SD.RectangleF(4.0, 3.5, 3.5, 13.0))
                    g.FillRectangle(brush, SD.RectangleF(12.5, 3.5, 3.5, 13.0))
                elif icon_type == 'prev':
                    g.FillRectangle(brush, SD.RectangleF(3.0, 3.5, 2.5, 13.0))
                    pts = [SD.PointF(17.0, 3.5), SD.PointF(17.0, 16.5), SD.PointF(6.0, 10.0)]
                    g.FillPolygon(brush, pts)
                elif icon_type == 'next':
                    pts = [SD.PointF(3.0, 3.5), SD.PointF(3.0, 16.5), SD.PointF(14.0, 10.0)]
                    g.FillPolygon(brush, pts)
                    g.FillRectangle(brush, SD.RectangleF(14.5, 3.5, 2.5, 13.0))
                g.Dispose()
                brush.Dispose()
                return int(bmp.GetHicon().ToInt64())

            h_prev = create_media_icon('prev')
            h_play = create_media_icon('play')
            h_pause = create_media_icon('pause')
            h_next = create_media_icon('next')

            # Wait for WinForms Form to be ready and visible
            form = None
            for _ in range(120):
                if hasattr(window, 'native') and window.native:
                    form = window.native
                    break
                elif hasattr(wf, 'BrowserView') and window.uid in wf.BrowserView.instances:
                    form = wf.BrowserView.instances[window.uid]
                    break
                time.sleep(0.1)

            if not form:
                log_tb("Could not find Form after waiting")
                return

            hwnd = int(form.Handle.ToInt64())
            log_tb(f"Found Form HWND: {hex(hwnd)}")

            # Allow WM_COMMAND (0x0111) through UIPI in case process is elevated
            try:
                user32.ChangeWindowMessageFilterEx(hwnd, 0x0111, 1, None)
            except Exception:
                pass

            is_playing_state = [False]
            tb_lock = threading.Lock()

            def update_play_button_ui(is_playing):
                try:
                    with tb_lock:
                        btn = (THUMBBUTTON * 1)()
                        btn[0].dwMask = 0x2 | 0x4 | 0x8  # THB_ICON | THB_TOOLTIP | THB_FLAGS
                        btn[0].iId = 102
                        btn[0].hIcon = h_pause if is_playing else h_play
                        btn[0].szTip = 'Pause' if is_playing else 'Play'
                        btn[0].dwFlags = 0
                        UpdateButtons_fn(p_tb, hwnd, 1, btn)
                        is_playing_state[0] = is_playing
                except Exception:
                    pass

            # Dispatch JS actions on a worker thread to prevent deadlocking the WinForms UI thread
            def dispatch_action(action_type):
                def _worker():
                    try:
                        if action_type == 'prev':
                            window.evaluate_js("if (typeof playPrev === 'function') playPrev();")
                        elif action_type == 'play_pause':
                            new_state = not is_playing_state[0]
                            update_play_button_ui(new_state)
                            window.evaluate_js("if (typeof togglePlayPause === 'function') togglePlayPause();")
                        elif action_type == 'next':
                            window.evaluate_js("if (typeof playNext === 'function') playNext();")
                    except Exception as ex:
                        log_tb(f"Error in dispatch_action {action_type}: {ex}")
                threading.Thread(target=_worker, daemon=True).start()

            # Subclass procedure to handle THBN_CLICKED
            def thumbar_subclass_proc(h, msg, wparam, lparam, uid, refdata):
                if msg == 0x0111: # WM_COMMAND
                    hi = (wparam >> 16) & 0xFFFF
                    lo = wparam & 0xFFFF
                    if hi == 0x1800: # THBN_CLICKED
                        log_tb(f"Thumbnail button clicked: ID {lo}")
                        if lo == 101: # Previous
                            dispatch_action('prev')
                        elif lo == 102: # Play / Pause
                            dispatch_action('play_pause')
                        elif lo == 103: # Next
                            dispatch_action('next')
                        return 0
                return comctl32.DefSubclassProc(h, msg, wparam, lparam)

            global _global_subclass_cb
            cb = SUBCLASSPROC(thumbar_subclass_proc)
            _global_subclass_cb = cb
            form._thumbar_subclass_cb = cb
            try:
                form.Invoke(System.Action(lambda: comctl32.SetWindowSubclass(hwnd, cb, 101, 0)))
                log_tb("Subclass attached via form.Invoke")
            except Exception as e:
                comctl32.SetWindowSubclass(hwnd, cb, 101, 0)
                log_tb(f"Subclass attached directly: {e}")

            # Build initial buttons: [Prev (101)] [Play (102)] [Next (103)]
            btns = (THUMBBUTTON * 3)()
            btns[0].dwMask = 0x2 | 0x4 | 0x8
            btns[0].iId = 101
            btns[0].hIcon = h_prev
            btns[0].szTip = 'Previous Track'
            btns[0].dwFlags = 0

            btns[1].dwMask = 0x2 | 0x4 | 0x8
            btns[1].iId = 102
            btns[1].hIcon = h_play
            btns[1].szTip = 'Play'
            btns[1].dwFlags = 0

            btns[2].dwMask = 0x2 | 0x4 | 0x8
            btns[2].iId = 103
            btns[2].hIcon = h_next
            btns[2].szTip = 'Next Track'
            btns[2].dwFlags = 0

            # Attach buttons once window is mapped to Explorer taskbar
            buttons_added = False
            for attempt in range(25):
                # Ensure desktop is still set
                if h_desk:
                    user32.SetThreadDesktop(h_desk)
                hr = AddButtons_fn(p_tb, hwnd, 3, btns)
                log_tb(f"Attempt {attempt}: AddButtons hr = {hex(hr & 0xffffffff)}")
                if hr == 0:
                    buttons_added = True
                    log_tb("Windows Taskbar Thumbnail Toolbar buttons attached successfully.")
                    print("Windows Taskbar Thumbnail Toolbar buttons attached successfully.")
                    break
                time.sleep(0.3)

            if not buttons_added:
                log_tb(f"Could not attach taskbar thumbnail buttons: {hex(hr & 0xffffffff)}")
                print(f"Note: Could not attach taskbar thumbnail buttons (shell returned {hex(hr & 0xffffffff)}).")
                return

            # Background synchronization loop to keep Play/Pause icon in sync with player state
            def sync_loop():
                while True:
                    time.sleep(1.0)
                    try:
                        val = window.evaluate_js("!!(window.__aether_is_playing || (window.audio && !window.audio.paused) || (window.audioA && !window.audioA.paused));")
                        is_playing = bool(val)
                        if is_playing != is_playing_state[0]:
                            update_play_button_ui(is_playing)
                    except Exception:
                        pass

            sync_thread = threading.Thread(target=sync_loop, daemon=True)
            sync_thread.start()

        except Exception as e:
            log_tb(f"Exception in run_setup: {traceback.format_exc()}")
            print("Note: Could not initialize taskbar thumbnail toolbar:", e)

    t = threading.Thread(target=run_setup, daemon=True)
    t.start()


DEFAULT_START_PORT = 38241
ACTIVE_PORT = DEFAULT_START_PORT
SERVER_PROCESS = None

def is_port_in_use(port):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.08)
            return s.connect_ex(('127.0.0.1', port)) == 0
    except Exception:
        return False

def is_aether_server(port):
    """Check if the service on the port is genuinely an AetherPlayer server."""
    import urllib.request
    import json
    try:
        req = urllib.request.Request(f'http://127.0.0.1:{port}/api/ping', headers={'User-Agent': 'AetherDesktop'})
        with urllib.request.urlopen(req, timeout=0.3) as res:
            if res.status == 200:
                data = json.loads(res.read().decode('utf-8'))
                return data.get('app') == 'AetherPlayer'
    except Exception:
        pass
    return False

def determine_active_port(start_port=38241, max_scan=5):
    # Ultra-fast check: if default port is free, use it immediately without scanning
    if not is_port_in_use(start_port):
        return start_port, False
    if is_aether_server(start_port):
        print(f"Discovered already running AetherPlayer instance on port {start_port}")
        return start_port, True

    # Otherwise scan next few ports
    for p in range(start_port + 1, start_port + max_scan):
        if is_port_in_use(p):
            if is_aether_server(p):
                print(f"Discovered already running AetherPlayer instance on port {p}")
                return p, True
        else:
            return p, False

    # Fallback: OS assigned dynamic port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
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
    script_dir = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    icon_path = os.path.join(script_dir, 'icon.ico')
    if not os.path.exists(icon_path):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        fallback = os.path.join(exe_dir, 'icon.ico')
        if os.path.exists(fallback):
            icon_path = fallback

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
            # Attach native Windows Taskbar Thumbnail Toolbar buttons ([⏮] [⏯] [⏭])
            start_taskbar_thumbnail_toolbar(window)

        # Trigger toolbar attachment when the native form is shown or on app ready
        window.events.shown += lambda: start_taskbar_thumbnail_toolbar(window)

        # Notify frontend to throttle/suspend animations and RAF loops when minimized
        try:
            window.events.minimized += lambda: window.evaluate_js("if (typeof window.setAppVisibilityState === 'function') window.setAppVisibilityState(false);")
            window.events.restored += lambda: window.evaluate_js("if (typeof window.setAppVisibilityState === 'function') window.setAppVisibilityState(true);")
            window.events.maximized += lambda: window.evaluate_js("if (typeof window.setAppVisibilityState === 'function') window.setAppVisibilityState(true);")
            window.events.shown += lambda: window.evaluate_js("if (typeof window.setAppVisibilityState === 'function') window.setAppVisibilityState(true);")
        except Exception:
            pass

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
    import multiprocessing
    multiprocessing.freeze_support()
    main()

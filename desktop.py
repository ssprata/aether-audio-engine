import os
import sys
import time
import socket
import subprocess

PORT = 3000
SERVER_PROCESS = None

def is_port_in_use(port):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            return s.connect_ex(('localhost', port)) == 0
    except Exception:
        return False

def start_server():
    global SERVER_PROCESS
    if not is_port_in_use(PORT):
        print("Starting AetherPlayer server...")
        script_dir = os.path.dirname(os.path.abspath(__file__))
        server_path = os.path.join(script_dir, 'server.py')
        
        # Start server in the background
        SERVER_PROCESS = subprocess.Popen([sys.executable, server_path], cwd=script_dir)
        
        # Wait a moment for server to bind
        for _ in range(15):
            if is_port_in_use(PORT):
                print("Server started successfully.")
                break
            time.sleep(0.2)
    else:
        print("AetherPlayer server is already running.")

def launch_desktop():
    # 1. First choice: Use native system WebView (via pywebview) if available
    try:
        import webview
        print("Launching native desktop window frame (Edge WebView2)...")
        
        # Create webview window
        window = webview.create_window(
            title='AetherPlayer',
            url=f'http://localhost:{PORT}',
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
        browser_process = subprocess.Popen([browser_path, f"--app=http://localhost:{PORT}"])
        browser_process.wait()
        print("App window closed.")
    else:
        # 3. Third choice: Fallback to standard web browser tab
        import webbrowser
        print("No native window wrapper found. Opening in default browser tab...")
        webbrowser.open(f"http://localhost:{PORT}")
        # Keep launcher process alive for a bit so they can see the tab open
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

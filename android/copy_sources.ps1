# PowerShell script to sync python server & web views into Android Chaquopy folder before compiling
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Resolve-Path "$ScriptDir\.."

$AndroidPythonDir = "$ScriptDir\app\src\main\python"

# Create destination folder if not exists
if (!(Test-Path $AndroidPythonDir)) {
    New-Item -ItemType Directory -Force -Path $AndroidPythonDir
}

Write-Host "Syncing files into Android build folder..." -ForegroundColor Cyan

# Copy server.py
Copy-Item "$ProjectRoot\server.py" "$AndroidPythonDir\server.py" -Force

# Copy public folder recursively
if (Test-Path "$AndroidPythonDir\public") {
    Remove-Item "$AndroidPythonDir\public" -Recurse -Force
}
Copy-Item "$ProjectRoot\public" "$AndroidPythonDir\public" -Recurse -Force

Write-Host "Sync complete! You can now compile the app in Android Studio or using Gradle." -ForegroundColor Green

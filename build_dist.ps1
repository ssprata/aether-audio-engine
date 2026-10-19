# Script to build both onedir and standalone onefile executables into dist/
$ErrorActionPreference = "Stop"

Write-Host "Closing any running AetherPlayer processes..." -ForegroundColor Cyan
Stop-Process -Name "AetherPlayer" -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

Write-Host "Building AetherPlayer directory distribution..." -ForegroundColor Cyan
pyinstaller AetherPlayer.spec --noconfirm

Write-Host "Building AetherPlayer standalone executable..." -ForegroundColor Cyan
pyinstaller AetherPlayer_onefile.spec --distpath dist_onefile --workpath build_onefile --noconfirm

Write-Host "Updating dist/AetherPlayer.exe..." -ForegroundColor Cyan
Copy-Item -Force dist_onefile\AetherPlayer.exe dist\AetherPlayer.exe
Remove-Item -Recurse -Force dist_onefile
Remove-Item -Recurse -Force build_onefile

Write-Host "Updating portable zip archives..." -ForegroundColor Cyan
Compress-Archive -Path "dist\AetherPlayer\*" -DestinationPath "dist\AetherPlayer-portable-windows-x64.zip" -Force
Compress-Archive -Path "dist\AetherPlayer.exe" -DestinationPath "dist\AetherPlayer-windows-x64.zip" -Force

Write-Host "Done! Dist executables and archives are up to date." -ForegroundColor Green

# AetherPlayer Android Packaging Guide

This directory contains a complete native Android Studio + Chaquopy wrapper project that allows running both the Python server backend and the HTML5 web frontend inside a single, standalone Android APK. 

No separate Python runner, Termux, or command-line utilities are required on the phone. Opening the app boots the Python server in a background thread and loads the player interface inside a full-screen WebView.

## How it works
1. **Chaquopy**: A Python runtime SDK for Android that embeds Python 3.10 and packages external pip dependencies (`ytmusicapi`) inside the APK.
2. **Localhost Binding**: On launch, the Kotlin launcher (`MainActivity.kt`) starts the Python backend, binds it to `localhost:3000`, and opens the user interface once ready.
3. **Writeable Storage**: The server automatically redirects uploads, settings, and backing stores to the safe writeable Android app internal storage.

---

## Build Requirements
- **Android Studio** (Koala or newer)
- An active Internet connection (to download Gradle dependencies, Python SDK, and `ytmusicapi` pip module during compile).

---

## Compilation Steps

There are two ways to compile this project into an APK: **Option A (The Cloud - Recommended)** which requires no installation, and **Option B (Local Build)** using Android Studio.

### Option A: Compile in the Cloud (No Installation Required) 🚀
We have configured a GitHub Actions CI/CD workflow at `.github/workflows/android.yml`.
If you push this repository to your GitHub account:
1. Go to the **Actions** tab of your GitHub repository.
2. Select **Build Android APK** in the left sidebar.
3. Click the **Run workflow** dropdown on the right and click the green button.
4. Once completed (takes ~3 minutes), click on the successful run, scroll down to the **Artifacts** section, and click on **AetherPlayer-Android-APK** to download your ready-to-install APK file!

---

### Option B: Local Build (Using Android Studio)
#### Step 1: Sync Current Sources
If you make code updates in the root workspace folder, always run the synchronization script to copy files into the Android app asset folder first:
- Double-click or run the PowerShell script:
  ```powershell
  powershell -ExecutionPolicy Bypass -File .\copy_sources.ps1
  ```
*(Note: We have already run this sync for you; the current files are populated).*

#### Step 2: Open Project in Android Studio
1. Launch **Android Studio**.
2. Select **Open** (or **File > Open**).
3. Navigate to and select the `android` folder in this workspace:
   `F:\Sprata\Apps\Multi-music-tool\android`
4. Wait for Android Studio to index, download the Android SDK platform toolchains, and complete the Gradle build configuration sync.

#### Step 3: Build the APK
1. In the top menu, go to **Build > Build Bundle(s) / APK(s) > Build APK(s)**.
2. Android Studio will download the Python 3.10 runtime packages and build the APK.
3. Once the build completes, a notification will appear on the bottom right. Click **locate** to open the output folder in Windows Explorer.
4. Alternatively, find the compiled APK at:
   `android\app\build\outputs\apk\debug\app-debug.apk`

---

## Installing on your Phone
1. Transfer the `app-debug.apk` file to your Android device (via USB, email, or cloud drive).
2. Open the file manager on your phone, select the APK, and install it.
3. *(If prompted, enable "Install from Unknown Sources" in settings).*
4. Launch **AetherPlayer** from your app drawer. It will run completely locally on the device!

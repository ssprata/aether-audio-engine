package com.aetherplayer.music

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.net.Socket
import kotlin.concurrent.thread

class BackgroundAudioWebView(context: Context) : WebView(context) {
    override fun onWindowVisibilityChanged(visibility: Int) {
        // Prevent Chromium from pausing YouTube iframe media when screen is locked/minimized
        super.onWindowVisibilityChanged(View.VISIBLE)
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, View.VISIBLE)
    }

    override fun dispatchWindowVisibilityChanged(visibility: Int) {
        super.dispatchWindowVisibilityChanged(View.VISIBLE)
    }
}

class MainActivity : AppCompatActivity() {

    companion object {
        var instance: MainActivity? = null
    }

    private lateinit var webView: BackgroundAudioWebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        instance = this
        
        // Request Notification permission on Android 13+ (API 33+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 101)
            }
        }

        // Request system audio focus to keep audio channel open during screen-off
        try {
            val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val playbackAttributes = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
                val focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(playbackAttributes)
                    .setAcceptsDelayedFocusGain(true)
                    .setOnAudioFocusChangeListener { }
                    .build()
                audioManager.requestAudioFocus(focusRequest)
            } else {
                @Suppress("DEPRECATION")
                audioManager.requestAudioFocus({ }, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }

        // Start Foreground Notification Service
        MediaPlaybackService.start(this)

        // Initialize Python runtime inside Android context
        if (!Python.isStarted()) {
            Python.start(AndroidPlatform(this))
        }

        // Start Python server inside background thread
        thread {
            try {
                val py = Python.getInstance()
                val serverModule = py.getModule("server")
                // Start HTTP server on local thread
                serverModule.callAttr("start_android_server")
            } catch (e: Exception) {
                runOnUiThread {
                    Toast.makeText(this, "Failed to start local audio backend: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }

        // Initialize BackgroundAudioWebView layout
        webView = BackgroundAudioWebView(this)
        setContentView(webView)
        setupWebView()

        // Wait for localhost port 3000 to bind, then load
        thread {
            var connected = false
            for (i in 1..30) {
                try {
                    val socket = Socket("localhost", 3000)
                    socket.close()
                    connected = true
                    break
                } catch (e: Exception) {
                    Thread.sleep(200)
                }
            }

            runOnUiThread {
                if (connected) {
                    webView.loadUrl("http://localhost:3000")
                } else {
                    Toast.makeText(this, "AetherPlayer backend timed out.", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        settings.mediaPlaybackRequiresUserGesture = false
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.allowFileAccess = true
        settings.allowContentAccess = true

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        // Expose Native Android Audio Bridge to JavaScript as window.AndroidAudio
        webView.addJavascriptInterface(AudioBridge(this), "AndroidAudio")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                return false // load links inside WebView frame
            }
        }
    }

    fun evaluateJs(script: String) {
        runOnUiThread {
            webView.evaluateJavascript(script, null)
        }
    }

    override fun onResume() {
        super.onResume()
        evaluateJs("if (typeof window.setAppVisibilityState === 'function') window.setAppVisibilityState(true);")
    }

    override fun onPause() {
        super.onPause()
        // Signal JS frontend that screen is off / minimized to stop DOM timers and CSS anims
        evaluateJs("if (typeof window.setAppVisibilityState === 'function') window.setAppVisibilityState(false);")
        // Prevent Chromium from killing background audio execution
        webView.resumeTimers()
    }

    override fun onStop() {
        super.onStop()
        evaluateJs("if (typeof window.setAppVisibilityState === 'function') window.setAppVisibilityState(false);")
        webView.resumeTimers()
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            // Move task to back (minimize) rather than killing the activity, preserving audio playback
            moveTaskToBack(true)
        }
    }

    override fun onDestroy() {
        try {
            MediaPlaybackService.stopPlayback(this)
        } catch (e: Exception) {
            e.printStackTrace()
        }
        super.onDestroy()
    }
}

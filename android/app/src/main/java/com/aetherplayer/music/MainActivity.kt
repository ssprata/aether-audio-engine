package com.aetherplayer.music

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
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

class MainActivity : AppCompatActivity() {

    companion object {
        var instance: MainActivity? = null
    }

    private lateinit var webView: WebView
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        instance = this
        
        // Request Notification permission on Android 13+ (API 33+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 101)
            }
        }

        // Acquire partial wake lock to keep audio playback running when screen is locked
        try {
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "AetherPlayer::AudioPlaybackWakeLock"
            )
            wakeLock?.acquire(24 * 60 * 60 * 1000L) // 24 hours max
        } catch (e: Exception) {
            e.printStackTrace()
        }

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

        // Initialize WebView layout
        webView = WebView(this)
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
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
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

    override fun onPause() {
        super.onPause()
        // Prevent WebView from freezing audio/timers when minimized
        webView.resumeTimers()
    }

    override fun onStop() {
        super.onStop()
        // Prevent WebView from freezing audio/timers when screen turns off
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
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
            MediaPlaybackService.stop(this)
        } catch (e: Exception) {
            e.printStackTrace()
        }
        super.onDestroy()
    }
}

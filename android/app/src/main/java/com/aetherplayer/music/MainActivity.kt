package com.aetherplayer.music

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.net.Socket
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
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

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                return false // load links inside WebView frame
            }
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}

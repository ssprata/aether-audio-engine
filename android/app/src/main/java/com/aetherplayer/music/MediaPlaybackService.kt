package com.aetherplayer.music

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import java.net.URL
import kotlin.concurrent.thread

class MediaPlaybackService : Service() {

    companion object {
        const val CHANNEL_ID = "aether_playback_channel_v3"
        const val NOTIFICATION_ID = 3003

        const val ACTION_UPDATE_TRACK = "com.aetherplayer.action.UPDATE_TRACK"
        const val ACTION_UPDATE_STATE = "com.aetherplayer.action.UPDATE_STATE"
        const val ACTION_PLAY_PAUSE = "com.aetherplayer.action.PLAY_PAUSE"
        const val ACTION_NEXT = "com.aetherplayer.action.NEXT"
        const val ACTION_PREV = "com.aetherplayer.action.PREV"
        const val ACTION_STOP = "com.aetherplayer.action.STOP"

        const val EXTRA_TITLE = "extra_title"
        const val EXTRA_ARTIST = "extra_artist"
        const val EXTRA_ART_URL = "extra_art_url"
        const val EXTRA_IS_PLAYING = "extra_is_playing"

        var instance: MediaPlaybackService? = null

        fun start(context: Context) {
            val intent = Intent(context, MediaPlaybackService::class.java)
            startServiceIntent(context, intent)
        }

        fun updateTrack(context: Context, title: String, artist: String, artUrl: String, isPlaying: Boolean) {
            val intent = Intent(context, MediaPlaybackService::class.java).apply {
                action = ACTION_UPDATE_TRACK
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_ARTIST, artist)
                putExtra(EXTRA_ART_URL, artUrl)
                putExtra(EXTRA_IS_PLAYING, isPlaying)
            }
            startServiceIntent(context, intent)
        }

        fun updateState(context: Context, isPlaying: Boolean) {
            val intent = Intent(context, MediaPlaybackService::class.java).apply {
                action = ACTION_UPDATE_STATE
                putExtra(EXTRA_IS_PLAYING, isPlaying)
            }
            startServiceIntent(context, intent)
        }

        fun stopPlayback(context: Context) {
            val intent = Intent(context, MediaPlaybackService::class.java).apply { action = ACTION_STOP }
            startServiceIntent(context, intent)
        }

        fun stop(context: Context) = stopPlayback(context)

        private fun startServiceIntent(context: Context, intent: Intent) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    private var mediaSession: MediaSession? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: android.net.wifi.WifiManager.WifiLock? = null
    private val handler = Handler(Looper.getMainLooper())

    private var currentTitle = "AetherPlayer"
    private var currentArtist = "Ready to play"
    private var currentArtBitmap: Bitmap? = null
    private var isPlaying = false

    override fun onCreate() {
        super.onCreate()
        instance = this

        try {
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AetherPlayer::ServiceWakeLock")
            wakeLock?.acquire(24 * 60 * 60 * 1000L)

            val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as? android.net.wifi.WifiManager
            wifiLock = wifiManager?.createWifiLock(android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "AetherPlayer::WifiLock")
            wifiLock?.acquire()
        } catch (e: Exception) {
            e.printStackTrace()
        }

        createNotificationChannel()
        setupMediaSession()

        val notification = buildNotification(false)
        startForeground(NOTIFICATION_ID, notification)
    }

    private fun setupMediaSession() {
        mediaSession = MediaSession(this, "AetherMediaSession").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() {
                    MainActivity.instance?.runOnUiThread {
                        MainActivity.instance?.evaluateJs("togglePlayPause()")
                    }
                }

                override fun onPause() {
                    MainActivity.instance?.runOnUiThread {
                        MainActivity.instance?.evaluateJs("togglePlayPause()")
                    }
                }

                override fun onSkipToNext() {
                    MainActivity.instance?.runOnUiThread {
                        MainActivity.instance?.evaluateJs("playNext()")
                    }
                }

                override fun onSkipToPrevious() {
                    MainActivity.instance?.runOnUiThread {
                        MainActivity.instance?.evaluateJs("playPrev()")
                    }
                }
            })
            isActive = true
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Aether Music Playback",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Active music playback controls"
                setShowBadge(false)
                setSound(null, null)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // ALWAYS ensure startForeground is active on every incoming intent
        val notification = buildNotification(isPlaying)
        startForeground(NOTIFICATION_ID, notification)

        when (intent?.action) {
            ACTION_UPDATE_TRACK -> {
                currentTitle = intent.getStringExtra(EXTRA_TITLE) ?: "Aether Track"
                currentArtist = intent.getStringExtra(EXTRA_ARTIST) ?: "Unknown Artist"
                val artUrl = intent.getStringExtra(EXTRA_ART_URL) ?: ""
                isPlaying = intent.getBooleanExtra(EXTRA_IS_PLAYING, true)

                loadAlbumArt(artUrl)
                updateMediaSessionState(if (isPlaying) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED)
            }
            ACTION_UPDATE_STATE -> {
                isPlaying = intent.getBooleanExtra(EXTRA_IS_PLAYING, false)
                updateMediaSessionState(if (isPlaying) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED)
                updateNotification(isPlaying)
            }
            ACTION_PLAY_PAUSE -> {
                MainActivity.instance?.runOnUiThread {
                    MainActivity.instance?.evaluateJs("togglePlayPause()")
                }
            }
            ACTION_NEXT -> {
                MainActivity.instance?.runOnUiThread {
                    MainActivity.instance?.evaluateJs("playNext()")
                }
            }
            ACTION_PREV -> {
                MainActivity.instance?.runOnUiThread {
                    MainActivity.instance?.evaluateJs("playPrev()")
                }
            }
            ACTION_STOP -> {
                stopForeground(true)
                stopSelf()
            }
        }
        return START_STICKY
    }

    private fun loadAlbumArt(url: String) {
        if (url.isBlank()) {
            currentArtBitmap = null
            updateNotification(isPlaying)
            return
        }
        thread {
            try {
                val stream = URL(url).openStream()
                currentArtBitmap = BitmapFactory.decodeStream(stream)
            } catch (e: Exception) {
                currentArtBitmap = null
            }
            handler.post {
                updateNotification(isPlaying)
            }
        }
    }

    private fun updateMediaSessionState(state: Int) {
        val playbackState = PlaybackState.Builder()
            .setActions(
                PlaybackState.ACTION_PLAY or
                PlaybackState.ACTION_PAUSE or
                PlaybackState.ACTION_PLAY_PAUSE or
                PlaybackState.ACTION_SKIP_TO_NEXT or
                PlaybackState.ACTION_SKIP_TO_PREVIOUS
            )
            .setState(state, 0L, 1.0f)
            .build()
        mediaSession?.setPlaybackState(playbackState)
    }

    private fun updateNotification(playing: Boolean) {
        val notification = buildNotification(playing)
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, notification)
    }

    private fun buildNotification(playing: Boolean): Notification {
        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val openAppPendingIntent = PendingIntent.getActivity(
            this,
            0,
            openAppIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val prevIntent = Intent(this, MediaPlaybackService::class.java).apply { action = ACTION_PREV }
        val prevPendingIntent = PendingIntent.getService(this, 1, prevIntent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        val playPauseIntent = Intent(this, MediaPlaybackService::class.java).apply { action = ACTION_PLAY_PAUSE }
        val playPausePendingIntent = PendingIntent.getService(this, 2, playPauseIntent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val playPauseIcon = if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play

        val nextIntent = Intent(this, MediaPlaybackService::class.java).apply { action = ACTION_NEXT }
        val nextPendingIntent = PendingIntent.getService(this, 3, nextIntent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(currentTitle)
            .setContentText(currentArtist)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(openAppPendingIntent)
            .setOngoing(playing)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(NotificationCompat.Action.Builder(android.R.drawable.ic_media_previous, "Previous", prevPendingIntent).build())
            .addAction(NotificationCompat.Action.Builder(playPauseIcon, if (playing) "Pause" else "Play", playPausePendingIntent).build())
            .addAction(NotificationCompat.Action.Builder(android.R.drawable.ic_media_next, "Next", nextPendingIntent).build())

        currentArtBitmap?.let {
            builder.setLargeIcon(it)
        }

        return builder.build()
    }

    override fun onDestroy() {
        mediaSession?.release()
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
            if (wifiLock?.isHeld == true) {
                wifiLock?.release()
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
        instance = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}

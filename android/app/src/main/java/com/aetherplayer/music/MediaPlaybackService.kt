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
import android.media.AudioAttributes
import android.media.MediaPlayer
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

class MediaPlaybackService : Service(), MediaPlayer.OnPreparedListener, MediaPlayer.OnCompletionListener, MediaPlayer.OnErrorListener {

    companion object {
        const val CHANNEL_ID = "aether_playback_channel_v2"
        const val NOTIFICATION_ID = 2002

        const val ACTION_PLAY = "com.aetherplayer.action.PLAY"
        const val ACTION_PAUSE = "com.aetherplayer.action.PAUSE"
        const val ACTION_RESUME = "com.aetherplayer.action.RESUME"
        const val ACTION_NEXT = "com.aetherplayer.action.NEXT"
        const val ACTION_PREV = "com.aetherplayer.action.PREV"
        const val ACTION_SEEK = "com.aetherplayer.action.SEEK"
        const val ACTION_STOP = "com.aetherplayer.action.STOP"
        const val ACTION_SET_VOLUME = "com.aetherplayer.action.SET_VOLUME"

        const val EXTRA_URL = "extra_url"
        const val EXTRA_TITLE = "extra_title"
        const val EXTRA_ARTIST = "extra_artist"
        const val EXTRA_ART_URL = "extra_art_url"
        const val EXTRA_DURATION = "extra_duration"
        const val EXTRA_SEEK_SECS = "extra_seek_secs"
        const val EXTRA_VOLUME = "extra_volume"

        var instance: MediaPlaybackService? = null

        fun play(context: Context, url: String, title: String, artist: String, artUrl: String, durationSec: Double) {
            val intent = Intent(context, MediaPlaybackService::class.java).apply {
                action = ACTION_PLAY
                putExtra(EXTRA_URL, url)
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_ARTIST, artist)
                putExtra(EXTRA_ART_URL, artUrl)
                putExtra(EXTRA_DURATION, durationSec)
            }
            startServiceIntent(context, intent)
        }

        fun pausePlayback(context: Context) {
            val intent = Intent(context, MediaPlaybackService::class.java).apply { action = ACTION_PAUSE }
            startServiceIntent(context, intent)
        }

        fun resumePlayback(context: Context) {
            val intent = Intent(context, MediaPlaybackService::class.java).apply { action = ACTION_RESUME }
            startServiceIntent(context, intent)
        }

        fun seekTo(context: Context, seconds: Double) {
            val intent = Intent(context, MediaPlaybackService::class.java).apply {
                action = ACTION_SEEK
                putExtra(EXTRA_SEEK_SECS, seconds)
            }
            startServiceIntent(context, intent)
        }

        fun setVolume(context: Context, volumePct: Float) {
            val intent = Intent(context, MediaPlaybackService::class.java).apply {
                action = ACTION_SET_VOLUME
                putExtra(EXTRA_VOLUME, volumePct)
            }
            startServiceIntent(context, intent)
        }

        fun stopPlayback(context: Context) {
            val intent = Intent(context, MediaPlaybackService::class.java).apply { action = ACTION_STOP }
            startServiceIntent(context, intent)
        }

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

    private var mediaPlayer: MediaPlayer? = null
    private var mediaSession: MediaSession? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val handler = Handler(Looper.getMainLooper())
    private var progressRunnable: Runnable? = null

    private var currentTitle = "AetherPlayer"
    private var currentArtist = "Ready to play"
    private var currentArtBitmap: Bitmap? = null
    private var currentDurationSec = 0.0
    private var isPlaying = false

    override fun onCreate() {
        super.onCreate()
        instance = this

        try {
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AetherPlayer::ServiceWakeLock")
            wakeLock?.acquire(24 * 60 * 60 * 1000L)
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
                    resumeMedia()
                }

                override fun onPause() {
                    pauseMedia()
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

                override fun onSeekTo(pos: Long) {
                    seekMedia((pos / 1000).toDouble())
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
        when (intent?.action) {
            ACTION_PLAY -> {
                val url = intent.getStringExtra(EXTRA_URL) ?: ""
                currentTitle = intent.getStringExtra(EXTRA_TITLE) ?: "Aether Track"
                currentArtist = intent.getStringExtra(EXTRA_ARTIST) ?: "Unknown Artist"
                val artUrl = intent.getStringExtra(EXTRA_ART_URL) ?: ""
                currentDurationSec = intent.getDoubleExtra(EXTRA_DURATION, 0.0)

                loadAlbumArt(artUrl)
                startAudioPlayback(url)
            }
            ACTION_PAUSE -> pauseMedia()
            ACTION_RESUME -> resumeMedia()
            ACTION_SEEK -> {
                val secs = intent.getDoubleExtra(EXTRA_SEEK_SECS, 0.0)
                seekMedia(secs)
            }
            ACTION_SET_VOLUME -> {
                val vol = intent.getFloatExtra(EXTRA_VOLUME, 1.0f)
                mediaPlayer?.setVolume(vol, vol)
            }
            ACTION_STOP -> stopAudioPlayback()
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

    private fun startAudioPlayback(streamUrl: String) {
        if (streamUrl.isBlank()) return

        stopProgressLoop()
        try {
            if (mediaPlayer == null) {
                mediaPlayer = MediaPlayer().apply {
                    setAudioAttributes(
                        AudioAttributes.Builder()
                            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .build()
                    )
                    setWakeMode(applicationContext, PowerManager.PARTIAL_WAKE_LOCK)
                    setOnPreparedListener(this@MediaPlaybackService)
                    setOnCompletionListener(this@MediaPlaybackService)
                    setOnErrorListener(this@MediaPlaybackService)
                }
            } else {
                mediaPlayer?.reset()
            }

            mediaPlayer?.setDataSource(streamUrl)
            mediaPlayer?.prepareAsync()
        } catch (e: Exception) {
            e.printStackTrace()
            MainActivity.instance?.runOnUiThread {
                MainActivity.instance?.evaluateJs("showToast('Stream error: ${e.message}')")
            }
        }
    }

    override fun onPrepared(mp: MediaPlayer?) {
        mp?.start()
        isPlaying = true
        updateMediaSessionState(PlaybackState.STATE_PLAYING)
        updateNotification(true)
        startProgressLoop()

        MainActivity.instance?.runOnUiThread {
            MainActivity.instance?.evaluateJs("window.onNativeAudioStateChange && window.onNativeAudioStateChange(true)")
        }
    }

    override fun onCompletion(mp: MediaPlayer?) {
        isPlaying = false
        stopProgressLoop()
        updateMediaSessionState(PlaybackState.STATE_PAUSED)
        updateNotification(false)

        MainActivity.instance?.runOnUiThread {
            MainActivity.instance?.evaluateJs("window.onNativeAudioEnded && window.onNativeAudioEnded()")
        }
    }

    override fun onError(mp: MediaPlayer?, what: Int, extra: Int): Boolean {
        isPlaying = false
        stopProgressLoop()
        updateNotification(false)
        MainActivity.instance?.runOnUiThread {
            MainActivity.instance?.evaluateJs("showToast('Playback error, skipping track...'); setTimeout(playNext, 1200);")
        }
        return true
    }

    private fun pauseMedia() {
        if (mediaPlayer?.isPlaying == true) {
            mediaPlayer?.pause()
            isPlaying = false
            stopProgressLoop()
            updateMediaSessionState(PlaybackState.STATE_PAUSED)
            updateNotification(false)
            MainActivity.instance?.runOnUiThread {
                MainActivity.instance?.evaluateJs("window.onNativeAudioStateChange && window.onNativeAudioStateChange(false)")
            }
        }
    }

    private fun resumeMedia() {
        if (mediaPlayer != null && !mediaPlayer!!.isPlaying) {
            mediaPlayer?.start()
            isPlaying = true
            updateMediaSessionState(PlaybackState.STATE_PLAYING)
            updateNotification(true)
            startProgressLoop()
            MainActivity.instance?.runOnUiThread {
                MainActivity.instance?.evaluateJs("window.onNativeAudioStateChange && window.onNativeAudioStateChange(true)")
            }
        }
    }

    private fun seekMedia(seconds: Double) {
        mediaPlayer?.let {
            val targetMs = (seconds * 1000).toInt()
            it.seekTo(targetMs)
        }
    }

    private fun stopAudioPlayback() {
        stopProgressLoop()
        mediaPlayer?.stop()
        mediaPlayer?.release()
        mediaPlayer = null
        isPlaying = false
        updateNotification(false)
        stopForeground(false)
    }

    private fun startProgressLoop() {
        stopProgressLoop()
        progressRunnable = object : Runnable {
            override fun run() {
                mediaPlayer?.let { mp ->
                    if (mp.isPlaying) {
                        val currentMs = mp.currentPosition
                        val totalMs = if (mp.duration > 0) mp.duration else (currentDurationSec * 1000).toInt()
                        val currentSec = currentMs / 1000.0
                        val totalSec = totalMs / 1000.0

                        MainActivity.instance?.runOnUiThread {
                            MainActivity.instance?.evaluateJs("window.onNativeAudioProgress && window.onNativeAudioProgress($currentSec, $totalSec)")
                        }
                    }
                }
                handler.postDelayed(this, 500)
            }
        }
        handler.post(progressRunnable!!)
    }

    private fun stopProgressLoop() {
        progressRunnable?.let { handler.removeCallbacks(it) }
        progressRunnable = null
    }

    private fun updateMediaSessionState(state: Int) {
        val playbackState = PlaybackState.Builder()
            .setActions(
                PlaybackState.ACTION_PLAY or
                PlaybackState.ACTION_PAUSE or
                PlaybackState.ACTION_PLAY_PAUSE or
                PlaybackState.ACTION_SKIP_TO_NEXT or
                PlaybackState.ACTION_SKIP_TO_PREVIOUS or
                PlaybackState.ACTION_SEEK_TO
            )
            .setState(state, mediaPlayer?.currentPosition?.toLong() ?: 0L, 1.0f)
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

        val playPauseAction = if (playing) {
            val pauseIntent = Intent(this, MediaPlaybackService::class.java).apply { action = ACTION_PAUSE }
            val pausePendingIntent = PendingIntent.getService(this, 2, pauseIntent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            NotificationCompat.Action.Builder(android.R.drawable.ic_media_pause, "Pause", pausePendingIntent).build()
        } else {
            val resumeIntent = Intent(this, MediaPlaybackService::class.java).apply { action = ACTION_RESUME }
            val resumePendingIntent = PendingIntent.getService(this, 2, resumeIntent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            NotificationCompat.Action.Builder(android.R.drawable.ic_media_play, "Play", resumePendingIntent).build()
        }

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
            .addAction(playPauseAction)
            .addAction(NotificationCompat.Action.Builder(android.R.drawable.ic_media_next, "Next", nextPendingIntent).build())

        currentArtBitmap?.let {
            builder.setLargeIcon(it)
        }

        return builder.build()
    }

    override fun onDestroy() {
        stopAudioPlayback()
        mediaSession?.release()
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
        instance = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}

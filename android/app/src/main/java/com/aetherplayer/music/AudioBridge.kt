package com.aetherplayer.music

import android.webkit.JavascriptInterface

class AudioBridge(private val activity: MainActivity) {

    @JavascriptInterface
    fun play(streamUrl: String, title: String, artist: String, artUrl: String, durationSec: Double) {
        activity.runOnUiThread {
            MediaPlaybackService.play(activity, streamUrl, title, artist, artUrl, durationSec)
        }
    }

    @JavascriptInterface
    fun pause() {
        activity.runOnUiThread {
            MediaPlaybackService.pausePlayback(activity)
        }
    }

    @JavascriptInterface
    fun resume() {
        activity.runOnUiThread {
            MediaPlaybackService.resumePlayback(activity)
        }
    }

    @JavascriptInterface
    fun seekTo(seconds: Double) {
        activity.runOnUiThread {
            MediaPlaybackService.seekTo(activity, seconds)
        }
    }

    @JavascriptInterface
    fun setVolume(volumePct: Float) {
        activity.runOnUiThread {
            MediaPlaybackService.setVolume(activity, volumePct)
        }
    }

    @JavascriptInterface
    fun stop() {
        activity.runOnUiThread {
            MediaPlaybackService.stopPlayback(activity)
        }
    }
}

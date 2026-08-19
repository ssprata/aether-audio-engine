package com.aetherplayer.music

import android.webkit.JavascriptInterface

class AudioBridge(private val activity: MainActivity) {

    @JavascriptInterface
    fun updateMetadata(title: String, artist: String, artUrl: String, isPlaying: Boolean) {
        activity.runOnUiThread {
            MediaPlaybackService.updateTrack(activity, title, artist, artUrl, isPlaying)
        }
    }

    @JavascriptInterface
    fun updatePlaybackState(isPlaying: Boolean) {
        activity.runOnUiThread {
            MediaPlaybackService.updateState(activity, isPlaying)
        }
    }

    @JavascriptInterface
    fun stop() {
        activity.runOnUiThread {
            MediaPlaybackService.stopPlayback(activity)
        }
    }
}

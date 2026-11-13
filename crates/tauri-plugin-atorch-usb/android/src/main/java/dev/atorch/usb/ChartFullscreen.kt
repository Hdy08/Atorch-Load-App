package dev.atorch.usb

import android.content.pm.ActivityInfo
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/** Window UI only: fullscreen never changes a USB/BLE or recording session. */
internal class ChartFullscreen(private val activity: AppCompatActivity) {
    private data class Previous(val orientation: Int, val behavior: Int, val status: Boolean, val navigation: Boolean)
    private var previous: Previous? = null
    private var webView: WebView? = null
    private val back = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            setEnabled(false)
            webView?.evaluateJavascript("window.dispatchEvent(new Event('atorch-chart-fullscreen-exit'))", null)
        }
    }

    init { activity.onBackPressedDispatcher.addCallback(activity, back) }

    fun load(view: WebView) {
        setEnabled(false)
        webView = view
    }

    fun setEnabled(enabled: Boolean) {
        val window = activity.window
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        if (enabled) {
            if (previous == null) {
                val insets = ViewCompat.getRootWindowInsets(window.decorView)
                previous = Previous(activity.requestedOrientation, controller.systemBarsBehavior,
                    insets?.isVisible(WindowInsetsCompat.Type.statusBars()) ?: true,
                    insets?.isVisible(WindowInsetsCompat.Type.navigationBars()) ?: true)
            }
            back.isEnabled = true
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            hideBars()
        } else {
            val saved = previous ?: return
            previous = null
            back.isEnabled = false
            controller.systemBarsBehavior = saved.behavior
            if (saved.status) controller.show(WindowInsetsCompat.Type.statusBars())
            else controller.hide(WindowInsetsCompat.Type.statusBars())
            if (saved.navigation) controller.show(WindowInsetsCompat.Type.navigationBars())
            else controller.hide(WindowInsetsCompat.Type.navigationBars())
            activity.requestedOrientation = saved.orientation
        }
    }

    fun resume() { if (previous != null) hideBars() }

    private fun hideBars() {
        val window = activity.window
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    fun destroy() {
        setEnabled(false)
        back.remove()
        webView = null
    }
}

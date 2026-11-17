package dev.atorch.load

import android.os.Bundle
import android.content.res.Configuration
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.settings.setSupportZoom(false)
    webView.settings.builtInZoomControls = false
    webView.settings.displayZoomControls = false
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Fit the WebView itself inside visible system bars. CSS safe-area values
    // are not reliably populated by Android WebView on edge-to-edge targets.
    val content = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(content)
    updateStatusBar(resources.configuration)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    updateStatusBar(newConfig)
  }

  override fun onResume() {
    super.onResume()
    if (resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) {
      updateStatusBar(resources.configuration)
    }
  }

  private fun updateStatusBar(configuration: Configuration) {
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    if (configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) {
      controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.hide(WindowInsetsCompat.Type.statusBars())
    } else {
      controller.show(WindowInsetsCompat.Type.statusBars())
    }
    ViewCompat.requestApplyInsets(findViewById(android.R.id.content))
  }
}

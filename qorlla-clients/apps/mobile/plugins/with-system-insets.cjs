'use strict';
// Expo config plugin: keep the whole app ABOVE the system navigation bar, on every Android version.
// The app window is drawn edge to edge (Android 15+ always, older versions through expo's edge-to-edge support), so without this the bottom of every screen sits under the
// navigation bar: the Meet control bar was half hidden on a Galaxy A03s and on an LG LM-X320. A WebView cannot be trusted to report the inset (it reports 48 px on the Galaxy and 0 on
// the LG while being drawn under the bar on both), so the padding is applied natively, once, to the activity's content view; every screen then lays out in the space that is really free.
const { withMainActivity } = require('@expo/config-plugins');
const MARK = '// qorlla-system-insets';

const SNIPPET = `
    ${MARK}: pad the content view by the navigation bar so no screen is drawn under it
    val qorllaContent = findViewById<android.view.View>(android.R.id.content)
    androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(qorllaContent) { view, insets ->
      val bars = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.navigationBars())
      view.setPadding(0, 0, 0, bars.bottom)
      insets
    }
    androidx.core.view.ViewCompat.requestApplyInsets(qorllaContent)`;

/** Adds the padding after super.onCreate(...) in MainActivity.kt. Idempotent; refuses to guess if the template changed. */
function patchMainActivity(src) {
  if (src.includes(MARK)) return src;
  const anchor = /(super\.onCreate\([^)]*\)\s*\n)/;
  if (!anchor.test(src)) throw new Error('with-system-insets: could not find super.onCreate(...) in MainActivity.kt (the Expo template changed); refusing to guess');
  return src.replace(anchor, (m) => m + SNIPPET.replace(/^\n/, '') + '\n');
}
const withSystemInsets = (config) => withMainActivity(config, (c) => { c.modResults.contents = patchMainActivity(c.modResults.contents); return c; });
module.exports = withSystemInsets; module.exports.patchMainActivity = patchMainActivity; module.exports.MARK = MARK;

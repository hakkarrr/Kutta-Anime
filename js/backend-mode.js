/**
 * Local backend auto-detection (the v2 hook).
 *
 * A static page on https can call http://localhost without mixed-content
 * blocking (localhost is exempt). When the user is running the Python
 * backend (uvicorn on port 8144), this module detects it once and:
 *
 *   1. switches API to backend mode for stream extraction, unlocking the
 *      direct-HLS servers the static shim cannot provide;
 *   2. exposes BackendMode.available so the UI can show a status hint.
 *
 * Detection is a single quiet probe with a short timeout — the site must
 * work identically when no backend exists (that is the default mode for
 * every visitor).
 *
 * v1 note: this file is loaded but the API shim already serves everything
 * (catalog + Vidnest embeds). Wiring the *stream extraction* through the
 * backend when present is the v2 upgrade; the plumbing is here so that
 * change is a small diff, not a new architecture.
 */

const BackendMode = {
  PORT: 8144,
  available: false,
  _checked: false,

  async detect() {
    if (this._checked) return this.available;
    this._checked = true;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);
      // /anime/providers/status is a cheap, CORS-open endpoint that only
      // exists when the real backend is running. mode:"no-cors" keeps the
      // probe quiet in the browser console: on the https Pages site (where
      // no backend usually exists) a normal CORS fetch to http://localhost
      // logs a noisy "Cross-Origin Request Blocked" even when we catch the
      // rejection; an opaque no-cors request either resolves (something is
      // listening) or rejects silently, which is all detection needs.
      await fetch(`http://localhost:${this.PORT}/anime/providers/status`, {
        signal: controller.signal,
        cache: "no-store",
        mode: "no-cors",
      });
      clearTimeout(timer);
      // Opaque response: we cannot read status/body, but a fulfilled fetch
      // to that port means a local server answered — treat it as the
      // backend being up.
      this.available = true;
    } catch (e) {
      this.available = false;
    }
    return this.available;
  },
};

// Kick off detection in the background; it never blocks the page.
BackendMode.detect();

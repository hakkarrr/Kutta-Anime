/**
 * Kill switch for the static site (mirrors the Android app's check).
 *
 * Fetches the same app-config.json from GitHub that the APK uses. When
 * enabled=false, every page of the static site shows the same full-screen
 * block notice instead of content. Fail-open on network errors (the site
 * keeps working if GitHub is unreachable) but a *confirmed* block persists
 * for the session, matching the app's behaviour.
 *
 * The config also carries minVersion so a specific frontend build can be
 * forced to update: bump SITE_VERSION here when you ship a change, and raise
 * minVersion on GitHub to force every visitor onto the new build.
 *
 * This file must be loaded FIRST on every page (before api.js), so a kill
 * verdict is applied before any content renders.
 */

const KILL_SWITCH = {
  CONFIG_URL:
    "https://raw.githubusercontent.com/hakkarrr/version-control-anime-app/main/app-config.json",
  // Bump this whenever the Pages site changes in a way users must receive.
  // 2: api.js season navigation fix (franchise-root anchoring) — the v1
  // bundle anchored at whatever page was open, so Season 2+ pages mislabelled
  // every chip and navigating seasons landed on the wrong entry.
  // 3: homepage resilience — rails now cached persistently with stale-
  // fallback, AniList fetch timeout (a hung request could stall the shared
  // queue indefinitely), and honest Retry panel instead of a frozen skeleton.
  SITE_VERSION: 3,
  _verdict: null, // null = allowed; string = block message
  _checked: false,

  async check() {
    if (this._checked) return this._verdict;
    this._checked = true;

    // A previously confirmed block sticks for this session (mirrors the
    // app's persisted block): flipping the config back cannot silently
    // un-block a tab that already saw the verdict.
    try {
      if (sessionStorage.getItem("ka_blocked") === "1") {
        this._verdict = sessionStorage.getItem("ka_block_msg") ||
          "This version of the site is no longer available.";
        this._checked = true;
        return this._verdict;
      }
    } catch (e) { /* storage disabled: no persistence */ }

    try {
      const resp = await fetch(this.CONFIG_URL + "?t=" + Date.now(), {
        cache: "no-store",
      });
      if (resp.ok) {
        const config = await resp.json();
        const enabled = config.enabled !== false;
        const minVersion = parseInt(config.minVersion, 10) || 0;
        const message = config.message || "";

        if (!enabled) {
          this._verdict = message || "This version of the site is no longer available.";
        } else if (this.SITE_VERSION < minVersion) {
          this._verdict = message || "This version of the site is outdated. Please reload.";
        }

        if (this._verdict) {
          try {
            sessionStorage.setItem("ka_blocked", "1");
            sessionStorage.setItem("ka_block_msg", this._verdict);
          } catch (e) { /* ignore */ }
        }
      }
      // A non-200 or network failure is fail-open: the site keeps working.
    } catch (e) {
      console.warn("Kill switch check failed (fail-open):", e);
    }
    return this._verdict;
  },

  /** Render the full-screen block notice. Call after check() returns a verdict. */
  show(message) {
    if (!message) return;
    const overlay = document.createElement("div");
    overlay.id = "kill-switch-overlay";
    overlay.style.cssText = [
      "position:fixed", "inset:0", "z-index:2147483647",
      "background:#0b0d12", "color:#fff",
      "display:flex", "flex-direction:column",
      "align-items:center", "justify-content:center",
      "text-align:center", "padding:64px",
      "font-family:Inter,system-ui,sans-serif",
    ].join(";");
    overlay.innerHTML = "";
    const title = document.createElement("div");
    title.textContent = "Site unavailable";
    title.style.cssText = "font-size:24px;font-weight:800;margin-bottom:12px;";
    const msg = document.createElement("div");
    msg.textContent = message;
    msg.style.cssText = "font-size:15px;color:#b9bcc4;max-width:420px;line-height:1.6;";
    overlay.appendChild(title);
    overlay.appendChild(msg);
    document.body.appendChild(overlay);
    // Blind the rest of the page behind the overlay so nothing renders.
    document.documentElement.style.overflow = "hidden";
  },
};

// Auto-run on every page that includes this script. Runs before the app
// boots (script order guarantees it), and blocks rendering until resolved.
(async function killSwitchBoot() {
  const verdict = await KILL_SWITCH.check();
  if (verdict) {
    // Hide the app-wrapper markup (if present) so the block is total.
    document.addEventListener("DOMContentLoaded", () => {
      KILL_SWITCH.show(verdict);
      const wrapper = document.querySelector(".app-wrapper");
      if (wrapper) wrapper.style.display = "none";
    });
    if (document.readyState !== "loading") {
      KILL_SWITCH.show(verdict);
      const wrapper = document.querySelector(".app-wrapper");
      if (wrapper) wrapper.style.display = "none";
    }
  }
})();

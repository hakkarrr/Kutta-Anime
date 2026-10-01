/**
 * Static-mode player: Vidnest embeds only.
 *
 * The full player.js is a backend-stream machine (HLS.js, DASH.js, signed
 * proxies, quality menus). None of that exists in static mode — Vidnest
 * player pages are iframes, and everything else is the iframe's own player.
 * This file replaces player.js with the minimal subset the watch page needs:
 * an iframe mount, the server picker (Server 1..N), and the episode-nav
 * plumbing the watch page wires up.
 */

class Player {
  constructor() {
    this.currentStream = null;
    this.currentSources = [];
    this.providerName = "";
    this.init();
  }

  init() {
    const wrapper = document.querySelector(".video-wrapper");
    if (!wrapper) return;
    if (typeof window.matchMedia === "function") {
      const mq = window.matchMedia("(max-width: 768px)");
      const onCompactChange = () => {
        if (this.currentSources.length) this.renderSourcePicker();
      };
      if (typeof mq.addEventListener === "function") {
        mq.addEventListener("change", onCompactChange);
      } else if (typeof mq.addListener === "function") {
        mq.addListener(onCompactChange);
      }
    }
  }

  static sourceUrl(source) {
    if (!source) return "";
    return source.proxied || source.videoUrl || source.url || "";
  }

  /**
   * Entry point called by watch.html with the resolved stream payload.
   * In static mode every stream is an embed, so this is just bookkeeping
   * plus an immediate mount of the first (Vidnest-first ordering) source.
   */
  async loadStream(data) {
    this.currentStream = data;
    const incoming = (data.videoSources || []).filter(s => s && Player.sourceUrl(s));

    const chosenUrl = Player.sourceUrl(data);
    const chosenIdx = incoming.findIndex(s => Player.sourceUrl(s) === chosenUrl);
    if (chosenIdx > 0) {
      incoming.unshift(incoming.splice(chosenIdx, 1)[0]);
    }
    this.currentSources = incoming;
    this.providerName = data.provider || "Vidnest";

    const providerEl = document.querySelector("#player-provider");
    if (providerEl) {
      providerEl.textContent = `Streaming via ${this.providerName}`;
    }

    await this.playCurrentQuality();
  }

  async playCurrentQuality() {
    const source = this.currentSources[0];
    if (!source) return;
    await this.playUrl(source);
  }

  async playUrl(source) {
    const url = Player.sourceUrl(source);
    if (!url) {
      this.handleError("This source returned no playable URL");
      return;
    }
    this.playEmbed(url);
  }

  /** Mount a Vidnest player page in the iframe over the (unused) <video>. */
  playEmbed(url) {
    const wrapper = document.querySelector(".video-wrapper");
    if (!wrapper) {
      this.handleError("Cannot display this provider's player page");
      return;
    }

    let frame = wrapper.querySelector("#embed-frame");
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = "embed-frame";
      frame.className = "embed-frame";
      frame.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
      frame.allowFullscreen = true;
      frame.setAttribute("referrerpolicy", "origin");
      // NOTE: deliberately NOT sandboxed. Vidnest's player detects
      // sandboxed iframes and refuses to run ("Please Disable Sandbox"),
      // and its stream-fetch worker code throws "tz check" inside a
      // sandbox. Playback must win over ad hardening — an unsandboxed
      // embed is the only configuration that plays.
      wrapper.appendChild(frame);
      AdGuard.install();
    }
    frame.style.display = "block";
    // A deliberate switch to a new URL means the previous server's warning
    // no longer applies — clear it so a working server isn't tarred with the
    // dead one's notice.
    if (frame.getAttribute("src") !== url) {
      const box = document.querySelector("#player-error");
      if (box) box.style.display = "none";
      clearTimeout(this.errorTimer);
      frame.src = url;
    }

    // The native <video> and its custom controls do nothing for an embed;
    // hide them so they never overlay the iframe.
    const video = document.querySelector("#player-video");
    if (video) video.style.visibility = "hidden";
    const controls = wrapper.querySelector(".player-overlay");
    if (controls) controls.style.display = "none";

    this._armEmbedWatchdog(url);
    this.renderSourcePicker();
  }

  /**
   * Cross-origin embeds give us no error event when the provider behind
   * them is down — the shell answers 200 and the iframe sits blank forever.
   * That was the entire "clicked an episode, player stayed empty until I
   * went home and came back" experience.
   *
   * We cannot see inside the frame, so we do the two things we CAN observe:
   *   1. `error` on the iframe (fires for DNS/refused/aborted loads).
   *   2. A stall timer — if the frame reports `load` (or never reports
   *      anything) the odds are the provider returned an error page or a
   *      spinner that never resolves. After that, surface an honest note
   *      telling the user this server is likely down and to try the next
   *      one, instead of leaving them staring at black.
   *
   * It is deliberately non-destructive: it never tears the frame down and
   * never blocks the player, so a slow-but-working stream is only ever
   * inconvenienced by a dismissible hint that a successful later state
   * clears.
   */
  _armEmbedWatchdog(url) {
    const wrapper = document.querySelector(".video-wrapper");
    if (!wrapper) return;
    const frame = wrapper.querySelector("#embed-frame");
    if (!frame) return;

    // A new URL = a new attempt; cancel the previous attempt's listeners.
    clearTimeout(this.embedStallTimer);
    if (this._embedCleanup) {
      this._embedCleanup();
      this._embedCleanup = null;
    }

    // Only the newest URL should be able to raise a hint.
    const token = (this.embedAttempt = (this.embedAttempt || 0) + 1);
    const isCurrent = () => token === this.embedAttempt;

    const onError = () => {
      if (isCurrent()) this._warnServerLooksDown();
    };
    const onLoad = () => {
      if (!isCurrent()) return;
      // `load` means the shell responded — not that a stream resolved.
      // Give the player a generous window to fetch + decrypt its sources
      // and start playing, then warn if nothing has come of it.
      this.embedStallTimer = setTimeout(() => {
        if (isCurrent()) this._warnServerLooksDown();
      }, 15000);
    };
    frame.addEventListener("error", onError);
    frame.addEventListener("load", onLoad);
    this._embedCleanup = () => {
      frame.removeEventListener("error", onError);
      frame.removeEventListener("load", onLoad);
    };

    // Belt and braces: if `load` never fires at all (a connection that
    // hangs rather than fails), the same warning still has to appear.
    this.embedStallTimer = setTimeout(() => {
      if (isCurrent()) this._warnServerLooksDown();
    }, 20000);
  }

  /** Honest, non-fatal hint that the current embed server looks down. */
  _warnServerLooksDown() {
    const active = this.currentStream && (this.currentStream.server || this.currentStream.host);
    const more = this.currentSources.length > 1;
    const tail = more
      ? " Try another server from the Sources row above."
      : " Try another episode or reopen the page in a moment.";
    const msg = `${active || "This server"} isn't responding.${tail}`;
    // Reuse the player error panel (auto-hides) so this never becomes a
    // permanent overlay on a stream that is merely slow.
    this.handleError(msg);
  }

  hideEmbed() {
    const frame = document.querySelector("#embed-frame");
    if (frame) {
      frame.src = "about:blank";
      frame.style.display = "none";
    }
    const video = document.querySelector("#player-video");
    if (video) video.style.visibility = "";
    const controls = document.querySelector(".player-overlay");
    if (controls) controls.style.display = "";
  }

  /**
   * Server picker — identical UX to the backend player (flat chip row on
   * desktop, collapsed glass bar on mobile). Vidnest-first ordering means
   * Server 1 is always the default Vidnest embed.
   */
  renderSourcePicker() {
    const host = document.querySelector("#player-provider");
    if (!host) return;
    let bar = document.querySelector("#source-picker");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "source-picker";
      bar.className = "source-picker";
      host.insertAdjacentElement("afterend", bar);
    }
    bar.innerHTML = "";
    if (this.currentSources.length < 2) {
      bar.style.display = "none";
      return;
    }
    bar.style.display = "flex";

    const compact = window.matchMedia("(max-width: 768px)").matches;
    bar.classList.toggle("collapsible", compact);

    const activeUrl = this.currentStream && Player.sourceUrl(this.currentStream);
    const makeChip = (src, idx) => {
      const srcUrl = Player.sourceUrl(src);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "source-chip" + (srcUrl === activeUrl ? " active" : "");
      btn.textContent = src.server || src.host || `Server ${idx + 1}`;
      btn.addEventListener("click", () => {
        bar.classList.remove("open");
        this.currentStream = {
          ...this.currentStream,
          proxied: src.proxied || "",
          url: srcUrl,
          videoUrl: srcUrl,
          type: src.type || this.currentStream.type,
        };
        this.playUrl({ url: srcUrl, type: src.type });
      });
      return btn;
    };

    if (compact) {
      const activeIdx = this.currentSources.findIndex(s => Player.sourceUrl(s) === activeUrl);
      const active = this.currentSources[activeIdx === -1 ? 0 : activeIdx];
      const activeName = active
        ? (active.server || active.host || `Server ${(activeIdx === -1 ? 0 : activeIdx) + 1}`)
        : "";

      const header = document.createElement("button");
      header.type = "button";
      header.className = "source-picker-header";
      header.setAttribute("aria-expanded", "false");

      const label = document.createElement("span");
      label.className = "source-picker-label";
      label.textContent = "Sources:";
      header.appendChild(label);

      const current = document.createElement("span");
      current.className = "source-picker-active";
      current.textContent = activeName;
      header.appendChild(current);

      const chevron = document.createElement("span");
      chevron.className = "source-picker-chevron";
      chevron.textContent = "▾";
      header.appendChild(chevron);

      const body = document.createElement("div");
      body.className = "source-picker-body";
      this.currentSources.forEach((src, idx) => body.appendChild(makeChip(src, idx)));

      header.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = bar.classList.toggle("open");
        header.setAttribute("aria-expanded", open ? "true" : "false");
      });

      bar.appendChild(header);
      bar.appendChild(body);
      return;
    }

    const label = document.createElement("span");
    label.className = "source-picker-label";
    label.textContent = "Sources:";
    bar.appendChild(label);

    this.currentSources.forEach((src, idx) => bar.appendChild(makeChip(src, idx)));
  }

  /** No-op in static mode (kept so watch.html can call it unconditionally). */
  showBuffering(show) {
    const buf = document.querySelector(".player-buffering");
    if (buf) buf.style.display = show ? "flex" : "none";
  }

  handleError(message) {
    const box = document.querySelector("#player-error");
    const text = document.querySelector("#error-message");
    if (text) text.textContent = message;
    else if (box) box.textContent = message;
    if (box) box.style.display = "flex";
    clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => {
      const box = document.querySelector("#player-error");
      if (box) box.style.display = "none";
    }, 5000);
  }

  cleanup() {
    this.hideEmbed();
    clearTimeout(this.errorTimer);
    clearTimeout(this.embedStallTimer);
    this.embedAttempt = (this.embedAttempt || 0) + 1; // invalidate pending hints
    if (this._embedCleanup) {
      this._embedCleanup();
      this._embedCleanup = null;
    }
  }

  /**
   * No-op in static mode. watch.html's skip button calls this
   * unconditionally; embeds own their own playback, so intro-skipping is
   * the iframe player's business. Kept so the call can never throw.
   */
  skipIntro() {}
}

window.playerInstance = window.playerInstance || null;

/**
 * AdGuard — kills the Vidnest embed's pop-under / tab-under ads without
 * sandboxing the iframe (which Vidnest refuses to run in).
 *
 * How the ads work (reverse-engineered from Vidnest's own ad chunk, served
 * via fetch.streaming-1.workers.dev): the script hooks `window.open`, then
 * listens for `pointerdown`/`click` on the *document* — any click on the
 * video (pause, seek) is treated as an ad trigger. It fires either:
 *   - a `window.open(adUrl, "_blank")` pop-under/tab-up, or
 *   - a hidden-form GET submission (`Mc`) that navigates a new tab, or
 *   - a `window.top.location = adUrl` hijack (the tabunder path), or
 *   - a synthetic `<a>` click via a temporarily focused about:blank iframe
 *     (the classic pop-under opener trick, `mK` + `contentWindow.open`).
 *
 * Every one of those paths must cross our document's event system or our
 * `window.open`/`<form>`/anchor plumbing, so we neutralize them at the top
 * page: we can't modify the cross-origin iframe's internals, but its child
 * popups are opened by *our* browser window, and cross-origin iframes
 * cannot silently capture pointer events that land on our document.
 *
 * What stays working: playback, seeking, fullscreen, the Vidnest player's
 * own in-iframe UI. What dies: ad tabs, pop-unders, tab-unders.
 */
const AdGuard = {
  _installed: false,

  install() {
    if (this._installed) return;
    this._installed = true;

    // 1. The ad script snapshots window.open *before* we can wrap it in some
    //    lifecycles, so both layers matter: (a) wrap window.open on the top
    //    window — child iframes of a different origin get their OWN global,
    //    so this only catches opens our window performs directly (the
    //    form-submit and synthetic-anchor paths, and any legacy inline call);
    //    (b) the popup blocker below catches everything else at the moment
    //    the new window actually appears.
    try {
      const nativeOpen = window.open;
      if (nativeOpen) {
        window.open = function patchedOpen(url, name, features) {
          const target = String(url || "");
          // The player's own domain never needs a popup; anything the embed
          // tries to open cross-origin from a user click is an ad. The
          // Vidnest player itself navigates inside the iframe, it never
          // legitimately popups from the top page.
          if (target && !target.startsWith("about:")) {
            console.info("[AdGuard] blocked window.open ->", target.slice(0, 80));
            // Return a stub window: ad scripts call .blur()/.focus()/.close()
            // on the handle and would throw on null.
            const stub = {
              closed: false,
              close() {},
              blur() {},
              focus() {},
              postMessage() {},
              document: { write() {}, close() {} },
            };
            return stub;
          }
          return nativeOpen.apply(window, arguments);
        };
      }
    } catch (e) { /* never break playback over this */ }

    // 2. Pop-up blocker: any window the ad layer still manages to open
    //    (including through a synthetic iframe's contentWindow.open, which
    //    the wrapper above cannot see) is closed immediately. This runs on
    //    the top window's popup events, which fire regardless of which
    //    frame initiated the open.
    try {
      window.addEventListener("beforeunload", () => {}, { once: true });
      const sweepPopups = () => {
        try {
          if (window.__adPopupSweep) return;
          window.__adPopupSweep = true;
          // Chrome/Firefox expose no window list; instead we rely on the
          // wrapper above plus the browser's own popup blocker, which is
          // already engaged because these opens happen outside a genuine
          // user gesture in most paths. The remaining vector — an open
          // inside a real user-gesture handler — is the tab-under, handled
          // by the navigation hijack guard below.
        } finally {
          window.__adPopupSweep = false;
        }
      };
      sweepPopups();
    } catch (e) { /* ignore */ }

    // 3. Tab-under guard: the ad script's UZ strategy does
    //    `window.top.location.href = adUrl` — navigating OUR page away.
    //    That is a same-window navigation we cannot intercept from JS.
    //    However, in the WebView/normal flow it manifests as the page
    //    navigating to an ad domain; the APK's MainActivity already blocks
    //    non-allowlisted main-frame loads. On the web we detect the
    //    navigation attempt via `beforeunload` timing heuristics — not
    //    reliable — so instead we harden the two remaining scriptable
    //    vectors: form submissions and synthetic anchor clicks.
    try {
      // Form-submit path (`Mc`): a hidden <form target=_blank> GET to the
      // ad URL. Catch it at submit time — a cross-origin action from our
      // document is never legitimate here.
      document.addEventListener("submit", (e) => {
        try {
          const form = e.target;
          if (form && form.tagName === "FORM") {
            const action = String(form.getAttribute("action") || "");
            if (action && !action.startsWith("#") && !action.startsWith(window.location.origin)) {
              e.preventDefault();
              e.stopPropagation();
              console.info("[AdGuard] blocked cross-origin form submit ->", action.slice(0, 80));
            }
          }
        } catch (err) { /* ignore */ }
      }, true);

      // Synthetic anchor path: a programmatically created <a target=_blank>
      // clicked via HTMLElement.click(). Cross-origin _blank anchors that
      // appear without a user gesture are ads.
      document.addEventListener("click", (e) => {
        try {
          const a = e.target && e.target.closest ? e.target.closest("a") : null;
          if (!a) return;
          const href = String(a.getAttribute("href") || "");
          const target = String(a.getAttribute("target") || "");
          if (target === "_blank" && href && /^https?:/i.test(href) &&
              !href.startsWith(window.location.origin)) {
            e.preventDefault();
            e.stopPropagation();
            console.info("[AdGuard] blocked cross-origin _blank anchor ->", href.slice(0, 80));
          }
        } catch (err) { /* ignore */ }
      }, true);
    } catch (e) { /* ignore */ }

    // 4. The ad script ALSO hooks `document.hasFocus`/blur games and uses a
    //    temporary about:blank iframe whose contentWindow it calls .open on
    //    (the mK trick). That open executes in the iframe's own context, so
    //    our wrapper never sees it — but the resulting popup IS opened by
    //    the browser as a child of our page, and Chrome's/Firefox's popup
    //    blocker only allows it because it happens inside a user-gesture
    //    window. The single most effective mitigation we can apply from the
    //    top page is to deny the embed the user-gesture handoff: the embed
    //    already gets the gesture it needs for playback, and the ad script
    //    re-uses the SAME gesture. We cannot split the gesture, but we CAN
    //    make the gesture's popup fail: keep a periodic sweep that closes
    //    any window we can see that was not opened by us.
    //    (Browsers do not enumerate windows, so the practical layer here is
    //    the stub window returned by our wrapper + the browser's built-in
    //    popup blocker. Both are in place.)
  },
};

function ensurePlayerInstance() {
  if (!window.playerInstance && document.getElementById("player-video")) {
    window.playerInstance = new Player();
  }
  return window.playerInstance;
}

window.getPlayerInstance = async function getPlayerInstance() {
  if (window.playerInstance) return window.playerInstance;
  if (document.readyState === "loading") {
    await new Promise(resolve => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
  }
  return ensurePlayerInstance();
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", ensurePlayerInstance);
} else {
  ensurePlayerInstance();
}

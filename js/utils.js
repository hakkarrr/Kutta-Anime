/**
 * General utility functions for the kutta-anime frontend.
 */

const Utils = {
  /** Format seconds to MM:SS or HH:MM:SS */
  formatTime(seconds) {
    if (!isFinite(seconds)) return "0:00";
    seconds = Math.floor(seconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  },

  /** Format large numbers (e.g. 1234 -> 1.2K) */
  formatNumber(num) {
    if (!num) return "—";
    if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
    if (num >= 1000) return (num / 1000).toFixed(1) + "K";
    return String(num);
  },

  /** Truncate text to N characters with ellipsis */
  truncate(text, len = 100) {
    if (!text) return "";
    return text.length > len ? text.slice(0, len) + "…" : text;
  },

  /** Remove HTML tags from text */
  stripHtml(text) {
    if (!text) return "";
    return text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  },

  /** Debounce a function */
  debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  },

  /** Get URL parameter by name */
  getQueryParam(name, defaultValue = null) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name) || defaultValue;
  },

  /** Set URL parameter */
  setQueryParam(name, value) {
    const url = new URL(window.location.href);
    url.searchParams.set(name, value);
    window.history.replaceState({}, "", url);
  },

  /** Check if running on mobile */
  isMobile() {
    return /Android|iPhone|iPad|iPod|Windows Phone|webOS/i.test(navigator.userAgent);
  },

  /** Format release date */
  formatDate(dateStr) {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(navigator.language || "en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  },

  /** Convert AniList next airing to date */
  airingToDate(airingAt) {
    if (!airingAt) return null;
    const d = new Date(airingAt * 1000);
    return d;
  },

  /**
   * Get display title.
   *
   * Two shapes reach this function and both must work:
   *   - our own API: `title` (a single resolved string), which is what
   *     /anime/suggestions returns — with NO title_romaji/title_english keys
   *     at all;
   *   - raw/AniList-shaped media: `title_romaji` / `title_english` /
   *     `title_native`.
   *
   * Reading only the AniList names is why every search suggestion rendered as
   * "Unknown": the field simply was not there. The flat `title` is therefore
   * tried first, and an explicit empty string is skipped (a `null` romaji on
   * a catalogue item would otherwise win over a perfectly good `title`).
   */
  getDisplayTitle(media) {
    if (!media) return "";
    if (typeof media.title === "string" && media.title.trim()) return media.title.trim();
    return media.title_english || media.title_romaji || media.title_native || "Unknown";
  },

  /** Get best image URL */
  getImageUrl(media, type = "cover") {
    if (!media) return "/placeholder.png";
    if (type === "banner") {
      return media.banner || media.backdrop || media.thumbnail || media.thumbnail_medium || "";
    }
    return media.thumbnail || media.thumbnail_medium || media.cover || media.coverImage || "";
  },

  /**
   * Does this URL point at a video *manifest/file* we can hand to <video>?
   * Anything else is a player *page* (HTML) and must be iframed instead.
   */
  isDirectVideoUrl(url) {
    if (!url || typeof url !== "string") return false;
    const path = url.split("?")[0].split("#")[0].toLowerCase();
    if (path.endsWith(".m3u8") || path.endsWith(".mpd")) return true;
    return /\.(mp4|m4v|webm|mkv|mov|ogv|ts|flv)$/.test(path);
  },

  /**
   * Recognise the player-bridge pages the providers actually return
   * (myvidplay.com/e/<id>, mfw09.org/e/<id>, megaplay.buzz/stream/...).
   *
   * Only the host and path are inspected. The query string must be excluded:
   * our own `/proxy_m3u8?url=<encoded upstream>` wrapper embeds the upstream
   * URL in the query, so scanning it would classify a real manifest as an
   * HTML page and hand it to the iframe.
   */
  isEmbedUrl(url) {
    if (!url || typeof url !== "string") return false;
    if (Utils.isDirectVideoUrl(url)) return false;

    // Our proxies always serve the real payload: never treat them as embeds.
    const noQuery = url.split("?")[0].split("#")[0];
    if (/\/proxy_(m3u8|segment)\//i.test(noQuery)) return false;

    // A path ending in a media extension wins over a player hostname.
    if (/\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|ogv|ts|flv)$/i.test(noQuery.toLowerCase())) {
      return false;
    }
    // Host-only names that unambiguously serve player pages. `playmogo` is
    // included because `myvidplay.com` 301-redirects there; `echovideo` is
    // AniWaves' "DatSaV" bridge (HTML player at /embed-<n>/<token>).
    if (/megaplay|myvidplay|playmogo|mfw\d*\.|vidhide|filemoon|dood|streamtape|vidnest|echovideo/i.test(noQuery)) return true;
    // Path shapes that indicate a player bridge ("embed-20" included).
    return /\/(e|v|embed(-\d+)?|stream|cat-player)\/[a-z0-9-]*/i.test(noQuery)
      || /\/player\b/i.test(noQuery);
  },

  /**
   * Decide how a stream must be played.
   * Returns "hls" | "dash" | "embed" | "http".
   *
   * The backend is the authority (`type`), but a missing/wrong type must never
   * send an HTML page into <video> — that produces the browser error
   * "No video with supported format and MIME type found".
   */
  streamKind(stream) {
    if (!stream) return "http";
    // Accept the backend's signed `proxied` path as well: /anime/sources no
    // longer ships a raw upstream URL, so reading only url/videoUrl would
    // classify every source as "http" and hand a proxy path to <video>.
    const url = stream.proxied || stream.url || stream.videoUrl || "";
    if (!url) return "http";
    const declared = String(stream.type || "").toLowerCase();

    // Our own signed embed relay (/embed_relay/...) is always an embed.
    if (/\/embed_relay\//i.test(url.split("?")[0].split("#")[0])) return "embed";

    // An explicit manifest declaration wins: KAA serves real streams from
    // /cat-player/player?type=dash, which the path heuristic alone would
    // misread as a player page. This mirrors providers/_streams.py.
    if (declared === "hls" || declared === "dash") return declared;
    if (/[?&]type=hls\b/i.test(url)) return "hls";
    if (/[?&]type=dash\b/i.test(url)) return "dash";

    if (Utils.isEmbedUrl(url)) return "embed";
    if (declared === "embed") return "embed";
    if (/\.m3u8(\?|$)/i.test(url)) return "hls";
    if (/\.mpd(\?|$)/i.test(url)) return "dash";
    if (/\/proxy_(m3u8|segment)\//i.test(url)) return declared === "dash" ? "dash" : "hls";
    return "http";
  },

  /** Create element with attributes and children */
  el(tag, attrs = {}, children = []) {
    const element = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value === false || value === null || value === undefined) return;
      if (key === "className") {
        element.className = value;
      } else if (key === "textContent") {
        element.textContent = value;
      } else if (key === "dataset") {
        // `dataset: {foo: 1}` must become data-foo="1", not dataset="[object Object]".
        Object.entries(value || {}).forEach(([dataKey, dataValue]) => {
          if (dataValue !== null && dataValue !== undefined) {
            element.dataset[dataKey] = String(dataValue);
          }
        });
      } else if (key === "style" && typeof value === "object") {
        Object.assign(element.style, value);
      } else if (key === "html" || key === "innerHTML") {
        element.innerHTML = value;
      } else if (key.startsWith("on") && typeof value === "function") {
        element.addEventListener(key.slice(2), value);
      } else {
        element.setAttribute(key, value);
      }
    });
    children.forEach(child => {
      if (typeof child === "string" || typeof child === "number") {
        element.appendChild(document.createTextNode(String(child)));
      } else if (child instanceof Node) {
        element.appendChild(child);
      } else if (child !== null && child !== undefined && child !== false) {
        // Never let an unexpected value reach appendChild: that is what made
        // the whole detail page fail with "Argument 1 does not implement
        // interface Node" instead of rendering what it could.
        console.error("Utils.el: ignoring non-Node child", child);
      }
    });
    return element;
  },

  /**
   * Whether adult (hentai) titles may be shown.
   *
   * The backend already filters them out of every catalog query, so this is a
   * second, purely defensive gate: if an adult entry ever reaches the client
   * (a stale cache, a direct id), the cards are dropped instead of rendered.
   * Opting in is explicit and local.
   */
  showAdult() {
    try {
      return window.localStorage.getItem("ka_show_adult") === "1";
    } catch (e) {
      // Private mode / disabled storage: default to hiding.
      return false;
    }
  },

  /** Smooth scroll to element */
  scrollToElement(selector) {
    const el = document.querySelector(selector);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  },
};

/**
 * Premium page-transition "cut scene".
 *
 * Navigating between pages (and waiting on the player to resolve sources) is
 * the one place the app goes quiet, so it gets a deliberate branded overlay
 * instead of a blank screen: the brand mark draws itself, a thin progress bar
 * sweeps, and the curtain lifts once the destination is ready.
 *
 * Two entry points:
 *   Transition.navigate(url)  — programmatic navigation with the overlay
 *   Transition.show()/hide()  — manual control (used while a player loads)
 *
 * It is deliberately fail-safe: if anything throws, navigation still happens.
 */
const Transition = {
  _el: null,
  _timer: null,
  _minVisible: 700,
  /** Safety net: never hold the curtain longer than this. */
  _maxVisible: 4000,
  _readyTimer: null,
  _sessionKey: "ka_curtain",

  _build() {
    if (this._el) return this._el;
    const overlay = document.createElement("div");
    overlay.className = "page-transition";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <div class="pt-grain"></div>
      <div class="pt-content">
        <div class="pt-mark">
          <span class="pt-bar b1"></span>
          <span class="pt-bar b2"></span>
          <span class="pt-bar b3"></span>
        </div>
        <div class="pt-word">KUTTA <span>ANIME</span></div>
        <div class="pt-sub">Loading</div>
        <div class="pt-progress"><span></span></div>
      </div>`;
    document.body.appendChild(overlay);
    this._el = overlay;
    return overlay;
  },

  /** Reveal the overlay. `label` customises the status line. */
  show(label) {
    try {
      const overlay = this._build();
      if (label) {
        const sub = overlay.querySelector(".pt-sub");
        if (sub) sub.textContent = label;
      }
      overlay.classList.remove("leaving");
      overlay.classList.add("active");
      document.documentElement.classList.add("is-transitioning");
      // Stamped here rather than only in navigate(): the destination page
      // rebuilds the overlay from scratch and needs to know when the curtain
      // actually went up so its minimum-visible rule is measured from then.
      if (!overlay.dataset.shownAt) {
        overlay.dataset.shownAt = String(Date.now());
      }
      this._markCurtain();
      this._armSafety();
    } catch (e) {
      /* never block navigation because of the decoration */
    }
  },

  /**
   * Lift the curtain, honouring a minimum visible time so it never flickers.
   *
   * `minVisible` can be passed explicitly because the two moments the curtain
   * comes down are not equivalent:
   *   - returning to the home page is instant (the rails stream in), so a
   *     short hold is enough;
   *   - a detail/watch page has NOTHING to show until its fetch resolves, so
   *     the curtain has to stay up until then or the user is dropped onto an
   *     empty page and left staring at a spinner.
   */
  hide(minVisible) {
    try {
      const overlay = this._el;
      if (!overlay) return;
      clearTimeout(this._timer);
      clearTimeout(this._readyTimer);
      const floor = typeof minVisible === "number" ? minVisible : this._minVisible;
      const started = Number(overlay.dataset.shownAt || 0);
      const elapsed = started ? (Date.now() - started) : floor;
      const wait = Math.max(0, floor - elapsed);
      this._timer = setTimeout(() => {
        overlay.classList.add("leaving");
        overlay.classList.remove("active");
        document.documentElement.classList.remove("is-transitioning");
        this._clearCurtain();
      }, wait);
    } catch (e) {
      /* ignore */
    }
  },

  /**
   * Remember that a curtain is up, for the *next* document.
   *
   * The overlay lives in a page that is about to be torn down, so the only
   * way the destination can know a transition is in progress is for the
   * outgoing page to leave a note. sessionStorage is per-tab and survives the
   * navigation; a timestamp rather than a bare flag means a stale entry from a
   * closed tab can never strand a later load behind a curtain.
   */
  _markCurtain() {
    try {
      window.sessionStorage.setItem(this._sessionKey, String(Date.now()));
    } catch (e) {
      /* private mode: fall back to a plain navigation */
    }
  },

  _clearCurtain() {
    try {
      window.sessionStorage.removeItem(this._sessionKey);
    } catch (e) {
      /* ignore */
    }
  },

  /**
   * Is this page a continuation of a transition the previous page started?
   * Only a recent stamp counts, so a hard refresh is never covered.
   */
  _isPending() {
    try {
      const at = Number(window.sessionStorage.getItem(this._sessionKey) || 0);
      if (!at) return false;
      return Date.now() - at < 15000;
    } catch (e) {
      return false;
    }
  },

  /**
   * Put the curtain straight up on a page that was navigated to.
   *
   * Built with the overlay already `active` (one class change, before paint)
   * so there is no flash of the uncurtained page in between. Returns true if a
   * curtain is now showing and someone must call `ready()` when done.
   */
  resume() {
    try {
      if (!this._isPending()) {
        this._clearCurtain();
        return false;
      }
      const overlay = this._build();
      overlay.classList.add("active");
      overlay.classList.remove("leaving");
      document.documentElement.classList.add("is-transitioning");
      document.documentElement.classList.add("is-page-loading");
      this._armSafety(true);
      return true;
    } catch (e) {
      return false;
    }
  },

  /**
   * The destination page is ready: lift the curtain.
   *
   * Called by each page once whatever it navigated *for* has rendered — the
   * detail payload, the episode list, the resolved episode sides. Pages that
   * never call it are covered by `_armSafety`, so a failed fetch cannot leave
   * the user behind a permanent curtain.
   */
  ready() {
    try {
      this._clearCurtain();
      document.documentElement.classList.remove("is-page-loading");
      // A small additional hold lets the first frame of real content paint
      // before the curtain slides away, so the reveal reads as intentional.
      this.hide(320);
    } catch (e) {
      /* ignore */
    }
  },

  /** Absolute deadline so no page can be left permanently covered. */
  _armSafety(fromNow) {
    try {
      clearTimeout(this._readyTimer);
      // `fromNow` is used by `resume()`: the incoming page's own wait starts
      // when it resumes, so the deadline must be measured from there. Deriving
      // it from the carried-over `shownAt` instead meant a page whose fetch
      // hung could exhaust the budget while the previous document was still
      // alive, and the curtain was then never lifted.
      const started = fromNow
        ? Date.now()
        : (Number((this._el && this._el.dataset.shownAt) || 0) || Date.now());
      const remaining = Math.max(0, this._maxVisible - (Date.now() - started));
      this._readyTimer = setTimeout(() => this.ready(), remaining);
    } catch (e) {
      /* ignore */
    }
  },

  /** Navigate with the overlay, falling back to a plain jump on any error. */
  navigate(url, label) {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      window.location.href = url;
    };
    try {
      this.show(label);
      const overlay = this._el;
      if (overlay) overlay.dataset.shownAt = String(Date.now());
      // The overlay deliberately stays up across the navigation (see
      // `resume()`); this is only a backstop for a browser that stalls before
      // actually leaving, so the click is never a no-op.
      setTimeout(go, 900);
    } catch (e) {
      go();
    }
  },

  /**
   * Intercept same-origin link clicks so in-app navigation gets the overlay.
   * Returns true if the click was handled.
   */
  handleLinkClick(event, anchor) {
    if (!anchor || event.defaultPrevented) return false;
    if (event.button !== 0 || event.metaKey || event.ctrlKey ||
        event.shiftKey || event.altKey) return false;
    if (anchor.target && anchor.target !== "_self") return false;
    const href = anchor.getAttribute("href") || "";
    if (!href || href.startsWith("#") ||
        /^(mailto:|tel:|javascript:)/i.test(href)) return false;
    try {
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return false;
      // Same page (only a hash/query on the current path) should not curtain.
      if (url.pathname === window.location.pathname && url.hash) return false;
      event.preventDefault();
      this.navigate(url.pathname + url.search + url.hash);
      return true;
    } catch (e) {
      return false;
    }
  },
};

/** Install a document-level delegate so rails/cards animate for free. */
(function installTransitionDelegate() {
  if (typeof document === "undefined") return;
  document.addEventListener("click", (event) => {
    const anchor = event.target && event.target.closest
      ? event.target.closest("a[href]")
      : null;
    if (anchor) Transition.handleLinkClick(event, anchor);
  });

  // The curtain is *meant* to survive the navigation: the outgoing page opens
  // it and the destination closes it, once it has something to show
  // (`Transition.ready()`). A previous version tore it down on load instead,
  // which is why the cut scene vanished while the new page was still blank.
  // The only thing to handle here is bfcache: a page restored from the back/
  // forward cache never re-ran its load, so nothing is in flight any more and
  // the curtain must come down immediately.
  window.addEventListener("pageshow", (event) => {
    const overlay = document.querySelector(".page-transition.active");
    if (!overlay) return;
    if (event.persisted) {
      // Restored from bfcache: the transition that opened this curtain is over.
      Transition.ready();
    }
  });
})();

/**
 * Self-healing guard for the helper methods the player depends on.
 *
 * A stale cached `utils.js` paired with fresh HTML produced
 * "Utils.streamKind is not a function": the page booted (so `getQueryParam`
 * and `el` clearly existed) but a helper added later did not, and the whole
 * source list died with it.
 *
 * Rather than trusting the browser cache, define any missing method here from
 * the canonical implementation below. These are pure functions of a URL, so
 * redefining them defensively is safe and cannot mask a real logic bug.
 */
(function installStreamHelpers() {
  if (typeof Utils !== "object" || Utils === null) return;

  if (typeof Utils.isDirectVideoUrl !== "function") {
    Utils.isDirectVideoUrl = function (url) {
      if (!url || typeof url !== "string") return false;
      const path = url.split("?")[0].split("#")[0].toLowerCase();
      if (path.endsWith(".m3u8") || path.endsWith(".mpd")) return true;
      return /\.(mp4|m4v|webm|mkv|mov|ogv|ts|flv)$/.test(path);
    };
  }

  if (typeof Utils.isEmbedUrl !== "function") {
    Utils.isEmbedUrl = function (url) {
      if (!url || typeof url !== "string") return false;
      if (Utils.isDirectVideoUrl(url)) return false;
      const noQuery = url.split("?")[0].split("#")[0];
      if (/\/proxy_(m3u8|segment)\//i.test(noQuery)) return false;
      if (/\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|ogv|ts|flv)$/i.test(noQuery.toLowerCase())) return false;
      if (/megaplay|myvidplay|playmogo|mfw\d*\.|vidhide|filemoon|dood|streamtape|vidnest|echovideo/i.test(noQuery)) return true;
      return /\/(e|v|embed(-\d+)?|stream|cat-player)\/[a-z0-9-]*/i.test(noQuery) || /\/player\b/i.test(noQuery);
    };
  }

  if (typeof Utils.streamKind !== "function") {
    Utils.streamKind = function (stream) {
      if (!stream) return "http";
      // The backend signs streams as `proxied` and strips the raw `url`.
      const url = stream.proxied || stream.url || stream.videoUrl || "";
      if (!url) return "http";
      const declared = String(stream.type || "").toLowerCase();
      if (/\/embed_relay\//i.test(url.split("?")[0].split("#")[0])) return "embed";
      if (declared === "hls" || declared === "dash") return declared;
      if (/[?&]type=hls\b/i.test(url)) return "hls";
      if (/[?&]type=dash\b/i.test(url)) return "dash";
      if (Utils.isEmbedUrl(url)) return "embed";
      if (declared === "embed") return "embed";
      if (/\.m3u8(\?|$)/i.test(url)) return "hls";
      if (/\.mpd(\?|$)/i.test(url)) return "dash";
      if (/\/proxy_(m3u8|segment)\//i.test(url)) return declared === "dash" ? "dash" : "hls";
      return "http";
    };
  }
})();

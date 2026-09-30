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
    }
    frame.style.display = "block";
    // Only navigate when the URL actually changes, otherwise re-selecting
    // the active source would reload the player and lose position.
    if (frame.getAttribute("src") !== url) {
      frame.src = url;
    }

    // The native <video> and its custom controls do nothing for an embed;
    // hide them so they never overlay the iframe.
    const video = document.querySelector("#player-video");
    if (video) video.style.visibility = "hidden";
    const controls = wrapper.querySelector(".player-overlay");
    if (controls) controls.style.display = "none";

    this.renderSourcePicker();
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
  }

  /**
   * No-op in static mode. watch.html's skip button calls this
   * unconditionally; embeds own their own playback, so intro-skipping is
   * the iframe player's business. Kept so the call can never throw.
   */
  skipIntro() {}
}

window.playerInstance = window.playerInstance || null;

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

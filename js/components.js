/**
 * Reusable UI components for the kutta-anime frontend.
 *
 * Two card systems live here:
 *   - rail cards (.rail-card)  — the horizontal "Movy-style" rows on the
 *     catalogue/search pages, styled by .rail-* rules in style.css;
 *   - episode cards (.ep-card) — 16:9 artwork cards used by the detail page's
 *     episode grid and the watch page's sidebar.
 *
 * Everything is built through Utils.el so user-controlled strings (titles)
 * are inserted as text nodes and can never inject markup.
 */

const Components = {
  /* ------------------------------------------------------------------ *
   * Rail card (poster + title + facts line)                             *
   * ------------------------------------------------------------------ */

  /** One poster card for a horizontal rail or a search-results grid. */
  mediaCard(media, options = {}) {
    if (!media || !media.id) return document.createDocumentFragment();

    const id = media.id;
    const title = Utils.getDisplayTitle(media);
    const poster = Utils.getImageUrl(media, "cover");
    const score = media.score;
    const year = media.seasonYear || "";
    const format = media.format || "";

    const card = Utils.el("div", { className: "rail-card" });

    const link = Utils.el("a", {
      href: `anime.html?id=${id}`,
      className: "rail-card-link",
      onclick: (e) => {
        // Curtain handover: show the branded overlay immediately, then let
        // the navigation proceed. The destination page (anime.html) resumes
        // the same curtain and lifts it when its content is ready, so the
        // user never stares at a blank detail page mid-fetch.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        Transition.navigate(`anime.html?id=${id}`, "Loading");
      },
    });

    const posterWrap = Utils.el("div", { className: "rail-poster-wrap" });
    if (poster) {
      posterWrap.appendChild(Utils.el("img", {
        src: poster,
        alt: title,
        className: "rail-poster",
        loading: options.loading || "lazy",
        decoding: "async",
      }));
    }
    link.appendChild(posterWrap);

    const meta = Utils.el("div", { className: "rail-meta" });
    meta.appendChild(Utils.el("h3", {
      className: "rail-card-title",
      textContent: title,
    }));

    const facts = Utils.el("div", { className: "rail-facts" });
    const factBits = [];
    if (score) {
      factBits.push(Utils.el("span", { className: "rail-fact" }, [
        Utils.el("span", { className: "rail-star", textContent: "★" }),
        Utils.el("span", {
          className: "tabular",
          textContent: (score / 10).toFixed(1),
        }),
      ]));
    }
    if (year) {
      factBits.push(Utils.el("span", {
        className: "rail-fact tabular",
        textContent: String(year),
      }));
    }
    if (format) {
      factBits.push(Utils.el("span", {
        className: "rail-fact",
        textContent: format,
      }));
    }
    factBits.forEach((bit, index) => {
      if (index > 0) {
        facts.appendChild(Utils.el("span", { className: "rail-dot", textContent: "·" }));
      }
      facts.appendChild(bit);
    });
    meta.appendChild(facts);

    link.appendChild(meta);
    card.appendChild(link);
    return card;
  },

  /** Append more rail cards before the lazy-load sentinel. Returns the count. */
  appendCards(track, mediaList, options = {}) {
    if (!track || !Array.isArray(mediaList)) return 0;
    const sentinel = track.querySelector(".rail-sentinel");
    const frag = document.createDocumentFragment();
    let added = 0;
    mediaList.forEach(media => {
      if (!media || !media.id) return;
      frag.appendChild(this.mediaCard(media, { loading: options.loading || "lazy" }));
      added++;
    });
    if (sentinel) {
      track.insertBefore(frag, sentinel);
    } else {
      track.appendChild(frag);
    }
    return added;
  },

  /**
   * Extend a rail by one page whenever its end sentinel scrolls into view.
   *
   * `loadMore` must return the number of cards appended (or a falsy value /
   * promise resolving to one). When a fetch adds nothing the observer is
   * disconnected, so a short final page can never spin into endless requests.
   */
  wireLazyRail(track, loadMore) {
    if (!track || typeof loadMore !== "function") return;

    const row = track.closest(".rail-row");
    const sentinel = track.querySelector(".rail-sentinel");
    let loading = false;
    let exhausted = false;

    const updateEdges = () => {
      if (!row) return;
      const maxScroll = track.scrollWidth - track.clientWidth;
      row.dataset.atStart = track.scrollLeft <= 2 ? "true" : "false";
      row.dataset.atEnd = track.scrollLeft >= maxScroll - 2 ? "true" : "false";
      const prev = row.querySelector(".rail-arrow.prev");
      const next = row.querySelector(".rail-arrow.next");
      if (prev) prev.disabled = track.scrollLeft <= 2;
      if (next) next.disabled = maxScroll <= 2 || track.scrollLeft >= maxScroll - 2;
    };

    track.addEventListener("scroll", updateEdges, { passive: true });
    updateEdges();

    if (row) {
      row.querySelectorAll(".rail-arrow").forEach(arrow => {
        arrow.addEventListener("click", () => {
          const direction = arrow.classList.contains("prev") ? -1 : 1;
          track.scrollBy({
            left: direction * Math.max(track.clientWidth * 0.85, 200),
            behavior: "smooth",
          });
        });
      });
    }

    if (!sentinel || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(async entries => {
      if (!entries.some(e => e.isIntersecting) || loading || exhausted) return;
      loading = true;
      try {
        const added = await loadMore();
        if (!added) {
          exhausted = true;
          observer.disconnect();
          updateEdges();
        }
      } catch (err) {
        console.error("Rail load failed:", err);
        exhausted = true;
        observer.disconnect();
      } finally {
        loading = false;
      }
    }, {
      root: track,
      rootMargin: "0px 200px 0px 0px",
    });
    observer.observe(sentinel);
  },

  /* ------------------------------------------------------------------ *
   * Section rail (heading + scroller)                                   *
   * ------------------------------------------------------------------ */

  /** A titled horizontal rail of media cards. */
  section(title, mediaList, options = {}) {
    const section = Utils.el("section", { className: "rail" });

    const head = Utils.el("div", { className: "row-head" });
    head.appendChild(Utils.el("div", { className: "row-accent" }));

    const copy = Utils.el("div", { className: "row-copy" });
    const titleEl = Utils.el("h2", { className: "row-title" });
    if (options.href) {
      titleEl.appendChild(Utils.el("a", {
        className: "row-title-link",
        href: options.href,
      }, [
        Utils.el("span", { textContent: title }),
        Utils.el("span", {
          html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
        }),
      ]));
    } else {
      titleEl.textContent = title;
    }
    copy.appendChild(titleEl);
    if (options.subtitle) {
      copy.appendChild(Utils.el("p", {
        className: "row-subtitle",
        textContent: options.subtitle,
      }));
    }
    head.appendChild(copy);
    section.appendChild(head);

    const row = Utils.el("div", { className: "rail-row" });
    row.dataset.atStart = "true";
    row.dataset.atEnd = "false";

    const track = Utils.el("div", {
      className: "rail-track",
      id: options.id || null,
      tabindex: "0",
    });
    (mediaList || []).forEach(media => {
      const card = this.mediaCard(media, { loading: "lazy" });
      if (card) track.appendChild(card);
    });
    track.appendChild(Utils.el("div", { className: "rail-sentinel" }));
    row.appendChild(track);

    const prev = Utils.el("button", {
      className: "rail-arrow prev",
      type: "button",
      "aria-label": `Scroll ${title} backwards`,
      textContent: "‹",
    });
    prev.disabled = true;
    const next = Utils.el("button", {
      className: "rail-arrow next",
      type: "button",
      "aria-label": `Scroll ${title} forwards`,
      textContent: "›",
    });
    row.appendChild(prev);
    row.appendChild(next);

    section.appendChild(row);
    return section;
  },

  /* ------------------------------------------------------------------ *
   * Hero banner                                                         *
   * ------------------------------------------------------------------ */

  /** Full-bleed billboard for the featured title. */
  heroBanner(media) {
    if (!media) return this.heroBannerPlaceholder();

    const title = Utils.getDisplayTitle(media);
    const banner = Utils.getImageUrl(media, "banner") ||
      Utils.getImageUrl(media, "cover");

    const hero = Utils.el("div", { className: "hero-banner" });
    if (banner) {
      hero.appendChild(Utils.el("img", {
        src: banner,
        alt: "",
        decoding: "async",
      }));
    }
    hero.appendChild(Utils.el("div", { className: "hero-overlay" }));
    hero.appendChild(Utils.el("div", { className: "hero-vignette" }));

    const content = Utils.el("div", { className: "hero-content" });
    content.appendChild(Utils.el("h1", {
      className: "hero-title",
      textContent: title,
    }));

    const facts = Utils.el("div", { className: "hero-facts" });
    const bits = [];
    if (media.score) {
      bits.push(Utils.el("span", { className: "hero-fact" }, [
        Utils.el("span", { className: "rail-star", textContent: "★" }),
        Utils.el("span", {
          className: "tabular",
          textContent: (media.score / 10).toFixed(1),
        }),
      ]));
    }
    if (media.seasonYear) {
      bits.push(Utils.el("span", {
        className: "hero-fact tabular",
        textContent: String(media.seasonYear),
      }));
    }
    if (media.format) {
      bits.push(Utils.el("span", {
        className: "hero-fact",
        textContent: media.format,
      }));
    }
    bits.forEach((bit, index) => {
      if (index > 0) {
        facts.appendChild(Utils.el("span", { className: "rail-dot", textContent: "·" }));
      }
      facts.appendChild(bit);
    });
    content.appendChild(facts);

    content.appendChild(Utils.el("div", { className: "hero-actions" }, [
      Utils.el("a", {
        href: `watch.html?id=${media.id}&ep=1`,
        className: "btn btn-primary",
        textContent: "▶ Watch Now",
      }),
      Utils.el("a", {
        href: `anime.html?id=${media.id}`,
        className: "btn btn-secondary",
        textContent: "More Info",
      }),
    ]));

    hero.appendChild(content);
    return hero;
  },

  heroBannerPlaceholder() {
    const hero = Utils.el("div", { className: "hero-banner placeholder" });
    hero.appendChild(Utils.el("div", { className: "skeleton" }));
    return hero;
  },

  /* ------------------------------------------------------------------ *
   * Episode cards                                                       *
   * ------------------------------------------------------------------ */

  /** Best artwork available for a show's episode card.
   *
   * The portrait "dp" (the show's poster thumbnail) is preferred over the
   * wide banner on purpose: episode cards are 16:9 crops, and the poster's
   * subject is centred, so `object-fit: cover` keeps the character in frame,
   * while a cinematic banner crop often slices the top off.
   */
  episodeArtwork(media) {
    if (!media) return "";
    return media.thumbnail || media.thumbnail_medium || media.cover ||
      media.coverImage || media.banner || "";
  },

  /**
   * One 16:9 episode card.
   *
   * Used by the detail page's grid (plain) and the watch page's sidebar
   * (with `active` / `watched` state). The click handler is attached by the
   * caller, so the item itself stays a passive container.
   */
  episodeItem(episode, options = {}) {
    const num = episode.episode;
    const label = episode.title || `Episode ${num}`;
    const classes = ["episode-item"];
    if (options.active) classes.push("ep-active");
    if (options.watched) classes.push("ep-dim");

    const item = Utils.el("div", {
      className: classes.join(" "),
      dataset: { episode: num },
    });

    const card = Utils.el("div", { className: "ep-card" });
    const image = options.image || this.episodeArtwork(episode) || "";
    if (image) {
      card.appendChild(Utils.el("img", {
        src: image,
        alt: "",
        className: "ep-card-media",
        loading: "lazy",
        decoding: "async",
      }));
    }
    card.appendChild(Utils.el("div", { className: "ep-card-scrim" }));

    const body = Utils.el("div", { className: "ep-card-body" });
    body.appendChild(Utils.el("div", {
      className: "ep-card-kicker",
      textContent: `EP ${num}`,
    }));
    body.appendChild(Utils.el("div", {
      className: `ep-card-name${episode.title ? "" : " empty"}`,
      textContent: label,
    }));

    const foot = Utils.el("div", { className: "ep-card-foot" });
    foot.appendChild(Utils.el("span", {
      html: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    }));
    if (options.watched) {
      foot.appendChild(Utils.el("span", {
        className: "ep-card-tag",
        textContent: "Watched",
      }));
    } else if (episode.title) {
      foot.appendChild(Utils.el("span", {
        className: "ep-card-tag",
        textContent: "Play",
      }));
    }
    body.appendChild(foot);
    card.appendChild(body);

    if (options.watched) {
      card.appendChild(Utils.el("div", {
        className: "ep-card-watched",
        textContent: "Watched",
      }));
    }

    item.appendChild(card);
    return item;
  },

  /* ------------------------------------------------------------------ *
   * Small shared pieces                                                 *
   * ------------------------------------------------------------------ */

  /** Skeleton poster card for loading states. */
  skeletonCard() {
    const card = Utils.el("div", { className: "rail-card" });
    const wrap = Utils.el("div", { className: "rail-poster-wrap" });
    wrap.appendChild(Utils.el("div", {
      className: "skeleton",
      style: "position:absolute;inset:0;",
    }));
    card.appendChild(wrap);
    return card;
  },

  /** Create a loading spinner. */
  spinner() {
    return Utils.el("div", { className: "spinner" });
  },

  /** Empty-state message block. */
  noResults(message = "No results found") {
    const wrap = Utils.el("div", { className: "no-results" });
    wrap.appendChild(Utils.el("div", {
      className: "no-results-icon",
      textContent: "🔍",
    }));
    wrap.appendChild(Utils.el("p", { textContent: message }));
    return wrap;
  },

  /** Subtitle track <option>. */
  subtitleOption(label, value, isDefault) {
    return Utils.el("option", {
      value: value,
      textContent: label,
      selected: isDefault ? "selected" : "",
    });
  },

  /** Header nav item (kept for compatibility; header currently has no nav). */
  navItem(label, href, active = false) {
    return Utils.el("a", {
      href: href,
      className: `nav-link ${active ? "active" : ""}`,
      textContent: label,
    });
  },
};
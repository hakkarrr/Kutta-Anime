/**
 * Main application logic: routing, search, browsing, homepage rendering.
 */

class App {
  constructor() {
    this.currentPage = "home";
    this.searchTimeout = null;
    this.init();
  }

  init() {
    this.setupSearch();
    this.renderPage();
  }

  /**
   * The header no longer carries nav links.
   *
   * Home / Trending / Popular / Recent used to be rendered here into
   * `#nav-links`. They were removed from the top bar on request — every one of
   * those destinations is still reachable (the section headings link to them
   * and `?tab=` routes still work), so nothing became unreachable; the header
   * is now just the brand and the search box.
   */

  /**
   * Wire the header search box.
   *
   * The handler body only touches App methods, never instance state, so it can
   * be run as a bare static call — the static idiom of the same function.
   */
  static attachSearch() {
    App.prototype.setupSearch.call(Object.create(App.prototype));
  }

  setupSearch() {
    const searchBox = document.querySelector("#search-input");
    const suggestionsBox = document.querySelector("#search-suggestions");

    if (!searchBox) return;
    if (searchBox.dataset.searchBound === "1") return;
    searchBox.dataset.searchBound = "1";

    let currentSuggestions = [];
    // The suggestions are debounced, so a fast typist can press Enter before
    // any response has arrived. Tracking the in-flight query (rather than
    // only the last *rendered* list) is what makes Enter always do something.
    let pendingQuery = "";

    searchBox.addEventListener("input", Utils.debounce(async (e) => {
      const query = e.target.value.trim();
      if (query.length < 2) {
        currentSuggestions = [];
        this.hideSuggestions(suggestionsBox);
        return;
      }
      pendingQuery = query;
      try {
        const data = await API.suggestions(query);
        // A slower response for an older keystroke must not overwrite the
        // results for what is currently in the box.
        if (pendingQuery !== query) return;
        currentSuggestions = (data.results || []).filter(m => m && m.id);
        this.showSuggestions(suggestionsBox, currentSuggestions);
      } catch (err) {
        currentSuggestions = [];
        this.hideSuggestions(suggestionsBox);
      }
    }, 300));

    searchBox.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.hideSuggestions(suggestionsBox);
        return;
      }
      if (e.key !== "Enter") return;
      e.preventDefault();

      const query = searchBox.value.trim();
      if (!query) return;

      // Ctrl/Cmd+Enter jumps straight to the top hit; a plain Enter runs a
      // full search so the user can see *all* matches (a series has several
      // entries and picking the first one silently is how you end up on the
      // wrong season).
      if (e.ctrlKey || e.metaKey) {
        if (currentSuggestions.length) {
          this.goToAnime(currentSuggestions[0].id);
          return;
        }
      }

      const exact = currentSuggestions.find(
        m => Utils.getDisplayTitle(m).toLowerCase() === query.toLowerCase()
      );
      if (exact && e.ctrlKey) {
        this.goToAnime(exact.id);
        return;
      }
      this.goToSearch(query);
    });

    document.addEventListener("click", (e) => {
      if (!searchBox.contains(e.target) && suggestionsBox && !suggestionsBox.contains(e.target)) {
        this.hideSuggestions(suggestionsBox);
      }
    });
  }

  /** Navigate to a detail page, from either page flavour. */
  goToAnime(id) {
    if (!id) return;
    window.location.href = `anime.html?id=${id}`;
  }

  /** Run a full search. Works on every page, including the detail pages. */
  goToSearch(query) {
    const q = (query || "").trim();
    if (!q) return;
    // index.html is the catalogue page; the ?search= parameter drives it.
    window.location.href = `index.html?search=${encodeURIComponent(q)}`;
  }

  showSuggestions(container, suggestions) {
    if (!container) return;
    container.innerHTML = "";
    container.classList.add("active");

    if (suggestions.length === 0) {
      container.appendChild(Utils.el("div", {
        className: "suggestion-empty",
        textContent: "No results found",
      }));
      return;
    }

    suggestions.forEach(media => {
      const title = Utils.getDisplayTitle(media);
      const poster = Utils.getImageUrl(media, "cover");
      // Building the anchor explicitly (rather than innerHTML) keeps the title
      // as text: a title containing `<` or `&` previously injected markup.
      const thumb = Utils.el("img", { className: "suggestion-thumb", alt: "" });
      if (poster) thumb.src = poster;
      const item = Utils.el("a", {
        href: `anime.html?id=${media.id}`,
        className: "suggestion-item",
      }, [
        thumb,
        Utils.el("div", { className: "suggestion-info" }, [
          Utils.el("div", { className: "suggestion-title", textContent: title }),
          Utils.el("div", {
            className: "suggestion-meta",
            textContent: [
              media.format,
              media.seasonYear || "",
              media.episodes ? `${media.episodes} ep` : "",
            ].filter(Boolean).join(" · "),
          }),
        ]),
      ]);
      container.appendChild(item);
    });
  }

  hideSuggestions(container) {
    if (!container) return;
    container.innerHTML = "";
    container.classList.remove("active");
  }

  async renderPage() {
    // A search is its own page state. Previously `?search=` was ignored
    // entirely, so pressing Enter in the search box navigated to the homepage
    // and the search appeared to do nothing at all.
    const query = (Utils.getQueryParam("search", "") || "").trim();
    if (query) {
      this.currentPage = "search";
      this.syncSearchInput(query);
      await this.renderSearchResults(query);
      return;
    }

    const page = Utils.getQueryParam("tab", "home");
    this.currentPage = page;

    switch (page) {
      case "home":
        await this.renderHome();
        break;
      case "trending":
        await this.renderListPage("trending", "Trending");
        break;
      case "popular":
        await this.renderListPage("popular", "Popular");
        break;
      case "recent":
        await this.renderListPage("recent", "Recently Airing");
        break;
      default:
        await this.renderHome();
    }
  }

  /** Keep the header box in sync when the page is reached via a URL. */
  syncSearchInput(query) {
    const box = document.querySelector("#search-input");
    if (box && !box.value) box.value = query;
  }

  async renderSearchResults(query) {
    const content = document.querySelector("#home-content");
    const heroContainer = document.querySelector("#hero-container");
    if (heroContainer) heroContainer.innerHTML = "";
    if (!content) return;

    content.innerHTML = "";
    document.title = `Search: ${query} - Kutta Anime`;

    const head = Utils.el("div", { className: "search-head" });
    head.appendChild(Utils.el("h1", { className: "search-title", textContent: `Results for “${query}”` }));
    const status = Utils.el("p", { className: "search-status", textContent: "Searching…" });
    head.appendChild(status);
    content.appendChild(head);

    const grid = Utils.el("div", { className: "search-grid" });
    content.appendChild(grid);

    let page = 1;
    const perPage = 24;
    let total = 0;
    let hasMore = false;

    const loadPage = async () => {
      const data = await API.search(query, page, perPage);
      const results = (data.results || []).filter(m => m && m.id && !m.isAdult);

      if (page === 1) {
        status.textContent = results.length
          ? `${results.length}${hasMore ? "+" : ""} match${results.length === 1 ? "" : "es"}`
          : "No results found";
      }
      total += results.length;

      // The first card is the most likely match, so it is rendered larger —
      // but only on the first page, to keep the grid predictable below.
      const frag = document.createDocumentFragment();
      results.forEach((media, index) => {
        const featured = page === 1 && index === 0;
        const cell = Utils.el("div", {
          className: featured ? "search-cell search-cell-featured" : "search-cell",
        });
        cell.appendChild(Components.mediaCard(media, {
          loading: index < 6 ? "eager" : "lazy",
        }));
        frag.appendChild(cell);
      });
      grid.appendChild(frag);

      if (results.length > 0) status.textContent = `${total}${data.results.length >= perPage ? "+" : ""} match${total === 1 ? "" : "es"}`;
      hasMore = (data.results || []).length >= perPage;
      page++;
    };

    try {
      await loadPage();
    } catch (err) {
      status.textContent = `Search failed: ${err && err.message ? err.message : err}`;
      return;
    }

    if (grid.children.length === 0) {
      content.appendChild(Components.noResults(`Nothing matched “${query}”`));
      return;
    }

    if (hasMore) {
      const more = Utils.el("div", { className: "search-more" });
      more.appendChild(Utils.el("button", {
        type: "button",
        className: "btn btn-secondary",
        textContent: "Load more results",
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = "Loading…";
          try {
            await loadPage();
            btn.disabled = false;
            btn.textContent = "Load more results";
            if (!hasMore) more.remove();
          } catch (err) {
            btn.disabled = false;
            btn.textContent = "Load more results";
          }
        },
      }));
      content.appendChild(more);
    }
  }

  async renderHome() {
    const heroContainer = document.querySelector("#hero-container");
    const content = document.querySelector("#home-content");
    if (!content) return;

    content.innerHTML = "";

    /**
     * Rails start at 20 cards — long enough to overflow visibly without a
     * bigger first paint — and each one extends itself by another page only
     * when the user scrolls that rail to its end (Components.wireLazyRail).
     * The page therefore costs exactly one request per visible rail up front,
     * however far it can be scrolled.
     */
    const ROW_SIZE = 20;

    // PERF: paint skeleton rails immediately instead of an empty page. The
    // old code awaited the trending call before painting anything, so on a
    // cold cache the page stayed blank for the full AniList round-trip (~2s)
    // and the transition curtain had to cover all of it. With skeletons on
    // screen the curtain can lift as soon as the first rail arrives and the
    // rest streams in around it.
    const skeletonTrack = Components.section("Trending This Week", [], { id: "rail-trending" });
    content.appendChild(skeletonTrack);
    // Fill the skeleton rail with placeholder cards so it visually reads as
    // "loading" rather than an empty row.
    const skeletonRow = skeletonTrack.querySelector("#rail-trending");
    if (skeletonRow) {
      const placeholder = document.createDocumentFragment();
      for (let i = 0; i < 8; i++) placeholder.appendChild(Components.skeletonCard());
      skeletonRow.insertBefore(placeholder, skeletonRow.querySelector(".rail-sentinel"));
    }

    // Trending (finishes first in practice) drives the hero, then feeding the
    // already-fetched list into the first rail avoids a duplicate request.
    let trendingResults = [];
    try {
      const trending = await API.trending(1, ROW_SIZE);
      trendingResults = (trending.results || []).filter(m => m && !m.isAdult);
      if (heroContainer && trendingResults[0]) {
        heroContainer.innerHTML = "";
        heroContainer.appendChild(Components.heroBanner(trendingResults[0]));
      }
    } catch (err) {
      console.error("Hero error:", err);
      if (heroContainer) heroContainer.innerHTML = "";
    }

    // Remaining rails load in parallel.
    const [popular, recent, topRated] = await Promise.allSettled([
      API.popular(1, ROW_SIZE),
      API.recent(1, ROW_SIZE),
      API.trending(2, ROW_SIZE),
    ]);

    // Every rail gets a stable id and its own "next page" loader. `page` is
    // per-rail, so a rail the user scrolls to extends independently of the
    // others.
    const addRow = (id, title, subtitle, settled, method, startPage) => {
      if (settled.status !== "fulfilled") return;
      const results = (settled.value.results || []).filter(m => m && !m.isAdult);
      if (!results.length) return;

      const section = Components.section(title, results, {
        subtitle,
        href: `index.html?tab=${id}`,
        id: `rail-${id}`,
      });
      content.appendChild(section);

      const track = section.querySelector(`#rail-${id}`);
      if (!track) return;

      let page = startPage;
      Components.wireLazyRail(track, async () => {
        const next = page + 1;
        const data = await API[method](next, ROW_SIZE);
        const more = (data.results || []).filter(m => m && !m.isAdult);
        // Advance the cursor even when nothing was added, so a short/duplicate
        // page cannot make the loader request the same page forever.
        page = next;
        return Components.appendCards(track, more, { loading: "lazy" });
      });
    };

    if (trendingResults.length) {
      // Replace the skeleton rail in place (the skeleton is removed, so
      // there is never a second #rail-trending in the DOM).
      const trendingSection = Components.section("Trending This Week", trendingResults, {
        subtitle: "What everyone is watching this week",
        href: "index.html?tab=trending",
        id: "rail-trending",
      });
      skeletonTrack.replaceWith(trendingSection);

      const track = trendingSection.querySelector("#rail-trending");
      if (track) {
        // Page 1 of trending is already on screen; extend from page 2.
        let page = 1;
        Components.wireLazyRail(track, async () => {
          const next = page + 1;
          const data = await API.trending(next, ROW_SIZE);
          const more = (data.results || []).filter(m => m && !m.isAdult);
          page = next;
          return Components.appendCards(track, more, { loading: "lazy" });
        });
      }
    }

    addRow("popular", "Popular Now", "The most-watched titles right now", popular, "popular", 1);
    addRow("recent", "Recently Airing", "Fresh episodes and new seasons", recent, "recent", 1);
    addRow("top-rated", "Top Rated", "Highest rated of all time", topRated, "trending", 2);
  }

  async renderListPage(apiMethod, title) {
    const content = document.querySelector("#home-content");
    if (!content) return;

    const heroContainer = document.querySelector("#hero-container");
    if (heroContainer) heroContainer.innerHTML = "";

    content.innerHTML = "";

    let page = 1;
    const perPage = 18;
    let hasMore = true;
    let firstBatch = true;

    const loadMore = async () => {
      if (!hasMore) return;
      const data = await API[apiMethod](page, perPage);
      const results = (data.results || []).filter(m => m && !m.isAdult);
      if (results.length > 0) {
        // Page 1 is a rail; later pages append below it so the initial screen
        // keeps the same premium rhythm as the homepage.
        if (firstBatch) {
          content.appendChild(Components.section(title, results, {
            subtitle: `Page ${page}`,
          }));
          firstBatch = false;
        } else {
          const existing = content.querySelector(".rail-track");
          if (existing) {
            results.forEach(m => existing.appendChild(Components.mediaCard(m, { loading: "lazy" })));
          } else {
            content.appendChild(Components.section(`${title} · Page ${page}`, results));
          }
        }
        page++;
        if (results.length < perPage) hasMore = false;
      } else {
        hasMore = false;
      }
    };

    await loadMore();

    if (content.children.length === 0) {
      content.appendChild(Components.noResults("Nothing to show here yet"));
      return;
    }

    const sentinel = Utils.el("div", { id: "scroll-sentinel" });
    content.appendChild(sentinel);

    const observer = new IntersectionObserver(async (entries) => {
      if (entries[0].isIntersecting && hasMore) {
        await loadMore();
      }
    }, { rootMargin: "300px" });
    observer.observe(sentinel);
  }
}

/**
 * Boot the home/browse routing only where it belongs.
 *
 * `App` also owns the header search wiring, which the detail pages want. It is
 * instantiated only when the page actually has the home containers, so
 * loading this file elsewhere (to reuse `App.attachSearch`) is safe and does
 * not hijack a detail page with the home renderer.
 */
function bootApp() {
  const isCatalogue = document.querySelector("#home-content");
  if (!isCatalogue) return;
  window.app = new App();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootApp);
} else {
  bootApp();
}
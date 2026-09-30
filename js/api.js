/**
 * Static API shim for GitHub Pages.
 *
 * Reimplements every /anime/* endpoint the original frontend consumed as
 * direct browser calls to public, CORS-friendly services (AniList GraphQL,
 * AniZip, ARM). Response shapes are byte-compatible with the backend
 * payloads the UI was written against, so app.js / components.js /
 * watch.html work unmodified.
 *
 * Playback: Vidnest embeds only (constructed URLs, no scraping, no server).
 * A local Python backend (optional, v2) is auto-detected and unlocks the
 * direct-HLS servers — see the backend probe at the bottom of this file.
 */

const ANILIST_URL = "https://graphql.anilist.co";
const ANIZIP_URL = "https://api.ani.zip/mappings";
const ARM_URL = "https://arm.haglund.dev/api/v2/ids";
const VIDNEST_BASE = "https://vidnest.fun";

// Two-tier cache (session + persistent).
//
// The in-memory Map covers the live session; the localStorage tier survives
// reloads and app restarts. That persistence is what fixes the "reopened the
// app and it came back faded/half-loaded" loop: a page whose AniList calls
// all fail (rate limit, upstream outage) used to render its structure with
// nothing in it and keep the user stuck until the API recovered. With a
// persistent tier the *previous* good payload is served instantly on reload
// while fresh data is fetched underneath, so the app always has something
// real to show.
const _cache = new Map();
const _CACHE_TTL = 5 * 60 * 1000;
// Persistent entries live far longer: catalog/season data is effectively
// static, and a stale-but-real payload beats a hard failure every time.
const _PERSIST_TTL = 24 * 60 * 60 * 1000;
const _PERSIST_PREFIX = "ka_api_";
// Cap the persistent tier so one long session can never fill the ~5MB
// localStorage quota: the newest entries matter, so prune from the front.
const _PERSIST_MAX_ENTRIES = 300;

function _cacheGet(key) {
  const entry = _cache.get(key);
  if (entry) {
    if (Date.now() - entry.at > _CACHE_TTL) _cache.delete(key);
    else return entry.value;
  }
  // Memory miss: try the persistent tier.
  try {
    const raw = localStorage.getItem(_PERSIST_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.at !== "number" || parsed.v === undefined) return null;
    if (Date.now() - parsed.at > _PERSIST_TTL) {
      localStorage.removeItem(_PERSIST_PREFIX + key);
      return null;
    }
    _cache.set(key, parsed);
    return parsed.v;
  } catch (e) {
    // Corrupt entry, quota error, or storage disabled: drop it quietly.
    try { localStorage.removeItem(_PERSIST_PREFIX + key); } catch (e2) { /* ignore */ }
    return null;
  }
}

function _cacheSet(key, value) {
  const entry = { value, at: Date.now() };
  _cache.set(key, entry);
  try {
    localStorage.setItem(_PERSIST_PREFIX + key, JSON.stringify(entry));
    // Enforce the cap: drop the oldest entries first.
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(_PERSIST_PREFIX)) keys.push(k);
    }
    if (keys.length > _PERSIST_MAX_ENTRIES) {
      const withTime = keys.map(k => {
        try {
          const p = JSON.parse(localStorage.getItem(k));
          return { k, at: (p && p.at) || 0 };
        } catch (e) { return { k, at: 0 }; }
      }).sort((a, b) => a.at - b.at);
      const excess = withTime.length - _PERSIST_MAX_ENTRIES;
      for (let i = 0; i < excess; i++) localStorage.removeItem(withTime[i].k);
    }
  } catch (e) {
    // Quota exceeded or storage disabled: the in-memory cache still works.
    try { localStorage.clear(); } catch (e2) { /* ignore */ }
  }
}

// --- GraphQL ------------------------------------------------------------

let _anilistQueue = Promise.resolve();

/**
 * Serialize AniList requests and retry transient failures.
 *
 * AniList rate-limits aggressively (~90 req/min, and it degrades well below
 * that under burst). The backend used asyncio + retries; the browser
 * equivalent is a promise queue (so a homepage of parallel rails cannot fire
 * 8 requests in one tick) plus exponential backoff on 429/5xx.
 *
 * The backoff is deliberately SHORT: 500ms/1s/2s rather than the old
 * 0.6s/1.2s/2.4s/4.8s. AniList's rate-limit window is per-minute, so a retry
 * that lands seconds later usually succeeds; the old ladder could hold a
 * page hostage for ~9s of silent waiting and still give up right as the
 * window rolled over — the "everything stops working, then fixes itself a
 * minute later" signature. A jitter term desynchronizes parallel retries so
 * they do not all slam the API on the same tick.
 */
async function _anilist(query, variables = {}, attempt = 0) {
  const run = async () => {
    // A fetch without a timeout can hang for the OS-level TCP window
    // (tens of seconds on flaky mobile networks). Because every AniList
    // call shares one promise queue, a single hung request would stall
    // EVERY page — the "app loads nothing until I kill and reopen it"
    // signature. Abort after 12s and treat it as a retryable failure.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let resp;
    try {
      resp = await fetch(ANILIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      // AbortError here = our own timeout; anything else is a network error.
      // Both are transient, so fall through to the same retry ladder.
      if (attempt >= 2) throw new Error("AniList unreachable (network timeout)");
      const jitter = Math.random() * 250;
      const delay = Math.min(2000, 500 * Math.pow(2, attempt)) + jitter;
      await new Promise(r => setTimeout(r, delay));
      return _anilist(query, variables, attempt + 1);
    }
    clearTimeout(timer);
    if (resp.status === 429 || resp.status >= 500) {
      if (attempt >= 2) throw new Error(`AniList rate limit exceeded (HTTP ${resp.status})`);
      const jitter = Math.random() * 250;
      const delay = Math.min(2000, 500 * Math.pow(2, attempt)) + jitter;
      await new Promise(r => setTimeout(r, delay));
      return _anilist(query, variables, attempt + 1);
    }
    if (!resp.ok) {
      throw new Error(`AniList returned ${resp.status}`);
    }
    const data = await resp.json();
    if (data.errors && data.errors.length) {
      throw new Error(String(data.errors[0] && data.errors[0].message || "AniList error"));
    }
    return data.data || {};
  };

  // Chain onto the queue so requests leave one at a time.
  const result = _anilistQueue.then(run, run);
  // Keep the queue alive even when a request fails.
  _anilistQueue = result.catch(() => {});
  return result;
}

// --- Title / image helpers (mirror the backend's English-first rule) -----

function displayTitle(title) {
  if (!title) return "";
  return title.english || title.romaji || title.native || "Unknown";
}

function _seasonLabel(season) {
  return season ? season.charAt(0) + season.slice(1).toLowerCase() : "";
}

/**
 * The minimal media shape every rail/suggestion/card consumes.
 * Field names deliberately match the backend's `_format_media` output:
 * id, title (flat string), thumbnail, banner, score (0-100), seasonYear,
 * format, status, episodes, genres, nextAiringEpisode, isAdult.
 */
function _formatMedia(m, options = {}) {
  if (!m) return null;
  const out = {
    id: m.id,
    idMal: m.idMal != null ? m.idMal : null,
    isAdult: !!m.isAdult,
    title: displayTitle(m.title),
    title_english: (m.title || {}).english || null,
    title_romaji: (m.title || {}).romaji || null,
    title_native: (m.title || {}).native || null,
    thumbnail: (m.coverImage || {}).large || (m.coverImage || {}).medium || "",
    thumbnail_medium: (m.coverImage || {}).medium || "",
    banner: m.bannerImage || "",
    score: m.averageScore || 0,
    seasonYear: m.seasonYear || null,
    season: _seasonLabel(m.season),
    format: m.format || null,
    status: m.status || null,
    episodes: m.episodes || null,
    duration: m.duration || null,
    genres: m.genres || [],
    popularity: m.popularity || null,
    nextAiringEpisode: m.nextAiringEpisode
      ? { episode: m.nextAiringEpisode.episode, airingAt: m.nextAiringEpisode.airingAt }
      : null,
    description: m.description || "",
    studios: ((m.studios || {}).nodes || []).map(n => n.name).filter(Boolean),
  };
  if (options.full) {
    out.characters = m._characters || [];
    out.recommendations = m._recommendations || [];
    out.trailer = (m.trailer || {}).thumbnail || null;
    out.startDate = m.startDate || null;
    out.endDate = m.endDate || null;
    out.meanScore = m.meanScore || null;
  }
  return out;
}

// --- GraphQL documents (mirrors extractor.py) ----------------------------

const MEDIA_FIELDS = `
  id idMal isAdult
  title { romaji english native }
  description(asHtml: false)
  status format episodes duration
  season seasonYear
  startDate { year month day }
  endDate { year month day }
  nextAiringEpisode { episode airingAt }
  genres
  averageScore meanScore popularity
  coverImage { large medium }
  bannerImage
  studios { nodes { name } }
  trailer { thumbnail }
  streamingEpisodes { title url thumbnail }
`;

const SEASON_RELATION_NODE = `
  id idMal isAdult
  type
  title { romaji english native }
  coverImage { large medium }
  bannerImage
  format status episodes seasonYear averageScore
`;

const Q_MEDIA = `
query ($id: Int, $search: String, $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    media(id: $id, search: $search, type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
      ${MEDIA_FIELDS}
    }
  }
}`;

const Q_CHARACTERS = `
query ($id: Int, $page: Int, $perPage: Int) {
  Media(id: $id) {
    characters(page: $page, perPage: $perPage, sort: FAVOURITES_DESC) {
      edges {
        node { id name { first last } image { large } }
        role
        voiceActors { name { first last } language }
      }
    }
  }
}`;

const Q_RECS = `
query ($id: Int) {
  Media(id: $id) {
    recommendations(sort: RATING_DESC) {
      edges {
        node {
          media {
            id
            title { romaji english native }
            coverImage { large }
            averageScore
            format
          }
        }
      }
    }
  }
}`;

const Q_TRENDING = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    media(type: ANIME, sort: TRENDING_DESC, isAdult: false) {
      id idMal isAdult title { romaji english native }
      coverImage { large medium }
      bannerImage averageScore popularity
      format episodes status nextAiringEpisode { episode airingAt }
    }
  }
}`;

const Q_POPULAR = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
      id idMal isAdult title { romaji english native }
      coverImage { large medium }
      bannerImage averageScore popularity
      format episodes status nextAiringEpisode { episode airingAt }
    }
  }
}`;

const Q_RECENT = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    media(type: ANIME, sort: START_DATE_DESC, status: RELEASING, isAdult: false) {
      id idMal isAdult title { romaji english native }
      coverImage { large medium }
      bannerImage averageScore popularity
      format episodes status nextAiringEpisode { episode airingAt }
    }
  }
}`;

const Q_SEASON_RELATIONS = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id idMal isAdult
    title { romaji english native }
    coverImage { large medium }
    bannerImage
    format status episodes seasonYear averageScore
    relations {
      edges {
        relationType
        node { ${SEASON_RELATION_NODE} }
      }
    }
  }
}`;

// --- Episode titles from AniList's streamingEpisodes ----------------------

const _EP_TITLE_RE = /^\s*(?:episode|ep|e)\s*\.?\s*0*(\d+)\s*(?:[-–—:.]\s*)?(.*)$/i;

function episodeTitles(media) {
  const titles = {};
  for (const entry of (media || {}).streamingEpisodes || []) {
    if (!entry || typeof entry !== "object") continue;
    const raw = (entry.title || "").trim();
    if (!raw) continue;
    const match = _EP_TITLE_RE.exec(raw);
    if (!match) continue;
    const number = parseInt(match[1], 10);
    let title = (match[2] || "").trim();
    if (!title) continue;
    title = title.replace(/^\s*\d+\s*[-–—:.]\s*/, "").trim();
    title = title.replace(/[-–—:.]+$/, "").trim();
    if (title && !(number in titles)) titles[number] = title;
  }
  return titles;
}

// --- Franchise walking (port of endpoints.py _season_bundle) --------------

const _SEASON_MARKERS = new Set([
  "season", "seasons", "part", "parts", "cour", "final", "the", "movie",
  "specials", "special", "ova", "ona", "tv", "chapter", "arc", "zenpen",
  "kouhen", "kai", "hen", "kanketsu", "and", "of", "to", "no", "wa", "ga",
  "wo", "ni", "de", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x",
]);

function _normalizeTitle(value) {
  return String(value || "").toLowerCase().replace(/[^\w\s]+/g, " ").replace(/\s+/g, " ").trim();
}

function _isRomanNumeral(word) {
  return word.length <= 4 && word.length > 0 && /^[ivxlcdm]+$/.test(word);
}

function _titleWords(normalized) {
  return new Set(
    normalized.split(" ").filter(w =>
      w && !_SEASON_MARKERS.has(w) && !/^\d+$/.test(w) && !_isRomanNumeral(w)
    )
  );
}

function _sharesFranchise(rootNorm, rootWords, candidateNorm) {
  if (!candidateNorm || !rootWords || rootWords.size === 0) return false;
  if (candidateNorm.startsWith(rootNorm) || rootNorm.startsWith(candidateNorm)) return true;

  const candidateWords = _titleWords(candidateNorm);
  if (candidateWords.size === 0) return false;

  let subset = true;
  for (const w of rootWords) {
    if (!candidateWords.has(w)) { subset = false; break; }
  }
  if (!subset) return false;

  const rootSequence = rootNorm.split(" ").filter(w => rootWords.has(w));
  const candidateSequence = candidateNorm.split(" ").filter(w => candidateWords.has(w));
  const head = candidateSequence.slice(0, rootSequence.length);
  if (head.join(" ") === rootSequence.join(" ")) return true;
  if (head.length !== rootSequence.length) return false;
  let same = true;
  for (const w of rootWords) {
    if (!head.includes(w)) { same = false; break; }
  }
  return same;
}

function _seasonEntry(media, isCurrent) {
  const title = media.title || {};
  return {
    anilistId: media.id,
    title: displayTitle(title),
    title_english: title.english || null,
    title_romaji: title.romaji || null,
    thumbnail: (media.coverImage || {}).large || "",
    banner: media.bannerImage || "",
    format: media.format || null,
    status: media.status || null,
    seasonYear: media.seasonYear || null,
    episodeCount: media.episodes || 0,
    score: media.averageScore || null,
    isCurrent: !!isCurrent,
  };
}

function _seasonSortKey(season) {
  const year = season.seasonYear;
  return [year ? 0 : 1, year || 0, season.anilistId || 0];
}

/**
 * A season list is only trustworthy if it is anchored at the FRANCHISE ROOT
 * — the entry whose title every other entry derives from. The page the user
 * is on is almost never that root: "Shingeki no Kyojin Season 3 Part 2" is a
 * mid-chain entry whose title carries no franchise name, so walking SEQUEL
 * edges from *it* collects only the entries after it, and renumbering that
 * fragment from "Season 1" is what made every season page claim to be
 * Season 1 and every chip navigate to the wrong entry.
 *
 * The root is recovered by walking PREQUEL edges upward until the chain
 * ends. Titles alone cannot pick the root ("The Final Season" does not
 * contain "Shingeki no Kyojin"), but AniList's relation graph can.
 */
const _seasonNodeCache = new Map();

async function _findFranchiseRoot(anilistId) {
  let currentId = anilistId;
  const guard = new Set([currentId]);
  for (let hops = 0; hops < 10; hops++) {
    let node = _seasonNodeCache.get(currentId) || null;
    if (!node) {
      try {
        const data = await _anilist(Q_SEASON_RELATIONS, { id: currentId });
        node = data.Media || null;
      } catch (e) {
        node = null;
      }
      if (node) _seasonNodeCache.set(currentId, node);
    }
    if (!node) return currentId;
    // The shallowest PREQUEL edge that stays within the franchise shape.
    const prequel = ((node.relations || {}).edges || []).find(edge => {
      const candidate = edge.node || {};
      return edge.relationType === "PREQUEL"
        && candidate.id
        && !guard.has(candidate.id)
        && ["TV", "TV_SHORT", "ONA", "SPECIAL"].includes(candidate.format)
        && (!candidate.type || candidate.type === "ANIME");
    });
    const prequelId = prequel && prequel.node && prequel.node.id;
    if (!prequelId) return currentId;
    guard.add(prequelId);
    currentId = prequelId;
  }
  // Ten hops without an end is a data pathology, not a franchise; stop on
  // the last verified node rather than looping.
  return currentId;
}

async function _seasonBundle(anilistId) {
  const cacheKey = `seasons:${anilistId}`;
  const cached = _cacheGet(cacheKey);
  if (cached) return cached;

  const rootId = await _findFranchiseRoot(anilistId);
  let root = _seasonNodeCache.get(rootId) || null;
  if (!root) {
    try {
      const data = await _anilist(Q_SEASON_RELATIONS, { id: rootId });
      root = data.Media || null;
    } catch (e) {
      root = null;
    }
  }
  if (!root) {
    const result = {
      currentAnilistId: anilistId,
      currentSeasonOrder: null,
      totalSeasons: 0,
      totalEpisodes: 0,
      seasons: [],
      source: "unavailable",
    };
    _cacheSet(cacheKey, result);
    return result;
  }

  const rootTitle = (root.title || {}).romaji || (root.title || {}).english || "";
  const rootNorm = _normalizeTitle(rootTitle);
  const rootWords = _titleWords(rootNorm);

  const seen = new Set([rootId]);
  const seasons = [_seasonEntry(root, rootId === anilistId)];

  // BFS over SEQUEL relations from the franchise root, up to four levels
  // deep (S1 -> S2 -> S3 -> S3P2 -> Final covers every AoT season).
  let frontier = [rootId];
  const visited = new Map([[rootId, root]]);

  for (let depth = 0; depth < 4; depth++) {
    const nextFrontier = [];
    const missing = frontier.filter(id => !visited.has(id));
    await Promise.all(missing.map(async id => {
      try {
        const d = await _anilist(Q_SEASON_RELATIONS, { id });
        if (d.Media) visited.set(id, d.Media);
      } catch (e) { /* branch ends here */ }
    }));
    for (const nodeId of frontier) {
      const node = visited.get(nodeId);
      if (!node) continue;
      for (const edge of ((node.relations || {}).edges || [])) {
        const candidate = edge.node || {};
        if (!candidate.id || seen.has(candidate.id)) continue;
        if (edge.relationType !== "SEQUEL") continue;
        if (!["TV", "TV_SHORT", "ONA", "SPECIAL"].includes(candidate.format)) continue;
        if (candidate.type && candidate.type !== "ANIME") continue;
        const title = (candidate.title || {}).romaji || (candidate.title || {}).english || "";
        if (!_sharesFranchise(rootNorm, rootWords, _normalizeTitle(title))) continue;
        seen.add(candidate.id);
        seasons.push(_seasonEntry(candidate, candidate.id === anilistId));
        nextFrontier.push(candidate.id);
      }
    }
    frontier = nextFrontier;
    if (!frontier.length) break;
  }

  // A franchise walked from its root can still miss an entry whose SEQUEL
  // edge is absent or malformed on AniList. Each visited node is asked for
  // its own PREQUEL-chain head as a cross-check; any id that reports a
  // different root than the one we walked from is appended so the strip
  // never silently splits a franchise in two.
  const crossCheckIds = [...visited.keys()].filter(id => id !== rootId);
  await Promise.all(crossCheckIds.map(async id => {
    try {
      const headId = await _findFranchiseRoot(id);
      if (headId !== rootId && !seen.has(headId)) {
        const d = await _anilist(Q_SEASON_RELATIONS, { id: headId });
        if (d.Media) {
          const title = (d.Media.title || {}).romaji || (d.Media.title || {}).english || "";
          if (_sharesFranchise(rootNorm, rootWords, _normalizeTitle(title))) {
            seen.add(headId);
            seasons.push(_seasonEntry(d.Media, headId === anilistId));
          }
        }
      }
    } catch (e) { /* cross-check is best-effort */ }
  }));

  // Refresh stale entries (sequels reached via shallow edges may lack
  // year/cover) so season chips show real metadata.
  const stale = seasons.filter(s =>
    s.anilistId !== anilistId && !(s.seasonYear && s.thumbnail));
  await Promise.all(stale.map(async season => {
    const node = _seasonNodeCache.get(season.anilistId);
    if (node) { Object.assign(season, _seasonEntry(node, false)); return; }
    try {
      const d = await _anilist(Q_SEASON_RELATIONS, { id: season.anilistId });
      if (d.Media) Object.assign(season, _seasonEntry(d.Media, false));
    } catch (e) { /* keep the shallow entry */ }
  }));

  seasons.sort((a, b) => {
    const ka = _seasonSortKey(a), kb = _seasonSortKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
  seasons.forEach((s, i) => { s.order = i + 1; });

  const result = {
    currentAnilistId: anilistId,
    currentSeasonOrder: (seasons.find(s => s.anilistId === anilistId) || {}).order || null,
    totalSeasons: seasons.length,
    totalEpisodes: seasons.reduce((sum, s) => sum + (s.episodeCount || 0), 0),
    seasons,
    source: "anilist.relations",
  };
  _cacheSet(cacheKey, result);
  return result;
}

// --- AniZip episode mapping (episode counts + gapless fallback) -----------

async function _anizipMapping(anilistId) {
  const cacheKey = `anizip:${anilistId}`;
  const cached = _cacheGet(cacheKey);
  if (cached) return cached;

  let anizip = {};
  try {
    const resp = await fetch(`${ANIZIP_URL}?anilist_id=${anilistId}`, {
      headers: { "Accept": "application/json" },
    });
    if (resp.ok) anizip = await resp.json();
  } catch (e) { anizip = {}; }

  const result = { anizip_episodes: [], titles: anizip.titles || {}, episodesObj: anizip.episodes || {} };

  const entries = anizip.episodes || {};
  const regular = [];
  const allNumbers = [];
  for (const key of Object.keys(entries).sort((a, b) => {
    const na = /^\d+$/.test(a) ? parseInt(a, 10) : 1e9;
    const nb = /^\d+$/.test(b) ? parseInt(b, 10) : 1e9;
    return na - nb;
  })) {
    if (!/^\d+$/.test(key)) continue;
    const number = parseInt(key, 10);
    if (number === 0) continue;
    allNumbers.push(number);
    const entry = entries[key];
    if (entry && typeof entry === "object" && entry.absoluteEpisodeNumber != null) continue;
    regular.push(number);
  }

  const gapless = nums => nums.length > 0 && nums.every((n, i) => n === i + 1);
  let chosen = [];
  if (gapless(regular)) chosen = regular;
  else if (gapless(allNumbers)) chosen = allNumbers;
  result.anizip_episodes = chosen;

  _cacheSet(cacheKey, result);
  return result;
}

// --- Vidnest URL builder (port of providers/vidnest.py) -------------------

const _PAHE_SERVERS = ["", "primesrc", "sigma"];
const _ZORO_SERVERS = ["", "alfa", "beta", "gama", "delta"];

function vidnestStreams(anilistId, ep, audio = "sub") {
  if (!anilistId || !ep) return [];
  const lang = String(audio || "sub").toLowerCase() === "dub" ? "dub" : "sub";
  const streams = [];
  const seen = new Set();

  const build = (prefix, server) => {
    let url = `${VIDNEST_BASE}/${prefix}/${anilistId}/${ep}/${lang}`;
    if (server) url += `?server=${encodeURIComponent(server)}`;
    return url;
  };

  // Labels are anonymized: the UI must only ever show "Server N", never the
  // upstream name (same contract as the backend's stream normalization).
  const backends = [
    ["animepahe", _PAHE_SERVERS],
    ["anime", _ZORO_SERVERS],
  ];
  let n = 0;
  for (const [prefix, servers] of backends) {
    for (const server of servers) {
      const url = build(prefix, server);
      if (seen.has(url)) continue;
      seen.add(url);
      n += 1;
      streams.push({
        url,
        type: "embed",
        server: `Server ${n}`,
        host: `Server ${n}`,
        quality: "auto",
      });
    }
  }
  return streams;
}

// --- The API object (drop-in replacement for the backend client) ----------

/**
 * Cached loader for the homepage rails (trending / popular / recent).
 *
 * These three calls build the ENTIRE homepage, yet they were the only
 * AniList paths with no cache at all — every app reopen re-fetched them
 * over the network, so one rate-limit window or dead Wi-Fi moment rendered
 * the exact screenshot the user reported: the skeleton "Trending This
 * Week" rail with nothing in it, forever.
 *
 * Behaviour:
 *  - Fresh cache (memory or localStorage) is served instantly.
 *  - A network fetch refreshes the cache in the background.
 *  - On failure, the last cached copy of ANY age is served (stale beats
 *    dead — the payload is a popularity list, not financial data).
 *  - Only when there has never been a successful fetch does the error
 *    propagate, so the UI can show an honest Retry panel.
 */
async function _railRequest(kind, query, page, perPage) {
  const cacheKey = `rail:${kind}:${page}:${perPage}`;
  const cached = _cacheGet(cacheKey);
  const refresh = async () => {
    const data = await _anilist(query, { page, perPage });
    const results = ((data.Page || {}).media || []).map(m => _formatMedia(m));
    _cacheSet(cacheKey, results);
    return { results };
  };

  if (cached) {
    // Serve the cache now; refresh silently so the next open is current.
    refresh().catch(() => {});
    return { results: cached };
  }
  try {
    return await refresh();
  } catch (err) {
    // Nothing fresh and nothing cached under the live key: accept ANY
    // prior copy of this rail before giving up.
    const staleKey = `rail:${kind}:${page}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(_PERSIST_PREFIX + staleKey)) {
        try {
          const parsed = JSON.parse(localStorage.getItem(k));
          if (parsed && parsed.v) return { results: parsed.v };
        } catch (e) { /* skip corrupt */ }
      }
    }
    throw err;
  }
}

const API = {
  // The static site has no backend base URL; endpoints are reimplemented
  // below. Kept as an empty string so any legacy relative call is a no-op
  // rather than a request to the Pages origin.
  baseURL: "",

  async get() { throw new Error("Static mode: use the reimplemented API methods"); },
  async post() { throw new Error("Static mode: use the reimplemented API methods"); },

  // --- Search & Browse ---

  async search(query, page = 1, perPage = 20) {
    perPage = Math.max(1, Math.min(perPage, 50));
    const clean = String(query || "").trim();
    if (!clean) return { results: [], page, per_page: perPage, query: "" };

    const cacheKey = `search:${clean}:${page}:${perPage}`;
    const cached = _cacheGet(cacheKey);
    if (cached) return { results: cached, page, per_page: perPage, query: clean };

    let results = [];
    // Searching the AniList id is exact and cheap (mirrors the backend).
    if (/^\d+$/.test(clean)) {
      try {
        const data = await _anilist(Q_MEDIA, { id: parseInt(clean, 10), page: 1, perPage: 1 });
        if (data.Page && data.Page.media && data.Page.media.length) {
          results = data.Page.media;
        }
      } catch (e) { /* fall through to text search */ }
    }

    if (!results.length) {
      const data = await _anilist(Q_MEDIA, { search: clean, page, perPage });
      results = (data.Page && data.Page.media) || [];
    }

    const formatted = results.filter(m => !m.isAdult).map(m => _formatMedia(m));
    _cacheSet(cacheKey, formatted);
    return { results: formatted, page, per_page: perPage, query: clean };
  },

  async suggestions(query) {
    const clean = String(query || "").trim();
    if (clean.length < 2) return { results: [] };
    const cacheKey = `suggest:${clean}`;
    const cached = _cacheGet(cacheKey);
    if (cached) return { results: cached };

    const data = await _anilist(Q_MEDIA, { search: clean, page: 1, perPage: 8 });
    const formatted = (data.Page.media || []).filter(m => !m.isAdult)
      .map(m => _formatMedia(m));
    _cacheSet(cacheKey, formatted);
    return { results: formatted };
  },

  async seasons(anilistId) {
    return _seasonBundle(parseInt(anilistId, 10));
  },

  async trending(page = 1, perPage = 20) {
    return _railRequest("trending", Q_TRENDING, page, perPage);
  },

  async popular(page = 1, perPage = 20) {
    return _railRequest("popular", Q_POPULAR, page, perPage);
  },

  async recent(page = 1, perPage = 20) {
    return _railRequest("recent", Q_RECENT, page, perPage);
  },

  async schedule(page = 1, perPage = 20) {
    // The backend mapped schedule onto "recently airing"; same here.
    return this.recent(page, perPage);
  },

  async spotlight(page = 1, perPage = 20) {
    // The backend mapped spotlight onto trending; same here.
    return this.trending(page, perPage);
  },

  async genres() {
    const cacheKey = "genres";
    const cached = _cacheGet(cacheKey);
    if (cached) return { results: cached };
    const data = await _anilist(`query { GenreCollection }`);
    const list = data.GenreCollection || [];
    _cacheSet(cacheKey, list);
    return { results: list };
  },

  async filter(params = {}) {
    // Genre/season browsing via a direct GraphQL query. The backend exposed
    // this for the (currently unused) filter UI; kept for compatibility.
    const page = params.page || 1;
    const perPage = params.per_page || 20;
    const genre = params.genre || null;
    const year = params.year || null;
    const sort = params.sort || "POPULARITY_DESC";
    // AniList rejects null for genre_in inside an argument list in some
    // versions, so the query is built with the genre fixed-in when present.
    // (GraphQL has no ternary; the original inline `$genre ? [$genre] : null`
    // would be a parse error.)
    const genreClause = genre ? `genre_in: ["${String(genre).replace(/"/g, '\\"')}"]` : "";
    const data = await _anilist(`
      query ($page: Int, $perPage: Int, $year: Int) {
        Page(page: $page, perPage: $perPage) {
          media(type: ANIME, sort: ${sort}, isAdult: false,
                ${genreClause}
                seasonYear: $year) {
            ${MEDIA_FIELDS}
          }
        }
      }`, { page, perPage, year });
    return { results: (data.Page.media || []).map(m => _formatMedia(m)) };
  },

  // --- Anime Details ---

  async info(anilistId) {
    const id = parseInt(anilistId, 10);
    const cacheKey = `info:${id}`;
    const cached = _cacheGet(cacheKey);
    if (cached) return cached;

    // Characters and recommendations are supplementary: a failure must
    // degrade the page, not fail it. But the media call itself previously
    // swallowed its own error with `.catch(() => null)`, so a rate-limited
    // fetch resolved as "Anime not found" — a wrong message and a dead page
    // for what is usually a transient hiccup. Let the real error through so
    // the caller's Retry button makes sense ("temporary network failure" was
    // the message the user actually saw here).
    const [mediaData, characters, recommendations] = await Promise.all([
      _anilist(Q_MEDIA, { id, page: 1, perPage: 1 }),
      this._charactersRaw(id).catch(() => []),
      this._recommendationsRaw(id).catch(() => []),
    ]);

    const media = mediaData && mediaData.Page && mediaData.Page.media
      && mediaData.Page.media[0];
    if (!media) throw new Error("Anime not found");

    media._characters = characters;
    media._recommendations = recommendations;
    const result = _formatMedia(media, { full: true });
    _cacheSet(cacheKey, result);
    return result;
  },

  async _charactersRaw(anilistId) {
    const data = await _anilist(Q_CHARACTERS, { id: anilistId, page: 1, perPage: 12 });
    const edges = (((data.Media || {}).characters || {}).edges) || [];
    return edges.map(edge => {
      const node = edge.node || {};
      const name = node.name || {};
      const fullName = [name.first, name.last].filter(Boolean).join(" ") || "Unknown";
      const actor = (edge.voiceActors || []).find(va =>
        (va.language || "").toLowerCase() === "japanese") || (edge.voiceActors || [])[0];
      const actorName = actor && actor.name
        ? [actor.name.first, actor.name.last].filter(Boolean).join(" ")
        : null;
      return {
        id: node.id != null ? node.id : null,
        name: fullName,
        image: (node.image || {}).large || null,
        role: edge.role || null,
        voiceActor: actorName,
      };
    }).filter(c => c.name);
  },

  async _recommendationsRaw(anilistId) {
    const data = await _anilist(Q_RECS, { id: anilistId });
    const edges = (((data.Media || {}).recommendations || {}).edges) || [];
    return edges
      .map(e => e.node && e.node.media)
      .filter(Boolean)
      .map(m => ({
        id: m.id,
        title: displayTitle(m.title),
        thumbnail: (m.coverImage || {}).large || "",
        score: m.averageScore || null,
        format: m.format || null,
      }));
  },

  async characters(anilistId, page = 1, perPage = 20) {
    const results = await this._charactersRaw(parseInt(anilistId, 10));
    return { results, page, per_page: perPage };
  },

  async recommendations(anilistId, page = 1, perPage = 20) {
    const results = await this._recommendationsRaw(parseInt(anilistId, 10));
    return { results };
  },

  // --- Episodes ---

  async episodes(anilistId, page = 1, perPage = 50) {
    const id = parseInt(anilistId, 10);
    perPage = Math.max(1, Math.min(perPage, 1250));
    const cacheKey = `episodes:${id}:${page}:${perPage}`;
    const cached = _cacheGet(cacheKey);
    if (cached) return cached;

    // One GraphQL round-trip serves both the media object (for
    // streamingEpisodes titles) and the declared episode count.
    const [mediaData, mapping] = await Promise.all([
      _anilist(Q_MEDIA, { id, page: 1, perPage: 1 }).catch(() => null),
      _anizipMapping(id),
    ]);
    const media = mediaData && mediaData.Page && mediaData.Page.media
      && mediaData.Page.media[0];
    const titles = episodeTitles(media);

    let epCount = parseInt((media && media.episodes) || 0, 10) || 0;
    const mapped = mapping.anizip_episodes || [];
    if (!epCount && mapped.length) epCount = mapped.length;

    const startIdx = (page - 1) * perPage;
    const endIdx = startIdx + perPage;
    const totalPages = Math.max(1, Math.ceil(epCount / perPage));

    const episodes = [];
    for (let i = startIdx + 1; i <= Math.min(endIdx, epCount); i++) {
      episodes.push({
        episode: i,
        label: `Episode ${String(i).padStart(2, "0")}`,
        title: titles[i] || null,
        mediaRef: `/watch/${id}/${i}`,
      });
    }

    let seasons = [];
    try {
      const bundle = await _seasonBundle(id);
      seasons = bundle.seasons || [];
    } catch (e) { /* season chips are decoration */ }
    if (seasons.length <= 1) seasons = [];

    const seasonInfo = {
      currentAnilistId: id,
      currentSeasonOrder: (seasons.find(s => s.anilistId === id) || {}).order || null,
      totalSeasons: seasons.length,
      totalEpisodes: seasons.reduce((sum, s) => sum + (s.episodeCount || 0), 0),
      seasonEpisodeCount: episodes.length,
      seasons,
    };

    const result = {
      anilistId: id,
      source: epCount ? (mapped.length ? "anizip" : "until_anilist_reports") : "none",
      status: (media && media.status) || null,
      episodes,
      episodeNumbers: mapped,
      titledEpisodes: Object.keys(titles).length,
      seasonInfo,
      pagination: {
        page,
        perPage,
        totalEpisodes: epCount,
        totalPages,
        hasMore: page < totalPages,
      },
    };
    // Only cache a usable answer (a zero-episode result is usually a hiccup).
    if (episodes.length) _cacheSet(cacheKey, result);
    return result;
  },

  // --- Stream Extraction (Vidnest embeds only in static mode) ---

  async extract(anilistId, ep = 1, type = "sub", provider = null) {
    const id = parseInt(anilistId, 10);
    const streams = vidnestStreams(id, ep, type);
    return {
      streams: streams.map(s => ({
        ...s,
        // The static site plays embeds directly in an iframe — no proxy, no
        // signing. The `proxied` field stays unset so the player's
        // Player.sourceUrl resolver falls through to `url`.
        proxied: null,
      })),
      provider: "vidnest-static",
      diagnostics: { vidnest: { ok: true, streams: streams.length, error: null } },
    };
  },

  async sources(episodeId, provider = null, anilistId = null, category = "sub") {
    let resolvedId = anilistId;
    let resolvedEp = 1;
    if (episodeId) {
      const parts = String(episodeId).split("/").filter(Boolean);
      if (parts[0] === "watch" || parts[0] === "anime") parts.shift();
      if (parts.length && /^\d+$/.test(parts[0])) {
        resolvedId = resolvedId || parts[0];
        if (parts.length > 1 && /^\d+$/.test(parts[1])) resolvedEp = parseInt(parts[1], 10);
      }
    }
    if (!resolvedId) {
      throw new Error("anilistId (or a numeric episodeId) is required");
    }
    return this.extract(resolvedId, resolvedEp, category, provider);
  },

  async providerStatus() {
    return {
      mode: "static",
      providers: ["vidnest"],
      note: "Static site: Vidnest embeds only. A local backend unlocks direct-HLS servers.",
    };
  },

  // --- Proxy (deprecated in static mode; embeds need no proxy) ---

  proxyM3u8(url) {
    console.warn("proxyM3u8 is unavailable in static mode");
    return url;
  },

  proxySegment(url) {
    console.warn("proxySegment is unavailable in static mode");
    return url;
  },
};

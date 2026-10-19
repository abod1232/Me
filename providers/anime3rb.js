const TMDB_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
const TMDB = "https://api.themoviedb.org/3";
const MAIN = "https://anime3rb.com";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const log = (...a) => console.log("[Anime3rb]", ...a);

// ======================
// Helper Functions
// ======================

const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, "").trim();

async function fetchHtml(url, headers = {}) {
  const r = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      Referer: `${MAIN}/`,
      ...headers
    }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function tmdbTitles(tmdbId, mediaType) {
  const type = mediaType === "movie" ? "movie" : "tv";
  const res = await fetch(`${TMDB}/${type}/${tmdbId}?api_key=${TMDB_KEY}&append_to_response=alternative_titles`);
  const d = await res.json();
  const main = d.name || d.title || "";
  const alt = ((d.alternative_titles || {}).results || []).map(t => t.title);
  return {
    titles: [main, ...alt].filter(Boolean),
    year: (d.first_air_date || d.release_date || "").split("-")[0] || null
  };
}

// ======================
// Search (Direct GET without Livewire)
// ======================

async function search(query) {
  // بحث مباشر عبر GET لتجنب مشاكل Livewire والـ Tokens
  const searchUrls = [
    `${MAIN}/titles?q=${encodeURIComponent(query)}`,
    `${MAIN}/search?q=${encodeURIComponent(query)}`
  ];

  for (const url of searchUrls) {
    try {
      const html = await fetchHtml(url);
      const items = [];
      
      // استخراج بطاقات الأنمي من نتائج البحث
      const cardRegex = /<a[^>]+href="([^"]*\/titles\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = cardRegex.exec(html)) !== null) {
        const link = match[1];
        const inner = match[2];
        const titleMatch = inner.match(/<h[34][^>]*>([\s\S]*?)<\/h[34]>/i) || inner.match(/class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\//i);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";
        
        if (link && title) {
          items.push({
            title,
            url: link.startsWith("http") ? link : `${MAIN}${link}`
          });
        }
      }
      if (items.length) return items;
    } catch {
      continue;
    }
  }
  return [];
}

const exactMatch = (items, title) => {
  const t = norm(title);
  return items.find(i => norm(i.title) === t);
};

const closeMatch = (items, title) => {
  const t = norm(title);
  return items.find(i => {
    const n = norm(i.title);
    return n && (n.includes(t) || t.includes(n));
  });
};

async function findAnime(titles) {
  for (const t of titles) {
    let items = [];
    try { items = await search(t); } catch { continue; }
    const hit = exactMatch(items, t) || closeMatch(items, t);
    if (hit) return hit;
  }
  return null;
}

// ======================
// Video Extractor
// ======================

async function extractStreamsFromPlayer(playerUrl, streamTitle) {
  try {
    const playerHtml = await fetchHtml(playerUrl, {
      Referer: `${MAIN}/`,
      Host: "video.vid3rb.com"
    });

    const jsonMatch = playerHtml.match(/var\s+video_sources\s*=\s*(\[[\s\S]*?\]);/);
    if (!jsonMatch) return [];

    const sources = JSON.parse(jsonMatch[1]);
    const out = [];

    for (const item of sources) {
      if (item.premium === true || item.premium === "true") continue;
      
      const rawUrl = item.src || item.file;
      if (!rawUrl) continue;

      const url = rawUrl.replace(/\\/g, "").replace(/&amp;/g, "&");
      const label = item.label || "HD";
      const qMatch = label.match(/\d+/);
      const quality = qMatch ? `${qMatch[0]}p` : label;

      out.push({
        name: `Anime3rb - ${label}`,
        title: streamTitle,
        url: url,
        quality: quality,
        size: "Unknown",
        headers: {
          "User-Agent": BROWSER_UA,
          Referer: "https://video.vid3rb.com/"
        },
        provider: "anime3rb"
      });
    }

    return out;
  } catch (err) {
    log(`extract error: ${err.message}`);
    return [];
  }
}

// ======================
// Main Function (getStreams)
// ======================

async function getStreams(tmdbId, mediaType = "movie", seasonNum = null, episodeNum = null) {
  const isMovie = mediaType === "movie";
  const s = seasonNum || 1;
  const e = episodeNum || 1;
  log(`tmdb=${tmdbId} type=${mediaType}${isMovie ? "" : ` S${s}E${e}`}`);

  try {
    const { titles, year } = await tmdbTitles(tmdbId, mediaType);
    if (!titles.length) return [];
    
    const title = titles[0];
    log(`tmdb: "${title}" (${year})${titles.length > 1 ? ` +${titles.length - 1} alt` : ""}`);
    const streamTitle = `${title}${isMovie ? (year ? ` (${year})` : "") : ` S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`}`;

    // 1. البحث عن صفحة الأنمي
    const anime = await findAnime(titles);
    if (!anime) {
      log("not found on Anime3rb");
      return [];
    }
    log(`matched: "${anime.title}" -> ${anime.url}`);

    // 2. قراءة صفحة الأنمي للوصول لرابط الحلقة المطلوبة
    const animePageHtml = await fetchHtml(anime.url);
    const epRegex = /<a[^>]+href="([^"]*\/episode\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    
    let epMatch;
    let targetEpUrl = null;
    let firstEpUrl = null;

    while ((epMatch = epRegex.exec(animePageHtml)) !== null) {
      const link = epMatch[1];
      const text = epMatch[2].replace(/<[^>]+>/g, " ").trim();
      const numMatch = text.match(/\d+/);
      const fullUrl = link.startsWith("http") ? link : `${MAIN}${link}`;

      if (!firstEpUrl) firstEpUrl = fullUrl;

      if (numMatch && parseInt(numMatch[0], 10) === e) {
        targetEpUrl = fullUrl;
        break;
      }
    }

    const episodeUrl = targetEpUrl || firstEpUrl || anime.url;
    log(`target episode url: ${episodeUrl}`);

    // 3. قراءة صفحة الحلقة لاستخراج رابط المشغل
    const epHtml = await fetchHtml(episodeUrl);
    const playerPattern = /https:(?:\\\/|\/){2}video\.vid3rb\.com(?:\\\/|\/)player(?:\\\/|\/)[^"' \s]+/i;
    const playerMatch = epHtml.match(playerPattern);

    if (!playerMatch) {
      log("player iframe not found");
      return [];
    }

    const playerUrl = playerMatch[0].replace(/\\/g, "").replace(/&amp;/g, "&");
    log(`player url found: ${playerUrl}`);

    // 4. استخراج روابط التشغيل المباشرة
    const streams = await extractStreamsFromPlayer(playerUrl, streamTitle);
    log(`returning ${streams.length} streams`);
    return streams;

  } catch (err) {
    log(`error: ${err.message}`);
    return [];
  }
}

module.exports = { getStreams };

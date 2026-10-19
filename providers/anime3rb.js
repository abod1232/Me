const TMDB_KEY = "1865f43a0549ca50d341dd9ab8b29f49";
const TMDB = "https://api.themoviedb.org/3";
const BASE_URL = "https://anime3rb.com";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

const log = (...a) => console.log("[Anime3rb]", ...a);

let savedCookies = "";

// ======================
// Helper Functions
// ======================

async function fetchText(url, headers = {}) {
  const reqHeaders = {
    "User-Agent": BROWSER_UA,
    ...headers
  };
  if (savedCookies) reqHeaders["Cookie"] = savedCookies;

  const res = await fetch(url, { headers: reqHeaders });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) savedCookies = setCookie;

  return await res.text();
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, ...headers }
  });
  return await res.json();
}

function decodeEntities(str) {
  if (!str) return "";
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'");
}

// ======================
// TMDB Title Resolver
// ======================

async function tmdbTitles(tmdbId, mediaType) {
  try {
    const type = mediaType === "tv" ? "tv" : "movie";
    let realId = tmdbId;

    if (String(tmdbId).startsWith("tt")) {
      const findData = await fetchJson(
        `${TMDB}/find/${tmdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`
      );
      realId =
        type === "movie"
          ? findData?.movie_results?.[0]?.id
          : findData?.tv_results?.[0]?.id;
    }

    if (!realId) return [];

    const d = await fetchJson(
      `${TMDB}/${type}/${realId}?api_key=${TMDB_KEY}&append_to_response=alternative_titles`
    );
    const main = d.name || d.title || "";
    const alt = ((d.alternative_titles || {}).results || []).map(t => t.title);
    return [main, ...alt].filter(Boolean);
  } catch (err) {
    log("TMDB error:", err.message);
    return [];
  }
}

// ======================
// Anime3rb Search (Livewire)
// ======================

async function searchAnime(query) {
  try {
    const html = await fetchText(BASE_URL);

    // استخراج CSRF Token بواسطة Regex بدلاً من Cheerio
    const csrfMatch =
      html.match(/data-csrf="([^"]+)"/i) ||
      html.match(/script[^>]+data-csrf="([^"]+)"/i);
    const csrfToken = csrfMatch ? csrfMatch[1] : null;

    // استخراج Livewire Snapshot بواسطة Regex
    const snapMatch = html.match(/wire:snapshot="([^"]+)"/i);
    const snapshotRaw = snapMatch ? snapMatch[1] : null;

    if (!csrfToken || !snapshotRaw) {
      log("Livewire tokens not found");
      return null;
    }

    const snapshotStr = decodeEntities(snapshotRaw);
    const updateUrl = `${BASE_URL}/livewire/update`;

    const payload = {
      _token: csrfToken,
      components: [
        {
          snapshot: snapshotStr,
          updates: { query: query },
          calls: []
        }
      ]
    };

    const res = await fetch(updateUrl, {
      method: "POST",
      headers: {
        "User-Agent": BROWSER_UA,
        "Content-Type": "application/json",
        Accept: "*/*",
        Origin: BASE_URL,
        Referer: `${BASE_URL}/`,
        Cookie: savedCookies
      },
      body: JSON.stringify(payload)
    });

    const resJson = await res.json();
    const htmlContent = resJson?.components?.[0]?.effects?.html || "";

    // استخراج أول رابط لبطاقة أنمي
    const linkMatch =
      htmlContent.match(/<a[^>]*class="[^"]*simple-title-card[^"]*"[^>]*href="([^"]+)"/i) ||
      htmlContent.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*simple-title-card[^"]*"/i);

    if (!linkMatch) return null;
    const link = linkMatch[1];
    return link.startsWith("http") ? link : `${BASE_URL}${link}`;
  } catch (e) {
    log("Search error:", e.message);
    return null;
  }
}

// ======================
// Vid3rb Player Extractor
// ======================

async function extractVid3rb(episodeUrl) {
  try {
    const epHtml = await fetchText(episodeUrl);

    // استخراج رابط مشغل vid3rb
    const playerPattern = /https:(?:\\\/|\/){2}video\.vid3rb\.com(?:\\\/|\/)player(?:\\\/|\/)[^"' \s]+/i;
    const match = epHtml.match(playerPattern);
    if (!match) return [];

    const playerUrl = match[0].replace(/\\/g, "").replace(/&amp;/g, "&");

    const playerHtml = await fetchText(playerUrl, {
      Host: "video.vid3rb.com",
      Referer: `${BASE_URL}/`
    });

    // استخراج مصفوفة السيرفرات
    const jsonMatch = playerHtml.match(/var\s+video_sources\s*=\s*(\[[\s\S]*?\]);/);
    if (!jsonMatch) return [];

    const videoSources = JSON.parse(jsonMatch[1]);
    const streams = [];

    for (const item of videoSources) {
      if (item.premium === true || item.premium === "true") continue;

      let src = item.src ? item.src.replace(/\\/g, "").replace(/&amp;/g, "&") : null;
      if (!src) continue;

      const label = item.label || "HD";
      const qualityMatch = label.match(/\d+/);
      const quality = qualityMatch ? `${qualityMatch[0]}p` : "720p";

      streams.push({
        name: `Anime3rb - ${label}`,
        title: `Anime3rb (${label})`,
        url: src,
        quality: quality,
        size: "Unknown",
        headers: {
          "User-Agent": BROWSER_UA,
          Referer: "https://video.vid3rb.com/"
        },
        provider: "anime3rb"
      });
    }

    return streams;
  } catch (e) {
    log("Extractor error:", e.message);
    return [];
  }
}

// ======================
// Main getStreams Function
// ======================

async function getStreams(tmdbId, mediaType = "movie", seasonNum = null, episodeNum = null) {
  const isMovie = mediaType === "movie";
  const s = seasonNum || 1;
  const e = episodeNum || 1;

  log(`tmdb=${tmdbId} type=${mediaType}${isMovie ? "" : ` S${s}E${e}`}`);

  try {
    const titles = await tmdbTitles(tmdbId, mediaType);
    if (!titles.length) {
      log("No titles found on TMDB");
      return [];
    }

    log(`Searching for: ${titles[0]}`);

    let animeUrl = null;
    for (const title of titles.slice(0, 3)) {
      animeUrl = await searchAnime(title);
      if (animeUrl) break;
    }

    if (!animeUrl) {
      log("Anime not found on Anime3rb");
      return [];
    }

    log(`Found Anime page: ${animeUrl}`);

    const animePageHtml = await fetchText(animeUrl);

    // استخراج روابط الحلقات بواسطة Regex
    const epRegex = /<a[^>]+href="([^"]*\/episode\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let epMatch;
    let targetEpisodeUrl = null;
    let firstEpisodeUrl = null;

    while ((epMatch = epRegex.exec(animePageHtml)) !== null) {
      const href = epMatch[1];
      const innerText = epMatch[2].replace(/<[^>]+>/g, " ").trim();
      const numMatch = innerText.match(/\d+/);

      const fullHref = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      if (!firstEpisodeUrl) firstEpisodeUrl = fullHref;

      if (numMatch && parseInt(numMatch[0], 10) === e) {
        targetEpisodeUrl = fullHref;
        break;
      }
    }

    // إذا لم يجد الحلقة برقمها المباشر يأخذ الحلقة الأولى أو الرابط الحالي
    const finalUrl = targetEpisodeUrl || firstEpisodeUrl || animeUrl;
    log(`Selected Episode URL: ${finalUrl}`);

    const streams = await extractVid3rb(finalUrl);
    log(`Returning ${streams.length} streams`);

    return streams;
  } catch (err) {
    log(`Error: ${err.message}`);
    return [];
  }
}

module.exports = { getStreams };

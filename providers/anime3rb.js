const TMDB_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
const TMDB = "https://api.themoviedb.org/3";
const MAIN = "https://cinemana.shabakaty.cc";
const API = `${MAIN}/api/android`;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const log = (...a) => console.log("[Cinemana]", ...a);

// تنظيف النصوص للمطابقة
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, "").trim();

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      Referer: `${MAIN}/`
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// 1. جلب العناوين والأسماء البديلة وسنة الإنتاج من TMDB
async function tmdbInfo(tmdbId, mediaType) {
  try {
    const type = mediaType === "movie" ? "movie" : "tv";
    let realId = tmdbId;

    if (String(tmdbId).startsWith("tt")) {
      const findRes = await fetchJson(
        `${TMDB}/find/${tmdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`
      );
      realId =
        type === "movie"
          ? findRes?.movie_results?.[0]?.id
          : findRes?.tv_results?.[0]?.id;
    }

    if (!realId) return { titles: [], year: null };

    const d = await fetchJson(
      `${TMDB}/${type}/${realId}?api_key=${TMDB_KEY}&append_to_response=alternative_titles`
    );
    const main = d.name || d.title || "";
    const alt = ((d.alternative_titles || {}).results || []).map((t) => t.title);
    return {
      titles: [main, ...alt].filter(Boolean),
      year: parseInt((d.first_air_date || d.release_date || "").slice(0, 4), 10) || null
    };
  } catch (e) {
    log("TMDB error:", e.message);
    return { titles: [], year: null };
  }
}

// 2. البحث في سينمانا (أفلام / مسلسلات)
async function searchCinemana(query, isMovie) {
  const type = isMovie ? "movies" : "series";
  const url = `${API}/AdvancedSearch?level=0&videoTitle=${encodeURIComponent(
    query
  )}&staffTitle=${encodeURIComponent(query)}&page=0&type=${type}&itemsPerPage=15`;

  try {
    const data = await fetchJson(url);
    if (Array.isArray(data)) return data;
    return [];
  } catch (err) {
    log(`Search error for "${query}":`, err.message);
    return [];
  }
}

// 3. مطابقة النتائج مع عناوين TMDB
function matchItem(items, titles, year) {
  for (const item of items) {
    const en = norm(item.en_title);
    const ar = norm(item.ar_title);
    const itemYear = parseInt(item.year, 10) || 0;

    for (const t of titles) {
      const target = norm(t);
      if (!target) continue;

      const isExact = en === target || ar === target;
      const isClose = (en && en.includes(target)) || (ar && ar.includes(target));

      if (isExact || isClose) {
        // التحقق من السنة إن وُجدت
        if (year && itemYear && Math.abs(year - itemYear) > 1) {
          continue;
        }
        return item;
      }
    }
  }
  return null;
}

// 4. استخراج الحلقة المطلوبة للمسلسلات
async function resolveEpisodeVideoId(seriesId, seasonNum, episodeNum) {
  const url = `${API}/videoSeason/id/${seriesId}`;
  try {
    const episodes = await fetchJson(url);
    if (!Array.isArray(episodes)) return null;

    const targetEp = episodes.find((ep) => {
      const s = parseInt(ep.season, 10);
      const e = parseInt(ep.episodeNummer, 10);
      return s === seasonNum && e === episodeNum;
    });

    return targetEp ? targetEp.nb : null;
  } catch (e) {
    log("Failed to fetch episodes:", e.message);
    return null;
  }
}

// 5. استخراج الترجمات المتوفرة
async function fetchSubtitles(videoId) {
  try {
    const detailsUrl = `${API}/allVideoInfo/id/${videoId}`;
    const details = await fetchJson(detailsUrl);
    const translations = details.translations || [];

    return translations
      .filter((t) => t.file)
      .map((t) => ({
        lang: t.name || "العربية",
        url: t.file
      }));
  } catch {
    return [];
  }
}

// 6. استخراج روابط التشغيل المباشرة
async function extractStreams(videoId, streamTitle) {
  const url = `${API}/transcoddedFiles/id/${videoId}`;
  try {
    const files = await fetchJson(url);
    if (!Array.isArray(files) || !files.length) return [];

    // جلب ملفات الترجمة
    const subtitles = await fetchSubtitles(videoId);
    const out = [];

    // ترتيب السيرفرات من الأعلى دقة إلى الأقل
    for (const file of files.reverse()) {
      const videoUrl = file.videoUrl;
      if (!videoUrl) continue;

      const resolution = file.resolution || "HD";
      out.push({
        name: `Cinemana - ${resolution}`,
        title: streamTitle,
        url: videoUrl,
        quality: resolution,
        size: "Unknown",
        subtitles: subtitles,
        headers: {
          "User-Agent": BROWSER_UA,
          Referer: `${MAIN}/`
        },
        provider: "cinemana"
      });
    }

    return out;
  } catch (e) {
    log("Error loading streams:", e.message);
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
    const { titles, year } = await tmdbInfo(tmdbId, mediaType);
    if (!titles.length) {
      log("No titles found on TMDB");
      return [];
    }

    const streamTitle = `${titles[0]}${
      isMovie
        ? year
          ? ` (${year})`
          : ""
        : ` S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`
    }`;

    // البحث في سينمانا
    let matchedItem = null;
    for (const title of titles.slice(0, 4)) {
      const results = await searchCinemana(title, isMovie);
      matchedItem = matchItem(results, titles, year);
      if (matchedItem) break;
    }

    if (!matchedItem || !matchedItem.nb) {
      log("Not found on Cinemana");
      return [];
    }

    log(`Found: "${matchedItem.ar_title || matchedItem.en_title}" (ID: ${matchedItem.nb})`);

    let targetVideoId = matchedItem.nb;

    // إذا كان مسلسلاً، نصل لرقم الفيديو الخاص بالحلقة
    if (!isMovie) {
      targetVideoId = await resolveEpisodeVideoId(matchedItem.nb, s, e);
      if (!targetVideoId) {
        log(`Episode S${s}E${e} not found`);
        return [];
      }
    }

    log(`Target Video ID: ${targetVideoId}`);

    // استخراج الروابط المباشرة والترجمات
    const streams = await extractStreams(targetVideoId, streamTitle);
    log(`Returning ${streams.length} streams`);

    return streams;
  } catch (err) {
    log(`General Error: ${err.message}`);
    return [];
  }
}

module.exports = { getStreams };

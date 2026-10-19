"use strict";

import cheerio from "cheerio-without-node-native";

// ======================
// Constants
// ======================

const BASE_URL = "https://anime3rb.com";
const TMDB_API_KEY = "1865f43a0549ca50d341dd9ab8b29f49";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DEFAULT_HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept-Language": "ar,en;q=0.9"
};

let savedCookies = "";

// ======================
// Helpers & Utils
// ======================

function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'");
}

function cleanTitle(str) {
  return str
    .replace(/\\n|\n/g, " ")
    .replace(/بترجمة.*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url, headers = DEFAULT_HEADERS) {
  const finalHeaders = { ...headers };
  if (savedCookies) finalHeaders["Cookie"] = savedCookies;

  const res = await fetch(url, { headers: finalHeaders });
  
  // حفظ ملفات تعريف الارتباط إن وجدت
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) savedCookies = setCookie;

  return await res.text();
}

async function fetchJson(url, headers = DEFAULT_HEADERS) {
  const res = await fetch(url, { headers });
  return await res.json();
}

// ======================
// TMDB Title Resolver
// ======================

async function resolveTmdbTitle(tmdbId, mediaType) {
  try {
    let finalTmdbId = tmdbId;
    if (String(tmdbId).startsWith("tt")) {
      const findUrl = `https://api.themoviedb.org/3/find/${tmdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
      const data = await fetchJson(findUrl);
      finalTmdbId =
        mediaType === "movie"
          ? data?.movie_results?.[0]?.id
          : data?.tv_results?.[0]?.id;
    }

    if (!finalTmdbId) return null;

    const detailsUrl = `https://api.themoviedb.org/3/${mediaType}/${finalTmdbId}?api_key=${TMDB_API_KEY}`;
    const mediaInfo = await fetchJson(detailsUrl);
    return mediaInfo.title || mediaInfo.name;
  } catch (e) {
    console.log(`[Anime3rb] TMDB Error: ${e.message}`);
    return null;
  }
}

// ======================
// Livewire Search Handler
// ======================

async function searchAnime(query) {
  try {
    const mainHtml = await fetchText(BASE_URL);
    const $ = cheerio.load(mainHtml);

    // استخراج CSRF Token
    const csrfToken = $('script[src*="livewire.min.js"]').attr("data-csrf");
    // استخراج Livewire Snapshot
    const snapshotRaw = $("form[wire\\:id]").attr("wire:snapshot");

    if (!csrfToken || !snapshotRaw) {
      console.log("[Anime3rb] Failed to extract Livewire tokens");
      return null;
    }

    const snapshotStr = decodeHtmlEntities(snapshotRaw);

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

    const headers = {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
      Accept: "*/*",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      Cookie: savedCookies
    };

    const response = await fetch(updateUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const resJson = await response.json();
    const htmlContent = resJson?.components?.[0]?.effects?.html;
    if (!htmlContent) return null;

    const $search = cheerio.load(htmlContent);
    const firstResult = $search("a.simple-title-card").first();
    const link = firstResult.attr("href");

    if (!link) return null;
    return link.startsWith("http") ? link : `${BASE_URL}${link}`;
  } catch (e) {
    console.log(`[Anime3rb] Search Error: ${e.message}`);
    return null;
  }
}

// ======================
// Stream Extractor (Vid3rb)
// ======================

async function extractVid3rbStreams(episodeUrl) {
  try {
    const epHtml = await fetchText(episodeUrl);

    // البحث عن رابط مشغل الفيديو vid3rb
    const playerPattern = /https:(?:\\\/|\/){2}video\.vid3rb\.com(?:\\\/|\/)player(?:\\\/|\/)[^"' \s]+/i;
    const match = epHtml.match(playerPattern);

    if (!match) {
      console.log("[Anime3rb] Player URL not found");
      return [];
    }

    const playerUrl = match[0]
      .replace(/\\/g, "")
      .replace(/&amp;/g, "&")
      .replace(/\\u0026/g, "&");

    // طلب كود صفحة المشغل
    const playerHeaders = {
      Host: "video.vid3rb.com",
      "User-Agent": USER_AGENT,
      Referer: `${BASE_URL}/`
    };

    const playerHtml = await fetchText(playerUrl, playerHeaders);

    // استخراج مصفوفة السيرفرات: var video_sources = [...];
    const jsonPattern = /var\s+video_sources\s*=\s*(\[[\s\S]*?\]);/;
    const jsonMatch = playerHtml.match(jsonPattern);

    if (!jsonMatch) {
      console.log("[Anime3rb] video_sources array not found");
      return [];
    }

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
        headers: {
          "User-Agent": USER_AGENT,
          Referer: "https://video.vid3rb.com/"
        }
      });
    }

    return streams;
  } catch (e) {
    console.log(`[Anime3rb] Stream extraction error: ${e.message}`);
    return [];
  }
}

// ======================
// Main Provider (getStreams)
// ======================

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    console.log(`[Anime3rb] Resolving ${mediaType} - ID: ${tmdbId}`);

    // 1. استخراج الاسم من TMDB
    const title = await resolveTmdbTitle(tmdbId, mediaType);
    if (!title) {
      console.log("[Anime3rb] Could not resolve title from TMDB");
      return [];
    }

    console.log(`[Anime3rb] Searching for: ${title}`);

    // 2. البحث داخل anime3rb
    const animeUrl = await searchAnime(title);
    if (!animeUrl) {
      console.log("[Anime3rb] No matching anime found on site");
      return [];
    }

    console.log(`[Anime3rb] Anime page: ${animeUrl}`);

    // 3. جلب صفحة الأنمي لاستخراج الحلقة
    const animePageHtml = await fetchText(animeUrl);
    const $ = cheerio.load(animePageHtml);

    let targetEpisodeUrl = null;
    const targetEpNum = parseInt(episode, 10) || 1;

    // مطابقة رقم الحلقة من قائمة الحلقات
    $(".video-list a").each((_, el) => {
      const epText = $(el).find(".video-data").children().first().text();
      const epNum = parseInt(epText.replace(/\D/g, ""), 10);

      if (epNum === targetEpNum) {
        const href = $(el).attr("href");
        targetEpisodeUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
        return false; // إيقاف التكرار عند إيجاد الحلقة
      }
    });

    // إذا لم يجد الحلقة بالرقم (أو كان فيلماً)، يأخذ الرابط الأول
    if (!targetEpisodeUrl) {
      const firstEp = $(".video-list a").first().attr("href");
      if (firstEp) {
        targetEpisodeUrl = firstEp.startsWith("http") ? firstEp : `${BASE_URL}${firstEp}`;
      } else {
        targetEpisodeUrl = animeUrl; // في حال كانت الصفحة نفسها هي صفحة المشاهدة
      }
    }

    console.log(`[Anime3rb] Episode URL: ${targetEpisodeUrl}`);

    // 4. استخراج الروابط المباشرة من المشغل
    const streams = await extractVid3rbStreams(targetEpisodeUrl);
    console.log(`[Anime3rb] Found ${streams.length} streams`);

    return streams;
  } catch (err) {
    console.log(`[Anime3rb] Provider General Error: ${err.message}`);
    return [];
  }
}

// ======================
// Export
// ======================

export { getStreams };

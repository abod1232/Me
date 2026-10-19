const CONFIG = {
  tmdbApiKey: "1c29a5198ee1854bd5eb45dbe8d17d92",
  tmdbEndpoint: "https://api.themoviedb.org/3",
  host: "https://cinemana.shabakaty.cc",
  apiRoot: "https://cinemana.shabakaty.cc/api/android",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
};

const sanitize = (val) => String(val || "").toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, "").trim();

async function apiRequest(endpoint, customHeaders = {}) {
  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": CONFIG.userAgent,
      "Referer": `${CONFIG.host}/`,
      ...customHeaders
    }
  });
  if (!response.ok) throw new Error(`Status: ${response.status}`);
  return response.json();
}

async function getMediaMetadata(id, isTv) {
  try {
    let targetId = id;
    const mediaType = isTv ? "tv" : "movie";

    if (String(id).startsWith("tt")) {
      const imdbLookup = await apiRequest(
        `${CONFIG.tmdbEndpoint}/find/${id}?api_key=${CONFIG.tmdbApiKey}&external_source=imdb_id`
      );
      targetId = isTv ? imdbLookup?.tv_results?.[0]?.id : imdbLookup?.movie_results?.[0]?.id;
    }

    if (!targetId) return null;

    const data = await apiRequest(
      `${CONFIG.tmdbEndpoint}/${mediaType}/${targetId}?api_key=${CONFIG.tmdbApiKey}&append_to_response=alternative_titles`
    );

    const primaryName = data.name || data.title;
    const extraNames = (data.alternative_titles?.results || []).map((entry) => entry.title);
    const releaseYear = parseInt((data.first_air_date || data.release_date || "").slice(0, 4), 10);

    return {
      names: [primaryName, ...extraNames].filter(Boolean),
      year: isNaN(releaseYear) ? null : releaseYear
    };
  } catch {
    return null;
  }
}

async function queryCinemana(term, isTv) {
  try {
    const category = isTv ? "series" : "movies";
    const path = `${CONFIG.apiRoot}/AdvancedSearch?level=0&videoTitle=${encodeURIComponent(term)}&staffTitle=${encodeURIComponent(term)}&page=0&type=${category}&itemsPerPage=15`;
    const response = await apiRequest(path);
    return Array.isArray(response) ? response : [];
  } catch {
    return [];
  }
}

function selectBestMatch(candidates, titles, targetYear) {
  for (const item of candidates) {
    const arabicName = sanitize(item.ar_title);
    const englishName = sanitize(item.en_title);
    const productionYear = parseInt(item.year, 10);

    for (const title of titles) {
      const cleanTarget = sanitize(title);
      if (!cleanTarget) continue;

      const matched = arabicName === cleanTarget || englishName === cleanTarget || 
                      (arabicName && arabicName.includes(cleanTarget)) || 
                      (englishName && englishName.includes(cleanTarget));

      if (matched) {
        if (targetYear && productionYear && Math.abs(targetYear - productionYear) > 1) {
          continue;
        }
        return item;
      }
    }
  }
  return null;
}

async function locateEpisodeId(showId, seasonNumber, episodeNumber) {
  try {
    const seasonData = await apiRequest(`${CONFIG.apiRoot}/videoSeason/id/${showId}`);
    if (!Array.isArray(seasonData)) return null;

    const matchedEpisode = seasonData.find((ep) => {
      const s = parseInt(ep.season, 10);
      const e = parseInt(ep.episodeNummer, 10);
      return s === seasonNumber && e === episodeNumber;
    });

    return matchedEpisode ? matchedEpisode.nb : null;
  } catch {
    return null;
  }
}

async function collectSubtitles(videoId) {
  try {
    const metadata = await apiRequest(`${CONFIG.apiRoot}/allVideoInfo/id/${videoId}`);
    const availableTranslations = metadata.translations || [];

    const formatPriority = { vtt: 1, srt: 2, ass: 3 };
    const ordered = [...availableTranslations].sort((a, b) => {
      const rankA = formatPriority[(a.extention || "").toLowerCase()] || 99;
      const rankB = formatPriority[(b.extention || "").toLowerCase()] || 99;
      return rankA - rankB;
    });

    return ordered
      .filter((item) => typeof item.file === "string" && item.file.trim().length > 0)
      .map((item) => {
        const isAss = (item.extention || "").toLowerCase() === "ass";
        const label = item.name || "العربية";
        return {
          url: item.file.startsWith("http") ? item.file : `${CONFIG.host}${item.file}`,
          lang: "Arabic",
          name: isAss ? `${label} (ASS)` : label
        };
      });
  } catch {
    return [];
  }
}

async function buildStreamPayload(videoId, displayTitle) {
  try {
    const [videoFiles, captionList] = await Promise.all([
      apiRequest(`${CONFIG.apiRoot}/transcoddedFiles/id/${videoId}`).catch(() => []),
      collectSubtitles(videoId)
    ]);

    if (!Array.isArray(videoFiles) || !videoFiles.length) return [];

    return videoFiles
      .filter((file) => Boolean(file.videoUrl))
      .reverse()
      .map((file) => ({
        name: `Cinemana - ${file.resolution || "HD"}`,
        title: displayTitle,
        url: file.videoUrl,
        quality: file.resolution || "HD",
        size: "Unknown",
        subtitles: captionList,
        headers: {
          "User-Agent": CONFIG.userAgent,
          "Referer": `${CONFIG.host}/`
        },
        provider: "cinemana"
      }));
  } catch {
    return [];
  }
}

async function getStreams(tmdbId, mediaType = "movie", seasonNum = null, episodeNum = null) {
  const isSeries = mediaType === "tv";
  const s = seasonNum || 1;
  const e = episodeNum || 1;

  try {
    const meta = await getMediaMetadata(tmdbId, isSeries);
    if (!meta || !meta.names.length) return [];

    const label = `${meta.names[0]}${
      isSeries 
        ? ` S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}` 
        : (meta.year ? ` (${meta.year})` : "")
    }`;

    let selectedEntry = null;
    for (const nameQuery of meta.names.slice(0, 4)) {
      const searchHits = await queryCinemana(nameQuery, isSeries);
      selectedEntry = selectBestMatch(searchHits, meta.names, meta.year);
      if (selectedEntry) break;
    }

    if (!selectedEntry?.nb) return [];

    let targetId = selectedEntry.nb;
    if (isSeries) {
      targetId = await locateEpisodeId(selectedEntry.nb, s, e);
      if (!targetId) return [];
    }

    return await buildStreamPayload(targetId, label);
  } catch {
    return [];
  }
}

module.exports = { getStreams };

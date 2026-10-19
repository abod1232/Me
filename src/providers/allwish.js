"use strict";

import cheerio from "cheerio-without-node-native";

// ======================
// Constants
// ======================

const BASE_URL = "https://all-wish.me";

const TMDB_API_KEY =
  "1865f43a0549ca50d341dd9ab8b29f49";

const XML_HEADER = {
  "X-Requested-With": "XMLHttpRequest",

  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
};

// ======================
// Utils
// ======================

function btoa(str) {
  return Buffer.from(
    str,
    "binary"
  ).toString("base64");
}

async function fetchJson(
  url,
  headers = XML_HEADER
) {
  const res = await fetch(url, {
    headers
  });

  return await res.json();
}

async function fetchText(
  url,
  headers = XML_HEADER
) {
  const res = await fetch(url, {
    headers
  });

  return await res.text();
}

// ======================
// IMDb -> TMDB
// ======================

async function resolveTmdbId(
  id,
  mediaType
) {
  if (
    !String(id).startsWith("tt")
  ) {
    return id;
  }

  console.log(
    `[TMDB] Resolving IMDb ID ${id}`
  );

  const url =
    `https://api.themoviedb.org/3/find/${id}` +
    `?api_key=${TMDB_API_KEY}` +
    `&external_source=imdb_id`;

  const data =
    await fetchJson(url);

  let tmdbId = null;

  if (
    mediaType === "movie"
  ) {
    tmdbId =
      data?.movie_results?.[0]
        ?.id;
  } else {
    tmdbId =
      data?.tv_results?.[0]
        ?.id;
  }

  if (!tmdbId) {
    throw new Error(
      "Failed to resolve TMDB ID"
    );
  }

  console.log(
    `[TMDB] IMDb ${id} -> TMDB ${tmdbId}`
  );

  return tmdbId;
}

// ======================
// TMDB
// ======================

async function getTmdbTitle(
  tmdbId,
  mediaType
) {
  const tmdbUrl =
    `https://api.themoviedb.org/3/${mediaType}/${tmdbId}` +
    `?api_key=${TMDB_API_KEY}`;

  console.log(
    `[TMDB] Fetching ${tmdbUrl}`
  );

  const mediaInfo =
    await fetchJson(tmdbUrl);

  return (
    mediaInfo.title ||
    mediaInfo.name
  );
}

// ======================
// VRF Generator
// ======================

function generateEpisodeVrf(
  episodeId
) {
  const secretKey =
    "ysJhV6U27FVIjjuk";

  const encodedId =
    encodeURIComponent(
      episodeId
    );

  const keyCodes = secretKey
    .split("")
    .map((c) =>
      c.charCodeAt(0)
    );

  const dataCodes = encodedId
    .split("")
    .map((c) =>
      c.charCodeAt(0)
    );

  const n = Array.from(
    { length: 256 },
    (_, i) => i
  );

  let a = 0;

  for (
    let o = 0;
    o < 256;
    o++
  ) {
    a =
      (a +
        n[o] +
        keyCodes[
          o % keyCodes.length
        ]) %
      256;

    [n[o], n[a]] = [
      n[a],
      n[o]
    ];
  }

  const out = [];

  let o = 0;

  a = 0;

  for (
    let r = 0;
    r < dataCodes.length;
    r++
  ) {
    o = (o + 1) % 256;

    a = (a + n[o]) % 256;

    [n[o], n[a]] = [
      n[a],
      n[o]
    ];

    const k =
      n[(n[o] + n[a]) % 256];

    out.push(
      dataCodes[r] ^ k
    );
  }

  const bytes =
    new Uint8Array(
      out.map(
        (b) => b & 255
      )
    );

  const base64 = btoa(
    String.fromCharCode(
      ...bytes
    )
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const transformed = [];

  for (
    let i = 0;
    i < base64.length;
    i++
  ) {
    let s =
      base64.charCodeAt(i);

    const mod = i % 8;

    if (mod === 1) s += 3;
    else if (mod === 7)
      s += 5;
    else if (mod === 2)
      s -= 4;
    else if (mod === 4)
      s -= 2;
    else if (mod === 6)
      s += 4;
    else if (mod === 0)
      s -= 3;
    else if (mod === 3)
      s += 2;
    else if (mod === 5)
      s += 5;

    transformed.push(
      s & 255
    );
  }

  const bytes2 =
    new Uint8Array(
      transformed
    );

  const base2 = btoa(
    String.fromCharCode(
      ...bytes2
    )
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return base2.replace(
    /[A-Za-z]/g,
    (c) => {
      const base =
        c <= "Z"
          ? 65
          : 97;

      return String.fromCharCode(
        ((c.charCodeAt(0) -
          base +
          13) %
          26) +
          base
      );
    }
  );
}

// ======================
// MegaPlay Extractor
// ======================

async function extractMegaPlay(
  realUrl,
  sectionType
) {
  try {
    const embedHtml =
      await fetchText(realUrl, {
        Referer:
          "https://megaplay.buzz/",

        "User-Agent":
          "Mozilla/5.0"
      });

    const dataIdMatch =
      embedHtml.match(
        /data-id="(\d+)"/
      );

    const megaId =
      dataIdMatch?.[1];

    if (!megaId) {
      console.log(
        "[MegaPlay] No data-id"
      );

      return [];
    }

    console.log(
      `[MegaPlay] data-id: ${megaId}`
    );

    const megaApi =
      `https://megaplay.buzz/stream/getSources?id=${megaId}`;

    const megaRes =
      await fetchJson(
        megaApi,
        {
          Referer:
            realUrl,

          Origin:
            "https://megaplay.buzz",

          "X-Requested-With":
            "XMLHttpRequest",

          "User-Agent":
            "Mozilla/5.0"
        }
      );

    const source =
      megaRes?.sources?.file;

    if (!source)
      return [];

    return [
      {
        name:
          `AllWish - MegaPlay ${(
            sectionType ||
            "SUB"
          ).toUpperCase()}`,

        title:
          `MegaPlay ${(
            sectionType ||
            "SUB"
          ).toUpperCase()}`,

        url: source,

        quality: "1080p",

        subtitles:
          megaRes?.tracks?.map(
            (track) => ({
              lang:
                track.label ||
                "Unknown",

              url:
                track.file
            })
          ) || [],

        headers: {
          Referer:
            "https://rapid-cloud.co/",

          Origin:
            "https://rapid-cloud.co"
        }
      }
    ];
  } catch (e) {
    console.log(
      `[MegaPlay] ${e.message}`
    );

    return [];
  }
}

// ======================
// Main Provider
// ======================

async function getStreams(
  tmdbId,
  mediaType,
  season,
  episode
) {
  try {
    console.log(
      `[AllWish] Fetching ${mediaType} ${tmdbId}`
    );

    // ======================
    // Resolve IMDb -> TMDB
    // ======================

    tmdbId =
      await resolveTmdbId(
        tmdbId,
        mediaType
      );

    console.log(
      `[AllWish] Using TMDB ID ${tmdbId}`
    );

    // ======================
    // TMDB Title
    // ======================

    const title =
      await getTmdbTitle(
        tmdbId,
        mediaType
      );

    if (!title) {
      console.log(
        "[AllWish] No title found"
      );

      return [];
    }

    console.log(
      `[AllWish] Title: ${title}`
    );

    // ======================
    // Search
    // ======================

    const searchUrl =
      `${BASE_URL}/filter?keyword=` +
      encodeURIComponent(
        title
      );

    const searchHtml =
      await fetchText(
        searchUrl
      );

    const $ =
      cheerio.load(
        searchHtml
      );

    let animeUrl = null;

    $("div.item").each(
      (_, item) => {
        const href = $(item)
          .find(
            "div.name > a"
          )
          .attr("href");

        if (
          href &&
          !animeUrl
        ) {
          animeUrl =
            href.startsWith(
              "http"
            )
              ? href
              : BASE_URL +
                href;

          animeUrl =
            animeUrl.replace(
              /\/+$/,
              ""
            );
        }
      }
    );

    if (!animeUrl) {
      console.log(
        "[AllWish] No anime page found"
      );

      return [];
    }

    console.log(
      `[AllWish] Anime URL: ${animeUrl}`
    );

    // ======================
    // Anime Page
    // ======================

    const animePage =
      await fetchText(
        animeUrl
      );

    const $2 =
      cheerio.load(
        animePage
      );

    const dataId = $2(
      "main > div.container"
    ).attr("data-id");

    if (!dataId) {
      console.log(
        "[AllWish] No data-id"
      );

      return [];
    }

    console.log(
      `[AllWish] Data ID: ${dataId}`
    );

    // ======================
    // Episode List
    // ======================

    const vrf =
      generateEpisodeVrf(
        dataId
      );

    const epListUrl =
      `${BASE_URL}/ajax/episode/list/${dataId}?vrf=${vrf}`;

    const epListRes =
      await fetchJson(
        epListUrl
      );

    if (
      !epListRes ||
      epListRes.status !==
        200
    ) {
      console.log(
        "[AllWish] Episode list failed"
      );

      return [];
    }

    const $3 =
      cheerio.load(
        epListRes.result ||
          ""
      );

    let episodeIds = null;

    const targetEp =
      episode || 1;

    $3(
      "div.range > div > a"
    ).each((_, el) => {
      const slug =
        $3(el).attr(
          "data-slug"
        );

      const epNum =
        parseInt(
          slug,
          10
        );

      if (
        epNum === targetEp
      ) {
        episodeIds =
          $3(el).attr(
            "data-ids"
          );
      }
    });

    if (!episodeIds) {
      const firstEp = $3(
        "div.range > div > a"
      ).first();

      episodeIds =
        firstEp.attr(
          "data-ids"
        );
    }

    if (!episodeIds) {
      console.log(
        "[AllWish] No episode IDs"
      );

      return [];
    }

    console.log(
      `[AllWish] Episode IDs: ${episodeIds}`
    );

    // ======================
    // Server List
    // ======================

    const serverListUrl =
      `${BASE_URL}/ajax/server/list?servers=${episodeIds}`;

    const serverListRes =
      await fetchJson(
        serverListUrl
      );

    if (
      !serverListRes ||
      serverListRes.status !==
        200
    ) {
      console.log(
        "[AllWish] Server list failed"
      );

      return [];
    }

    const $4 =
      cheerio.load(
        serverListRes.result ||
          ""
      );

    const serverEls = [];

    $4(
      "div.server-type"
    ).each(
      (_, section) => {
        $4(section)
          .find(
            "div.server-list > div.server"
          )
          .each(
            (
              __,
              server
            ) => {
              const dataLinkId =
                $4(server).attr(
                  "data-link-id"
                );

              const sectionType =
                $4(section).attr(
                  "data-type"
                );

              if (
                dataLinkId
              ) {
                serverEls.push(
                  {
                    dataLinkId,
                    sectionType
                  }
                );
              }
            }
          );
      }
    );

    console.log(
      `[AllWish] Servers found: ${serverEls.length}`
    );

    // ======================
    // Streams
    // ======================

    const streams = [];

    for (const {
      dataLinkId,
      sectionType
    } of serverEls.slice(
      0,
      5
    )) {
      try {
        const apiUrl =
          `${BASE_URL}/ajax/server?get=${dataLinkId}`;

        const apiRes =
          await fetchJson(
            apiUrl
          );

        const realUrl =
          apiRes?.result
            ?.url;

        if (!realUrl)
          continue;

        // MegaPlay

        if (
          realUrl.includes(
            "megaplay"
          ) ||
          realUrl.includes(
            "rapid-cloud"
          )
        ) {
          const megaStreams =
            await extractMegaPlay(
              realUrl,
              sectionType
            );

          streams.push(
            ...megaStreams
          );

          continue;
        }

        // Fallback

        streams.push({
          name:
            `AllWish - ${(
              sectionType ||
              "SUB"
            ).toUpperCase()}`,

          title:
            `AllWish ${(
              sectionType ||
              "SUB"
            ).toUpperCase()}`,

          url: realUrl,

          quality:
            "1080p"
        });
      } catch (err) {
        console.log(
          `[AllWish] Server error: ${err.message}`
        );
      }
    }

    console.log(
      `[AllWish] Streams found: ${streams.length}`
    );

    return streams;
  } catch (e) {
    console.log(
      `[AllWish] Error: ${e.message}`
    );

    return [];
  }
}

// ======================
// Export
// ======================

export { getStreams };

"use strict";
// Pure helpers for working out season/episode numbers from TV file and folder names.
// Kept free of any server state so they can be tested directly with node.

// Matches a WHOLE folder name like "Season 1", "Säsong 03", "series_2", "S4" (case-insensitive).
const SEASON_FOLDER_RE = /^(season|säsong|sasong|series|saison|staffel|temporada|s)[\s._-]*0*(\d{1,2})$/i;

// A number at the very start of a file name that stands on its own (not glued to letters/digits):
// "101 Title", "01-Title", "116+117 Title", "00.Opening.mkv" — but not "2Fast.mkv".
const LEADING_NUMBER_RE = /^(\d{1,4})(?![\p{L}\d])/u;

// Letter runs that are technical tags, not part of a release name: audio/video codecs, and
// resolution/source tags. A number right after one of these ("AAC192", "HD720", "WEB1080") is
// never an episode. Compared case-insensitively against the WHOLE letter run before the number.
const TECH_TAGS = new Set([
  "aac", "eac", "ddp", "dd", "dts", "ac", "avc", "hevc", "xvid", "divx", "mpeg", "flac", "opus",
  "hd", "sd", "fhd", "uhd", "bd", "web", "dl", "dvd"
]);

// "Season 3" -> 3, "Season 0" -> 0 (specials), anything that isn't a season folder -> null.
function seasonHintFromFolderName(folderName) {
  const m = String(folderName || "").match(SEASON_FOLDER_RE);
  return m ? parseInt(m[2], 10) : null;
}

// The four original naming patterns, most specific first. A match here always wins and is
// never affected by season hints or folder numbering style.
// The returned match gets two extra properties for the range detection (episode_end):
//   kind:   "se" (S01E01 / S01x01), "nxm" (1x01) or "code" (packed 301)
//   endIdx: index in the name where the episode digits end
// (The "d" flag only adds index information; it doesn't change what matches.)
function matchOriginalPatterns(name) {
  let m;
  if ((m = name.match(/[Ss](\d+)[\s._-]?[Ee](\d+)/d))) {          // S01E01, S01 E01, S01-E01
    m.kind = "se"; m.endIdx = m.indices[2][1]; return m;
  }
  if ((m = name.match(/[Ss](\d+)[xX](\d+)/d))) {                  // S01x01
    m.kind = "se"; m.endIdx = m.indices[2][1]; return m;
  }
  if ((m = name.match(/(?<![\d])(\d+)[xX](\d+)(?![\d])/d))) {     // 1x01, 2x01
    m.kind = "nxm"; m.endIdx = m.indices[2][1]; return m;
  }
  if ((m = name.match(/\.([1-9])(\d{2})\.|[-_\s]([1-9])(\d{2})[-_\s.]/d))) { // .301. or -301-
    m.kind = "code"; m.endIdx = m.indices[m[1] !== undefined ? 2 : 4][1]; return m;
  }
  return null;
}

// Episode ranges in ONE file ("212+213", "S10E18-19", "1x01-02", ...). Looks only at the text
// directly after the episode digits (which end at endIdx), so words like "Part 1+2" later in a
// title are never read as a range. Returns the last episode number, or undefined.
// Guards: the end must be greater than the first episode and at most 3 higher, and it must not
// be followed by a letter or digit ("720p" and the like can never become a range).
const MAX_RANGE_SPAN = 3;
function episodeEndAfter(name, endIdx, kind, season, episode) {
  const rest = name.slice(endIdx);
  let end, m;
  if (kind === "se") {
    // S10E18-19, S10E18E19, S01E01-E02
    m = rest.match(/^(?:-?[Ee]|-)(\d{1,3})(?![\p{L}\d])/u);
    if (m) end = parseInt(m[1], 10);
  } else if (kind === "nxm") {
    // 1x01-02, [1x01-1x02] (a second season number, if given, must be the same)
    m = rest.match(/^-(?:(\d+)[xX])?(\d{1,2})(?![\p{L}\d])/u);
    if (m && (m[1] === undefined || parseInt(m[1], 10) === season)) end = parseInt(m[2], 10);
  } else if (kind === "code") {
    // 212+213, 116&117, 205-06, 1215-16: separator, then a second code of the same season, or two digits
    m = rest.match(/^[+&-](?:(\d{3,4})|(\d{2}))(?![\p{L}\d])/u);
    if (m) {
      if (m[1] !== undefined) {
        const n2 = parseInt(m[1], 10);
        if (Math.floor(n2 / 100) === season) end = n2 % 100;
      } else {
        end = parseInt(m[2], 10);
      }
    }
  }
  return (Number.isInteger(end) && end > episode && end <= episode + MAX_RANGE_SPAN) ? end : undefined;
}

// { season, episode } plus episodeEnd only when there is a range.
function withEnd(season, episode, end) {
  return end === undefined ? { season, episode } : { season, episode, episodeEnd: end };
}

// Decides how the files in ONE folder are numbered, from the folder's file names:
//  - "compact":  at least one file starts with a 3-4 digit number AND no file starts with a
//                1-2 digit number. The number packs season+episode: "101" = season 1 episode 1
//                (Friends: "101 Title", "301 - Title").
//  - "absolute": everything else. The leading number is the episode number as it is
//                ("101.Candy Candy" = episode 101, "01 - Title" = episode 1), also in mixed folders.
// Files that match one of the four original patterns are left out of the decision, since they
// never use the leading-number rules.
function detectFolderNumbering(fileNames) {
  let hasLong = false, hasShort = false;
  for (const raw of fileNames || []) {
    const name = String(raw || "");
    if (matchOriginalPatterns(name)) continue;
    const lead = name.match(LEADING_NUMBER_RE);
    if (!lead) continue;
    if (lead[1].length <= 2) hasShort = true; else hasLong = true;
  }
  return hasLong && !hasShort ? "compact" : "absolute";
}

// Returns { season, episode } for a file name, or null if nothing could be detected.
// seasonHint (a number, or null) comes from the season folder the file sits in; numbering
// ("compact" | "absolute") from detectFolderNumbering() on that folder's files. If numbering is
// left out it is worked out from this one file name alone.
//
// Order matters:
//  1. The four original patterns — always first, never affected by the hint or the numbering.
//  2. Only if none matched AND there is a seasonHint:
//     - a leading number in an "absolute" folder: season = hint, episode = the number (if >= 1;
//       0, e.g. "00.Opening.mkv", falls through to step 3)
//     - otherwise the first stand-alone 3-4 digit number whose hundreds part equals the hint
//       ("101 Title" in Season 1, "two.and.a.half.men.1101.hdtv" in Season 11) -> season/episode.
//       "Stand-alone" means not touching other digits or letters, so "1080p" and "x264" are
//       skipped. Numbers inside the name are handled this way whatever the folder's style is.
//     - if still nothing: rule 2c (see below), "tpz-koq701" / "Scrubs.s711".
//  3. The original last resort: a bare leading number (up to 3 digits) means season 1.
function parseEpisodeFromFilename(fileName, seasonHint = null, numbering) {
  const name = String(fileName || "");

  const em = matchOriginalPatterns(name);
  if (em) {
    const season = parseInt(em[1] || em[3]), episode = parseInt(em[2] || em[4]);
    return withEnd(season, episode, episodeEndAfter(name, em.endIdx, em.kind, season, episode));
  }

  if (seasonHint !== null && seasonHint !== undefined) {
    const style = numbering || detectFolderNumbering([name]);
    const lead = name.match(LEADING_NUMBER_RE);
    if (lead && style === "absolute") {
      const ep = parseInt(lead[1], 10);
      if (ep >= 1) return { season: seasonHint, episode: ep };
      // ep === 0 -> fall through to the original behaviour below
    } else {
      for (const m of name.matchAll(/(?<![\p{L}\d])(\d{3,4})(?![\p{L}\d])/gu)) {
        const n = parseInt(m[1], 10);
        if (Math.floor(n / 100) === seasonHint && n % 100 >= 1) {
          return withEnd(seasonHint, n % 100, episodeEndAfter(name, m.index + m[1].length, "code", seasonHint, n % 100));
        }
      }
    }

    // 2c (only reached if nothing above returned): release-style names with the season+episode
    // packed into one number inside the name.
    //  a) a stand-alone 3-4 digit number right after a run of 2+ letters, e.g. "tpz-koq701.avi".
    //     The WHOLE letter run before the number must not be a technical tag (AAC192, HD720,
    //     WEB1080, ...). A single letter before the number (x264, h265) never matches since 2+
    //     letters are required, and a letter after it (720p, 1080p) never matches either.
    //  b) "s" + 3-4 digits after a separator or at the start, e.g. "Scrubs.s711.pdtv-lol.mkv".
    for (const m of name.matchAll(/(?<!\p{L})(\p{L}{2,})(\d{3,4})(?![\p{L}\d])/gu)) {
      if (TECH_TAGS.has(m[1].toLowerCase())) continue;
      const n = parseInt(m[2], 10);
      if (Math.floor(n / 100) === seasonHint && n % 100 >= 1) return { season: seasonHint, episode: n % 100 };
    }
    for (const m of name.matchAll(/(?<![\p{L}\d])[sS](\d{3,4})(?!\d)/gu)) {
      const n = parseInt(m[1], 10);
      if (Math.floor(n / 100) === seasonHint && n % 100 >= 1) return { season: seasonHint, episode: n % 100 };
    }
  }

  // Last resort: a bare leading episode number with NO season marker at all — common for
  // older/classic shows (e.g. some anime) released as one continuous run rather than
  // separate seasons, e.g. "13.Candy Candy episode title.mkv". Defaults to season 1.
  const flatEm = name.match(/^(\d{1,3})[.\s_-]/);
  if (flatEm) return { season: 1, episode: parseInt(flatEm[1]) };

  return null;
}

// ── Double episodes: combining the TMDB info of the two parts ─────────────────────
// Trailing "part" markers that are stripped before comparing the two titles:
// "(1)", "(2)", ", Part 1", ": Part 2", " - Part II", "Pt. 1".
const PART_MARKER_RES = [
  /\s*\(\s*(?:1|2|3|i{1,3}|one|two)\s*\)\s*$/i,
  /\s*[,:]\s*part\s*(?:1|2|3|i{1,3}|one|two)\s*$/i,
  /\s+-\s+part\s*(?:1|2|3|i{1,3}|one|two)\s*$/i,
  /\s+pt\.?\s*(?:1|2|3|i{1,3})\s*$/i
];
function stripPartMarker(title) {
  let t = String(title || "").trim();
  for (const re of PART_MARKER_RES) {
    const next = t.replace(re, "").trim();
    if (next !== t) { t = next; break; }
  }
  return t;
}

// Combines two episodes' metadata ({ title, overview, runtime, still_url, air_date }) into one
// card for a double episode file. a = first part, b = second part. If one is missing, the other
// is used as it is (no error).
//  - title:    same title once the part markers are removed -> "Title (1 & 2)", else "A / B"
//  - overview: A's text, then B's on a new line (empty or identical ones skipped)
//  - runtime:  the sum if both have one, otherwise whichever exists
//  - still_url, air_date: A's (B's only if A has none)
function mergeEpisodeMeta(a, b) {
  if (!a && !b) return null;
  if (!b) return a;
  if (!a) return b;
  const ta = String(a.title || "").trim(), tb = String(b.title || "").trim();
  let title;
  if (ta && tb) {
    const baseA = stripPartMarker(ta), baseB = stripPartMarker(tb);
    title = baseA && baseA.toLowerCase() === baseB.toLowerCase() ? `${baseA} (1 & 2)` : `${ta} / ${tb}`;
  } else {
    title = ta || tb || a.title;
  }
  const oa = String(a.overview || "").trim(), ob = String(b.overview || "").trim();
  const overview = [oa, ob].filter((t, i, all) => t && all.indexOf(t) === i).join("\n");
  const runtime = (a.runtime && b.runtime) ? a.runtime + b.runtime : (a.runtime || b.runtime || null);
  return {
    ...a,
    title, overview, runtime,
    still_url: a.still_url || b.still_url || null,
    air_date: a.air_date || b.air_date || null
  };
}

module.exports = { parseEpisodeFromFilename, seasonHintFromFolderName, detectFolderNumbering, mergeEpisodeMeta, SEASON_FOLDER_RE };

"use strict";
// Pure helpers for working out season/episode numbers from TV file and folder names.
// Kept free of any server state so they can be tested directly with node.

// Matches a WHOLE folder name like "Season 1", "Säsong 03", "series_2", "S4" (case-insensitive).
const SEASON_FOLDER_RE = /^(season|säsong|sasong|series|saison|staffel|temporada|s)[\s._-]*0*(\d{1,2})$/i;

// A number at the very start of a file name that stands on its own (not glued to letters/digits):
// "101 Title", "01-Title", "116+117 Title", "00.Opening.mkv" — but not "2Fast.mkv".
const LEADING_NUMBER_RE = /^(\d{1,4})(?![\p{L}\d])/u;

// "Season 3" -> 3, "Season 0" -> 0 (specials), anything that isn't a season folder -> null.
function seasonHintFromFolderName(folderName) {
  const m = String(folderName || "").match(SEASON_FOLDER_RE);
  return m ? parseInt(m[2], 10) : null;
}

// The four original naming patterns, most specific first. A match here always wins and is
// never affected by season hints or folder numbering style.
function matchOriginalPatterns(name) {
  return name.match(/[Ss](\d+)[\s._-]?[Ee](\d+)/) ||   // S01E01, S01 E01, S01-E01
         name.match(/[Ss](\d+)[xX](\d+)/) ||              // S01x01
         name.match(/(?<![\d])(\d+)[xX](\d+)(?![\d])/) || // 1x01, 2x01
         name.match(/\.([1-9])(\d{2})\.|[-_\s]([1-9])(\d{2})[-_\s.]/); // .301. or -301-
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
//  3. The original last resort: a bare leading number (up to 3 digits) means season 1.
function parseEpisodeFromFilename(fileName, seasonHint = null, numbering) {
  const name = String(fileName || "");

  const em = matchOriginalPatterns(name);
  if (em) return { season: parseInt(em[1] || em[3]), episode: parseInt(em[2] || em[4]) };

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
        if (Math.floor(n / 100) === seasonHint && n % 100 >= 1) return { season: seasonHint, episode: n % 100 };
      }
    }
  }

  // Last resort: a bare leading episode number with NO season marker at all — common for
  // older/classic shows (e.g. some anime) released as one continuous run rather than
  // separate seasons, e.g. "13.Candy Candy episode title.mkv". Defaults to season 1.
  const flatEm = name.match(/^(\d{1,3})[.\s_-]/);
  if (flatEm) return { season: 1, episode: parseInt(flatEm[1]) };

  return null;
}

module.exports = { parseEpisodeFromFilename, seasonHintFromFolderName, detectFolderNumbering, SEASON_FOLDER_RE };

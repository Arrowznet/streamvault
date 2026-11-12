"use strict";
// Pure helpers for working out season/episode numbers from TV file and folder names.
// Kept free of any server state so they can be tested directly with node.

// Matches a WHOLE folder name like "Season 1", "Säsong 03", "series_2", "S4" (case-insensitive).
const SEASON_FOLDER_RE = /^(season|säsong|sasong|series|saison|staffel|temporada|s)[\s._-]*0*(\d{1,2})$/i;

// "Season 3" -> 3, "Season 0" -> 0 (specials), anything that isn't a season folder -> null.
function seasonHintFromFolderName(folderName) {
  const m = String(folderName || "").match(SEASON_FOLDER_RE);
  return m ? parseInt(m[2], 10) : null;
}

// Returns { season, episode } for a file name, or null if nothing could be detected.
// seasonHint (a number, or null) comes from the season folder the file sits in.
//
// Order matters:
//  1. The four original patterns — always first, and a match here is never affected by the hint.
//  2. Only if none matched AND there is a seasonHint:
//     a) a one- or two-digit number first in the name ("07 Title.mkv") -> that is the episode
//     b) the first stand-alone 3-4 digit number whose hundreds part equals the hint
//        ("101 Title" in Season 1, "two.and.a.half.men.1101.hdtv" in Season 11) -> season/episode.
//        "Stand-alone" means not touching other digits or letters, so "1080p" and "x264" are skipped.
//  3. The original last resort: a bare leading number (up to 3 digits) means season 1.
function parseEpisodeFromFilename(fileName, seasonHint = null) {
  const name = String(fileName || "");

  // Try multiple naming conventions - order matters, most specific first!
  const em = name.match(/[Ss](\d+)[\s._-]?[Ee](\d+)/) ||   // S01E01, S01 E01, S01-E01
             name.match(/[Ss](\d+)[xX](\d+)/) ||              // S01x01
             name.match(/(?<![\d])(\d+)[xX](\d+)(?![\d])/) || // 1x01, 2x01
             name.match(/\.([1-9])(\d{2})\.|[-_\s]([1-9])(\d{2})[-_\s.]/); // .301. or -301-
  if (em) return { season: parseInt(em[1] || em[3]), episode: parseInt(em[2] || em[4]) };

  if (seasonHint !== null && seasonHint !== undefined) {
    const lead = name.match(/^(\d{1,2})[.\s_-]/);
    if (lead) {
      const ep = parseInt(lead[1], 10);
      if (ep >= 1) return { season: seasonHint, episode: ep };
    }
    for (const m of name.matchAll(/(?<![\p{L}\d])(\d{3,4})(?![\p{L}\d])/gu)) {
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

module.exports = { parseEpisodeFromFilename, seasonHintFromFolderName, SEASON_FOLDER_RE };

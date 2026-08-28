const STREAMVAULT_VERSION = require("../package.json").version;
const GITHUB_REPO = "Arrowznet/streamvault";

const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const https = require("https");
let musicMetadata;
try { musicMetadata = require("music-metadata"); } catch(e) { console.log("[MUSIC] music-metadata not installed, using folder names"); }
const http = require("http");
const os = require("os");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const Datastore = require("nedb");
const { v4: uuidv4 } = require("uuid");

// Subtitle pre-cache queue
const _subtitleCacheQueue = [];
let _subtitleCacheRunning = false;
let _subtitleCacheTotal = 0;       // total movies queued
let _subtitleCacheTotalEps = 0;    // total episodes queued
let _subtitleCacheWithSwe = 0;        // movies with a cached Swedish subtitle (any source)
let _subtitleCacheWithEng = 0;        // movies with a cached English subtitle (any source)
let _subtitleCacheWithExtSrt = 0;     // movies with an external SRT cached
let _subtitleCacheWithSweEps = 0;     // episodes with a cached Swedish subtitle
let _subtitleCacheWithEngEps = 0;     // episodes with a cached English subtitle
let _subtitleCacheWithExtSrtEps = 0;  // episodes with an external SRT cached
let _subtitleCacheDone = 0;           // items with at least one language successfully cached
let _subtitleCacheErrors = 0;         // items where a genuine failure occurred (kept for backward compat)
let _subtitleCacheFailed = 0;         // movies: genuine extraction/conversion failure
let _subtitleCacheFailedEps = 0;      // episodes: genuine extraction/conversion failure
let _subtitleCacheGated = 0;          // movies: bitmap subtitle exists but isn't OCR'd (allowlist/missing tool) — expected, not an error
let _subtitleCacheGatedEps = 0;       // episodes: same
let _subtitleCacheNoSubs = 0;         // movies: no subtitles found at all — normal, not an error
let _subtitleCacheNoSubsEps = 0;      // episodes: same
// Dynamic per-language breakdown, e.g. { movies: { swe: 29, eng: 24, nor: 5 }, episodes: {...} }
// Rebuilt by countExistingSubtitleCache() so the dashboard reflects whatever languages actually exist.
let _subtitleLangBreakdown = { movies: {}, episodes: {} };

// ── SUBTITLE LOGGING ──────────────────────────────────────────────────────────
// Keeps a rolling in-memory log plus a persistent log file so failures are easy
// to trace after the fact (which file, which language, when, and why).
const _subtitleLogBuffer = []; // most recent first
const SUBTITLE_LOG_MAX = 500;
function subtitleLogPath() { return path.join(DATA_DIR, "logs", "subtitles.log"); }
function logSubtitle(level, item, message, extra) {
  const entry = {
    time: new Date().toISOString(),
    level,
    mediaId: item?._id || null,
    title: item?.title || null,
    message,
    extra: extra || null
  };
  _subtitleLogBuffer.unshift(entry);
  if (_subtitleLogBuffer.length > SUBTITLE_LOG_MAX) _subtitleLogBuffer.length = SUBTITLE_LOG_MAX;
  const line = `[${entry.time}] [${level.toUpperCase()}]${item?.title ? ` "${item.title}" –` : ""} ${message}${extra ? " | " + JSON.stringify(extra) : ""}`;
  console.log("[SUBTITLES]", line);
  try {
    const logDir = path.join(DATA_DIR, "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(subtitleLogPath(), line + "\n");
  } catch(e) {
    console.log("[SUBTITLES] Kunde inte skriva till loggfilen:", e.message);
  }
}

// ── LANGUAGE CODE NORMALIZATION ────────────────────────────────────────────────
// Maps whatever ffprobe/filename gives us (2-letter, 3-letter, or full name) to a
// stable 3-letter code used consistently in cache filenames and the DB.
const SUBTITLE_LANG_ALIASES = {
  // "se" is Sweden's country code, not its language code (that's "sv") — but it's a common
  // real-world mixup in subtitle filenames from whoever originally named them, so it's worth
  // recognizing explicitly rather than showing the raw, unrecognized code.
  sv:"swe", swe:"swe", svenska:"swe", swedish:"swe", se:"swe",
  en:"eng", eng:"eng", english:"eng",
  no:"nor", nor:"nor", nb:"nor", nn:"nor", norsk:"nor", norwegian:"nor",
  da:"dan", dan:"dan", dansk:"dan", danish:"dan",
  de:"deu", deu:"deu", ger:"deu", german:"deu", tysk:"deu",
  fr:"fra", fra:"fra", fre:"fra", french:"fra", franska:"fra",
  es:"spa", spa:"spa", spanish:"spa", spanska:"spa",
  nl:"nld", nld:"nld", dut:"nld", dutch:"nld",
  fi:"fin", fin:"fin", finnish:"fin", finska:"fin",
  it:"ita", ita:"ita", italian:"ita", italienska:"ita",
  pt:"por", por:"por", portuguese:"por", portugisiska:"por",
  pl:"pol", pol:"pol", polish:"pol", polska:"pol",
  ja:"jpn", jpn:"jpn", japanese:"jpn", japanska:"jpn"
};
const SUBTITLE_LANG_LABELS = { swe:"Svenska", eng:"English", nor:"Norsk", dan:"Dansk", deu:"Deutsch", fra:"Français", spa:"Español", nld:"Nederlands", fin:"Suomi", ita:"Italiano", por:"Português", pol:"Polski", jpn:"日本語", und:"Okänt språk" };
const TESSERACT_LANG_MAP = { swe:"swe", eng:"eng", nor:"nor", dan:"dan", deu:"deu", fra:"fra", spa:"spa", nld:"nld", fin:"fin", ita:"ita", por:"por", pol:"pol", jpn:"jpn" };

// "Bitmap subtitle" covers two structurally different formats that are NOT interchangeable:
//  - PGS (Blu-ray, hdmv_pgs_subtitle): what PgsToSrt is actually built for. FFmpeg can extract
//    this straight into a .sup container, which PgsToSrt reads directly.
//  - VobSub/DVD-style (dvd_subtitle, dvdsub, xsub, dvb_subtitle): a different bitmap format
//    entirely. FFmpeg's .sup muxer flatly refuses these ("sup muxer supports only codec
//    hdmv_pgs_subtitle"), and PgsToSrt has no VobSub support — OCR'ing these would need a
//    completely different tool (e.g. vobsub2srt) working from a .sub/.idx pair instead of a
//    .sup file. Until/unless that's built, these are treated as a known, permanent limitation
//    rather than retried and logged as a mysterious repeated failure.
const PGS_COMPATIBLE_CODECS = ["hdmv_pgs_subtitle"];
const UNSUPPORTED_BITMAP_CODECS = ["dvd_subtitle", "dvdsub", "xsub", "dvb_subtitle"];
const bitmapCodecs = [...PGS_COMPATIBLE_CODECS, ...UNSUPPORTED_BITMAP_CODECS]; // still "bitmap", just handled differently below
// Maps a user's UI language setting (e.g. "sv-SE") to the 3-letter subtitle code
const USER_LANG_TO_SUB_LANG = { "sv-SE":"swe","en-US":"eng","no-NO":"nor","da-DK":"dan","de-DE":"deu","fr-FR":"fra","es-ES":"spa","nl-NL":"nld","fi-FI":"fin","ja-JP":"jpn" };

// Decodes common HTML entities and strips unsupported markup from subtitle text. Many SRT
// files — especially ones downloaded from OpenSubtitles or other web sources — contain raw
// HTML entities like "&amp;" or "&#39;" and font-styling tags. WebVTT does NOT auto-decode
// general HTML entities the way a browser renders normal HTML, so without this they show up
// literally on screen (e.g. "Tom &amp; Jerry" instead of "Tom & Jerry"). Applied to the whole
// converted body, not just cue text — timestamp lines never contain any of these characters,
// so this is safe to run over the entire thing in one pass.
function cleanSubtitleText(text) {
  return text
    // <font ...>...</font> isn't a real WebVTT tag (only <b>/<i>/<u>/<c>/<v>/<ruby> are) — strip
    // the wrapper but keep the text inside, rather than leaving it to render unpredictably.
    .replace(/<\/?font[^>]*>/gi, "")
    // Numeric entities (decimal and hex)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    // Common named entities — &amp; must be decoded LAST, otherwise something like "&amp;lt;"
    // would incorrectly unescape twice into "<" instead of staying as the literal text "&lt;".
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}


// Best-effort, human-readable device/client label from a User-Agent string, for the Live
// Activity dashboard. Order matters — more specific checks (TV platforms, app frameworks)
// come before generic ones (Chrome/Safari), since some of those substrings overlap.
function describeClient(ua) {
  const u = (ua || "").toLowerCase();
  if (!u) return "Okänd klient";
  if (u.includes("web0s") || u.includes("webos")) return "📺 LG TV (webOS)";
  if (u.includes("tizen")) return "📺 Samsung TV (Tizen)";
  if (u.includes("smarttv") || u.includes("smart-tv") || u.includes("googletv") || u.includes("aft")) return "📺 Smart-TV";
  if (u.includes("okhttp") || u.includes("exoplayer")) return "📱 Android-app";
  if (u.includes("android")) return "📱 Android (webbläsare)";
  if (u.includes("iphone") || u.includes("ipad")) return "📱 iOS (webbläsare)";
  if (u.includes("edg/") || u.includes("edga") || u.includes("edgios")) return "💻 Edge";
  if (u.includes("firefox")) return "💻 Firefox";
  if (u.includes("chrome")) return "💻 Chrome";
  if (u.includes("safari")) return "💻 Safari";
  return "❓ Okänd klient";
}

function normalizeLangCode(raw) {
  const l = (raw || "").toLowerCase().trim();
  if (!l) return "und";
  if (SUBTITLE_LANG_ALIASES[l]) return SUBTITLE_LANG_ALIASES[l];
  const safe = l.replace(/[^a-z0-9]/g, "");
  return safe || "und";
}
function subtitleLangLabel(lang) { return SUBTITLE_LANG_LABELS[lang] || lang; }

// Media IDs are base64url-encoded full file paths (see scanLibraries), which can easily be
// 200-300+ characters for well-tagged releases with long folder+file names. Used directly in
// a subtitle cache filename (which also needs "_{subIdx}_{lang}.srt" appended, plus the full
// cache directory path), this routinely blows past Windows' 260-character MAX_PATH limit —
// causing FFmpeg to fail creating the output file for EVERY subtitle track on such a movie,
// silently and identically regardless of language. A short, fixed-length hash avoids this
// entirely. External-file caching already did this; this makes embedded/converted caching
// consistent with it.
function shortMediaId(id) {
  return require("crypto").createHash("md5").update(id).digest("hex");
}

// ── OCR LANGUAGE ALLOWLIST ─────────────────────────────────────────────────────
// Text-based subtitles and external .srt files are cheap, so we always cache every
// language found. Bitmap (PGS/VOBSUB) OCR conversion is expensive (30s–minutes per
// language per file), so by default it's limited to a small allowlist the admin
// controls, instead of blindly OCR'ing every language a disc happens to contain.
function getServerDefaultSubLang() {
  return USER_LANG_TO_SUB_LANG[config.language] || "eng";
}
// Returns null if OCR should run for ANY language (admin picked "cacha alla"),
// otherwise a Set of the 3-letter codes currently allowed.
function getEffectiveOcrLanguages() {
  if (config.subtitle_ocr_mode === "all") return null;
  const list = (config.subtitle_ocr_languages && config.subtitle_ocr_languages.length)
    ? config.subtitle_ocr_languages
    : [getServerDefaultSubLang(), "eng"];
  return new Set(list);
}

// ── PENDING OCR-LANGUAGE REQUESTS ──────────────────────────────────────────────
// An active, persistent "someone wants a new language" notification for the admin —
// not just a log line easy to miss. Stored in config.json so it survives a restart;
// cleared once the admin either adds the language or explicitly dismisses it.
function addPendingOcrRequest(lang, userId) {
  if (!Array.isArray(config.pending_ocr_requests)) config.pending_ocr_requests = [];
  // Dedupe: one open request per (lang, user) pair — refresh the timestamp instead of piling up
  const existing = config.pending_ocr_requests.find(r => r.lang === lang && r.userId === userId);
  if (existing) { existing.requestedAt = new Date().toISOString(); }
  else config.pending_ocr_requests.push({ lang, userId, requestedAt: new Date().toISOString() });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
function clearPendingOcrRequests(lang) {
  if (!Array.isArray(config.pending_ocr_requests)) return;
  config.pending_ocr_requests = config.pending_ocr_requests.filter(r => r.lang !== lang);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
async function getPendingOcrRequestsWithUsernames() {
  const list = config.pending_ocr_requests || [];
  const out = [];
  for (const r of list) {
    const user = await dbFindOne(db.users, { _id: r.userId });
    out.push({ lang: r.lang, userId: r.userId, username: user?.username || "(borttagen användare)", requestedAt: r.requestedAt });
  }
  return out;
}

// Count existing cache files on startup (and whenever the dashboard asks, if idle)
async function countExistingSubtitleCache() {
  const cacheDir = path.join(DATA_DIR, "subtitle-cache");
  _subtitleLangBreakdown = { movies: {}, episodes: {} };
  if (!fs.existsSync(cacheDir)) return;
  try {
    const files = fs.readdirSync(cacheDir);
    const movies = await dbFind(db.media, { type: "movie" });
    const episodes = await dbFind(db.media, { type: "episode" });

    // All subtitle cache filenames (embedded/converted AND external) now start with a fixed-
    // length md5 hash of the media id — see shortMediaId(). That means matching a cache file
    // back to its media item is always an unambiguous O(1) lookup, regardless of what
    // characters happen to be in the (base64url-encoded) media id itself.
    const hashToItem = new Map();
    for (const m of movies) hashToItem.set(shortMediaId(m._id), { id: m._id, kind: "movie" });
    for (const e of episodes) hashToItem.set(shortMediaId(e._id), { id: e._id, kind: "episode" });

    const movieLangs = new Map(); // id -> Set(lang)
    const epLangs = new Map();
    function addLang(map, id, lang) {
      if (!map.has(id)) map.set(id, new Set());
      map.get(id).add(lang);
    }

    for (const f of files) {
      if (!f.endsWith(".srt")) continue;
      // Matches both "{hash}_ext_{lang}.srt" (external) and "{hash}_{subIdx}_{lang}.srt"
      // (embedded/converted) — either way, the language is always the last "_"-delimited part.
      const m = f.match(/^([a-f0-9]{32})_(?:ext_)?(?:\d+_)?([a-z0-9]+)\.srt$/);
      if (!m) continue;
      const hit = hashToItem.get(m[1]);
      if (hit) addLang(hit.kind === "movie" ? movieLangs : epLangs, hit.id, m[2]);
    }

    const movieCounts = {};
    for (const langs of movieLangs.values()) for (const l of langs) movieCounts[l] = (movieCounts[l] || 0) + 1;
    const epCounts = {};
    for (const langs of epLangs.values()) for (const l of langs) epCounts[l] = (epCounts[l] || 0) + 1;

    _subtitleLangBreakdown = { movies: movieCounts, episodes: epCounts };
    // Keep the legacy swe/eng counters in sync too, in case anything else still reads them
    _subtitleCacheWithSwe = movieCounts.swe || 0;
    _subtitleCacheWithEng = movieCounts.eng || 0;
    _subtitleCacheWithSweEps = epCounts.swe || 0;
    _subtitleCacheWithEngEps = epCounts.eng || 0;
    _subtitleCacheWithExtSrt = 0;    // no longer tracked as a separate bucket – folded into per-language counts
    _subtitleCacheWithExtSrtEps = 0;
  } catch(e) { logSubtitle("error", null, "Kunde inte räkna cachade undertexter", { error: e.message }); }
}
setTimeout(countExistingSubtitleCache, 1000);

const DATA_DIR = process.env.STREAMVAULT_DATA
  ? path.join(process.env.STREAMVAULT_DATA, "data")
  : path.join(__dirname, "..", "data");

const CONFIG_PATH = path.join(DATA_DIR, "config.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ── SERVER-WIDE LOGGING ───────────────────────────────────────────────────────
// Captures EVERYTHING — every console.log/warn/error/info call across the whole server,
// plus every HTTP request — into a daily-rotated log file, viewable/downloadable from
// Settings without needing terminal/console access. Complements the existing subtitle-
// specific log (which stays focused on just subtitle events); this one is the "what is the
// app actually trying to do" firehose for general debugging (e.g. Android app requests).
const LOG_DIR = path.join(DATA_DIR, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const SERVER_LOG_MAX_LINES = 5000; // in-memory buffer for the fast admin viewer
const SERVER_LOG_RETENTION_DAYS = 3; // how many days of log FILES to keep on disk
let _serverLogBuffer = [];
let _serverLogStream = null;
let _serverLogDate = null;

function _serverLogFilePath(date) {
  return path.join(LOG_DIR, `server-${date}.log`);
}

let _serverLogWritable = true; // flips to false permanently if the stream can't be written to at all

function _ensureServerLogStream() {
  const today = new Date().toISOString().slice(0, 10);
  if (_serverLogStream && _serverLogDate === today) return;
  if (_serverLogStream) _serverLogStream.end();
  _serverLogDate = today;
  try {
    _serverLogStream = fs.createWriteStream(_serverLogFilePath(today), { flags: "a" });
    // CRITICAL: an EventEmitter's 'error' event with no listener crashes the entire Node
    // process — without this handler, a permissions issue writing the log file takes down
    // the whole server, which defeats the entire purpose of a logging system. The in-memory
    // buffer (used by the admin log viewer) keeps working regardless of whether the file
    // itself can be written.
    _serverLogStream.on("error", (e) => {
      if (_serverLogWritable) {
        _origConsole.error(`[LOG] Could not write to server log file (logging to memory buffer only from now on): ${e.message}`);
      }
      _serverLogWritable = false;
    });
    _cleanupOldServerLogs();
  } catch(e) {
    _serverLogWritable = false;
    _origConsole.error(`[LOG] Could not create server log file: ${e.message}`);
  }
}

function _cleanupOldServerLogs() {
  try {
    const cutoff = Date.now() - SERVER_LOG_RETENTION_DAYS * 86400000;
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!f.startsWith("server-") || !f.endsWith(".log")) continue;
      const full = path.join(LOG_DIR, f);
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlink(full, () => {});
    }
  } catch(e) { /* non-fatal — just means old logs pile up a bit longer */ }
}

function writeServerLog(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(a => {
    if (typeof a === "string") return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(" ")}`;
  _serverLogBuffer.push(line);
  if (_serverLogBuffer.length > SERVER_LOG_MAX_LINES) _serverLogBuffer.shift();
  if (!_serverLogWritable) return; // already known broken — admin viewer still works via the buffer above
  try {
    _ensureServerLogStream();
    if (_serverLogWritable) _serverLogStream.write(line + "\n");
  } catch(e) { _serverLogWritable = false; /* never let logging itself crash the server */ }
}

// Wrap console methods so EVERY existing console.log/warn/error/info call throughout the
// whole codebase (all the [SCAN]/[DASH]/[SUBTITLES]/[CROPDETECT]/etc lines already
// scattered everywhere) gets captured automatically, with zero changes needed at each call
// site. Still prints to the real terminal exactly as before — this only adds capturing.
const _origConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
console.log = (...args) => { _origConsole.log(...args); writeServerLog("LOG", args); };
console.warn = (...args) => { _origConsole.warn(...args); writeServerLog("WARN", args); };
console.error = (...args) => { _origConsole.error(...args); writeServerLog("ERROR", args); };
console.info = (...args) => { _origConsole.info(...args); writeServerLog("INFO", args); };

// Tools directory for PgsToSrt and Tesseract
const TOOLS_DIR = path.join(DATA_DIR, "tools");
const PGSTOSRT_DIR = path.join(TOOLS_DIR, "PgsToSrt");
const PGSTOSRT_EXE = path.join(PGSTOSRT_DIR, "PgsToSrt.exe");
const TESSDATA_DIR = path.join(PGSTOSRT_DIR, "tessdata");
fs.mkdirSync(TOOLS_DIR, { recursive: true });

function isPgsToSrtInstalled() {
  return fs.existsSync(PGSTOSRT_EXE) && fs.existsSync(TESSDATA_DIR);
}

// Downloads a missing Tesseract language pack (e.g. "fin.traineddata") straight from the
// official tesseract-ocr/tessdata GitHub repo, so admins never have to manually download and
// place language files themselves. Follows redirects, writes to a temp file first so a failed/
// interrupted download never leaves a broken half-written .traineddata file behind.
function downloadTessdataFile(tessLang, destPath, redirectCount = 0, overrideUrl = null) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("För många omdirigeringar"));
    const https = require("https");
    const url = overrideUrl || `https://raw.githubusercontent.com/tesseract-ocr/tessdata/main/${tessLang}.traineddata`;
    const tempPath = destPath + ".downloading";
    const fileStream = fs.createWriteStream(tempPath);
    const req = https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fileStream.close(); try { fs.unlinkSync(tempPath); } catch {}
        return resolve(downloadTessdataFile(tessLang, destPath, redirectCount + 1, res.headers.location));
      }
      if (res.statusCode !== 200) {
        fileStream.close(); try { fs.unlinkSync(tempPath); } catch {}
        return reject(new Error(`HTTP ${res.statusCode} – språket finns troligen inte i Tesseracts standardarkiv`));
      }
      res.pipe(fileStream);
      fileStream.on("finish", () => {
        fileStream.close(() => {
          try {
            const size = fs.statSync(tempPath).size;
            // A real traineddata file is at least a few hundred KB — anything tiny is almost
            // certainly an error page, not language data.
            if (size < 50000) { try { fs.unlinkSync(tempPath); } catch {}; return reject(new Error(`Nedladdad fil för liten (${size} bytes) – troligen inte en giltig traineddata-fil`)); }
            fs.renameSync(tempPath, destPath);
            resolve();
          } catch(e) { reject(e); }
        });
      });
    });
    req.on("error", (e) => { fileStream.close(); try { fs.unlinkSync(tempPath); } catch {}; reject(e); });
    req.on("timeout", () => { req.destroy(); fileStream.close(); try { fs.unlinkSync(tempPath); } catch {}; reject(new Error("Timeout vid nedladdning")); });
  });
}

// Ensures a Tesseract language pack is present, downloading it automatically if missing.
// Returns { ok, downloaded, error } — "ok" is true if the language is (now) available.
async function ensureTesseractLanguage(tessLang) {
  const destPath = path.join(TESSDATA_DIR, `${tessLang}.traineddata`);
  if (fs.existsSync(destPath)) return { ok: true, downloaded: false };
  try {
    if (!fs.existsSync(TESSDATA_DIR)) fs.mkdirSync(TESSDATA_DIR, { recursive: true });
    logSubtitle("info", null, `Hämtar Tesseract-språkdata för "${tessLang}" automatiskt...`, { tessLang });
    await downloadTessdataFile(tessLang, destPath);
    logSubtitle("info", null, `Tesseract-språkdata för "${tessLang}" hämtad och installerad`, { tessLang });
    return { ok: true, downloaded: true };
  } catch(e) {
    logSubtitle("error", null, `Kunde inte hämta Tesseract-språkdata för "${tessLang}" automatiskt`, { tessLang, error: e.message });
    return { ok: false, downloaded: false, error: e.message };
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaults = { port: 7000, jwt_secret: uuidv4()+uuidv4()+uuidv4(), tmdb_api_key: "", opensubtitles_api_key: "", language: "auto", transcoding: { enabled: true, hardware_accel: "auto" }, libraries: [], version: STREAMVAULT_VERSION };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
let config = loadConfig();

// Load default API keys from keys.js if it exists (never committed to git)
try {
  const keys = require("./keys.js");
  if (!config.tmdb_api_key && keys.TMDB_KEY) config.tmdb_api_key = keys.TMDB_KEY;
  if (!config.opensubtitles_api_key && keys.OPENSUBTITLES_KEY) config.opensubtitles_api_key = keys.OPENSUBTITLES_KEY;
  if (!config.omdb_api_key && keys.OMDB_KEY) config.omdb_api_key = keys.OMDB_KEY;
  if (!config.lastfm_api_key && keys.LASTFM_KEY) config.lastfm_api_key = keys.LASTFM_KEY;
  if (!config.spotify_client_id && keys.SPOTIFY_CLIENT_ID) config.spotify_client_id = keys.SPOTIFY_CLIENT_ID;
  if (!config.spotify_client_secret && keys.SPOTIFY_CLIENT_SECRET) config.spotify_client_secret = keys.SPOTIFY_CLIENT_SECRET;
  if (keys.GITHUB_TOKEN && !process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = keys.GITHUB_TOKEN;
} catch {} // keys.js is optional

const db = {
  users: new Datastore({ filename: path.join(DATA_DIR, "users.db"), autoload: true }),
  sessions: new Datastore({ filename: path.join(DATA_DIR, "sessions.db"), autoload: true }),
  media: new Datastore({ filename: path.join(DATA_DIR, "media.db"), autoload: true }),
  history: new Datastore({ filename: path.join(DATA_DIR, "history.db"), autoload: true }),
  favorites: new Datastore({ filename: path.join(DATA_DIR, "favorites.db"), autoload: true }),
  loginAttempts: new Datastore({ filename: path.join(DATA_DIR, "attempts.db"), autoload: true }),
  spotifyCache: new Datastore({ filename: path.join(DATA_DIR, "spotify_cache.db"), autoload: true }),
  // Append-only log of playback sessions (one entry per "play" request) — the historical
  // record of who watched what, when, from where, and whether it was direct-played or
  // transcoded. Separate from db.history (which just tracks each user's latest resume
  // position per title) — this is for analytics/monitoring, not resume state.
  playbackLog: new Datastore({ filename: path.join(DATA_DIR, "playback_log.db"), autoload: true }),
  // IPTV channels parsed from an admin-provided M3U playlist URL. Re-parsing replaces the
  // whole set (channels come and go between playlist updates — no reason to keep stale ones).
  iptvChannels: new Datastore({ filename: path.join(DATA_DIR, "iptv_channels.db"), autoload: true }),
  // Named IPTV favorite lists (Spotify-style "save to playlist") — personal per user, one
  // document per list, each holding the channel IDs currently in it.
  iptvPlaylists: new Datastore({ filename: path.join(DATA_DIR, "iptv_playlists.db"), autoload: true })
};

db.users.ensureIndex({ fieldName: "username", unique: true });
db.media.ensureIndex({ fieldName: "library_id" });
db.media.ensureIndex({ fieldName: "type" });
db.history.ensureIndex({ fieldName: "user_id" });
db.iptvChannels.ensureIndex({ fieldName: "group" });
db.iptvPlaylists.ensureIndex({ fieldName: "user_id" });

const dbFind = (s, q) => new Promise((r, j) => s.find(q, (e, d) => e ? j(e) : r(d)));
const dbFindOne = (s, q) => new Promise((r, j) => s.findOne(q, (e, d) => e ? j(e) : r(d)));
const dbInsert = (s, d) => new Promise((r, j) => s.insert(d, (e, n) => e ? j(e) : r(n)));
const dbUpdate = (s, q, u, o={}) => new Promise((r, j) => s.update(q, u, o, (e, n) => e ? j(e) : r(n)));
const dbRemove = (s, q, o={}) => new Promise((r, j) => s.remove(q, o, (e, n) => e ? j(e) : r(n)));
const dbCount = (s, q) => new Promise((r, j) => s.count(q, (e, n) => e ? j(e) : r(n)));

// ── SYSTEM MONITORING ─────────────────────────────────────────────────────────
// Continuously samples CPU and RAM usage (both for StreamVault's own process AND the whole
// system, matching Plex's dashboard style of showing two lines per graph) into a rolling
// buffer the admin overview page can poll for live-updating graphs. Sampling happens
// regardless of whether anyone's looking at the page — cheap enough that this doesn't matter,
// and it means the graph already has history the moment someone opens the page instead of
// starting from a blank chart.
const SYSTEM_STATS_INTERVAL_MS = 3000;
const SYSTEM_STATS_MAX_SAMPLES = 60; // 60 × 3s = 3 minutes of history, comfortably covers Plex's own default "2m" view
let _systemStatsBuffer = [];
let _lastCpuSample = null; // { time, processCpu (from process.cpuUsage()), systemCpu }
let _lastPeriodicScanTime = null;
let _lastBandwidthSampleTime = null;
let _bandwidthCounters = { local: 0, remote: 0 };
function isLocalRequestIp(ip) {
  if (!ip) return false;
  const clean = ip.replace(/^::ffff:/, "");
  return clean === "127.0.0.1" || clean === "::1" ||
    /^10\./.test(clean) || /^192\.168\./.test(clean) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(clean);
}
const BANDWIDTH_TRACKED_PATTERNS = [/^\/api\/stream\//, /^\/api\/dash\//, /^\/api\/media\/.*\/direct/];

function _readSystemCpuTimes() {
  // Sums idle/total across all cores — os.cpus() gives cumulative counters since boot, so
  // this only becomes meaningful as a delta between two samples, not a single reading.
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total, coreCount: cpus.length };
}

function sampleSystemStats() {
  const now = Date.now();
  const processCpu = process.cpuUsage(); // cumulative microseconds of CPU time used by THIS process since it started
  const systemCpu = _readSystemCpuTimes();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const processMemBytes = process.memoryUsage().rss;

  let systemCpuPct = 0, processCpuPct = 0;
  if (_lastCpuSample) {
    const elapsedMs = now - _lastCpuSample.time;
    const systemIdleDelta = systemCpu.idle - _lastCpuSample.systemCpu.idle;
    const systemTotalDelta = systemCpu.total - _lastCpuSample.systemCpu.total;
    systemCpuPct = systemTotalDelta > 0 ? Math.max(0, Math.min(100, 100 * (1 - systemIdleDelta / systemTotalDelta))) : 0;
    // process.cpuUsage() deltas are in microseconds of CPU TIME, not wall-clock time — divide
    // by (elapsed wall-clock × core count) to get a percentage comparable to the system one
    // (matches how Task Manager/Plex present per-process CPU as a share of total capacity).
    const processCpuDeltaUs = (processCpu.user + processCpu.system) - (_lastCpuSample.processCpu.user + _lastCpuSample.processCpu.system);
    const availableUs = elapsedMs * 1000 * systemCpu.coreCount;
    processCpuPct = availableUs > 0 ? Math.max(0, Math.min(100, 100 * processCpuDeltaUs / availableUs)) : 0;
  }
  _lastCpuSample = { time: now, processCpu, systemCpu };

  // Bandwidth: bytes accumulated SINCE the last sample, converted to megabits-per-second
  // over the actual elapsed interval (not assumed to be exactly 3s, in case a GC pause or
  // slow tick pushed it slightly longer).
  const elapsedSec = _lastBandwidthSampleTime ? (now - _lastBandwidthSampleTime) / 1000 : SYSTEM_STATS_INTERVAL_MS / 1000;
  const localMbps = Math.round((_bandwidthCounters.local * 8 / 1e6 / elapsedSec) * 100) / 100;
  const remoteMbps = Math.round((_bandwidthCounters.remote * 8 / 1e6 / elapsedSec) * 100) / 100;
  _bandwidthCounters = { local: 0, remote: 0 };
  _lastBandwidthSampleTime = now;

  _systemStatsBuffer.push({
    time: now,
    systemCpuPct: Math.round(systemCpuPct * 10) / 10,
    processCpuPct: Math.round(processCpuPct * 10) / 10,
    systemMemPct: Math.round(100 * (totalMem - freeMem) / totalMem * 10) / 10,
    processMemPct: Math.round(100 * processMemBytes / totalMem * 10) / 10,
    localMbps, remoteMbps
  });
  if (_systemStatsBuffer.length > SYSTEM_STATS_MAX_SAMPLES) _systemStatsBuffer.shift();
}
setInterval(sampleSystemStats, SYSTEM_STATS_INTERVAL_MS);
sampleSystemStats(); // seed the first sample immediately rather than waiting 3s for anything to show

const app = express();
// Caddy now sits in front of this as a reverse proxy (for HTTPS/external access), running
// on the same machine and connecting via localhost. This tells Express to trust the
// X-Forwarded-For header specifically from loopback — not from anywhere else — so
// express-rate-limit (and anything else relying on req.ip) sees each external visitor's
// real IP instead of treating every request as coming from Caddy itself. Scoped to
// "loopback" rather than trusting it universally, since blindly trusting the header would
// let anyone spoof their IP if the server were ever reachable by another path.
app.set("trust proxy", "loopback");
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => { res.setHeader("X-Content-Type-Options","nosniff"); res.setHeader("X-Frame-Options","SAMEORIGIN"); next(); });
// Logs every API request (method, path, status, timing, client) into the server-wide log —
// skips static asset requests (images/js/css) since those are just noise for "what is the
// app actually trying to do" debugging, which is what this is actually for.
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  const t0 = Date.now();
  res.on("finish", () => {
    writeServerLog("HTTP", [`${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - t0}ms) ua=${(req.headers["user-agent"] || "").slice(0, 60)}`]);
  });
  next();
});
app.use("/api/auth", rateLimit({ windowMs: 15*60*1000, max: 20 }));
app.use("/api", rateLimit({ windowMs: 60*1000, max: 300 }));

// Bandwidth tracking (for the same live "system-stats" graphs as CPU/RAM) — counts bytes
// actually streamed to clients, split into "local" (same network) vs "remote" (over the
// internet), matching Plex's own bandwidth graph. Deliberately scoped to the actual
// media-streaming routes (direct-play, DASH segments, subtitle/artwork would just be noise)
// rather than counting every API response — a JSON reply to "/api/media/:id" isn't
// meaningful "bandwidth" in the sense this graph is trying to show.
app.use((req, res, next) => {
  if (!BANDWIDTH_TRACKED_PATTERNS.some(p => p.test(req.path))) return next();
  const isLocal = isLocalRequestIp(req.ip || req.connection?.remoteAddress);
  const originalWrite = res.write.bind(res);
  res.write = (chunk, ...args) => {
    const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk || "");
    if (isLocal) _bandwidthCounters.local += len; else _bandwidthCounters.remote += len;
    return originalWrite(chunk, ...args);
  };
  next();
});

function generateTokens(userId) {
  return {
    accessToken: jwt.sign({ userId, type: "access" }, config.jwt_secret, { expiresIn: "24h" }),
    refreshToken: jwt.sign({ userId, type: "refresh" }, config.jwt_secret, { expiresIn: "30d" })
  };
}

function userHasLibraryAccess(user, libraryId) {
  // Admin always has access to all libraries
  if (user.role === "admin") return true;
  // If user has no library restrictions, they have access to all
  if (!user.library_ids || user.library_ids.length === 0) return true;
  return user.library_ids.includes(libraryId);
}

// IPTV is treated as a pseudo-library entry ("iptv") within the same library_ids list, so it
// follows the exact same "empty list = access to everything" convention as real libraries.
function userHasIptvAccess(user) {
  if (user.role === "admin") return true;
  if (!user.library_ids || user.library_ids.length === 0) return true;
  return user.library_ids.includes("iptv");
}

function requireAuth(req, res, next) {
  // Accept token from header OR query parameter (needed for video streaming)
  let token = null;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) token = auth.slice(7);
  else if (req.query.token) token = req.query.token;
  if (!token) return res.status(401).json({ error: "Ej autentiserad" });
  try {
    const payload = jwt.verify(token, config.jwt_secret);
    if (payload.type !== "access") throw new Error();
    dbFindOne(db.users, { _id: payload.userId, is_active: true }).then(user => {
      if (!user) return res.status(401).json({ error: "Användare hittades inte" });
      req.user = user; next();
    }).catch(() => res.status(401).json({ error: "Databasfel" }));
  } catch { res.status(401).json({ error: "Ogiltig token" }); }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Kräver adminbehörighet" });
    next();
  });
}

// Guards any endpoint that serves the actual media/subtitle bytes for one specific item
// (streaming, playback-method lookup, offline download, subtitle files). Accepts EITHER:
//   - a normal session access token (header or ?token=), same as requireAuth, or
//   - a media-scoped download token (?dtoken=), issued via /api/media/:id/download-token,
//     used for offline downloads that outlive the normal 24h session token.
// Unlike requireAuth, this ALSO enforces per-library access restrictions — streaming and
// subtitle endpoints previously skipped that check entirely, which meant a user with
// restricted library access could still stream/download anything if they knew its ID.
async function requireMediaAccess(req, res, next) {
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item) return res.status(404).json({ error: "Hittades inte" });
    req.mediaItem = item;

    let user = null;

    let token = null;
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) token = auth.slice(7);
    else if (req.query.token) token = req.query.token;
    if (token) {
      try {
        const payload = jwt.verify(token, config.jwt_secret);
        if (payload.type === "access") {
          user = await dbFindOne(db.users, { _id: payload.userId, is_active: true });
        }
      } catch {}
    }

    if (!user && req.query.dtoken) {
      try {
        const payload = jwt.verify(req.query.dtoken, config.jwt_secret);
        if (payload.type === "download" && payload.mediaId === req.params.id) {
          user = await dbFindOne(db.users, { _id: payload.userId, is_active: true });
        }
      } catch {}
    }

    if (!user) return res.status(401).json({ error: "Ej autentiserad" });
    if (!userHasLibraryAccess(user, item.library_id)) return res.status(403).json({ error: "Ingen åtkomst till detta bibliotek" });

    req.user = user;
    next();
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}

app.get("/api/setup-required", async (req, res) => {
  const admin = await dbFindOne(db.users, { role: "admin" });
  res.json({ required: !admin });
});

// Redirect /setup to / if admin already exists
app.get("/setup", async (req, res) => {
  const admin = await dbFindOne(db.users, { role: "admin" });
  if (admin) return res.redirect("/");
  res.sendFile(path.join(PUBLIC, "setup", "setup.html"));
});

app.post("/api/auth/setup", async (req, res) => {
  try {
    const existing = await dbFindOne(db.users, { role: "admin" });
    if (existing) return res.status(400).json({ error: "Admin finns redan" });
    const { username, password } = req.body;
    if (!username || !password || password.length < 6) return res.status(400).json({ error: "Ogiltiga uppgifter. Lösenord minst 6 tecken." });
    const hash = await bcrypt.hash(password, 12);
    const user = await dbInsert(db.users, { _id: uuidv4(), username: username.trim(), password_hash: hash, role: "admin", created_at: new Date().toISOString(), is_active: true });
    const tokens = generateTokens(user._id);
    await dbInsert(db.sessions, { _id: uuidv4(), user_id: user._id, refreshToken: tokens.refreshToken, expires_at: new Date(Date.now()+30*24*60*60*1000).toISOString() });
    res.json({ ...tokens, user: { id: user._id, username: user.username, role: "admin" } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Ange användarnamn och lösenord" });
    const cutoff = new Date(Date.now()-15*60*1000).toISOString();
    const fails = await dbCount(db.loginAttempts, { ip: req.ip, success: false, at: { $gt: cutoff } });
    if (fails >= 10) return res.status(429).json({ error: "För många försök. Vänta 15 minuter." });
    const user = await dbFindOne(db.users, { username: username.trim(), is_active: true });
    const valid = user && await bcrypt.compare(password, user.password_hash);
    await dbInsert(db.loginAttempts, { ip: req.ip, success: valid, at: new Date().toISOString() });
    if (!valid) return res.status(401).json({ error: "Fel användarnamn eller lösenord" });
    await dbUpdate(db.users, { _id: user._id }, { $set: { last_login: new Date().toISOString() } });
    const tokens = generateTokens(user._id);
    await dbInsert(db.sessions, { _id: uuidv4(), user_id: user._id, refreshToken: tokens.refreshToken, expires_at: new Date(Date.now()+30*24*60*60*1000).toISOString() });
    res.json({ ...tokens, user: { id: user._id, username: user.username, role: user.role } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/refresh", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: "Ingen refresh token" });
    const payload = jwt.verify(refreshToken, config.jwt_secret);
    if (payload.type !== "refresh") throw new Error();
    const session = await dbFindOne(db.sessions, { refreshToken, expires_at: { $gt: new Date().toISOString() } });
    if (!session) return res.status(401).json({ error: "Ogiltig session" });
    const tokens = generateTokens(session.user_id);
    await dbUpdate(db.sessions, { _id: session._id }, { $set: { refreshToken: tokens.refreshToken, expires_at: new Date(Date.now()+30*24*60*60*1000).toISOString() } });
    res.json(tokens);
  } catch { res.status(401).json({ error: "Ogiltig refresh token" }); }
});

app.post("/api/auth/logout", requireAuth, async (req, res) => {
  if (req.body.refreshToken) await dbRemove(db.sessions, { refreshToken: req.body.refreshToken });
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const user = await dbFindOne(db.users, { _id: req.user._id });
    if (!user) return res.status(404).json({ error: "Användare hittades inte" });
    const { password, ...safeUser } = user;
    res.json(safeUser);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Personal preference, but same permission model as language: you can always change your
// own, admins can change anyone's (e.g. setting a theme for a new/test account without
// having to log in as them).
app.patch("/api/users/:id/theme", requireAuth, async (req, res) => {
  try {
    const { theme } = req.body;
    if (!theme) return res.status(400).json({ error: "Inget tema angivet" });
    if (req.params.id !== req.user._id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Ej tillåtet" });
    }
    await dbUpdate(db.users, { _id: req.params.id }, { $set: { theme } });
    res.json({ ok: true, theme });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Personal preference, same permission model as theme/language — you can always set your
// own, admins can set anyone's.
app.patch("/api/users/:id/webhook", requireAuth, async (req, res) => {
  try {
    const { webhook_url, webhook_enabled } = req.body;
    if (req.params.id !== req.user._id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Ej tillåtet" });
    }
    if (webhook_url) {
      try { new URL(webhook_url); } catch { return res.status(400).json({ error: "Ogiltig webbadress" }); }
    }
    const update = {};
    if (webhook_url !== undefined) update.webhook_url = webhook_url || null;
    if (webhook_enabled !== undefined) update.webhook_enabled = !!webhook_enabled;
    await dbUpdate(db.users, { _id: req.params.id }, { $set: update });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/users", requireAdmin, async (req, res) => {
  const users = await dbFind(db.users, { is_active: true });
  res.json(users.map(u => ({
    id: u._id, username: u.username, role: u.role, created_at: u.created_at, last_login: u.last_login,
    library_ids: u.library_ids || [], language: u.language || null, subtitleLanguages: u.subtitleLanguages || [], theme: u.theme || null, webhook_url: u.webhook_url || null, webhook_enabled: !!u.webhook_enabled, preferred_watch_providers: u.preferred_watch_providers || []
  })));
});

// Shared by user creation and the language-patch endpoint: checks whether a language
// needs a bitmap-subtitle OCR allowlist entry, and logs + persists a pending notice if so.
// Core check: does the OCR/cache allowlist need this specific 3-letter code added? Shared by
// both the single "UI language" check (below) and the subtitle-priority-list check (used by
// the multi-language subtitle priority feature).
function checkNeedsOcrLanguageForCode(subLang, userId, changedByUserId, changedByLabel) {
  if (config.subtitle_ocr_mode === "all") return null;
  if (!subLang) return null;
  const current = getEffectiveOcrLanguages(); // Set, since mode isn't "all" here
  if (current.has(subLang)) return null;
  const who = changedByUserId === userId ? "användaren själv" : `admin (${changedByLabel || changedByUserId})`;
  logSubtitle("warn", null, `Nytt användarspråk (${subtitleLangLabel(subLang)}) är inte i språklistan än – satt av ${who}`, { subLang, userId });
  addPendingOcrRequest(subLang, userId);
  return subLang;
}

function checkNeedsOcrLanguage(language, userId, changedByUserId, changedByLabel) {
  const subLang = USER_LANG_TO_SUB_LANG[language];
  return checkNeedsOcrLanguageForCode(subLang, userId, changedByUserId, changedByLabel);
}

app.post("/api/users", requireAdmin, async (req, res) => {
  try {
    const { username, password, role = "user", language } = req.body;
    if (!username || !password || password.length < 6) return res.status(400).json({ error: "Ogiltiga uppgifter" });
    const existing = await dbFindOne(db.users, { username: username.trim() });
    if (existing) return res.status(409).json({ error: "Användarnamnet är upptaget" });
    const hash = await bcrypt.hash(password, 12);
    const user = await dbInsert(db.users, { _id: uuidv4(), username: username.trim(), password_hash: hash, role, language: language || null, created_at: new Date().toISOString(), is_active: true });
    const needsOcrLanguage = language ? checkNeedsOcrLanguage(language, user._id, req.user._id, req.user.username) : null;
    res.json({ id: user._id, username: user.username, role: user.role, needsOcrLanguage });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/users/:id", requireAdmin, async (req, res) => {
  if (req.params.id === req.user._id) return res.status(400).json({ error: "Kan inte ta bort dig själv" });
  // Fully remove the user (not just deactivate) — otherwise the username stays taken forever
  // and can never be reused. Also cleans up their watch history so it doesn't linger in the
  // live-activity feed as an orphaned "(borttagen användare)" entry.
  await dbRemove(db.users, { _id: req.params.id });
  await dbRemove(db.history, { user_id: req.params.id }, { multi: true });
  await dbRemove(db.favorites, { user_id: req.params.id }, { multi: true }).catch(() => {});
  // Clean up any pending OCR-language notification tied to this user, if one exists.
  if (Array.isArray(config.pending_ocr_requests)) {
    config.pending_ocr_requests = config.pending_ocr_requests.filter(r => r.userId !== req.params.id);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  }
  res.json({ ok: true });
});

// One-time cleanup: permanently purges any user accounts soft-deactivated by the OLD delete
// behavior (before it was changed to a real delete, above). Those "ghost" accounts are
// invisible in /api/users (which only lists is_active users) but still occupy their username,
// so this is the only way to free them up again. Safe to run repeatedly — a no-op once clean.
app.post("/api/users/purge-inactive", requireAdmin, async (req, res) => {
  try {
    const ghosts = await dbFind(db.users, { is_active: false });
    for (const u of ghosts) {
      await dbRemove(db.users, { _id: u._id });
      await dbRemove(db.history, { user_id: u._id }, { multi: true });
      await dbRemove(db.favorites, { user_id: u._id }, { multi: true }).catch(() => {});
    }
    res.json({ ok: true, purged: ghosts.length, usernames: ghosts.map(u => u.username) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/users/:id/language", requireAuth, async (req, res) => {
  try {
    const { language } = req.body;
    // Users can only change their own language, admins can change anyone's
    if (req.params.id !== req.user._id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Ej tillåtet" });
    }
    await dbUpdate(db.users, { _id: req.params.id }, { $set: { language } });
    const needsOcrLanguage = checkNeedsOcrLanguage(language, req.params.id, req.user._id, req.user.username);
    res.json({ ok: true, needsOcrLanguage });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Manages a user's ordered subtitle-language PRIORITY list — separate from their primary
// `language` (which still governs UI text and TMDB overview/metadata language). This is for
// households with more than one nationality under one roof: e.g. a Danish-language account
// where one family member specifically wants Japanese subtitles first, falling back to
// Danish, and only then the server's normal eng→swe→embedded-swe→none chain.
app.patch("/api/users/:id/subtitle-languages", requireAuth, async (req, res) => {
  try {
    if (req.params.id !== req.user._id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Ej tillåtet" });
    }
    const languages = Array.isArray(req.body.languages) ? req.body.languages.filter(Boolean).slice(0, 6) : [];
    await dbUpdate(db.users, { _id: req.params.id }, { $set: { subtitleLanguages: languages } });
    // Flag any of these languages that aren't in the OCR/cache allowlist yet — same
    // notification path as the primary-language check, just looped over the whole list.
    let needsOcrLanguage = null;
    for (const lang of languages) {
      const flagged = checkNeedsOcrLanguageForCode(lang, req.params.id, req.user._id, req.user.username);
      if (flagged && !needsOcrLanguage) needsOcrLanguage = flagged; // surface the first one found
    }
    res.json({ ok: true, needsOcrLanguage });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Add a language to the OCR allowlist and (optionally) queue a targeted backfill so
// existing bitmap subtitles in that language get converted without redoing everything else.
app.post("/api/subtitles/ocr-languages", requireAdmin, async (req, res) => {
  try {
    const { lang, backfill = true } = req.body;
    const code = normalizeLangCode(lang);
    if (!code || code === "und") return res.status(400).json({ error: "Ogiltig språkkod" });
    const list = new Set(config.subtitle_ocr_languages && config.subtitle_ocr_languages.length
      ? config.subtitle_ocr_languages
      : [getServerDefaultSubLang(), "eng"]);
    list.add(code);
    config.subtitle_ocr_languages = [...list];
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    clearPendingOcrRequests(code); // this resolves any open notifications for that language

    // Tesseract needs a separate {lang}.traineddata file per language. Try to fetch it
    // automatically from the official tesseract-ocr/tessdata repo instead of just warning —
    // most languages are available there and this makes the whole flow fully self-service.
    const tessLang = TESSERACT_LANG_MAP[code] || code;
    const tessResult = await ensureTesseractLanguage(tessLang);

    let queued = 0;
    if (backfill) queued = await queueLanguageBackfill(code);
    res.json({
      ok: true, languages: config.subtitle_ocr_languages, queued,
      tessdataDownloaded: tessResult.downloaded,
      tessdataWarning: !tessResult.ok
        ? `Kunde inte hämta Tesseract-språkdata för ${subtitleLangLabel(code)} automatiskt (${tessResult.error}). Bildbaserade (PGS) undertexter på det språket kommer misslyckas tills du manuellt laddar ner "${tessLang}.traineddata" från github.com/tesseract-ocr/tessdata och lägger den i tools/PgsToSrt/tessdata/ på servern. Textbaserade spår påverkas inte.`
        : null
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/subtitles/ocr-languages", requireAuth, (req, res) => {
  res.json({
    mode: config.subtitle_ocr_mode || "selected",
    languages: (config.subtitle_ocr_languages && config.subtitle_ocr_languages.length)
      ? config.subtitle_ocr_languages
      : [getServerDefaultSubLang(), "eng"]
  });
});

// Active admin notification: users waiting on a new OCR subtitle language.
// Persisted (config.json) so it's still there next time an admin logs in, not just a log line.
app.get("/api/subtitles/ocr-pending", requireAdmin, async (req, res) => {
  try {
    res.json({ pending: await getPendingOcrRequestsWithUsernames() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Dismiss a pending request WITHOUT adding the language (admin decided not to, for now)
app.post("/api/subtitles/ocr-pending/dismiss", requireAdmin, async (req, res) => {
  try {
    const { lang, userId } = req.body;
    if (Array.isArray(config.pending_ocr_requests)) {
      config.pending_ocr_requests = config.pending_ocr_requests.filter(r => !(r.lang === lang && r.userId === userId));
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/subtitles/ocr-mode", requireAdmin, async (req, res) => {
  try {
    const { mode } = req.body; // "all" | "selected"
    if (!["all", "selected"].includes(mode)) return res.status(400).json({ error: "Ogiltigt läge" });
    config.subtitle_ocr_mode = mode;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    res.json({ ok: true, mode });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Removing a language just stops future OCR for it — already-cached files are left
// on disk (cheap to keep, and removing them would mean redoing the work if re-added).
app.delete("/api/subtitles/ocr-languages/:lang", requireAdmin, async (req, res) => {
  try {
    const code = normalizeLangCode(req.params.lang);
    const current = config.subtitle_ocr_languages && config.subtitle_ocr_languages.length
      ? config.subtitle_ocr_languages
      : [getServerDefaultSubLang(), "eng"];
    config.subtitle_ocr_languages = current.filter(l => l !== code);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    res.json({ ok: true, languages: config.subtitle_ocr_languages });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/users/:id/library-access", requireAdmin, async (req, res) => {
  try {
    const { library_ids } = req.body;
    await dbUpdate(db.users, { _id: req.params.id }, { $set: { library_ids: library_ids || [] } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/users/:id/password", requireAuth, async (req, res) => {
  if (req.params.id !== req.user._id && req.user.role !== "admin") return res.status(403).json({ error: "Ej tillåtet" });
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: "För kort lösenord" });
  const hash = await bcrypt.hash(password, 12);
  await dbUpdate(db.users, { _id: req.params.id }, { $set: { password_hash: hash } });
  res.json({ ok: true });
});

app.get("/api/libraries", requireAuth, (req, res) => {
  const libs = config.libraries || [];
  if (req.user.role === "admin") return res.json(libs);
  const allowed = libs.filter(l => userHasLibraryAccess(req.user, l.id));
  res.json(allowed);
});

app.get("/api/version", (req, res) => {
  res.json({ version: STREAMVAULT_VERSION, repo: GITHUB_REPO });
});

// Compares two "1.2.3"-style version strings. Returns >0 if a is newer, <0 if b is newer, 0 if equal.
function compareVersions(a, b) {
  const pa = (a || "0").split(".").map(n => parseInt(n) || 0);
  const pb = (b || "0").split(".").map(n => parseInt(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

app.get("/api/updates/check", requireAuth, async (req, res) => {
  try {
    const channel = config.update_channel || "stable"; // "stable" or "beta"
    const releases = await new Promise((resolve, reject) => {
      const req = https.get({
        hostname: "api.github.com",
        path: "/repos/" + GITHUB_REPO + "/releases",
        timeout: 5000, // fail fast — this must never be what makes Settings feel slow
        headers: {
          "User-Agent": "StreamVault/" + STREAMVAULT_VERSION,
          ...(process.env.GITHUB_TOKEN ? { "Authorization": "token " + process.env.GITHUB_TOKEN } : {})
        }
      }, r => {
        let d = ""; r.on("data", c => d += c);
        r.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error("parse")); } });
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("GitHub-anropet tog för lång tid (timeout)")); });
    });
    // Filter based on channel
    const eligible = (Array.isArray(releases) ? releases : [releases]).filter(r => {
      if (!r.tag_name) return false;
      if (channel === "beta") return true; // include pre-releases
      return !r.prerelease; // stable only
    });
    const data = eligible[0]; // newest eligible release
    if (!data) return res.json({ current: STREAMVAULT_VERSION, latest: STREAMVAULT_VERSION, hasUpdate: false });
    const latest = (data.tag_name || "v" + STREAMVAULT_VERSION).replace(/^v/, "");
    // On beta channel: compare full version including suffix
    // On stable channel: compare base versions only
    const latestBase = latest.replace(/[-+].*$/, "");
    const currentBase = STREAMVAULT_VERSION.replace(/[-+].*$/, "");
    const hasUpdate = channel === "beta"
      ? latest !== STREAMVAULT_VERSION
      : latestBase !== currentBase;
    const downloadUrl = (data.assets || []).find(a => a.name && a.name.endsWith(".exe"))?.browser_download_url || null;

    // Android app updates — completely separate version numbering from the server's own
    // (e.g. app "1.0.1" vs server "2.6.2"), so these are tracked independently: the Android
    // version is read from the APK's filename (e.g. "streamvault-android-v1.0.1.apk"), not
    // from the GitHub release tag, which represents the SERVER version instead. Scans the
    // last several releases (not just the newest one) in case a release was published with
    // only a server update and no new APK that time — otherwise a real APK update sitting in
    // an older release would be invisible once a newer, APK-less release comes along.
    let apkDownloadUrl = null, apkVersion = null, apkNotesAsset = null;
    for (const rel of eligible.slice(0, 10)) {
      // Was .find() (first match only) — if a single release had multiple APK assets (e.g.
      // v1.0.25 and v1.0.26 both attached), the server could get stuck on whichever happened
      // to be listed first by GitHub, meaning a device already on 1.0.25 would never see
      // 1.0.26 as available. Now checks every APK asset in the release, not just the first.
      const apkAssets = (rel.assets || []).filter(a => a.name && a.name.endsWith(".apk"));
      for (const apkAsset of apkAssets) {
        const m = apkAsset.name.match(/(\d+\.\d+(?:\.\d+)?)/);
        const v = m ? m[1] : null;
        if (v && (!apkVersion || compareVersions(v, apkVersion) > 0)) {
          apkVersion = v;
          apkDownloadUrl = apkAsset.browser_download_url;
          // Android gets its own release notes, never the server/Windows text (data.body) —
          // that's written for the Windows server audience and would be confusing/irrelevant
          // in the app. Looked for as a sibling asset in the SAME release, matching the APK's
          // name with a "-notes.txt" suffix (e.g. "streamvault-android-v1.0.1-notes.txt").
          const baseName = apkAsset.name.replace(/\.apk$/i, "");
          apkNotesAsset = (rel.assets || []).find(a => a.name === `${baseName}-notes.txt` || a.name === `${baseName}.notes.txt`) || null;
        }
      }
    }
    const requestedVersionName = req.query.versionName || null;
    const hasAndroidUpdate = !!(apkVersion && requestedVersionName && compareVersions(apkVersion, requestedVersionName) > 0);

    // Fetch the notes file's actual text content, if one was found. Deliberately left as an
    // empty string (never data.body) when no notes file exists for this APK — showing the
    // Windows server's release notes inside the Android app would just be confusing.
    let apkReleaseNotes = "";
    if (apkNotesAsset?.browser_download_url) {
      try {
        apkReleaseNotes = await new Promise((resolve, reject) => {
          https.get(apkNotesAsset.browser_download_url, { headers: { "User-Agent": "StreamVault/" + STREAMVAULT_VERSION }, timeout: 5000 }, r => {
            if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
              return https.get(r.headers.location, res2 => {
                let d = ""; res2.on("data", c => d += c); res2.on("end", () => resolve(d));
              }).on("error", reject);
            }
            let d = ""; r.on("data", c => d += c); r.on("end", () => resolve(d));
          }).on("error", reject);
        });
      } catch(e) {
        apkReleaseNotes = ""; // fine if this fails — the update itself still works, just without notes text
      }
    }

    res.json({ current: STREAMVAULT_VERSION, latest, hasUpdate, releaseNotes: data.body || "", htmlUrl: data.html_url || null, downloadUrl, channel, isBeta: !!data.prerelease, apkDownloadUrl, apkVersion, hasAndroidUpdate, apkReleaseNotes });
  } catch {
    res.json({ current: STREAMVAULT_VERSION, latest: STREAMVAULT_VERSION, hasUpdate: false });
  }
});

// Download and install update
app.post("/api/updates/install", requireAdmin, async (req, res) => {
  const { downloadUrl } = req.body;
  if (!downloadUrl) return res.status(400).json({ error: "No download URL" });

  res.json({ ok: true, message: "Update started" });

  // Run in background after response sent
  setTimeout(async () => {
    try {
      const os = require("os");
      const { execSync, spawn } = require("child_process");
      const tmpFile = path.join(os.tmpdir(), "StreamVault-Update.exe");

      console.log("[UPDATE] Downloading from:", downloadUrl);

      // Download the installer - follow up to 5 redirects
      await new Promise((resolve, reject) => {
        function download(url, redirectCount) {
          if (redirectCount > 5) return reject(new Error("Too many redirects"));
          const parsedUrl = new URL(url);
          const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            headers: { "User-Agent": "StreamVault/" + STREAMVAULT_VERSION }
          };
          https.get(options, response => {
            if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 303) {
              response.resume();
              return download(response.headers.location, redirectCount + 1);
            }
            if (response.statusCode !== 200) {
              response.resume();
              return reject(new Error("HTTP " + response.statusCode));
            }
            const file = fs.createWriteStream(tmpFile);
            response.pipe(file);
            file.on("finish", () => { file.close(); resolve(); });
            file.on("error", reject);
          }).on("error", reject);
        }
        download(downloadUrl, 0);
      });

      console.log("[UPDATE] Download complete, running installer...");

      // Run installer silently - /SILENT = silent, /NORESTART = don't restart
      spawn(tmpFile, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], {
        detached: true,
        stdio: "ignore"
      }).unref();

      // Schedule a restart via Task Scheduler after installer has had time to finish
      // We use a separate scheduled task approach - write a restart flag file
      const restartFlagPath = path.join(DATA_DIR, "pending_restart.flag");
      fs.writeFileSync(restartFlagPath, new Date().toISOString());
      
      // Exit so installer can replace files
      setTimeout(() => process.exit(0), 1000);

    } catch(e) {
      console.log("[UPDATE] Error:", e.message);
    }
  }, 500);
});

app.get("/api/libraries-all", requireAdmin, (req, res) => res.json(config.libraries || []));

app.post("/api/libraries", requireAdmin, (req, res) => {
  const { name, type, path: libPath } = req.body;
  if (!name || !type || !libPath) return res.status(400).json({ error: "Saknar fält" });
  if (!fs.existsSync(libPath)) return res.status(400).json({ error: "Sökvägen finns inte: " + libPath });
  const lib = { id: uuidv4(), name, type, path: libPath };
  config.libraries.push(lib);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  startFileWatchers(); // Watch new library
  res.json(lib);
});

// Accepts any name_<langCode> field generically (name_en, name_fi, etc.) — the display name
// shown to users whose language matches that code, so e.g. "Filmer UHD" can show as "Movies
// UHD" or "Elokuvat UHD" without renaming the library itself (which is also its folder path
// reference, not just a label). Generic by design so adding another language later doesn't
// need a backend change.
app.patch("/api/libraries/:id", requireAdmin, (req, res) => {
  const lib = config.libraries.find(l => l.id === req.params.id);
  if (!lib) return res.status(404).json({ error: "Hittades inte" });
  for (const key of Object.keys(req.body)) {
    if (/^name_[a-z]{2}$/.test(key)) lib[key] = req.body[key] || null;
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  res.json(lib);
});

app.delete("/api/libraries/:id", requireAdmin, async (req, res) => {
  config.libraries = config.libraries.filter(l => l.id !== req.params.id);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  await dbRemove(db.media, { library_id: req.params.id }, { multi: true });
  startFileWatchers(); // Update watchers
  res.json({ ok: true });
});

const VIDEO_EXT = new Set([".mp4",".mkv",".avi",".mov",".wmv",".m4v",".ts",".webm",".flv"]);
const AUDIO_EXT = new Set([".mp3",".flac",".aac",".ogg",".wav",".m4a",".opus",".wma"]);

function cleanTitle(name) {
  let n = path.parse(name).name;
  // Replace separators with spaces
  n = n.replace(/[\.\-\_]/g," ");
  // Remove common release tags
  n = n.replace(/\b(1080p|2160p|4k|uhd|720p|480p|bluray|blu ray|bdrip|webrip|web dl|web|hdtv|x264|x265|hevc|avc|aac|dts|ac3|h264|h265|remux|hdr|hdr10|dolby|atmos|truehd|proper|repack|extended|theatrical|directors cut|unrated|remastered|imax|3d|dvdrip|dvdscr)\b/gi,"");
  // Extract year
  const ym = n.match(/\b(19|20)\d{2}\b/);
  const year = ym ? parseInt(ym[0]) : null;
  // Remove year and everything after
  n = n.replace(/\b(19|20)\d{2}\b.*$/,"");
  // Remove trailing standalone numbers (e.g. "Beverly Hills Cop 1" -> "Beverly Hills Cop")
  n = n.replace(/\s+\d+\s*$/,"");
  // Clean spaces
  n = n.replace(/\s+/g," ").trim();
  return { cleanName: n, year };
}

const metaCache = new Map();
// Tracks the last TMDB failure so there's something concrete to look at instead of just
// guessing "rate limited?" — tmdbFetch update this on every non-2xx response, timeout, or
// network error. Successful calls clear it.
let _tmdbLastError = null;

// Verbose subtitle-request logging — off by default (noisy), toggled at runtime via
// POST /api/admin/verbose-subtitle-logging, no server restart needed. Meant for actively
// debugging "what exactly did the app ask for, and what did the server decide/return" across
// all four subtitle-serving endpoints, in one consistent, easy-to-follow format.
let _verboseSubtitleLogging = false;
function vlog(...args) {
  if (!_verboseSubtitleLogging) return;
  // Routed through logSubtitle (same buffer/file the "Visa undertext-logg" viewer already
  // reads) instead of a separate raw console.log, so these show up in the existing in-app
  // log viewer — no need to dig through raw server console/file output to see them.
  logSubtitle("debug", null, args.join(" "));
}
app.post("/api/admin/verbose-subtitle-logging", requireAdmin, (req, res) => {
  _verboseSubtitleLogging = !!req.body.enabled;
  console.log(`[SUB-DEBUG] Detaljerad undertextloggning ${_verboseSubtitleLogging ? "PÅSLAGEN" : "avstängd"}`);
  res.json({ enabled: _verboseSubtitleLogging });
});
app.get("/api/admin/verbose-subtitle-logging", requireAdmin, (req, res) => {
  res.json({ enabled: _verboseSubtitleLogging });
});

// Fast viewer — serves straight from the in-memory ring buffer (last ~5000 lines), no disk
// read needed. Optional ?q= filters to lines containing that text (case-insensitive), handy
// for e.g. just looking at [HTTP] lines or a specific endpoint while debugging the app.
app.get("/api/admin/server-log", requireAdmin, (req, res) => {
  let lines = _serverLogBuffer;
  if (req.query.q) {
    const q = req.query.q.toLowerCase();
    lines = lines.filter(l => l.toLowerCase().includes(q));
  }
  const limit = Math.min(parseInt(req.query.limit) || 1000, SERVER_LOG_MAX_LINES);
  res.json({ lines: lines.slice(-limit), totalBuffered: _serverLogBuffer.length });
});

// Full file download for a given date (defaults to today) — for digging deeper than the
// in-memory buffer covers, or attaching the whole thing somewhere.
app.get("/api/admin/server-log/download", requireAdmin, (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "") ? req.query.date : new Date().toISOString().slice(0, 10);
  const filePath = _serverLogFilePath(date);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Ingen logg för det datumet" });
  res.download(filePath, `streamvault-log-${date}.txt`);
});

app.get("/api/admin/server-log/dates", requireAdmin, (req, res) => {
  try {
    const dates = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith("server-") && f.endsWith(".log"))
      .map(f => f.slice(7, -4))
      .sort().reverse();
    res.json({ dates });
  } catch(e) { res.json({ dates: [] }); }
});

// Backfills genres onto titles scanned before this field existed — uses the tmdb_id already
// stored on each item (no need to re-match by title/year), so this is quick and safe to run
// even on a large library.
app.post("/api/admin/backfill-genres", requireAdmin, async (req, res) => {
  try {
    const items = await dbFind(db.media, { type: { $in: ["movie", "tvshow"] }, tmdb_id: { $ne: null } });
    const missing = items.filter(i => !i.genres || !i.genres.length);
    let updated = 0;
    for (const item of missing) {
      try {
        const endpoint = item.type === "movie" ? `/movie/${item.tmdb_id}` : `/tv/${item.tmdb_id}`;
        const data = await tmdbFetch(endpoint);
        const genres = (data?.genres || []).map(g => g.name);
        if (genres.length) {
          await dbUpdate(db.media, { _id: item._id }, { $set: { genres } });
          updated++;
        }
      } catch(e) {} // one bad lookup shouldn't stop the whole backfill
    }
    res.json({ ok: true, checked: missing.length, updated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/system-stats", requireAdmin, (req, res) => {
  res.json({ samples: _systemStatsBuffer, intervalMs: SYSTEM_STATS_INTERVAL_MS });
});

// ── IPTV ──────────────────────────────────────────────────────────────────────
// Parses a standard M3U/M3U8 playlist (the common format IPTV providers use) into
// individual channels. Format is simple: a "#EXTINF:" metadata line immediately followed by
// the stream URL on the next line, repeated for each channel.
//   #EXTINF:-1 tvg-id="..." tvg-logo="http://..." group-title="Sweden",Channel Name
//   http://stream-url...
// Detects which country a group-title belongs to (e.g. "CANADA – Sports", "CANADA-LOCAL CBC",
// "Canada Kids" all belong to "Canada") — many IPTV providers split each country into several
// separate group-titles by category, which otherwise clutters the top-level list with dozens
// of near-duplicate entries instead of one country to drill into.
const COUNTRY_NAMES = {
  "sweden":"Sweden","sverige":"Sweden","norway":"Norway","norge":"Norway","denmark":"Denmark","danmark":"Denmark",
  "finland":"Finland","iceland":"Iceland","uk":"UK","united kingdom":"UK","england":"UK","britain":"UK",
  "usa":"USA","us":"USA","united states":"USA","america":"USA","canada":"Canada","germany":"Germany",
  "deutschland":"Germany","france":"France","spain":"Spain","espana":"Spain","italy":"Italy","italia":"Italy",
  "netherlands":"Netherlands","holland":"Netherlands","belgium":"Belgium","portugal":"Portugal","poland":"Poland","polska":"Poland",
  "russia":"Russia","turkey":"Turkey","turkiye":"Turkey","greece":"Greece","austria":"Austria","switzerland":"Switzerland",
  "ireland":"Ireland","albania":"Albania","arabic":"Saudi Arabia","saudi":"Saudi Arabia","uae":"UAE","emirates":"UAE",
  "india":"India","pakistan":"Pakistan","brazil":"Brazil","brasil":"Brazil","mexico":"Mexico","australia":"Australia",
  "romania":"Romania","bulgaria":"Bulgaria","croatia":"Croatia","serbia":"Serbia","hungary":"Hungary","czech":"Czech Republic",
  "slovakia":"Slovakia","slovenia":"Slovenia","lithuania":"Lithuania","latvia":"Latvia","estonia":"Estonia","ukraine":"Ukraine",
  "china":"China","japan":"Japan","korea":"Korea","thailand":"Thailand","philippines":"Philippines","vietnam":"Vietnam",
  "indonesia":"Indonesia","malaysia":"Malaysia","israel":"Israel","egypt":"Egypt","morocco":"Morocco","south africa":"South Africa"
};
function detectCountry(groupTitle) {
  const clean = groupTitle.toLowerCase().replace(/\bhd\b|\b4k\b|\buhd\b|\bfhd\b/g, " ").replace(/[-–_]/g, " ").trim();
  for (const [key, country] of Object.entries(COUNTRY_NAMES)) {
    // Word-boundary match against the FIRST word/segment specifically — avoids e.g. "usa"
    // matching inside an unrelated longer word, since group-titles put the country first.
    if (clean === key || clean.startsWith(key + " ") || clean.startsWith(key + "-")) return country;
  }
  return null; // not a recognized country — kept as its own standalone top-level entry
}

// Detects whether an entry is a live channel, a VOD movie, or a VOD series episode.
// Xtream Codes-based providers (the most common IPTV backend, identifiable by the
// "m3u_plus" playlist type) consistently encode this in the stream URL's path itself
// (/live/, /movie/, /series/) regardless of which specific provider it is — far more
// reliable than group-title text, which varies a lot between providers. Group-title
// keywords are only used as a fallback for playlists that don't follow that convention.
function detectContentType(url, groupTitle) {
  if (/\/movie\//i.test(url)) return "movie";
  if (/\/series\//i.test(url)) return "series";
  if (/\/live\//i.test(url)) return "live";
  const g = (groupTitle || "").toLowerCase();
  if (/\bvod\b|\bmovies?\b|\bfilm/i.test(g)) return "movie";
  if (/\bseries\b|\btv shows?\b/i.test(g)) return "series";
  return "live";
}

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXTINF:")) continue;
    const url = (lines[i + 1] || "").trim();
    if (!url || url.startsWith("#")) continue; // malformed entry — no URL followed, skip
    const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
    const groupMatch = line.match(/group-title="([^"]*)"/i);
    const name = line.split(",").pop().trim() || "Okänd kanal";
    const group = groupMatch && groupMatch[1] ? groupMatch[1] : "Övrigt";
    const type = detectContentType(url, group);
    channels.push({
      _id: uuidv4(),
      name,
      logo: logoMatch ? logoMatch[1] : null,
      group,
      country: type === "live" ? detectCountry(group) : null, // consolidation only makes sense for live TV, not movies/series
      type,
      url
    });
  }
  return channels;
}

// Re-parses and replaces the whole channel list — channels come and go between playlist
// updates, so keeping stale entries around from a previous version doesn't make sense.
// Shared logic for fetching + parsing + saving a playlist — used by both the initial setup
// (POST /parse, with a URL provided) and refresh (POST /refresh, reusing the saved URL).
async function fetchAndSaveM3U(url) {
  const text = await new Promise((resolve, reject) => {
    const client = url.startsWith("http://") ? http : https;
    client.get(url, { timeout: 20000 }, (r) => {
      if (r.statusCode >= 400) { r.resume(); return reject(new Error(`HTTP ${r.statusCode}`)); }
      let body = "";
      r.on("data", c => body += c);
      r.on("end", () => resolve(body));
    }).on("error", reject).on("timeout", () => reject(new Error("Timeout")));
  });
  const channels = parseM3U(text);
  if (!channels.length) throw new Error("Ingen kanal hittades i listan — kontrollera att adressen pekar på en giltig M3U-fil");
  await new Promise((resolve, reject) => db.iptvChannels.remove({}, { multi: true }, (err) => err ? reject(err) : resolve()));
  await new Promise((resolve, reject) => db.iptvChannels.insert(channels, (err) => err ? reject(err) : resolve()));
  config.iptv_m3u_url = url;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`[IPTV] Tolkade ${channels.length} kanaler från spellistan`);
  return channels.length;
}

// Re-fetches using the already-saved playlist URL — for refreshing the channel list without
// needing to go into Settings and re-paste the same address. Still entirely on-demand: this
// is never called automatically or on a schedule, only when explicitly triggered.
app.post("/api/iptv/refresh", requireAdmin, async (req, res) => {
  if (!config.iptv_m3u_url) return res.status(400).json({ error: "Ingen spellista sparad ännu" });
  try {
    const count = await fetchAndSaveM3U(config.iptv_m3u_url);
    res.json({ ok: true, count });
  } catch(e) {
    res.status(500).json({ error: "Kunde inte hämta/tolka listan: " + e.message });
  }
});

app.post("/api/iptv/parse", requireAdmin, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Ingen adress angiven" });
  try {
    const count = await fetchAndSaveM3U(url);
    res.json({ ok: true, count });
  } catch(e) {
    res.status(500).json({ error: "Kunde inte hämta/tolka listan: " + e.message });
  }
});

app.get("/api/iptv/groups", requireAuth, async (req, res) => {
  if (!userHasIptvAccess(req.user)) return res.status(403).json({ error: "Ej tillåtet" });
  try {
    const type = ["live", "movie", "series"].includes(req.query.type) ? req.query.type : "live";
    const allChannels = await dbFind(db.iptvChannels, {});
    const channels = allChannels.filter(c => (c.type || "live") === type);
    // For live TV, consolidate under detected country where possible (e.g. "CANADA – Sports"
    // and "CANADA-LOCAL CBC" both roll up under one "Canada" entry) — for movies/series this
    // consolidation doesn't apply (country wasn't computed for those at parse time), so it
    // just falls through to the raw group-title, same as before.
    const counts = {};
    for (const c of channels) {
      const key = (type === "live" && c.country) ? c.country : c.group;
      counts[key] = (counts[key] || 0) + 1;
    }
    const userPlaylists = await dbFind(db.iptvPlaylists, { user_id: req.user._id });
    const favoritedCountryNames = new Set(userPlaylists.flatMap(p => (p.countries || []).map(c => c.name)));
    const groups = Object.entries(counts).map(([name, count]) => ({
      name, count,
      isCountry: type === "live" && Object.values(COUNTRY_NAMES).includes(name),
      inAnyPlaylist: favoritedCountryNames.has(name)
    })).sort((a, b) => a.name.localeCompare(b.name));
    const typeCounts = { live: 0, movie: 0, series: 0 };
    for (const c of allChannels) typeCounts[c.type || "live"]++;
    res.json({ groups, total: channels.length, typeCounts, configuredUrl: config.iptv_m3u_url || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Drills into a consolidated country entry to show its original, provider-specific
// sub-categories (e.g. Canada → Documentary / Sports / Kids / LOCAL CBC / ...).
// ── IPTV PLAYLISTS (favorites) ─────────────────────────────────────────────────
// Spotify-style: the person can create several named lists (e.g. "Barnfavoriter",
// "Sportfavoriter") and add individual channels OR a whole country's worth of channels to
// whichever list(s) they choose, rather than one single flat favorites list. Personal to
// each user, not shared.
//
// A playlist stores TWO separate things, not just one flat channel list:
//   - channel_ids: individually-added channels
//   - countries: [{name, isCountry}] — whole countries/groups added as a single unit, shown
//     collapsed as one entry ("Sweden — 42 kanaler") rather than exploding into 42 separate
//     rows. The channel count for a country entry is always computed FRESH from the current
//     channel list (not stored), so a later playlist refresh that adds/removes channels for
//     that country is reflected automatically.

function channelsForCountryQuery(country, isCountry) {
  return isCountry ? { country, type: "live" } : { group: country, type: "live" };
}

app.get("/api/iptv/playlists", requireAuth, async (req, res) => {
  if (!userHasIptvAccess(req.user)) return res.status(403).json({ error: "Ej tillåtet" });
  try {
    const playlists = await dbFind(db.iptvPlaylists, { user_id: req.user._id });
    res.json({ playlists: playlists.map(p => ({ id: p._id, name: p.name, count: (p.channel_ids || []).length + (p.countries || []).length })).sort((a, b) => a.name.localeCompare(b.name)) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/iptv/playlists", requireAuth, async (req, res) => {
  if (!userHasIptvAccess(req.user)) return res.status(403).json({ error: "Ej tillåtet" });
  try {
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Inget namn angivet" });
    const doc = { _id: uuidv4(), user_id: req.user._id, name, channel_ids: [], countries: [], created_at: new Date().toISOString() };
    await dbInsert(db.iptvPlaylists, doc);
    res.json({ id: doc._id, name: doc.name, count: 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/iptv/playlists/:id/delete", requireAuth, async (req, res) => {
  try {
    const playlist = await dbFindOne(db.iptvPlaylists, { _id: req.params.id });
    if (!playlist || playlist.user_id !== req.user._id) return res.status(404).json({ error: "Hittades inte" });
    await new Promise((resolve, reject) => db.iptvPlaylists.remove({ _id: req.params.id }, {}, (err) => err ? reject(err) : resolve()));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Which of the person's playlists already contain this channel — used to pre-check the
// right boxes when opening the "save to..." picker for a single channel.
app.get("/api/iptv/playlists/for-channel/:channelId", requireAuth, async (req, res) => {
  try {
    const playlists = await dbFind(db.iptvPlaylists, { user_id: req.user._id });
    res.json({ playlists: playlists.map(p => ({ id: p._id, name: p.name, contains: (p.channel_ids || []).includes(req.params.channelId) })).sort((a, b) => a.name.localeCompare(b.name)) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Same, but for a whole country/group — checks the "countries" list directly (was this
// country explicitly saved as a unit), not whether every individual channel happens to be
// present, since those are now tracked separately.
app.get("/api/iptv/playlists/for-country", requireAuth, async (req, res) => {
  try {
    const { country, isCountry } = req.query;
    if (!country) return res.status(400).json({ error: "Inget land angivet" });
    const playlists = await dbFind(db.iptvPlaylists, { user_id: req.user._id });
    res.json({
      playlists: playlists.map(p => ({
        id: p._id, name: p.name,
        contains: (p.countries || []).some(c => c.name === country)
      })).sort((a, b) => a.name.localeCompare(b.name))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/iptv/playlists/:id/toggle-channel", requireAuth, async (req, res) => {
  try {
    const playlist = await dbFindOne(db.iptvPlaylists, { _id: req.params.id });
    if (!playlist || playlist.user_id !== req.user._id) return res.status(404).json({ error: "Hittades inte" });
    const { channelId, add } = req.body;
    const current = new Set(playlist.channel_ids || []);
    if (add) current.add(channelId); else current.delete(channelId);
    await dbUpdate(db.iptvPlaylists, { _id: req.params.id }, { $set: { channel_ids: [...current] } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/iptv/playlists/:id/toggle-country", requireAuth, async (req, res) => {
  try {
    const playlist = await dbFindOne(db.iptvPlaylists, { _id: req.params.id });
    if (!playlist || playlist.user_id !== req.user._id) return res.status(404).json({ error: "Hittades inte" });
    const { country, isCountry, add } = req.body;
    let countries = playlist.countries || [];
    if (add) {
      if (!countries.some(c => c.name === country)) countries = [...countries, { name: country, isCountry: !!isCountry }];
    } else {
      countries = countries.filter(c => c.name !== country);
    }
    await dbUpdate(db.iptvPlaylists, { _id: req.params.id }, { $set: { countries } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/iptv/playlists/:id/channels", requireAuth, async (req, res) => {
  try {
    const playlist = await dbFindOne(db.iptvPlaylists, { _id: req.params.id });
    if (!playlist || playlist.user_id !== req.user._id) return res.status(404).json({ error: "Hittades inte" });
    const countries = playlist.countries || [];
    // Country entries stay collapsed — count is computed fresh, not stored, so it reflects
    // the playlist's current channel count even if channels were added/removed since.
    const countryEntries = [];
    for (const c of countries) {
      const count = await new Promise((resolve) => db.iptvChannels.count(channelsForCountryQuery(c.name, c.isCountry), (err, n) => resolve(err ? 0 : n)));
      countryEntries.push({ name: c.name, isCountry: c.isCountry, count });
    }
    const ids = playlist.channel_ids || [];
    const channels = ids.length ? (await dbFind(db.iptvChannels, { _id: { $in: ids } })).sort((a, b) => a.name.localeCompare(b.name)) : [];
    res.json({
      name: playlist.name,
      countryEntries,
      channels: channels.map(c => ({ id: c._id, name: c.name, logo: c.logo, group: c.group, country: c.country, type: c.type || "live", url: c.url }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Lists a playlist's country entry's actual channels — for drilling into "Sweden" within a
// playlist to see/play its channels, same as browsing normally.
app.get("/api/iptv/playlists/:id/country-channels", requireAuth, async (req, res) => {
  try {
    const playlist = await dbFindOne(db.iptvPlaylists, { _id: req.params.id });
    if (!playlist || playlist.user_id !== req.user._id) return res.status(404).json({ error: "Hittades inte" });
    const { country, isCountry } = req.query;
    const channels = (await dbFind(db.iptvChannels, channelsForCountryQuery(country, isCountry === "true"))).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ channels: channels.map(c => ({ id: c._id, name: c.name, logo: c.logo, group: c.group, type: c.type || "live", url: c.url })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/iptv/subgroups", requireAuth, async (req, res) => {
  if (!userHasIptvAccess(req.user)) return res.status(403).json({ error: "Ej tillåtet" });
  try {
    const country = req.query.country;
    if (!country) return res.status(400).json({ error: "Inget land angivet" });
    const channels = await dbFind(db.iptvChannels, { country, type: "live" });
    const counts = {};
    for (const c of channels) counts[c.group] = (counts[c.group] || 0) + 1;
    const groups = Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ groups });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/iptv/channels", requireAuth, async (req, res) => {
  if (!userHasIptvAccess(req.user)) return res.status(403).json({ error: "Ej tillåtet" });
  try {
    const query = req.query.group ? { group: req.query.group } : {};
    if (["live", "movie", "series"].includes(req.query.type)) query.type = req.query.type;
    const channels = (await dbFind(db.iptvChannels, query)).sort((a, b) => a.name.localeCompare(b.name));
    const userPlaylists = await dbFind(db.iptvPlaylists, { user_id: req.user._id });
    const favoritedChannelIds = new Set(userPlaylists.flatMap(p => p.channel_ids || []));
    const favoritedCountryNames = new Set(userPlaylists.flatMap(p => (p.countries || []).map(c => c.name)));
    res.json({ channels: channels.map(c => ({
      id: c._id, name: c.name, logo: c.logo, group: c.group, type: c.type || "live", url: c.url,
      inAnyPlaylist: favoritedChannelIds.has(c._id) || (c.country && favoritedCountryNames.has(c.country)) || favoritedCountryNames.has(c.group)
    })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DEPENDENCY UPDATES ────────────────────────────────────────────────────────
// Checks npm packages via `npm outdated`, and separately checks whether a newer Node.js LTS
// release exists (informational only — Node.js itself is never auto-updated, since the
// server would need to stop the very runtime it's currently executing on to do that, and it
// usually needs different permissions than the app runs with anyway. That one stays a manual,
// occasional task with a short how-to shown in the UI).
const PROJECT_ROOT = path.join(__dirname, "..");

function runNpmCommand(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    require("child_process").execFile(
      process.platform === "win32" ? "npm.cmd" : "npm",
      args,
      // shell:true is required on Windows — npm.cmd is a batch file, not a real executable,
      // and spawning it directly without a shell throws "spawn EINVAL" on Windows/Node
      // combinations. No effect on Linux/Mac, where npm is invoked directly either way.
      { cwd: PROJECT_ROOT, timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024, shell: process.platform === "win32" },
      (err, stdout, stderr) => {
        // `npm outdated` deliberately exits with code 1 when outdated packages exist — that's
        // normal, not a failure, so we always resolve with whatever stdout we got rather than
        // treating a non-zero exit as an error.
        resolve({ stdout: stdout || "", stderr: stderr || "", err });
      }
    );
  });
}

app.get("/api/admin/dependency-check", requireAdmin, async (req, res) => {
  try {
    const { stdout } = await runNpmCommand(["outdated", "--json"]);
    let outdated = {};
    try { outdated = stdout.trim() ? JSON.parse(stdout) : {}; } catch(e) { /* empty/malformed output = nothing outdated */ }
    const packages = Object.entries(outdated).map(([name, info]) => {
      const currentMajor = parseInt((info.current || "0").split(".")[0]);
      const latestMajor = parseInt((info.latest || "0").split(".")[0]);
      return {
        name, current: info.current, wanted: info.wanted, latest: info.latest,
        // A major-version jump is far more likely to include breaking changes than a
        // minor/patch bump — flagged so the UI can visually distinguish "probably safe" from
        // "read the changelog first".
        majorUpdate: latestMajor > currentMajor
      };
    });

    let nodeUpdate = null;
    try {
      const releases = await httpsGetJson("https://nodejs.org/dist/index.json", 8000);
      const latestLts = releases.find(r => r.lts); // list is newest-first
      const currentVersion = process.version.replace(/^v/, "");
      if (latestLts && latestLts.version.replace(/^v/, "") !== currentVersion) {
        nodeUpdate = { current: currentVersion, latest: latestLts.version.replace(/^v/, ""), ltsName: latestLts.lts };
      }
    } catch(e) {
      console.log("[DEPS] Could not check Node.js version:", e.message);
    }

    res.json({ packages, nodeUpdate, checkedAt: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Installs specific packages the admin chose (never "everything" blindly) at their latest
// version. The server does NOT restart itself afterward — Node has already loaded the old
// code into memory, so a manual/scripted restart is still required for the update to
// actually take effect, same as any other file change to index.js/app.js.
app.post("/api/admin/dependency-install", requireAdmin, async (req, res) => {
  try {
    const names = Array.isArray(req.body.packages) ? req.body.packages.filter(n => /^[a-zA-Z0-9@/_.-]+$/.test(n)) : [];
    if (!names.length) return res.status(400).json({ error: "Inga paket valda" });
    const results = [];
    for (const name of names) {
      console.log(`[DEPS] Installerar ${name}@latest...`);
      const { err, stderr } = await runNpmCommand(["install", `${name}@latest`], 120000);
      results.push({ name, ok: !err, error: err ? stderr.slice(0, 300) : null });
    }
    res.json({ results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


function tmdbFetch(endpoint, userLanguage) {
  return new Promise(resolve => {
    if (!config.tmdb_api_key) { _tmdbLastError = { at: new Date().toISOString(), reason: "no_api_key", message: "Ingen TMDB API-nyckel är inställd" }; return resolve(null); }
    const sep = endpoint.includes("?") ? "&" : "?";
    const lang = userLanguage || (config.language && config.language !== "auto" ? config.language : "en-US");
    const req = https.get(`https://api.themoviedb.org/3${endpoint}${sep}api_key=${config.tmdb_api_key}&language=${lang}`, { timeout: 8000 }, res => {
      let d=""; res.on("data",c=>d+=c);
      res.on("end",()=>{
        let parsed = null;
        try { parsed = JSON.parse(d); } catch {}
        if (res.statusCode !== 200) {
          const reason = res.statusCode === 401 ? "invalid_api_key" : res.statusCode === 429 ? "rate_limited" : "http_error";
          _tmdbLastError = { at: new Date().toISOString(), reason, status: res.statusCode, message: parsed?.status_message || `HTTP ${res.statusCode}`, endpoint };
          console.log(`[TMDB] Fel (${res.statusCode}) på ${endpoint}: ${parsed?.status_message || "okänt fel"}`);
          return resolve(null);
        }
        _tmdbLastError = null; // success clears any previous error
        resolve(parsed);
      });
    });
    req.on("error", (e) => {
      _tmdbLastError = { at: new Date().toISOString(), reason: "network_error", message: e.message, endpoint };
      console.log(`[TMDB] Nätverksfel på ${endpoint}:`, e.message);
      resolve(null);
    });
    req.on("timeout", () => {
      req.destroy();
      _tmdbLastError = { at: new Date().toISOString(), reason: "timeout", message: "Anropet tog för lång tid (>8s)", endpoint };
      console.log(`[TMDB] Timeout på ${endpoint}`);
      resolve(null);
    });
  });
}

// Live connectivity test — makes one cheap, harmless call and reports back exactly what
// happened, instead of leaving the admin to guess whether it's rate limiting, a bad key,
// or a network problem.
app.get("/api/tmdb/test", requireAdmin, async (req, res) => {
  if (!config.tmdb_api_key) return res.json({ ok: false, reason: "no_api_key", message: "Ingen TMDB API-nyckel är inställd i Inställningar." });
  const before = _tmdbLastError;
  const data = await tmdbFetch("/configuration");
  if (data && data.images) {
    return res.json({ ok: true, message: "TMDB svarar normalt." });
  }
  const err = _tmdbLastError;
  const messages = {
    invalid_api_key: "TMDB-nyckeln verkar ogiltig eller återkallad. Kontrollera nyckeln i Inställningar.",
    rate_limited: "TMDB har tillfälligt blockerat/strypt anrop från din server (rate limiting). Vänta en stund och försök igen.",
    network_error: "Kunde inte nå TMDB alls – kontrollera serverns internetanslutning: " + (err?.message || ""),
    timeout: "TMDB svarade inte inom 8 sekunder – kan vara ett tillfälligt nätverks- eller TMDB-problem.",
    http_error: `TMDB svarade med ett fel: ${err?.message || "okänt"}`
  };
  res.json({ ok: false, reason: err?.reason || "unknown", message: messages[err?.reason] || "Okänt fel – se serverloggen (\"[TMDB]\").", detail: err });
});

async function getMovieMeta(title, year) {
  const key=`movie:${title}:${year}`;
  if(metaCache.has(key)) return metaCache.get(key);
  const data = await tmdbFetch(`/search/movie?query=${encodeURIComponent(title)}${year?`&year=${year}`:""}`);
  const m = data?.results?.[0];
  if (!m) { metaCache.set(key, null); return null; }
  // Fetch full movie details to get belongs_to_collection
  const details = await tmdbFetch(`/movie/${m.id}`);
  const collection = details?.belongs_to_collection;
  const meta = {
    tmdb_id: m.id,
    overview: m.overview||"",
    poster_url: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
    backdrop_url: m.backdrop_path ? `https://image.tmdb.org/t/p/w1280${m.backdrop_path}` : null,
    rating: m.vote_average||null,
    year: m.release_date ? parseInt(m.release_date) : year,
    genres: (details?.genres || []).map(g => g.name),
    collection_id: collection?.id || null,
    collection_name: collection?.name || null,
    collection_poster: collection?.poster_path ? `https://image.tmdb.org/t/p/w500${collection.poster_path}` : null,
    collection_backdrop: collection?.backdrop_path ? `https://image.tmdb.org/t/p/w1280${collection.backdrop_path}` : null
  };
// Fetch English title separately so we always keep originals — title/overview text fields
  // ARE reliably localized by TMDB's `language` param, unlike poster images (see below).
  if (config.language && config.language !== "en-US" && config.language !== "auto") {
    const enData = await tmdbFetch(`/movie/${m.id}`, "en-US");
    if (enData?.title) meta.title_en = enData.title;
  }
  // Fetch the poster via the dedicated images endpoint rather than trusting `poster_path` on
  // a language-filtered details call. Per TMDB's own docs: poster_path for a requested
  // `language` falls back to the movie's original-language poster if none is tagged for that
  // language, and if THAT doesn't exist either, falls all the way back to the single highest-
  // rated poster overall — which can end up in any language, unrelated to what was requested.
  // Querying /images directly with include_image_language lets us explicitly pick an
  // English-tagged poster ourselves, guaranteeing the "always English" policy regardless of
  // what quirks TMDB's automatic per-movie fallback chain happens to produce.
  try {
    const images = await tmdbFetch(`/movie/${m.id}/images?include_image_language=en,null`);
    const posters = images?.posters || [];
    const englishPoster = posters.find(p => p.iso_639_1 === "en") || posters[0];
    if (englishPoster?.file_path) meta.poster_url = `https://image.tmdb.org/t/p/w500${englishPoster.file_path}`;
  } catch(e) {
    // Keep whatever poster_url was already set above — not worth failing the whole scan over.
  }
  // Same reasoning as the poster fix above — TMDB frequently has no translated overview for
  // less mainstream/older movies even though the search itself succeeds.
  if (!meta.overview) {
    try {
      const enData = await tmdbFetch(`/movie/${m.id}`, "en-US");
      if (enData?.overview) meta.overview = enData.overview;
    } catch(e) {
      // Keep the empty overview — not worth failing the whole scan over.
    }
  }
  metaCache.set(key, meta);
  return meta;
}

async function getTVMeta(title) {
  const key=`tv:${title}`;
  if(metaCache.has(key)) return metaCache.get(key);
  const data = await tmdbFetch(`/search/tv?query=${encodeURIComponent(title)}`);
  const m = data?.results?.[0];
  if (!m) { metaCache.set(key, null); return null; }
  const details = await tmdbFetch(`/tv/${m.id}`); // search results only include genre_ids (numbers), not genre names — need the full details call for that
  const meta = { tmdb_id:m.id, overview:m.overview||"", poster_url:m.poster_path?`https://image.tmdb.org/t/p/w500${m.poster_path}`:null, backdrop_url:m.backdrop_path?`https://image.tmdb.org/t/p/w1280${m.backdrop_path}`:null, rating:m.vote_average||null, status:m.status||null, genres:(details?.genres||[]).map(g=>g.name) };
  // Same fix as movies: fetch the poster via /images with an explicit English pick, since
  // poster_path on the basic details/search response can silently fall back to any language
  // per TMDB's own documented behavior (see getMovieMeta for the full explanation).
  try {
    const images = await tmdbFetch(`/tv/${m.id}/images?include_image_language=en,null`);
    const posters = images?.posters || [];
    const englishPoster = posters.find(p => p.iso_639_1 === "en") || posters[0];
    if (englishPoster?.file_path) meta.poster_url = `https://image.tmdb.org/t/p/w500${englishPoster.file_path}`;
  } catch(e) {
    // Keep whatever poster_url was already set above.
  }
  // TMDB frequently has no translated overview for less mainstream/older shows even though
  // the search itself succeeds — without this, meta.overview stays genuinely empty and the
  // show page shows no description at all, rather than falling back to English.
  if (!meta.overview) {
    try {
      const enData = await tmdbFetch(`/tv/${m.id}`, "en-US");
      if (enData?.overview) meta.overview = enData.overview;
    } catch(e) {
      // Keep the empty overview — not worth failing the whole scan over.
    }
  }
  metaCache.set(key, meta);
  return meta;
}

let isScanning = false;
// Files are discovered on disk almost instantly, but each NEW one then waits on a TMDB
// lookup before the loop moves to the next — so without this, the admin sees nothing at all
// until the first one or two finish, even though the scan already knows about all of them.
let _scanProgress = { library: null, found: 0, processed: 0 };

// Scans a single library entry (movies/tvshows/music) and returns how many new items were
// added. Extracted out of scanLibraries() so both a full server-wide scan and a scan scoped
// to just one library can share the exact same logic.
// Removes database entries whose underlying file (movie) or folder (TV show) no longer
// exists on disk — the regular scan only ever finds NEW files, it never checked whether
// previously-known ones had been deleted. Also prunes individual episodes whose file
// disappeared even if the show folder itself is still there, and cleans up watch
// history/favorites for anything removed, same as the per-library "clear and rescan" does.
async function pruneMissingMedia(lib) {
  let removed = 0;
  const shows = await dbFind(db.media, { library_id: lib.id, type: "tvshow" });
  for (const show of shows) {
    if (fs.existsSync(show.file_path)) continue;
    const eps = await dbFind(db.media, { parent_id: show._id, type: "episode" });
    const epIds = eps.map(e => e._id);
    if (epIds.length) {
      await dbRemove(db.media, { parent_id: show._id, type: "episode" }, { multi: true });
      await dbRemove(db.history, { media_id: { $in: epIds } }, { multi: true });
      await dbRemove(db.favorites, { media_id: { $in: epIds } }, { multi: true }).catch(() => {});
    }
    await dbRemove(db.media, { _id: show._id });
    await dbRemove(db.history, { media_id: show._id }, { multi: true }).catch(() => {});
    console.log(`[SCAN] Removed missing show: "${show.title}" (folder no longer exists)`);
    removed++;
  }

  const movies = await dbFind(db.media, { library_id: lib.id, type: "movie" });
  for (const m of movies) {
    if (fs.existsSync(m.file_path)) continue;
    await dbRemove(db.media, { _id: m._id });
    await dbRemove(db.history, { media_id: m._id }, { multi: true });
    await dbRemove(db.favorites, { media_id: m._id }, { multi: true }).catch(() => {});
    console.log(`[SCAN] Removed missing movie: "${m.title}" (file no longer exists)`);
    removed++;
  }

  // Episodes belonging to a show whose folder is still present, but where this specific
  // episode's own file was individually deleted.
  const episodes = await dbFind(db.media, { library_id: lib.id, type: "episode" });
  for (const ep of episodes) {
    if (fs.existsSync(ep.file_path)) continue;
    await dbRemove(db.media, { _id: ep._id });
    await dbRemove(db.history, { media_id: ep._id }, { multi: true });
    console.log(`[SCAN] Removed missing episode: "${ep.title}" (file no longer exists)`);
    removed++;
  }

  if (removed > 0) console.log(`[SCAN] Library "${lib.name}": pruned ${removed} missing item(s) no longer on disk`);
  return removed;
}

// Generates a URL-friendly slug from a title (e.g. "Bad Boys: Ride or Die" → "bad-boys-ride-or-die").
function slugify(title) {
  return (title || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip accents: é→e, å→a, etc.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "titel";
}

// Generates a slug guaranteed unique among existing movies/shows of the same type — appends
// the year, then a counter, if the plain title-based slug collides (e.g. two different films
// both titled "Dune").
async function generateUniqueSlug(title, year, type) {
  const base = slugify(title);
  const candidates = [base, year ? `${base}-${year}` : null].filter(Boolean);
  for (const candidate of candidates) {
    if (!(await dbFindOne(db.media, { type, slug: candidate }))) return candidate;
  }
  let i = 2;
  while (await dbFindOne(db.media, { type, slug: `${base}-${i}` })) i++;
  return `${base}-${i}`;
}

async function scanOneLibrary(lib) {
  let added = 0;
  if (!fs.existsSync(lib.path)) return added;
  if (lib.type === "movies") {
    const entries = fs.readdirSync(lib.path,{withFileTypes:true});
    // Report the raw count immediately — this is instant (local disk listing), unlike
    // the TMDB lookups below, so there's no reason to make the admin wait for those
    // just to find out how many files are even in the folder.
    _scanProgress = { library: lib.name, found: entries.length, processed: 0 };
    console.log(`[SCAN] Movie library "${lib.name}": found ${entries.length} entries`);
    for (const entry of entries) {
      const fullPath = path.join(lib.path,entry.name);
      let filePath = null;
      if (entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) filePath=fullPath;
      else if (entry.isDirectory()) {
        const vf = fs.readdirSync(fullPath,{withFileTypes:true}).find(f=>f.isFile()&&VIDEO_EXT.has(path.extname(f.name).toLowerCase()));
        if (vf) filePath=path.join(fullPath,vf.name);
      }
      if (!filePath) { _scanProgress.processed++; continue; }
      const id = Buffer.from(filePath).toString("base64url");
      if (await dbFindOne(db.media,{_id:id})) { _scanProgress.processed++; continue; }
      const {cleanName,year} = cleanTitle(entry.isDirectory()?entry.name:path.basename(filePath));
      const meta = await getMovieMeta(cleanName,year);
      const stat = fs.statSync(filePath);
      const movieTitle = meta?.title_en || cleanName;
      const movieYear = meta?.year || year;
      const slug = await generateUniqueSlug(movieTitle, movieYear, "movie");
      const newItem = {_id:id,library_id:lib.id,type:"movie",title:movieTitle,year:movieYear,slug,file_path:filePath,file_size:stat.size,tmdb_id:meta?.tmdb_id||null,poster_url:meta?.poster_url||null,backdrop_url:meta?.backdrop_url||null,overview:meta?.overview||null,rating:meta?.rating||null,genres:meta?.genres||[],collection_id:meta?.collection_id||null,collection_name:meta?.collection_name||null,collection_poster:meta?.collection_poster||null,collection_backdrop:meta?.collection_backdrop||null,added_at:new Date().toISOString()};
      await dbInsert(db.media, newItem);
      queueSubtitleCache(newItem); // queue Swedish subtitle pre-cache (sequential)
      added++;
      _scanProgress.processed++;
    }
  }
  if (lib.type === "tvshows") {
    const shows = fs.readdirSync(lib.path,{withFileTypes:true}).filter(f=>f.isDirectory());
    _scanProgress = { library: lib.name, found: shows.length, processed: 0 };
    console.log(`[SCAN] TV library "${lib.name}": found ${shows.length} show folders`);
    for (const show of shows) {
      const showPath=path.join(lib.path,show.name);
      const showId=Buffer.from(showPath).toString("base64url");
      if (!await dbFindOne(db.media,{_id:showId})) {
        const {cleanName}=cleanTitle(show.name);
        const meta=await getTVMeta(cleanName);
        if (!meta) console.log(`[SCAN] No TMDB match for TV show: "${cleanName}"`);
        else console.log(`[SCAN] Matched TV show: "${cleanName}" → "${meta.title || cleanName}" (TMDB ${meta.tmdb_id})`);
        const showSlug = await generateUniqueSlug(meta?.title || cleanName, null, "tvshow");
        await dbInsert(db.media,{_id:showId,library_id:lib.id,type:"tvshow",title:cleanName,slug:showSlug,file_path:showPath,tmdb_id:meta?.tmdb_id||null,poster_url:meta?.poster_url||null,backdrop_url:meta?.backdrop_url||null,overview:meta?.overview||null,rating:meta?.rating||null,status:meta?.status||null,genres:meta?.genres||[],added_at:new Date().toISOString()});
        added++;
      }
      await scanEpisodes(showPath,showId,lib.id);
      _scanProgress.processed++;
    }
    console.log(`[SCAN] TV library "${lib.name}": done`);
  }
  if (lib.type === "music") await scanMusic(lib.path,lib.id);
  if (lib.type === "movies" || lib.type === "tvshows") await pruneMissingMedia(lib);
  return added;
}

// Best-effort: lower the whole Node process's OS priority while a scan runs, so it competes
// less aggressively with an active playback for CPU — same idea as Plex's "run scan at a
// lower priority" toggle. Windows-specific (uses wmic); silently does nothing on failure,
// since this is a nice-to-have that must never be allowed to break scanning itself if it
// doesn't work in a given environment.
function setProcessPriority(priorityClass) {
  if (process.platform !== "win32") return;
  try {
    const { exec } = require("child_process");
    exec(`wmic process where processid=${process.pid} call setpriority ${priorityClass}`, () => {});
  } catch(e) {}
}

async function scanLibraries() {
  if (isScanning) return;
  isScanning = true;
  _scanProgress = { library: null, found: 0, processed: 0 };
  let added = 0;
  if (config.scan_low_priority) setProcessPriority(64); // 64 = BELOW_NORMAL_PRIORITY_CLASS
  try {
    for (const lib of (config.libraries||[])) {
      added += await scanOneLibrary(lib);
    }
  } finally {
    isScanning=false;
    if (config.scan_low_priority) setProcessPriority(32); // 32 = NORMAL_PRIORITY_CLASS — restore once the scan's done
  }
  console.log(`Scan complete: ${added} new items`);
  // Scan's done — now it's safe to let the subtitle-cache queue (FFmpeg/OCR, CPU + disk
  // heavy) start working through whatever got queued during the scan, without competing
  // with it for resources.
  if (!_subtitleCacheRunning && _subtitleCacheQueue.length > 0) {
    _subtitleCacheRunning = true;
    setTimeout(processSubtitleCacheQueue, 100);
  }
}

// Subtitle pre-cache queue - processes one film at a time to avoid CPU contention
function queueSubtitleCache(item) {
  _subtitleCacheQueue.push({ item });
  if (item.type === "episode") _subtitleCacheTotalEps++;
  else _subtitleCacheTotal++;
  // Don't start chewing through the queue (FFmpeg/OCR, CPU + disk heavy) while a scan is
  // still running — that just makes the scan itself sluggish from resource contention.
  // scanLibraries() explicitly kicks the queue off once it's actually done, further down.
  if (!_subtitleCacheRunning && !isScanning) {
    _subtitleCacheRunning = true;
    setTimeout(processSubtitleCacheQueue, 100);
  }
}

// Queues a targeted re-cache pass for ONE language across the whole library. Used when
// an admin adds a new language to the OCR allowlist (e.g. after a new user picks Norwegian) —
// much cheaper than a full re-cache since every other already-cached language is left alone.
async function queueLanguageBackfill(lang) {
  const items = await dbFind(db.media, { type: { $in: ["movie", "episode"] } });
  for (const item of items) {
    _subtitleCacheQueue.push({ item, onlyLang: lang });
    if (item.type === "episode") _subtitleCacheTotalEps++;
    else _subtitleCacheTotal++;
  }
  logSubtitle("info", null, `Riktad efterhandscachning köad för språk "${subtitleLangLabel(lang)}" – ${items.length} filer`, { lang });
  if (!_subtitleCacheRunning && !isScanning) {
    _subtitleCacheRunning = true;
    setTimeout(processSubtitleCacheQueue, 100);
  }
  return items.length;
}

async function processSubtitleCacheQueue() {
  while (_subtitleCacheQueue.length > 0) {
    // A scan takes priority — it's quick and mostly network-bound (TMDB), so there's no
    // reason to make it compete with heavy FFmpeg/OCR work for CPU and disk. Just wait here
    // between items (never interrupting one already in progress) until the scan is done,
    // then carry on exactly where the queue left off — no manual restart needed either way.
    while (isScanning) {
      await new Promise(r => setTimeout(r, 2000));
    }

    const entry = _subtitleCacheQueue.shift();

    try {
      await preCacheSubtitles(entry.item, { onlyLang: entry.onlyLang || null });
    } catch(e) {
      console.log("[SUBTITLES] Queue error:", e.message);
    }

    // Small pause between extractions to avoid CPU contention
    await new Promise(r => setTimeout(r, 2000));
  }
  _subtitleCacheRunning = false;
}

// Convert bitmap subtitle (PGS/VOBSUB) to SRT using PgsToSrt + Tesseract, for one specific language track
async function convertPgsTosrt(item, subIdx, cacheFile, targetLang) {
  const { execFile } = require("child_process");
  const supFile = cacheFile.replace(".srt", ".sup");
  const tessLang = TESSERACT_LANG_MAP[targetLang] || "eng";

  // Safety net: make sure the language pack is actually there before we bother extracting
  // the .sup file at all — covers languages added before auto-download existed, or via any
  // path other than the OCR-languages endpoint (e.g. "cache all languages" mode).
  const tessCheck = await ensureTesseractLanguage(tessLang);
  if (!tessCheck.ok) {
    logSubtitle("error", item, `Kan inte OCR-konvertera spår ${subIdx} (${targetLang}) – Tesseract-språkdata saknas och kunde inte hämtas automatiskt`, { subIdx, targetLang, tessLang, error: tessCheck.error });
    return false;
  }

  let ffmpegStderr = "", pgsStdout = "", pgsStderr = "";
  try {
    // Step 1: Extract .sup file with FFmpeg
    await new Promise((resolve, reject) => {
      const proc = execFile(getFfmpegPath(), [
        "-y", "-i", item.file_path,
        "-map", "0:s:" + subIdx,
        "-c:s", "copy",
        supFile
      ], { timeout: 300000, windowsHide: true }, (err) => {
        if (err) reject(err); else resolve();
      });
      deprioritizeBackgroundProcess(proc);
      proc.stderr?.on("data", d => { ffmpegStderr += d.toString(); if (ffmpegStderr.length > 4000) ffmpegStderr = ffmpegStderr.slice(-4000); });
    });

    // Sanity check: an empty/near-empty .sup means there's nothing for PgsToSrt to read —
    // catch this here with a clear message instead of a confusing "no output" a step later.
    let supSize = 0;
    try { supSize = fs.statSync(supFile).size; } catch {}
    if (supSize < 100) {
      logSubtitle("error", item, `Bildbaserat spår ${subIdx} (${targetLang}) gav en tom/nästan tom .sup-fil (${supSize} bytes) – troligen ett problem med själva spåret i filen, inte med OCR:en`, { subIdx, targetLang, supSize, ffmpegStderr: ffmpegStderr.slice(-1000) });
      try { fs.unlinkSync(supFile); } catch {}
      return false;
    }

    // Step 2: Convert .sup to .srt using PgsToSrt
    await new Promise((resolve, reject) => {
      const proc = execFile(PGSTOSRT_EXE, [
        "--input", supFile,
        "--output", cacheFile,
        "--tesseractdata", TESSDATA_DIR,
        "--tesseractlanguage", tessLang
      ], { timeout: 600000, windowsHide: true }, (err) => {
        if (err) reject(err); else resolve();
      });
      deprioritizeBackgroundProcess(proc);
      proc.stdout?.on("data", d => { pgsStdout += d.toString(); if (pgsStdout.length > 4000) pgsStdout = pgsStdout.slice(-4000); });
      proc.stderr?.on("data", d => { pgsStderr += d.toString(); if (pgsStderr.length > 4000) pgsStderr = pgsStderr.slice(-4000); });
    });

    // Cleanup .sup file
    try { fs.unlinkSync(supFile); } catch {}

    if (fs.existsSync(cacheFile)) return true;
    logSubtitle("error", item, `PgsToSrt gav ingen utfil för spår ${subIdx} (${targetLang})`, {
      subIdx, targetLang, tessLang, supSize,
      pgsStdout: pgsStdout.trim().slice(-1000) || null,
      pgsStderr: pgsStderr.trim().slice(-1000) || null
    });
    return false;
  } catch(e) {
    logSubtitle("error", item, `PgsToSrt-konvertering misslyckades för spår ${subIdx} (${targetLang})`, {
      subIdx, targetLang, tessLang,
      error: e.message?.split("\n")[0],
      ffmpegStderr: ffmpegStderr.trim().slice(-1000) || null,
      pgsStdout: pgsStdout.trim().slice(-1000) || null,
      pgsStderr: pgsStderr.trim().slice(-1000) || null
    });
    try { fs.unlinkSync(supFile); } catch {}
    try { fs.unlinkSync(cacheFile); } catch {}
    return false;
  }
}

// Extract one text-based embedded subtitle stream directly (no OCR needed)
// Lowers a background subtitle-processing child process's OS priority (Windows process
// priority class / POSIX nice value) so it yields CPU to anything more time-sensitive running
// at the same time — most importantly, active video transcoding for someone actually
// watching right now. This is pure background work with no real-time deadline; it can afford
// to run slower rather than compete for CPU on weaker hardware.
function deprioritizeBackgroundProcess(proc) {
  try {
    const os = require("os");
    if (proc?.pid) os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch(e) {
    // Not fatal if this fails (e.g. process already exited) — just means it runs at normal
    // priority instead, no different from before this existed.
  }
}

function extractTextSubtitle(item, subIdx, cacheFile) {
  return new Promise((resolve) => {
    const { execFile } = require("child_process");
    const tempFile = cacheFile.replace(".srt", ".part.srt");
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch {}
    const proc = execFile(getFfmpegPath(), [
      "-y", "-i", item.file_path,
      "-map", "0:s:" + subIdx,
      "-f", "srt", "-c:s", "srt",
      tempFile
    ], { timeout: 300000, windowsHide: true }, (err) => {
      if (err) {
        try { fs.unlinkSync(tempFile); } catch {}
        resolve({ ok: false, error: err.message || String(err) });
        return;
      }
      try {
        fs.renameSync(tempFile, cacheFile);
        resolve({ ok: true });
      } catch(e) {
        resolve({ ok: false, error: e.message });
      }
    });
    deprioritizeBackgroundProcess(proc);
  });
}

// Pre-cache ALL subtitle languages for a media file (runs sequentially via queue,
// one file at a time, so a big library never competes with playback/transcoding).
// - Text-based embedded tracks: cached for every language found (cheap, no OCR)
// - Bitmap (PGS/VOBSUB) tracks: OCR-converted for every language found (slow, but
//   only ever needs to happen once per file since results are cached on disk)
// - External .srt files next to the video: cached per detected language suffix
async function preCacheSubtitles(item, opts) {
  const onlyLang = opts?.onlyLang || null;
  // If this is a targeted backfill for one language, that language is explicitly wanted,
  // so OCR runs for it regardless of the general allowlist. Otherwise use the admin's list.
  const ocrLangs = onlyLang ? new Set([onlyLang]) : getEffectiveOcrLanguages(); // null = allow all
  const startedAt = Date.now();
  const cacheDir = path.join(DATA_DIR, "subtitle-cache");
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  const cachedLangs = new Set();
  let hadGatedSkip = false;   // a bitmap track exists but is intentionally not OCR'd (allowlist or missing tool)
  let hadRealFailure = false; // something actually went wrong (extraction/conversion error)

  // 1. Embedded subtitle streams via ffprobe
  let streams = [];
  try {
    const ffprobePath = getFfmpegPath().replace("ffmpeg.exe", "ffprobe.exe");
    const { execFile } = require("child_process");
    streams = await new Promise((resolve) => {
      execFile(ffprobePath, [
        "-v", "quiet", "-analyzeduration", "100M", "-probesize", "100M",
        "-print_format", "json", "-show_streams",
        "-select_streams", "s", item.file_path
      ], { timeout: 30000, windowsHide: true }, (err, stdout) => {
        if (err) { logSubtitle("warn", item, "ffprobe misslyckades – hoppar över inbäddade spår", { error: err.message?.split("\n")[0] }); return resolve([]); }
        try { resolve(JSON.parse(stdout).streams || []); }
        catch(e) { logSubtitle("warn", item, "Kunde inte tolka ffprobe-resultatet", { error: e.message }); resolve([]); }
      });
    });
  } catch(e) {
    logSubtitle("error", item, "Oväntat fel vid inläsning av undertextspår", { error: e.message });
  }

  for (let subIdx = 0; subIdx < streams.length; subIdx++) {
    const s = streams[subIdx];
    const rawLang = s.tags?.language || s.tags?.LANGUAGE || "und";
    const lang = normalizeLangCode(rawLang);
    if (onlyLang && lang !== onlyLang) continue; // targeted backfill: skip everything else
    const codec = s.codec_name || "";
    const cacheFile = path.join(cacheDir, `${shortMediaId(item._id)}_${subIdx}_${lang}.srt`);
    if (fs.existsSync(cacheFile)) { cachedLangs.add(lang); continue; }

    if (UNSUPPORTED_BITMAP_CODECS.includes(codec)) {
      // Not a failure — a genuine, permanent limitation of the current tool (PgsToSrt only
      // reads PGS/.sup, not VobSub-style formats). Logged once, informationally, so it
      // doesn't look like a mysterious repeated crash.
      logSubtitle("info", item, `Bildbaserat spår (${subtitleLangLabel(lang)}, ${codec}) hoppas över – DVD/VobSub-format stöds inte av nuvarande OCR-verktyg (bara Blu-ray/PGS)`, { subIdx, lang, codec });
      hadGatedSkip = true;
      continue;
    }

    if (bitmapCodecs.includes(codec)) {
      if (ocrLangs !== null && !ocrLangs.has(lang)) {
        logSubtitle("info", item, `Bildbaserat spår (${subtitleLangLabel(lang)}) hoppas över – inte i språklistan just nu`, { subIdx, lang, codec });
        hadGatedSkip = true;
        continue;
      }
      if (!isPgsToSrtInstalled()) {
        logSubtitle("warn", item, `Bildbaserat spår (${subtitleLangLabel(lang)}) hoppas över – PgsToSrt är inte installerat`, { subIdx, lang, codec });
        hadGatedSkip = true;
        continue;
      }
      const t0 = Date.now();
      const ok = await convertPgsTosrt(item, subIdx, cacheFile, lang);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (ok) {
        cachedLangs.add(lang);
        logSubtitle("info", item, `Bildbaserad undertext konverterad – ${subtitleLangLabel(lang)} på ${secs}s`, { subIdx, lang });
      } else {
        logSubtitle("error", item, `Kunde inte konvertera bildbaserad undertext – ${subtitleLangLabel(lang)}`, { subIdx, lang, codec });
        hadRealFailure = true;
      }
      continue;
    }

    // Text-based track: cheap PER LANGUAGE, but "cheap x thousands of files x dozens of
    // language tracks each" adds up to real hours on a big library — so this now respects
    // the same language allowlist as bitmap OCR, not just bitmap. Skipped the same way.
    if (ocrLangs !== null && !ocrLangs.has(lang)) {
      logSubtitle("info", item, `Textbaserat spår (${subtitleLangLabel(lang)}) hoppas över – inte i språklistan just nu`, { subIdx, lang, codec });
      hadGatedSkip = true;
      continue;
    }
    const t0 = Date.now();
    const result = await extractTextSubtitle(item, subIdx, cacheFile);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (result.ok) {
      cachedLangs.add(lang);
      logSubtitle("info", item, `Textbaserad undertext cachad – ${subtitleLangLabel(lang)} på ${secs}s`, { subIdx, lang });
    } else {
      const errMsg = result.error || "";
      if (errMsg.includes("bitmap to bitmap") || errMsg.includes("only possible from text")) {
        // ffprobe said "text" but ffmpeg disagrees – treat as bitmap after all
        if (ocrLangs !== null && !ocrLangs.has(lang)) {
          logSubtitle("info", item, `Bildbaserat spår (${subtitleLangLabel(lang)}, upptäckt sent) hoppas över – inte i språklistan just nu`, { subIdx, lang });
          hadGatedSkip = true;
        } else if (isPgsToSrtInstalled()) {
          const t1 = Date.now();
          const ok = await convertPgsTosrt(item, subIdx, cacheFile, lang);
          const secs2 = ((Date.now() - t1) / 1000).toFixed(1);
          if (ok) {
            cachedLangs.add(lang);
            logSubtitle("info", item, `Bildbaserad undertext (upptäckt sent) konverterad – ${subtitleLangLabel(lang)} på ${secs2}s`, { subIdx, lang });
          } else {
            logSubtitle("error", item, `Kunde inte konvertera sent upptäckt bildbaserad undertext – ${subtitleLangLabel(lang)}`, { subIdx, lang });
            hadRealFailure = true;
          }
        } else {
          logSubtitle("warn", item, `Bildbaserat spår (${subtitleLangLabel(lang)}) hoppas över – PgsToSrt är inte installerat`, { subIdx, lang, codec });
          hadGatedSkip = true;
        }
      } else {
        logSubtitle("error", item, `Kunde inte extrahera textbaserad undertext – ${subtitleLangLabel(lang)}`, { subIdx, lang, codec, error: errMsg.slice(-800) });
        hadRealFailure = true;
      }
    }
  }

  // 2. External .srt files next to the video file (movie.srt, movie.sv.srt, movie.no.srt, ...)
  try {
    const videoDir = path.dirname(item.file_path);
    const videoBase = path.basename(item.file_path, path.extname(item.file_path)).toLowerCase();
    const shortId = require("crypto").createHash("md5").update(item._id).digest("hex");
    const localFiles = fs.readdirSync(videoDir).filter(f => f.toLowerCase().endsWith(".srt"));
    const langsFoundOnDisk = new Set();
    for (const file of localFiles) {
      const fileLower = file.toLowerCase();
      if (!fileLower.startsWith(videoBase)) continue; // only files that clearly belong to this video
      const suffix = fileLower.slice(videoBase.length).replace(/\.srt$/, "").replace(/^\./, "");
      const lang = suffix ? normalizeLangCode(suffix) : "und";
      langsFoundOnDisk.add(lang);
      if (onlyLang && lang !== onlyLang) continue; // targeted backfill: skip everything else
      if (!onlyLang && ocrLangs !== null && !ocrLangs.has(lang)) {
        logSubtitle("info", item, `Extern undertextfil (${subtitleLangLabel(lang)}) hoppas över – inte i språklistan just nu`, { file, lang });
        hadGatedSkip = true;
        continue;
      }
      const extCacheFile = path.join(cacheDir, `${shortId}_ext_${lang}.srt`);
      if (fs.existsSync(extCacheFile)) { cachedLangs.add(lang); continue; }
      try {
        fs.copyFileSync(path.join(videoDir, file), extCacheFile);
        cachedLangs.add(lang);
        logSubtitle("info", item, `Extern undertextfil hittad och cachad – ${subtitleLangLabel(lang)}`, { file });
      } catch(e) {
        logSubtitle("error", item, `Kunde inte kopiera extern undertextfil – ${subtitleLangLabel(lang)}`, { file, error: e.message });
      }
    }

    // Clean up orphaned external cache entries: if a cached "{id}_ext_{lang}.srt" no longer
    // has a matching .srt file on disk (e.g. the source file was renamed or removed), the
    // cache entry is stale and just clutters the language list forever otherwise. Skipped
    // during a targeted single-language backfill, since that only ever looks at one language.
    if (!onlyLang) {
      try {
        const existingExtCache = fs.readdirSync(cacheDir).filter(f => f.startsWith(`${shortId}_ext_`) && f.endsWith(".srt"));
        for (const cachedFile of existingExtCache) {
          const m = cachedFile.match(/_ext_([a-z0-9]+)\.srt$/);
          const cachedLang = m ? m[1] : null;
          if (cachedLang && !langsFoundOnDisk.has(cachedLang)) {
            try {
              fs.unlinkSync(path.join(cacheDir, cachedFile));
              logSubtitle("info", item, `Övergiven undertextcache borttagen – ${subtitleLangLabel(cachedLang)} (källfilen finns inte längre / har döpts om)`, { cachedFile });
            } catch(e) {
              logSubtitle("warn", item, `Kunde inte ta bort övergiven undertextcache – ${subtitleLangLabel(cachedLang)}`, { cachedFile, error: e.message });
            }
          }
        }
      } catch(e) {
        logSubtitle("warn", item, "Kunde inte kontrollera övergivna undertextcachefiler", { error: e.message });
      }
    }
  } catch(e) {
    logSubtitle("warn", item, "Kunde inte söka efter externa undertextfiler", { error: e.message });
  }

  const totalSecs = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (cachedLangs.size > 0) {
    _subtitleCacheDone++;
    const langList = [...cachedLangs];
    if (langList.includes("swe")) { if (item.type === "episode") _subtitleCacheWithSweEps++; else _subtitleCacheWithSwe++; }
    if (langList.includes("eng")) { if (item.type === "episode") _subtitleCacheWithEngEps++; else _subtitleCacheWithEng++; }
    // Merge with whatever was already recorded, so a targeted backfill (or a second pass)
    // doesn't wipe out languages found in an earlier pass.
    dbFindOne(db.media, { _id: item._id }).then(fresh => {
      const merged = Array.from(new Set([...(fresh?.cached_subtitle_langs || []), ...langList]));
      return dbUpdate(db.media, { _id: item._id }, { $set: { cached_subtitle_langs: merged, cached_subtitle_lang: merged[0] } });
    })
      .then(async () => {
        // Also roll this up onto the parent SHOW, so "which shows have Norwegian subtitles
        // somewhere" can be answered with a simple, fast filter at the show-list level,
        // instead of having to open every show/season to check episode-by-episode.
        // Recomputed fresh from ALL of the show's episodes each time (not just merged
        // incrementally) so it can never drift out of sync with what's actually cached.
        if (item.type === "episode" && item.parent_id) {
          try {
            const allEpisodes = await dbFind(db.media, { type: "episode", parent_id: item.parent_id });
            const showLangs = Array.from(new Set(allEpisodes.flatMap(e => e.cached_subtitle_langs || [])));
            await dbUpdate(db.media, { _id: item.parent_id }, { $set: { episode_subtitle_langs: showLangs } });
          } catch(e) {
            logSubtitle("warn", item, "Kunde inte uppdatera seriens sammanställda språklista", { error: e.message });
          }
        }
      })
      .then(() => logSubtitle("info", item, `Klar – ${langList.length} språk cachade nu (${langList.map(subtitleLangLabel).join(", ")}) på totalt ${totalSecs}s`))
      .catch(e => logSubtitle("error", item, "Kunde inte spara cachade språk i databasen", { error: e.message }));
  } else if (onlyLang) {
    // A targeted backfill simply finding nothing for that one language isn't an error.
  } else if (hadRealFailure) {
    // Something genuinely went wrong (extraction/conversion error) — worth a look in the log.
    _subtitleCacheErrors++;
    if (item.type === "episode") _subtitleCacheFailedEps++; else _subtitleCacheFailed++;
    logSubtitle("warn", item, "Inga undertexter kunde cachas för den här filen (se tidigare rader för orsak)");
  } else if (hadGatedSkip) {
    // Bitmap subtitle(s) exist but are intentionally not OCR'd yet (allowlist or missing tool) —
    // expected behavior, not a failure. Tracked separately so the dashboard doesn't cry wolf.
    if (item.type === "episode") _subtitleCacheGatedEps++; else _subtitleCacheGated++;
  } else {
    // This file simply has no subtitles at all (no embedded tracks, no external files) —
    // completely normal for a lot of media, not worth flagging as an error either.
    if (item.type === "episode") _subtitleCacheNoSubsEps++; else _subtitleCacheNoSubs++;
  }
}

// Search OpenSubtitles for a subtitle and cache it
async function fetchOpenSubtitlesForItem(item) {
  if (!config.opensubtitles_api_key) return;
  const cacheDir = path.join(DATA_DIR, "subtitle-cache");
  const cacheFile = path.join(cacheDir, item._id + "_os.srt");
  if (fs.existsSync(cacheFile)) return; // already cached
  try {
    // Try hash first
    let results = [];
    try {
      const hash = await calcOpenSubtitlesHash(item.file_path);
      const hashData = await new Promise((resolve, reject) => {
        const params = new URLSearchParams({ languages: "sv", moviehash: hash });
        https.get({
          hostname: "api.opensubtitles.com",
          path: "/api/v1/subtitles?" + params.toString(),
          headers: { "Api-Key": config.opensubtitles_api_key, "User-Agent": "StreamVault/" + STREAMVAULT_VERSION, "Accept": "application/json" }
        }, r => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ try{resolve(JSON.parse(d))}catch{reject()} }); }).on("error", reject);
      });
      if (hashData.data?.length) results = hashData.data;
    } catch(e) {}

    // Fallback to name search
    if (!results.length) {
      const query = item.type === "episode" ?
        `${item.title} S${String(item.season).padStart(2,"0")}E${String(item.episode).padStart(2,"0")}` :
        item.title;
      const nameData = await new Promise((resolve, reject) => {
        const params = new URLSearchParams({ languages: "sv", query });
        https.get({
          hostname: "api.opensubtitles.com",
          path: "/api/v1/subtitles?" + params.toString(),
          headers: { "Api-Key": config.opensubtitles_api_key, "User-Agent": "StreamVault/" + STREAMVAULT_VERSION, "Accept": "application/json" }
        }, r => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ try{resolve(JSON.parse(d))}catch{reject()} }); }).on("error", reject);
      });
      if (nameData.data?.length) results = nameData.data;
    }

    if (!results.length) return;
    // TODO: auto-download best match - for now just log that we found results
    console.log(`[SUBTITLES] OpenSubtitles found ${results.length} results for: ${item.title}`);
  } catch(e) {}
}

// Fetch TMDB episode info in background after scan
async function enrichEpisodeMeta(episode) {
  if (!config.tmdb_api_key) return;
  const show = await dbFindOne(db.media, { _id: episode.parent_id });
  if (!show || !show.tmdb_id) {
    console.log(`[ENRICH] Skipping S${episode.season}E${episode.episode} - no show TMDB ID`);
    return;
  }
  if (episode.season === 0 || episode.episode === 0) return;
  try {
    // Always fetch the episode name in English, same "titel alltid engelsk" policy as movies —
    // this previously used the server's default language (tmdbFetch's fallback), which is
    // why episode names showed up in Swedish on a Swedish-default server.
    const data = await tmdbFetch(`/tv/${show.tmdb_id}/season/${episode.season}/episode/${episode.episode}?`, "en-US");
    if (!data || !data.name) {
      console.log(`[ENRICH] No data for ${show.title} S${episode.season}E${episode.episode}`);
      return;
    }
    await dbUpdate(db.media, { _id: episode._id }, {
      $set: {
        title: data.name,
        overview: data.overview || null,
        rating: data.vote_average || null,
        still_url: data.still_path ? `https://image.tmdb.org/t/p/w300${data.still_path}` : null
      }
    });
    console.log(`[ENRICH] ${show.title} S${episode.season}E${episode.episode} → "${data.name}"`);
  } catch(e) {
    console.log(`[ENRICH] Error for ${show.title} S${episode.season}E${episode.episode}:`, e.message);
  }
}

// Queue for episode enrichment
const _episodeEnrichQueue = [];
let _episodeEnrichRunning = false;

function queueEpisodeEnrich(episode) {
  _episodeEnrichQueue.push(episode);
  if (!_episodeEnrichRunning) processEpisodeEnrichQueue();
}

async function processEpisodeEnrichQueue() {
  if (_episodeEnrichRunning) return;
  _episodeEnrichRunning = true;
  while (_episodeEnrichQueue.length > 0) {
    const ep = _episodeEnrichQueue.shift();
    await enrichEpisodeMeta(ep);
    await new Promise(r => setTimeout(r, 300)); // small delay between API calls
  }
  _episodeEnrichRunning = false;
}

async function scanEpisodes(showPath,showId,libId,depth=0) {
  if (!fs.existsSync(showPath)) return;
  let newEpisodes = 0;
  let skipped = 0;
  for (const entry of fs.readdirSync(showPath,{withFileTypes:true})) {
    const fullPath=path.join(showPath,entry.name);
    if (entry.isDirectory()) {
      await scanEpisodes(fullPath,showId,libId,depth+1);
      continue;
    }
    if (!VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    const id=Buffer.from(fullPath).toString("base64url");
    if (await dbFindOne(db.media,{_id:id})) { skipped++; continue; }
    // Try multiple naming conventions - order matters, most specific first!
    const em = entry.name.match(/[Ss](\d+)[\s._-]?[Ee](\d+)/) ||   // S01E01, S01 E01, S01-E01
               entry.name.match(/[Ss](\d+)[xX](\d+)/) ||              // S01x01
               entry.name.match(/(?<![\d])(\d+)[xX](\d+)(?![\d])/) || // 1x01, 2x01
               entry.name.match(/\.([1-9])(\d{2})\.|[-_\s]([1-9])(\d{2})[-_\s.]/); // .301. or -301-
    // Last resort: a bare leading episode number with NO season marker at all — common for
    // older/classic shows (e.g. some anime) released as one continuous run rather than
    // separate seasons, e.g. "13.Candy Candy episode title.mkv". Defaults to season 1, since
    // that's the only sensible assumption when the source material itself has no seasons.
    const flatEm = !em ? entry.name.match(/^(\d{1,3})[.\s_-]/) : null;
    if (!em && !flatEm) console.log(`[SCAN] Warning: could not detect season/episode from "${entry.name}"`);
    const emSeason = em ? parseInt(em[1] || em[3]) : (flatEm ? 1 : 0);
    const emEpisode = em ? parseInt(em[2] || em[4]) : (flatEm ? parseInt(flatEm[1]) : 0);
    const newEp = {_id:id,library_id:libId,type:"episode",title:path.parse(entry.name).name,file_path:fullPath,file_size:fs.statSync(fullPath).size,parent_id:showId,season:emSeason,episode:emEpisode,added_at:new Date().toISOString()};
    await dbInsert(db.media, newEp);
    queueEpisodeEnrich(newEp); // fetch episode title from TMDB in background
    queueSubtitleCache(newEp); // queue subtitle pre-cache (external SRT + OpenSubtitles)
    newEpisodes++;
  }
  if (depth === 0 && newEpisodes > 0) console.log(`[SCAN] Added ${newEpisodes} new episodes from "${path.basename(showPath)}"`);
}

async function scanMusic(rootDir, libId) {
  if (!fs.existsSync(rootDir)) return;
  // Scan root level folders only
  for (const entry of fs.readdirSync(rootDir, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const folderPath = path.join(rootDir, entry.name);
    const folderId = Buffer.from(folderPath).toString("base64url");
    // Check if this folder has subfolders (= artist with albums) or just files (= standalone album/mix)
    const subEntries = fs.readdirSync(folderPath, {withFileTypes: true});
    const hasSubFolders = subEntries.some(e => e.isDirectory());
    if (hasSubFolders) {
      // Artist folder with album subfolders
      if (!await dbFindOne(db.media, {_id: folderId})) {
        await dbInsert(db.media, {_id: folderId, library_id: libId, type: "music", title: entry.name,
          file_path: folderPath, file_size: 0, extra_data: JSON.stringify({isArtist: true}), added_at: new Date().toISOString()});
      }
      // Scan album subfolders
      for (const albumEntry of subEntries.filter(e => e.isDirectory())) {
        const albumPath = path.join(folderPath, albumEntry.name);
        const albumId = Buffer.from(albumPath).toString("base64url");
        if (!await dbFindOne(db.media, {_id: albumId})) {
          await dbInsert(db.media, {_id: albumId, library_id: libId, type: "music", title: albumEntry.name,
            file_path: albumPath, file_size: 0, extra_data: JSON.stringify({isAlbum: true, artistId: folderId, artistName: entry.name}), added_at: new Date().toISOString()});
        }
        // Scan tracks in album
        for (const trackEntry of fs.readdirSync(albumPath, {withFileTypes: true}).filter(e => e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase()))) {
          const trackPath = path.join(albumPath, trackEntry.name);
          const trackId = Buffer.from(trackPath).toString("base64url");
          if (await dbFindOne(db.media, {_id: trackId})) continue;
          const fileTitle = path.parse(trackEntry.name).name;
          let title = fileTitle;
          if (musicMetadata) { try { const m = await musicMetadata.parseFile(trackPath, {duration:false}); if (m.common.title) title = m.common.title; } catch {} }
          await dbInsert(db.media, {_id: trackId, library_id: libId, type: "music", title,
            file_path: trackPath, file_size: fs.statSync(trackPath).size, extra_data: JSON.stringify({isTrack: true, albumId, albumName: albumEntry.name, artistName: entry.name, fileName: fileTitle}), added_at: new Date().toISOString()});
        }
      }
    } else {
      // Standalone folder with just files (mix/compilation)
      if (!await dbFindOne(db.media, {_id: folderId})) {
        await dbInsert(db.media, {_id: folderId, library_id: libId, type: "music", title: entry.name,
          file_path: folderPath, file_size: 0, extra_data: JSON.stringify({isAlbum: true, artistName: entry.name}), added_at: new Date().toISOString()});
      }
      for (const trackEntry of subEntries.filter(e => e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase()))) {
        const trackPath = path.join(folderPath, trackEntry.name);
        const trackId = Buffer.from(trackPath).toString("base64url");
        if (await dbFindOne(db.media, {_id: trackId})) continue;
        const fileTitle = path.parse(trackEntry.name).name;
        let title = fileTitle;
        if (musicMetadata) { try { const m = await musicMetadata.parseFile(trackPath, {duration:false}); if (m.common.title) title = m.common.title; } catch {} }
        await dbInsert(db.media, {_id: trackId, library_id: libId, type: "music", title,
          file_path: trackPath, file_size: fs.statSync(trackPath).size, extra_data: JSON.stringify({isTrack: true, albumId: folderId, albumName: entry.name, artistName: entry.name, fileName: fileTitle}), added_at: new Date().toISOString()});
      }
    }
  }
}

const safe = i => ({ ...i, file_path: undefined, _id: undefined, id: i._id });

app.get("/api/media", requireAuth, async (req, res) => {
  try {
    const {type,library_id,search,subLang,limit=200} = req.query;
    const query={};
    if (type) query.type=type;
    if (library_id) {
      if (!userHasLibraryAccess(req.user, library_id)) return res.json([]);
      query.library_id=library_id;
    } else if (req.user.role !== "admin" && req.user.library_ids?.length > 0) {
      query.library_id = { $in: req.user.library_ids };
    }
    if (search) query.title=new RegExp(search,"i");
    // Filter to only items with a cached subtitle in this language — lets someone answer
    // "which of my movies actually have Norwegian subtitles" instead of just knowing a total
    // count in Settings with no way to see which titles make it up.
    if (subLang) query.cached_subtitle_langs = subLang;
    const items = await dbFind(db.media,query);
    const sorted = items.sort((a,b)=>(a.title||"").localeCompare(b.title||"")).slice(0,parseInt(limit)).map(safe);
    // Attach progress (position/completed) for each item
    const history = await dbFind(db.history, { user_id: req.user._id });
    const progressMap = {};
    for (const h of history) progressMap[h.media_id] = h;
    const withProgress = sorted.map(item => {
      const p = progressMap[item.id];
      return p ? { ...item, position: p.position, duration: p.duration, completed: p.completed } : item;
    });
    res.json({items: withProgress, total: items.length});
  } catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/libraries/:id/contents", requireAuth, async (req, res) => {
  try {
    const lib=(config.libraries||[]).find(l=>l.id===req.params.id);
    if (!lib) return res.status(404).json({error:"Bibliotek hittades inte"});
    if (!userHasLibraryAccess(req.user, req.params.id)) return res.json({library:lib,items:[],count:0});
    const items = await dbFind(db.media,{library_id:req.params.id,type:{$in:["movie","tvshow","music"]}});
    res.json({library:lib,items:items.sort((a,b)=>(a.title||"").localeCompare(b.title||"")).map(safe),count:items.length});
  } catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/media/:id", requireAuth, async (req, res) => {
  try {
    const item = await dbFindOne(db.media,{_id:req.params.id});
    if (!item) return res.status(404).json({error:"Hittades inte"});
    const episodes = item.type==="tvshow"
      ? (await dbFind(db.media,{parent_id:item._id})).sort((a,b)=>a.season-b.season||a.episode-b.episode).map(safe)
      : [];
    res.json({...safe(item),episodes});
  } catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/media/:id/progress", requireAuth, async (req, res) => {
  const p = await dbFindOne(db.history,{user_id:req.user._id,media_id:req.params.id});
  res.json(p||{position:0,completed:0});
});

app.post("/api/media/:id/progress", requireAuth, async (req, res) => {
  const {position,duration,completed=0} = req.body;
  const existing = await dbFindOne(db.history,{user_id:req.user._id,media_id:req.params.id});
  if (existing) await dbUpdate(db.history,{_id:existing._id},{$set:{position,duration,completed:completed?1:0,watched_at:new Date().toISOString()}});
  else await dbInsert(db.history,{_id:uuidv4(),user_id:req.user._id,media_id:req.params.id,position:position||0,duration:duration||0,completed:completed?1:0,watched_at:new Date().toISOString()});

  // Once genuine watch progress is seen (60+ seconds in — long enough to rule out someone
  // just pressing play to test something and immediately backing out), mark the most recent
  // matching playback-log entry as "confirmed". The analytics dashboard can then distinguish
  // "play was pressed" from "this was actually watched", without needing a full session-id
  // system tying an exact play action to its later heartbeats.
  if ((position || 0) > 60) {
    dbFind(db.playbackLog, { user_id: req.user._id, media_id: req.params.id, confirmed: { $ne: true } })
      .then(entries => {
        if (!entries.length) return;
        const mostRecent = entries.sort((a, b) => new Date(b.at) - new Date(a.at))[0];
        return dbUpdate(db.playbackLog, { _id: mostRecent._id }, { $set: { confirmed: true } });
      })
      .catch(() => {}); // best-effort — never let this affect the actual resume-position save
  }

  // Live activity: refresh (or create) this session's heartbeat entry, unless playback
  // just completed — a finished item shouldn't linger in the "currently watching" list.
  const sessionKey = `${req.user._id}:${req.params.id}`;
  const isNewSession = !_activeSessions.has(sessionKey);
  if (completed) {
    _activeSessions.delete(sessionKey);
    fireUserWebhook(req.user, "stopped", { title: (await dbFindOne(db.media, { _id: req.params.id }))?.title });
  } else {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    _activeSessions.set(sessionKey, {
      userId: req.user._id,
      username: req.user.username,
      mediaId: req.params.id,
      title: item?.title || "Okänd",
      posterUrl: item?.poster_url || null,
      type: item?.type || "unknown",
      position: position || 0,
      duration: duration || 0,
      // Inferred, not client-reported: if this file currently has an active FFmpeg
      // transcode running, this session is (almost certainly) watching via DASH.
      method: activeDashTranscodes.has(req.params.id) ? "dash" : "direct",
      ip: req.ip,
      device: describeClient(req.headers["user-agent"]),
      startedAt: _activeSessions.get(sessionKey)?.startedAt || Date.now(),
      lastHeartbeat: Date.now()
    });
    if (isNewSession) fireUserWebhook(req.user, "started", { title: item?.title });
  }

  res.json({ok:true});
});

app.get("/api/continue-watching", requireAuth, async (req, res) => {
  try {
    const history = await dbFind(db.history,{user_id:req.user._id,completed:0,position:{$gt:30}});
    history.sort((a,b)=>new Date(b.watched_at)-new Date(a.watched_at));
    const maxWeeks = config.continue_watching_max_weeks ?? 16;
    const maxItems = config.continue_watching_max_items ?? 20;
    const cutoff = maxWeeks > 0 ? new Date(Date.now() - maxWeeks * 7 * 86400000) : null;
    const items=[];
    for (const h of history) {
      if (items.length >= maxItems) break;
      const item = await dbFindOne(db.media,{_id:h.media_id});
      if (!item) continue;
      // Normal rule: drop anything not watched in the last `maxWeeks`. Exception (approximates
      // Plex's "include season premieres" — surfacing a show even after a long gap if a new
      // episode/season has actually shown up): skip the cutoff if the item itself was added
      // to the library recently, since that's inherently fresh content worth resurfacing
      // regardless of how long ago the person last watched something from this show.
      const recentlyAdded = item.added_at && new Date(item.added_at) > (cutoff || new Date(0));
      if (cutoff && new Date(h.watched_at) < cutoff && !recentlyAdded) continue;
      items.push({...safe(item),position:h.position,duration:h.duration});
    }
    res.json(items);
  } catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/recently-added", requireAuth, async (req, res) => {
  try {
    const { type } = req.query;
    const query = type ? { type } : { type: { $in: ["movie","tvshow","music"] } };
    // Filter by user library access
    if (req.user.role !== "admin" && req.user.library_ids?.length > 0) {
      query.library_id = { $in: req.user.library_ids };
    }
    const items = await dbFind(db.media, query);
    res.json(items.sort((a,b)=>new Date(b.added_at)-new Date(a.added_at)).slice(0,24).map(safe));
  } catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/ongoing-shows", requireAuth, async (req, res) => {
  try {
    // Shows that are marked as ongoing (no end date or status = ongoing)
    const shows = await dbFind(db.media, { type: "tvshow" });
    const ongoing = shows.filter(s => s.status === "ongoing" || s.status === "Returning Series" || (!s.ended && s.tmdb_id));
    res.json(ongoing.sort((a,b)=>new Date(b.added_at)-new Date(a.added_at)).slice(0,24).map(safe));
  } catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/favorites", requireAuth, async (req, res) => {
  try {
    const favs = await dbFind(db.favorites,{user_id:req.user._id});
    const items=[];
    for (const f of favs) { const item=await dbFindOne(db.media,{_id:f.media_id}); if(item) items.push(safe(item)); }
    res.json(items);
  } catch(e){res.status(500).json({error:e.message});}
});

// Whether the current user has already liked this title — used so the button shows its
// correct state on load instead of always starting blank.
app.get("/api/favorites/:id/status", requireAuth, async (req, res) => {
  try {
    const existing = await dbFindOne(db.favorites, { user_id: req.user._id, media_id: req.params.id });
    res.json({ liked: !!existing });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Real on/off toggle now — previously this only ever inserted, so repeated clicks quietly
// piled up duplicate rows in the database rather than actually un-liking anything.
app.post("/api/favorites/:id", requireAuth, async (req, res) => {
  try {
    const existing = await dbFindOne(db.favorites, { user_id: req.user._id, media_id: req.params.id });
    if (existing) {
      // {multi:true} matters here — the old version of this endpoint (before it was a real
      // toggle) only ever inserted, so repeated clicks could leave several duplicate rows
      // for the same title. Removing by _id alone would only clear one and leave the item
      // looking permanently "liked". This clears every matching row in one go instead.
      await dbRemove(db.favorites, { user_id: req.user._id, media_id: req.params.id }, { multi: true });
      _recommendationCache.delete(`${req.user._id}:movie`);
      _recommendationCache.delete(`${req.user._id}:tvshow`);
      return res.json({ ok: true, liked: false });
    }
    await dbInsert(db.favorites,{_id:uuidv4(),user_id:req.user._id,media_id:req.params.id,added_at:new Date().toISOString()});
    // Cleared on every like/unlike rather than waiting out the 6-hour cache — otherwise a
    // freshly liked title wouldn't influence the recommendation row until the cache expired,
    // which would feel broken even though it's working as designed.
    _recommendationCache.delete(`${req.user._id}:movie`);
    _recommendationCache.delete(`${req.user._id}:tvshow`);
    res.json({ ok: true, liked: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/favorites/:id", requireAuth, async (req, res) => {
  await dbRemove(db.favorites,{user_id:req.user._id,media_id:req.params.id},{multi:true});
  res.json({ok:true});
});


// ── STREAMING & HLS TRANSCODING ───────────────────────────────────────────────
// One-time backfill (runs once at startup, cheap after that) — populates episode_subtitle_langs
// for shows that already had subtitles cached before this feature existed, so the show-level
// language filter works immediately for the existing library, not just future caching runs.
async function backfillShowSubtitleLanguages() {
  try {
    const shows = await dbFind(db.media, { type: "tvshow" });
    let updated = 0;
    for (const show of shows) {
      if (Array.isArray(show.episode_subtitle_langs)) continue; // already computed, incremental updates keep it fresh
      const episodes = await dbFind(db.media, { type: "episode", parent_id: show._id });
      const langs = Array.from(new Set(episodes.flatMap(e => e.cached_subtitle_langs || [])));
      await dbUpdate(db.media, { _id: show._id }, { $set: { episode_subtitle_langs: langs } });
      updated++;
    }
    if (updated > 0) console.log(`[STARTUP] Sammanställde undertextspråk för ${updated} serier`);
  } catch(e) {
    console.log("[STARTUP] Kunde inte sammanställa seriers undertextspråk:", e.message);
  }
}
setTimeout(backfillShowSubtitleLanguages, 3000);

// One-time backfill — gives already-scanned movies/shows a slug too, so shareable URLs work
// immediately for the existing library, not just titles scanned in after this update.
async function backfillSlugs() {
  try {
    const items = await dbFind(db.media, { type: { $in: ["movie", "tvshow"] } });
    let updated = 0;
    for (const item of items) {
      if (item.slug) continue;
      const slug = await generateUniqueSlug(item.title, item.year, item.type);
      await dbUpdate(db.media, { _id: item._id }, { $set: { slug } });
      updated++;
    }
    if (updated > 0) console.log(`[STARTUP] Genererade webbadresser (slugs) för ${updated} titlar`);
  } catch(e) {
    console.log("[STARTUP] Kunde inte generera slugs:", e.message);
  }
}
setTimeout(backfillSlugs, 4000);

const HLS_CACHE = path.join(DATA_DIR, "hls");
const DASH_CACHE = path.join(DATA_DIR, "dash");
fs.mkdirSync(HLS_CACHE, { recursive: true });
fs.mkdirSync(DASH_CACHE, { recursive: true });

// Nothing can legitimately be "in progress" the instant the server starts, so any transcode
// segments already sitting in these folders are leftovers — either from before per-session
// cleanup existed, or from a crash/hard restart that skipped the normal stop-cleanup path.
// Wiped once here rather than left to accumulate indefinitely (these can easily reach tens
// of GB over time, one per movie ever transcoded).
for (const cacheDir of [HLS_CACHE, DASH_CACHE]) {
  try {
    const entries = fs.readdirSync(cacheDir);
    let cleaned = 0;
    for (const entry of entries) {
      try { fs.rmSync(path.join(cacheDir, entry), { recursive: true, force: true }); cleaned++; } catch {}
    }
    if (cleaned > 0) console.log(`[STARTUP] Rensade ${cleaned} gamla transkodningsmappar i ${cacheDir}`);
  } catch (e) {
    console.log(`[STARTUP] Kunde inte rensa ${cacheDir}:`, e.message);
  }
}

const { spawn } = require("child_process");
const activeTranscodes = new Map(); // itemId -> { proc, startTime, segCount }

const MIME = {
  ".mp4":"video/mp4", ".mkv":"video/x-matroska", ".avi":"video/x-msvideo",
  ".mov":"video/quicktime", ".wmv":"video/x-ms-wmv", ".m4v":"video/mp4",
  ".ts":"video/mp2t", ".webm":"video/webm", ".flv":"video/x-flv",
  ".mp3":"audio/mpeg", ".flac":"audio/flac", ".aac":"audio/aac",
  ".ogg":"audio/ogg", ".wav":"audio/wav", ".m4a":"audio/mp4",
  ".opus":"audio/opus", ".wma":"audio/x-ms-wma"
};

// Formats Chrome/Firefox can play natively without transcoding
const NATIVE_FORMATS = new Set([".mp4", ".m4v", ".webm", ".mp3", ".aac", ".wav", ".ogg", ".m4a"]);
// MKV works in Chrome but not Edge
const CHROME_FORMATS = new Set([".mkv"]);

function canDirectPlay(ext, userAgent) {
  if (NATIVE_FORMATS.has(ext)) return true;
  if (CHROME_FORMATS.has(ext)) {
    const ua = (userAgent || "").toLowerCase();
    return ua.includes("chrome") && !ua.includes("edg");
  }
  return false;
}

function getFfmpegPath() {
  const candidates = [
    path.join(__dirname, "..", "ffmpeg", "bin", "ffmpeg.exe"),
    path.join(__dirname, "..", "ffmpeg", "bin", "ffmpeg"),
    "ffmpeg"
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return "ffmpeg";
}

function getFfprobePath() {
  const candidates = [
    path.join(__dirname, "..", "ffmpeg", "bin", "ffprobe.exe"),
    path.join(__dirname, "..", "ffmpeg", "bin", "ffprobe"),
    "ffprobe"
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return "ffprobe";
}

// Get duration + video metadata via ffprobe, cache in DB
async function getDuration(item) {
  const needsMetadata = !item.width || !item.codec || item.display_aspect_ratio === undefined;
  if (item.duration && !needsMetadata) return item.duration;
  try {
    const ffprobe = getFfprobePath();
    const { execFileSync } = require("child_process");
    const out = execFileSync(ffprobe, [
      "-v", "quiet",
      "-analyzeduration", "100M", "-probesize", "100M",
      "-show_entries", "format=duration:stream=width,height,codec_name,pix_fmt,display_aspect_ratio,sample_aspect_ratio",
      "-of", "json",
      item.file_path
    ], { timeout: 20000, windowsHide: true }).toString().trim();
    const data = JSON.parse(out);
    const dur = Math.floor(parseFloat(data?.format?.duration || "0"));
    const videoStream = (data?.streams || []).find(s => s.width && s.height);
    const updates = {};
    if (dur > 0) updates.duration = dur;
    if (videoStream) {
      updates.width     = videoStream.width;
      updates.height    = videoStream.height;
      updates.codec     = videoStream.codec_name || "";
      updates.bit_depth = (videoStream.pix_fmt || "").includes("10") ? 10 : 8;
      // "0:1" or missing means ffprobe couldn't determine it (common for some containers) —
      // don't cache a bogus ratio, let the client fall back to computing it from width/height.
      updates.display_aspect_ratio = (videoStream.display_aspect_ratio && videoStream.display_aspect_ratio !== "0:1") ? videoStream.display_aspect_ratio : null;
      updates.sample_aspect_ratio = (videoStream.sample_aspect_ratio && videoStream.sample_aspect_ratio !== "0:1") ? videoStream.sample_aspect_ratio : "1:1";
    }
    if (Object.keys(updates).length > 0) {
      await dbUpdate(db.media, { _id: item._id }, { $set: updates });
      Object.assign(item, updates);
    }
    return item.duration || dur;
  } catch(e) {
    console.log("[FFPROBE] Error:", e.message);
  }
  return item.duration || 0;
}

// ── DIRECT STREAM (for native formats) ─────────────────────────────────────────
app.get("/api/stream/:id", requireMediaAccess, async (req, res) => {
  const item = await dbFindOne(db.media, { _id: req.params.id });
  if (!item?.file_path || !fs.existsSync(item.file_path))
    return res.status(404).json({ error: "Fil hittades inte" });

  const ext = path.extname(item.file_path).toLowerCase();
  const stat = fs.statSync(item.file_path);
  const contentType = MIME[ext] || "video/mp4";
  const range = req.headers.range;

  if (range) {
    const [s, e] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(s, 10);
    const end = e ? parseInt(e, 10) : stat.size - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": contentType
    });
    fs.createReadStream(item.file_path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": stat.size,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes"
    });
    fs.createReadStream(item.file_path).pipe(res);
  }
});

// ── HLS TRANSCODING ─────────────────────────────────────────────────────────────
// Returns info about what playback method to use
// Normalizes codec names so minor naming differences between clients (ExoPlayer/MediaFormat,
// ffprobe, other platforms) don't cause false mismatches. Keys and values are both lowercase.
// Shared by /api/playback/:id (deciding direct vs. transcode) and startDashTranscode (deciding
// whether video can be copied as-is instead of re-encoded).
const CODEC_ALIASES = {
  // video
  avc: "h264", "avc1": "h264", "h.264": "h264",
  hevc1: "hevc", "h.265": "hevc", h265: "hevc",
  vp09: "vp9", av01: "av1",
  // XviD/DivX are both MPEG-4 Part 2 (ASP) implementations — ffprobe reports the underlying
  // stream as "mpeg4" with a fourcc tag (e.g. "DX50", "XVID"), not as a distinct codec_name of
  // its own, so these aliases just make sure any caller checking for "xvid"/"divx" explicitly
  // still normalizes consistently to what ffprobe/direct_video_codecs actually deal in.
  xvid: "mpeg4", divx: "mpeg4",
  // audio
  "ec-3": "eac3", ec3: "eac3", "dd+": "eac3",
  "ac-3": "ac3", dd: "ac3",
  "dts-hd": "dts", dtshd: "dts",
  mp4a: "aac", "aac-lc": "aac"
};
function normalizeCodec(c) {
  const v = (c || "").toLowerCase().trim();
  return CODEC_ALIASES[v] || v;
}
// Query params can arrive as a single string or (if repeated) an array — always coerce to
// a string first. Also cap length/entries defensively against malformed or abusive input.
function parseCodecList(raw) {
  const str = Array.isArray(raw) ? raw.join(",") : String(raw || "");
  return new Set(
    str.slice(0, 500) // hard cap on input length
      .toLowerCase()
      .split(",")
      .map(s => normalizeCodec(s.trim()))
      .filter(Boolean)
      .slice(0, 20) // hard cap on number of entries
  );
}

app.get("/api/playback/:id", requireMediaAccess, async (req, res) => {
  const item = await dbFindOne(db.media, { _id: req.params.id });
  if (!item?.file_path || !fs.existsSync(item.file_path))
    return res.status(404).json({ error: "Fil hittades inte" });

  const ext = path.extname(item.file_path).toLowerCase();
  const ua = req.headers["user-agent"] || "";
  const duration = await getDuration(item);
  const token = req.query.token || "";

  // Get the audio codec once, since both the browser path and the capability path need it.
  // Only probed on demand since it's the one check here that actually shells out to ffprobe.
  // Detects commentary tracks (director/cast commentary, etc.) via their title metadata — see
  // the module-level isCommentaryTrack() function, shared with startDashTranscode.

  async function getAllAudioStreams() {
    try {
      const { execFileSync } = require("child_process");
      const ffprobePath = getFfmpegPath().replace("ffmpeg.exe", "ffprobe.exe");
      const out = execFileSync(ffprobePath, [
        "-v", "quiet", "-analyzeduration", "100M", "-probesize", "100M",
        "-show_streams", "-select_streams", "a",
        "-show_entries", "stream=codec_name:stream_tags=title",
        "-of", "json", item.file_path
      ], { timeout: 12000, windowsHide: true }).toString();
      return (JSON.parse(out).streams || []).map(s => ({
        codec: normalizeCodec(s.codec_name || ""),
        isCommentary: isCommentaryTrack(s.tags?.title)
      }));
    } catch(e) {
      console.log("[PLAYBACK] ffprobe all-audio check failed:", e.message);
      return [];
    }
  }

  async function getAudioCodec() {
    try {
      const { execFileSync } = require("child_process");
      const ffprobe = getFfprobePath();
      const out = execFileSync(ffprobe, [
        "-v", "quiet", "-analyzeduration", "100M", "-probesize", "100M",
        "-show_streams", "-select_streams", "a:0",
        "-show_entries", "stream=codec_name",
        "-of", "json", item.file_path
      ], { timeout: 12000, windowsHide: true }).toString();
      return normalizeCodec(JSON.parse(out).streams?.[0]?.codec_name || "");
    } catch(e) {
      console.log("[PLAYBACK] ffprobe audio check failed:", e.message);
      return "";
    }
  }

  // Defensive re-probe: getDuration() should already have cached item.codec, but if it's
  // still missing for some reason, verify with a direct probe rather than assuming compatible —
  // silently trusting an unknown codec is exactly the kind of gap that causes broken playback.
  async function getVideoCodec() {
    if (item.codec) return normalizeCodec(item.codec);
    try {
      const { execFileSync } = require("child_process");
      const out = execFileSync(getFfprobePath(), [
        "-v", "quiet", "-analyzeduration", "100M", "-probesize", "100M",
        "-show_streams", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name",
        "-of", "json", item.file_path
      ], { timeout: 12000, windowsHide: true }).toString();
      return normalizeCodec(JSON.parse(out).streams?.[0]?.codec_name || "");
    } catch(e) {
      console.log("[PLAYBACK] ffprobe video check failed:", e.message);
      return "";
    }
  }

  let needsTranscode;
  let compatibleAudioIndex = null;

  // Capability-based negotiation: a native app (Android/iOS/etc.) can tell us exactly what
  // it supports instead of us guessing from the User-Agent. Any client sending these query
  // params opts into this path; browsers that don't send them keep the existing behavior below.
  const hasCapParams = req.query.direct_containers || req.query.direct_video_codecs || req.query.direct_audio_codecs;

  if (hasCapParams) {
    const containers = parseCodecList(req.query.direct_containers);
    const videoCodecs = parseCodecList(req.query.direct_video_codecs);
    const audioCodecs = parseCodecList(req.query.direct_audio_codecs);
    const reasons = [];

    // Cheapest check first: container/extension, no probing needed.
    const containerOk = containers.size === 0 || containers.has(ext.replace(".", ""));
    if (!containerOk) reasons.push(`container "${ext.replace(".", "")}" not in [${[...containers].join(",")}]`);

    // Video codec: already cached by getDuration() in the vast majority of cases, so this is
    // normally free too. Falls back to a fresh probe only if genuinely unknown (see above).
    // If we still can't determine it even after that (e.g. probe genuinely fails), treat it
    // as INCOMPATIBLE rather than assuming it's fine — a silently broken (audio-only, no
    // picture) direct-play is worse than transcoding a file that might have been fine.
    let videoOk = true;
    if (containerOk && videoCodecs.size > 0) {
      const videoCodec = await getVideoCodec();
      videoOk = videoCodec ? videoCodecs.has(videoCodec) : false;
      if (!videoOk) reasons.push(`video codec "${videoCodec || "unknown"}" not in [${[...videoCodecs].join(",")}]`);
    }

    // Audio codec: checks ALL audio tracks, not just the first one — a remux can easily have
    // track 0 as DTS/TrueHD (incompatible) with a perfectly fine AC3/AAC track sitting right
    // next to it at index 1+. Picks the first compatible, NON-commentary track found; its
    // index is returned below so the client can actually select it (direct-play just streams
    // the raw file — the server doesn't remap tracks the way DASH does, so the client MUST
    // switch to this track index itself, or it'll just get whatever the container's default
    // track is).
    let audioOk = true;
    if (containerOk && videoOk && audioCodecs.size > 0) {
      const audioStreams = await getAllAudioStreams();
      compatibleAudioIndex = audioStreams.findIndex(s => s.codec && audioCodecs.has(s.codec) && !s.isCommentary);
      audioOk = compatibleAudioIndex !== -1;
      if (!audioOk) reasons.push(`no compatible non-commentary audio track among [${audioStreams.map(s=>s.codec).join(",")}] for [${[...audioCodecs].join(",")}]`);
    }

    needsTranscode = !(containerOk && videoOk && audioOk);
    console.log(`[PLAYBACK] ${item.title} (${ext}): capability-based, method=${needsTranscode ? "dash" : "direct"}${reasons.length ? " – " + reasons.join("; ") : ""} ua=${ua.slice(0, 40)}`);
  } else {
    // Existing browser-oriented logic (Chrome/Edge), unchanged.
    needsTranscode = !canDirectPlay(ext, ua);
    if (!needsTranscode && (ext === ".mkv" || ext === ".mp4")) {
      // Force transcode for H.265
      if (item.codec && (item.codec.includes("hevc") || item.codec.includes("h265") || item.codec.includes("265"))) {
        needsTranscode = true;
        console.log(`[PLAYBACK] ${item.title}: H.265 detected, forcing DASH`);
      }
      // Force transcode for AC3/DTS audio (Chrome can't play these)
      if (!needsTranscode) {
        const audioCodec = await getAudioCodec();
        const incompatibleAudio = ["ac3", "dts", "truehd", "eac3", "mlp"];
        if (incompatibleAudio.some(c => audioCodec.includes(c))) {
          needsTranscode = true;
          console.log(`[PLAYBACK] ${item.title}: ${audioCodec} audio detected, forcing DASH`);
        }
      }
    }
    console.log(`[PLAYBACK] ${item.title} (${ext}): method=${needsTranscode ? "dash" : "direct"} ua=${ua.includes("edg") ? "Edge" : "Chrome"}`);
  }

  // Fire-and-forget: log this playback decision for historical analytics (Tautulli-style —
  // direct vs transcode rates over time, which containers/codecs transcode most, per-title
  // play counts). Never blocks or fails the actual playback response.
  dbInsert(db.playbackLog, {
    user_id: req.user._id, username: req.user.username,
    media_id: item._id, title: item.title, type: item.type,
    method: needsTranscode ? "dash" : "direct",
    container: ext.replace(".", ""),
    video_codec: item.codec ? normalizeCodec(item.codec) : null,
    device: describeClient(ua), ip: req.ip,
    at: new Date().toISOString()
  }).catch(() => {});

  res.json({
    method: needsTranscode ? "dash" : "direct",
    url: needsTranscode
      ? `/api/dash/${item._id}/manifest.mpd?token=${token}`
      : `/api/stream/${item._id}?token=${token}`,
    duration,
    title: item.title,
    // Lets the client make its own informed decisions (e.g. route certain codecs to an
    // alternate player/decoder) instead of only getting a bare direct/dash verdict. Reuses
    // the already-cached DB field rather than re-probing — cheap either way.
    container: ext.replace(".", ""),
    videoCodec: item.codec ? normalizeCodec(item.codec) : null,
    // For the Android app's video-scaling decisions (widescreen vs. embedded letterbox).
    // Already-cached from getDuration() — no extra probing cost here.
    videoWidth: item.width || null,
    videoHeight: item.height || null,
    displayAspectRatio: item.display_aspect_ratio || null,
    sampleAspectRatio: item.sample_aspect_ratio || "1:1",
    // Field name matches what the Android app (v1.0.10+) explicitly looks for — confirmed
    // with Cursor. Only meaningful for direct play — tells the client which audio track to
    // explicitly select (e.g. via ExoPlayer track override or LibVLC setAudioTrack), since
    // direct play streams the raw file as-is and the server has no way to remap tracks the
    // way DASH transcoding does. Null when not using capability-based negotiation, or when
    // track 0 was already fine.
    serverPlaybackAudioIndex: (!needsTranscode && typeof compatibleAudioIndex === "number" && compatibleAudioIndex > 0) ? compatibleAudioIndex : null
  });
});

// ── OFFLINE DOWNLOADS (native apps) ────────────────────────────────────────────
// Issues a media-scoped download token: valid ONLY for this one file, for this one user,
// for 7 days instead of the normal 24h session token. Meant for background downloads on
// mobile that can take a long time on a slow connection — the app shouldn't have to juggle
// session refresh mid-download just to keep a multi-gigabyte transfer alive.
app.post("/api/media/:id/download-token", requireAuth, async (req, res) => {
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item) return res.status(404).json({ error: "Hittades inte" });
    if (!userHasLibraryAccess(req.user, item.library_id)) return res.status(403).json({ error: "Ingen åtkomst till detta bibliotek" });
    const dtoken = jwt.sign({ userId: req.user._id, mediaId: item._id, type: "download" }, config.jwt_secret, { expiresIn: "7d" });
    res.json({ dtoken, expiresIn: "7d" });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// One-stop endpoint for a native app building an offline download: returns the raw video
// download URL (always the original file — offline playback uses the device's own decoders,
// so none of the streaming-time direct/DASH capability logic applies here) plus every
// cached subtitle language available right now, so subtitles can be bundled offline too.
app.get("/api/media/:id/offline-manifest", requireAuth, async (req, res) => {
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item?.file_path || !fs.existsSync(item.file_path)) return res.status(404).json({ error: "Hittades inte" });
    if (!userHasLibraryAccess(req.user, item.library_id)) return res.status(403).json({ error: "Ingen åtkomst till detta bibliotek" });

    const dtoken = jwt.sign({ userId: req.user._id, mediaId: item._id, type: "download" }, config.jwt_secret, { expiresIn: "7d" });
    const stat = fs.statSync(item.file_path);
    const duration = await getDuration(item);

    // Gather every subtitle language already cached for this item (embedded/converted + external).
    const subtitles = [];
    try {
      const cacheDir = path.join(DATA_DIR, "subtitle-cache");
      const shortId = require("crypto").createHash("md5").update(item._id).digest("hex");
      const cacheFiles = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];
      const ownCached = cacheFiles.filter(f => f.startsWith(shortId + "_") && !f.includes("_ext_") && f.endsWith(".srt"));
      for (const file of ownCached) {
        const m = file.match(/_(\d+)_([a-z0-9]+)\.srt$/);
        const lang = m ? m[2] : "und";
        subtitles.push({ lang, label: subtitleLangLabel(lang), url: `/api/media/${item._id}/subtitle-cache?file=${encodeURIComponent(file)}&dtoken=${dtoken}` });
      }
      const extCached = cacheFiles.filter(f => f.startsWith(shortId + "_ext_") && f.endsWith(".srt"));
      for (const file of extCached) {
        const m = file.match(/_ext_([a-z0-9]+)\.srt$/);
        const lang = m ? m[1] : "und";
        if (!subtitles.some(s => s.lang === lang)) {
          subtitles.push({ lang, label: subtitleLangLabel(lang), url: `/api/media/${item._id}/subtitle-cache?file=${encodeURIComponent(file)}&dtoken=${dtoken}` });
        }
      }
    } catch(e) {
      logSubtitle("warn", item, "Kunde inte lista undertexter för offline-manifest", { error: e.message });
    }

    res.json({
      title: item.title,
      duration,
      sizeBytes: stat.size,
      videoUrl: `/api/media/${item._id}/download?dtoken=${dtoken}`,
      subtitles,
      dtoken,
      expiresIn: "7d"
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Serves the raw original file for offline download — same byte-range support as /api/stream/:id
// (so downloads can pause/resume), but with an attachment header and always the untouched
// original, regardless of what device is asking. Accepts the same media-scoped download token.
app.get("/api/media/:id/download", requireMediaAccess, async (req, res) => {
  const item = req.mediaItem;
  if (!item?.file_path || !fs.existsSync(item.file_path))
    return res.status(404).json({ error: "Fil hittades inte" });

  const ext = path.extname(item.file_path).toLowerCase();
  const stat = fs.statSync(item.file_path);
  const contentType = MIME[ext] || "video/mp4";
  const range = req.headers.range;
  const filename = encodeURIComponent((item.title || "video") + ext);

  const baseHeaders = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Content-Disposition": `attachment; filename*=UTF-8''${filename}`
  };

  // Live activity: track this download's progress by the highest byte offset requested so
  // far. Native download managers typically fetch sequential ranges, so the end of the most
  // recent range is a good proxy for "how far along" the download is.
  const downloadKey = `${req.user._id}:${item._id}`;
  function touchDownloadTracker(bytesServedSoFar) {
    const existing = _activeDownloads.get(downloadKey);
    _activeDownloads.set(downloadKey, {
      userId: req.user._id,
      username: req.user.username,
      mediaId: item._id,
      title: item.title || "Okänd",
      totalBytes: stat.size,
      bytesServed: Math.max(existing?.bytesServed || 0, bytesServedSoFar),
      startedAt: existing?.startedAt || Date.now(),
      lastActivity: Date.now()
    });
  }

  if (range) {
    const [s, e] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(s, 10);
    const end = e ? parseInt(e, 10) : stat.size - 1;
    touchDownloadTracker(end + 1);
    res.writeHead(206, { ...baseHeaders, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
    fs.createReadStream(item.file_path, { start, end }).pipe(res);
  } else {
    touchDownloadTracker(stat.size);
    res.writeHead(200, { ...baseHeaders, "Content-Length": stat.size });
    fs.createReadStream(item.file_path).pipe(res);
  }
});

async function startHlsTranscode(item, startSec = 0) {
  const itemId = item._id;
  const hlsDir = path.join(HLS_CACHE, itemId);
  fs.mkdirSync(hlsDir, { recursive: true });

  // Kill existing transcode and wait for it to die
  if (activeTranscodes.has(itemId)) {
    try { activeTranscodes.get(itemId).proc.kill("SIGKILL"); } catch {}
    activeTranscodes.delete(itemId);
    await new Promise(r => setTimeout(r, 1500)); // Wait longer for Windows to release file locks
  }

  // Clear old segments - retry up to 3 times to handle Windows file locks
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const files = fs.readdirSync(hlsDir).filter(f => f.endsWith(".ts") || f.endsWith(".m3u8"));
      for (const f of files) {
        try { fs.unlinkSync(path.join(hlsDir, f)); } catch {}
      }
      break; // Success
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  const ffmpeg = getFfmpegPath();
  const startNum = Math.floor(startSec / 4); // 4-second segments

  const { encoder, extraArgs } = cachedEncoder;

  // Detect 4K HDR (10-bit HEVC at high resolution) - needs special pipeline
  const is4kHdr = (item.width || 0) >= 3000 && (item.bit_depth || 8) === 10 &&
                  (item.codec || "").toLowerCase().includes("hevc");

  let hwaccelArgs = [];
  let videoFilterArgs = [];

  if (is4kHdr) {
    console.log(`[HLS] 4K HDR detected (${item.width}x${item.height} 10-bit HEVC) - using d3d11va + scale`);
    hwaccelArgs = ["-hwaccel", "d3d11va"];
    const targetW = 1920;
    const targetH = item.width && item.height
      ? Math.round((item.height / item.width) * targetW / 2) * 2
      : 800;
    videoFilterArgs = ["-vf", `scale=${targetW}:${targetH},format=yuv420p`];
  } else {
    videoFilterArgs = ["-vf", "format=yuv420p"];
  }

  console.log(`[HLS] Using encoder: ${encoder}`);

  const args = [
    "-hide_banner", "-loglevel", "warning",
    ...hwaccelArgs,
    ...(startSec > 0 ? ["-ss", startSec.toString()] : []),
    "-fflags", "+genpts+igndts+discardcorrupt",
    "-err_detect", "ignore_err",
    "-analyzeduration", "100M",
    "-probesize", "100M",
    "-i", item.file_path,
    "-avoid_negative_ts", "make_zero",
    ...videoFilterArgs,
    "-c:v", encoder, ...extraArgs,
    "-c:a", "aac", "-profile:a", "aac_low", "-ac", "2", "-b:a", "128k",
    "-async", "1",
    "-hls_time", "4",
    "-hls_list_size", "0",
    "-hls_segment_type", "mpegts",
    "-hls_flags", "independent_segments",
    "-hls_segment_filename", path.join(hlsDir, "seg%05d.ts").replace(/\\/g, "/"),
    "-start_number", startNum.toString(),
    "-f", "hls",
    path.join(hlsDir, "playlist.m3u8").replace(/\\/g, "/")
  ];

  console.log(`[HLS] FFmpeg path: ${ffmpeg}`);
  console.log(`[HLS] Args: ${args.slice(0,6).join(' ')}...`);
  const proc = spawn(ffmpeg, args, { windowsHide: false });
  activeTranscodes.set(itemId, { proc, startSec, startNum });

  let stderrBuf = "";
  proc.stderr.on("data", d => {
    const msg = d.toString().trim();
    stderrBuf += msg + "\n";
    if (msg && !HARMLESS_STDERR_PATTERNS.some(p => p.test(msg))) console.log(`[HLS ERR] ${msg}`);
  });

  proc.on("error", err => {
    console.error(`[HLS] Spawn error: ${err.message}`);
    activeTranscodes.delete(itemId);
  });

  proc.on("exit", (code, signal) => {
    activeTranscodes.delete(itemId);
    console.log(`[HLS] Done: ${item.title} (code=${code} signal=${signal})`);
    if (stderrBuf) console.log(`[HLS] Stderr: ${stderrBuf.substring(0,500)}`);
  });

  return proc;
}


// ── LIVE ACTIVITY TRACKING ──────────────────────────────────────────────────────
// Lightweight in-memory trackers (no DB writes) feeding the admin "live activity" view.
// Populated as a side-effect of endpoints that already run on every heartbeat/request —
// no new client-side polling needed.

// Keyed by `${userId}:${mediaId}`. Refreshed on every /progress POST (already sent every
// 5s by the player), so "currently watching" is just "heartbeat seen recently".
const _activeSessions = new Map();
const SESSION_STALE_MS = 20000; // no heartbeat for 20s = session considered ended

// Keyed by `${userId}:${mediaId}`. Refreshed on every byte-range request to the download
// endpoint, so we can show live progress (bytes served vs. total) without the app polling.
const _activeDownloads = new Map();
const DOWNLOAD_STALE_MS = 60000; // no activity for 60s = considered stalled/abandoned
// Grace period before a transcode with no matching active session is considered orphaned.
// Must be generous enough that a transcode which JUST started (before its first progress
// heartbeat has had time to arrive) isn't killed prematurely.
const TRANSCODE_ORPHAN_GRACE_MS = 30000;

setInterval(() => {
  const now = Date.now();
  for (const [key, s] of _activeSessions) if (now - s.lastHeartbeat > SESSION_STALE_MS) _activeSessions.delete(key);
  for (const [key, d] of _activeDownloads) if (now - d.lastActivity > DOWNLOAD_STALE_MS) _activeDownloads.delete(key);

  // Safety net: kill any DASH transcode nobody is actively watching anymore. This is the
  // primary defense against orphaned FFmpeg processes — relying on every client (web, native
  // apps, future clients) to remember to call /api/dash/:id/stop is fragile (closed tabs,
  // crashes, force-quits all skip that call). The server checks for itself instead.
  for (const [itemId, t] of activeDashTranscodes) {
    const hasActiveViewer = [..._activeSessions.values()].some(s => s.mediaId === itemId);
    if (!hasActiveViewer && (now - t.startTime) > TRANSCODE_ORPHAN_GRACE_MS) {
      console.log(`[DASH] No active viewer for "${t.title}" — killing orphaned transcode (ran for ${Math.round((now - t.startTime)/1000)}s)`);
      try { t.proc.kill("SIGKILL"); } catch {}
      activeDashTranscodes.delete(itemId);
      const dashDir = path.join(DASH_CACHE, itemId);
      setTimeout(() => {
        fs.rm(dashDir, { recursive: true, force: true }, (e) => {
          if (e) console.log(`[DASH] Kunde inte städa bort ${dashDir}:`, e.message);
        });
      }, 1000);
    }
  }
}, 10000);

// ── DASH TRANSCODE ───────────────────────────────────────────────────────────
const activeDashTranscodes = new Map();
// Known-harmless FFmpeg stderr messages, filtered out of the console log (but still kept in
// each transcode's stderrBuf) so real problems aren't buried in noise. Shared by both the
// DASH and HLS transcode stderr handlers below.
const HARMLESS_STDERR_PATTERNS = [
  /Could not find codec parameters for stream .* \(Subtitle: hdmv_pgs_subtitle/,
  /Consider increasing the value for the 'analyzeduration'/,
  // Old "packed" XviD/DivX AVI encodes (a ~2003-2005-era B-frame storage trick) trigger this
  // once per frame FFmpeg has to correct — harmless and extremely noisy, easily thousands of
  // lines for a single episode. Playback is unaffected; FFmpeg handles it automatically.
  /Discarding excessive bitstream in packed xvid/
];
const seekLocks = new Map(); // Prevent concurrent seeks for same item

// Detects commentary tracks (director/cast commentary, etc.) via their title metadata, so
// they're never picked as a fallback "main" audio track just because the codec happens to
// match — being technically playable isn't the same as being the track someone actually
// wants when the real audio track isn't supported by their device. Shared between the
// direct-play capability check and startDashTranscode's own audio-track selection.
// Fires a small JSON POST to whatever webhook URL the user has configured on their own
// profile (e.g. a Home Assistant webhook) — entirely fire-and-forget. A failing or slow
// webhook (wrong URL, unreachable server, etc.) must never affect actual playback in any way,
// so every failure mode here is swallowed silently rather than surfaced to the caller.
function fireUserWebhook(user, event, extra) {
  if (!user?.webhook_enabled || !user?.webhook_url) return;
  try {
    const url = new URL(user.webhook_url);
    const client = url.protocol === "http:" ? http : https;
    const payload = JSON.stringify({ event, username: user.username, timestamp: new Date().toISOString(), ...extra });
    const req = client.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: 5000
    }, (res) => { res.resume(); }); // drain the response, don't care about the body
    req.on("error", () => {}); // unreachable/misconfigured webhook — nothing to do about it here
    req.on("timeout", () => req.destroy());
    req.write(payload);
    req.end();
  } catch(e) {} // malformed URL etc — same story, just don't let it affect playback
}

// Converts raw pixel dimensions into the common resolution names people actually recognize
// (matching how Plex/most media apps label things), rather than showing raw "3836x1604".
function friendlyResolutionLabel(width, height) {
  if (!width || !height) return "Okänd upplösning";
  if (width >= 3800) return "4K";
  if (width >= 1900) return "1080p";
  if (width >= 1200) return "720p";
  if (width >= 700) return "480p";
  return `${width}x${height}`;
}

function isCommentaryTrack(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return /commentary|kommentar|director'?s? track|cast and crew/.test(t);
}

async function startDashTranscode(item, seekSec = 0, audioTrackIndex = null, allowedVideoCodecs = null) {
  const itemId = item._id;
  const dashDir = path.join(DASH_CACHE, itemId);
  fs.mkdirSync(dashDir, { recursive: true });

  // Kill existing if running
  if (activeDashTranscodes.has(itemId)) {
    try { activeDashTranscodes.get(itemId).proc.kill("SIGKILL"); } catch {}
    activeDashTranscodes.delete(itemId);
    await new Promise(r => setTimeout(r, 3000)); // Wait for Windows file locks to release
  }

  // Clear old segments
  try {
    const files = fs.readdirSync(dashDir);
    for (const f of files) {
      try { fs.unlinkSync(path.join(dashDir, f)); } catch {}
    }
  } catch {}

  const ffmpeg = getFfmpegPath();
  const { encoder, extraArgs } = cachedEncoder;

  // 4K HDR detection
  const is4kHdr = (item.width || 0) >= 3000 && (item.bit_depth || 8) === 10 &&
                  (item.codec || "").toLowerCase().includes("hevc");

  let hwaccelArgs = [];
  let videoFilterArgs = [];
  if (is4kHdr) {
    const targetW = 1920;
    const targetH = item.width && item.height
      ? Math.round((item.height / item.width) * targetW / 2) * 2
      : 800;
    if (encoder === "h264_nvenc") {
      console.log(`[DASH] 4K HDR detected (${item.width}x${item.height} 10-bit HEVC) - using cuda hwaccel + scale`);
      hwaccelArgs = ["-hwaccel", "cuda"];
      videoFilterArgs = ["-vf", `scale=${targetW}:${targetH},format=yuv420p`, "-pix_fmt", "yuv420p"];
    } else {
      console.log(`[DASH] 4K HDR detected (${item.width}x${item.height} 10-bit HEVC) - using software decode + scale`);
      hwaccelArgs = [];
      videoFilterArgs = ["-vf", `scale=${targetW}:${targetH},format=yuv420p`];
    }
  } else {
    videoFilterArgs = ["-vf", "format=yuv420p"];
  }

  // Check if video can be copied directly instead of re-encoded:
  //  - H264 always qualifies (universally supported, matches old browser-only behavior)
  //  - HEVC qualifies too, but ONLY if the client explicitly told us it can decode HEVC
  //    (via direct_video_codecs on /api/dash/:id/start or /seek) — otherwise transcoding
  //    to H264 is still required for compatibility, same as before.
  // This is what prevents a needless full video re-encode when the ONLY reason DASH was
  // chosen is an unsupported audio codec (e.g. AC3 without passthrough) on an HEVC file.
  const itemCodec = normalizeCodec(item.codec || "");
  const canCopyH264 = itemCodec === "h264";
  const canCopyHevc = itemCodec === "hevc" && allowedVideoCodecs && allowedVideoCodecs.has("hevc");
  const canCopyVideo = !is4kHdr && (canCopyH264 || canCopyHevc) && seekSec === 0;

  if (canCopyVideo) {
    console.log(`[DASH] Using encoder: copy (${canCopyHevc ? "HEVC" : "H264"} passthrough)`);
  } else {
    console.log(`[DASH] Using encoder: ${encoder}`);
  }

  const mpdPath = "manifest.mpd"; // relative - cwd set to dashDir

  // For DASH, AMF works without extra args - just encoder + bitrate, no -quality flag
  // -quality before -b:v sets VBR mode which conflicts with DASH muxer
  const dashEncoderArgs = encoder === "h264_amf" ? [] : [...extraArgs];

  const videoArgs = canCopyVideo
    ? ["-c:v", "copy", "-bsf:v", canCopyHevc ? "hevc_mp4toannexb" : "h264_mp4toannexb"]
    : [...videoFilterArgs, "-c:v", encoder, ...dashEncoderArgs, "-b:v", "4000k"];

  // Audio stream selection - use specific track if requested, otherwise pick best audio stream
  // Prefer AC3/EAC3/AAC over TrueHD/DTS (TrueHD causes FFmpeg errors in DASH), and never pick
  // a commentary track just because its codec happens to match — see isCommentaryTrack above.
  let bestAudioIndex = 0;
  let sourceAudioCodec = null, sourceAudioChannels = null, sourceAudioLanguage = null;
  if (audioTrackIndex === null) {
    try {
      const { execFileSync } = require("child_process");
      const ffprobePath = getFfmpegPath().replace("ffmpeg.exe", "ffprobe.exe");
      const probeOut = execFileSync(ffprobePath, [
        "-v", "quiet", "-analyzeduration", "100M", "-probesize", "100M",
        "-print_format", "json", "-show_streams",
        "-select_streams", "a", item.file_path
      ], { timeout: 12000, windowsHide: true }).toString();
      const audioStreams = JSON.parse(probeOut).streams || [];
      const preferred = audioStreams.find(s => ["ac3","eac3","aac","mp3"].includes((s.codec_name||"").toLowerCase()) && !isCommentaryTrack(s.tags?.title));
      if (preferred) {
        // Find relative audio index
        bestAudioIndex = audioStreams.indexOf(preferred);
        sourceAudioCodec = preferred.codec_name;
        sourceAudioChannels = preferred.channel_layout || (preferred.channels ? `${preferred.channels}ch` : null);
        sourceAudioLanguage = preferred.tags?.language ? subtitleLangLabel(normalizeLangCode(preferred.tags.language)) : null;
        console.log(`[DASH] Auto-selected audio stream: ${bestAudioIndex} (${preferred.codec_name})`);
      }
    } catch(e) {
      console.log("[DASH] Audio probe failed, using default:", e.message);
    }
  }
  const audioSelectArgs = audioTrackIndex !== null
    ? ["-map", "0:v:0", "-map", `0:a:${audioTrackIndex}`]
    : ["-map", "0:v:0", "-map", `0:a:${bestAudioIndex}`];

  const args = [
    "-hide_banner", "-loglevel", "warning",
    ...hwaccelArgs,
    "-fflags", "+genpts+igndts+discardcorrupt",
    "-err_detect", "ignore_err",
    "-analyzeduration", "100M",
    "-probesize", "100M",
    ...(seekSec > 0 ? ["-ss", seekSec.toString()] : []),
    "-i", item.file_path,
    "-avoid_negative_ts", "make_zero",
    ...(audioSelectArgs.length ? audioSelectArgs : []),
    ...videoArgs,
    "-c:a", "aac", "-profile:a", "aac_low", "-ac", "2", "-b:a", "128k",
    "-async", "1",
    "-af", "aresample=async=1000",
    ...(canCopyVideo ? [] : ["-force_key_frames", "expr:gte(t,n_forced*2)"]),
    "-f", "dash",
    "-seg_duration", "4",
    "-use_template", "1",
    // use_timeline=1 makes the manifest list each segment's ACTUAL duration (DASH
    // SegmentTimeline) instead of assuming every segment is exactly 4 seconds. That
    // assumption breaks down for copy-mode (canCopyVideo skips -force_key_frames above,
    // since it only applies when re-encoding) — without control over keyframe placement,
    // segments end up irregular, and the player's fixed-interval math drifts further out of
    // sync with reality the longer playback goes, eventually requesting a segment that
    // doesn't line up with anything and stalling. Safe to enable unconditionally — it works
    // fine for evenly-spaced re-encoded segments too, just a slightly more detailed manifest.
    "-use_timeline", "1",
    "-window_size", "0",
    "-adaptation_sets", "id=0,streams=v id=1,streams=a",
    mpdPath
  ];

  console.log(`[DASH] FFmpeg path: ${ffmpeg}`);
  console.log(`[DASH] ${new Date().toISOString().substring(11,23)} Starting transcode: ${item.title}`);
  console.log(`[DASH] Full args: ${args.join(' ')}`);
  const proc = spawn(ffmpeg, args, { windowsHide: false, cwd: dashDir });
  activeDashTranscodes.set(itemId, {
    proc, startTime: Date.now(), startSec: seekSec, duration: await getDuration(item),
    title: item.title, videoMode: canCopyVideo ? (canCopyHevc ? "copy-hevc" : "copy-h264") : `encode-${encoder}`,
    sourceAudioCodec, sourceAudioChannels, sourceAudioLanguage
  });

  let stderrBuf = "";
  // FFmpeg dumps its own warnings/info to stderr by design (not just real errors), so
  // everything here gets a scary "[DASH ERR]" prefix regardless of severity. This one
  // specific pattern is well-known and harmless — FFmpeg can't determine display size for
  // certain PGS (bitmap) subtitle streams during its initial probe, even though those
  // streams are never actually used in the DASH output (only video + one audio track are
  // mapped — see audioSelectArgs above). Still captured in stderrBuf for debugging, just
  // not spammed to the console.
  proc.stderr.on("data", d => {
    const msg = d.toString().trim();
    stderrBuf += msg + "\n";
    if (msg && !HARMLESS_STDERR_PATTERNS.some(p => p.test(msg))) console.log(`[DASH ERR] ${msg}`);
  });

  proc.on("error", err => {
    console.error(`[DASH] Spawn error: ${err.message}`);
    activeDashTranscodes.delete(itemId);
  });

  proc.on("exit", (code, signal) => {
    console.log(`[DASH] Done: ${item.title} (code=${code} signal=${signal})`);
    if (stderrBuf) console.log(`[DASH] Stderr: ${stderrBuf.substring(0, 500)}`);
    // Only remove from map if THIS process is still the active one
    // (a newer process may have already replaced it)
    const tcRef = activeDashTranscodes.get(itemId);
    if (tcRef && tcRef.proc === proc) {
      tcRef.done = true;
      activeDashTranscodes.delete(itemId);
    }
  });

  return proc;
}

// Start DASH transcode endpoint
app.post("/api/dash/:id/start", requireAuth, async (req, res) => {
  const item = await dbFindOne(db.media, { _id: req.params.id });
  if (!item?.file_path || !fs.existsSync(item.file_path))
    return res.status(404).json({ error: "Fil hittades inte" });

  const duration = await getDuration(item);
  const token = req.query.token || "";
  const dashDir = path.join(DASH_CACHE, item._id);
  const mpdPath = path.join(dashDir, "manifest.mpd");

  const startSec = parseInt(req.body?.startSec || "0");
  const audioTrack = req.body?.audioTrack !== undefined ? parseInt(req.body.audioTrack) : null;
  // Same capability hint as /api/playback/:id: if the client says it can decode HEVC directly,
  // we can copy the video stream as-is here too instead of re-encoding it just because audio
  // needed fixing. Absent for browsers, which keeps their existing H264-only behavior.
  const allowedVideoCodecs = req.query.direct_video_codecs ? parseCodecList(req.query.direct_video_codecs) : null;

  // Kill existing transcode if starting from different position
  const existing = activeDashTranscodes.get(item._id);
  if (existing) {
    if (Math.abs((existing.startSec || 0) - startSec) > 5) {
      const oldProc = existing.proc;
      activeDashTranscodes.delete(item._id);
      try { oldProc.kill("SIGKILL"); } catch {}
      // Wait for old process to fully release file locks on Windows
      await new Promise(r => setTimeout(r, 3000));
      startDashTranscode(item, startSec, audioTrack, allowedVideoCodecs);
    }
    // else reuse existing
  } else {
    startDashTranscode(item, startSec, audioTrack, allowedVideoCodecs);
  }

  // Wait for first media segment (means FFmpeg is running and writing data)
  const firstSeg = path.join(dashDir, "chunk-stream0-00001.m4s");
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (fs.existsSync(firstSeg) && fs.statSync(firstSeg).size > 1000) break;
    await new Promise(r => setTimeout(r, 300));
  }

  if (!fs.existsSync(firstSeg)) {
    return res.status(500).json({ error: "Transkodning misslyckades – MPD skapades inte" });
  }

  // Small extra wait for MPD to be written
  await new Promise(r => setTimeout(r, 500));

  console.log(`[DASH] ${new Date().toISOString().substring(11,23)} MPD ready for: ${item.title}`);
  res.json({
    ok: true,
    manifest: `/api/dash/${item._id}/manifest.mpd?token=${token}`,
    duration
  });
});

// Seek DASH transcode - restart FFmpeg from new position
app.post("/api/dash/:id/seek", requireAuth, async (req, res) => {
  const item = await dbFindOne(db.media, { _id: req.params.id });
  if (!item?.file_path || !fs.existsSync(item.file_path))
    return res.status(404).json({ error: "Fil hittades inte" });

  // Server-side lock: reject concurrent seeks for same item
  if (seekLocks.get(item._id)) {
    return res.status(429).json({ error: "Seek redan pågår" });
  }
  seekLocks.set(item._id, true);

  const seekSec = parseInt(req.body?.startSec || "0");
  const duration = await getDuration(item);
  const token = req.query.token || "";
  const dashDir = path.join(DASH_CACHE, item._id);
  const firstSeg = path.join(dashDir, "chunk-stream0-00001.m4s");

  // startDashTranscode handles kill + 2s wait + clear internally
  const seekAudioTrack = req.body?.audioTrack !== undefined ? parseInt(req.body.audioTrack) : null;
  const seekAllowedVideoCodecs = req.query.direct_video_codecs ? parseCodecList(req.query.direct_video_codecs) : null;
  await startDashTranscode(item, seekSec, seekAudioTrack, seekAllowedVideoCodecs);

  // Wait for MPD + first segment (or init segment as fallback)
  const initSeg = path.join(dashDir, "init-stream0.mp4");
  const mpdFile = path.join(dashDir, "manifest.mpd");
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (fs.existsSync(firstSeg) && fs.statSync(firstSeg).size > 1000) break;
    // If FFmpeg already finished (short remaining duration), check MPD exists
    const tc = activeDashTranscodes.get(item._id);
    if (!tc && fs.existsSync(mpdFile)) break;
    await new Promise(r => setTimeout(r, 300));
  }

  if (!fs.existsSync(firstSeg) && !fs.existsSync(mpdFile)) {
    seekLocks.delete(item._id);
    return res.status(500).json({ error: "Seek misslyckades" });
  }

  await new Promise(r => setTimeout(r, 300));

  seekLocks.delete(item._id);
  console.log(`[DASH] Seek ready: ${item.title} from ${seekSec}s`);
  res.json({
    ok: true,
    manifest: `/api/dash/${item._id}/manifest.mpd?token=${token}`,
    duration
  });
});

// Stop DASH transcode
// Called whenever the player closes, regardless of whether it finished or was just quit
// partway through — separate from /dash/:id/stop (which only concerns killing the FFmpeg
// process). This is what lets the "stopped" webhook fire promptly instead of waiting for the
// session to time out on its own a few minutes later.
app.post("/api/media/:id/stop", requireAuth, async (req, res) => {
  const sessionKey = `${req.user._id}:${req.params.id}`;
  if (_activeSessions.has(sessionKey)) {
    _activeSessions.delete(sessionKey);
    const item = await dbFindOne(db.media, { _id: req.params.id });
    fireUserWebhook(req.user, "stopped", { title: item?.title });
  }
  res.json({ ok: true });
});

app.post("/api/dash/:id/stop", requireAuth, (req, res) => {
  const t = activeDashTranscodes.get(req.params.id);
  if (t) {
    try { t.proc.kill("SIGKILL"); } catch {}
    activeDashTranscodes.delete(req.params.id);
  }
  // Nobody's watching this anymore — the segment files (can easily be several GB for a long
  // movie) have no reason to keep existing. Delayed slightly so FFmpeg has time to actually
  // release its file handles after SIGKILL before we try to remove them.
  const dashDir = path.join(DASH_CACHE, req.params.id);
  setTimeout(() => {
    fs.rm(dashDir, { recursive: true, force: true }, (e) => {
      if (e) console.log(`[DASH] Kunde inte städa bort ${dashDir}:`, e.message);
    });
  }, 1000);
  res.json({ ok: true });
});

// Serve DASH segments - Plex-style incomplete segment streaming
// X-Plex-Incomplete-Segments: stream segment to client WHILE FFmpeg writes it
app.get("/api/dash/:id/:file", async (req, res) => {
  const dashDir = path.join(DASH_CACHE, req.params.id);
  const filePath = path.join(dashDir, req.params.file);
  const fileName = req.params.file;

  if (!filePath.startsWith(dashDir)) return res.status(403).end();

  const ext = path.extname(fileName);
  const mimeTypes = {
    '.mpd': 'application/dash+xml',
    '.m4s': 'video/mp4',
    '.mp4': 'video/mp4'
  };
  res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  // For MPD: serve as-is (dynamic type kept so dash.js keeps polling for new segments)
  if (ext === '.mpd') {
    let waited = 0;
    while (!fs.existsSync(filePath) && waited < 15000) {
      await new Promise(r => setTimeout(r, 100));
      waited += 100;
    }
    if (!fs.existsSync(filePath)) return res.status(404).end();
    return fs.createReadStream(filePath).pipe(res);
  }

  // For init segments: wait up to 10s
  if (fileName.startsWith('init-')) {
    let waited = 0;
    while (!fs.existsSync(filePath) && waited < 10000) {
      await new Promise(r => setTimeout(r, 100));
      waited += 100;
    }
    if (!fs.existsSync(filePath)) return res.status(404).end();
    return fs.createReadStream(filePath).pipe(res);
  }

  // For media segments: wait until the NEXT segment exists (means this one is complete)
  // This avoids dash.js timeout on non-computable download size
  let waited = 0;
  while (!fs.existsSync(filePath) && waited < 30000) {
    await new Promise(r => setTimeout(r, 200));
    waited += 200;
  }
  if (!fs.existsSync(filePath)) return res.status(404).end();

  // Wait for segment to be fully written by checking if next segment started
  const match = fileName.match(/chunk-stream(\d+)-(\d+)\.m4s/);
  if (match) {
    const streamIdx = match[1];
    const segNum = parseInt(match[2]);
    const nextNum = String(segNum + 1).padStart(match[2].length, '0');
    const nextPath = path.join(dashDir, `chunk-stream${streamIdx}-${nextNum}.m4s`);
    let waitedForNext = 0;
    while (!fs.existsSync(nextPath) && waitedForNext < 20000) {
      const tc = activeDashTranscodes.get(req.params.id);
      if (!tc) {
        // FFmpeg finished - wait a bit more in case it just wrote the last segment
        await new Promise(r => setTimeout(r, 500));
        break;
      }
      await new Promise(r => setTimeout(r, 100));
      waitedForNext += 100;
    }
  }

  // Set Content-Length so dash.js knows the size (avoids "non-computable download size")
  try {
    const stat = fs.statSync(filePath);
    res.setHeader('Content-Length', stat.size);
  } catch {}

  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    console.error('[DASH] Segment read error:', err.message);
    if (!res.headersSent) res.status(404).end();
    else res.end();
  });
  stream.pipe(res);
});


// Start/seek HLS transcode
app.post("/api/hls/:id/start", requireAuth, async (req, res) => {
  const item = await dbFindOne(db.media, { _id: req.params.id });
  if (!item?.file_path || !fs.existsSync(item.file_path))
    return res.status(404).json({ error: "Fil hittades inte" });

  const startSec = parseInt(req.body?.startSec || req.query.startSec || "0");
  
  // Check if already transcoding from same position – don't restart
  const existing = activeTranscodes.get(item._id);
  if (existing && Math.abs(existing.startSec - startSec) < 5) {
    console.log(`[HLS] Already transcoding ${item.title} from ~${startSec}s, reusing`);
    const duration = await getDuration(item);
    const token = req.query.token || "";
    return res.json({
      ok: true,
      playlist: `/api/hls/${item._id}/master.m3u8?token=${token}`,
      duration,
      startSec
    });
  }

  console.log(`[HLS] Starting transcode: ${item.title} from ${startSec}s`);
  startHlsTranscode(item, startSec);

  // Wait for first segment (max 20 seconds)
  const hlsDir = path.join(HLS_CACHE, item._id);
  const startNum = Math.floor(startSec / 4);
  const firstSeg = path.join(hlsDir, `seg${String(startNum).padStart(5,'0')}.ts`);

  console.log(`[HLS] Waiting for first segment: ${firstSeg}`);
  let waited = 0;
  let segReady = false;
  while (waited < 20000) {
    try {
      if (fs.existsSync(firstSeg) && fs.statSync(firstSeg).size > 10000) {
        segReady = true;
        break;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300));
    waited += 300;
  }

  if (!segReady) {
    console.error(`[HLS] First segment never appeared: ${firstSeg}`);
    // Clean up failed transcode
    const tc = activeTranscodes.get(item._id);
    if (tc) { try { tc.proc.kill("SIGKILL"); } catch {} activeTranscodes.delete(item._id); }
    return res.status(500).json({ error: "Transkodning misslyckades – kontrollera att FFmpeg är installerat" });
  }
  
  console.log(`[HLS] First segment ready after ${waited}ms`);

  const duration = await getDuration(item);
  const token = req.query.token || "";

  res.json({
    ok: true,
    playlist: `/api/hls/${item._id}/master.m3u8?token=${token}`,
    duration,
    startSec
  });
});

// Master playlist (tells client about available streams)
app.get("/api/hls/:id/master.m3u8", requireAuth, async (req, res) => {
  const token = req.query.token || "";
  const item = await dbFindOne(db.media, { _id: req.params.id });
  const duration = item ? (item.duration || 0) : 0;
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.setHeader("Cache-Control", "no-cache");
  if (duration > 0) res.setHeader("X-Content-Duration", duration.toString());
  res.send([
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080`,
    `/api/hls/${req.params.id}/playlist.m3u8?token=${encodeURIComponent(token)}`
  ].join("\n"));
});

// Playlist - dynamically built so video.currentTime always starts at 0
// This is the Jellyfin approach: EXT-X-MEDIA-SEQUENCE = startSegment
app.get("/api/hls/:id/playlist.m3u8", requireAuth, async (req, res) => {
  const hlsDir = path.join(HLS_CACHE, req.params.id);
  const playlist = path.join(hlsDir, "playlist.m3u8");
  if (!fs.existsSync(playlist)) return res.status(404).end();

  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.setHeader("Cache-Control", "no-cache");

  const token = req.query.token || "";
  const tc = activeTranscodes.get(req.params.id);
  const startNum = tc ? (tc.startNum || 0) : 0;

  let m3u8 = fs.readFileSync(playlist, "utf8");
  
  // Set MEDIA-SEQUENCE to startNum so video.currentTime starts at 0
  m3u8 = m3u8.replace(/#EXT-X-MEDIA-SEQUENCE:\d+/, `#EXT-X-MEDIA-SEQUENCE:${startNum}`);
  
  // Rewrite segment URLs to include token
  m3u8 = m3u8.replace(/^(seg\d+\.ts)$/gm,
    `/api/hls/${req.params.id}/$1?token=${encodeURIComponent(token)}`);
  res.send(m3u8);
});

// Segments
app.get("/api/hls/:id/:seg", requireAuth, async (req, res) => {
  const segName = req.params.seg.split("?")[0];
  if (!segName.endsWith(".ts")) return res.status(404).end();

  const segFile = path.join(HLS_CACHE, req.params.id, segName);

  // Wait up to 10 seconds for segment to appear
  let waited = 0;
  while (!fs.existsSync(segFile) && waited < 10000) {
    await new Promise(r => setTimeout(r, 200));
    waited += 200;
  }

  if (!fs.existsSync(segFile)) return res.status(404).end();

  res.setHeader("Content-Type", "video/MP2T");
  res.setHeader("Cache-Control", "public, max-age=3600");
  fs.createReadStream(segFile).pipe(res);
});

// Stop transcode
app.post("/api/hls/:id/stop", requireAuth, (req, res) => {
  const tc = activeTranscodes.get(req.params.id);
  if (tc) {
    try { tc.proc.kill("SIGKILL"); } catch {}
    activeTranscodes.delete(req.params.id);
  }
  res.json({ ok: true });
});

// All providers TMDB knows about for Sweden — used to populate the "choose your services"
// settings list. Cached for a day since this barely ever changes.
let _allProvidersCache = null, _allProvidersCacheTime = 0;
app.get("/api/watch-providers/all", requireAuth, async (req, res) => {
  if (!config.tmdb_api_key) return res.json({ providers: [] });
  if (_allProvidersCache && Date.now() - _allProvidersCacheTime < 86400000) return res.json({ providers: _allProvidersCache });
  const data = await tmdbFetch(`/watch/providers/movie?watch_region=SE`);
  const providers = (data?.results || [])
    .map(p => ({ name: p.provider_name, logo: p.logo_path ? `https://image.tmdb.org/t/p/w92${p.logo_path}` : null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  _allProvidersCache = providers; _allProvidersCacheTime = Date.now();
  res.json({ providers });
});

app.patch("/api/users/:id/preferred-providers", requireAuth, async (req, res) => {
  try {
    if (req.params.id !== req.user._id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Ej tillåtet" });
    }
    await dbUpdate(db.users, { _id: req.params.id }, { $set: { preferred_watch_providers: req.body.providers || [] } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/watch-providers/:tmdb_id", requireAuth, async (req, res) => {
  if (!config.tmdb_api_key) return res.json({});
  const kind = req.query.kind === "tv" ? "tv" : "movie";
  const data = await tmdbFetch(`/${kind}/${req.params.tmdb_id}/watch/providers?watch_region=SE`);
  const region = data?.results?.SE || {};
  const withLogo = (arr) => (arr || []).map(p => ({ name: p.provider_name, logo: p.logo_path ? `https://image.tmdb.org/t/p/w92${p.logo_path}` : null }));
  const preferred = req.user.preferred_watch_providers || [];
  // Default (nothing chosen yet) shows everything, unchanged from before. Once the person has
  // picked their own services, this switches to showing ONLY those — not just prioritizing
  // them at the top — since that's specifically what was asked for here.
  const filterIfPreferred = (arr) => preferred.length ? arr.filter(p => preferred.includes(p.name)) : arr;
  res.json({
    flatrate: filterIfPreferred(withLogo(region.flatrate)),
    rent: filterIfPreferred(withLogo(region.rent)),
    buy: filterIfPreferred(withLogo(region.buy)),
    // TMDB's own aggregator page for this specific title — the actual per-provider deep
    // links (e.g. straight to this movie's page on Netflix) require JustWatch's paid
    // affiliate API, which we don't have; this is the free alternative that still gets
    // someone one click closer instead of nothing at all.
    link: region.link || null
  });
});

// Related movies/shows for a detail page — pulls TMDB's recommendations for the title, then
// filters down to only what's actually in this library, so every result is guaranteed
// clickable (no dead-end links to things you don't own). Falls back to TMDB's "similar"
// endpoint if recommendations comes back empty, since recommendations relies on TMDB user
// behavior data and can be thin for less mainstream titles.
// Tracks media IDs currently having cropdetect run, so a burst of requests for the same
// file (e.g. the app polling while waiting) doesn't kick off multiple concurrent ffmpeg runs.
const _cropDetectInProgress = new Set();

// Detects embedded letterbox black bars baked into the video itself (as opposed to genuine
// widescreen content) — lets a client zoom to fill the screen without cropping real picture.
// Deliberately NOT run during scanning (cropdetect needs to actually decode frames, unlike
// the metadata-only ffprobe calls elsewhere — on a library with thousands of files that adds
// hours of work for something most files will never need). Instead computed lazily the first
// time a specific file's layout is actually requested, then cached permanently.
// Detects embedded letterbox black bars baked into the video itself (as opposed to genuine
// widescreen content) — lets a client zoom to fill the screen without cropping real picture.
// Samples several points spread across the film rather than a single fixed timestamp — a
// single sample can land on a dark scene, transition, or (for older/less well-indexed files)
// a bad seek position, giving a misleadingly aggressive crop reading. Picks the most
// conservative (smallest crop / largest active area) result across samples, since
// under-cropping a real letterbox is harmless while over-cropping real picture isn't.
async function runCropDetect(item) {
  const duration = item.duration || 0;
  // Sample at 25/50/75% through the runtime — avoids opening titles and end credits, and
  // spreads the samples so one unusual scene can't dominate the result. Falls back to a
  // single sample near the start for very short or duration-unknown files.
  const samplePoints = duration > 300
    ? [Math.floor(duration * 0.25), Math.floor(duration * 0.5), Math.floor(duration * 0.75)]
    : [Math.min(60, Math.floor(duration * 0.3) || 10)];

  console.log(`[CROPDETECT] Starting analysis for "${item.title}" — ${samplePoints.length} sample point(s) at ${samplePoints.join("s, ")}s`);

  const results = [];
  for (const seekSec of samplePoints) {
    const result = await runCropDetectSample(item, seekSec);
    if (result) results.push(result);
  }

  if (!results.length) {
    console.log(`[CROPDETECT] "${item.title}": no usable crop data from any sample point`);
    return null;
  }

  // Pick the sample with the LARGEST active area (i.e. the smallest, most conservative crop)
  // — a genuine consistent letterbox will show up similarly across all samples anyway, while
  // a one-off bad reading (an anomalously small area) gets naturally out-voted.
  results.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  const best = results[0];
  console.log(`[CROPDETECT] "${item.title}": ${results.length}/${samplePoints.length} samples usable, picked largest active area — ${JSON.stringify(best)}`);
  return best;
}

function runCropDetectSample(item, seekSec) {
  return new Promise((resolve) => {
    const args = [
      "-y", "-ss", String(seekSec),
      "-i", item.file_path,
      "-vframes", "40",
      "-vf", "cropdetect=24:16:0",
      "-f", "null", "-"
    ];
    const t0 = Date.now();
    const proc = require("child_process").execFile(getFfmpegPath(), args, { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (err) console.log(`[CROPDETECT] FFmpeg error at ${seekSec}s for "${item.title}" after ${secs}s: ${err.message}`);
      const matches = [...(stderr || "").matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
      if (!matches.length) {
        console.log(`[CROPDETECT] "${item.title}" @ ${seekSec}s: no crop values in ${secs}s`);
        resolve(null);
        return;
      }
      const [, w, h, x, y] = matches[matches.length - 1];
      console.log(`[CROPDETECT] "${item.title}" @ ${seekSec}s: crop=${w}:${h}:${x}:${y} in ${secs}s (${matches.length} samples)`);
      resolve({ x: parseInt(x), y: parseInt(y), width: parseInt(w), height: parseInt(h) });
    });
    deprioritizeBackgroundProcess(proc); // background analysis shouldn't compete with active playback
  });
}

app.get("/api/media/:id/video-layout", requireMediaAccess, async (req, res) => {
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item) { console.log(`[CROPDETECT] GET video-layout: media ${req.params.id} not found`); return res.status(404).json({ error: "Not found" }); }

    if (item.activePicture) {
      console.log(`[CROPDETECT] "${item.title}": already cached — ${JSON.stringify(item.activePicture)}`);
      return res.json({ status: "ready", activePicture: item.activePicture });
    }
    if (_cropDetectInProgress.has(item._id)) {
      console.log(`[CROPDETECT] "${item.title}": already in progress, told client to retry`);
      return res.json({ status: "computing", retryAfter: 5 });
    }

    console.log(`[CROPDETECT] "${item.title}": no cache yet — kicking off analysis`);
    _cropDetectInProgress.add(item._id);
    runCropDetect(item).then(result => {
      _cropDetectInProgress.delete(item._id);
      // Sanity check: real embedded letterboxing/pillarboxing rarely removes more than
      // ~35% of either dimension (even 4:3-in-16:9 pillarboxing is ~25% per side). A more
      // aggressive reading than that is more likely a bad sample (dark scene, bad seek on an
      // older/less well-indexed file) than a genuine crop — safer to ignore it than to zoom
      // into and cut real picture based on a probably-wrong reading.
      if (result && item.width && item.height) {
        const wRatio = result.width / item.width, hRatio = result.height / item.height;
        if (wRatio < 0.65 || hRatio < 0.65) {
          console.log(`[CROPDETECT] "${item.title}": discarding implausibly aggressive crop (${result.width}x${result.height} of ${item.width}x${item.height}) — likely a bad sample, not genuine letterboxing`);
          result = null;
        }
      }
      // Cache a "no letterbox detected" result too (as the full frame), so we never redo
      // this expensive analysis for the same file twice, even when there was nothing to find.
      const activePicture = result || { x: 0, y: 0, width: item.width || 0, height: item.height || 0 };
      console.log(`[CROPDETECT] "${item.title}": caching result — ${JSON.stringify(activePicture)}`);
      dbUpdate(db.media, { _id: item._id }, { $set: { activePicture } }).catch(e => console.log(`[CROPDETECT] Failed to save result for "${item.title}": ${e.message}`));
    }).catch(e => { _cropDetectInProgress.delete(item._id); console.log(`[CROPDETECT] "${item.title}" THREW: ${e.message}`); });

    res.json({ status: "computing", retryAfter: 5 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Resolves a shareable URL's slug back to the actual media item — used by the frontend
// router when a movie/show page is loaded directly (shared link, bookmark, refresh) rather
// than navigated to from within the app.
app.get("/api/media/slug/:slug", requireAuth, async (req, res) => {
  try {
    const item = await dbFindOne(db.media, { slug: req.params.slug, type: { $in: ["movie", "tvshow"] } });
    if (!item) return res.status(404).json({ error: "Hittades inte" });
    if (item.library_id && !userHasLibraryAccess(req.user, item.library_id)) return res.status(403).json({ error: "Ej tillåtet" });
    res.json({ id: item._id, type: item.type });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Everything TMDB has beyond just the main trailer — featurettes, behind-the-scenes clips,
// bloopers, scenes, teasers. Same underlying /videos call as the trailer feature already
// makes, just keeping every result instead of picking out only the one "Trailer" entry.
const EXTRAS_TYPE_LABELS = { "Trailer": "Trailer", "Teaser": "Teaser", "Clip": "Scen", "Featurette": "Bakom kulisserna", "Behind the Scenes": "Bakom kulisserna", "Bloopers": "Utanför manus" };
app.get("/api/media/:id/extras", requireAuth, async (req, res) => {
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item || !item.tmdb_id) return res.json({ extras: [] });
    const kind = item.type === "tvshow" ? "tv" : "movie";
    let data = await tmdbFetch(`/${kind}/${item.tmdb_id}/videos`);
    let videos = data?.results || [];
    if (!videos.length) { data = await tmdbFetch(`/${kind}/${item.tmdb_id}/videos`, "en-US"); videos = data?.results || []; }
    const extras = videos
      .filter(v => v.site === "YouTube")
      .map(v => ({ key: v.key, name: v.name, type: EXTRAS_TYPE_LABELS[v.type] || v.type, thumbnail: `https://img.youtube.com/vi/${v.key}/hqdefault.jpg` }));
    res.json({ extras });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Shared trailer lookup — used both for already-owned titles (looked up via our own media
// ID) and for titles found via search that aren't owned at all (looked up via a raw TMDB ID).
async function fetchTmdbTrailer(tmdbId, kind) {
  let data = await tmdbFetch(`/${kind}/${tmdbId}/videos`);
  let videos = data?.results || [];
  // TMDB's video listings are very often only tagged in English regardless of what language
  // we ask in — a non-English query can come back completely empty even though the trailer
  // genuinely exists (same issue we've hit before with posters/biographies).
  if (!videos.length) {
    data = await tmdbFetch(`/${kind}/${tmdbId}/videos`, "en-US");
    videos = data?.results || [];
  }
  const trailer = videos.find(v => v.site === "YouTube" && v.type === "Trailer")
    || videos.find(v => v.site === "YouTube" && v.type === "Teaser")
    || null;
  return { key: trailer?.key || null, name: trailer?.name || null, type: trailer?.type || null };
}

// Fetches the official trailer (YouTube) for a movie/show already in the library, via its
// stored tmdb_id. Falls back to "Teaser" if no proper Trailer exists, since some titles
// (especially older or less mainstream ones) only have a teaser listed on TMDB.
app.get("/api/media/:id/trailer", requireAuth, async (req, res) => {
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item || !item.tmdb_id) return res.json({ key: null });
    const kind = item.type === "tvshow" ? "tv" : "movie";
    res.json(await fetchTmdbTrailer(item.tmdb_id, kind));
  } catch(e) {
    res.json({ key: null }); // never let a broken trailer lookup break the detail page
  }
});

// Same trailer lookup, but for a title found via search that isn't owned at all — no media
// DB entry to look up a tmdb_id from, so it's passed directly instead.
// ── EXPLORE ───────────────────────────────────────────────────────────────────
// Lets someone browse movies they DON'T own too (popular/top-rated/now-playing/upcoming,
// optionally filtered by genre and/or year) — same underlying data source as search's
// "Var kan du se den?" results, just as its own dedicated browsing page instead of only
// showing up after a search. Cross-references against the library so results the person
// already owns link straight to the real detail page instead of the TMDB preview.

app.get("/api/genres/movie", requireAuth, async (req, res) => {
  try {
    const data = await tmdbFetch("/genre/movie/list", "en-US");
    res.json({ genres: data?.genres || [] });
  } catch(e) {
    res.json({ genres: [] });
  }
});

const EXPLORE_CATEGORIES = {
  popular: { endpoint: "/movie/popular", discoverSort: "popularity.desc" },
  top_rated: { endpoint: "/movie/top_rated", discoverSort: "vote_average.desc" },
  now_playing: { endpoint: "/movie/now_playing", discoverSort: "popularity.desc" },
  upcoming: { endpoint: "/movie/upcoming", discoverSort: "primary_release_date.asc" }
};

app.get("/api/explore/movies", requireAuth, async (req, res) => {
  try {
    const category = EXPLORE_CATEGORIES[req.query.category] ? req.query.category : "popular";
    const genre = req.query.genre ? parseInt(req.query.genre) : null;
    const year = req.query.year ? parseInt(req.query.year) : null;
    const page = Math.min(parseInt(req.query.page) || 1, 500);
    const cat = EXPLORE_CATEGORIES[category];

    let endpoint;
    if (genre || year) {
      // Genre/year filtering only works via TMDB's /discover endpoint, not the dedicated
      // popular/top_rated/etc endpoints — so filters route through discover instead,
      // approximating the chosen category via sort order (and, for "upcoming"/"now
      // playing", a release-date constraint discover itself doesn't otherwise apply).
      const params = new URLSearchParams({ sort_by: cat.discoverSort, page: String(page), "vote_count.gte": category === "top_rated" ? "200" : "0" });
      if (genre) params.set("with_genres", String(genre));
      if (year) params.set("primary_release_year", String(year));
      const today = new Date().toISOString().slice(0, 10);
      if (category === "upcoming") params.set("primary_release_date.gte", today);
      if (category === "now_playing") { params.set("primary_release_date.lte", today); params.set("primary_release_date.gte", new Date(Date.now() - 60*86400000).toISOString().slice(0,10)); }
      endpoint = `/discover/movie?${params.toString()}`;
    } else {
      endpoint = `${cat.endpoint}?page=${page}`;
    }

    const data = await tmdbFetch(endpoint, "en-US");
    const results = data?.results || [];
    const tmdbIds = results.map(r => r.id).filter(Boolean);
    const owned = tmdbIds.length ? await dbFind(db.media, { type: "movie", tmdb_id: { $in: tmdbIds } }) : [];
    const ownedByTmdbId = new Map(owned.map(o => [o.tmdb_id, o]));

    const items = results.map(r => {
      const localItem = ownedByTmdbId.get(r.id);
      return {
        tmdb_id: r.id,
        title: r.title,
        year: r.release_date ? r.release_date.slice(0, 4) : null,
        rating: r.vote_average || null,
        poster_url: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null,
        owned: !!localItem,
        id: localItem ? localItem._id : null
      };
    });

    res.json({ items, page, totalPages: data?.total_pages || 1 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/tmdb/trailer/:kind/:tmdb_id", requireAuth, async (req, res) => {
  try {
    const kind = req.params.kind === "tv" ? "tv" : "movie";
    res.json(await fetchTmdbTrailer(req.params.tmdb_id, kind));
  } catch(e) {
    res.json({ key: null });
  }
});

// Resolves a YouTube video ID to a direct, playable stream URL via third-party Piped
// instances — NOT YouTube's official API, and outside their terms of service. Deliberately
// gated behind an admin toggle (default OFF) rather than always available: this exists
// specifically for private, personal-use setups where embedding YouTube's own iframe player
// isn't practical (e.g. some Android TV WebViews refuse to play it at all), not as a
// general-purpose feature meant for wide distribution. Off by default so a server shared
// more broadly doesn't carry this by accident.
// Community-run, unofficial instances — individually unreliable (go down, get blocked, change
// domains without notice), which is exactly why several are tried in sequence rather than
// just one or two. List sourced from Piped's own public documentation; worth refreshing
// occasionally from https://github.com/TeamPiped/documentation (public-instances page) or
// checking live status at https://status.piped.video/ if trailer streaming stops working
// again — this is a symptom of the instances themselves, not a StreamVault bug.
const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi-libre.kavin.rocks",
  "https://pipedapi.leptons.xyz",
  "https://pipedapi.nosebs.ru",
  "https://piped-api.privacy.com.de",
  "https://pipedapi.adminforge.de",
  "https://api.piped.yt",
  "https://pipedapi.drgns.space",
  "https://pipedapi.owo.si",
  "https://pipedapi.ducks.party",
  "https://piped-api.codespace.cz",
  "https://pipedapi.reallyaweso.me",
  "https://api.piped.private.coffee",
  "https://pipedapi.darkness.services",
  "https://pipedapi.orangenet.cc"
];

function httpsGetJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: timeoutMs,
      headers: { "User-Agent": "StreamVault/" + STREAMVAULT_VERSION }
    }, (res) => {
      if (res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.on("error", reject);
  });
}

// Invidious instances are fetched LIVE from their own official instances API instead of
// hardcoded, since (as we just saw with Piped) a hardcoded list inevitably goes stale as
// instances die or get blocked. Cached for a few hours so we're not hitting that API on
// every single trailer request.
let _invidiousInstancesCache = null;
let _invidiousInstancesCacheTime = 0;
async function getInvidiousInstances() {
  const now = Date.now();
  if (_invidiousInstancesCache && (now - _invidiousInstancesCacheTime) < 6 * 3600 * 1000) {
    return _invidiousInstancesCache;
  }
  try {
    const data = await httpsGetJson("https://api.invidious.io/instances.json?sort_by=type,users", 8000);
    const instances = (data || [])
      .filter(([, details]) => details && details.type === "https" && details.api !== false)
      .map(([, details]) => details.uri)
      .slice(0, 10); // cap how many we bother trying per request
    if (instances.length) { _invidiousInstancesCache = instances; _invidiousInstancesCacheTime = now; }
    return _invidiousInstancesCache || [];
  } catch(e) {
    console.log("[TRAILER-STREAM] Could not fetch current Invidious instance list:", e.message);
    return _invidiousInstancesCache || [];
  }
}

// Last-resort fallback if every Piped/Invidious instance failed — only used if yt-dlp is
// actually installed and on PATH (never installed automatically). Generally the most
// reliable single option of the three, since it's a dedicated, actively-maintained tool
// built specifically to track YouTube's changes, but tried last since it's slower to spawn
// than a simple HTTP request to an already-running instance.
function tryYtDlp(youtubeKey, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    require("child_process").execFile(
      "yt-dlp",
      ["-g", "-f", "best[ext=mp4]/best", `https://www.youtube.com/watch?v=${youtubeKey}`],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err);
        const url = (stdout || "").trim().split("\n")[0];
        if (url) resolve(url); else reject(new Error("yt-dlp returned no usable URL"));
      }
    );
  });
}

async function resolveYoutubeStreamUrl(youtubeKey) {
  // Piped, Invidious, AND yt-dlp are all raced together from the start — not yt-dlp only
  // as a last resort after everything else has already failed. Right now Piped/Invidious are
  // largely down, which meant waiting through a long chain of timeouts/DNS failures before
  // ever reaching yt-dlp, even though yt-dlp usually ends up winning anyway. Racing them
  // together means the total wait is however long the FASTEST working option takes, not the
  // sum of every failed attempt plus yt-dlp on top. If Piped/Invidious recover at some point,
  // they can still win the race on their own merits (e.g. if yt-dlp is ever slow to spawn).
  const invidiousInstances = await getInvidiousInstances();
  const pipedAttempts = PIPED_INSTANCES.map(base =>
    httpsGetJson(`${base}/streams/${youtubeKey}`, 6000).then(data => {
      if (data.hls) return data.hls;
      const streams = (data.videoStreams || []).filter(s => !s.videoOnly);
      if (streams.length) return streams[0].url;
      throw new Error("No usable stream in response");
    }).catch(e => {
      console.log(`[TRAILER-STREAM] Piped instance ${base} failed for ${youtubeKey}: ${e.message}`);
      throw e;
    })
  );
  const invidiousAttempts = invidiousInstances.map(base =>
    httpsGetJson(`${base}/api/v1/videos/${youtubeKey}`, 6000).then(data => {
      const streams = (data.formatStreams || []).filter(s => s.url);
      if (streams.length) return streams[0].url;
      throw new Error("No usable stream in response");
    }).catch(e => {
      console.log(`[TRAILER-STREAM] Invidious instance ${base} failed for ${youtubeKey}: ${e.message}`);
      throw e;
    })
  );
  const ytDlpAttempt = tryYtDlp(youtubeKey).catch(e => {
    console.log(`[TRAILER-STREAM] yt-dlp failed/not installed for ${youtubeKey}: ${e.message}`);
    throw e;
  });

  try {
    const url = await Promise.any([...pipedAttempts, ...invidiousAttempts, ytDlpAttempt]);
    console.log(`[TRAILER-STREAM] Resolved stream for ${youtubeKey}`);
    return url;
  } catch(e) {
    console.log(`[TRAILER-STREAM] Every option (Piped/Invidious/yt-dlp) failed for ${youtubeKey}`);
    return null;
  }
}

app.get("/api/media/:id/trailer-stream", requireAuth, async (req, res) => {
  if (!config.trailer_stream_enabled) {
    return res.status(403).json({ url: null, error: "Funktionen är avstängd i Inställningar" });
  }
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item) return res.status(404).json({ error: "Hittades inte" });
    if (item.library_id && !userHasLibraryAccess(req.user, item.library_id)) {
      return res.status(403).json({ error: "Ej tillåtet" });
    }
    if (!item.tmdb_id) return res.json({ url: null });
    const kind = item.type === "tvshow" ? "tv" : "movie";
    const trailer = await fetchTmdbTrailer(item.tmdb_id, kind);
    if (!trailer.key) return res.json({ url: null });
    const url = await resolveYoutubeStreamUrl(trailer.key);
    res.json(url ? { url } : { url: null, error: "Kunde inte lösa stream" });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Same as /api/media/:id/trailer-stream, but for a title that isn't owned at all (e.g. from
// Utforska or search) — no local media entry to look up a tmdb_id from, so kind+tmdb_id are
// passed directly instead. Same toggle-gating and reasoning applies (see the owned version).
app.get("/api/tmdb/trailer-stream/:kind/:tmdb_id", requireAuth, async (req, res) => {
  if (!config.trailer_stream_enabled) {
    return res.status(403).json({ url: null, error: "Funktionen är avstängd i Inställningar" });
  }
  try {
    const kind = req.params.kind === "tv" ? "tv" : "movie";
    const trailer = await fetchTmdbTrailer(req.params.tmdb_id, kind);
    if (!trailer.key) return res.json({ url: null });
    const url = await resolveYoutubeStreamUrl(trailer.key);
    res.json(url ? { url } : { url: null, error: "Kunde inte lösa stream" });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// "Du gillade X — du kanske även gillar detta" — picks one random liked title (not the most
// recent, on purpose: a rotating pick keeps the homepage row from going stale if the person
// just keeps liking the same handful of things) and reuses the exact same TMDB
// recommendations logic as the detail page's "Liknande filmer", so unowned suggestions show
// up too with the same "I biblioteket" badge.
// Cache keyed by "userId:type" — recomputing this means one TMDB call per sampled liked
// title, so without caching it'd re-run in full on every single homepage load. 6 hours is
// long enough that repeat visits in a day are cheap, short enough that liking something new
// shows up reasonably soon.
const _recommendationCache = new Map();
const RECOMMENDATION_CACHE_MS = 6 * 60 * 60 * 1000;
const RECOMMENDATION_SAMPLE_SIZE = 8; // caps TMDB calls regardless of how many titles someone has liked

// Builds a "you liked X, Y, Z — you might like this" set for a specific media type. Rather
// than picking one random liked title and asking TMDB what's similar to just that one, this
// samples several liked titles, asks TMDB for recommendations against each, and tallies how
// often each candidate shows up — a title recommended off the back of 5 different things you
// liked is a much stronger signal than one that only matched a single title. Gets more
// accurate over time as there's more liked history to draw the sample from.
async function buildRecommendationSet(userId, mediaType) {
  const cacheKey = `${userId}:${mediaType}`;
  const cached = _recommendationCache.get(cacheKey);
  if (cached && Date.now() - cached.time < RECOMMENDATION_CACHE_MS) return cached.data;

  const likes = await dbFind(db.favorites, { user_id: userId });
  if (!likes.length) return { sourceTitles: [], items: [] };
  const likedItems = (await Promise.all(likes.map(l => dbFindOne(db.media, { _id: l.media_id }))))
    .filter(i => i && i.type === mediaType && i.tmdb_id);
  if (!likedItems.length) return { sourceTitles: [], items: [] };

  // Shuffle then cap — keeps this bounded even with a huge liked list, and rotates which
  // titles get sampled between cache refreshes rather than always using the same few.
  const sample = [...likedItems].sort(() => Math.random() - 0.5).slice(0, RECOMMENDATION_SAMPLE_SIZE);
  const kind = mediaType === "tvshow" ? "tv" : "movie";

  const tally = new Map(); // tmdb_id -> { count, data }
  await Promise.all(sample.map(async (item) => {
    let data = await tmdbFetch(`/${kind}/${item.tmdb_id}/recommendations`);
    let recs = data?.results || [];
    if (!recs.length) {
      data = await tmdbFetch(`/${kind}/${item.tmdb_id}/similar`);
      recs = data?.results || [];
    }
    for (const c of recs.slice(0, 20)) {
      if (!c.id) continue;
      const existing = tally.get(c.id);
      if (existing) existing.count++;
      else tally.set(c.id, { count: 1, data: c });
    }
  }));

  // Highest tally first (most titles it was recommended alongside), ties broken by TMDB's
  // own popularity so the order isn't arbitrary within a tally group.
  const ranked = [...tally.values()].sort((a, b) => b.count - a.count || (b.data.popularity||0) - (a.data.popularity||0));
  const rankedTmdbIds = ranked.map(r => r.data.id);
  const owned = await dbFind(db.media, { type: mediaType, tmdb_id: { $in: rankedTmdbIds } });
  const ownedByTmdbId = new Map(owned.map(o => [o.tmdb_id, o]));
  const items = ranked.slice(0, 20).map(({ data: c }) => {
    const ownedItem = ownedByTmdbId.get(c.id);
    return ownedItem
      ? { id: ownedItem._id, tmdb_id: c.id, title: ownedItem.title, year: ownedItem.year, poster_url: ownedItem.poster_url, type: ownedItem.type, owned: true }
      : { id: null, tmdb_id: c.id, title: c.title || c.name, year: (c.release_date || c.first_air_date || "").slice(0,4) || null, poster_url: c.poster_path ? `https://image.tmdb.org/t/p/w342${c.poster_path}` : null, type: mediaType, owned: false };
  });

  const result = { sourceTitles: sample.map(s => s.title), items };
  _recommendationCache.set(cacheKey, { time: Date.now(), data: result });
  return result;
}

app.get("/api/recommendations", requireAuth, async (req, res) => {
  try {
    const [movies, tvshows] = await Promise.all([
      buildRecommendationSet(req.user._id, "movie"),
      buildRecommendationSet(req.user._id, "tvshow")
    ]);
    res.json({ movies, tvshows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/media/:id/related", requireAuth, async (req, res) => {
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item) return res.json({ items: [] });

    // Same-collection entries first (e.g. every Johan Falk movie) — this is exact, reliable
    // data we already have from scanning, unlike TMDB's recommendations/similar endpoints,
    // which are algorithmic guesses that don't reliably surface sequels for franchises
    // outside TMDB's own most-watched-together data (works well for Marvel, poorly for a
    // niche non-English franchise with less TMDB user activity behind it).
    let collectionItems = [];
    if (item.collection_id) {
      const inCollection = await dbFind(db.media, { type: "movie", collection_id: item.collection_id, _id: { $ne: item._id } });
      collectionItems = inCollection.map(o => ({ id: o._id, tmdb_id: o.tmdb_id, title: o.title, year: o.year, poster_url: o.poster_url, type: o.type, owned: true }));
    }

    let recItems = [];
    if (item.tmdb_id) {
      const kind = item.type === "tvshow" ? "tv" : "movie";
      let data = await tmdbFetch(`/${kind}/${item.tmdb_id}/recommendations`);
      let candidates = data?.results || [];
      if (!candidates.length) {
        data = await tmdbFetch(`/${kind}/${item.tmdb_id}/similar`);
        candidates = data?.results || [];
      }
      const candidateTmdbIds = candidates.map(c => c.id).filter(Boolean);
      const owned = await dbFind(db.media, { type: item.type, tmdb_id: { $in: candidateTmdbIds } });
      const ownedByTmdbId = new Map(owned.map(o => [o.tmdb_id, o]));
      // Unlike before, unowned candidates are now included too (matching Plex's own "similar"
      // section, which isn't limited to your library) — each item just carries an owned flag
      // so the card can show the same "I biblioteket" badge Utforska already uses, and route
      // to the right detail page (ours if owned, TMDB's if not) when clicked.
      recItems = candidates.map(c => {
        const ownedItem = ownedByTmdbId.get(c.id);
        return ownedItem
          ? { id: ownedItem._id, tmdb_id: c.id, title: ownedItem.title, year: ownedItem.year, poster_url: ownedItem.poster_url, type: ownedItem.type, owned: true }
          : { id: null, tmdb_id: c.id, title: c.title || c.name, year: (c.release_date || c.first_air_date || "").slice(0,4) || null, poster_url: c.poster_path ? `https://image.tmdb.org/t/p/w342${c.poster_path}` : null, type: kind === "tv" ? "tvshow" : "movie", owned: false };
      });
    }

    // Collection entries first, then fill the rest with TMDB recommendations, deduplicated
    // by tmdb_id (not id — unowned items don't have one, so deduping on id would wrongly
    // treat every unowned item as a duplicate of the first one)
    const seen = new Set(collectionItems.map(i => i.tmdb_id).filter(Boolean));
    const items = [...collectionItems, ...recItems.filter(i => !i.tmdb_id || !seen.has(i.tmdb_id) && (seen.add(i.tmdb_id), true))].slice(0, 20);

    res.json({ items });
  } catch(e) {
    res.json({ items: [] }); // never let a broken related-media lookup break the detail page
  }
});

// ── SUBTITLES ─────────────────────────────────────────────────────────────────

// Get available subtitles for a media item (embedded + .srt files)
app.get("/api/media/:id/subtitles", requireAuth, async (req, res) => {
  vlog(`GET /subtitles  id=${req.params.id}  user=${req.user?.username}  ua=${req.headers["user-agent"]}`);
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item) { vlog(`  → 404, media not found`); return res.status(404).json({ error: "Not found" }); }
    vlog(`  item="${item.title}" (${item.type}) file="${item.file_path}"`);

    const subtitles = [];

    // 1. Check for .srt files in the same directory (served live, any language)
    const dir = path.dirname(item.file_path);
    const baseName = path.basename(item.file_path, path.extname(item.file_path));
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith(".srt")) continue;
        const fileLower = file.toLowerCase();
        const baseLower = baseName.toLowerCase();
        if (!fileLower.startsWith(baseLower)) continue;
        // Match files like "movie.srt", "movie.sv.srt", "movie.no.srt", "movie.Swedish.srt"
        const suffix = fileLower.slice(baseLower.length).replace(/\.srt$/, "").replace(/^\./, "");
        const lang = suffix ? normalizeLangCode(suffix) : "und";
        subtitles.push({
          id: "srt_" + file,
          type: "srt",
          lang,
          label: `${subtitleLangLabel(lang)} (SRT)`,
          path: path.join(dir, file),
          url: "/api/media/" + item._id + "/subtitle-file?file=" + encodeURIComponent(file)
        });
      }
    } catch(e) {
      logSubtitle("warn", item, "Kunde inte lista externa undertextfiler", { error: e.message });
    }

    // 2. Check for embedded subtitle tracks via ffprobe (every language, on-demand extraction)
    const ffprobePath = getFfmpegPath().replace("ffmpeg.exe", "ffprobe.exe");
    try {
      const { execFileSync } = require("child_process");
      const probeOut = execFileSync(ffprobePath, [
        "-v", "quiet", "-analyzeduration", "100M", "-probesize", "100M",
        "-print_format", "json", "-show_streams",
        "-select_streams", "s", item.file_path
      ], { timeout: 15000, windowsHide: true }).toString();
      const probe = JSON.parse(probeOut);
      (probe.streams || []).forEach((s, i) => {
        const lang = normalizeLangCode(s.tags?.language || s.tags?.LANGUAGE || "und");
        const title = s.tags?.title || s.tags?.TITLE || "";
        subtitles.push({
          id: "embedded_" + i,
          type: "embedded",
          lang,
          index: i,
          label: title || subtitleLangLabel(lang),
          codec: s.codec_name,
          url: "/api/media/" + item._id + "/subtitle-extract?index=" + i
        });
      });
    } catch(e) {
      logSubtitle("warn", item, "Kunde inte lista inbäddade undertextspår", { error: e.message });
    }

    // 3. Check pre-cached subtitles (embedded pre-cache, PgsToSrt-converted, or external copy)
    // — every language that's already cached on disk shows up here.
    try {
      const cacheDir = path.join(DATA_DIR, "subtitle-cache");
      const shortId = require("crypto").createHash("md5").update(item._id).digest("hex");
      const cacheFiles = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];

      // Embedded/converted cache: {id}_{subIdx}_{lang}.srt
      const ownCached = cacheFiles.filter(f => f.startsWith(shortId + "_") && !f.includes("_ext_") && f.endsWith(".srt"));
      for (const cachedFile of ownCached) {
        const m = cachedFile.match(/_(\d+)_([a-z0-9]+)\.srt$/);
        const lang = m ? m[2] : "und";
        const alreadyHave = subtitles.some(s => s.type !== "embedded" && s.lang === lang);
        if (!alreadyHave) {
          subtitles.push({
            id: "cached_" + cachedFile,
            type: "srt",
            lang,
            label: `${subtitleLangLabel(lang)} (Cachad)`,
            url: "/api/media/" + item._id + "/subtitle-cache?file=" + encodeURIComponent(cachedFile)
          });
        }
      }
      // External cache: {hash}_ext_{lang}.srt
      const extCached = cacheFiles.filter(f => f.startsWith(shortId + "_ext_") && f.endsWith(".srt"));
      for (const cachedFile of extCached) {
        const m = cachedFile.match(/_ext_([a-z0-9]+)\.srt$/);
        const lang = m ? m[1] : "und";
        const alreadyHave = subtitles.some(s => s.type !== "embedded" && s.lang === lang);
        if (!alreadyHave) {
          subtitles.push({
            id: "cached_ext_" + cachedFile,
            type: "srt",
            lang,
            label: `${subtitleLangLabel(lang)} (Extern)`,
            url: "/api/media/" + item._id + "/subtitle-cache?file=" + encodeURIComponent(cachedFile)
          });
        }
      }
    } catch(e) {
      logSubtitle("warn", item, "Kunde inte lista cachade undertexter", { error: e.message });
    }

    // Sort: the requesting user's own priority list first (in order, if set — otherwise just
    // their single primary language), then Swedish, then English, then others
    const userSubLang = USER_LANG_TO_SUB_LANG[req.user?.language] || null;
    const priorityList = (Array.isArray(req.user?.subtitleLanguages) && req.user.subtitleLanguages.length)
      ? req.user.subtitleLanguages
      : [userSubLang].filter(Boolean);
    subtitles.sort((a, b) => {
      const priority = (l) => {
        const idx = priorityList.indexOf(l);
        if (idx !== -1) return idx - 100; // ahead of everything else, in list order
        if (l === "swe") return 0;
        if (l === "eng") return 1;
        return 2;
      };
      return priority(a.lang) - priority(b.lang);
    });

    // The player fetches these URLs directly (no Authorization header attached), so embed
    // the caller's own token here — otherwise the library-access check added to
    // subtitle-cache/subtitle-file/subtitle-extract would 401 on every request.
    let callerToken = req.query.token || "";
    if (!callerToken) {
      const auth = req.headers.authorization;
      if (auth?.startsWith("Bearer ")) callerToken = auth.slice(7);
    }
    if (callerToken) {
      for (const s of subtitles) {
        if (s.url) s.url += (s.url.includes("?") ? "&" : "?") + "token=" + callerToken;
      }
    }

    vlog(`  → returning ${subtitles.length} subtitles: [${subtitles.map(s => `${s.lang}/${s.type}`).join(", ")}]`);
    res.json({ subtitles });
  } catch(e) {
    vlog(`  → 500 ERROR: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Serve a cached subtitle file (PgsToSrt-converted or pre-extracted)
app.get("/api/media/:id/subtitle-cache", requireMediaAccess, async (req, res) => {
  vlog(`GET /subtitle-cache  id=${req.params.id}  file=${req.query.file}`);
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item) { vlog(`  → 404, media not found`); return res.status(404).json({ error: "Not found" }); }
    const cacheDir = path.join(DATA_DIR, "subtitle-cache");
    const file = req.query.file;
    if (!file || file.includes("..")) { vlog(`  → 400, invalid file param`); return res.status(400).json({ error: "Invalid" }); }
    const filePath = path.join(cacheDir, file);
    if (!fs.existsSync(filePath)) { vlog(`  → 404, file not on disk: ${filePath}`); return res.status(404).json({ error: "Not found" }); }
    vlog(`  → serving, ${fs.statSync(filePath).size} bytes, offset=${req.query.offset || 0}`);
    const offsetSec = parseFloat(req.query.offset || "0");
    let srt;
    const rawBuffer = fs.readFileSync(filePath);
    try {
      srt = rawBuffer.toString("utf8");
      if (srt.includes("\uFFFD")) throw new Error("not utf8");
    } catch { srt = rawBuffer.toString("latin1"); }
    if (srt.charCodeAt(0) === 0xFEFF) srt = srt.slice(1);
    function shiftTime(h, m, s, ms, offset) {
      let totalMs = (parseInt(h)*3600 + parseInt(m)*60 + parseInt(s))*1000 + parseInt(ms) - Math.round(offset*1000);
      if (totalMs < 0) totalMs = 0;
      const oh = Math.floor(totalMs/3600000); totalMs %= 3600000;
      const om = Math.floor(totalMs/60000); totalMs %= 60000;
      const os = Math.floor(totalMs/1000);
      const oms = totalMs % 1000;
      return String(oh).padStart(2,'0')+':'+String(om).padStart(2,'0')+':'+String(os).padStart(2,'0')+'.'+String(oms).padStart(3,'0');
    }
    let vttBody = srt.replace(/\r\n/g,"\n").replace(/\r/g,"\n")
      .replace(/(\d+)\n(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/g, function(match,idx,h1,m1,s1,ms1,h2,m2,s2,ms2) {
        return shiftTime(h1,m1,s1,ms1,offsetSec) + " --> " + shiftTime(h2,m2,s2,ms2,offsetSec);
      });
    const vtt = "WEBVTT\n\n" + cleanSubtitleText(vttBody);
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.send(vtt);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Serve a .srt file as WebVTT for browser playback
app.get("/api/media/:id/subtitle-file", requireMediaAccess, async (req, res) => {
  vlog(`GET /subtitle-file  id=${req.params.id}  file=${req.query.file}`);
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item) { vlog(`  → 404, media not found`); return res.status(404).json({ error: "Not found" }); }
    const dir = path.dirname(item.file_path);
    const file = req.query.file;
    if (!file || file.includes("..")) { vlog(`  → 400, invalid file param`); return res.status(400).json({ error: "Invalid" }); }
    const filePath = path.join(dir, file);
    if (!fs.existsSync(filePath)) { vlog(`  → 404, file not on disk: ${filePath}`); return res.status(404).json({ error: "File not found" }); }
    vlog(`  → serving, ${fs.statSync(filePath).size} bytes`);
    // Convert SRT to WebVTT - handle multiple encodings
    let srt;
    const rawBuffer = fs.readFileSync(filePath);
    // Try UTF-8 first, fall back to Latin-1/Windows-1252
    try {
      srt = rawBuffer.toString("utf8");
      // Check if it looks like garbled text (replacement chars indicate wrong encoding)
      if (srt.includes("\uFFFD")) throw new Error("not utf8");
    } catch {
      srt = rawBuffer.toString("latin1");
    }
    // Handle BOM
    if (srt.charCodeAt(0) === 0xFEFF) srt = srt.slice(1);
    
    // Parse offset (seekSec) for time-shifting subtitles
    const offsetSec = parseFloat(req.query.offset || "0");
    
    // Helper to shift a time string by offset
    function shiftTime(h, m, s, ms, offset) {
      let totalMs = (parseInt(h)*3600 + parseInt(m)*60 + parseInt(s))*1000 + parseInt(ms) - Math.round(offset*1000);
      if (totalMs < 0) totalMs = 0;
      const oh = Math.floor(totalMs/3600000); totalMs %= 3600000;
      const om = Math.floor(totalMs/60000); totalMs %= 60000;
      const os = Math.floor(totalMs/1000);
      const oms = totalMs % 1000;
      return String(oh).padStart(2,'0')+':'+String(om).padStart(2,'0')+':'+String(os).padStart(2,'0')+'.'+String(oms).padStart(3,'0');
    }

    let vttBody = srt
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/(\d+)\n(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/g, function(match, idx, h1,m1,s1,ms1,h2,m2,s2,ms2) {
        if (offsetSec === 0) return `${shiftTime(h1,m1,s1,ms1,0)} --> ${shiftTime(h2,m2,s2,ms2,0)}`;
        return `${shiftTime(h1,m1,s1,ms1,offsetSec)} --> ${shiftTime(h2,m2,s2,ms2,offsetSec)}`;
      });

    const vtt = "WEBVTT\n\n" + cleanSubtitleText(vttBody);
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.send(vtt);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Extract embedded subtitle track to VTT
app.get("/api/media/:id/subtitle-extract", requireMediaAccess, async (req, res) => {
  vlog(`GET /subtitle-extract  id=${req.params.id}  index=${req.query.index}  offset=${req.query.offset}`);
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item) { vlog(`  → 404, media not found`); return res.status(404).json({ error: "Not found" }); }
    const trackIndex = parseInt(req.query.index || "0");
    const offsetSec = parseFloat(req.query.offset || "0");

    const cacheDir = path.join(DATA_DIR, "subtitle-cache");
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    // Probe this specific stream so the cache filename matches what preCacheSubtitles uses
    let lang = "und", codec = "";
    try {
      const { execFileSync } = require("child_process");
      const ffprobePath = getFfmpegPath().replace("ffmpeg.exe", "ffprobe.exe");
      const probeOut = execFileSync(ffprobePath, [
        "-v", "quiet", "-analyzeduration", "100M", "-probesize", "100M",
        "-print_format", "json", "-show_streams",
        "-select_streams", "s:" + trackIndex, item.file_path
      ], { timeout: 12000, windowsHide: true }).toString();
      const streams = JSON.parse(probeOut).streams || [];
      lang = normalizeLangCode(streams[0]?.tags?.language || streams[0]?.tags?.LANGUAGE || "und");
      codec = streams[0]?.codec_name || "";
      vlog(`  probed track ${trackIndex}: lang=${lang} codec=${codec}`);
    } catch(e) {
      vlog(`  probe FAILED for track ${trackIndex}: ${e.message}`);
      logSubtitle("warn", item, `Kunde inte läsa spårinfo för spår ${trackIndex} vid extraktion`, { trackIndex, error: e.message });
    }

    const cacheFile = path.join(cacheDir, `${shortMediaId(item._id)}_${trackIndex}_${lang}.srt`);
    const tempFile = cacheFile + ".tmp";
    vlog(`  cacheFile=${cacheFile}  exists=${fs.existsSync(cacheFile)}  tempExists=${fs.existsSync(tempFile)}`);

    if (!fs.existsSync(cacheFile)) {
      if (UNSUPPORTED_BITMAP_CODECS.includes(codec)) {
        vlog(`  → 404, unsupported VobSub/DVD codec (${codec})`);
        logSubtitle("info", item, `Bildbaserat spår (${subtitleLangLabel(lang)}, ${codec}) kan inte visas – DVD/VobSub-format stöds inte av nuvarande OCR-verktyg`, { trackIndex, lang, codec });
        return res.status(404).json({ error: "DVD/VobSub subtitle format not supported by current OCR tool (PGS only)" });
      }
      if (bitmapCodecs.includes(codec)) {
        if (!isPgsToSrtInstalled()) {
          vlog(`  → 404, PgsToSrt not installed`);
          logSubtitle("warn", item, `Bildbaserat spår (${subtitleLangLabel(lang)}) kan inte visas – PgsToSrt är inte installerat`, { trackIndex, lang });
          return res.status(404).json({ error: "Bitmap subtitle not supported without PgsToSrt" });
        }
        if (fs.existsSync(tempFile)) { vlog(`  → 202, already converting (PGS)`); return res.status(202).json({ status: "extracting", retryAfter: 5 }); }
        vlog(`  → 202, starting on-demand PGS conversion`);
        fs.writeFileSync(tempFile, "");
        convertPgsTosrt(item, trackIndex, cacheFile, lang).then(ok => {
          try { fs.unlinkSync(tempFile); } catch {}
          vlog(`  on-demand PGS conversion ${ok ? "succeeded" : "FAILED"} for track ${trackIndex}`);
          if (ok) logSubtitle("info", item, `Undertext konverterad on-demand – ${subtitleLangLabel(lang)}`, { trackIndex });
        }).catch(e => { try { fs.unlinkSync(tempFile); } catch {}; vlog(`  on-demand PGS conversion THREW: ${e.message}`); logSubtitle("error", item, "Oväntat fel vid on-demand PgsToSrt", { trackIndex, error: e.message }); });
        return res.status(202).json({ status: "extracting", retryAfter: 5 });
      }

      // Already extracting?
      if (fs.existsSync(tempFile)) {
        vlog(`  → 202, already extracting (text)`);
        return res.status(202).json({ status: "extracting", retryAfter: 3 });
      }
      vlog(`  → 202, starting on-demand text extraction`);
      fs.writeFileSync(tempFile, "");
      extractTextSubtitle(item, trackIndex, cacheFile).then(result => {
        try { fs.unlinkSync(tempFile); } catch {}
        vlog(`  on-demand text extraction result: ${JSON.stringify(result)}`);
        if (result.ok) {
          logSubtitle("info", item, `Undertext extraherad on-demand – ${subtitleLangLabel(lang)}`, { trackIndex });
        } else {
          logSubtitle("error", item, `On-demand-extraktion misslyckades – ${subtitleLangLabel(lang)}`, { trackIndex, error: result.error?.split("\n")[0] });
        }
      });
      return res.status(202).json({ status: "extracting", retryAfter: 3 });
    }
    const tmpFile = cacheFile;
    vlog(`  → cache hit, serving existing file directly (${fs.statSync(tmpFile).size} bytes)`);

    // Convert SRT to VTT with optional offset
    const rawBuffer = fs.readFileSync(tmpFile);
    let srt;
    try {
      srt = rawBuffer.toString("utf8");
      if (srt.includes("�") || srt.includes("Ã")) throw new Error("not utf8");
    } catch {
      srt = rawBuffer.toString("latin1");
    }
    if (srt.charCodeAt(0) === 0xFEFF) srt = srt.slice(1);

    function shiftTime(h, m, s, ms, offset) {
      let totalMs = (parseInt(h)*3600 + parseInt(m)*60 + parseInt(s))*1000 + parseInt(ms) - Math.round(offset*1000);
      if (totalMs < 0) totalMs = 0;
      const oh = Math.floor(totalMs/3600000); totalMs %= 3600000;
      const om = Math.floor(totalMs/60000); totalMs %= 60000;
      const os2 = Math.floor(totalMs/1000);
      const oms = totalMs % 1000;
      return String(oh).padStart(2,'0')+':'+String(om).padStart(2,'0')+':'+String(os2).padStart(2,'0')+'.'+String(oms).padStart(3,'0');
    }

    const srtCleaned = srt.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // Match SRT timestamps with or without preceding cue number
    const timeRegex = /(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/g;
    const vttBody = srtCleaned
      .replace(timeRegex, function(match, t1, t2) {
        // Parse each time
        var p1 = t1.split(/[:,]/);
        var p2 = t2.split(/[:,]/);
        return shiftTime(p1[0],p1[1],p1[2],p1[3],offsetSec) + " --> " + shiftTime(p2[0],p2[1],p2[2],p2[3],offsetSec);
      });
    const vtt = "WEBVTT\n\n" + cleanSubtitleText(vttBody);
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.send(vtt);

    // File is cached - no cleanup needed
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Search OpenSubtitles
// Calculate OpenSubtitles hash for a file
async function calcOpenSubtitlesHash(filePath) {
  return new Promise((resolve, reject) => {
    const HASH_CHUNK = 65536; // 64KB
    fs.stat(filePath, (err, stat) => {
      if (err) return reject(err);
      const fileSize = stat.size;
      if (fileSize < HASH_CHUNK * 2) return reject(new Error("File too small"));
      let hash = BigInt(fileSize);
      const buf = Buffer.alloc(HASH_CHUNK);
      const fd = require("fs").openSync(filePath, "r");
      try {
        // Read first 64KB
        fs.readSync(fd, buf, 0, HASH_CHUNK, 0);
        for (let i = 0; i < HASH_CHUNK; i += 8) {
          hash = (hash + buf.readBigUInt64LE(i)) & BigInt("0xFFFFFFFFFFFFFFFF");
        }
        // Read last 64KB
        fs.readSync(fd, buf, 0, HASH_CHUNK, fileSize - HASH_CHUNK);
        for (let i = 0; i < HASH_CHUNK; i += 8) {
          hash = (hash + buf.readBigUInt64LE(i)) & BigInt("0xFFFFFFFFFFFFFFFF");
        }
      } finally {
        fs.closeSync(fd);
      }
      resolve(hash.toString(16).padStart(16, "0"));
    });
  });
}

app.get("/api/tmdb/lookup", requireAuth, async (req, res) => {
  const { id, type = "movie" } = req.query;
  if (!id) return res.status(400).json({ error: "Missing id" });
  if (!config.tmdb_api_key) return res.status(400).json({ error: "No TMDB API key" });
  try {
    const endpoint = type === "tv" ? "tv" : "movie";
    const lang = config.language && config.language !== "auto" ? config.language : "en-US";
    const url = `https://api.themoviedb.org/3/${endpoint}/${id}?api_key=${config.tmdb_api_key}&language=${lang}`;
    const data = await new Promise((resolve, reject) => {
      https.get(url, r => {
        let d = ""; r.on("data", c => d += c);
        r.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      }).on("error", reject);
    });
    if (data.success === false) return res.status(404).json({ error: "Not found" });
    const title = data.title || data.name;
    const year = (data.release_date || data.first_air_date || "").substring(0, 4);
    const poster = data.poster_path ? "https://image.tmdb.org/t/p/w200" + data.poster_path : null;
    const backdrop = data.backdrop_path ? "https://image.tmdb.org/t/p/w1280" + data.backdrop_path : null;
    res.json({ id: data.id, title, year, poster_url: poster, backdrop_url: backdrop, overview: data.overview, rating: data.vote_average });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Shared OpenSubtitles REST helper (follows redirects) — used by both the single-item
// search endpoint and the season batch-search endpoint below.
function doOpenSubsRequest(params) {
  return new Promise((resolve, reject) => {
    function doRequest(url, redirects) {
      if (redirects > 5) return reject(new Error("Too many redirects"));
      const parsed = new URL(url);
      https.get({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          "Api-Key": config.opensubtitles_api_key,
          "User-Agent": "StreamVault/" + STREAMVAULT_VERSION,
          "Accept": "application/json"
        }
      }, r => {
        if (r.statusCode === 301 || r.statusCode === 302) {
          r.resume();
          const loc = r.headers.location;
          const nextUrl = loc.startsWith("http") ? loc : "https://api.opensubtitles.com" + loc;
          return doRequest(nextUrl, redirects + 1);
        }
        let d = ""; r.on("data", c => d += c);
        r.on("end", () => {
          try { resolve(JSON.parse(d)); }
          catch(e) { console.log("[SUBTITLES] Parse error:", d.substring(0, 200)); reject(new Error("parse")); }
        });
      }).on("error", reject);
    }
    doRequest("https://api.opensubtitles.com/api/v1/subtitles?" + params.toString(), 0);
  });
}

// Downloads a specific OpenSubtitles file_id and saves it next to a media item's video file,
// tagged with the given language suffix. Shared by the single-download endpoint and the
// season batch-search endpoint.
async function downloadOpenSubtitlesFile(fileId, item, langSuffix) {
  const linkData = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ file_id: fileId });
    function doRequest(hostname, urlPath, redirects) {
      if (redirects > 5) return reject(new Error("Too many redirects"));
      const options = {
        hostname, path: urlPath, method: "POST",
        headers: {
          "Api-Key": config.opensubtitles_api_key,
          "User-Agent": "StreamVault/" + STREAMVAULT_VERSION,
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      };
      const r = https.request(options, resp => {
        if (resp.statusCode === 301 || resp.statusCode === 302) {
          resp.resume();
          const loc = resp.headers.location;
          const newUrl = loc.startsWith("http") ? new URL(loc) : new URL("https://api.opensubtitles.com" + loc);
          return doRequest(newUrl.hostname, newUrl.pathname + newUrl.search, redirects + 1);
        }
        let d = ""; resp.on("data", c => d += c);
        resp.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error("parse")); } });
      });
      r.on("error", reject); r.write(body); r.end();
    }
    doRequest("api.opensubtitles.com", "/api/v1/download", 0);
  });
  if (!linkData.link) throw new Error("Ingen nedladdningslänk från OpenSubtitles");
  const dir = path.dirname(item.file_path);
  const baseName = path.basename(item.file_path, path.extname(item.file_path));
  const savePath = path.join(dir, `${baseName}.${langSuffix}.srt`);
  await new Promise((resolve, reject) => {
    function download(url) {
      const parsedUrl = new URL(url);
      https.get({ hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search }, r => {
        if (r.statusCode === 301 || r.statusCode === 302) { r.resume(); return download(r.headers.location); }
        const file = fs.createWriteStream(savePath);
        r.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
      }).on("error", reject);
    }
    download(linkData.link);
  });
  return savePath;
}

app.get("/api/subtitles/search", requireAuth, async (req, res) => {
  try {
    const { query, lang = "sv", imdb_id, media_id } = req.query;
    if (!config.opensubtitles_api_key) return res.json({ subtitles: [] });


    let data = null;

    // Try hash-based search first if media_id provided
    if (media_id) {
      try {
        const item = await dbFindOne(db.media, { _id: media_id });
        if (item && item.file_path) {
          const hash = await calcOpenSubtitlesHash(item.file_path);
          console.log("[SUBTITLES] Trying hash search:", hash);
          const hashParams = new URLSearchParams({ languages: lang, moviehash: hash });
          const hashData = await doOpenSubsRequest(hashParams);
          if (hashData.data && hashData.data.length > 0) {
            console.log("[SUBTITLES] Hash search found", hashData.data.length, "results");
            data = hashData;
          }
        }
      } catch(e) {
        console.log("[SUBTITLES] Hash search failed, falling back to name search:", e.message);
      }
    }

    // Fallback to name/imdb search
    if (!data) {
      const params = new URLSearchParams({ languages: lang });
      if (imdb_id) params.set("imdb_id", imdb_id);
      else if (query) params.set("query", query);
      data = await doOpenSubsRequest(params);
    }
    const results = (data.data || []).slice(0, 10).map(s => ({
      id: s.id,
      lang: s.attributes?.language,
      release: s.attributes?.release,
      downloads: s.attributes?.download_count,
      rating: s.attributes?.ratings,
      file_id: s.attributes?.files?.[0]?.file_id
    }));
    res.json({ subtitles: results });
  } catch(e) {
    res.json({ subtitles: [], error: e.message });
  }
});

// Download subtitle from OpenSubtitles
app.post("/api/subtitles/download", requireAuth, async (req, res) => {
  try {
    const { file_id, media_id } = req.body;
    if (!config.opensubtitles_api_key) return res.status(400).json({ error: "No API key" });
    // Get download link
    const linkData = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ file_id });
      const options = {
        hostname: "api.opensubtitles.com",
        path: "/api/v1/download",
        method: "POST",
        headers: {
          "Api-Key": config.opensubtitles_api_key,
          "User-Agent": "StreamVault/" + STREAMVAULT_VERSION,
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      };
      const r = https.request(options, resp => {
        // Follow redirects
        if (resp.statusCode === 301 || resp.statusCode === 302) {
          resp.resume();
          const loc = resp.headers.location;
          const newUrl = loc.startsWith("http") ? new URL(loc) : new URL("https://api.opensubtitles.com" + loc);
          const r2 = https.request({ hostname: newUrl.hostname, path: newUrl.pathname + newUrl.search, method: "POST",
            headers: { "Api-Key": config.opensubtitles_api_key, "User-Agent": "StreamVault/" + STREAMVAULT_VERSION, "Content-Type": "application/json", "Accept": "application/json", "Content-Length": Buffer.byteLength(body) }
          }, resp2 => {
            let d = ""; resp2.on("data", c => d += c);
            resp2.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { console.log("[DOWNLOAD] Parse error:", d.substring(0,200)); reject(new Error("parse")); } });
          });
          r2.on("error", reject); r2.write(body); r2.end();
          return;
        }
        let d = ""; resp.on("data", c => d += c);
        resp.on("end", () => { 
          console.log("[DOWNLOAD] Response status:", resp.statusCode, "body:", d.substring(0, 300));
          try { resolve(JSON.parse(d)); } catch(e) { reject(new Error("parse")); } 
        });
      });
      r.on("error", reject);
      r.write(body); r.end();
    });
    console.log("[DOWNLOAD] linkData:", JSON.stringify(linkData).substring(0, 300));
    if (!linkData.link) return res.status(400).json({ error: "No download link" });
    // Download and save next to the media file
    const item = await dbFindOne(db.media, { _id: media_id });
    if (!item) return res.status(404).json({ error: "Media not found" });
    const dir = path.dirname(item.file_path);
    const baseName = path.basename(item.file_path, path.extname(item.file_path));
    const savePath = path.join(dir, baseName + ".sv.srt");
    await new Promise((resolve, reject) => {
      function download(url) {
        const parsedUrl = new URL(url);
        https.get({ hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search }, r => {
          if (r.statusCode === 301 || r.statusCode === 302) { r.resume(); return download(r.headers.location); }
          const file = fs.createWriteStream(savePath);
          r.pipe(file);
          file.on("finish", () => { file.close(); resolve(); });
        }).on("error", reject);
      }
      download(linkData.link);
    });
    res.json({ ok: true, path: savePath, url: "/api/media/" + media_id + "/subtitle-file?file=" + encodeURIComponent(path.basename(savePath)) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Batch-searches OpenSubtitles for every episode in a season (or a whole show, if no season
// given) and downloads the best match for each — instead of doing it one episode at a time
// manually. Runs sequentially with a pause between episodes to stay well within OpenSubtitles'
// own rate limits, and skips any episode that already has an external subtitle in that
// language on disk.
app.post("/api/subtitles/batch-search", requireAuth, async (req, res) => {
  const { show_id, season, lang = "sv" } = req.body;
  if (!config.opensubtitles_api_key) return res.status(400).json({ error: "Ingen OpenSubtitles API-nyckel är inställd" });
  if (!show_id) return res.status(400).json({ error: "show_id krävs" });

  const query = { type: "episode", parent_id: show_id };
  if (season !== undefined && season !== null && season !== "") query.season = parseInt(season);
  const episodes = await dbFind(db.media, query);
  if (!episodes.length) return res.status(404).json({ error: "Inga avsnitt hittades" });

  // Respond immediately with how many episodes were queued, then keep working in the
  // background — searching+downloading subtitles for a whole season can take a couple of
  // minutes, too long to hold one HTTP request open for.
  res.json({ ok: true, queued: episodes.length });

  let done = 0, found = 0, skipped = 0, failed = 0;
  for (const ep of episodes) {
    try {
      // Skip if this episode already has an external subtitle in this language on disk.
      const dir = path.dirname(ep.file_path);
      const baseName = path.basename(ep.file_path, path.extname(ep.file_path)).toLowerCase();
      const alreadyHasSub = fs.existsSync(dir) && fs.readdirSync(dir).some(f => {
        const fl = f.toLowerCase();
        return fl.startsWith(baseName) && fl.endsWith(`.${lang}.srt`);
      });
      if (alreadyHasSub) {
        skipped++;
        logSubtitle("info", ep, `Batch-sök (OpenSubtitles): hoppar över – har redan en ${lang}-undertext på disk`, { show_id, season });
      } else {
        const show = await dbFindOne(db.media, { _id: ep.parent_id });
        // Hash-based search first (most accurate) — narrowed further with the show's real
        // TMDB id + season/episode when we have it.
        let data = null;
        try {
          const hash = await calcOpenSubtitlesHash(ep.file_path);
          const hashParams = new URLSearchParams({ languages: lang, moviehash: hash });
          if (show?.tmdb_id) {
            hashParams.set("parent_tmdb_id", String(show.tmdb_id));
            hashParams.set("season_number", String(ep.season));
            hashParams.set("episode_number", String(ep.episode));
          }
          const hashData = await doOpenSubsRequest(hashParams);
          if (hashData?.data?.length) data = hashData;
        } catch(e) { /* fall through to id/name search below */ }
        if (!data) {
          const params = new URLSearchParams({ languages: lang });
          if (show?.tmdb_id) {
            // OpenSubtitles' own guidance: when you know the parent id + season/episode,
            // don't ALSO send a text query — it changes how the search is prioritized and
            // can return unrelated results instead of narrowing things down.
            params.set("parent_tmdb_id", String(show.tmdb_id));
            params.set("season_number", String(ep.season));
            params.set("episode_number", String(ep.episode));
          } else {
            // No TMDB id for the show at all — text query is the only option left. Include
            // the show's own name, not just the (often generic, e.g. "Avsnitt 1") episode
            // title, or the search has nothing meaningful to match against.
            params.set("query", `${show?.title || ""} S${String(ep.season).padStart(2,"0")}E${String(ep.episode).padStart(2,"0")}`.trim());
          }
          data = await doOpenSubsRequest(params);
        }
        const results = data?.data || [];
        // Pick the most-downloaded result as the best guess at quality, same signal a person
        // would use when browsing results manually.
        const best = results.slice().sort((a, b) => (b.attributes?.download_count || 0) - (a.attributes?.download_count || 0))[0];
        const fileId = best?.attributes?.files?.[0]?.file_id;
        if (!fileId) {
          skipped++;
          logSubtitle("info", ep, `Batch-sök (OpenSubtitles): ingen träff hittades`, { show_id, season, lang });
        } else {
          await downloadOpenSubtitlesFile(fileId, ep, lang);
          found++;
          logSubtitle("info", ep, `Batch-sök (OpenSubtitles): undertext hämtad`, { show_id, season, lang, release: best.attributes?.release });
        }
      }
    } catch(e) {
      failed++;
      logSubtitle("error", ep, `Batch-sök (OpenSubtitles): misslyckades`, { show_id, season, lang, error: e.message });
    }
    done++;
    // Small pause between episodes so a 24-episode season doesn't hammer OpenSubtitles'
    // API in a tight loop — same spirit as the subtitle-cache queue's own pacing.
    await new Promise(r => setTimeout(r, 1500));
  }
  logSubtitle("info", null, `Batch-sök (OpenSubtitles) klar för säsong ${season ?? "(alla)"}: ${found} hittade, ${skipped} hoppade över, ${failed} misslyckades av ${episodes.length}`, { show_id, season, lang });
});

// Removes external .{lang}.srt files (and their cache entries) for every episode in a season —
// mainly for cleaning up after a batch-search that grabbed wrong subtitles (e.g. before the
// parent_tmdb_id fix), without having to hunt down and delete files by hand one at a time.
app.post("/api/subtitles/batch-remove-external", requireAuth, async (req, res) => {
  const { show_id, season, lang } = req.body;
  if (!show_id || !lang) return res.status(400).json({ error: "show_id och lang krävs" });

  const query = { type: "episode", parent_id: show_id };
  if (season !== undefined && season !== null && season !== "") query.season = parseInt(season);
  const episodes = await dbFind(db.media, query);
  if (!episodes.length) return res.status(404).json({ error: "Inga avsnitt hittades" });

  const cacheDir = path.join(DATA_DIR, "subtitle-cache");
  let removed = 0;
  for (const ep of episodes) {
    try {
      const dir = path.dirname(ep.file_path);
      const baseName = path.basename(ep.file_path, path.extname(ep.file_path));
      const srtPath = path.join(dir, `${baseName}.${lang}.srt`);
      if (fs.existsSync(srtPath)) { fs.unlinkSync(srtPath); removed++; }
      // Also drop the matching cache entry, if the subtitle-cache queue already picked this
      // file up — otherwise the wrong subtitle would still show as "cached" until the next
      // full re-cache noticed it was orphaned.
      const cacheFile = path.join(cacheDir, `${shortMediaId(ep._id)}_ext_${lang}.srt`);
      if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
    } catch(e) {
      logSubtitle("warn", ep, `Kunde inte ta bort extern undertext (${lang})`, { error: e.message });
    }
  }
  logSubtitle("info", null, `Tog bort ${removed} externa ${lang}-undertexter för säsong ${season ?? "(alla)"}`, { show_id, season, lang });
  res.json({ ok: true, removed });
});


// Search local library by cast name via TMDB person search
app.get("/api/search/cast", requireAuth, async (req, res) => {
  const { query } = req.query;
  if (!query || !config.tmdb_api_key) return res.json({ items: [] });
  try {
    // Search for person on TMDB
    const userLang = req.user?.language || null;
    const data = await tmdbFetch(`/search/person?query=${encodeURIComponent(query)}`, userLang);
    const persons = (data?.results || []).slice(0, 3);
    const allMedia = await dbFind(db.media, { type: { $in: ["movie","tvshow"] } });
    const tmdbIds = new Set(allMedia.filter(m => m.tmdb_id).map(m => String(m.tmdb_id)));
    // For each person, find their movies in our library
    const found = [];
    for (const person of persons) {
      const credits = await tmdbFetch(`/person/${person.id}?append_to_response=movie_credits`, userLang);
      if (!credits) continue;
      for (const movie of (credits.movie_credits?.cast || [])) {
        if (tmdbIds.has(String(movie.id))) {
          const localItem = allMedia.find(m => String(m.tmdb_id) === String(movie.id));
          if (localItem && !found.find(f => f.id === localItem._id)) {
            found.push({ ...localItem, id: localItem._id });
          }
        }
      }
    }
    res.json({ items: found.map(i => ({ ...i, file_path: undefined, _id: undefined })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/search/streaming", requireAuth, async (req, res) => {
  const {query}=req.query;
  if (!query||!config.tmdb_api_key) return res.json({results:[]});
  const userLang = req.user?.language || null;
  const data = await tmdbFetch(`/search/multi?query=${encodeURIComponent(query)}`, userLang);
  res.json({results:(data?.results||[]).slice(0,10).map(r=>({
    id:r.id,
    title:r.title||r.name,
    type:r.media_type,
    poster:r.profile_path?`https://image.tmdb.org/t/p/w185${r.profile_path}`:r.poster_path?`https://image.tmdb.org/t/p/w300${r.poster_path}`:null,
    year:(r.release_date||r.first_air_date||"").slice(0,4)
  }))});
});

app.post("/api/scan", requireAdmin, (req, res) => {
  res.json({message:"Skanning startad"});
  scanLibraries().catch(console.error);
});

// Re-queue subtitle caching for every existing movie/episode already in the library.
// Needed because a normal scan only queues NEW items — this catches everything that
// was added before the multi-language subtitle cache existed.
app.post("/api/subtitles/recache-all", requireAdmin, async (req, res) => {
  try {
    const items = await dbFind(db.media, { type: { $in: ["movie", "episode"] } });
    for (const item of items) queueSubtitleCache(item);
    logSubtitle("info", null, `Manuell omcachning startad för ${items.length} filer (admin-begäran)`);
    res.json({ message: `${items.length} filer köade för undertextcachning`, queued: items.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Wipes every cached subtitle file and resets the related DB fields/counters, so the whole
// pipeline can be verified from a genuinely clean slate (e.g. after changing OCR settings or
// testing the auto-download of Tesseract language data). Does NOT touch the OCR allowlist
// itself — that's a setting, not cached data — and doesn't touch the source video files.
app.post("/api/subtitles/clear-cache", requireAdmin, async (req, res) => {
  try {
    const cacheDir = path.join(DATA_DIR, "subtitle-cache");
    let removed = 0;
    if (fs.existsSync(cacheDir)) {
      for (const f of fs.readdirSync(cacheDir)) {
        try { fs.unlinkSync(path.join(cacheDir, f)); removed++; } catch(e) { logSubtitle("warn", null, `Kunde inte ta bort cachefil ${f}`, { error: e.message }); }
      }
    }
    await dbUpdate(db.media, {}, { $unset: { cached_subtitle_langs: true, cached_subtitle_lang: true } }, { multi: true });

    _subtitleCacheDone = 0; _subtitleCacheErrors = 0;
    _subtitleCacheFailed = 0; _subtitleCacheFailedEps = 0;
    _subtitleCacheGated = 0; _subtitleCacheGatedEps = 0;
    _subtitleCacheNoSubs = 0; _subtitleCacheNoSubsEps = 0;
    _subtitleCacheWithSwe = 0; _subtitleCacheWithEng = 0;
    _subtitleCacheWithSweEps = 0; _subtitleCacheWithEngEps = 0;
    _subtitleLangBreakdown = { movies: {}, episodes: {} };

    logSubtitle("info", null, `Undertextcache helt rensad av admin – ${removed} filer borttagna`);
    res.json({ ok: true, removed });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LIVE ACTIVITY (admin dashboard) ────────────────────────────────────────────
// Aggregates everything the "what's happening on my server right now" view needs from the
// in-memory trackers above, plus a recent cross-user history feed (also the foundation for
// future "you watched X, you might like Y" recommendations — same underlying data).
app.get("/api/admin/live-activity", requireAdmin, async (req, res) => {
  try {
    const now = Date.now();

    const transcodeByMediaId = new Map(activeDashTranscodes.entries());
    const sessionMediaIds = [...new Set([...(_activeSessions.values())].map(s => s.mediaId).filter(Boolean))];
    const sessionMedia = sessionMediaIds.length ? Object.fromEntries((await dbFind(db.media, { _id: { $in: sessionMediaIds } })).map(m => [m._id, m])) : {};

    const sessions = [...(_activeSessions.values())].map(s => {
      const t = transcodeByMediaId.get(s.mediaId);
      const item = sessionMedia[s.mediaId];
      let videoInfo = null, audioInfo = null;
      if (t && item) {
        // Merged in from the transcode job directly — this used to be its own separate
        // "Aktiva transkodningar" list; showing it right on the session it belongs to
        // (Plex's own "visa detaljer" style) makes a lot more sense than a disconnected list.
        const isHdr = (item.width || 0) >= 3000 && (item.bit_depth || 8) === 10;
        const srcRes = friendlyResolutionLabel(item.width, item.height);
        const srcCodec = (item.codec || "?").toUpperCase();
        // "Main 10" vs "Main" is inferred from bit depth, not stored directly — HDR content is
        // essentially always 10-bit "Main 10" profile, SDR HEVC is essentially always 8-bit
        // "Main". A reasonable approximation, not a guaranteed-exact readout from the file.
        const profile = srcCodec === "HEVC" ? ((item.bit_depth || 8) === 10 ? " Main 10" : " Main") : "";
        const isHw = /nvenc|amf|qsv/.test(t.videoMode || "");
        videoInfo = {
          source: `${srcRes}${isHdr ? " HDR10" : ""} (${srcCodec}${profile})`,
          target: `1080p (H264) — Transkodas${isHw ? " (GPU)" : ""}`
        };
        const cleanChannels = (t.sourceAudioChannels || "").replace(/\s*\((side|back|front)\)/gi, ""); // ffprobe channel_layout includes technical detail like "5.1(side)" that isn't meaningful to a viewer
        audioInfo = {
          source: t.sourceAudioCodec
            ? `${t.sourceAudioLanguage ? t.sourceAudioLanguage + " " : ""}(${t.sourceAudioCodec.toUpperCase()}${cleanChannels ? " " + cleanChannels : ""})`
            : "Okänt format",
          target: "AAC — Omkodas"
        };
      } else if (item) {
        videoInfo = { source: "Direktuppspelning", target: null };
      }
      return {
        ...s,
        idleSeconds: Math.round((now - s.lastHeartbeat) / 1000),
        progressPct: s.duration > 0 ? Math.min(100, Math.round((s.position / s.duration) * 100)) : 0,
        videoInfo, audioInfo
      };
    });

    const downloads = [...(_activeDownloads.values())].map(d => ({
      ...d,
      progressPct: d.totalBytes > 0 ? Math.min(100, Math.round((d.bytesServed / d.totalBytes) * 100)) : 0,
      idleSeconds: Math.round((now - d.lastActivity) / 1000),
      stalled: (now - d.lastActivity) > 15000
    }));

    // Recent activity feed across all users (not just the requesting admin) — most recent first.
    // Uses NeDB's own sort+limit cursor instead of dbFind({}) — fetching and JS-sorting the
    // WHOLE history collection every 5 seconds (this endpoint is polled that often while the
    // dashboard is open) got noticeably heavy once history had built up from real usage.
    const topHistory = await new Promise((resolve, reject) => {
      db.history.find({}).sort({ watched_at: -1 }).limit(50).exec((err, docs) => err ? reject(err) : resolve(docs));
    });
    const userIds = [...new Set(topHistory.map(h => h.user_id))];
    const mediaIds = [...new Set(topHistory.map(h => h.media_id))];
    const [historyUsers, historyMedia] = await Promise.all([
      dbFind(db.users, { _id: { $in: userIds } }),
      dbFind(db.media, { _id: { $in: mediaIds } })
    ]);
    const userMap = Object.fromEntries(historyUsers.map(u => [u._id, u]));
    const mediaMap = Object.fromEntries(historyMedia.map(m => [m._id, m]));
    const recentHistory = topHistory.map(h => ({
      username: userMap[h.user_id]?.username || "(borttagen användare)",
      title: mediaMap[h.media_id]?.title || "(borttagen film/serie)",
      mediaId: h.media_id,
      position: h.position,
      duration: h.duration,
      completed: !!h.completed,
      watchedAt: h.watched_at
    }));

    res.json({
      sessions,
      downloads,
      recentHistory,
      subtitleQueue: { running: _subtitleCacheRunning, queued: _subtitleCacheQueue.length }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Historical playback analytics — direct-play vs transcode rates over time, which
// container/codec combinations transcode most often (so it's visible at a glance instead of
// manually reading server console logs), and per-title play counts. Reads from the
// append-only playbackLog collection, separate from db.history (resume-position state).
// "Senaste aktivitet" — a chronological feed of "X tittade på Y" / "X såg klart Y", Plex-style.
// Built from db.history (each user's latest watch state per title) rather than a true
// append-only event log — since watched_at updates every time someone plays something, and
// naturally lands on "completed" once they actually finish it, sorting by watched_at gives a
// reasonable approximation of "what happened most recently" without needing a separate log.
// "Spelningshistorik" (Plex-style) — total time watched per week, broken down by content
// type. Same time-approximation caveat as "Mest aktiva användare": derived from db.history's
// position field (each user's latest watch state per title), not a precise per-session
// timer. Weeks are simple rolling 7-day buckets counting back from today, not calendar weeks.
// "Visa all historik" — the full, unaggregated playback log, filterable and paginated.
// Sourced from db.playbackLog (a genuine append-only event log, one row per play request),
// unlike the other history-based cards above which approximate from db.history's
// latest-state-per-title data — this one shows every individual play, exactly as it happened.
app.get("/api/admin/all-history", requireAdmin, async (req, res) => {
  try {
    const query = {};
    if (req.query.user) query.username = req.query.user;
    if (req.query.days) query.at = { $gte: new Date(Date.now() - parseInt(req.query.days) * 86400000).toISOString() };
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;
    const allMatching = (await dbFind(db.playbackLog, query)).sort((a, b) => new Date(b.at) - new Date(a.at));
    const page = allMatching.slice(offset, offset + limit);
    res.json({
      entries: page.map(e => ({
        username: e.username, type: e.type, title: e.title,
        device: e.device, method: e.method, at: e.at
      })),
      total: allMatching.length
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/weekly-history", requireAdmin, async (req, res) => {
  try {
    const weekCount = Math.min(parseInt(req.query.weeks) || 5, 12);
    const now = new Date();
    const weekMs = 7 * 86400000;
    const rangeStart = new Date(now.getTime() - weekCount * weekMs);
    const entries = await dbFind(db.history, { watched_at: { $gte: rangeStart.toISOString() } });
    const mediaIds = [...new Set(entries.map(e => e.media_id))];
    const media = await dbFind(db.media, { _id: { $in: mediaIds } });
    const typeMap = Object.fromEntries(media.map(m => [m._id, m.type]));

    const weeks = [];
    for (let i = weekCount - 1; i >= 0; i--) {
      const weekStart = new Date(now.getTime() - (i + 1) * weekMs);
      const weekEnd = new Date(now.getTime() - i * weekMs);
      weeks.push({ start: weekStart, end: weekEnd, movie: 0, tvshow: 0, music: 0 });
    }
    for (const e of entries) {
      const watchedAt = new Date(e.watched_at);
      const week = weeks.find(w => watchedAt >= w.start && watchedAt < w.end);
      if (!week) continue;
      const type = typeMap[e.media_id];
      const minutes = (e.position || 0) / 60;
      if (type === "movie") week.movie += minutes;
      else if (type === "tvshow") week.tvshow += minutes;
      else if (type === "music") week.music += minutes;
    }

    const fmtDate = (d) => d.toLocaleDateString("sv-SE", { month: "short", day: "numeric" });
    res.json({
      weeks: weeks.map(w => ({
        label: `${fmtDate(w.start)} - ${fmtDate(w.end)}`,
        movie: Math.round(w.movie), tvshow: Math.round(w.tvshow), music: Math.round(w.music)
      })),
      totals: {
        movie: Math.round(weeks.reduce((s, w) => s + w.movie, 0)),
        tvshow: Math.round(weeks.reduce((s, w) => s + w.tvshow, 0)),
        music: Math.round(weeks.reduce((s, w) => s + w.music, 0))
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/recent-activity", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const entries = (await dbFind(db.history, {})).sort((a, b) => new Date(b.watched_at) - new Date(a.watched_at)).slice(0, limit);
    const userIds = [...new Set(entries.map(e => e.user_id))];
    const mediaIds = [...new Set(entries.map(e => e.media_id))];
    const [users, media] = await Promise.all([
      dbFind(db.users, { _id: { $in: userIds } }),
      dbFind(db.media, { _id: { $in: mediaIds } })
    ]);
    const userMap = Object.fromEntries(users.map(u => [u._id, u.username]));
    const mediaMap = Object.fromEntries(media.map(m => [m._id, m]));
    const activity = entries
      .filter(e => userMap[e.user_id] && mediaMap[e.media_id]) // skip entries whose user/media has since been deleted
      .map(e => ({
        username: userMap[e.user_id],
        title: mediaMap[e.media_id].title,
        type: mediaMap[e.media_id].type,
        completed: !!e.completed,
        watched_at: e.watched_at
      }));
    res.json({ activity });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/playback-stats", requireAdmin, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const entries = await dbFind(db.playbackLog, { at: { $gte: since } });

    const totalPlays = entries.length;
    const directCount = entries.filter(e => e.method === "direct").length;
    const transcodeCount = totalPlays - directCount;

    // Which container/codec combos transcode most — the "why does this always transcode"
    // question, answered directly instead of reading console logs one playback at a time.
    const comboMap = new Map();
    for (const e of entries) {
      const key = `${e.container || "?"} / ${e.video_codec || "?"}`;
      if (!comboMap.has(key)) comboMap.set(key, { combo: key, total: 0, transcoded: 0 });
      const c = comboMap.get(key);
      c.total++;
      if (e.method === "dash") c.transcoded++;
    }
    const byContainerCodec = [...comboMap.values()]
      .map(c => ({ ...c, transcodePct: Math.round((c.transcoded / c.total) * 100) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 15);

    // Most-played titles — only counts CONFIRMED plays (genuine watch progress seen, not
    // just play being pressed), so testing/quickly backing out doesn't inflate this list.
    const confirmedEntries = entries.filter(e => e.confirmed);
    const titleMap = new Map();
    for (const e of confirmedEntries) {
      if (!titleMap.has(e.media_id)) titleMap.set(e.media_id, { title: e.title, type: e.type, plays: 0 });
      titleMap.get(e.media_id).plays++;
    }
    const mostWatched = [...titleMap.values()].sort((a, b) => b.plays - a.plays).slice(0, 10);

    // Per-day breakdown for a simple chart — direct vs transcode, last N days
    const dayMap = new Map();
    for (const e of entries) {
      const day = (e.at || "").slice(0, 10);
      if (!day) continue;
      if (!dayMap.has(day)) dayMap.set(day, { date: day, direct: 0, transcode: 0 });
      const d = dayMap.get(day);
      if (e.method === "direct") d.direct++; else d.transcode++;
    }
    const dailyStats = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

    // Per-user breakdown — who's actually using the server, and from what
    const userMap = new Map();
    for (const e of entries) {
      if (!userMap.has(e.username)) userMap.set(e.username, { username: e.username, plays: 0, direct: 0, transcode: 0 });
      const u = userMap.get(e.username);
      u.plays++;
      if (e.method === "direct") u.direct++; else u.transcode++;
    }
    const byUser = [...userMap.values()].sort((a, b) => b.plays - a.plays);

    // "Mest aktiva användare" — minutes watched per content type, not just play counts.
    // Derived from db.history (each user's latest position per title) rather than
    // playbackLog, since that's where actual watch position/duration lives. This is an
    // approximation, not a precise "time actually spent watching" — position reflects
    // wherever playback last left off, so a rewatch-from-scratch after finishing something
    // wouldn't double-count, and a session that was scrubbed around isn't measured as
    // continuously-watched time. Good enough for "who's actually using this and for what",
    // which is the actual question this card answers.
    const historyEntries = await dbFind(db.history, { watched_at: { $gte: since } });
    const historyUserIds = [...new Set(historyEntries.map(h => h.user_id))];
    const historyMediaIds = [...new Set(historyEntries.map(h => h.media_id))];
    const [activeUsersInfo, activeMediaInfo] = await Promise.all([
      dbFind(db.users, { _id: { $in: historyUserIds } }),
      dbFind(db.media, { _id: { $in: historyMediaIds } })
    ]);
    const userInfoMap = Object.fromEntries(activeUsersInfo.map(u => [u._id, u]));
    const mediaTypeMap = Object.fromEntries(activeMediaInfo.map(m => [m._id, m.type]));
    const activeUserMap = new Map();
    for (const h of historyEntries) {
      const uname = userInfoMap[h.user_id]?.username;
      if (!uname) continue; // deleted user — nothing meaningful left to attribute this to
      if (!activeUserMap.has(h.user_id)) activeUserMap.set(h.user_id, { username: uname, plays: 0, minutesByType: { movie: 0, tvshow: 0, music: 0 } });
      const u = activeUserMap.get(h.user_id);
      u.plays++;
      const type = mediaTypeMap[h.media_id];
      const minutes = Math.round((h.position || 0) / 60);
      if (type === "movie") u.minutesByType.movie += minutes;
      else if (type === "tvshow") u.minutesByType.tvshow += minutes;
      else if (type === "music") u.minutesByType.music += minutes;
    }
    const mostActiveUsers = [...activeUserMap.values()]
      .map(u => ({ ...u, totalMinutes: u.minutesByType.movie + u.minutesByType.tvshow + u.minutesByType.music }))
      .sort((a, b) => b.totalMinutes - a.totalMinutes)
      .slice(0, 10);

    res.json({
      days, totalPlays, directCount, transcodeCount, confirmedPlays: confirmedEntries.length,
      directPct: totalPlays ? Math.round((directCount / totalPlays) * 100) : 0,
      byContainerCodec, mostWatched, dailyStats, byUser, mostActiveUsers
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Clears all playback analytics history — meant for wiping out test/development data before
// starting to track real usage, not something needed in normal operation.
app.post("/api/admin/playback-stats/reset", requireAdmin, async (req, res) => {
  try {
    const result = await new Promise((resolve, reject) => {
      db.playbackLog.remove({}, { multi: true }, (err, n) => err ? reject(err) : resolve(n));
    });
    console.log(`[STATS] Uppspelningsstatistik nollställd av admin – ${result} poster borttagna`);
    res.json({ ok: true, removed: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.get("/api/subtitles/cache-status", requireAuth, async (req, res) => {
  const cacheDir = path.join(DATA_DIR, "subtitle-cache");
  let cached = 0;
  try {
    cached = fs.readdirSync(cacheDir).filter(f => f.endsWith(".srt") && !f.startsWith("test")).length;
  } catch {}
  // Count unique shows and episodes from DB (always accurate, not just during scan)
  let totalShows = 0;
  let totalEpsFromDb = 0;
  try {
    const shows = await dbFind(db.media, { type: "tvshow" });
    totalShows = shows.length;
    totalEpsFromDb = await dbCount(db.media, { type: "episode" });
  } catch {}
  // Re-count subtitle cache live if not currently scanning (always accurate)
  if (!_subtitleCacheRunning) await countExistingSubtitleCache();
  res.json({
    total: _subtitleCacheTotal,
    totalEps: _subtitleCacheTotalEps || totalEpsFromDb,
    totalShows,
    withSwe: _subtitleCacheWithSwe,
    withEng: _subtitleCacheWithEng,
    withExtSrt: _subtitleCacheWithExtSrt,
    withSweEps: _subtitleCacheWithSweEps,
    withEngEps: _subtitleCacheWithEngEps,
    withExtSrtEps: _subtitleCacheWithExtSrtEps,
    languageBreakdown: _subtitleLangBreakdown,
    // The "featured" languages to show individually on the dashboard: server default + English
    // + anything the admin has explicitly added — everything else gets lumped into "Övriga språk".
    featuredLanguages: (config.subtitle_ocr_languages && config.subtitle_ocr_languages.length)
      ? config.subtitle_ocr_languages
      : [getServerDefaultSubLang(), "eng"],
    done: _subtitleCacheDone,
    errors: _subtitleCacheErrors,
    failed: _subtitleCacheFailed,
    failedEps: _subtitleCacheFailedEps,
    gated: _subtitleCacheGated,
    gatedEps: _subtitleCacheGatedEps,
    noSubs: _subtitleCacheNoSubs,
    noSubsEps: _subtitleCacheNoSubsEps,
    cached: cached,
    running: _subtitleCacheRunning,
    queued: _subtitleCacheQueue.length
  });
});

// Recent subtitle-cache log entries (successes, warnings, failures) for troubleshooting.
// Kept in memory (most recent 500) and appended to data/logs/subtitles.log on disk.
app.get("/api/subtitles/log", requireAdmin, (req, res) => {
  const level = req.query.level; // optional: "error" | "warn" | "info"
  const limit = Math.min(parseInt(req.query.limit || "200"), 500);
  let entries = _subtitleLogBuffer;
  if (level) entries = entries.filter(e => e.level === level);
  res.json({ entries: entries.slice(0, limit), total: entries.length });
});

app.get("/api/scan/status", requireAuth, async (req, res) => {
  const allMusic = await dbFind(db.media, {type:"music"});
  const musicTracks = allMusic.filter(m => { try { return JSON.parse(m.extra_data||"{}").isTrack; } catch { return false; } }).length;
  const musicAlbums = allMusic.filter(m => { try { return JSON.parse(m.extra_data||"{}").isAlbum; } catch { return false; } }).length;
  const [movies,tvshows,episodes] = await Promise.all([dbCount(db.media,{type:"movie"}),dbCount(db.media,{type:"tvshow"}),dbCount(db.media,{type:"episode"})]);
  const allMoviesForCollections = await dbFind(db.media, {type:"movie", collection_id: {$exists: true}});
  const collectionIds = new Set(allMoviesForCollections.filter(m => m.collection_id).map(m => m.collection_id));
  const collections = collectionIds.size;
  res.json({scanning:isScanning,progress:_scanProgress,counts:[{type:"movie",c:movies,collections},{type:"tvshow",c:tvshows,episodes},{type:"music",c:musicTracks,albums:musicAlbums}]});
});

// Minimal, non-sensitive subset of config — safe for any logged-in user (unlike the full
// /api/config, which includes API keys and is admin-only). Just enough for cosmetic display
// like showing the server's name in the UI.
// Maps our internal 3-letter subtitle-tracking codes to OpenSubtitles' 2-letter ISO codes.
const OPENSUBS_LANG_CODE = { swe:"sv", eng:"en", nor:"no", dan:"da", fin:"fi", deu:"de", fra:"fr", spa:"es", nld:"nl", ita:"it", por:"pt", pol:"pl", jpn:"ja" };
const OPENSUBS_LANG_LABEL = { sv:"Svenska", en:"English", no:"Norsk", da:"Dansk", fi:"Suomi", de:"Deutsch", fr:"Français", es:"Español", nl:"Nederlands", it:"Italiano", pt:"Português", pl:"Polski", ja:"日本語" };

app.get("/api/public-config", requireAuth, (req, res) => {
  // Household's subtitle-search language options — the OCR/cache allowlist if one is set,
  // otherwise just Swedish+English as a sane default. Always includes the requesting user's
  // own configured language too, even if it isn't on the allowlist (e.g. a guest account set
  // to a language nobody else in the household uses), so the manual OpenSubtitles search
  // dropdown is never missing the one language that person actually needs.
  const allowlist = (config.subtitle_ocr_mode !== "all" && Array.isArray(config.subtitle_ocr_languages) && config.subtitle_ocr_languages.length)
    ? config.subtitle_ocr_languages
    : ["swe", "eng"];
  const codes = new Set(allowlist.map(c => OPENSUBS_LANG_CODE[c]).filter(Boolean));
  const userSubLang = USER_LANG_TO_SUB_LANG[req.user?.language];
  if (userSubLang && OPENSUBS_LANG_CODE[userSubLang]) codes.add(OPENSUBS_LANG_CODE[userSubLang]);
  if (!codes.size) codes.add("sv"), codes.add("en");
  const subtitleSearchLanguages = [...codes].map(code => ({ code, label: OPENSUBS_LANG_LABEL[code] || code }));

  res.json({ server_name: config.server_name || null, subtitleSearchLanguages, defaultLanguage: config.language || null, trailerStreamEnabled: !!config.trailer_stream_enabled, iptvEnabled: !!config.iptv_enabled, watchedThresholdPct: config.watched_threshold_pct || 90 });
});

app.get("/api/config", requireAdmin, (req, res) => {
  const s={...config}; delete s.jwt_secret; res.json(s);
});

app.patch("/api/config", requireAdmin, (req, res) => {
  ["tmdb_api_key","opensubtitles_api_key","omdb_api_key","lastfm_api_key","spotify_client_id","spotify_client_secret","port","language","update_channel","server_name","trailer_stream_enabled","iptv_enabled","watched_threshold_pct","continue_watching_max_weeks","continue_watching_max_items","periodic_scan_enabled","periodic_scan_interval_hours","scan_low_priority"].forEach(k=>{if(req.body[k]!==undefined)config[k]=req.body[k];});
  fs.writeFileSync(CONFIG_PATH,JSON.stringify(config,null,2));
  res.json({ok:true});
});

// old update/check endpoint removed
// old version endpoint removed



// ── TMDB IMAGES ──────────────────────────────────────────────────────────────
app.get("/api/media/:id/images", requireAuth, async (req, res) => {
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item || !item.tmdb_id || !config.tmdb_api_key) return res.json({ posters: [], backdrops: [] });
    const endpoint = item.type === "tvshow"
      ? `/tv/${item.tmdb_id}/images?include_image_language=en,sv,null`
      : `/movie/${item.tmdb_id}/images?include_image_language=en,sv,null`;
    const data = await tmdbFetch(endpoint);
    if (!data) return res.json({ posters: [], backdrops: [] });
    const posters = (data.posters||[]).sort((a,b)=>(b.vote_average||0)-(a.vote_average||0)).slice(0,40)
      .map(p => ({ url: `https://image.tmdb.org/t/p/w342${p.file_path}`, full: `https://image.tmdb.org/t/p/original${p.file_path}`, lang: p.iso_639_1, rating: p.vote_average }));
    const backdrops = (data.backdrops||[]).sort((a,b)=>(b.vote_average||0)-(a.vote_average||0)).slice(0,20)
      .map(b => ({ url: `https://image.tmdb.org/t/p/w780${b.file_path}`, full: `https://image.tmdb.org/t/p/original${b.file_path}`, rating: b.vote_average }));
    res.json({ posters, backdrops });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FILE INFO (ffprobe) ───────────────────────────────────────────────────────
// Derives the human-readable chroma subsampling (e.g. "4:2:0") from ffprobe's pix_fmt string
// (e.g. "yuv420p10le") — not a direct ffprobe field, just a well-known naming convention.
function chromaSubsamplingFromPixFmt(pixFmt) {
  if (!pixFmt) return null;
  if (/444/.test(pixFmt)) return "4:4:4";
  if (/422/.test(pixFmt)) return "4:2:2";
  if (/420/.test(pixFmt)) return "4:2:0";
  if (/411/.test(pixFmt)) return "4:1:1";
  return null;
}

app.get("/api/media/:id/fileinfo", requireAdmin, async (req, res) => {
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item) return res.status(404).json({ error: "Hittades inte" });
    let probe = null;
    try {
      const { execSync } = require("child_process");
      const ffprobePath = getFfprobePath();
      const cmd = `"${ffprobePath}" -v quiet -print_format json -show_streams -show_format "${item.file_path.replace(/"/g, '')}"`;
      probe = JSON.parse(execSync(cmd, { timeout: 15000 }).toString());
    } catch {}
    const videoStream = probe?.streams?.find(s => s.codec_type === "video");
    const audioStreams = probe?.streams?.filter(s => s.codec_type === "audio") || [];
    const subtitleStreams = probe?.streams?.filter(s => s.codec_type === "subtitle") || [];
    const fmt = probe?.format || {};

    const videoResLabel = videoStream ? friendlyResolutionLabel(videoStream.width, videoStream.height) : null;
    res.json({
      title: item.title, file_path: item.file_path, file_size: item.file_size, tmdb_id: item.tmdb_id,
      library_id: item.library_id, added_at: item.added_at, year: item.year, type: item.type, rating: item.rating,
      video: videoStream ? {
        codec: videoStream.codec_name?.toUpperCase(), profile: videoStream.profile,
        width: videoStream.width, height: videoStream.height,
        coded_width: videoStream.coded_width || null, coded_height: videoStream.coded_height || null,
        resolution_label: videoResLabel,
        fps: videoStream.r_frame_rate ? (eval(videoStream.r_frame_rate)).toFixed(3).replace(/\.?0+$/, "") : null,
        bitrate: videoStream.bit_rate ? Math.round(videoStream.bit_rate/1000)+" kbps" : (fmt.bit_rate ? Math.round(fmt.bit_rate/1000)+" kbps (container)" : null),
        bit_depth: videoStream.bits_per_raw_sample || null,
        color_space: videoStream.color_space || null, color_range: videoStream.color_range || null,
        color_transfer: videoStream.color_transfer || null, color_primaries: videoStream.color_primaries || null,
        chroma_location: videoStream.chroma_location || null, chroma_subsampling: chromaSubsamplingFromPixFmt(videoStream.pix_fmt),
        level: videoStream.level != null ? (videoStream.level / 10).toFixed(1) : null,
        ref_frames: videoStream.refs || null,
        aspect_ratio: videoStream.display_aspect_ratio || null,
        language: videoStream.tags?.language || null,
        display_title: `${videoResLabel || ""} ${videoStream.bits_per_raw_sample === 10 ? "HDR10 " : ""}(${(videoStream.codec_name||"").toUpperCase()}${videoStream.profile ? " " + videoStream.profile : ""})`.trim()
      } : null,
      audio: audioStreams.map(a => ({
        codec: a.codec_name?.toUpperCase(), channels: a.channels, channel_layout: a.channel_layout,
        language: a.tags?.language || "und", language_tag: a.tags?.language || null,
        bitrate: a.bit_rate ? Math.round(a.bit_rate/1000)+" kbps" : null,
        sampling_rate: a.sample_rate ? `${a.sample_rate} Hz` : null,
        title: a.tags?.title || null,
        display_title: `${subtitleLangLabel(normalizeLangCode(a.tags?.language || "und"))}${a.channel_layout ? " (" + (a.codec_name||"").toUpperCase() + " " + a.channel_layout.replace(/\s*\((side|back|front)\)/gi,"") + ")" : ""}`
      })),
      subtitles: subtitleStreams.map(s => ({
        codec: s.codec_name?.toUpperCase(), language: s.tags?.language || "und", language_tag: s.tags?.language || null,
        title: s.tags?.title || null, forced: s.disposition?.forced === 1, default: s.disposition?.default === 1,
        display_title: `${subtitleLangLabel(normalizeLangCode(s.tags?.language || "und"))}${s.disposition?.forced === 1 ? " Tvingad" : ""} (${(s.codec_name||"").toUpperCase()})`
      })),
      container: {
        format: fmt.format_long_name || fmt.format_name,
        duration: fmt.duration ? Math.round(parseFloat(fmt.duration)) : null,
        bitrate: fmt.bit_rate ? Math.round(fmt.bit_rate/1000)+" kbps" : null,
        size: fmt.size ? (fmt.size/1024/1024/1024).toFixed(2)+" GB" : null
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Raw ffprobe dump — the "Visa rådata" equivalent of Plex's "Visa XML" link, for anyone who
// wants to see literally everything ffprobe reports, not just what we've chosen to surface.
// Same idea as /fileinfo but for the regular detail page (everyone sees this on Plex, not
// just admins) — deliberately excludes file_path and other admin-only detail.
app.get("/api/media/:id/techinfo", requireAuth, async (req, res) => {
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item) return res.status(404).json({ error: "Hittades inte" });
    let probe = null;
    try {
      const { execSync } = require("child_process");
      const ffprobePath = getFfprobePath();
      const cmd = `"${ffprobePath}" -v quiet -print_format json -show_streams "${item.file_path.replace(/"/g, '')}"`;
      probe = JSON.parse(execSync(cmd, { timeout: 15000 }).toString());
    } catch {}
    const videoStream = probe?.streams?.find(s => s.codec_type === "video");
    const audioStream = probe?.streams?.find(s => s.codec_type === "audio" && !isCommentaryTrack(s.tags?.title));
    const subtitleStreams = probe?.streams?.filter(s => s.codec_type === "subtitle") || [];
    const videoResLabel = videoStream ? friendlyResolutionLabel(videoStream.width, videoStream.height) : null;
    const isHdr = videoStream && (videoStream.width || 0) >= 3000 && (videoStream.bits_per_raw_sample || 8) === 10;
    res.json({
      video: videoStream ? `${videoResLabel}${isHdr ? " HDR10" : ""} (${(videoStream.codec_name||"").toUpperCase()}${videoStream.profile ? " " + videoStream.profile : ""})` : null,
      audio: audioStream ? `${subtitleLangLabel(normalizeLangCode(audioStream.tags?.language || "und"))} (${(audioStream.codec_name||"").toUpperCase()}${audioStream.channel_layout ? " " + audioStream.channel_layout.replace(/\s*\((side|back|front)\)/gi,"") : ""})` : null,
      subtitles: subtitleStreams.length ? subtitleStreams.map(s => subtitleLangLabel(normalizeLangCode(s.tags?.language || "und"))).join(", ") : "Av"
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/media/:id/fileinfo/raw", requireAdmin, async (req, res) => {
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item) return res.status(404).json({ error: "Hittades inte" });
    const { execSync } = require("child_process");
    const ffprobePath = getFfprobePath();
    const cmd = `"${ffprobePath}" -v quiet -print_format json -show_streams -show_format "${item.file_path.replace(/"/g, '')}"`;
    const probe = JSON.parse(execSync(cmd, { timeout: 15000 }).toString());
    res.json(probe);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AUDIO TRACKS (for player audio track selection) ──────────────────────────
app.get("/api/media/:id/audio-tracks", requireMediaAccess, async (req, res) => {
  try {
    const item = req.mediaItem;
    const { execSync } = require("child_process");
    const ffprobePath = getFfprobePath();
    const cmd = `"${ffprobePath}" -v quiet -print_format json -show_streams -select_streams a "${item.file_path.replace(/"/g, '')}"`;
    const probe = JSON.parse(execSync(cmd, { timeout: 10000 }).toString());
    const tracks = (probe.streams || []).map((a, i) => ({
      index: a.index,
      trackIndex: i, // relative audio track index for -map 0:a:N
      codec: a.codec_name?.toUpperCase(),
      channels: a.channels,
      channel_layout: a.channel_layout,
      language: a.tags?.language || "und",
      title: a.tags?.title || null,
      default: a.disposition?.default === 1
    }));
    res.json({ tracks });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MANUAL METADATA SEARCH ────────────────────────────────────────────────────
// ── MANUAL METADATA SEARCH ────────────────────────────────────────────────────
app.get("/api/search-meta", requireAuth, async (req, res) => {
  const { query, type = "movie" } = req.query;
  if (!query) return res.status(400).json({ error: "Ange sökterm" });
  if (!config.tmdb_api_key) return res.json({ results: [] });
  try {
    const endpoint = type === "tv"
      ? `/search/tv?query=${encodeURIComponent(query)}`
      : `/search/movie?query=${encodeURIComponent(query)}`;
    const data = await tmdbFetch(endpoint);
    const enData = await tmdbFetch(endpoint, "en-US");
    const enMap = new Map((enData?.results || []).map(r => [r.id, r.title || r.name]));
    const results = (data?.results || []).slice(0, 10).map(r => ({
      tmdb_id: r.id,
      title: enMap.get(r.id) || r.title || r.name,
      year: (r.release_date || r.first_air_date || "").slice(0, 4),
      overview: r.overview || "",
      poster_url: r.poster_path ? `https://image.tmdb.org/t/p/w200${r.poster_path}` : null,
      backdrop_url: r.backdrop_path ? `https://image.tmdb.org/t/p/w1280${r.backdrop_path}` : null,
      rating: r.vote_average || null
    }));
    res.json({ results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/media/:id/fix-meta", requireAdmin, async (req, res) => {
  const { tmdb_id, title, year, overview, poster_url, backdrop_url, rating } = req.body;
  if (!tmdb_id) return res.status(400).json({ error: "Saknar tmdb_id" });
  try {
    const existing = await dbFindOne(db.media, { _id: req.params.id });
    const kind = existing?.type === "tvshow" ? "tv" : "movie";

    // Same "poster always English" policy as the automatic scan (getMovieMeta/getTVMeta) —
    // without this, a manual "Fixa info" match saved whatever poster_path came back from the
    // search results, which reflects the SERVER's default language (e.g. Swedish), not
    // English. Re-resolves the poster explicitly here at the actual save point, so it applies
    // regardless of which language the poster_url the frontend sent happened to be in.
    let finalPosterUrl = poster_url;
    try {
      const images = await tmdbFetch(`/${kind}/${tmdb_id}/images?include_image_language=en,null`);
      const posters = images?.posters || [];
      const englishPoster = posters.find(p => p.iso_639_1 === "en") || posters[0];
      if (englishPoster?.file_path) finalPosterUrl = `https://image.tmdb.org/t/p/w500${englishPoster.file_path}`;
    } catch(e) {
      // Keep whatever poster_url was sent — not worth failing the whole save over.
    }

    // Same reasoning applies to the overview text — TMDB frequently has no translated
    // overview for less mainstream titles (older shows especially), even though the search
    // itself succeeded. Without this, a genuinely empty Swedish overview from the search
    // preview just got saved as empty text, showing no description at all.
    let finalOverview = overview;
    if (!finalOverview) {
      try {
        const enData = await tmdbFetch(`/${kind}/${tmdb_id}`, "en-US");
        if (enData?.overview) finalOverview = enData.overview;
      } catch(e) {
        // Keep whatever (empty) overview was sent — not worth failing the whole save over.
      }
    }

    await dbUpdate(db.media, { _id: req.params.id }, {
      $set: { tmdb_id, title, year: year ? parseInt(year) : undefined, overview: finalOverview, poster_url: finalPosterUrl, backdrop_url, rating }
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── SPOTIFY ARTIST IMAGE ─────────────────────────────────────────────────────
let _spotifyToken = null;
let _spotifyTokenExpiry = 0;
let _spotifyTokenPromise = null;
const _spotifyCache = new Map(); // Cache artist/album results
let _spotifyLastCall = 0;
let _spotifyRetryAfter = 0; // Timestamp when we can call Spotify again

async function getSpotifyToken() {
  if (_spotifyToken && Date.now() < _spotifyTokenExpiry) return _spotifyToken;
  if (!config.spotify_client_id || !config.spotify_client_secret) return null;
  // If already fetching, wait for that promise
  if (_spotifyTokenPromise) return _spotifyTokenPromise;
  console.log("[SPOTIFY] Fetching new token...");
  _spotifyTokenPromise = (async () => {
  try {
    const creds = Buffer.from(`${config.spotify_client_id}:${config.spotify_client_secret}`).toString("base64");
    const data = await new Promise((resolve, reject) => {
      const body = "grant_type=client_credentials";
      const req = https.request({
        hostname: "accounts.spotify.com", path: "/api/token", method: "POST",
        headers: { "Authorization": `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
      }, res => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error("Parse error")); } });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
    if (data.access_token) {
      _spotifyToken = data.access_token;
      _spotifyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
      _spotifyTokenPromise = null;
      return _spotifyToken;
    }
  } catch(e) { console.log("[SPOTIFY] Token error:", e.message); }
  _spotifyTokenPromise = null;
  return null;
  })();
  return _spotifyTokenPromise;
}

function cleanArtistName(name) {
  let n = name;
  n = n.replace(/\([^)]*\)/g, "");
  n = n.replace(/(19|20)\d{2}/g, "");
  n = n.replace(/\s+[-–]\s+.+$/, "");
  n = n.replace(/_/g, " ");
  n = n.replace(/(remastered|deluxe|edition|greatest|hits|best|collection|anthology|vol|volume|cd|disc|lp|ep|single|live|acoustic|unplugged|remix|reissue|expanded|cta|nbd|se)/gi, "");
  n = n.replace(/\s+/g, " ").trim();
  return n;
}

app.get("/api/spotify/artist/:name", requireAuth, async (req, res) => {
  try {
    const cacheKey = "artist:" + req.params.name;
    // Check memory cache first
    if (_spotifyCache.has(cacheKey)) return res.json(_spotifyCache.get(cacheKey));
    // Check DB cache
    const dbCached = await dbFindOne(db.spotifyCache, { _id: cacheKey });
    if (dbCached) {
      _spotifyCache.set(cacheKey, dbCached.data);
      return res.json(dbCached.data);
    }
    const token = await getSpotifyToken();
    if (!token) return res.json({ image: null });
    // Rate limit: wait if needed
    if (Date.now() < _spotifyRetryAfter) {
      await new Promise(r => setTimeout(r, _spotifyRetryAfter - Date.now()));
    }
    const now = Date.now();
    const wait = Math.max(0, _spotifyLastCall + 1000 - now);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _spotifyLastCall = Date.now();
    const rawName = req.params.name;
    const cleanName = cleanArtistName(rawName);
    // Try clean name first, fall back to raw if no results
    const trySearch = async (name) => {
      // Check if we're still in retry-after period
      if (Date.now() < _spotifyRetryAfter) {
        const wait = _spotifyRetryAfter - Date.now();
        console.log(`[SPOTIFY] Waiting ${Math.ceil(wait/1000)}s for rate limit...`);
        await new Promise(r => setTimeout(r, wait));
      }
      return new Promise((resolve) => {
        https.get({
          hostname: "api.spotify.com",
          path: `/v1/search?q=${encodeURIComponent(name)}&type=artist&limit=1`,
          headers: { "Authorization": `Bearer ${token}` }
        }, r => {
          if (r.statusCode === 429) {
            const retryAfter = parseInt(r.headers["retry-after"] || "30");
            _spotifyRetryAfter = Date.now() + (retryAfter + 1) * 1000;
            console.log(`[SPOTIFY] Rate limited! Retry after ${retryAfter}s`);
            r.resume();
            resolve(null);
            return;
          }
          let d = ""; r.on("data", c => d += c);
          r.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
        }).on("error", () => resolve(null));
      });
    };
    let search = await trySearch(cleanName);
    let artist = search?.artists?.items?.[0];
    // If no result with clean name and it differs, try raw name
    if (!artist && cleanName !== rawName) {
      search = await trySearch(rawName);
      artist = search?.artists?.items?.[0];
    }
    const image = artist?.images?.[0]?.url || null;
    // Proxy the image through our server to avoid CORS issues
    const proxyImage = image ? `/api/proxy-image?url=${encodeURIComponent(image)}` : null;
    const result = { image: proxyImage, name: artist?.name || null, searched: cleanName };
    _spotifyCache.set(cacheKey, result);
    // Only save to DB if we got an image (don't cache failures)
    if (proxyImage) {
      dbInsert(db.spotifyCache, { _id: cacheKey, data: result }).catch(() => {});
    }
    res.json(result);
  } catch(e) { res.json({ image: null }); }
});

// ── IMAGE PROXY ──────────────────────────────────────────────────────────────
app.get("/api/proxy-image", async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith("https://")) return res.status(400).end();
  try {
    const parsed = new URL(url);
    const req2 = https.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search }, r => {
      res.setHeader("Content-Type", r.headers["content-type"] || "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=86400");
      r.pipe(res);
    });
    req2.on("error", () => res.status(500).end());
  } catch { res.status(500).end(); }
});

// ── SPOTIFY ALBUM IMAGE ──────────────────────────────────────────────────────
app.get("/api/spotify/album/:artist/:album", requireAuth, async (req, res) => {
  try {
    const albumCacheKey = "album:" + req.params.artist + ":" + req.params.album;
    if (_spotifyCache.has(albumCacheKey)) return res.json(_spotifyCache.get(albumCacheKey));
    const dbCached = await dbFindOne(db.spotifyCache, { _id: albumCacheKey });
    if (dbCached) {
      _spotifyCache.set(albumCacheKey, dbCached.data);
      return res.json(dbCached.data);
    }
    const token = await getSpotifyToken();
    if (!token) return res.json({ image: null });
    // Rate limit
    if (Date.now() < _spotifyRetryAfter) {
      await new Promise(r => setTimeout(r, _spotifyRetryAfter - Date.now()));
    }
    const nowAlbum = Date.now();
    const waitAlbum = Math.max(0, _spotifyLastCall + 1000 - nowAlbum);
    if (waitAlbum > 0) await new Promise(r => setTimeout(r, waitAlbum));
    _spotifyLastCall = Date.now();
    const artist = cleanArtistName(decodeURIComponent(req.params.artist));
    let album = decodeURIComponent(req.params.album)
      .replace(/[_]/g, " ")
      .replace(/\s+(fr[åa]n|from|vol|volume|del|part)\.?\s+\d{2,4}/gi, "")
      .replace(/(19|20)\d{2}/g, "")
      .replace(/\([^)]*\)/g, "")
      .replace(/\s+/g, " ").trim();
    // Remove artist name from album name if present
    const artistLower = artist.toLowerCase();
    if (album.toLowerCase().startsWith(artistLower)) {
      album = album.slice(artist.length).replace(/^[\s\-–]+/, "").trim();
    }
    // Remove leading/trailing dashes and years
    album = album.replace(/^[\s\-–]+|[\s\-–]+$/g, "").trim();
    const spotifySearch = async (q) => new Promise((resolve) => {
      https.get({
        hostname: "api.spotify.com",
        path: `/v1/search?q=${encodeURIComponent(q)}&type=album&limit=1`,
        headers: { "Authorization": `Bearer ${token}` }
      }, r => {
        if (r.statusCode === 429) {
          const retryAfter = parseInt(r.headers["retry-after"] || "30");
          _spotifyRetryAfter = Date.now() + (retryAfter + 1) * 1000;
          r.resume();
          resolve(null);
          return;
        }
        let d = ""; r.on("data", c => d += c);
        r.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      }).on("error", () => resolve(null));
    });
    let search = await spotifySearch(`album:${album} artist:${artist}`);
    let albumResult = search?.albums?.items?.[0];
    // Fallback: broader search if exact match fails
    if (!albumResult) {
      search = await spotifySearch(`${album} ${artist}`);
      albumResult = search?.albums?.items?.[0];
    }
    const image = albumResult?.images?.[0]?.url || null;
    const proxyImage = image ? `/api/proxy-image?url=${encodeURIComponent(image)}` : null;
    const albumResultData = { image: proxyImage, name: albumResult?.name || null };
    _spotifyCache.set(albumCacheKey, albumResultData);
    if (proxyImage) {
      dbInsert(db.spotifyCache, { _id: albumCacheKey, data: albumResultData }).catch(() => {});
    }
    res.json(albumResultData);
  } catch(e) { res.json({ image: null }); }
});

// ── CLEAR SPOTIFY CACHE ──────────────────────────────────────────────────────
app.delete("/api/spotify/cache", requireAdmin, async (req, res) => {
  _spotifyCache.clear();
  _spotifyRetryAfter = 0;
  await new Promise(resolve => db.spotifyCache.remove({}, { multi: true }, resolve));
  res.json({ ok: true });
});

// ── LOCAL COVER ART LOOKUP ───────────────────────────────────────────────────
const COVER_FILENAMES = ["cover.jpg","cover.jpeg","cover.png","folder.jpg","folder.jpeg","folder.png","artist.jpg","artist.png","album.jpg","album.png"];

function findLocalCover(folderPath) {
  try {
    if (!fs.existsSync(folderPath)) return null;
    const files = fs.readdirSync(folderPath);
    for (const name of COVER_FILENAMES) {
      const match = files.find(f => f.toLowerCase() === name);
      if (match) return path.join(folderPath, match);
    }
  } catch {}
  return null;
}

// Serve a local cover file by folder path (base64url encoded id, same as media _id)
app.get("/api/music/local-cover/:folderId", async (req, res) => {
  try {
    const folderPath = Buffer.from(req.params.folderId, "base64url").toString();
    const coverPath = findLocalCover(folderPath);
    if (!coverPath) return res.status(404).end();
    res.sendFile(coverPath);
  } catch(e) { res.status(500).end(); }
});

// Check if a folder has a local cover (used by frontend before falling back to Spotify)
app.get("/api/music/has-local-cover/:folderId", requireAuth, async (req, res) => {
  try {
    const folderPath = Buffer.from(req.params.folderId, "base64url").toString();
    const coverPath = findLocalCover(folderPath);
    res.json({ hasLocal: !!coverPath, url: coverPath ? `/api/music/local-cover/${req.params.folderId}` : null });
  } catch(e) { res.json({ hasLocal: false }); }
});

// ── MUSIC COVER UPLOAD (manual image upload, base64) ─────────────────────────
const COVER_UPLOAD_DIR = path.join(DATA_DIR, "music-covers");
if (!fs.existsSync(COVER_UPLOAD_DIR)) fs.mkdirSync(COVER_UPLOAD_DIR, { recursive: true });

app.post("/api/music/upload-cover", requireAuth, async (req, res) => {
  try {
    const { imageBase64, kind, folderKey, artistFolderKey } = req.body;
    if (!imageBase64 || !folderKey) return res.status(400).json({ error: "Saknar data" });
    const matches = imageBase64.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: "Ogiltig bilddata" });
    const ext = matches[1] === "jpeg" ? "jpg" : matches[1];
    const buffer = Buffer.from(matches[2], "base64");
    const fileName = `${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;
    const filePath = path.join(COVER_UPLOAD_DIR, fileName);
    fs.writeFileSync(filePath, buffer);
    const imageUrl = `/api/music/cover-upload/${fileName}`;

    // Save as override (same as Spotify override)
    const cacheKey = kind === "artist" ? "artist:" + decodeURIComponent(folderKey) : "album:" + decodeURIComponent(artistFolderKey) + ":" + decodeURIComponent(folderKey);
    const result = { image: imageUrl, name: null, manual: true, uploaded: true };
    _spotifyCache.set(cacheKey, result);
    await dbUpdate(db.spotifyCache, { _id: cacheKey }, { _id: cacheKey, data: result }, { upsert: true });

    res.json({ ok: true, url: imageUrl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/music/cover-upload/:filename", async (req, res) => {
  const filePath = path.join(COVER_UPLOAD_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

// ── MUSIC FIX META (manual artist/album search and override) ─────────────────
app.get("/api/spotify/search-artists", requireAuth, async (req, res) => {
  try {
    const token = await getSpotifyToken();
    if (!token) return res.json({ results: [] });
    if (Date.now() < _spotifyRetryAfter) {
      return res.json({ results: [], rateLimited: true, retryAfterSec: Math.ceil((_spotifyRetryAfter - Date.now())/1000) });
    }
    const now = Date.now();
    const wait = Math.max(0, _spotifyLastCall + 1000 - now);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _spotifyLastCall = Date.now();
    const search = await new Promise((resolve) => {
      https.get({
        hostname: "api.spotify.com",
        path: `/v1/search?q=${encodeURIComponent(req.query.q||"")}&type=artist&limit=8`,
        headers: { "Authorization": `Bearer ${token}` }
      }, r => {
        if (r.statusCode === 429) {
          const retryAfter = parseInt(r.headers["retry-after"] || "30");
          _spotifyRetryAfter = Date.now() + (retryAfter + 1) * 1000;
          r.resume(); resolve(null); return;
        }
        let d = ""; r.on("data", c => d += c);
        r.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      }).on("error", () => resolve(null));
    });
    const results = (search?.artists?.items || []).map(a => ({
      id: a.id, name: a.name,
      image: a.images?.[0]?.url ? `/api/proxy-image?url=${encodeURIComponent(a.images[0].url)}` : null,
      popularity: a.popularity
    }));
    res.json({ results });
  } catch(e) { res.json({ results: [] }); }
});

app.get("/api/spotify/search-albums", requireAuth, async (req, res) => {
  try {
    const token = await getSpotifyToken();
    if (!token) return res.json({ results: [] });
    if (Date.now() < _spotifyRetryAfter) {
      return res.json({ results: [], rateLimited: true, retryAfterSec: Math.ceil((_spotifyRetryAfter - Date.now())/1000) });
    }
    const now = Date.now();
    const wait = Math.max(0, _spotifyLastCall + 1000 - now);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _spotifyLastCall = Date.now();
    const search = await new Promise((resolve) => {
      https.get({
        hostname: "api.spotify.com",
        path: `/v1/search?q=${encodeURIComponent(req.query.q||"")}&type=album&limit=8`,
        headers: { "Authorization": `Bearer ${token}` }
      }, r => {
        if (r.statusCode === 429) {
          const retryAfter = parseInt(r.headers["retry-after"] || "30");
          _spotifyRetryAfter = Date.now() + (retryAfter + 1) * 1000;
          r.resume(); resolve(null); return;
        }
        let d = ""; r.on("data", c => d += c);
        r.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      }).on("error", () => resolve(null));
    });
    const results = (search?.albums?.items || []).map(a => ({
      id: a.id, name: a.name, artist: a.artists?.[0]?.name || "",
      image: a.images?.[0]?.url ? `/api/proxy-image?url=${encodeURIComponent(a.images[0].url)}` : null
    }));
    res.json({ results });
  } catch(e) { res.json({ results: [] }); }
});

// Manually override an artist's cached image (by original folder name)
app.post("/api/spotify/artist-override", requireAuth, async (req, res) => {
  try {
    const { folderName, image, name } = req.body;
    if (!folderName) return res.status(400).json({ error: "folderName krävs" });
    const cacheKey = "artist:" + folderName;
    const result = { image, name: name || null, searched: folderName, manual: true };
    _spotifyCache.set(cacheKey, result);
    await dbUpdate(db.spotifyCache, { _id: cacheKey }, { _id: cacheKey, data: result }, { upsert: true });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Manually override an album's cached image
app.post("/api/spotify/album-override", requireAuth, async (req, res) => {
  try {
    const { artistFolder, albumFolder, image, name } = req.body;
    if (!artistFolder || !albumFolder) return res.status(400).json({ error: "artistFolder och albumFolder krävs" });
    const cacheKey = "album:" + artistFolder + ":" + albumFolder;
    const result = { image, name: name || null, manual: true };
    _spotifyCache.set(cacheKey, result);
    await dbUpdate(db.spotifyCache, { _id: cacheKey }, { _id: cacheKey, data: result }, { upsert: true });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── LAST.FM ARTIST IMAGE ─────────────────────────────────────────────────────
app.get("/api/lastfm/artist/:name", requireAuth, async (req, res) => {
  if (!config.lastfm_api_key) return res.json({ image: null, bio: null, tags: [] });
  try {
    const cacheKey = "lastfm_bio:" + req.params.name;
    const dbCached = await dbFindOne(db.spotifyCache, { _id: cacheKey });
    if (dbCached) return res.json(dbCached.data);

    const name = encodeURIComponent(req.params.name);
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=${name}&api_key=${config.lastfm_api_key}&format=json`;
    const data = await new Promise(resolve => {
      https.get(url, r => {
        let d = ""; r.on("data", c => d += c);
        r.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      }).on("error", () => resolve(null));
    });
    const images = data?.artist?.image || [];
    const large = images.find(i => i.size === "extralarge") || images.find(i => i.size === "large");
    const image = large?.["#text"] || null;
    const isPlaceholder = !image || image === "" || image.includes("2a96cbd8b46e442fc41c2b86b821562f");

    // Extract bio - strip HTML and Last.fm's "Read more" link
    let bio = data?.artist?.bio?.content || data?.artist?.bio?.summary || null;
    if (bio) {
      bio = bio.replace(/<a href="[^"]*">Read more on Last\.fm<\/a>\.?/i, "").trim();
      bio = bio.replace(/<[^>]+>/g, "").trim(); // strip any remaining HTML
    }
    const tags = (data?.artist?.tags?.tag || []).slice(0, 5).map(t => t.name);
    const listeners = data?.artist?.stats?.listeners || null;
    const playcount = data?.artist?.stats?.playcount || null;

    const result = {
      image: isPlaceholder ? null : image,
      bio, tags, listeners, playcount
    };

    // Only cache if we got useful data
    if (bio || tags.length) {
      dbInsert(db.spotifyCache, { _id: cacheKey, data: result }).catch(() => {});
    }
    res.json(result);
  } catch(e) { res.json({ image: null, bio: null, tags: [] }); }
});

// ── COLLECTION FULL DATA (from TMDB) ─────────────────────────────────────────
app.patch("/api/collections/:collection_id", requireAdmin, async (req, res) => {
  try {
    const { collection_id } = req.params;
    const { name, poster_url, backdrop_url, movie_ids } = req.body;

    // Update all movies: remove from collection if not in movie_ids, add if in movie_ids
    const allMovies = await dbFind(db.media, { type: "movie" });
    for (const movie of allMovies) {
      const shouldBeInCollection = movie_ids && movie_ids.includes(movie._id);
      const isInCollection = String(movie.collection_id) === String(collection_id);

      if (shouldBeInCollection && !isInCollection) {
        await dbUpdate(db.media, { _id: movie._id }, { $set: { collection_id: parseInt(collection_id) || collection_id } });
      } else if (!shouldBeInCollection && isInCollection) {
        await dbUpdate(db.media, { _id: movie._id }, { $unset: { collection_id: true, collection_name: true } });
      }
    }

    // Update collection metadata on all movies in collection
    if (name || poster_url !== undefined || backdrop_url !== undefined) {
      const updates = {};
      if (name) updates.collection_name = name;
      if (poster_url !== undefined) updates.collection_poster = poster_url;
      if (backdrop_url !== undefined) updates.collection_backdrop = backdrop_url;
      if (Object.keys(updates).length) {
        await dbUpdate(db.media, { collection_id: parseInt(collection_id) || collection_id }, { $set: updates }, { multi: true });
      }
    }

    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/tmdb/collection-images", requireAuth, async (req, res) => {
  try {
    if (!config.tmdb_api_key) return res.json({ posters: [], backdrops: [] });
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "id required" });
    const data = await tmdbFetch(`/collection/${id}/images`);
    res.json({ posters: data?.posters || [], backdrops: data?.backdrops || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/collections/:collection_id/full", requireAuth, async (req, res) => {
  try {
    if (!config.tmdb_api_key) return res.json({ parts: [] });
    const data = await tmdbFetch(`/collection/${req.params.collection_id}`);
    if (!data) return res.json({ parts: [] });
    // Find which parts we have locally
    const allMedia = await dbFind(db.media, { type: "movie" });
    const localTmdbIds = new Set(allMedia.filter(m => m.tmdb_id).map(m => String(m.tmdb_id)));
    const parts = (data.parts || [])
      .sort((a,b) => (a.release_date||"").localeCompare(b.release_date||""))
      .map(p => ({
        tmdb_id: p.id,
        title: p.title,
        year: p.release_date ? parseInt(p.release_date) : null,
        poster_url: p.poster_path ? `https://image.tmdb.org/t/p/w342${p.poster_path}` : null,
        in_library: localTmdbIds.has(String(p.id))
      }));
    res.json({ name: data.name, parts });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── COLLECTIONS ──────────────────────────────────────────────────────────────
// Collection names have the same scan-time-language problem overview text had — stored once
// during scanning, always in the server's own default language, never re-fetched per viewing
// user. Cached per collection+language so this stays fast on repeat visits, and only touches
// TMDB at all for users whose language isn't Swedish.
const _collectionNameCache = new Map(); // `${collection_id}:${lang}` -> name
async function translatedCollectionName(collectionId, fallbackName, userLang) {
  if (!userLang || userLang.startsWith("sv")) return fallbackName;
  const cacheKey = `${collectionId}:${userLang}`;
  if (_collectionNameCache.has(cacheKey)) return _collectionNameCache.get(cacheKey);
  try {
    const data = await tmdbFetch(`/collection/${collectionId}`, userLang);
    let name = data?.name;
    // Same original-language leak issue as overview text — if the requested language isn't
    // genuinely translated, fall back to English rather than trusting whatever came back.
    if (!name || name === fallbackName) {
      const enData = await tmdbFetch(`/collection/${collectionId}`, "en-US");
      if (enData?.name) name = enData.name;
    }
    name = name || fallbackName;
    _collectionNameCache.set(cacheKey, name);
    return name;
  } catch { return fallbackName; }
}

app.get("/api/collections", requireAuth, async (req, res) => {
  try {
    const movies = await dbFind(db.media, { type: "movie", collection_id: { $exists: true } });
    const collectionsMap = {};
    movies.filter(m => m.collection_id).forEach(m => {
      const id = m.collection_id;
      if (!collectionsMap[id]) {
        collectionsMap[id] = {
          id, name: m.collection_name, poster_url: m.collection_poster,
          backdrop_url: m.collection_backdrop, movies: []
        };
      }
      collectionsMap[id].movies.push({ ...m, file_path: undefined, _id: undefined, id: m._id });
    });
    // Only return collections with 2+ movies
    let collections = Object.values(collectionsMap).filter(c => c.movies.length >= 2);
    const userLang = req.user?.language || null;
    if (userLang && !userLang.startsWith("sv")) {
      collections = await Promise.all(collections.map(async c => ({
        ...c, name: await translatedCollectionName(c.id, c.name, userLang)
      })));
    }
    collections.sort((a,b) => (a.name||"").localeCompare(b.name||""));
    res.json(collections);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MEDIA DETAILS (cast, crew, genres) ───────────────────────────────────────
// IMDb, Rotten Tomatoes, and Metacritic scores — TMDB doesn't have these itself, but OMDb
// wraps all three in a single free call, matched by title+year rather than needing an IMDb
// ID lookup first. Cached indefinitely per title+year in memory (these scores essentially
// never change once a title has settled), so this only costs a real API call the first time
// any given title is looked up, not on every page view.
const _omdbCache = new Map(); // `${title}:${year}` -> ratings object (or null if not found)
app.get("/api/ratings", requireAuth, async (req, res) => {
  if (!config.omdb_api_key) return res.json({});
  const { title, year } = req.query;
  if (!title) return res.status(400).json({ error: "Saknar titel" });
  const cacheKey = `${title.toLowerCase()}:${year||""}`;
  if (_omdbCache.has(cacheKey)) return res.json(_omdbCache.get(cacheKey) || {});
  try {
    const params = new URLSearchParams({ t: title, apikey: config.omdb_api_key });
    if (year) params.set("y", year);
    const url = `https://www.omdbapi.com/?${params.toString()}`;
    const resp = await new Promise((resolve, reject) => {
      https.get(url, r => {
        let body = "";
        r.on("data", c => body += c);
        r.on("end", () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      }).on("error", reject);
    });
    if (resp.Response === "False") { _omdbCache.set(cacheKey, null); return res.json({}); }
    const ratings = {
      imdb: resp.imdbRating && resp.imdbRating !== "N/A" ? parseFloat(resp.imdbRating) : null,
      imdb_votes: resp.imdbVotes && resp.imdbVotes !== "N/A" ? resp.imdbVotes : null,
      imdb_id: resp.imdbID || null,
      rotten_tomatoes: null,
      metacritic: resp.Metascore && resp.Metascore !== "N/A" ? parseInt(resp.Metascore) : null
    };
    const rt = (resp.Ratings||[]).find(r => r.Source === "Rotten Tomatoes");
    if (rt) ratings.rotten_tomatoes = parseInt(rt.Value); // comes back as "87%" — parseInt stops at the %, giving just the number
    _omdbCache.set(cacheKey, ratings);
    res.json(ratings);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/media/:id/details", requireAuth, async (req, res) => {
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item || !item.tmdb_id || !config.tmdb_api_key) return res.json({ cast: [], crew: [], genres: [], runtime: null, overview: null, reviews: [] });
    const userLang = req.user?.language || null;
    const endpoint = item.type === "tvshow"
      ? `/tv/${item.tmdb_id}?append_to_response=aggregate_credits,reviews`
      : `/movie/${item.tmdb_id}?append_to_response=credits,reviews`;
    const data = await tmdbFetch(endpoint, userLang);
    if (!data) return res.json({ cast: [], crew: [], genres: [], runtime: null, overview: null, reviews: [] });
    // TV shows use aggregate_credits for full series cast
    const castSource = item.type === "tvshow"
      ? (data.aggregate_credits?.cast || data.credits?.cast || [])
      : (data.credits?.cast || []);
    const cast = castSource.slice(0, 50).map(p => ({
      id: p.id, name: p.name,
      character: p.character || (p.roles?.[0]?.character) || "",
      profile_url: p.profile_path ? `https://image.tmdb.org/t/p/w185${p.profile_path}` : null
    }));
    const crew = (data.credits?.crew || [])
      .filter(p => ["Director","Creator","Writer"].includes(p.job))
      .slice(0, 5).map(p => ({ id: p.id, name: p.name, job: p.job }));
    const genres = (data.genres || []).map(g => g.name);
    const runtime = data.runtime || (data.episode_run_time?.[0]) || null;
    // Real TMDB user reviews — genuine content/rating/date, but no like/reaction counts like
    // Plex shows, since those come from Plex's own community layer that we have no
    // equivalent of. Reviews are very often missing when requested in less common languages
    // — TMDB just returns an empty array rather than falling back itself — so this falls back
    // to an explicit English request when that happens.
    //
    // Overview needed a stronger fix than "empty means missing": TMDB sometimes fills a
    // missing translation slot with the movie's own ORIGINAL-language text instead of
    // actually leaving it empty (e.g. a Swedish film's "fi-FI" overview can silently be the
    // Swedish text). An empty check can't catch that — it isn't empty, just wrong — so for
    // anyone whose language isn't Swedish or English, the English version is always fetched
    // and preferred outright, rather than only used as a last resort.
    let reviewResults = data.reviews?.results || [];
    let overview = data.overview || null;
    const userLangBase = (userLang || "").slice(0, 2).toLowerCase();
    // Only worth the extra check when the movie's own original language ISN'T what the user
    // requested — that's the specific situation where TMDB can silently substitute its
    // original-language text into a missing translation slot instead of leaving it empty.
    const needsEnglishCheck = userLang !== "en-US" && userLang !== "en" && userLang !== "sv-SE" && userLang !== "sv"
      && data.original_language && data.original_language !== userLangBase && data.original_language !== "en";
    if ((!reviewResults.length || needsEnglishCheck) && userLang !== "en-US" && userLang !== "en") {
      const enData = await tmdbFetch(item.type === "tvshow" ? `/tv/${item.tmdb_id}?append_to_response=reviews` : `/movie/${item.tmdb_id}?append_to_response=reviews`, "en-US");
      if (!reviewResults.length) reviewResults = enData?.reviews?.results || [];
      if (needsEnglishCheck && enData?.overview) overview = enData.overview;
      else if (!overview) overview = enData?.overview || null;
    }
    const reviews = mapTmdbReviews(reviewResults);
    res.json({ cast, crew, genres, runtime, overview, reviews });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TV SHOW SEASON DATA ──────────────────────────────────────────────────────
app.get("/api/tvshow/:id/seasons", requireAuth, async (req, res) => {
  try {
    const show = await dbFindOne(db.media, { _id: req.params.id });
    if (!show) return res.status(404).json({ error: "Hittades inte" });

    // Get all episodes for this show from DB
    const episodes = await dbFind(db.media, { parent_id: req.params.id, type: "episode" });

    // Group by season
    const seasonMap = {};
    episodes.forEach(ep => {
      const s = ep.season || 0;
      if (!seasonMap[s]) seasonMap[s] = [];
      seasonMap[s].push(ep);
    });

    // Get season images from TMDB
    let tmdbSeasons = [];
    if (show.tmdb_id && config.tmdb_api_key) {
      const data = await tmdbFetch(`/tv/${show.tmdb_id}?append_to_response=seasons`);
      if (data?.seasons) tmdbSeasons = data.seasons;
    }

    const seasons = Object.entries(seasonMap)
      .filter(([s]) => parseInt(s) > 0)
      .sort((a,b) => parseInt(a[0]) - parseInt(b[0]))
      .map(([s, eps]) => {
        const seasonNum = parseInt(s);
        const tmdbSeason = tmdbSeasons.find(ts => ts.season_number === seasonNum);
        return {
          season: seasonNum,
          name: tmdbSeason?.name || `Säsong ${seasonNum}`,
          overview: tmdbSeason?.overview || "",
          poster_url: tmdbSeason?.poster_path ? `https://image.tmdb.org/t/p/w300${tmdbSeason.poster_path}` : show.poster_url,
          episode_count: eps.length,
          air_date: tmdbSeason?.air_date || null
        };
      });

    res.json({ seasons });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/tvshow/:id/season/:season", requireAuth, async (req, res) => {
  try {
    const show = await dbFindOne(db.media, { _id: req.params.id });
    if (!show) return res.status(404).json({ error: "Hittades inte" });

    const seasonNum = parseInt(req.params.season);
    const episodes = await dbFind(db.media, { parent_id: req.params.id, type: "episode", season: seasonNum });
    episodes.sort((a,b) => a.episode - b.episode);

    // Get episode thumbnails + names from TMDB. Always in English — same "titel alltid
    // engelsk" policy as movies and the scan-time enrichment above. Without this, a Swedish-
    // default server would show Swedish episode names here even after enrichEpisodeMeta had
    // already stored the correct English title, since this fetch runs fresh on every page
    // view and was taking priority over the stored value.
    let tmdbEpisodes = [];
    if (show.tmdb_id && config.tmdb_api_key) {
      const url = `/tv/${show.tmdb_id}/season/${seasonNum}`;
      const data = await tmdbFetch(url, "en-US");
      if (data?.episodes) tmdbEpisodes = data.episodes;
    }

    const enriched = episodes.map(ep => {
      const tmdbEp = tmdbEpisodes.find(te => te.episode_number === ep.episode);
      return {
        ...safe(ep),
        title: tmdbEp?.name || ep.title || `Avsnitt ${ep.episode}`,
        overview: tmdbEp?.overview || "",
        still_url: tmdbEp?.still_path ? `https://image.tmdb.org/t/p/w300${tmdbEp.still_path}` : null,
        runtime: tmdbEp?.runtime || null,
        air_date: tmdbEp?.air_date || null
      };
    });

    // Season details from TMDB
    let seasonInfo = { name: `Säsong ${seasonNum}`, poster_url: show.poster_url };
    if (show.tmdb_id && config.tmdb_api_key) {
      const data = await tmdbFetch(`/tv/${show.tmdb_id}?append_to_response=seasons`);
      const ts = data?.seasons?.find(s => s.season_number === seasonNum);
      if (ts) {
        seasonInfo = {
          name: ts.name || `Säsong ${seasonNum}`,
          poster_url: ts.poster_path ? `https://image.tmdb.org/t/p/w300${ts.poster_path}` : show.poster_url,
          overview: ts.overview || ""
        };
      }
    }

    // Get season cast - use aggregate_credits filtered by season
    let seasonCast = [];
    if (show.tmdb_id && config.tmdb_api_key) {
      const aggCredits = await tmdbFetch(`/tv/${show.tmdb_id}?append_to_response=aggregate_credits`);
      if (aggCredits?.aggregate_credits?.cast) {
        // Filter cast that appeared in this season
        seasonCast = aggCredits.aggregate_credits.cast
          .filter(p => p.roles?.some(r => r.episode_count > 0))
          .sort((a,b) => (b.popularity||0) - (a.popularity||0))
          .slice(0, 50)
          .map(p => ({
            id: p.id, name: p.name,
            character: p.roles?.[0]?.character || "",
            profile_url: p.profile_path ? `https://image.tmdb.org/t/p/w185${p.profile_path}` : null
          }));
      }
    }
    res.json({ season: seasonNum, ...seasonInfo, episodes: enriched, cast: seasonCast });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PERSON DETAILS ───────────────────────────────────────────────────────────
app.get("/api/person/:tmdb_id", requireAuth, async (req, res) => {
  try {
    if (!config.tmdb_api_key) return res.status(503).json({ error: "Ingen TMDB-nyckel" });
    const userLang = req.query.lang || req.user?.language || null;
    let data = await tmdbFetch(`/person/${req.params.tmdb_id}?append_to_response=combined_credits,movie_credits`, userLang);
    if (!data) return res.status(404).json({ error: "Hittades inte" });
    // Always fall back to English if biography is empty — TMDB often has no translated
    // biography for less mainstream people, even when the language request itself succeeds.
    if (!data.biography) {
      const enData = await tmdbFetch(`/person/${req.params.tmdb_id}?append_to_response=combined_credits,movie_credits`, "en-US");
      if (enData?.biography) data.biography = enData.biography;
    }
    const allMedia = await dbFind(db.media, {});
    const tmdbToLocalTitle = new Map(allMedia.filter(m => m.tmdb_id).map(m => [String(m.tmdb_id), (m.title||"").toLowerCase()]));
    function titlesSimilar(t1, t2) {
      if (!t1 || !t2) return true;
      const a = t1.toLowerCase().replace(/[^a-z0-9]/g,"");
      const b = t2.replace(/[^a-z0-9]/g,"");
      return a.includes(b.substring(0,8)) || b.includes(a.substring(0,8));
    }
    const allCast = [...(data.movie_credits?.cast||[]), ...(data.combined_credits?.cast||[])];
    const seenIds = new Set();
    // Filter out talk show (10767) and news (10763) appearances — these are guest-appearance
    // credits TMDB tracks like any other role, but they're rarely what someone means when
    // browsing "what else has this person been in".
    const EXCLUDED_GENRES = new Set([10767, 10763]);
    const uniqueCast = allCast.filter(m => {
      if (seenIds.has(m.id)) return false;
      if ((m.genre_ids||[]).some(g => EXCLUDED_GENRES.has(g))) return false;
      seenIds.add(m.id);
      return true;
    });
    const credits = uniqueCast.filter(m => m.poster_path).sort((a,b) => (b.popularity||0)-(a.popularity||0)).slice(0,100).map(m => {
      const tmdbTitle = m.title || m.name;
      const localTitle = tmdbToLocalTitle.get(String(m.id));
      const in_library = tmdbToLocalTitle.has(String(m.id)) && titlesSimilar(tmdbTitle, localTitle||"");
      // combined_credits includes both movies and TV, and TMDB tags each with media_type —
      // movie_credits items don't have that field at all, so they're always a movie.
      const media_type = m.media_type || (m.name && !m.title ? "tv" : "movie");
      return { tmdb_id: m.id, title: tmdbTitle, character: m.character, poster_url: `https://image.tmdb.org/t/p/w342${m.poster_path}`, year: (m.release_date||m.first_air_date||"").substring(0,4), in_library, media_type };
    });
    res.json({
      name: data.name, biography: data.biography, birthday: data.birthday,
      profile_url: data.profile_path ? `https://image.tmdb.org/t/p/w342${data.profile_path}` : null,
      known_for: data.known_for_department, credits
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TMDB DIRECT LOOKUP (for online search results) ───────────────────────────
app.get("/api/genres/tv", requireAuth, async (req, res) => {
  try {
    const data = await tmdbFetch("/genre/tv/list", "en-US");
    res.json({ genres: data?.genres || [] });
  } catch(e) {
    res.json({ genres: [] });
  }
});

const EXPLORE_TV_CATEGORIES = {
  popular: { endpoint: "/tv/popular", discoverSort: "popularity.desc" },
  top_rated: { endpoint: "/tv/top_rated", discoverSort: "vote_average.desc" },
  on_the_air: { endpoint: "/tv/on_the_air", discoverSort: "popularity.desc" },
  airing_today: { endpoint: "/tv/airing_today", discoverSort: "popularity.desc" }
};

app.get("/api/explore/tvshows", requireAuth, async (req, res) => {
  try {
    const category = EXPLORE_TV_CATEGORIES[req.query.category] ? req.query.category : "popular";
    const genre = req.query.genre ? parseInt(req.query.genre) : null;
    const year = req.query.year ? parseInt(req.query.year) : null;
    const page = Math.min(parseInt(req.query.page) || 1, 500);
    const cat = EXPLORE_TV_CATEGORIES[category];

    let endpoint;
    if (genre || year) {
      const params = new URLSearchParams({ sort_by: cat.discoverSort, page: String(page), "vote_count.gte": category === "top_rated" ? "200" : "0" });
      if (genre) params.set("with_genres", String(genre));
      if (year) params.set("first_air_date_year", String(year));
      if (category === "on_the_air" || category === "airing_today") params.set("with_status", "0|2|3"); // returning, in production, planned — a rough approximation via discover
      endpoint = `/discover/tv?${params.toString()}`;
    } else {
      endpoint = `${cat.endpoint}?page=${page}`;
    }

    const data = await tmdbFetch(endpoint, "en-US");
    const results = data?.results || [];
    const tmdbIds = results.map(r => r.id).filter(Boolean);
    const owned = tmdbIds.length ? await dbFind(db.media, { type: "tvshow", tmdb_id: { $in: tmdbIds } }) : [];
    const ownedByTmdbId = new Map(owned.map(o => [o.tmdb_id, o]));

    const items = results.map(r => {
      const localItem = ownedByTmdbId.get(r.id);
      return {
        tmdb_id: r.id,
        title: r.name,
        year: r.first_air_date ? r.first_air_date.slice(0, 4) : null,
        rating: r.vote_average || null,
        poster_url: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null,
        owned: !!localItem,
        id: localItem ? localItem._id : null
      };
    });

    res.json({ items, page, totalPages: data?.total_pages || 1 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Shared by every endpoint that surfaces TMDB reviews (owned titles, and now unowned
// tv/movie lookups too) — maps TMDB's raw review objects into our simpler shape, handling
// the same avatar_path quirk each time.
function mapTmdbReviews(results) {
  return (results || []).slice(0, 12).map(r => ({
    author: r.author_details?.username || r.author,
    avatar: r.author_details?.avatar_path
      ? (r.author_details.avatar_path.startsWith("/http") ? r.author_details.avatar_path.slice(1) : `https://image.tmdb.org/t/p/w64${r.author_details.avatar_path}`)
      : null,
    rating: r.author_details?.rating || null,
    content: r.content?.length > 220 ? r.content.slice(0, 220) + "…" : r.content,
    date: r.created_at
  }));
}

app.get("/api/tmdb/tv/:tmdb_id", requireAuth, async (req, res) => {
  if (!config.tmdb_api_key) return res.status(503).json({ error: "Ingen TMDB-nyckel" });
  try {
    const userLang = req.user?.language || null;
    const data = await tmdbFetch(`/tv/${req.params.tmdb_id}?append_to_response=credits,videos,reviews`, userLang);
    if (!data) return res.status(404).json({ error: "Hittades inte" });
    // Reused for the English title/poster fallback AND, now, as the reviews source — TMDB
    // reviews are almost always English-only and come back empty otherwise, same issue
    // already handled for owned titles.
    const userLangBase = (userLang || "").slice(0, 2).toLowerCase();
    const needsEnglishCheck = userLang && userLang !== "en-US" && data.original_language && data.original_language !== userLangBase && data.original_language !== "en";
    const enData = (userLang && userLang !== "en-US")
      ? await tmdbFetch(`/tv/${req.params.tmdb_id}?append_to_response=reviews`, "en-US")
      : null;
    const reviews = mapTmdbReviews(data.reviews?.results?.length ? data.reviews.results : enData?.reviews?.results);
    res.json({
      tmdb_id: data.id,
      title: enData?.name || data.name,
      year: data.first_air_date ? parseInt(data.first_air_date) : null,
      overview: (needsEnglishCheck && enData?.overview) ? enData.overview : (data.overview || enData?.overview || null),
      poster_url: (enData?.poster_path || data.poster_path) ? `https://image.tmdb.org/t/p/w500${enData?.poster_path || data.poster_path}` : null,
      backdrop_url: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : null,
      rating: data.vote_average || null,
      runtime: (data.episode_run_time && data.episode_run_time[0]) || null,
      genres: (data.genres||[]).map(g => g.name),
      cast: (data.credits?.cast||[]).slice(0,20).map(p => ({
        id: p.id, name: p.name, character: p.character,
        profile_url: p.profile_path ? `https://image.tmdb.org/t/p/w185${p.profile_path}` : null
      })),
      // TV shows use "created_by" instead of a director crew credit
      crew: (data.created_by||[]).slice(0,3).map(p => ({ id: p.id, name: p.name, job: "Skapare" })),
      reviews
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/tmdb/movie/:tmdb_id", requireAuth, async (req, res) => {
  if (!config.tmdb_api_key) return res.status(503).json({ error: "Ingen TMDB-nyckel" });
  try {
    const userLang = req.user?.language || null;
    const data = await tmdbFetch(`/movie/${req.params.tmdb_id}?append_to_response=credits,videos,reviews`, userLang);
    if (!data) return res.status(404).json({ error: "Hittades inte" });
    const userLangBase = (userLang || "").slice(0, 2).toLowerCase();
    const needsEnglishCheck = userLang && userLang !== "en-US" && data.original_language && data.original_language !== userLangBase && data.original_language !== "en";
    const enData = (userLang && userLang !== "en-US")
      ? await tmdbFetch(`/movie/${req.params.tmdb_id}?append_to_response=reviews`, "en-US")
      : null;
    const reviews = mapTmdbReviews(data.reviews?.results?.length ? data.reviews.results : enData?.reviews?.results);
    res.json({
      tmdb_id: data.id,
      title: enData?.title || data.title,
      year: data.release_date ? parseInt(data.release_date) : null,
      overview: (needsEnglishCheck && enData?.overview) ? enData.overview : (data.overview || enData?.overview || null),
      poster_url: (enData?.poster_path || data.poster_path) ? `https://image.tmdb.org/t/p/w500${enData?.poster_path || data.poster_path}` : null,
      backdrop_url: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : null,
      rating: data.vote_average || null,
      runtime: data.runtime || null,
      genres: (data.genres||[]).map(g => g.name),
      cast: (data.credits?.cast||[]).slice(0,20).map(p => ({
        id: p.id, name: p.name, character: p.character,
        profile_url: p.profile_path ? `https://image.tmdb.org/t/p/w185${p.profile_path}` : null
      })),
      crew: (data.credits?.crew||[]).filter(p => p.job === "Director").slice(0,3).map(p => ({ id: p.id, name: p.name, job: p.job })),
      reviews
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EDIT MEDIA ────────────────────────────────────────────────────────────────
app.post("/api/media/:id/edit", requireAdmin, async (req, res) => {
  const { title, year, overview, poster_url, backdrop_url, rating } = req.body;
  if (!title) return res.status(400).json({ error: "Titel krävs" });
  try {
    const updates = { title };
    if (year !== undefined) updates.year = year ? parseInt(year) : null;
    if (overview !== undefined) updates.overview = overview;
    if (poster_url !== undefined) updates.poster_url = poster_url;
    if (backdrop_url !== undefined) updates.backdrop_url = backdrop_url;
    if (rating !== undefined) updates.rating = rating;
    await dbUpdate(db.media, { _id: req.params.id }, { $set: updates });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PGSTOSRT INSTALL ──────────────────────────────────────────────────────────
const PGSTOSRT_VERSION = "1.4.8";
const PGSTOSRT_RELEASE_URLS = [
  `https://github.com/Tentacule/PgsToSrt/releases/download/v${PGSTOSRT_VERSION}/PgsToSrt-${PGSTOSRT_VERSION}.zip`,
  `https://github.com/Tentacule/PgsToSrt/releases/download/v${PGSTOSRT_VERSION}/PgsToStr-${PGSTOSRT_VERSION}.zip`
];
const TESSDATA_BASE_URL = "https://github.com/tesseract-ocr/tessdata/raw/main/";
const TESSDATA_LANGUAGES = { "swe": "swe.traineddata", "eng": "eng.traineddata", "nor": "nor.traineddata", "dan": "dan.traineddata", "fin": "fin.traineddata", "deu": "deu.traineddata", "fra": "fra.traineddata", "spa": "spa.traineddata", "nld": "nld.traineddata" };

let _pgsInstallProgress = null; // { step, percent, message, error, done }

app.get("/api/tools/pgstosrt-status", requireAuth, (req, res) => {
  res.json({
    installed: isPgsToSrtInstalled(),
    installing: !!_pgsInstallProgress && !_pgsInstallProgress.done,
    progress: _pgsInstallProgress
  });
});

app.post("/api/tools/pgstosrt-install", requireAdmin, async (req, res) => {
  if (_pgsInstallProgress && !_pgsInstallProgress.done) {
    return res.json({ ok: false, message: "Installation pågår redan" });
  }
  const extraLangs = req.body?.languages || [];
  res.json({ ok: true, message: "Installation startad" });
  _pgsInstallProgress = { step: 1, percent: 0, message: "Förbereder...", error: null, done: false };

  (async () => {
    try {
      fs.mkdirSync(PGSTOSRT_DIR, { recursive: true });
      fs.mkdirSync(TESSDATA_DIR, { recursive: true });

      // Step 1: Download PgsToSrt zip - try both filename variants
      _pgsInstallProgress = { step: 1, percent: 5, message: "Laddar ner PgsToSrt...", error: null, done: false };
      const zipPath = path.join(TOOLS_DIR, "PgsToSrt.zip");
      let downloadError = null;
      for (const url of PGSTOSRT_RELEASE_URLS) {
        try {
          await downloadFile(url, zipPath, (p) => {
            _pgsInstallProgress.percent = Math.round(5 + p * 0.35);
            _pgsInstallProgress.message = `Laddar ner PgsToSrt... ${Math.round(p * 100)}%`;
          });
          downloadError = null;
          break; // success
        } catch(e) {
          downloadError = e;
          console.log(`[TOOLS] Download failed for ${url}:`, e.message);
          try { fs.unlinkSync(zipPath); } catch {}
        }
      }
      if (downloadError) throw downloadError;

      // Step 2: Extract zip
      _pgsInstallProgress = { step: 2, percent: 40, message: "Packar upp PgsToSrt...", error: null, done: false };
      await extractZip(zipPath, PGSTOSRT_DIR);
      try { fs.unlinkSync(zipPath); } catch {}

      // Step 3: Download tessdata - always get configured language + eng + any extras
      const langMap = { "sv-SE": "swe", "no-NO": "nor", "da-DK": "dan", "fi-FI": "fin", "de-DE": "deu", "fr-FR": "fra", "es-ES": "spa", "nl-NL": "nld", "ja-JP": "jpn", "en-US": "eng" };
      const configLang = langMap[config.language] || "eng";
      const langs = [configLang, "eng", ...extraLangs].filter((v, i, a) => a.indexOf(v) === i);
      for (let i = 0; i < langs.length; i++) {
        const lang = langs[i];
        const filename = TESSDATA_LANGUAGES[lang] || lang + ".traineddata";
        _pgsInstallProgress = { step: 3, percent: 50 + Math.round((i / langs.length) * 45), message: `Laddar ner ${lang} undertextdata...`, error: null, done: false };
        await downloadFile(TESSDATA_BASE_URL + filename, path.join(TESSDATA_DIR, filename), () => {});
      }

      _pgsInstallProgress = { step: 4, percent: 100, message: "Installation klar!", error: null, done: true };
      console.log("[TOOLS] PgsToSrt installed successfully");
    } catch(e) {
      console.error("[TOOLS] PgsToSrt install failed:", e.message);
      _pgsInstallProgress = { step: 0, percent: 0, message: "Installation misslyckades", error: e.message, done: true };
    }
  })();
});

// Helper: download file with progress callback
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const followRedirects = (url, depth = 0) => {
      if (depth > 5) return reject(new Error("Too many redirects"));
      const mod = url.startsWith("https") ? require("https") : require("http");
      mod.get(url, { headers: { "User-Agent": "StreamVault" } }, (r) => {
        if (r.statusCode === 301 || r.statusCode === 302 || r.statusCode === 307 || r.statusCode === 308) {
          r.resume();
          return followRedirects(r.headers.location, depth + 1);
        }
        if (r.statusCode !== 200) { r.resume(); return reject(new Error("HTTP " + r.statusCode)); }
        const total = parseInt(r.headers["content-length"] || "0");
        let received = 0;
        const file = fs.createWriteStream(dest);
        r.on("data", chunk => { received += chunk.length; if (total) onProgress(received / total); });
        r.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
        file.on("error", reject);
        r.on("error", reject);
      }).on("error", reject);
    };
    followRedirects(url);
  });
}

// Helper: extract zip
function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const AdmZip = (() => { try { return require("adm-zip"); } catch { return null; } })();
    if (AdmZip) {
      try { new AdmZip(zipPath).extractAllTo(destDir, true); resolve(); }
      catch(e) { reject(e); }
    } else {
      // Fallback: use PowerShell on Windows
      const { execFile } = require("child_process");
      execFile("powershell", ["-Command", `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`],
        { windowsHide: true, timeout: 60000 }, (err) => err ? reject(err) : resolve());
    }
  });
}
app.post("/api/scan/update-collections", requireAdmin, async (req, res) => {
  try {
    const movies = await dbFind(db.media, { type: "movie", tmdb_id: { $exists: true } });
    let updated = 0;
    for (const movie of movies) {
      if (!movie.tmdb_id) continue;
      try {
        const details = await tmdbFetch(`/movie/${movie.tmdb_id}`);
        const collection = details?.belongs_to_collection;
        if (collection) {
          const updates = {
            collection_id: collection.id,
            collection_name: collection.name,
            collection_poster: collection.poster_path ? `https://image.tmdb.org/t/p/w500${collection.poster_path}` : null,
            collection_backdrop: collection.backdrop_path ? `https://image.tmdb.org/t/p/w1280${collection.backdrop_path}` : null
          };
          await dbUpdate(db.media, { _id: movie._id }, { $set: updates });
          updated++;
        } else if (movie.collection_id) {
          await dbUpdate(db.media, { _id: movie._id }, { $unset: { collection_id: true, collection_name: true, collection_poster: true, collection_backdrop: true } });
        }
        await new Promise(r => setTimeout(r, 100));
      } catch(e) {
        console.log("[COLLECTIONS] Error for", movie.title, ":", e.message);
      }
    }
    console.log(`[COLLECTIONS] Updated ${updated} movies`);
    res.json({ ok: true, updated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ── RESCAN ALL (clear + rescan) ────────────────────────────────────────────────
app.post("/api/scan/full-rescan", requireAdmin, async (req, res) => {
  res.json({ message: "Rensar databas och skannar om allt..." });
  try {
    // Clear all media
    await dbRemove(db.media, {}, { multi: true });
    await dbRemove(db.history, {}, { multi: true });
    metaCache.clear();

    // Clear subtitle cache directory so stale/orphaned files don't pollute stats
    const subCacheDir = path.join(DATA_DIR, "subtitle-cache");
    try {
      if (fs.existsSync(subCacheDir)) {
        fs.rmSync(subCacheDir, { recursive: true, force: true });
        console.log("[RESCAN] Cleared subtitle-cache directory");
      }
      fs.mkdirSync(subCacheDir, { recursive: true });
    } catch(e) { console.log("[RESCAN] Failed to clear subtitle-cache:", e.message); }

    // Reset all subtitle counters
    _subtitleCacheTotal = 0; _subtitleCacheTotalEps = 0;
    _subtitleCacheWithSwe = 0; _subtitleCacheWithEng = 0; _subtitleCacheWithExtSrt = 0;
    _subtitleCacheWithSweEps = 0; _subtitleCacheWithEngEps = 0; _subtitleCacheWithExtSrtEps = 0;
    _subtitleCacheDone = 0; _subtitleCacheErrors = 0;
    _subtitleCacheFailed = 0; _subtitleCacheFailedEps = 0;
    _subtitleCacheGated = 0; _subtitleCacheGatedEps = 0;
    _subtitleCacheNoSubs = 0; _subtitleCacheNoSubsEps = 0;

    console.log("Database cleared, starting full rescan...");
    await scanLibraries();
  } catch(e) { console.error("Full rescan error:", e); }
});

// Rescans just ONE library (new files only, existing entries untouched) — for when you've
// added files to one library and don't want to wait for/disturb the others.
app.post("/api/scan/library/:id/rescan", requireAdmin, async (req, res) => {
  const lib = (config.libraries || []).find(l => l.id === req.params.id);
  if (!lib) return res.status(404).json({ error: "Bibliotek hittades inte" });
  if (isScanning) return res.status(409).json({ error: "En skanning pågår redan — vänta tills den är klar" });
  res.json({ message: `Skannar biblioteket "${lib.name}"...` });
  isScanning = true;
  _scanProgress = { library: null, found: 0, processed: 0 };
  try {
    const added = await scanOneLibrary(lib);
    console.log(`[SCAN] Library "${lib.name}" rescan complete: ${added} new items`);
  } catch(e) {
    console.error(`Library rescan error (${lib.name}):`, e);
  } finally {
    isScanning = false;
  }
  if (!_subtitleCacheRunning && _subtitleCacheQueue.length > 0) {
    _subtitleCacheRunning = true;
    setTimeout(processSubtitleCacheQueue, 100);
  }
});

// Clears everything belonging to ONE library (its media entries, their watch history, and
// their subtitle cache) and rescans it completely from scratch — the single-library
// equivalent of "Rensa och skanna om allt", without touching any other library at all.
app.post("/api/scan/library/:id/full-rescan", requireAdmin, async (req, res) => {
  const lib = (config.libraries || []).find(l => l.id === req.params.id);
  if (!lib) return res.status(404).json({ error: "Bibliotek hittades inte" });
  if (isScanning) return res.status(409).json({ error: "En skanning pågår redan — vänta tills den är klar" });
  res.json({ message: `Rensar och skannar om biblioteket "${lib.name}"...` });
  try {
    const libItems = await dbFind(db.media, { library_id: lib.id });
    const libItemIds = libItems.map(i => i._id);
    await dbRemove(db.media, { library_id: lib.id }, { multi: true });
    if (libItemIds.length) {
      await dbRemove(db.history, { media_id: { $in: libItemIds } }, { multi: true });
      await dbRemove(db.favorites, { media_id: { $in: libItemIds } }, { multi: true }).catch(() => {});
    }
    metaCache.clear(); // shared across libraries, but cheap enough to just clear entirely

    // Remove subtitle-cache files for just these items (both embedded/converted and external)
    const cacheDir = path.join(DATA_DIR, "subtitle-cache");
    if (fs.existsSync(cacheDir) && libItemIds.length) {
      const hashes = new Set(libItemIds.map(id => shortMediaId(id)));
      let removed = 0;
      for (const f of fs.readdirSync(cacheDir)) {
        const hash = f.slice(0, 32);
        if (hashes.has(hash)) { try { fs.unlinkSync(path.join(cacheDir, f)); removed++; } catch {} }
      }
      console.log(`[RESCAN] Library "${lib.name}": cleared ${removed} subtitle cache files`);
    }

    isScanning = true;
    _scanProgress = { library: null, found: 0, processed: 0 };
    try {
      const added = await scanOneLibrary(lib);
      console.log(`[RESCAN] Library "${lib.name}" full rescan complete: ${added} new items`);
    } finally {
      isScanning = false;
    }
    if (!_subtitleCacheRunning && _subtitleCacheQueue.length > 0) {
      _subtitleCacheRunning = true;
      setTimeout(processSubtitleCacheQueue, 100);
    }
  } catch(e) {
    console.error(`Library full rescan error (${lib.name}):`, e);
  }
});

// ── AUTO SCAN STATUS ───────────────────────────────────────────────────────────
app.get("/api/scan/auto-status", requireAuth, (req, res) => {
  res.json({ 
    scanning: isScanning,
    watchersActive: watchers.length,
    watchingLibraries: (config.libraries || []).map(l => l.name),
    nextScan: nextAutoScan ? new Date(nextAutoScan).toISOString() : null
  });
});


// ── FOLDER BROWSER API ─────────────────────────────────────────────────────────
app.get("/api/browse", requireAuth, (req, res) => {
  const reqPath = req.query.path || "";
  try {
    if (!reqPath) {
      if (process.platform === "win32") {
        const { execSync } = require("child_process");
        try {
          const output = execSync("wmic logicaldisk get name", { encoding: "utf8", windowsHide: true });
          const drives = output.split("\n")
            .map(l => l.trim())
            .filter(l => /^[A-Z]:$/.test(l))
            .map(d => ({ name: d, path: d + "\\", type: "drive" }));
          return res.json({ current: "", items: drives, parent: null });
        } catch {
          return res.json({ current: "", items: [{ name: "C:", path: "C:\\", type: "drive" }], parent: null });
        }
      } else {
        const items = fs.readdirSync("/", { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => ({ name: e.name, path: "/" + e.name, type: "folder" }));
        return res.json({ current: "/", items, parent: null });
      }
    }
    if (!fs.existsSync(reqPath)) return res.status(400).json({ error: "Sökvägen finns inte" });
    const stat = fs.statSync(reqPath);
    if (!stat.isDirectory()) return res.status(400).json({ error: "Inte en mapp" });
    const parentPath = path.dirname(reqPath);
    const parent = parentPath === reqPath ? null : parentPath;
    const entries = fs.readdirSync(reqPath, { withFileTypes: true });
    const items = entries
      .filter(e => {
        if (!e.isDirectory()) return false;
        if (process.platform === "win32") {
          const skip = ["$Recycle.Bin","System Volume Information","$WINDOWS.~BT","$WinREAgent","Recovery","Config.Msi"];
          if (skip.includes(e.name) || e.name.startsWith("$")) return false;
        }
        if (e.name.startsWith(".")) return false;
        return true;
      })
      .map(e => ({ name: e.name, path: path.join(reqPath, e.name), type: "folder" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ current: reqPath, items, parent });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── FILESYSTEM WATCHER ────────────────────────────────────────────────────────
const watchers = [];
let watchDebounceTimer = null;
let nextAutoScan = null;

// Debounce – wait 10 seconds after the last genuine change before actually scanning. This
// prevents scanning mid-copy when large files are being transferred, and (combined with the
// known-file/size check above) means routine subtitle-processing reads never trigger this.
function scheduleWatcherScan(libName) {
  if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
  nextAutoScan = Date.now() + 10000;
  watchDebounceTimer = setTimeout(async () => {
    if (!isScanning) {
      console.log(`File watcher: detected change in ${libName}, scanning...`);
      await scanLibraries().catch(console.error);
    }
  }, 10000);
}

function startFileWatchers() {
  // Stop existing watchers
  watchers.forEach(w => { try { w.close(); } catch {} });
  watchers.length = 0;

  for (const lib of (config.libraries || [])) {
    if (!fs.existsSync(lib.path)) continue;
    try {
      const watcher = fs.watch(lib.path, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const ext = path.extname(filename).toLowerCase();
        const isMedia = [".mp4",".mkv",".avi",".mov",".wmv",".m4v",".ts",".webm",
                         ".mp3",".flac",".aac",".ogg",".wav",".m4a",".opus"].includes(ext);
        if (!isMedia) return;

        // Windows' change notifications (what fs.watch uses under the hood here) can fire
        // for metadata-only touches too — e.g. FFmpeg repeatedly reading a large video file
        // during subtitle extraction can update its last-accessed time, which Windows then
        // reports as a "change". Without this check, that alone was enough to trigger a full
        // library rescan every time subtitle caching touched a file — completely spurious,
        // since nothing about the file (or the library) actually changed.
        try {
          const fullPath = path.join(lib.path, filename);
          const id = Buffer.from(fullPath).toString("base64url");
          const stat = fs.existsSync(fullPath) ? fs.statSync(fullPath) : null;
          if (stat) {
            db.media.findOne({ _id: id }, (err, existing) => {
              if (existing && existing.file_size === stat.size) return; // known, unchanged size — ignore
              scheduleWatcherScan(lib.name);
            });
            return;
          }
        } catch(e) { /* fall through and scan to be safe if we couldn't check */ }
        scheduleWatcherScan(lib.name);
      });
      watchers.push(watcher);
      console.log(`👁  Watching: ${lib.path}`);
    } catch(e) {
      console.warn(`Could not watch ${lib.path}: ${e.message}`);
    }
  }
}

function scheduleAutoScan() {
  // Kept for compatibility but no-op now – filesystem watcher handles it
}


// Detect best video encoder once at startup
let cachedEncoder = { encoder: "libx264", extraArgs: ["-preset", "ultrafast", "-crf", "23"] };
try {
  const { execFileSync } = require("child_process");
  const encoderList = execFileSync(getFfmpegPath(), ["-hide_banner", "-encoders"],
    { timeout: 5000, windowsHide: true }).toString();

  const candidates = [];
  if (encoderList.includes("h264_nvenc")) {
    // Detect NVIDIA GPU generation for optimal settings
    let nvencArgs = ["-preset", "p4", "-profile:v", "high"]; // safe default
    try {
      const gpuInfo = execFileSync("nvidia-smi", [
        "--query-gpu=name,compute_cap",
        "--format=csv,noheader"
      ], { timeout: 5000, windowsHide: true }).toString().trim();
      console.log("[GPU] Detected:", gpuInfo);
      const computeCap = parseFloat(gpuInfo.split(",")[1]?.trim() || "0");
      if (computeCap >= 8.9) {
        // Ada Lovelace (40xx) / Blackwell (50xx) - fastest
        nvencArgs = ["-preset", "p1", "-rc", "constqp", "-qp", "23", "-gpu", "0", "-profile:v", "high", "-zerolatency", "1"];
        console.log("[GPU] Ada/Blackwell detected - using p1 constqp preset");
      } else if (computeCap >= 8.0) {
        // Ampere (30xx) - very fast
        nvencArgs = ["-preset", "p1", "-rc", "constqp", "-qp", "23", "-gpu", "0", "-profile:v", "high", "-zerolatency", "1"];
        console.log("[GPU] Ampere detected - using p1 constqp preset (RTX 3080)");
      } else if (computeCap >= 7.0) {
        // Turing (20xx) / Volta - fast
        nvencArgs = ["-preset", "p3", "-rc", "vbr", "-cq", "23", "-gpu", "0", "-profile:v", "high"];
        console.log("[GPU] Turing/Volta detected - using p3 preset");
      } else if (computeCap >= 6.0) {
        // Pascal (10xx) - standard
        nvencArgs = ["-preset", "p4", "-gpu", "0", "-profile:v", "high"];
        console.log("[GPU] Pascal detected - using p4 preset");
      } else {
        console.log("[GPU] Older NVIDIA - using safe p4 preset");
      }
    } catch(e) {
      console.log("[GPU] nvidia-smi not available, using default NVENC settings");
    }
    candidates.push({
      encoder: "h264_nvenc",
      extraArgs: nvencArgs,
      testArgs: ["-preset", "p4", "-profile:v", "high"]
    });
  }
  if (encoderList.includes("h264_amf")) candidates.push({
    encoder: "h264_amf",
    extraArgs: [],
    testArgs: []
  });
  if (encoderList.includes("h264_qsv")) candidates.push({
    encoder: "h264_qsv",
    extraArgs: ["-preset", "veryfast"],
    testArgs: ["-preset", "veryfast"]
  });

  for (const candidate of candidates) {
    try {
      // Use color=black source which is more compatible than nullsrc
      execFileSync(getFfmpegPath(), [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=black:size=320x240:duration=1:rate=25",
        "-c:v", candidate.encoder, ...(candidate.testArgs || candidate.extraArgs),
        "-frames:v", "1",
        "-f", "null", "-"
      ], { timeout: 10000, windowsHide: true });
      cachedEncoder = { encoder: candidate.encoder, extraArgs: candidate.extraArgs };
      console.log(`🎬 Video encoder: ${candidate.encoder}`);
      break;
    } catch {
      console.log(`⚠️  ${candidate.encoder} not available, trying next...`);
    }
  }
  if (cachedEncoder.encoder === "libx264") {
    console.log(`🎬 Video encoder: libx264 (CPU)`);
  }
} catch(e) {
  console.log("⚠️  Could not detect GPU encoder, using CPU (libx264)");
}

const PUBLIC=path.join(__dirname,"..","public");
if (fs.existsSync(PUBLIC)) {
  app.use(express.static(PUBLIC));
  app.get("*",(req,res)=>res.sendFile(path.join(PUBLIC,"index.html")));
}

const PORT=config.port||7000;
const server=http.createServer(app);
server.listen(PORT,()=>{
  console.log(`\n StreamVault v${STREAMVAULT_VERSION} - http://localhost:${PORT}\n`);
  setTimeout(()=>scanLibraries().catch(console.error),2000);
  setTimeout(()=>startFileWatchers(), 3000);

  // Scheduled safety-net rescan, on top of the real-time file watchers — catches cases the
  // watchers might miss (e.g. a network drive dropping its watch, or changes made while the
  // server was offline). Off unless explicitly enabled, matching how Plex's own equivalent
  // setting defaults to on but is still just an extra safety net, not the primary mechanism.
  setInterval(() => {
    if (!config.periodic_scan_enabled) return;
    const intervalHours = config.periodic_scan_interval_hours || 12;
    const hoursSinceLastScan = (Date.now() - (_lastPeriodicScanTime || 0)) / 3600000;
    if (hoursSinceLastScan < intervalHours) return;
    _lastPeriodicScanTime = Date.now();
    console.log(`[SCAN] Running scheduled safety-net rescan (every ${intervalHours}h)...`);
    scanLibraries().catch(e => console.error("[SCAN] Scheduled rescan error:", e));
  }, 30 * 60 * 1000); // checked every 30 min — cheap, and means the configured interval doesn't need to divide evenly into anything
});

process.on("SIGTERM",()=>{server.close();process.exit(0);});
process.on("SIGINT",()=>{server.close();process.exit(0);});

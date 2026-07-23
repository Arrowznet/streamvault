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
  sv:"swe", swe:"swe", svenska:"swe", swedish:"swe",
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
  playbackLog: new Datastore({ filename: path.join(DATA_DIR, "playback_log.db"), autoload: true })
};

db.users.ensureIndex({ fieldName: "username", unique: true });
db.media.ensureIndex({ fieldName: "library_id" });
db.media.ensureIndex({ fieldName: "type" });
db.history.ensureIndex({ fieldName: "user_id" });

const dbFind = (s, q) => new Promise((r, j) => s.find(q, (e, d) => e ? j(e) : r(d)));
const dbFindOne = (s, q) => new Promise((r, j) => s.findOne(q, (e, d) => e ? j(e) : r(d)));
const dbInsert = (s, d) => new Promise((r, j) => s.insert(d, (e, n) => e ? j(e) : r(n)));
const dbUpdate = (s, q, u, o={}) => new Promise((r, j) => s.update(q, u, o, (e, n) => e ? j(e) : r(n)));
const dbRemove = (s, q, o={}) => new Promise((r, j) => s.remove(q, o, (e, n) => e ? j(e) : r(n)));
const dbCount = (s, q) => new Promise((r, j) => s.count(q, (e, n) => e ? j(e) : r(n)));

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => { res.setHeader("X-Content-Type-Options","nosniff"); res.setHeader("X-Frame-Options","SAMEORIGIN"); next(); });
app.use("/api/auth", rateLimit({ windowMs: 15*60*1000, max: 20 }));
app.use("/api", rateLimit({ windowMs: 60*1000, max: 300 }));

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

app.get("/api/users", requireAdmin, async (req, res) => {
  const users = await dbFind(db.users, { is_active: true });
  res.json(users.map(u => ({ id: u._id, username: u.username, role: u.role, created_at: u.created_at, last_login: u.last_login })));
});

// Shared by user creation and the language-patch endpoint: checks whether a language
// needs a bitmap-subtitle OCR allowlist entry, and logs + persists a pending notice if so.
function checkNeedsOcrLanguage(language, userId, changedByUserId, changedByLabel) {
  if (config.subtitle_ocr_mode === "all") return null;
  const subLang = USER_LANG_TO_SUB_LANG[language];
  if (!subLang) return null;
  const current = getEffectiveOcrLanguages(); // Set, since mode isn't "all" here
  if (current.has(subLang)) return null;
  const who = changedByUserId === userId ? "användaren själv" : `admin (${changedByLabel || changedByUserId})`;
  logSubtitle("warn", null, `Nytt användarspråk (${subtitleLangLabel(subLang)}) är inte i språklistan än – satt av ${who}`, { subLang, userId });
  addPendingOcrRequest(subLang, userId);
  return subLang;
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
      const apkAsset = (rel.assets || []).find(a => a.name && a.name.endsWith(".apk"));
      if (!apkAsset) continue;
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
  metaCache.set(key, meta);
  return meta;
}

async function getTVMeta(title) {
  const key=`tv:${title}`;
  if(metaCache.has(key)) return metaCache.get(key);
  const data = await tmdbFetch(`/search/tv?query=${encodeURIComponent(title)}`);
  const m = data?.results?.[0];
  if (!m) { metaCache.set(key, null); return null; }
  const meta = { tmdb_id:m.id, overview:m.overview||"", poster_url:m.poster_path?`https://image.tmdb.org/t/p/w500${m.poster_path}`:null, backdrop_url:m.backdrop_path?`https://image.tmdb.org/t/p/w1280${m.backdrop_path}`:null, rating:m.vote_average||null, status:m.status||null };
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
      const newItem = {_id:id,library_id:lib.id,type:"movie",title:meta?.title_en || cleanName,year:meta?.year||year,file_path:filePath,file_size:stat.size,tmdb_id:meta?.tmdb_id||null,poster_url:meta?.poster_url||null,backdrop_url:meta?.backdrop_url||null,overview:meta?.overview||null,rating:meta?.rating||null,collection_id:meta?.collection_id||null,collection_name:meta?.collection_name||null,collection_poster:meta?.collection_poster||null,collection_backdrop:meta?.collection_backdrop||null,added_at:new Date().toISOString()};
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
        await dbInsert(db.media,{_id:showId,library_id:lib.id,type:"tvshow",title:cleanName,file_path:showPath,tmdb_id:meta?.tmdb_id||null,poster_url:meta?.poster_url||null,backdrop_url:meta?.backdrop_url||null,overview:meta?.overview||null,rating:meta?.rating||null,status:meta?.status||null,added_at:new Date().toISOString()});
        added++;
      }
      await scanEpisodes(showPath,showId,lib.id);
      _scanProgress.processed++;
    }
    console.log(`[SCAN] TV library "${lib.name}": done`);
  }
  if (lib.type === "music") await scanMusic(lib.path,lib.id);
  return added;
}

async function scanLibraries() {
  if (isScanning) return;
  isScanning = true;
  _scanProgress = { library: null, found: 0, processed: 0 };
  let added = 0;
  try {
    for (const lib of (config.libraries||[])) {
      added += await scanOneLibrary(lib);
    }
  } finally { isScanning=false; }
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
    if (!em) console.log(`[SCAN] Warning: could not detect season/episode from "${entry.name}"`);
    const emSeason = em ? parseInt(em[1] || em[3]) : 0;
    const emEpisode = em ? parseInt(em[2] || em[4]) : 0;
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
    const {type,library_id,search,limit=200} = req.query;
    const query={};
    if (type) query.type=type;
    if (library_id) {
      if (!userHasLibraryAccess(req.user, library_id)) return res.json([]);
      query.library_id=library_id;
    } else if (req.user.role !== "admin" && req.user.library_ids?.length > 0) {
      query.library_id = { $in: req.user.library_ids };
    }
    if (search) query.title=new RegExp(search,"i");
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

  // Live activity: refresh (or create) this session's heartbeat entry, unless playback
  // just completed — a finished item shouldn't linger in the "currently watching" list.
  const sessionKey = `${req.user._id}:${req.params.id}`;
  if (completed) {
    _activeSessions.delete(sessionKey);
  } else {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    _activeSessions.set(sessionKey, {
      userId: req.user._id,
      username: req.user.username,
      mediaId: req.params.id,
      title: item?.title || "Okänd",
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
  }

  res.json({ok:true});
});

app.get("/api/continue-watching", requireAuth, async (req, res) => {
  try {
    const history = await dbFind(db.history,{user_id:req.user._id,completed:0,position:{$gt:30}});
    history.sort((a,b)=>new Date(b.watched_at)-new Date(a.watched_at));
    const items=[];
    for (const h of history.slice(0,20)) {
      const item = await dbFindOne(db.media,{_id:h.media_id});
      if (item) items.push({...safe(item),position:h.position,duration:h.duration});
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

app.post("/api/favorites/:id", requireAuth, async (req, res) => {
  try { await dbInsert(db.favorites,{_id:uuidv4(),user_id:req.user._id,media_id:req.params.id,added_at:new Date().toISOString()}); } catch{}
  res.json({ok:true});
});

app.delete("/api/favorites/:id", requireAuth, async (req, res) => {
  await dbRemove(db.favorites,{user_id:req.user._id,media_id:req.params.id});
  res.json({ok:true});
});


// ── STREAMING & HLS TRANSCODING ───────────────────────────────────────────────
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
  const needsMetadata = !item.width || !item.codec;
  if (item.duration && !needsMetadata) return item.duration;
  try {
    const ffprobe = getFfprobePath();
    const { execFileSync } = require("child_process");
    const out = execFileSync(ffprobe, [
      "-v", "quiet",
      "-analyzeduration", "100M", "-probesize", "100M",
      "-show_entries", "format=duration:stream=width,height,codec_name,pix_fmt",
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
  async function getAllAudioStreams() {
    try {
      const { execFileSync } = require("child_process");
      const ffprobePath = getFfmpegPath().replace("ffmpeg.exe", "ffprobe.exe");
      const out = execFileSync(ffprobePath, [
        "-v", "quiet", "-analyzeduration", "100M", "-probesize", "100M",
        "-show_streams", "-select_streams", "a",
        "-show_entries", "stream=codec_name",
        "-of", "json", item.file_path
      ], { timeout: 12000, windowsHide: true }).toString();
      return (JSON.parse(out).streams || []).map(s => normalizeCodec(s.codec_name || ""));
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
    // next to it at index 1+. Picks the first compatible track found; its index is returned
    // below so the client can actually select it (direct-play just streams the raw file —
    // the server doesn't remap tracks the way DASH does, so the client MUST switch to this
    // track index itself, or it'll just get whatever the container's default track is).
    let audioOk = true;
    if (containerOk && videoOk && audioCodecs.size > 0) {
      const audioStreams = await getAllAudioStreams();
      compatibleAudioIndex = audioStreams.findIndex(c => c && audioCodecs.has(c));
      audioOk = compatibleAudioIndex !== -1;
      if (!audioOk) reasons.push(`no compatible audio track among [${audioStreams.join(",")}] for [${[...audioCodecs].join(",")}]`);
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
    // Only meaningful for direct play — tells the client which audio track to explicitly
    // select (e.g. via ExoPlayer track selection), since direct play streams the raw file
    // as-is and the server has no way to remap tracks the way DASH transcoding does. Null
    // when not using capability-based negotiation, or when track 0 was already fine.
    audioTrackIndex: (!needsTranscode && typeof compatibleAudioIndex === "number" && compatibleAudioIndex > 0) ? compatibleAudioIndex : null
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
  // Prefer AC3/EAC3/AAC over TrueHD/DTS (TrueHD causes FFmpeg errors in DASH)
  let bestAudioIndex = 0;
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
      const preferred = audioStreams.find(s => ["ac3","eac3","aac","mp3"].includes((s.codec_name||"").toLowerCase()));
      if (preferred) {
        // Find relative audio index
        bestAudioIndex = audioStreams.indexOf(preferred);
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
    title: item.title, videoMode: canCopyVideo ? (canCopyHevc ? "copy-hevc" : "copy-h264") : `encode-${encoder}`
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

app.get("/api/watch-providers/:tmdb_id", requireAuth, async (req, res) => {
  if (!config.tmdb_api_key) return res.json({});
  const data = await tmdbFetch(`/movie/${req.params.tmdb_id}/watch/providers?watch_region=SE`);
  res.json(data?.results?.SE || {});
});

// Related movies/shows for a detail page — pulls TMDB's recommendations for the title, then
// filters down to only what's actually in this library, so every result is guaranteed
// clickable (no dead-end links to things you don't own). Falls back to TMDB's "similar"
// endpoint if recommendations comes back empty, since recommendations relies on TMDB user
// behavior data and can be thin for less mainstream titles.
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
      collectionItems = inCollection.map(o => ({ id: o._id, title: o.title, year: o.year, poster_url: o.poster_url, type: o.type }));
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
      const candidateIds = candidates.map(c => c.id).filter(Boolean);
      if (candidateIds.length) {
        const owned = await dbFind(db.media, { type: item.type, tmdb_id: { $in: candidateIds } });
        const ownedByTmdbId = new Map(owned.map(o => [o.tmdb_id, o]));
        recItems = candidateIds.map(id => ownedByTmdbId.get(id)).filter(Boolean)
          .map(o => ({ id: o._id, title: o.title, year: o.year, poster_url: o.poster_url, type: o.type }));
      }
    }

    // Collection entries first, then fill the rest with TMDB recommendations, deduplicated
    const seen = new Set(collectionItems.map(i => i.id));
    const items = [...collectionItems, ...recItems.filter(i => !seen.has(i.id) && (seen.add(i.id), true))].slice(0, 20);

    res.json({ items });
  } catch(e) {
    res.json({ items: [] }); // never let a broken related-media lookup break the detail page
  }
});

// ── SUBTITLES ─────────────────────────────────────────────────────────────────

// Get available subtitles for a media item (embedded + .srt files)
app.get("/api/media/:id/subtitles", requireAuth, async (req, res) => {
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item) return res.status(404).json({ error: "Not found" });

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

    // Sort: the requesting user's own language first, then Swedish, then English, then others
    const userSubLang = USER_LANG_TO_SUB_LANG[req.user?.language] || null;
    subtitles.sort((a, b) => {
      const priority = (l) => {
        if (userSubLang && l === userSubLang) return -1;
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

    res.json({ subtitles });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve a cached subtitle file (PgsToSrt-converted or pre-extracted)
app.get("/api/media/:id/subtitle-cache", requireMediaAccess, async (req, res) => {
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item) return res.status(404).json({ error: "Not found" });
    const cacheDir = path.join(DATA_DIR, "subtitle-cache");
    const file = req.query.file;
    if (!file || file.includes("..")) return res.status(400).json({ error: "Invalid" });
    const filePath = path.join(cacheDir, file);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
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
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item) return res.status(404).json({ error: "Not found" });
    const dir = path.dirname(item.file_path);
    const file = req.query.file;
    if (!file || file.includes("..")) return res.status(400).json({ error: "Invalid" });
    const filePath = path.join(dir, file);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
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
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item) return res.status(404).json({ error: "Not found" });
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
    } catch(e) {
      logSubtitle("warn", item, `Kunde inte läsa spårinfo för spår ${trackIndex} vid extraktion`, { trackIndex, error: e.message });
    }

    const cacheFile = path.join(cacheDir, `${shortMediaId(item._id)}_${trackIndex}_${lang}.srt`);
    const tempFile = cacheFile + ".tmp";

    if (!fs.existsSync(cacheFile)) {
      if (UNSUPPORTED_BITMAP_CODECS.includes(codec)) {
        logSubtitle("info", item, `Bildbaserat spår (${subtitleLangLabel(lang)}, ${codec}) kan inte visas – DVD/VobSub-format stöds inte av nuvarande OCR-verktyg`, { trackIndex, lang, codec });
        return res.status(404).json({ error: "DVD/VobSub subtitle format not supported by current OCR tool (PGS only)" });
      }
      if (bitmapCodecs.includes(codec)) {
        if (!isPgsToSrtInstalled()) {
          logSubtitle("warn", item, `Bildbaserat spår (${subtitleLangLabel(lang)}) kan inte visas – PgsToSrt är inte installerat`, { trackIndex, lang });
          return res.status(404).json({ error: "Bitmap subtitle not supported without PgsToSrt" });
        }
        if (fs.existsSync(tempFile)) return res.status(202).json({ status: "extracting", retryAfter: 5 });
        fs.writeFileSync(tempFile, "");
        convertPgsTosrt(item, trackIndex, cacheFile, lang).then(ok => {
          try { fs.unlinkSync(tempFile); } catch {}
          if (ok) logSubtitle("info", item, `Undertext konverterad on-demand – ${subtitleLangLabel(lang)}`, { trackIndex });
        }).catch(e => { try { fs.unlinkSync(tempFile); } catch {}; logSubtitle("error", item, "Oväntat fel vid on-demand PgsToSrt", { trackIndex, error: e.message }); });
        return res.status(202).json({ status: "extracting", retryAfter: 5 });
      }

      // Already extracting?
      if (fs.existsSync(tempFile)) {
        return res.status(202).json({ status: "extracting", retryAfter: 3 });
      }
      fs.writeFileSync(tempFile, "");
      extractTextSubtitle(item, trackIndex, cacheFile).then(result => {
        try { fs.unlinkSync(tempFile); } catch {}
        if (result.ok) {
          logSubtitle("info", item, `Undertext extraherad on-demand – ${subtitleLangLabel(lang)}`, { trackIndex });
        } else {
          logSubtitle("error", item, `On-demand-extraktion misslyckades – ${subtitleLangLabel(lang)}`, { trackIndex, error: result.error?.split("\n")[0] });
        }
      });
      return res.status(202).json({ status: "extracting", retryAfter: 3 });
    }
    const tmpFile = cacheFile;

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

    const sessions = [...(_activeSessions.values())].map(s => ({
      ...s,
      idleSeconds: Math.round((now - s.lastHeartbeat) / 1000),
      progressPct: s.duration > 0 ? Math.min(100, Math.round((s.position / s.duration) * 100)) : 0
    }));

    const transcodes = [...activeDashTranscodes.entries()].map(([mediaId, t]) => ({
      mediaId,
      title: t.title,
      videoMode: t.videoMode || "unknown",
      elapsedSeconds: Math.round((now - t.startTime) / 1000),
      startSec: t.startSec
    }));

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
      transcodes,
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

    // Most-played titles
    const titleMap = new Map();
    for (const e of entries) {
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

    res.json({
      days, totalPlays, directCount, transcodeCount,
      directPct: totalPlays ? Math.round((directCount / totalPlays) * 100) : 0,
      byContainerCodec, mostWatched, dailyStats, byUser
    });
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

  res.json({ server_name: config.server_name || null, subtitleSearchLanguages });
});

app.get("/api/config", requireAdmin, (req, res) => {
  const s={...config}; delete s.jwt_secret; res.json(s);
});

app.patch("/api/config", requireAdmin, (req, res) => {
  ["tmdb_api_key","opensubtitles_api_key","lastfm_api_key","spotify_client_id","spotify_client_secret","port","language","update_channel","server_name"].forEach(k=>{if(req.body[k]!==undefined)config[k]=req.body[k];});
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
    res.json({
      title: item.title, file_path: item.file_path, file_size: item.file_size, tmdb_id: item.tmdb_id,
      library_id: item.library_id, added_at: item.added_at, year: item.year, type: item.type, rating: item.rating,
      video: videoStream ? {
        codec: videoStream.codec_name?.toUpperCase(), profile: videoStream.profile,
        width: videoStream.width, height: videoStream.height,
        fps: videoStream.r_frame_rate ? Math.round(eval(videoStream.r_frame_rate)) : null,
        bitrate: videoStream.bit_rate ? Math.round(videoStream.bit_rate/1000)+" kbps" : null,
        bit_depth: videoStream.bits_per_raw_sample || null, color_space: videoStream.color_space || null
      } : null,
      audio: audioStreams.map(a => ({
        codec: a.codec_name?.toUpperCase(), channels: a.channels, channel_layout: a.channel_layout,
        language: a.tags?.language || "und", bitrate: a.bit_rate ? Math.round(a.bit_rate/1000)+" kbps" : null, title: a.tags?.title || null
      })),
      subtitles: subtitleStreams.map(s => ({
        codec: s.codec_name?.toUpperCase(), language: s.tags?.language || "und",
        title: s.tags?.title || null, forced: s.disposition?.forced === 1, default: s.disposition?.default === 1
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

    await dbUpdate(db.media, { _id: req.params.id }, {
      $set: { tmdb_id, title, year: year ? parseInt(year) : undefined, overview, poster_url: finalPosterUrl, backdrop_url, rating }
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
    const collections = Object.values(collectionsMap)
      .filter(c => c.movies.length >= 2)
      .sort((a,b) => (a.name||"").localeCompare(b.name||""));
    res.json(collections);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MEDIA DETAILS (cast, crew, genres) ───────────────────────────────────────
app.get("/api/media/:id/details", requireAuth, async (req, res) => {
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item || !item.tmdb_id || !config.tmdb_api_key) return res.json({ cast: [], crew: [], genres: [], runtime: null, overview: null });
    const userLang = req.user?.language || null;
    const endpoint = item.type === "tvshow"
      ? `/tv/${item.tmdb_id}?append_to_response=aggregate_credits`
      : `/movie/${item.tmdb_id}?append_to_response=credits`;
    const data = await tmdbFetch(endpoint, userLang);
    if (!data) return res.json({ cast: [], crew: [], genres: [], runtime: null, overview: null });
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
    res.json({ cast, crew, genres, runtime, overview: data.overview || null });
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
    const userLang = req.user?.language || null;
    let data = await tmdbFetch(`/person/${req.params.tmdb_id}?append_to_response=combined_credits,movie_credits`, userLang);
    if (!data) return res.status(404).json({ error: "Hittades inte" });
    // Fallback to English if biography is empty
    if (!data.biography && userLang && userLang !== "en-US") {
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
    const uniqueCast = allCast.filter(m => { if (seenIds.has(m.id)) return false; seenIds.add(m.id); return true; });
    const credits = uniqueCast.filter(m => m.poster_path).sort((a,b) => (b.popularity||0)-(a.popularity||0)).slice(0,100).map(m => {
      const tmdbTitle = m.title || m.name;
      const localTitle = tmdbToLocalTitle.get(String(m.id));
      const in_library = tmdbToLocalTitle.has(String(m.id)) && titlesSimilar(tmdbTitle, localTitle||"");
      return { tmdb_id: m.id, title: tmdbTitle, character: m.character, poster_url: `https://image.tmdb.org/t/p/w342${m.poster_path}`, year: (m.release_date||m.first_air_date||"").substring(0,4), in_library };
    });
    res.json({
      name: data.name, biography: data.biography, birthday: data.birthday,
      profile_url: data.profile_path ? `https://image.tmdb.org/t/p/w342${data.profile_path}` : null,
      known_for: data.known_for_department, credits
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TMDB DIRECT LOOKUP (for online search results) ───────────────────────────
app.get("/api/tmdb/movie/:tmdb_id", requireAuth, async (req, res) => {
  if (!config.tmdb_api_key) return res.status(503).json({ error: "Ingen TMDB-nyckel" });
  try {
    const userLang = req.user?.language || null;
    const data = await tmdbFetch(`/movie/${req.params.tmdb_id}?append_to_response=credits,videos`, userLang);
    if (!data) return res.status(404).json({ error: "Hittades inte" });
    const enData = (userLang && userLang !== "en-US")
      ? await tmdbFetch(`/movie/${req.params.tmdb_id}`, "en-US")
      : null;
    res.json({
      tmdb_id: data.id,
      title: enData?.title || data.title,
      year: data.release_date ? parseInt(data.release_date) : null,
      overview: data.overview,
      poster_url: (enData?.poster_path || data.poster_path) ? `https://image.tmdb.org/t/p/w500${enData?.poster_path || data.poster_path}` : null,
      backdrop_url: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : null,
      rating: data.vote_average || null,
      runtime: data.runtime || null,
      genres: (data.genres||[]).map(g => g.name),
      cast: (data.credits?.cast||[]).slice(0,20).map(p => ({
        id: p.id, name: p.name, character: p.character,
        profile_url: p.profile_path ? `https://image.tmdb.org/t/p/w185${p.profile_path}` : null
      })),
      crew: (data.credits?.crew||[]).filter(p => p.job === "Director").slice(0,3).map(p => ({ id: p.id, name: p.name, job: p.job }))
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
});

process.on("SIGTERM",()=>{server.close();process.exit(0);});
process.on("SIGINT",()=>{server.close();process.exit(0);});

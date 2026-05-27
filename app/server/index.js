const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const https = require("https");
const http = require("http");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");
const { v4: uuidv4 } = require("uuid");
const { execSync, exec } = require("child_process");

// ── Paths ──────────────────────────────────────────────────────────────────────
const DATA_DIR = process.env.STREAMVAULT_DATA
  ? path.join(process.env.STREAMVAULT_DATA, "data")
  : path.join(__dirname, "..", "data");

const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const DB_PATH = path.join(DATA_DIR, "streamvault.db");
const VERSION = "1.0.0";
const UPDATE_CHECK_URL = "https://api.github.com/repos/streamvault/streamvault/releases/latest";

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Config ─────────────────────────────────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaults = {
      port: 7000,
      jwt_secret: uuidv4() + uuidv4() + uuidv4(),
      tmdb_api_key: "",
      opensubtitles_api_key: "",
      language: "auto",
      transcoding: { enabled: true, hardware_accel: "auto" },
      libraries: [],
      version: VERSION
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

let config = loadConfig();

// ── Database ───────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    avatar TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    refresh_token TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS media_items (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    year INTEGER,
    file_path TEXT,
    file_size INTEGER,
    duration INTEGER,
    tmdb_id INTEGER,
    poster_url TEXT,
    backdrop_url TEXT,
    overview TEXT,
    rating REAL,
    genres TEXT,
    parent_id TEXT,
    season INTEGER,
    episode INTEGER,
    extra_data TEXT,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS watch_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    media_id TEXT NOT NULL,
    position INTEGER DEFAULT 0,
    duration INTEGER DEFAULT 0,
    completed INTEGER DEFAULT 0,
    watched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, media_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS favorites (
    user_id TEXT NOT NULL,
    media_id TEXT NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, media_id)
  );
  CREATE TABLE IF NOT EXISTS login_attempts (
    ip_address TEXT NOT NULL,
    attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    success INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_media_library ON media_items(library_id);
  CREATE INDEX IF NOT EXISTS idx_media_type ON media_items(type);
  CREATE INDEX IF NOT EXISTS idx_watch_user ON watch_history(user_id);
`);

// ── App ────────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));

// Security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  next();
});

// Rate limiting
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 300 });
app.use("/api/auth", authLimiter);
app.use("/api", apiLimiter);

// ── Auth helpers ───────────────────────────────────────────────────────────────
function generateTokens(userId) {
  const accessToken = jwt.sign({ userId, type: "access" }, config.jwt_secret, { expiresIn: "15m" });
  const refreshToken = jwt.sign({ userId, type: "refresh" }, config.jwt_secret, { expiresIn: "30d" });
  return { accessToken, refreshToken };
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Ej autentiserad" });
  try {
    const payload = jwt.verify(auth.slice(7), config.jwt_secret);
    if (payload.type !== "access") throw new Error();
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND is_active = 1").get(payload.userId);
    if (!user) return res.status(401).json({ error: "Användare hittades inte" });
    req.user = user;
    next();
  } catch { return res.status(401).json({ error: "Ogiltig token" }); }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Kräver adminbehörighet" });
    next();
  });
}

// ── AUTH ───────────────────────────────────────────────────────────────────────
app.get("/api/setup-required", (req, res) => {
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  res.json({ required: !admin });
});

app.post("/api/auth/setup", async (req, res) => {
  const existing = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existing) return res.status(400).json({ error: "Admin finns redan" });
  const { username, password } = req.body;
  if (!username || !password || password.length < 6)
    return res.status(400).json({ error: "Ogiltiga uppgifter. Lösenord minst 6 tecken." });
  const hash = await bcrypt.hash(password, 12);
  const id = uuidv4();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)").run(id, username.trim(), hash, "admin");
  const tokens = generateTokens(id);
  db.prepare("INSERT INTO sessions (id, user_id, refresh_token, expires_at) VALUES (?,?,?,datetime('now','+30 days'))").run(uuidv4(), id, tokens.refreshToken);
  res.json({ ...tokens, user: { id, username, role: "admin" } });
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Ange användarnamn och lösenord" });
  const recentFails = db.prepare("SELECT COUNT(*) as c FROM login_attempts WHERE ip_address = ? AND success = 0 AND attempted_at > datetime('now','-15 minutes')").get(req.ip);
  if (recentFails.c >= 10) return res.status(429).json({ error: "För många försök. Vänta 15 minuter." });
  const user = db.prepare("SELECT * FROM users WHERE username = ? AND is_active = 1").get(username.trim());
  const valid = user && await bcrypt.compare(password, user.password_hash);
  db.prepare("INSERT INTO login_attempts (ip_address, success) VALUES (?,?)").run(req.ip, valid ? 1 : 0);
  if (!valid) return res.status(401).json({ error: "Fel användarnamn eller lösenord" });
  db.prepare("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?").run(user.id);
  const tokens = generateTokens(user.id);
  db.prepare("INSERT INTO sessions (id, user_id, refresh_token, expires_at) VALUES (?,?,?,datetime('now','+30 days'))").run(uuidv4(), user.id, tokens.refreshToken);
  res.json({ ...tokens, user: { id: user.id, username: user.username, role: user.role } });
});

app.post("/api/auth/refresh", (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: "Ingen refresh token" });
  try {
    const payload = jwt.verify(refreshToken, config.jwt_secret);
    if (payload.type !== "refresh") throw new Error();
    const session = db.prepare("SELECT * FROM sessions WHERE refresh_token = ? AND expires_at > CURRENT_TIMESTAMP").get(refreshToken);
    if (!session) return res.status(401).json({ error: "Ogiltig session" });
    const tokens = generateTokens(session.user_id);
    db.prepare("UPDATE sessions SET refresh_token = ?, expires_at = datetime('now','+30 days') WHERE id = ?").run(tokens.refreshToken, session.id);
    res.json(tokens);
  } catch { res.status(401).json({ error: "Ogiltig refresh token" }); }
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) db.prepare("DELETE FROM sessions WHERE refresh_token = ?").run(refreshToken);
  res.json({ ok: true });
});

// ── USERS ──────────────────────────────────────────────────────────────────────
app.get("/api/users", requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT id, username, role, avatar, created_at, last_login FROM users WHERE is_active = 1").all());
});

app.post("/api/users", requireAdmin, async (req, res) => {
  const { username, password, role = "user" } = req.body;
  if (!username || !password || password.length < 6) return res.status(400).json({ error: "Ogiltiga uppgifter" });
  if (db.prepare("SELECT id FROM users WHERE username = ?").get(username.trim())) return res.status(409).json({ error: "Användarnamnet är upptaget" });
  const hash = await bcrypt.hash(password, 12);
  const id = uuidv4();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)").run(id, username.trim(), hash, role);
  res.json({ id, username, role });
});

app.delete("/api/users/:id", requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "Kan inte ta bort dig själv" });
  db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.patch("/api/users/:id/password", requireAuth, async (req, res) => {
  if (req.params.id !== req.user.id && req.user.role !== "admin") return res.status(403).json({ error: "Ej tillåtet" });
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: "För kort lösenord" });
  const hash = await bcrypt.hash(password, 12);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, req.params.id);
  res.json({ ok: true });
});

// ── LIBRARIES ──────────────────────────────────────────────────────────────────
app.get("/api/libraries", requireAuth, (req, res) => res.json(config.libraries || []));

app.post("/api/libraries", requireAdmin, (req, res) => {
  const { name, type, path: libPath } = req.body;
  if (!name || !type || !libPath) return res.status(400).json({ error: "Saknar fält" });
  if (!fs.existsSync(libPath)) return res.status(400).json({ error: "Sökvägen finns inte: " + libPath });
  const lib = { id: uuidv4(), name, type, path: libPath };
  config.libraries.push(lib);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  res.json(lib);
});

app.delete("/api/libraries/:id", requireAdmin, (req, res) => {
  config.libraries = config.libraries.filter(l => l.id !== req.params.id);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  db.prepare("DELETE FROM media_items WHERE library_id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ── MEDIA SCANNING ─────────────────────────────────────────────────────────────
const VIDEO_EXT = new Set([".mp4",".mkv",".avi",".mov",".wmv",".m4v",".ts",".webm",".flv"]);
const AUDIO_EXT = new Set([".mp3",".flac",".aac",".ogg",".wav",".m4a",".opus",".wma"]);

function cleanTitle(name) {
  let n = path.parse(name).name.replace(/[\.\-\_]/g, " ");
  n = n.replace(/\b(1080p|2160p|4k|uhd|720p|480p|bluray|bdrip|webrip|web-dl|hdtv|x264|x265|hevc|avc|aac|dts|ac3|h264|h265|remux|hdr|hdr10|dolby|atmos|truehd|proper|repack)\b/gi, "");
  const yearMatch = n.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? parseInt(yearMatch[0]) : null;
  n = n.replace(/\b(19|20)\d{2}\b.*$/, "").replace(/\s+/g, " ").trim();
  return { cleanName: n, year };
}

const metaCache = new Map();

function tmdbFetch(endpoint) {
  return new Promise(resolve => {
    if (!config.tmdb_api_key) return resolve(null);
    const url = `https://api.themoviedb.org/3${endpoint}&api_key=${config.tmdb_api_key}`;
    https.get(url, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on("error", () => resolve(null));
  });
}

async function getMovieMeta(title, year) {
  const key = `movie:${title}:${year}`;
  if (metaCache.has(key)) return metaCache.get(key);
  const data = await tmdbFetch(`/search/movie?query=${encodeURIComponent(title)}${year ? `&year=${year}` : ""}`);
  const m = data?.results?.[0];
  const meta = m ? {
    tmdb_id: m.id, overview: m.overview || "",
    poster_url: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
    backdrop_url: m.backdrop_path ? `https://image.tmdb.org/t/p/w1280${m.backdrop_path}` : null,
    rating: m.vote_average || null,
    year: m.release_date ? parseInt(m.release_date) : year
  } : null;
  metaCache.set(key, meta);
  return meta;
}

async function getTVMeta(title) {
  const key = `tv:${title}`;
  if (metaCache.has(key)) return metaCache.get(key);
  const data = await tmdbFetch(`/search/tv?query=${encodeURIComponent(title)}`);
  const m = data?.results?.[0];
  const meta = m ? {
    tmdb_id: m.id, overview: m.overview || "",
    poster_url: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
    backdrop_url: m.backdrop_path ? `https://image.tmdb.org/t/p/w1280${m.backdrop_path}` : null,
    rating: m.vote_average || null
  } : null;
  metaCache.set(key, meta);
  return meta;
}

let isScanning = false;

async function scanLibraries() {
  if (isScanning) return;
  isScanning = true;
  let added = 0;
  try {
    for (const lib of (config.libraries || [])) {
      if (!fs.existsSync(lib.path)) continue;
      if (lib.type === "movies") {
        const entries = fs.readdirSync(lib.path, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(lib.path, entry.name);
          let filePath = null;
          if (entry.isFile()) {
            if (VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) filePath = fullPath;
          } else if (entry.isDirectory()) {
            const sub = fs.readdirSync(fullPath, { withFileTypes: true });
            const vf = sub.find(f => f.isFile() && VIDEO_EXT.has(path.extname(f.name).toLowerCase()));
            if (vf) filePath = path.join(fullPath, vf.name);
          }
          if (!filePath) continue;
          const id = Buffer.from(filePath).toString("base64url").slice(0, 64);
          if (db.prepare("SELECT id FROM media_items WHERE id = ?").get(id)) continue;
          const { cleanName, year } = cleanTitle(entry.isDirectory() ? entry.name : path.basename(filePath));
          const meta = await getMovieMeta(cleanName, year);
          const stat = fs.statSync(filePath);
          db.prepare("INSERT OR IGNORE INTO media_items (id,library_id,type,title,year,file_path,file_size,tmdb_id,poster_url,backdrop_url,overview,rating) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(id, lib.id, "movie", cleanName, meta?.year || year, filePath, stat.size, meta?.tmdb_id || null, meta?.poster_url || null, meta?.backdrop_url || null, meta?.overview || null, meta?.rating || null);
          added++;
        }
      }
      if (lib.type === "tvshows") {
        const shows = fs.readdirSync(lib.path, { withFileTypes: true }).filter(f => f.isDirectory());
        for (const show of shows) {
          const showPath = path.join(lib.path, show.name);
          const showId = Buffer.from(showPath).toString("base64url").slice(0, 64);
          if (!db.prepare("SELECT id FROM media_items WHERE id = ?").get(showId)) {
            const { cleanName } = cleanTitle(show.name);
            const meta = await getTVMeta(cleanName);
            db.prepare("INSERT OR IGNORE INTO media_items (id,library_id,type,title,file_path,tmdb_id,poster_url,backdrop_url,overview,rating) VALUES (?,?,?,?,?,?,?,?,?,?)")
              .run(showId, lib.id, "tvshow", cleanName, showPath, meta?.tmdb_id || null, meta?.poster_url || null, meta?.backdrop_url || null, meta?.overview || null, meta?.rating || null);
            added++;
          }
          scanEpisodes(showPath, showId, lib.id);
        }
      }
      if (lib.type === "music") scanMusic(lib.path, lib.id);
    }
  } finally { isScanning = false; }
  console.log(`✅ Scan complete: ${added} new items`);
}

function scanEpisodes(showPath, showId, libId) {
  if (!fs.existsSync(showPath)) return;
  for (const entry of fs.readdirSync(showPath, { withFileTypes: true })) {
    const fullPath = path.join(showPath, entry.name);
    if (entry.isDirectory()) { scanEpisodes(fullPath, showId, libId); continue; }
    if (!VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    const id = Buffer.from(fullPath).toString("base64url").slice(0, 64);
    if (db.prepare("SELECT id FROM media_items WHERE id = ?").get(id)) continue;
    const epMatch = entry.name.match(/[Ss](\d+)[Ee](\d+)/);
    db.prepare("INSERT OR IGNORE INTO media_items (id,library_id,type,title,file_path,file_size,parent_id,season,episode) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, libId, "episode", path.parse(entry.name).name, fullPath, fs.statSync(fullPath).size, showId, epMatch ? parseInt(epMatch[1]) : 0, epMatch ? parseInt(epMatch[2]) : 0);
  }
}

function scanMusic(dir, libId, depth = 0) {
  if (!fs.existsSync(dir) || depth > 4) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) { scanMusic(fullPath, libId, depth + 1); continue; }
    if (!AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    const id = Buffer.from(fullPath).toString("base64url").slice(0, 64);
    if (db.prepare("SELECT id FROM media_items WHERE id = ?").get(id)) continue;
    db.prepare("INSERT OR IGNORE INTO media_items (id,library_id,type,title,file_path,file_size,extra_data) VALUES (?,?,?,?,?,?,?)")
      .run(id, libId, "music", path.parse(entry.name).name, fullPath, fs.statSync(fullPath).size,
        JSON.stringify({ artist: path.basename(path.dirname(path.dirname(fullPath))), album: path.basename(path.dirname(fullPath)) }));
  }
}

// ── MEDIA API ──────────────────────────────────────────────────────────────────
// Get all items, grouped by library
app.get("/api/media", requireAuth, (req, res) => {
  const { type, library_id, search, limit = 200, offset = 0 } = req.query;
  let q = "SELECT * FROM media_items WHERE 1=1";
  const params = [];
  if (type) { q += " AND type = ?"; params.push(type); }
  if (library_id) { q += " AND library_id = ?"; params.push(library_id); }
  if (search) { q += " AND title LIKE ?"; params.push(`%${search}%`); }
  q += " ORDER BY title LIMIT ? OFFSET ?";
  params.push(parseInt(limit), parseInt(offset));
  const items = db.prepare(q).all(...params).map(i => ({ ...i, file_path: undefined }));
  res.json({ items, total: items.length });
});

// Get library contents grouped – NEW for v10
app.get("/api/libraries/:id/contents", requireAuth, (req, res) => {
  const lib = (config.libraries || []).find(l => l.id === req.params.id);
  if (!lib) return res.status(404).json({ error: "Bibliotek hittades inte" });
  const items = db.prepare("SELECT * FROM media_items WHERE library_id = ? AND type IN ('movie','tvshow','music') ORDER BY title")
    .all(req.params.id).map(i => ({ ...i, file_path: undefined }));
  res.json({ library: lib, items, count: items.length });
});

app.get("/api/media/:id", requireAuth, (req, res) => {
  const item = db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
  if (!item) return res.status(404).json({ error: "Hittades inte" });
  const episodes = item.type === "tvshow"
    ? db.prepare("SELECT * FROM media_items WHERE parent_id = ? ORDER BY season, episode").all(item.id).map(e => ({ ...e, file_path: undefined }))
    : [];
  res.json({ ...item, file_path: undefined, episodes });
});

app.get("/api/media/:id/progress", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM watch_history WHERE user_id = ? AND media_id = ?").get(req.user.id, req.params.id) || { position: 0, completed: 0 });
});

app.post("/api/media/:id/progress", requireAuth, (req, res) => {
  const { position, duration, completed = 0 } = req.body;
  db.prepare("INSERT INTO watch_history (id,user_id,media_id,position,duration,completed,watched_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id,media_id) DO UPDATE SET position=excluded.position,duration=excluded.duration,completed=excluded.completed,watched_at=CURRENT_TIMESTAMP")
    .run(uuidv4(), req.user.id, req.params.id, position || 0, duration || 0, completed ? 1 : 0);
  res.json({ ok: true });
});

app.get("/api/continue-watching", requireAuth, (req, res) => {
  const items = db.prepare("SELECT m.*,wh.position,wh.duration,wh.watched_at FROM watch_history wh JOIN media_items m ON m.id=wh.media_id WHERE wh.user_id=? AND wh.completed=0 AND wh.position>30 ORDER BY wh.watched_at DESC LIMIT 20").all(req.user.id);
  res.json(items.map(i => ({ ...i, file_path: undefined })));
});

app.get("/api/recently-added", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM media_items WHERE type IN ('movie','tvshow','music') ORDER BY added_at DESC LIMIT 24").all().map(i => ({ ...i, file_path: undefined })));
});

app.get("/api/favorites", requireAuth, (req, res) => {
  const items = db.prepare("SELECT m.* FROM favorites f JOIN media_items m ON m.id=f.media_id WHERE f.user_id=? ORDER BY f.added_at DESC").all(req.user.id);
  res.json(items.map(i => ({ ...i, file_path: undefined })));
});

app.post("/api/favorites/:id", requireAuth, (req, res) => {
  try { db.prepare("INSERT INTO favorites (user_id,media_id) VALUES (?,?)").run(req.user.id, req.params.id); } catch {}
  res.json({ ok: true });
});

app.delete("/api/favorites/:id", requireAuth, (req, res) => {
  db.prepare("DELETE FROM favorites WHERE user_id=? AND media_id=?").run(req.user.id, req.params.id);
  res.json({ ok: true });
});

// ── STREAMING ──────────────────────────────────────────────────────────────────
const MIME = {
  ".mp4":"video/mp4",".mkv":"video/x-matroska",".avi":"video/x-msvideo",
  ".mov":"video/quicktime",".wmv":"video/x-ms-wmv",".m4v":"video/mp4",
  ".ts":"video/mp2t",".webm":"video/webm",".flv":"video/x-flv",
  ".mp3":"audio/mpeg",".flac":"audio/flac",".aac":"audio/aac",
  ".ogg":"audio/ogg",".wav":"audio/wav",".m4a":"audio/mp4",
  ".opus":"audio/opus",".wma":"audio/x-ms-wma"
};

app.get("/api/stream/:id", requireAuth, (req, res) => {
  const item = db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.id);
  if (!item?.file_path || !fs.existsSync(item.file_path)) return res.status(404).json({ error: "Fil hittades inte" });
  const stat = fs.statSync(item.file_path);
  const ext = path.extname(item.file_path).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(s, 10);
    const end = e ? parseInt(e, 10) : stat.size - 1;
    res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Content-Type": contentType });
    fs.createReadStream(item.file_path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Length": stat.size, "Content-Type": contentType, "Accept-Ranges": "bytes" });
    fs.createReadStream(item.file_path).pipe(res);
  }
});

// ── WHERE TO WATCH ─────────────────────────────────────────────────────────────
app.get("/api/watch-providers/:tmdb_id", requireAuth, async (req, res) => {
  if (!config.tmdb_api_key) return res.json({});
  const data = await tmdbFetch(`/movie/${req.params.tmdb_id}/watch/providers?`);
  res.json(data?.results?.SE || data?.results?.US || {});
});

app.get("/api/search/streaming", requireAuth, async (req, res) => {
  const { query } = req.query;
  if (!query || !config.tmdb_api_key) return res.json({ results: [] });
  const data = await tmdbFetch(`/search/multi?query=${encodeURIComponent(query)}`);
  res.json({ results: (data?.results || []).slice(0, 10).map(r => ({ id: r.id, title: r.title || r.name, type: r.media_type, poster: r.poster_path ? `https://image.tmdb.org/t/p/w300${r.poster_path}` : null, year: (r.release_date || r.first_air_date || "").slice(0, 4) })) });
});

// ── SCAN ───────────────────────────────────────────────────────────────────────
app.post("/api/scan", requireAdmin, (req, res) => {
  res.json({ message: "Skanning startad" });
  scanLibraries().catch(console.error);
});

app.get("/api/scan/status", requireAuth, (req, res) => {
  const counts = db.prepare("SELECT type, COUNT(*) as c FROM media_items GROUP BY type").all();
  res.json({ scanning: isScanning, counts });
});

// ── CONFIG ─────────────────────────────────────────────────────────────────────
app.get("/api/config", requireAdmin, (req, res) => {
  const safe = { ...config }; delete safe.jwt_secret; res.json(safe);
});

app.patch("/api/config", requireAdmin, (req, res) => {
  ["tmdb_api_key", "opensubtitles_api_key", "port", "language"].forEach(k => {
    if (req.body[k] !== undefined) config[k] = req.body[k];
  });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  res.json({ ok: true });
});

// ── UPDATE CHECK ───────────────────────────────────────────────────────────────
app.get("/api/update/check", requireAdmin, (req, res) => {
  https.get(UPDATE_CHECK_URL, { headers: { "User-Agent": "StreamVault" } }, r => {
    let d = ""; r.on("data", c => d += c);
    r.on("end", () => {
      try {
        const data = JSON.parse(d);
        const latest = data.tag_name?.replace("v", "") || VERSION;
        const hasUpdate = latest !== VERSION;
        res.json({ current: VERSION, latest, hasUpdate, releaseUrl: data.html_url, releaseNotes: data.body || "" });
      } catch { res.json({ current: VERSION, latest: VERSION, hasUpdate: false }); }
    });
  }).on("error", () => res.json({ current: VERSION, latest: VERSION, hasUpdate: false }));
});

app.post("/api/update/install", requireAdmin, (req, res) => {
  // In production this downloads and replaces files then restarts
  // For now returns instructions
  res.json({ message: "Laddar ner uppdatering...", status: "pending" });
});

// ── VERSION ────────────────────────────────────────────────────────────────────
app.get("/api/version", (req, res) => res.json({ version: VERSION }));

// ── SERVE FRONTEND ─────────────────────────────────────────────────────────────
const PUBLIC = path.join(__dirname, "..", "public");
if (fs.existsSync(PUBLIC)) {
  app.use(express.static(PUBLIC));
  app.get("*", (req, res) => res.sendFile(path.join(PUBLIC, "index.html")));
}

// ── START ──────────────────────────────────────────────────────────────────────
const PORT = config.port || 7000;
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════╗`);
  console.log(`║   StreamVault v${VERSION}             ║`);
  console.log(`║   http://localhost:${PORT}           ║`);
  console.log(`╚════════════════════════════════════╝\n`);
  setTimeout(() => scanLibraries().catch(console.error), 2000);
});

process.on("SIGTERM", () => { server.close(); db.close(); process.exit(0); });
process.on("SIGINT", () => { server.close(); db.close(); process.exit(0); });

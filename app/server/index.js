const STREAMVAULT_VERSION = require("../package.json").version;
const GITHUB_REPO = "Arrowznet/streamvault";

const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const https = require("https");
const http = require("http");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const Datastore = require("nedb");
const { v4: uuidv4 } = require("uuid");

const DATA_DIR = process.env.STREAMVAULT_DATA
  ? path.join(process.env.STREAMVAULT_DATA, "data")
  : path.join(__dirname, "..", "data");

const CONFIG_PATH = path.join(DATA_DIR, "config.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

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
} catch {} // keys.js is optional

const db = {
  users: new Datastore({ filename: path.join(DATA_DIR, "users.db"), autoload: true }),
  sessions: new Datastore({ filename: path.join(DATA_DIR, "sessions.db"), autoload: true }),
  media: new Datastore({ filename: path.join(DATA_DIR, "media.db"), autoload: true }),
  history: new Datastore({ filename: path.join(DATA_DIR, "history.db"), autoload: true }),
  favorites: new Datastore({ filename: path.join(DATA_DIR, "favorites.db"), autoload: true }),
  loginAttempts: new Datastore({ filename: path.join(DATA_DIR, "attempts.db"), autoload: true })
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

app.get("/api/users", requireAdmin, async (req, res) => {
  const users = await dbFind(db.users, { is_active: true });
  res.json(users.map(u => ({ id: u._id, username: u.username, role: u.role, created_at: u.created_at, last_login: u.last_login })));
});

app.post("/api/users", requireAdmin, async (req, res) => {
  try {
    const { username, password, role = "user" } = req.body;
    if (!username || !password || password.length < 6) return res.status(400).json({ error: "Ogiltiga uppgifter" });
    const existing = await dbFindOne(db.users, { username: username.trim() });
    if (existing) return res.status(409).json({ error: "Användarnamnet är upptaget" });
    const hash = await bcrypt.hash(password, 12);
    const user = await dbInsert(db.users, { _id: uuidv4(), username: username.trim(), password_hash: hash, role, created_at: new Date().toISOString(), is_active: true });
    res.json({ id: user._id, username: user.username, role: user.role });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/users/:id", requireAdmin, async (req, res) => {
  if (req.params.id === req.user._id) return res.status(400).json({ error: "Kan inte ta bort dig själv" });
  await dbUpdate(db.users, { _id: req.params.id }, { $set: { is_active: false } });
  res.json({ ok: true });
});

app.patch("/api/users/:id/password", requireAuth, async (req, res) => {
  if (req.params.id !== req.user._id && req.user.role !== "admin") return res.status(403).json({ error: "Ej tillåtet" });
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: "För kort lösenord" });
  const hash = await bcrypt.hash(password, 12);
  await dbUpdate(db.users, { _id: req.params.id }, { $set: { password_hash: hash } });
  res.json({ ok: true });
});

app.get("/api/libraries", requireAuth, (req, res) => res.json(config.libraries || []));

app.get("/api/version", (req, res) => {
  res.json({ version: STREAMVAULT_VERSION, repo: GITHUB_REPO });
});

app.get("/api/updates/check", requireAuth, async (req, res) => {
  try {
    const data = await new Promise((resolve, reject) => {
      https.get({
        hostname: "api.github.com",
        path: "/repos/" + GITHUB_REPO + "/releases/latest",
        headers: { "User-Agent": "StreamVault/" + STREAMVAULT_VERSION }
      }, r => {
        let d = ""; r.on("data", c => d += c);
        r.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error("parse")); } });
      }).on("error", reject);
    });
    const latest = (data.tag_name || "v" + STREAMVAULT_VERSION).replace(/^v/, "");
    const hasUpdate = latest !== STREAMVAULT_VERSION;
    const downloadUrl = (data.assets || []).find(a => a.name && a.name.endsWith(".exe"))?.browser_download_url || null;
    res.json({ current: STREAMVAULT_VERSION, latest, hasUpdate, releaseNotes: data.body || "", htmlUrl: data.html_url || null, downloadUrl });
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
      spawn(tmpFile, ["/SILENT", "/NORESTART"], {
        detached: true,
        stdio: "ignore"
      }).unref();

    } catch(e) {
      console.log("[UPDATE] Error:", e.message);
    }
  }, 500);
});

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
function tmdbFetch(endpoint) {
  return new Promise(resolve => {
    if (!config.tmdb_api_key) return resolve(null);
    https.get(`https://api.themoviedb.org/3${endpoint}&api_key=${config.tmdb_api_key}`, res => {
      let d=""; res.on("data",c=>d+=c); res.on("end",()=>{ try{resolve(JSON.parse(d))}catch{resolve(null)} });
    }).on("error",()=>resolve(null));
  });
}

async function getMovieMeta(title, year) {
  const key=`movie:${title}:${year}`;
  if(metaCache.has(key)) return metaCache.get(key);
  const data = await tmdbFetch(`/search/movie?query=${encodeURIComponent(title)}${year?`&year=${year}`:""}`);
  const m = data?.results?.[0];
  const meta = m ? { tmdb_id:m.id, overview:m.overview||"", poster_url:m.poster_path?`https://image.tmdb.org/t/p/w500${m.poster_path}`:null, backdrop_url:m.backdrop_path?`https://image.tmdb.org/t/p/w1280${m.backdrop_path}`:null, rating:m.vote_average||null, year:m.release_date?parseInt(m.release_date):year } : null;
  metaCache.set(key, meta);
  return meta;
}

async function getTVMeta(title) {
  const key=`tv:${title}`;
  if(metaCache.has(key)) return metaCache.get(key);
  const data = await tmdbFetch(`/search/tv?query=${encodeURIComponent(title)}`);
  const m = data?.results?.[0];
  const meta = m ? { tmdb_id:m.id, overview:m.overview||"", poster_url:m.poster_path?`https://image.tmdb.org/t/p/w500${m.poster_path}`:null, backdrop_url:m.backdrop_path?`https://image.tmdb.org/t/p/w1280${m.backdrop_path}`:null, rating:m.vote_average||null } : null;
  metaCache.set(key, meta);
  return meta;
}

let isScanning = false;

async function scanLibraries() {
  if (isScanning) return;
  isScanning = true;
  let added = 0;
  try {
    for (const lib of (config.libraries||[])) {
      if (!fs.existsSync(lib.path)) continue;
      if (lib.type === "movies") {
        for (const entry of fs.readdirSync(lib.path,{withFileTypes:true})) {
          const fullPath = path.join(lib.path,entry.name);
          let filePath = null;
          if (entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) filePath=fullPath;
          else if (entry.isDirectory()) {
            const vf = fs.readdirSync(fullPath,{withFileTypes:true}).find(f=>f.isFile()&&VIDEO_EXT.has(path.extname(f.name).toLowerCase()));
            if (vf) filePath=path.join(fullPath,vf.name);
          }
          if (!filePath) continue;
          const id = Buffer.from(filePath).toString("base64url").slice(0,64);
          if (await dbFindOne(db.media,{_id:id})) continue;
          const {cleanName,year} = cleanTitle(entry.isDirectory()?entry.name:path.basename(filePath));
          const meta = await getMovieMeta(cleanName,year);
          const stat = fs.statSync(filePath);
          await dbInsert(db.media,{_id:id,library_id:lib.id,type:"movie",title:cleanName,year:meta?.year||year,file_path:filePath,file_size:stat.size,tmdb_id:meta?.tmdb_id||null,poster_url:meta?.poster_url||null,backdrop_url:meta?.backdrop_url||null,overview:meta?.overview||null,rating:meta?.rating||null,added_at:new Date().toISOString()});
          added++;
        }
      }
      if (lib.type === "tvshows") {
        for (const show of fs.readdirSync(lib.path,{withFileTypes:true}).filter(f=>f.isDirectory())) {
          const showPath=path.join(lib.path,show.name);
          const showId=Buffer.from(showPath).toString("base64url").slice(0,64);
          if (!await dbFindOne(db.media,{_id:showId})) {
            const {cleanName}=cleanTitle(show.name);
            const meta=await getTVMeta(cleanName);
            await dbInsert(db.media,{_id:showId,library_id:lib.id,type:"tvshow",title:cleanName,file_path:showPath,tmdb_id:meta?.tmdb_id||null,poster_url:meta?.poster_url||null,backdrop_url:meta?.backdrop_url||null,overview:meta?.overview||null,rating:meta?.rating||null,added_at:new Date().toISOString()});
            added++;
          }
          await scanEpisodes(showPath,showId,lib.id);
        }
      }
      if (lib.type === "music") await scanMusic(lib.path,lib.id);
    }
  } finally { isScanning=false; }
  console.log(`Scan complete: ${added} new items`);
}

async function scanEpisodes(showPath,showId,libId) {
  if (!fs.existsSync(showPath)) return;
  for (const entry of fs.readdirSync(showPath,{withFileTypes:true})) {
    const fullPath=path.join(showPath,entry.name);
    if (entry.isDirectory()) { await scanEpisodes(fullPath,showId,libId); continue; }
    if (!VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    const id=Buffer.from(fullPath).toString("base64url").slice(0,64);
    if (await dbFindOne(db.media,{_id:id})) continue;
    const em=entry.name.match(/[Ss](\d+)[Ee](\d+)/);
    await dbInsert(db.media,{_id:id,library_id:libId,type:"episode",title:path.parse(entry.name).name,file_path:fullPath,file_size:fs.statSync(fullPath).size,parent_id:showId,season:em?parseInt(em[1]):0,episode:em?parseInt(em[2]):0,added_at:new Date().toISOString()});
  }
}

async function scanMusic(dir,libId,depth=0) {
  if (!fs.existsSync(dir)||depth>4) return;
  for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    const fullPath=path.join(dir,entry.name);
    if (entry.isDirectory()) { await scanMusic(fullPath,libId,depth+1); continue; }
    if (!AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    const id=Buffer.from(fullPath).toString("base64url").slice(0,64);
    if (await dbFindOne(db.media,{_id:id})) continue;
    await dbInsert(db.media,{_id:id,library_id:libId,type:"music",title:path.parse(entry.name).name,file_path:fullPath,file_size:fs.statSync(fullPath).size,extra_data:JSON.stringify({artist:path.basename(path.dirname(path.dirname(fullPath))),album:path.basename(path.dirname(fullPath))}),added_at:new Date().toISOString()});
  }
}

const safe = i => ({ ...i, file_path: undefined, _id: undefined, id: i._id });

app.get("/api/media", requireAuth, async (req, res) => {
  try {
    const {type,library_id,search,limit=200} = req.query;
    const query={};
    if (type) query.type=type;
    if (library_id) query.library_id=library_id;
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
    const items = await dbFind(db.media,{type:{$in:["movie","tvshow","music"]}});
    res.json(items.sort((a,b)=>new Date(b.added_at)-new Date(a.added_at)).slice(0,24).map(safe));
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
      "-show_entries", "format=duration:stream=width,height,codec_name,pix_fmt",
      "-of", "json",
      item.file_path
    ], { timeout: 15000, windowsHide: true }).toString().trim();
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
app.get("/api/stream/:id", requireAuth, async (req, res) => {
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
app.get("/api/playback/:id", requireAuth, async (req, res) => {
  const item = await dbFindOne(db.media, { _id: req.params.id });
  if (!item?.file_path || !fs.existsSync(item.file_path))
    return res.status(404).json({ error: "Fil hittades inte" });

  const ext = path.extname(item.file_path).toLowerCase();
  const ua = req.headers["user-agent"] || "";
  const duration = await getDuration(item);
  const token = req.query.token || "";

  // Check if file uses H.265/HEVC codec (needs transcoding in all browsers)
  let needsTranscode = !canDirectPlay(ext, ua);
  if (!needsTranscode && (ext === ".mkv" || ext === ".mp4")) {
    // Check codec via item metadata or ffprobe
    if (item.codec && (item.codec.includes("hevc") || item.codec.includes("h265") || item.codec.includes("265"))) {
      needsTranscode = true;
      console.log(`[PLAYBACK] ${item.title}: H.265 detected, forcing HLS`);
    }
  }

  console.log(`[PLAYBACK] ${item.title} (${ext}): method=${needsTranscode ? "dash" : "direct"} ua=${ua.includes("edg") ? "Edge" : "Chrome"}`);

  res.json({
    method: needsTranscode ? "dash" : "direct",
    url: needsTranscode
      ? `/api/dash/${item._id}/manifest.mpd?token=${token}`
      : `/api/stream/${item._id}?token=${token}`,
    duration,
    title: item.title
  });
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
    "-i", item.file_path,
    "-avoid_negative_ts", "make_zero",
    ...videoFilterArgs,
    "-c:v", encoder, ...extraArgs,
    "-c:a", "aac", "-ac", "2", "-b:a", "128k",
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
    if (msg) console.log(`[HLS ERR] ${msg}`);
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


// ── DASH TRANSCODE ───────────────────────────────────────────────────────────
const activeDashTranscodes = new Map();
const seekLocks = new Map(); // Prevent concurrent seeks for same item

async function startDashTranscode(item, seekSec = 0) {
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
    console.log(`[DASH] 4K HDR detected (${item.width}x${item.height} 10-bit HEVC) - using d3d11va + scale`);
    hwaccelArgs = ["-hwaccel", "d3d11va"];
    const targetW = 1920;
    const targetH = item.width && item.height
      ? Math.round((item.height / item.width) * targetW / 2) * 2
      : 800;
    videoFilterArgs = ["-vf", `scale=${targetW}:${targetH},format=yuv420p`];
  } else {
    videoFilterArgs = ["-vf", "format=yuv420p"];
  }

  console.log(`[DASH] Using encoder: ${encoder}`);

  const mpdPath = "manifest.mpd"; // relative - cwd set to dashDir

  // For DASH, AMF works without extra args - just encoder + bitrate, no -quality flag
  // -quality before -b:v sets VBR mode which conflicts with DASH muxer
  const dashEncoderArgs = encoder === "h264_amf" ? [] : [...extraArgs];

  const args = [
    "-hide_banner", "-loglevel", "warning",
    ...hwaccelArgs,
    "-re",
    "-fflags", "+genpts+igndts+discardcorrupt",
    "-err_detect", "ignore_err",
    ...(seekSec > 0 ? ["-ss", seekSec.toString()] : []),
    "-i", item.file_path,
    "-avoid_negative_ts", "make_zero",
    ...videoFilterArgs,
    "-c:v", encoder, ...dashEncoderArgs,
    "-b:v", "4000k",
    "-c:a", "aac", "-ac", "2", "-b:a", "128k",
    "-async", "1",
    "-af", "aresample=async=1000",
    "-force_key_frames", "expr:gte(t,n_forced*2)",
    "-f", "dash",
    "-seg_duration", "4",
    "-use_template", "1",
    "-use_timeline", "1",
    "-window_size", "0",
    "-adaptation_sets", "id=0,streams=v id=1,streams=a",
    mpdPath
  ];

  console.log(`[DASH] FFmpeg path: ${ffmpeg}`);
  console.log(`[DASH] Starting transcode: ${item.title}`);
  console.log(`[DASH] Full args: ${args.join(' ')}`);
  const proc = spawn(ffmpeg, args, { windowsHide: false, cwd: dashDir });
  activeDashTranscodes.set(itemId, { proc, startTime: Date.now(), startSec: seekSec, duration: await getDuration(item) });

  let stderrBuf = "";
  proc.stderr.on("data", d => {
    const msg = d.toString().trim();
    stderrBuf += msg + "\n";
    if (msg) console.log(`[DASH ERR] ${msg}`);
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

  // Kill existing transcode if starting from different position
  const existing = activeDashTranscodes.get(item._id);
  if (existing) {
    if (Math.abs((existing.startSec || 0) - startSec) > 5) {
      const oldProc = existing.proc;
      activeDashTranscodes.delete(item._id);
      try { oldProc.kill("SIGKILL"); } catch {}
      // Wait for old process to fully release file locks on Windows
      await new Promise(r => setTimeout(r, 3000));
      startDashTranscode(item, startSec);
    }
    // else reuse existing
  } else {
    startDashTranscode(item, startSec);
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

  console.log(`[DASH] MPD ready for: ${item.title}`);
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
  await startDashTranscode(item, seekSec);

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
  const data = await tmdbFetch(`/movie/${req.params.tmdb_id}/watch/providers?`);
  res.json(data?.results?.SE||data?.results?.US||{});
});

// ── SUBTITLES ─────────────────────────────────────────────────────────────────

// Get available subtitles for a media item (embedded + .srt files)
app.get("/api/media/:id/subtitles", requireAuth, async (req, res) => {
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item) return res.status(404).json({ error: "Not found" });

    const subtitles = [];

    // 1. Check for .srt files in the same directory
    const dir = path.dirname(item.file_path);
    const baseName = path.basename(item.file_path, path.extname(item.file_path));
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith(".srt")) continue;
        const fileLower = file.toLowerCase();
        // Match files like "movie.srt", "movie.sv.srt", "movie.en.srt", "movie.Swedish.srt"
        if (fileLower.startsWith(baseName.toLowerCase()) || fileLower.includes("swedish") || fileLower.includes("english")) {
          let lang = "unknown";
          if (fileLower.includes(".sv.") || fileLower.includes("swedish") || fileLower.includes(".swe.")) lang = "sv";
          else if (fileLower.includes(".en.") || fileLower.includes("english") || fileLower.includes(".eng.")) lang = "en";
          subtitles.push({
            id: "srt_" + file,
            type: "srt",
            lang,
            label: lang === "sv" ? "Svenska (SRT)" : lang === "en" ? "English (SRT)" : file,
            path: path.join(dir, file),
            url: "/api/media/" + item._id + "/subtitle-file?file=" + encodeURIComponent(file)
          });
        }
      }
    } catch {}

    // 2. Check for embedded subtitle tracks via ffprobe
    const ffprobePath = getFfmpegPath().replace("ffmpeg.exe", "ffprobe.exe");
    try {
      const { execFileSync } = require("child_process");
      const probeOut = execFileSync(ffprobePath, [
        "-v", "quiet", "-print_format", "json", "-show_streams",
        "-select_streams", "s", item.file_path
      ], { timeout: 10000, windowsHide: true }).toString();
      const probe = JSON.parse(probeOut);
      (probe.streams || []).forEach((s, i) => {
        const lang = s.tags?.language || s.tags?.LANGUAGE || "und";
        const title = s.tags?.title || s.tags?.TITLE || "";
        subtitles.push({
          id: "embedded_" + i,
          type: "embedded",
          lang,
          index: i,
          label: title || (lang === "swe" || lang === "sv" ? "Svenska" : lang === "eng" || lang === "en" ? "English" : lang),
          codec: s.codec_name
        });
      });
    } catch {}

    // Sort: Swedish first, then English, then others
    subtitles.sort((a, b) => {
      const priority = (l) => (l === "sv" || l === "swe") ? 0 : (l === "en" || l === "eng") ? 1 : 2;
      return priority(a.lang) - priority(b.lang);
    });

    res.json({ subtitles });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve a .srt file as WebVTT for browser playback
app.get("/api/media/:id/subtitle-file", async (req, res) => {
  try {
    const item = await dbFindOne(db.media, { _id: req.params.id });
    if (!item) return res.status(404).json({ error: "Not found" });
    const dir = path.dirname(item.file_path);
    const file = req.query.file;
    if (!file || file.includes("..")) return res.status(400).json({ error: "Invalid" });
    const filePath = path.join(dir, file);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
    // Convert SRT to WebVTT
    let srt = fs.readFileSync(filePath, "utf8");
    // Handle different encodings
    if (srt.charCodeAt(0) === 0xFEFF) srt = srt.slice(1); // BOM
    const vtt = "WEBVTT\n\n" + srt
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/(\d+)\n(\d{2}:\d{2}:\d{2}),(\d{3}) --> (\d{2}:\d{2}:\d{2}),(\d{3})/g, "$2.$3 --> $4.$5");
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.send(vtt);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Search OpenSubtitles
app.get("/api/subtitles/search", requireAuth, async (req, res) => {
  try {
    const { query, lang = "sv", imdb_id } = req.query;
    if (!config.opensubtitles_api_key) return res.json({ subtitles: [] });
    const params = new URLSearchParams({ languages: lang });
    if (imdb_id) params.set("imdb_id", imdb_id);
    else if (query) params.set("query", query);
    const data = await new Promise((resolve, reject) => {
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


app.get("/api/search/streaming", requireAuth, async (req, res) => {
  const {query}=req.query;
  if (!query||!config.tmdb_api_key) return res.json({results:[]});
  const data = await tmdbFetch(`/search/multi?query=${encodeURIComponent(query)}`);
  res.json({results:(data?.results||[]).slice(0,10).map(r=>({id:r.id,title:r.title||r.name,type:r.media_type,poster:r.poster_path?`https://image.tmdb.org/t/p/w300${r.poster_path}`:null,year:(r.release_date||r.first_air_date||"").slice(0,4)}))});
});

app.post("/api/scan", requireAdmin, (req, res) => {
  res.json({message:"Skanning startad"});
  scanLibraries().catch(console.error);
});

app.get("/api/scan/status", requireAuth, async (req, res) => {
  const [movies,tvshows,music] = await Promise.all([dbCount(db.media,{type:"movie"}),dbCount(db.media,{type:"tvshow"}),dbCount(db.media,{type:"music"})]);
  res.json({scanning:isScanning,counts:[{type:"movie",c:movies},{type:"tvshow",c:tvshows},{type:"music",c:music}]});
});

app.get("/api/config", requireAdmin, (req, res) => {
  const s={...config}; delete s.jwt_secret; res.json(s);
});

app.patch("/api/config", requireAdmin, (req, res) => {
  ["tmdb_api_key","opensubtitles_api_key","port","language"].forEach(k=>{if(req.body[k]!==undefined)config[k]=req.body[k];});
  fs.writeFileSync(CONFIG_PATH,JSON.stringify(config,null,2));
  res.json({ok:true});
});

// old update/check endpoint removed
// old version endpoint removed



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
    const results = (data?.results || []).slice(0, 10).map(r => ({
      tmdb_id: r.id,
      title: r.title || r.name,
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
    await dbUpdate(db.media, { _id: req.params.id }, {
      $set: { tmdb_id, title, year: year ? parseInt(year) : undefined, overview, poster_url, backdrop_url, rating }
    });
    res.json({ ok: true });
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
    console.log("Database cleared, starting full rescan...");
    await scanLibraries();
  } catch(e) { console.error("Full rescan error:", e); }
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

        // Debounce – wait 10 seconds after last change before scanning
        // This prevents scanning mid-copy when large files are being transferred
        if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
        nextAutoScan = Date.now() + 10000;
        watchDebounceTimer = setTimeout(async () => {
          if (!isScanning) {
            console.log(`File watcher: detected change in ${lib.name}, scanning...`);
            await scanLibraries().catch(console.error);
          }
        }, 10000);
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
  if (encoderList.includes("h264_nvenc")) candidates.push({
    encoder: "h264_nvenc",
    // Use more compatible test args - no -tune ll which can fail on some cards
    extraArgs: ["-preset", "p4"],
    testArgs: ["-preset", "p4", "-profile:v", "high"]
  });
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

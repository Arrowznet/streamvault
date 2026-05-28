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
const VERSION = "1.0.0";
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaults = { port: 7000, jwt_secret: uuidv4()+uuidv4()+uuidv4(), tmdb_api_key: "", opensubtitles_api_key: "", language: "auto", transcoding: { enabled: true, hardware_accel: "auto" }, libraries: [], version: VERSION };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
let config = loadConfig();

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
    accessToken: jwt.sign({ userId, type: "access" }, config.jwt_secret, { expiresIn: "15m" }),
    refreshToken: jwt.sign({ userId, type: "refresh" }, config.jwt_secret, { expiresIn: "30d" })
  };
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Ej autentiserad" });
  try {
    const payload = jwt.verify(auth.slice(7), config.jwt_secret);
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

app.post("/api/libraries", requireAdmin, (req, res) => {
  const { name, type, path: libPath } = req.body;
  if (!name || !type || !libPath) return res.status(400).json({ error: "Saknar fält" });
  if (!fs.existsSync(libPath)) return res.status(400).json({ error: "Sökvägen finns inte: " + libPath });
  const lib = { id: uuidv4(), name, type, path: libPath };
  config.libraries.push(lib);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  res.json(lib);
});

app.delete("/api/libraries/:id", requireAdmin, async (req, res) => {
  config.libraries = config.libraries.filter(l => l.id !== req.params.id);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  await dbRemove(db.media, { library_id: req.params.id }, { multi: true });
  res.json({ ok: true });
});

const VIDEO_EXT = new Set([".mp4",".mkv",".avi",".mov",".wmv",".m4v",".ts",".webm",".flv"]);
const AUDIO_EXT = new Set([".mp3",".flac",".aac",".ogg",".wav",".m4a",".opus",".wma"]);

function cleanTitle(name) {
  let n = path.parse(name).name.replace(/[\.\-\_]/g," ");
  n = n.replace(/\b(1080p|2160p|4k|uhd|720p|480p|bluray|bdrip|webrip|web-dl|hdtv|x264|x265|hevc|avc|aac|dts|ac3|h264|h265|remux|hdr|dolby|atmos|truehd|proper|repack)\b/gi,"");
  const ym = n.match(/\b(19|20)\d{2}\b/);
  const year = ym ? parseInt(ym[0]) : null;
  n = n.replace(/\b(19|20)\d{2}\b.*$/,"").replace(/\s+/g," ").trim();
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
    res.json({items:items.sort((a,b)=>(a.title||"").localeCompare(b.title||"")).slice(0,parseInt(limit)).map(safe),total:items.length});
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

const MIME={".mp4":"video/mp4",".mkv":"video/x-matroska",".avi":"video/x-msvideo",".mov":"video/quicktime",".wmv":"video/x-ms-wmv",".m4v":"video/mp4",".ts":"video/mp2t",".webm":"video/webm",".flv":"video/x-flv",".mp3":"audio/mpeg",".flac":"audio/flac",".aac":"audio/aac",".ogg":"audio/ogg",".wav":"audio/wav",".m4a":"audio/mp4",".opus":"audio/opus",".wma":"audio/x-ms-wma"};

app.get("/api/stream/:id", requireAuth, async (req, res) => {
  const item = await dbFindOne(db.media,{_id:req.params.id});
  if (!item?.file_path||!fs.existsSync(item.file_path)) return res.status(404).json({error:"Fil hittades inte"});
  const stat=fs.statSync(item.file_path);
  const contentType=MIME[path.extname(item.file_path).toLowerCase()]||"application/octet-stream";
  const range=req.headers.range;
  if (range) {
    const [s,e]=range.replace(/bytes=/,"").split("-");
    const start=parseInt(s,10), end=e?parseInt(e,10):stat.size-1;
    res.writeHead(206,{"Content-Range":`bytes ${start}-${end}/${stat.size}`,"Accept-Ranges":"bytes","Content-Length":end-start+1,"Content-Type":contentType});
    fs.createReadStream(item.file_path,{start,end}).pipe(res);
  } else {
    res.writeHead(200,{"Content-Length":stat.size,"Content-Type":contentType,"Accept-Ranges":"bytes"});
    fs.createReadStream(item.file_path).pipe(res);
  }
});

app.get("/api/watch-providers/:tmdb_id", requireAuth, async (req, res) => {
  if (!config.tmdb_api_key) return res.json({});
  const data = await tmdbFetch(`/movie/${req.params.tmdb_id}/watch/providers?`);
  res.json(data?.results?.SE||data?.results?.US||{});
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

app.get("/api/update/check", requireAdmin, (req, res) => res.json({current:VERSION,latest:VERSION,hasUpdate:false}));
app.get("/api/version", (req, res) => res.json({version:VERSION}));

const PUBLIC=path.join(__dirname,"..","public");
if (fs.existsSync(PUBLIC)) {
  app.use(express.static(PUBLIC));
  app.get("*",(req,res)=>res.sendFile(path.join(PUBLIC,"index.html")));
}

const PORT=config.port||7000;
const server=http.createServer(app);
server.listen(PORT,()=>{
  console.log(`\n StreamVault v${VERSION} - http://localhost:${PORT}\n`);
  setTimeout(()=>scanLibraries().catch(console.error),2000);
});
process.on("SIGTERM",()=>{server.close();process.exit(0);});
process.on("SIGINT",()=>{server.close();process.exit(0);});

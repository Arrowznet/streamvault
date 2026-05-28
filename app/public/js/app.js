// StreamVault v10 - Main App
let currentUser = null;
let nowPlayingId = null;
let allLibraries = [];

// ── INIT ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", async () => {
  const token = localStorage.getItem("sv_token");
  if (token) {
    const user = JSON.parse(localStorage.getItem("sv_user") || "null");
    if (user) { currentUser = user; showApp(); return; }
  }
  try {
    const data = await API.post("/auth/refresh", { refreshToken: API._refresh });
    if (data?.accessToken) {
      API.setTokens(data.accessToken, data.refreshToken);
      const user = JSON.parse(localStorage.getItem("sv_user") || "null");
      if (user) { currentUser = user; showApp(); return; }
    }
  } catch {}
});

// ── LOGIN ─────────────────────────────────────────────────────────────────────
async function login() {
  const username = document.getElementById("l-user").value.trim();
  const password = document.getElementById("l-pass").value;
  const errEl = document.getElementById("l-error");
  errEl.textContent = "";
  if (!username || !password) { errEl.textContent = "Ange användarnamn och lösenord."; return; }
  try {
    const data = await API.post("/auth/login", { username, password });
    API.setTokens(data.accessToken, data.refreshToken);
    currentUser = data.user;
    localStorage.setItem("sv_user", JSON.stringify(data.user));
    showApp();
  } catch (e) { errEl.textContent = e.message || "Inloggning misslyckades."; }
}

document.getElementById("l-pass")?.addEventListener("keydown", e => { if (e.key === "Enter") login(); });

function logout() {
  API.post("/auth/logout", { refreshToken: API._refresh }).catch(() => {});
  API.clearTokens();
  currentUser = null;
  document.getElementById("main-app").style.display = "none";
  document.getElementById("login-screen").style.display = "flex";
  closePlayer();
}

function showApp() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("main-app").style.display = "block";
  document.getElementById("userAvatar").textContent = (currentUser.username || "?")[0].toUpperCase();
  document.getElementById("userName").textContent = currentUser.username;
  loadHome();
  if (currentUser.role === "admin") checkForUpdates();
}

// ── UPDATE CHECK ──────────────────────────────────────────────────────────────
async function checkForUpdates() {
  try {
    const data = await API.get("/update/check");
    if (data.hasUpdate) {
      showUpdateBanner(data.latest, data.releaseUrl);
    }
  } catch {}
}

function showUpdateBanner(version, url) {
  const banner = document.createElement("div");
  banner.id = "update-banner";
  banner.style.cssText = `
    position:fixed;bottom:80px;right:24px;z-index:300;
    background:#0d3d24;border:1px solid #2ecc71;border-radius:10px;
    padding:14px 18px;font-size:13px;color:#2ecc71;
    display:flex;align-items:center;gap:14px;
    box-shadow:0 4px 20px rgba(0,0,0,0.4);max-width:320px;
  `;
  banner.innerHTML = `
    <span style="font-size:20px">🎉</span>
    <div style="flex:1">
      <div style="font-weight:600;margin-bottom:2px">StreamVault ${version} tillgänglig!</div>
      <div style="opacity:0.8;font-size:12px">Ny version finns att ladda ner</div>
    </div>
    <button onclick="window.open('${url}')" style="background:#2ecc71;border:none;color:#0a0a0a;font-size:12px;font-weight:600;padding:6px 12px;border-radius:6px;cursor:pointer">Uppdatera</button>
    <button onclick="this.parentElement.remove()" style="background:none;border:none;color:#2ecc71;cursor:pointer;font-size:16px">✕</button>
  `;
  document.body.appendChild(banner);
}

// ── NAV ───────────────────────────────────────────────────────────────────────
function switchSection(name) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".ntab").forEach(b => b.classList.remove("active"));
  document.getElementById("sec-" + name).classList.add("active");
  const tabs = ["home","movies","tvshows","music","search"];
  const idx = tabs.indexOf(name);
  if (idx >= 0) document.querySelectorAll(".ntab")[idx]?.classList.add("active");
  if (name === "home") loadHome();
  else if (name === "movies") loadMediaSection("movies");
  else if (name === "tvshows") loadMediaSection("tvshows");
  else if (name === "music") loadMusicPage();
  else if (name === "search") loadSearchPage();
  else if (name === "settings") loadSettings();
  document.getElementById("userMenu").style.display = "none";
}

function toggleUserMenu() {
  const m = document.getElementById("userMenu");
  m.style.display = m.style.display === "none" ? "block" : "none";
}
document.addEventListener("click", e => {
  if (!e.target.closest(".nav-user")) document.getElementById("userMenu").style.display = "none";
});

// ── HOME ──────────────────────────────────────────────────────────────────────
async function loadHome() {
  const sec = document.getElementById("sec-home");
  sec.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const [libs, continueW, recents] = await Promise.all([
      API.get("/libraries"),
      API.get("/continue-watching"),
      API.get("/recently-added")
    ]);
    allLibraries = libs;
    let html = "";

    // Hero from first movie with backdrop
    const firstMovieLib = libs.find(l => l.type === "movies");
    if (firstMovieLib) {
      const data = await API.get(`/libraries/${firstMovieLib.id}/contents`);
      const featured = data.items.find(m => m.backdrop_url) || data.items[0];
      if (featured) html += buildHero(featured);
    }

    if (continueW?.length) html += buildRow("Fortsätt titta", continueW);
    if (recents?.length) html += buildRow("Nytt i biblioteket", recents.slice(0, 16));

    // Show each library as its own row
    for (const lib of libs) {
      const data = await API.get(`/libraries/${lib.id}/contents`);
      if (data.items.length) {
        html += buildRow(lib.name, data.items.slice(0, 16));
      }
    }

    sec.innerHTML = html || `<div class="empty"><div class="empty-icon">🎬</div><h3>Biblioteket är tomt</h3><p>Lägg till mediabibliotek under Inställningar → Bibliotek</p></div>`;
  } catch (e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>Kunde inte ladda</h3><p>${e.message}</p></div>`;
  }
}

// ── MEDIA SECTION (Movies/Shows) – grouped by library ─────────────────────────
async function loadMediaSection(sectionType) {
  const secId = sectionType === "movies" ? "sec-movies" : "sec-tvshows";
  const sec = document.getElementById(secId);
  sec.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const libs = await API.get("/libraries");
    const relevantLibs = libs.filter(l => l.type === sectionType);
    if (!relevantLibs.length) {
      sec.innerHTML = `<div class="empty"><div class="empty-icon">${sectionType === "movies" ? "🎬" : "📺"}</div><h3>Inga bibliotek hittades</h3><p>Lägg till ett bibliotek under Inställningar</p></div>`;
      return;
    }

    let html = `<div class="grid-wrap">
      <div class="filter-bar">
        <input class="filter-input" type="text" placeholder="Sök..." id="filter-q-${sectionType}" oninput="filterMediaSection('${sectionType}')"/>
        <select class="filter-select" id="filter-sort-${sectionType}" onchange="filterMediaSection('${sectionType}')">
          <option value="title">A–Ö</option>
          <option value="year">År (nyast)</option>
          <option value="rating">Betyg</option>
        </select>
      </div>`;

    // Fetch all libraries and render each as its own section
    for (const lib of relevantLibs) {
      const data = await API.get(`/libraries/${lib.id}/contents`);
      html += `
        <div class="section-group" data-lib="${lib.id}" data-type="${sectionType}">
          <div class="row-header" style="margin-bottom:14px">
            <span class="row-title">📁 ${esc(lib.name)}</span>
            <span class="row-count">${data.items.length} ${sectionType === "movies" ? "titlar" : "serier"}</span>
          </div>
          <div class="media-grid lib-grid-${lib.id}" data-items='${JSON.stringify(data.items.map(i => ({ id: i.id, title: i.title, year: i.year, rating: i.rating, poster_url: i.poster_url, type: i.type, added_at: i.added_at })))}'>
            ${data.items.map(i => buildCard(i, sectionType === "tvshows")).join("")}
          </div>
        </div>`;
    }
    html += "</div>";
    sec.innerHTML = html;
  } catch (e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>${e.message}</h3></div>`;
  }
}

function filterMediaSection(sectionType) {
  const q = (document.getElementById(`filter-q-${sectionType}`)?.value || "").toLowerCase();
  const sort = document.getElementById(`filter-sort-${sectionType}`)?.value || "title";
  document.querySelectorAll(`.section-group[data-type="${sectionType}"]`).forEach(group => {
    const libId = group.getAttribute("data-lib");
    const grid = group.querySelector(`.lib-grid-${libId}`);
    if (!grid) return;
    let items = JSON.parse(grid.getAttribute("data-items") || "[]");
    if (q) items = items.filter(i => (i.title || "").toLowerCase().includes(q));
    if (sort === "title") items.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === "year") items.sort((a, b) => (b.year || 0) - (a.year || 0));
    else if (sort === "rating") items.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    grid.innerHTML = items.map(i => buildCard(i, sectionType === "tvshows")).join("") ||
      `<div style="color:var(--muted);font-size:14px;padding:20px 0">Inga träffar</div>`;
    // Show/hide the group based on results
    group.style.display = q && !items.length ? "none" : "block";
  });
}

// ── MUSIC ─────────────────────────────────────────────────────────────────────
async function loadMusicPage() {
  const sec = document.getElementById("sec-music");
  sec.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const data = await API.get("/media?type=music&limit=500");
    if (!data.items.length) {
      sec.innerHTML = `<div class="empty"><div class="empty-icon">🎵</div><h3>Ingen musik hittad</h3></div>`;
      return;
    }
    const byArtist = {};
    data.items.forEach(t => {
      let meta = {};
      try { meta = JSON.parse(t.extra_data || "{}"); } catch {}
      const artist = meta.artist || "Okänd artist";
      if (!byArtist[artist]) byArtist[artist] = [];
      byArtist[artist].push({ ...t, _artist: artist, _album: meta.album || "" });
    });
    let html = `<div style="padding:28px">`;
    Object.entries(byArtist).forEach(([artist, tracks]) => {
      html += `<div class="section" style="margin-bottom:28px">
        <div class="row-header"><span class="row-title">🎤 ${esc(artist)}</span><span class="row-count">${tracks.length} låtar</span></div>
        <div>${tracks.map(t => buildMusicRow(t)).join("")}</div>
      </div>`;
    });
    html += "</div>";
    sec.innerHTML = html;
  } catch (e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>${e.message}</h3></div>`;
  }
}

function buildMusicRow(t) {
  const playing = nowPlayingId === t.id;
  return `<div class="music-track${playing ? " now-playing" : ""}" onclick='playMusic("${t.id}","${esc(t.title)}","${esc(t._artist)}")'>
    <span class="mt-icon">${playing ? "🎵" : "♪"}</span>
    <div class="mt-info"><div class="mt-title">${esc(t.title)}</div><div class="mt-artist">${esc(t._artist)}</div></div>
    <div class="mt-album">${esc(t._album)}</div>
  </div>`;
}

// ── HERO ──────────────────────────────────────────────────────────────────────
function buildHero(item) {
  const bg = item.backdrop_url ? `style="background-image:url('${item.backdrop_url}')"` : "";
  const pct = 0;
  return `<div class="hero">
    <div class="hero-bg" ${bg}></div>
    <div class="hero-content">
      <div class="hero-badge">Utvalda</div>
      <div class="hero-title">${esc(item.title)}</div>
      <div class="hero-meta">
        ${item.rating ? `<span class="hero-rating">⭐ ${parseFloat(item.rating).toFixed(1)}</span>` : ""}
        ${item.year ? `<span>${item.year}</span>` : ""}
      </div>
      ${item.overview ? `<div class="hero-overview">${esc(item.overview)}</div>` : ""}
      <div class="hero-actions">
        <button class="btn-play" onclick='playItem("${item.id}","${esc(item.title)}")'>▶ Spela</button>
        <button class="btn-info" onclick='openDetail("${item.id}")'>ℹ Mer info</button>
      </div>
    </div>
  </div>`;
}

function buildRow(title, items) {
  if (!items?.length) return "";
  return `<div class="row-section">
    <div class="row-header"><span class="row-title">${esc(title)}</span><span class="row-count">${items.length}</span></div>
    <div class="row-scroll">${items.map(i => buildCard(i, i.type === "tvshow")).join("")}</div>
  </div>`;
}

function buildCard(item, wide = false) {
  const poster = item.poster_url
    ? `<img class="mcard-poster" src="${item.poster_url}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    : "";
  const ph = `<div class="mcard-poster-ph" ${item.poster_url ? 'style="display:none"' : ""}><span>${item.type === "tvshow" ? "📺" : item.type === "music" ? "🎵" : "🎬"}</span><span>${esc((item.title || "").slice(0, 14))}</span></div>`;
  return `<div class="mcard${wide ? " mcard-wide" : ""}" onclick='openDetail("${item.id}")'>
    <div style="position:relative">${poster}${ph}<div class="mcard-overlay"><span class="mcard-play">▶</span></div></div>
    <div class="mcard-info">
      <div class="mcard-title">${esc(item.title)}</div>
      <div class="mcard-meta">${item.rating ? `<span class="mcard-rating">⭐ ${parseFloat(item.rating).toFixed(1)}</span> ` : ""}${item.year || ""}</div>
    </div>
  </div>`;
}

// ── DETAIL ────────────────────────────────────────────────────────────────────
async function openDetail(id) {
  const ov = document.getElementById("detail-overlay");
  ov.style.display = "flex";
  ov.innerHTML = `<div class="detail-box"><div class="spinner-wrap"><div class="spinner"></div></div></div>`;
  try {
    const [item, progress] = await Promise.all([API.get("/media/" + id), API.get("/media/" + id + "/progress")]);
    const pct = progress?.duration ? Math.round((progress.position / progress.duration) * 100) : 0;
    const playLabel = pct > 5 && pct < 95 ? `▶ Fortsätt (${pct}%)` : "▶ Spela";
    let episodesHtml = "";
    if (item.type === "tvshow" && item.episodes?.length) {
      episodesHtml = `<div style="margin-top:20px"><div class="wtw-title">Avsnitt (${item.episodes.length})</div>
        <div class="episode-list">${item.episodes.map(ep => {
          const label = ep.season && ep.episode ? `S${String(ep.season).padStart(2,"0")} E${String(ep.episode).padStart(2,"0")}` : "Avsnitt";
          return `<div class="ep-item" onclick='playItem("${ep.id}","${esc(item.title)} · ${label}"); closeDetail()'>
            <span class="ep-num">${label}</span><span class="ep-name">${esc(ep.title || "")}</span><span>▶</span>
          </div>`;
        }).join("")}</div></div>`;
    }
    let wtwHtml = "";
    if (item.tmdb_id && item.type === "movie") {
      wtwHtml = `<div class="wtw-section"><div class="wtw-title">Var kan du se den?</div>
        <div class="wtw-providers" id="wtw-${id}"><span style="font-size:13px;color:var(--muted)">Hämtar...</span></div></div>`;
    }
    ov.innerHTML = `<div class="detail-box">
      ${item.backdrop_url ? `<img class="detail-backdrop" src="${item.backdrop_url}" alt=""/>` : `<div class="detail-backdrop-ph">${item.type === "tvshow" ? "📺" : "🎬"}</div>`}
      <button class="detail-close" onclick="closeDetail()">✕</button>
      <div class="detail-body">
        <div class="detail-title">${esc(item.title)}</div>
        <div class="detail-meta">
          ${item.rating ? `<span class="detail-rating">⭐ ${parseFloat(item.rating).toFixed(1)}</span>` : ""}
          ${item.year ? `<span>${item.year}</span>` : ""}
          ${item.type === "tvshow" ? `<span>${item.episodes?.length || 0} avsnitt</span>` : ""}
        </div>
        ${item.overview ? `<div class="detail-overview">${esc(item.overview)}</div>` : ""}
        <div class="detail-actions">
          ${item.type !== "tvshow" ? `<button class="btn-play" onclick='playItem("${item.id}","${esc(item.title)}"); closeDetail()'>${playLabel}</button>` : ""}
          <button class="btn-fav" onclick="toggleFav('${item.id}',this)">♡ Favorit</button>
        </div>
        ${wtwHtml}${episodesHtml}
      </div>
    </div>`;
    if (item.tmdb_id && item.type === "movie") {
      API.get("/watch-providers/" + item.tmdb_id).then(data => {
        const el = document.getElementById("wtw-" + id);
        if (!el) return;
        const flat = new Set((data.flatrate || []).map(p => p.provider_name));
        const providers = [...new Set([...(data.flatrate || []), ...(data.rent || [])].map(p => p.provider_name))];
        el.innerHTML = providers.length
          ? providers.map(n => `<span class="wtw-pill ${flat.has(n) ? "stream" : "rent"}">${esc(n)}</span>`).join("")
          : `<span style="font-size:13px;color:var(--muted)">Inte tillgänglig på streamingtjänster</span>`;
      }).catch(() => {});
    }
  } catch (e) {
    ov.innerHTML = `<div class="detail-box" style="padding:40px;text-align:center;color:var(--muted)">${e.message}</div>`;
  }
}

function closeDetail() {
  const ov = document.getElementById("detail-overlay");
  ov.style.display = "none";
  ov.innerHTML = "";
}
document.getElementById("detail-overlay")?.addEventListener("click", e => {
  if (e.target === document.getElementById("detail-overlay")) closeDetail();
});

async function toggleFav(id, btn) {
  try {
    await API.post("/favorites/" + id, {});
    btn.textContent = "♥ Tillagd";
    btn.style.color = "var(--accent2)";
    toast("Tillagd i favoriter!", "success");
  } catch { toast("Fel vid sparande", "error"); }
}

// ── PLAYBACK ──────────────────────────────────────────────────────────────────
function playItem(id, title) {
  const bar = document.getElementById("player-bar");
  const video = document.getElementById("main-video");
  video.src = "/api/stream/" + id + "?token=" + API._token;
  video.play();
  bar.style.display = "flex";
  document.getElementById("pb-title").textContent = title;
  document.getElementById("pb-sub").textContent = "";
  document.body.style.paddingBottom = "320px";
  nowPlayingId = id;
  video.ontimeupdate = () => {
    if (video.duration > 30) {
      API.post("/media/" + id + "/progress", {
        position: Math.floor(video.currentTime),
        duration: Math.floor(video.duration),
        completed: video.currentTime / video.duration > 0.9 ? 1 : 0
      }).catch(() => {});
    }
  };
}

function playMusic(id, title, artist) {
  const bar = document.getElementById("player-bar");
  const video = document.getElementById("main-video");
  video.src = "/api/stream/" + id + "?token=" + API._token;
  video.play();
  bar.style.display = "flex";
  document.getElementById("pb-title").textContent = title;
  document.getElementById("pb-sub").textContent = artist;
  document.body.style.paddingBottom = "100px";
  nowPlayingId = id;
  loadMusicPage();
}

function closePlayer() {
  const video = document.getElementById("main-video");
  video?.pause();
  if (video) video.src = "";
  document.getElementById("player-bar").style.display = "none";
  document.body.style.paddingBottom = "";
  nowPlayingId = null;
}

// ── SEARCH ────────────────────────────────────────────────────────────────────
function loadSearchPage() {
  document.getElementById("sec-search").innerHTML = `
  <div class="search-wrap">
    <div class="search-big">Sök</div>
    <div class="search-input-wrap">
      <span class="search-ico">🔍</span>
      <input class="search-big-input" type="text" id="search-q" placeholder="Sök filmer, serier, musik..." oninput="handleSearch()" autofocus/>
    </div>
    <div id="search-results"></div>
  </div>`;
}

let searchTimer = null;
async function handleSearch() {
  clearTimeout(searchTimer);
  const q = document.getElementById("search-q")?.value?.trim();
  const res = document.getElementById("search-results");
  if (!q || q.length < 2) { if (res) res.innerHTML = ""; return; }
  searchTimer = setTimeout(async () => {
    res.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
    try {
      const [local, online] = await Promise.all([
        API.get("/media?search=" + encodeURIComponent(q) + "&limit=24"),
        API.get("/search/streaming?query=" + encodeURIComponent(q)).catch(() => ({ results: [] }))
      ]);
      let html = "";
      if (local.items?.length) {
        html += `<div class="search-results-title">I ditt bibliotek</div>`;
        html += `<div class="media-grid">${local.items.map(i => buildCard(i, i.type === "tvshow")).join("")}</div>`;
      }
      if (online.results?.length) {
        html += `<div class="search-results-title" style="margin-top:28px">Var kan du se det?</div>`;
        html += `<div style="display:flex;gap:12px;flex-wrap:wrap">${online.results.slice(0, 8).map(r =>
          `<div class="mcard">
            ${r.poster ? `<img class="mcard-poster" src="${r.poster}" loading="lazy">` : `<div class="mcard-poster-ph"><span>🎬</span></div>`}
            <div class="mcard-info"><div class="mcard-title">${esc(r.title)}</div><div class="mcard-meta">${r.year || ""}</div></div>
          </div>`).join("")}</div>`;
      }
      res.innerHTML = html || `<div class="empty"><div class="empty-icon">🔍</div><h3>Inga träffar för "${esc(q)}"</h3></div>`;
    } catch { res.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>Sökning misslyckades</h3></div>`; }
  }, 400);
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  if (currentUser.role !== "admin") {
    document.getElementById("sec-settings").innerHTML = `<div class="empty"><div class="empty-icon">🔒</div><h3>Kräver adminbehörighet</h3></div>`;
    return;
  }
  const sec = document.getElementById("sec-settings");
  sec.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const [cfg, users, libs, scanStatus, updateInfo] = await Promise.all([
      API.get("/config"), API.get("/users"), API.get("/libraries"),
      API.get("/scan/status"), API.get("/update/check").catch(() => null)
    ]);
    const counts = Object.fromEntries((scanStatus.counts || []).map(c => [c.type, c.c]));

    sec.innerHTML = `<div class="settings-wrap">
      <div class="settings-title">Inställningar</div>

      ${updateInfo?.hasUpdate ? `
      <div style="background:#0d3d24;border:1px solid #2ecc71;border-radius:10px;padding:16px 20px;margin-bottom:28px;display:flex;align-items:center;gap:16px">
        <span style="font-size:24px">🎉</span>
        <div style="flex:1">
          <div style="font-size:14px;font-weight:600;color:#2ecc71">StreamVault ${updateInfo.latest} är tillgänglig!</div>
          <div style="font-size:12px;color:#2ecc71;opacity:0.8;margin-top:2px">Du kör version ${updateInfo.current}</div>
        </div>
        <button class="s-btn" onclick="window.open('${updateInfo.releaseUrl}')" style="border-color:#2ecc71;color:#2ecc71">Ladda ner</button>
      </div>` : ""}

      <div class="settings-section">
        <div class="settings-section-title">Biblioteksstatus</div>
        <div style="display:flex;gap:12px;margin-bottom:12px">
          <div style="background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:14px 20px;text-align:center">
            <div style="font-size:22px;font-weight:600">${counts.movie || 0}</div>
            <div style="font-size:12px;color:var(--muted)">Filmer</div>
          </div>
          <div style="background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:14px 20px;text-align:center">
            <div style="font-size:22px;font-weight:600">${counts.tvshow || 0}</div>
            <div style="font-size:12px;color:var(--muted)">Serier</div>
          </div>
          <div style="background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:14px 20px;text-align:center">
            <div style="font-size:22px;font-weight:600">${counts.music || 0}</div>
            <div style="font-size:12px;color:var(--muted)">Låtar</div>
          </div>
        </div>
        <button class="s-btn primary" onclick="rescan()">↻ Skanna om biblioteket</button>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Bibliotek</div>
        <div class="user-list" id="lib-list">
          ${libs.map(l => {
            const icons = { movies:"🎬", tvshows:"📺", music:"🎵" };
            return `<div class="user-row">
              <span style="font-size:20px">${icons[l.type] || "📁"}</span>
              <div class="user-info"><div class="user-name">${esc(l.name)}</div><div class="user-role">${esc(l.path)}</div></div>
              <button class="s-btn danger" onclick="removeLib('${l.id}')">Ta bort</button>
            </div>`;
          }).join("") || "<p style='color:var(--muted);font-size:14px'>Inga bibliotek tillagda.</p>"}
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <input class="s-input" id="new-lib-name" placeholder="Namn"/>
          <select class="filter-select" id="new-lib-type">
            <option value="movies">🎬 Filmer</option>
            <option value="tvshows">📺 TV-serier</option>
            <option value="music">🎵 Musik</option>
          </select>
          <div style="display:flex;gap:6px;flex:1">
            <input class="s-input" id="new-lib-path" placeholder="Sökväg (ex: D:\\Movies)" style="flex:1"/>
            <button class="s-btn" onclick="openFolderBrowser(p => { document.getElementById('new-lib-path').value = p; })" style="flex-shrink:0">📁 Bläddra</button>
          </div>
          <button class="s-btn primary" onclick="addLib()">Lägg till</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Användare</div>
        <div class="user-list">
          ${users.map(u => `<div class="user-row">
            <div class="user-av">${(u.username || "?")[0].toUpperCase()}</div>
            <div class="user-info">
              <div class="user-name">${esc(u.username)}</div>
              <div class="user-role">Senast inloggad: ${u.last_login ? new Date(u.last_login).toLocaleDateString("sv-SE") : "Aldrig"}</div>
            </div>
            <span class="user-badge ${u.role === "admin" ? "badge-admin" : "badge-user"}">${u.role === "admin" ? "Admin" : "Användare"}</span>
            ${u.id !== currentUser.id ? `<button class="s-btn danger" onclick="deleteUser('${u.id}')">Ta bort</button>` : ""}
          </div>`).join("")}
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <input class="s-input" id="new-user" placeholder="Användarnamn"/>
          <input class="s-input" type="password" id="new-pass" placeholder="Lösenord"/>
          <select class="filter-select" id="new-role"><option value="user">Användare</option><option value="admin">Admin</option></select>
          <button class="s-btn primary" onclick="addUser()">Lägg till</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Byt lösenord</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input class="s-input" type="password" id="new-own-pass" placeholder="Nytt lösenord"/>
          <button class="s-btn primary" onclick="changeOwnPassword()">Byt lösenord</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">API-nycklar</div>
        <div class="setting-row">
          <div><div class="setting-label">TMDB API-nyckel</div><div class="setting-desc">Filmaffischer och beskrivningar</div></div>
          <input class="s-input" id="s-tmdb" value="${esc(cfg.tmdb_api_key || "")}" placeholder="Ej angiven"/>
        </div>
        <div class="setting-row">
          <div><div class="setting-label">OpenSubtitles API-nyckel</div><div class="setting-desc">Automatiska undertexter</div></div>
          <input class="s-input" id="s-opensub" value="${esc(cfg.opensubtitles_api_key || "")}" placeholder="Ej angiven"/>
        </div>
        <div style="margin-top:12px"><button class="s-btn primary" onclick="saveApiKeys()">Spara nycklar</button></div>
      </div>

      <div style="padding:20px 0;font-size:12px;color:var(--muted)">StreamVault v${updateInfo?.current || "1.0.0"}</div>
    </div>`;
  } catch (e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>${e.message}</h3></div>`;
  }
}

async function rescan() {
  toast("Skannar om biblioteket...", "info");
  try { await API.post("/scan", {}); toast("Skanning startad!", "success"); }
  catch (e) { toast(e.message, "error"); }
}

async function addUser() {
  const username = document.getElementById("new-user").value.trim();
  const password = document.getElementById("new-pass").value;
  const role = document.getElementById("new-role").value;
  if (!username || !password) { toast("Ange användarnamn och lösenord", "error"); return; }
  try { await API.post("/users", { username, password, role }); toast(`✓ ${username} skapad!`, "success"); loadSettings(); }
  catch (e) { toast(e.message, "error"); }
}

async function deleteUser(id) {
  if (!confirm("Ta bort användaren?")) return;
  try { await API.delete("/users/" + id); toast("Användare borttagen", "success"); loadSettings(); }
  catch (e) { toast(e.message, "error"); }
}

async function addLib() {
  const name = document.getElementById("new-lib-name").value.trim();
  const type = document.getElementById("new-lib-type").value;
  const path = document.getElementById("new-lib-path").value.trim();
  if (!name || !path) { toast("Ange namn och sökväg", "error"); return; }
  try { await API.post("/libraries", { name, type, path }); toast(`✓ ${name} tillagd!`, "success"); loadSettings(); }
  catch (e) { toast(e.message, "error"); }
}

async function removeLib(id) {
  if (!confirm("Ta bort biblioteket? Mediaobjekten tas bort från databasen men filerna på disk rörs inte.")) return;
  try { await API.delete("/libraries/" + id); toast("Bibliotek borttaget", "success"); loadSettings(); }
  catch (e) { toast(e.message, "error"); }
}

async function saveApiKeys() {
  try {
    await API.patch("/config", {
      tmdb_api_key: document.getElementById("s-tmdb").value.trim(),
      opensubtitles_api_key: document.getElementById("s-opensub").value.trim()
    });
    toast("✓ Nycklar sparade!", "success");
  } catch (e) { toast(e.message, "error"); }
}

async function changeOwnPassword() {
  const password = document.getElementById("new-own-pass").value;
  if (!password || password.length < 6) { toast("Lösenordet måste vara minst 6 tecken", "error"); return; }
  try {
    await API.patch(`/users/${currentUser.id}/password`, { password });
    toast("✓ Lösenord ändrat!", "success");
    document.getElementById("new-own-pass").value = "";
  } catch (e) { toast(e.message, "error"); }
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function esc(s) {
  return (s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function toast(msg, type = "info") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove("show"), 3500);
}

// ── FOLDER BROWSER ─────────────────────────────────────────────────────────────
let fbCallback = null;
let fbSelected = null;

async function openFolderBrowser(callback) {
  fbCallback = callback;
  fbSelected = null;

  const overlay = document.createElement("div");
  overlay.className = "fb-overlay";
  overlay.id = "fb-overlay";
  overlay.innerHTML = `
    <div class="fb-modal">
      <div class="fb-header">
        <span style="font-size:20px">📁</span>
        <span class="fb-title">Välj mapp</span>
        <button class="fb-close" onclick="closeFolderBrowser()">✕</button>
      </div>
      <div class="fb-path" id="fb-path">Väljer startposition...</div>
      <div class="fb-body" id="fb-body">
        <div class="fb-spinner">⏳ Laddar...</div>
      </div>
      <div class="fb-footer">
        <span class="fb-selected-path" id="fb-selected-display">Ingen mapp vald</span>
        <button class="btn btn-ghost btn-sm" onclick="closeFolderBrowser()">Avbryt</button>
        <button class="btn btn-primary btn-sm" id="fb-select-btn" onclick="confirmFolderSelection()" disabled>Välj denna mapp</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  await loadFolder("");
}

function closeFolderBrowser() {
  document.getElementById("fb-overlay")?.remove();
  fbCallback = null;
  fbSelected = null;
}

async function loadFolder(folderPath) {
  const body = document.getElementById("fb-body");
  const pathEl = document.getElementById("fb-path");
  if (!body) return;

  body.innerHTML = `<div class="fb-spinner">⏳ Laddar...</div>`;

  try {
    const url = "/api/browse" + (folderPath ? "?path=" + encodeURIComponent(folderPath) : "");
    const data = await API.get(url.replace("/api", ""));
    
    pathEl.textContent = data.current || "Enheter";

    let html = "";

    // Up button
    if (data.parent !== null && data.parent !== undefined) {
      html += `<div class="fb-up" onclick='loadFolder(${JSON.stringify(data.parent)})'>
        <span class="fb-icon">⬆️</span>
        <span>.. (upp en nivå)</span>
      </div>`;
    }

    if (!data.items.length) {
      html += `<div style="text-align:center;padding:32px;color:var(--muted);font-size:13px">Mappen är tom</div>`;
    }

    data.items.forEach(item => {
      const icon = item.type === "drive" ? "💾" : "📁";
      html += `<div class="fb-item" onclick='selectFolderItem(${JSON.stringify(item.path)}, ${JSON.stringify(item.name)})'>
        <span class="fb-icon">${icon}</span>
        <span class="fb-name">${esc(item.name)}</span>
        <span class="fb-arrow">›</span>
      </div>`;
    });

    body.innerHTML = html;

    // If we're in a folder (not root), allow selecting current folder
    if (data.current) {
      fbSelected = data.current;
      const display = document.getElementById("fb-selected-display");
      const btn = document.getElementById("fb-select-btn");
      if (display) display.textContent = data.current;
      if (btn) btn.disabled = false;
    }

  } catch(e) {
    body.innerHTML = `<div class="fb-spinner">⚠️ Kunde inte ladda mappen: ${e.message}</div>`;
  }
}

function selectFolderItem(itemPath, name) {
  // Mark as selected and navigate into it
  document.querySelectorAll(".fb-item").forEach(el => el.classList.remove("selected"));
  event.currentTarget.classList.add("selected");
  fbSelected = itemPath;
  const display = document.getElementById("fb-selected-display");
  const btn = document.getElementById("fb-select-btn");
  if (display) display.textContent = itemPath;
  if (btn) btn.disabled = false;
  // Navigate into folder after short delay
  setTimeout(() => loadFolder(itemPath), 200);
}

function confirmFolderSelection() {
  if (!fbSelected || !fbCallback) return;
  fbCallback(fbSelected);
  closeFolderBrowser();
}

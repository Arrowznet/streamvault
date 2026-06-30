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

async function showApp() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("main-app").style.display = "flex";
  document.getElementById("userAvatar").textContent = (currentUser.username || "?")[0].toUpperCase();
  document.getElementById("userName").textContent = currentUser.username;
  loadSidebarLibraries();
  loadHome();
  if (currentUser.role === "admin") checkForUpdates();
}

async function loadSidebarLibraries() {
  try {
    const libs = await API.get("/libraries");
    allLibraries = libs;
    const container = document.getElementById("sb-libraries");
    if (!container) return;
    const icons = { movies: "🎬", tvshows: "📺", music: "🎵" };
    const nonMusicLibs = libs.filter(l => l.type !== "music");
    const musicLibs = libs.filter(l => l.type === "music");
    container.innerHTML = nonMusicLibs.map(lib => `
      <div class="sb-item" id="sb-lib-${lib.id}" onclick="switchToLibrary('${lib.id}', '${lib.name.replace(/'/g, "\'")}', '${lib.type}')">
        <span class="sb-icon">${icons[lib.type] || "📁"}</span>
        <span>${esc(lib.name)}</span>
      </div>
    `).join("") + `
      <div class="sb-item" id="sb-collections" onclick="switchSection('collections')">
        <span class="sb-icon">🎬</span>
        <span>Samlingar</span>
      </div>` +
    (musicLibs.length ? `
      <div class="sb-sep">ÖVRIGT</div>
      <div style="height:1px;background:var(--border);margin:0 18px 4px"></div>` +
      musicLibs.map(lib => `
      <div class="sb-item" id="sb-lib-${lib.id}" onclick="switchToLibrary('${lib.id}', '${lib.name.replace(/'/g, "\'")}', '${lib.type}')">
        <span class="sb-icon">🎵</span>
        <span>${esc(lib.name)}</span>
      </div>`).join("") : "");
  } catch {}
}


// ── UPDATE CHECK ──────────────────────────────────────────────────────────────
function switchSection(name) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".sb-item").forEach(b => b.classList.remove("active"));
  const sec = document.getElementById("sec-" + name);
  if (sec) sec.classList.add("active");
  const sbEl = document.getElementById("sb-" + name);
  if (sbEl) sbEl.classList.add("active");
  if (name === "home") loadHome();
  else if (name === "movies") loadMediaSection("movies");
  else if (name === "tvshows") loadMediaSection("tvshows");
  else if (name === "music") loadMusicPage();
  else if (name === "search") loadSearchPage();
  else if (name === "settings") loadSettings();
  else if (name === "collections") loadCollections();
  const userMenu = document.getElementById("userMenu");
  if (userMenu) userMenu.style.display = "none";
}

function switchToLibrary(libId, libName, libType) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".sb-item").forEach(b => b.classList.remove("active"));
  const sec = document.getElementById("sec-library");
  if (sec) sec.classList.add("active");
  const sbEl = document.getElementById("sb-lib-" + libId);
  if (sbEl) sbEl.classList.add("active");
  loadLibraryView(libId, libName, libType);
  const userMenu = document.getElementById("userMenu");
  if (userMenu) userMenu.style.display = "none";
}

function toggleUserMenu() {
  const m = document.getElementById("userMenu");
  if (m) m.style.display = m.style.display === "none" ? "block" : "none";
}
document.addEventListener("click", e => {
  if (!e.target.closest(".sb-user")) {
    const m = document.getElementById("userMenu");
    if (m) m.style.display = "none";
  }
});

async function checkForUpdates() {
  try {
    var data = await API.get("/updates/check");
    if (data.hasUpdate) showUpdateBanner(data.latest, data.releaseNotes, data.htmlUrl, data.downloadUrl);
  } catch {}
}

function showUpdateBanner(version, releaseNotes, url, downloadUrl) {
  var existing = document.getElementById("update-banner");
  if (existing) existing.remove();
  var banner = document.createElement("div");
  banner.id = "update-banner";
  banner.style.cssText = "position:fixed;bottom:80px;right:24px;z-index:300;background:#0d3d24;border:1px solid #2ecc71;border-radius:12px;padding:16px 20px;font-size:13px;color:#2ecc71;display:flex;flex-direction:column;gap:12px;box-shadow:0 4px 24px rgba(0,0,0,0.5);max-width:340px;";
  
  var header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;gap:10px";
  header.innerHTML = "<span style='font-size:22px'>🎉</span><div style='flex:1'><b style='font-size:14px'>StreamVault " + version + " available!</b><div style='opacity:0.7;font-size:12px;margin-top:2px'>A new version is ready to install</div></div>";
  var closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.cssText = "background:none;border:none;color:#2ecc71;font-size:18px;cursor:pointer;opacity:0.7;padding:0";
  closeBtn.onclick = function() { banner.remove(); };
  header.appendChild(closeBtn);
  banner.appendChild(header);



  var btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:8px";

  if (downloadUrl) {
    var installBtn = document.createElement("button");
    installBtn.textContent = "⬇ Install now";
    installBtn.style.cssText = "background:#2ecc71;color:#000;border:none;border-radius:6px;padding:9px 16px;font-weight:700;font-size:13px;cursor:pointer;flex:1";
    installBtn.onclick = function() { startUpdate(version, downloadUrl, banner); };
    btnRow.appendChild(installBtn);
  }

  if (url) {
    var viewBtn = document.createElement("a");
    viewBtn.href = url;
    viewBtn.target = "_blank";
    viewBtn.textContent = "View release";
    viewBtn.style.cssText = "background:transparent;color:#2ecc71;border:1px solid #2ecc71;border-radius:6px;padding:9px 16px;font-size:13px;cursor:pointer;text-decoration:none;text-align:center";
    btnRow.appendChild(viewBtn);
  }

  banner.appendChild(btnRow);
  document.body.appendChild(banner);
}

async function startUpdate(version, downloadUrl, banner) {
  // Replace banner content with progress UI
  banner.innerHTML = "";
  banner.style.minWidth = "300px";

  var title = document.createElement("div");
  title.style.cssText = "font-weight:700;font-size:14px;margin-bottom:8px";
  title.textContent = "Installing StreamVault " + version + "...";
  banner.appendChild(title);

  var progressWrap = document.createElement("div");
  progressWrap.style.cssText = "background:rgba(0,0,0,0.3);border-radius:6px;height:8px;overflow:hidden;margin-bottom:8px";
  var progressBar = document.createElement("div");
  progressBar.style.cssText = "height:100%;background:#2ecc71;border-radius:6px;transition:width 0.5s;width:0%";
  progressWrap.appendChild(progressBar);
  banner.appendChild(progressWrap);

  var status = document.createElement("div");
  status.style.cssText = "font-size:12px;opacity:0.8";
  status.textContent = "Downloading...";
  banner.appendChild(status);

  // Animate progress
  var progress = 0;
  function setProgress(pct, msg) {
    progress = pct;
    progressBar.style.width = pct + "%";
    status.textContent = msg;
  }

  // Capture current version to detect when update is complete
  var currentVersion = null;
  try { var vInfo = await API.get("/version"); currentVersion = vInfo.version; } catch {}

  try {
    setProgress(10, "Contacting server...");
    await new Promise(r => setTimeout(r, 500));
    setProgress(30, "Downloading update...");

    await API.post("/updates/install", { downloadUrl: downloadUrl });

    setProgress(60, "Installing...");
    await new Promise(r => setTimeout(r, 3000));
    setProgress(80, "Installing update... This may take 1-2 minutes, please wait.");
    await new Promise(r => setTimeout(r, 2000));
    setProgress(90, "Waiting for server to restart... Page will reload automatically.");

    // Wait for server to restart with NEW version
    var attempts = 0;
    var interval = setInterval(async function() {
      attempts++;
      try {
        var vData = await API.get("/version");
        // Check if version has changed
        if (vData.version !== currentVersion) {
          clearInterval(interval);
          setProgress(100, "Complete! Reloading...");
          await new Promise(r => setTimeout(r, 1500));
          window.location.reload();
        } else if (attempts > 60) {
          // Timeout after 2 minutes - reload anyway
          clearInterval(interval);
          setProgress(100, "Update complete! Reloading...");
          await new Promise(r => setTimeout(r, 1000));
          window.location.reload();
        }
      } catch {
        // Server is down - good! It's restarting
        setProgress(90, "Server restarting...");
      }
    }, 2000);

  } catch(e) {
    status.textContent = "Error: " + e.message;
    progressBar.style.background = "#e74c3c";
  }
}





function buildCastScroll(cast, scrollId) {
  return `<div class="cast-scroll-wrap">
    <button class="cast-scroll-btn left" onclick="document.getElementById('${scrollId}').scrollBy({left:-300,behavior:'smooth'})">‹</button>
    <div class="cast-scroll" id="${scrollId}">
      ${cast.map(p => `
        <div class="cast-card" onclick="openPersonDetail(${p.id})">
          ${p.profile_url ? `<img class="cast-photo" src="${p.profile_url}" alt="" loading="lazy">` : `<div class="cast-photo-ph">👤</div>`}
          <div class="cast-name">${esc(p.name)}</div>
          <div class="cast-char">${esc(p.character||"")}</div>
        </div>`).join("")}
    </div>
    <button class="cast-scroll-btn right" onclick="document.getElementById('${scrollId}').scrollBy({left:300,behavior:'smooth'})">›</button>
  </div>`;
}

function buildAbcNav(items) {
  const letters = new Set(items.map(i => (i.title||"").replace(/^(the |a |an )/i,"")[0]?.toUpperCase()).filter(Boolean));
  const all = "#ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  return `<div class="abc-nav">${all.map(l => {
    const hasItems = l === "#"
      ? [...letters].some(c => !/[A-Z]/.test(c))
      : letters.has(l);
    return `<a onclick="scrollToLetter('${l}')" class="${hasItems ? 'has-items' : ''}">${l}</a>`;
  }).join("")}</div>`;
}

function scrollToLetter(letter) {
  const grid = document.getElementById("lib-grid") || document.querySelector(".media-grid");
  if (!grid) return;
  const cards = grid.querySelectorAll(".mcard");
  for (const card of cards) {
    const title = card.querySelector(".mcard-title")?.textContent?.replace(/^(the |a |an )/i,"") || "";
    const firstChar = title[0]?.toUpperCase();
    const matches = letter === "#" ? !/[A-Z]/.test(firstChar) : firstChar === letter;
    if (matches) {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
  }
}

async function loadCollections() {
  const sec = document.getElementById("sec-collections");
  sec.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const collections = await API.get("/collections");
    if (!collections.length) {
      sec.innerHTML = `<div class="empty"><div class="empty-icon">🎬</div><h3>Inga samlingar hittades</h3><p>Skanna om biblioteket för att hitta filmserier</p></div>`;
      return;
    }
    sec.innerHTML = `
      <div class="grid-wrap" style="padding-right:32px">
        <div class="row-header" style="margin-bottom:20px">
          <span class="row-title">Samlingar</span>
          <span class="row-count">${collections.length} samlingar</span>
        </div>
        <div class="media-grid">
          ${collections.map(c => `
            <div class="mcard" onclick="openCollection('${c.id}')">
              <div style="position:relative">
                ${c.poster_url
                  ? `<img class="mcard-poster" src="${c.poster_url}" alt="" loading="lazy">`
                  : `<div class="mcard-poster-ph"><span>🎬</span><span>${esc((c.name||"").slice(0,14))}</span></div>`}
                <div class="mcard-overlay"><span class="mcard-play">▶</span></div>
              </div>
              <div class="mcard-info">
                <div class="mcard-title">${esc(c.name||"")}</div>
                <div class="mcard-meta">${c.movies.length} filmer</div>
              </div>
            </div>`).join("")}
        </div>
      </div>`;
    // Store for openCollection
    window._collectionsData = collections;
  } catch(e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>${e.message}</h3></div>`;
  }
}

async function openCollection(collectionId) {
  const collection = window._collectionsData?.find(c => String(c.id) === String(collectionId));
  if (!collection) return;
  const sec = document.getElementById("sec-detail") || (() => {
    const s = document.createElement("section");
    s.id = "sec-detail"; s.className = "section";
    document.getElementById("appMain").appendChild(s);
    return s;
  })();
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  sec.classList.add("active");
  sec.innerHTML = `<div class="spinner-wrap" style="height:60vh"><div class="spinner"></div></div>`;

  // Fetch full collection from TMDB to get missing films too
  let allParts = null;
  try {
    allParts = await API.get("/collections/" + collectionId + "/full");
  } catch {}

  const localMovies = [...collection.movies].sort((a,b) => (a.year||0)-(b.year||0));

  let filmsHtml = "";
  if (allParts?.parts?.length) {
    const inLib = allParts.parts.filter(p => p.in_library);
    const missing = allParts.parts.filter(p => !p.in_library);

    if (inLib.length) {
      filmsHtml += `<div class="detail-section">
        <h3 class="detail-section-title">I ditt bibliotek (${inLib.length})</h3>
        <div class="media-grid">
          ${localMovies.map(m => buildCard(m)).join("")}
        </div>
      </div>`;
    }

    if (missing.length) {
      filmsHtml += `<div class="detail-section">
        <h3 class="detail-section-title">Saknas i ditt bibliotek (${missing.length})</h3>
        <div class="media-grid">
          ${missing.map(p => `
            <div class="mcard" onclick="openTmdbDetail(${p.tmdb_id})" style="opacity:0.6">
              <div style="position:relative">
                ${p.poster_url
                  ? `<img class="mcard-poster" src="${p.poster_url}" alt="" loading="lazy">`
                  : `<div class="mcard-poster-ph"><span>🎬</span><span>${esc((p.title||"").slice(0,14))}</span></div>`}
                <div class="mcard-overlay"><span class="mcard-play" style="font-size:24px">🔍</span></div>
              </div>
              <div class="mcard-info">
                <div class="mcard-title">${esc(p.title||"")}</div>
                <div class="mcard-meta">${p.year||""}</div>
              </div>
            </div>`).join("")}
        </div>
      </div>`;
    }
  } else {
    filmsHtml = `<div class="detail-section">
      <h3 class="detail-section-title">Filmer (${localMovies.length})</h3>
      <div class="media-grid">${localMovies.map(m => buildCard(m)).join("")}</div>
    </div>`;
  }

  sec.innerHTML = `
    <div class="detail-page">
      <div class="show-hero" ${collection.backdrop_url ? `style="background-image:url('${collection.backdrop_url}')"` : ""}>
        <div class="show-hero-overlay"></div>
        <button class="detail-back" onclick="switchSection('collections')">← Samlingar</button>
        <div class="show-hero-content">
          <div class="detail-poster-col">
            ${collection.poster_url ? `<img class="detail-poster" src="${collection.poster_url}" alt="">` : `<div class="detail-poster-ph">🎬</div>`}
          </div>
          <div class="detail-info-col">
            <h1 class="detail-page-title">${esc(collection.name||"")}</h1>
            <div class="detail-meta-row">
              <span class="detail-meta-item">${localMovies.length} av ${allParts?.parts?.length||localMovies.length} filmer i ditt bibliotek</span>
            </div>
          </div>
        </div>
      </div>
      <div class="detail-content">
        ${filmsHtml}
      </div>
    </div>`;
}

async function loadLibraryView(libId, libName, libType) {
  const sec = document.getElementById("sec-library");
  sec.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    if (libType === "music") {
      // Music uses its own page
      document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
      document.getElementById("sec-music").classList.add("active");
      loadMusicPage();
      return;
    }
    const data = await API.get(`/libraries/${libId}/contents`);
    const items = data.items || [];
    sec.innerHTML = `
      <div class="grid-wrap" style="padding-right:32px">
        <div class="filter-bar">
          <h2 style="font-size:22px;font-weight:700;margin:0;flex:1">${esc(libName)}</h2>
          <input class="filter-input" type="text" placeholder="Sök i ${esc(libName)}..." id="lib-filter-q" oninput="filterLibraryView()"/>
          <select class="filter-select" id="lib-filter-sort" onchange="filterLibraryView()">
            <option value="title">A–Ö</option>
            <option value="year">År (nyast)</option>
            <option value="rating">Betyg</option>
          </select>
        </div>
        <div class="media-grid" id="lib-grid">
          ${items.length ? items.map(i => buildCard(i)).join("") : '<div class="empty"><div class="empty-icon">📭</div><h3>Tomt bibliotek</h3></div>'}
        </div>
      </div>
      ${buildAbcNav(items)}`;
    sec.dataset.items = JSON.stringify(items);
  } catch(e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>Kunde inte ladda</h3><p>${e.message}</p></div>`;
  }
}

function filterLibraryView() {
  const sec = document.getElementById("sec-library");
  const q = (document.getElementById("lib-filter-q")?.value || "").toLowerCase();
  const sort = document.getElementById("lib-filter-sort")?.value || "title";
  let items = JSON.parse(sec.dataset.items || "[]");
  if (q) items = items.filter(m => (m.title||"").toLowerCase().includes(q) || String(m.year||"").includes(q));
  if (sort === "title") items.sort((a,b) => (a.title||"").localeCompare(b.title||""));
  else if (sort === "year") items.sort((a,b) => (b.year||0)-(a.year||0));
  else if (sort === "rating") items.sort((a,b) => (b.rating||0)-(a.rating||0));
  document.getElementById("lib-grid").innerHTML = items.length
    ? items.map(i => buildCard(i)).join("")
    : '<div style="color:var(--muted);font-size:14px;padding:20px 0">Inga träffar</div>';
}

async function loadHome() {
  const sec = document.getElementById("sec-home");
  sec.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const [libs, continueW, recentMovies, recentShows, ongoingShows] = await Promise.all([
      API.get("/libraries"),
      API.get("/continue-watching"),
      API.get("/recently-added?type=movie"),
      API.get("/recently-added?type=tvshow"),
      API.get("/ongoing-shows")
    ]);
    allLibraries = libs;
    let html = "";

    // Hero: daily seed - same film all day, changes at midnight
    const movieLibs = libs.filter(l => l.type === "movies");
    if (movieLibs.length) {
      let allMovies = [];
      for (const lib of movieLibs) {
        const data = await API.get(`/libraries/${lib.id}/contents`);
        allMovies = allMovies.concat(data.items.filter(m => m.backdrop_url));
      }
      if (allMovies.length) {
        const today = new Date();
        const seed = today.getFullYear() * 10000 + (today.getMonth()+1) * 100 + today.getDate();
        const idx = seed % allMovies.length;
        html += buildHero(allMovies[idx]);
      }
    }

    if (continueW?.length) html += buildRow("Fortsätt titta", continueW);
    if (recentMovies?.length) html += buildRow("Nyligen tillagda filmer", recentMovies.slice(0, 16));
    if (recentShows?.length) html += buildRow("Nyligen tillagda TV-serier", recentShows.slice(0, 16));

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

    const letters = "#ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const alphaNav = `<div class="alpha-nav" id="alpha-nav-${sectionType}">${letters.map(l => 
    `<span class="alpha-letter" onclick="jumpToLetter('${sectionType}','${l}')">${l}</span>`
  ).join("")}</div>`;

  let html = `<div class="grid-wrap" style="position:relative">
      <div class="filter-bar">
        <input class="filter-input" type="text" placeholder="Sök..." id="filter-q-${sectionType}" oninput="filterMediaSection('${sectionType}')"/>
        <select class="filter-select" id="filter-sort-${sectionType}" onchange="filterMediaSection('${sectionType}')">
          <option value="title">A–Ö</option>
          <option value="year">År (nyast)</option>
          <option value="rating">Betyg</option>
        </select>
      </div>
      ${alphaNav}`;

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
            ${data.items.map(i => buildCard(i)).join("")}
          </div>
        </div>`;
    }
    html += "</div>";
    sec.innerHTML = html;
  } catch (e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>${e.message}</h3></div>`;
  }
}

function jumpToLetter(sectionType, letter) {
  const groups = document.querySelectorAll(`.section-group[data-type="${sectionType}"]`);
  for (const group of groups) {
    const grid = group.querySelector(`[class*="lib-grid-"]`);
    if (!grid) continue;
    const items = JSON.parse(grid.getAttribute("data-items") || "[]");
    const match = items.find(i => {
      const title = (i.title || "").replace(/^(the |a |an )/i, "").trim().toUpperCase();
      if (letter === "#") return /^[^A-Z]/.test(title);
      return title.startsWith(letter);
    });
    if (match) {
      const card = grid.querySelector(`[onclick*="${match.id}"]`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "start" });
        // Highlight active letter
        document.querySelectorAll(`#alpha-nav-${sectionType} .alpha-letter`).forEach(el => el.classList.remove("active"));
        document.querySelectorAll(`#alpha-nav-${sectionType} .alpha-letter`).forEach(el => {
          if (el.textContent === letter) el.classList.add("active");
        });
        return;
      }
    }
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
    grid.innerHTML = items.map(i => buildCard(i)).join("") ||
      `<div style="color:var(--muted);font-size:14px;padding:20px 0">Inga träffar</div>`;
    // Show/hide the group based on results
    group.style.display = q && !items.length ? "none" : "block";
  });
}

// ── MUSIC ─────────────────────────────────────────────────────────────────────
var _musicData = null; // cache music data

async function loadMusicPage() {
  const sec = document.getElementById("sec-music");
  sec.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const data = await API.get("/media?type=music&limit=2000");
    if (!data.items.length) {
      sec.innerHTML = `<div class="empty"><div class="empty-icon">🎵</div><h3>Ingen musik hittad</h3></div>`;
      return;
    }
    // Build structure in 3 passes to avoid ordering issues
    const byArtist = {};
    const albumMap = {};

    // Pass 1: Artists
    data.items.forEach(t => {
      let meta = {};
      try { meta = JSON.parse(t.extra_data || "{}"); } catch {}
      if (meta.isArtist) {
        byArtist[t.id] = { name: t.title, albums: {}, totalTracks: 0 };
      }
    });

    // Pass 2: Albums
    data.items.forEach(t => {
      let meta = {};
      try { meta = JSON.parse(t.extra_data || "{}"); } catch {}
      if (meta.isAlbum) {
        albumMap[t.id] = { name: t.title, artistId: meta.artistId || null, artistName: meta.artistName || t.title, tracks: [] };
        if (meta.artistId && byArtist[meta.artistId]) {
          byArtist[meta.artistId].albums[t.id] = albumMap[t.id];
        } else {
          // Standalone album/folder
          byArtist[t.id] = { name: t.title, albums: { [t.id]: albumMap[t.id] }, totalTracks: 0, isStandalone: true };
        }
      }
    });

    // Pass 3: Tracks
    data.items.forEach(t => {
      let meta = {};
      try { meta = JSON.parse(t.extra_data || "{}"); } catch {}
      if (meta.isTrack && meta.albumId && albumMap[meta.albumId]) {
        albumMap[meta.albumId].tracks.push(t);
        const artistId = albumMap[meta.albumId].artistId || meta.albumId;
        if (byArtist[artistId]) byArtist[artistId].totalTracks++;
      }
    });
    _musicData = byArtist;
    // Render artist cards
    renderArtistGrid(byArtist);
  } catch (e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>${e.message}</h3></div>`;
  }
}

async function renderArtistGrid(byArtist) {
  const sec = document.getElementById("sec-music");
  const artists = Object.entries(byArtist).sort((a,b) => a[1].name.localeCompare(b[1].name));
  let html = `<div style="padding:28px">
    <div class="row-header" style="margin-bottom:20px"><span class="row-title">Musik</span><span class="row-count">${artists.length} artister / mappar</span></div>
    <div class="row-scroll">`;
  artists.forEach(([id, data], idx) => {
    const albumCount = Object.keys(data.albums).length;
    const safeId = encodeURIComponent(id);
    const icon = data.isStandalone ? "💿" : "🎤";
    const imgId = "artist-img-" + idx;
    const artistKey = "aimg-" + encodeURIComponent(data.name).slice(0,30).replace(/%/g,"");
    html += `<div class="mcard" onclick="openArtistById('${safeId}')">
      <div style="position:relative">
        <div class="mcard-poster-ph" id="${artistKey}"><span>${icon}</span><span>${esc(data.name.slice(0,14))}</span></div>
        <div class="mcard-overlay"><span class="mcard-play">▶</span></div>
      </div>
      <div class="mcard-info">
        <div class="mcard-title">${esc(data.name)}</div>
        <div class="mcard-meta">${data.isStandalone ? data.totalTracks + " låtar" : albumCount + " album · " + data.totalTracks + " låtar"}</div>
      </div>
    </div>`;
  });
  html += `</div></div>`;
  sec.innerHTML = html;
  // Load Spotify images sequentially to avoid rate limiting
  (async () => {
    for (const [id, data] of artists) {
      const artistKey = "aimg-" + encodeURIComponent(data.name).slice(0,30).replace(/%/g,"");
      try {
        const r = await API.get("/spotify/artist/" + encodeURIComponent(data.name));
        if (r.image) {
          const el = document.getElementById(artistKey);
          if (el) el.outerHTML = `<img class="mcard-poster" src="${r.image}" alt="" loading="lazy" style="aspect-ratio:1/1;object-fit:cover">`;
        }
      } catch {}
      await new Promise(res => setTimeout(res, 200));
    }
  })();
}

function openArtistById(safeId) {
  const id = decodeURIComponent(safeId);
  if (!_musicData || !_musicData[id]) return;
  const data = _musicData[id];
  const sec = document.getElementById("sec-music");
  // If standalone album - go directly to tracks
  if (data.isStandalone) {
    const albumData = Object.values(data.albums)[0];
    if (albumData) openAlbumById(id, id);
    return;
  }
  const albums = Object.entries(data.albums).sort((a,b) => a[1].name.localeCompare(b[1].name));
  let html = `<div style="padding:28px">
    <button class="s-btn" onclick="renderArtistGrid(_musicData)" style="margin-bottom:20px">← Alla artister</button>
    <div class="row-header" style="margin-bottom:20px">
      <span class="row-title">🎤 ${esc(data.name)}</span>
      <span class="row-count">${albums.length} album</span>
    </div>
    <div class="row-scroll">`;
  albums.forEach(([albumId, albumData], idx) => {
    const safeArtistId = encodeURIComponent(id);
    const safeAlbumId = encodeURIComponent(albumId);
    const albumImgId = "album-img-" + idx;
    html += `<div class="mcard" onclick="openAlbumById('${safeArtistId}', '${safeAlbumId}')">
      <div style="position:relative">
        <div class="mcard-poster-ph" id="${albumImgId}"><span>💿</span><span>${esc(albumData.name.slice(0,14))}</span></div>
        <div class="mcard-overlay"><span class="mcard-play">▶</span></div>
      </div>
      <div class="mcard-info">
        <div class="mcard-title">${esc(albumData.name)}</div>
        <div class="mcard-meta">${albumData.tracks.length} låtar</div>
      </div>
    </div>`;
  });
  html += `</div></div>`;
  sec.innerHTML = html;
  // Load album images from Spotify
  albums.forEach(([albumId, albumData], idx) => {
    const albumImgId = "album-img-" + idx;
    API.get("/spotify/album/" + encodeURIComponent(data.name) + "/" + encodeURIComponent(albumData.name))
      .then(r => {
        if (r.image) {
          const el = document.getElementById(albumImgId);
          if (el) el.outerHTML = `<img class="mcard-poster" src="${r.image}" alt="" loading="lazy" style="object-fit:cover">`;
        }
      }).catch(() => {});
  });
}

function openAlbumById(safeArtistId, safeAlbumId) {
  const artistId = decodeURIComponent(safeArtistId);
  const albumId = decodeURIComponent(safeAlbumId);
  if (!_musicData?.[artistId]?.albums?.[albumId]) return;
  const sec = document.getElementById("sec-music");
  const albumData = _musicData[artistId].albums[albumId];
  const artistData = _musicData[artistId];
  let html = `<div style="padding:28px">
    <button class="s-btn" onclick="${artistData.isStandalone ? 'renderArtistGrid(_musicData)' : 'openArtistById(\'' + safeArtistId + '\')'}" style="margin-bottom:20px">← ${artistData.isStandalone ? "Alla artister" : esc(artistData.name)}</button>
    <div class="row-header" style="margin-bottom:20px">
      <span class="row-title">💿 ${esc(albumData.name)}</span>
      <span class="row-count">${albumData.tracks.length} låtar</span>
    </div>
    <div>${albumData.tracks.map(t => buildMusicRow(t)).join("")}</div>
  </div>`;
  sec.innerHTML = html;
}

function buildMusicRow(t) {
  const playing = nowPlayingId === t.id;
  let meta = {};
  try { meta = JSON.parse(t.extra_data || "{}"); } catch {}
  // Use fileName from extra_data, fall back to ID3 title
  const displayTitle = meta.fileName || t.title || "Okänd låt";
  return `<div class="music-track${playing ? " now-playing" : ""}" onclick='playMusic("${t.id}","${esc(displayTitle)}","${esc(meta.artistName||"")}")'>
    <span class="mt-icon">${playing ? "🎵" : "♪"}</span>
    <div class="mt-info"><div class="mt-title">${esc(displayTitle)}</div><div class="mt-artist">${esc(meta.artistName||"")}</div></div>
  </div>`;
}

// ── HERO ──────────────────────────────────────────────────────────────────────
function buildHero(item) {
  const bg = item.backdrop_url ? `style="background-image:url('${item.backdrop_url}')"` : "";
  const pct = 0;
  return `<div class="hero">
    <div class="hero-bg" ${bg}></div>
    <div class="hero-content">
      <div class="hero-badge">${navigator.language.startsWith("sv") ? "StreamVault rekommenderar" : navigator.language.startsWith("no") ? "StreamVault anbefaler" : navigator.language.startsWith("da") ? "StreamVault anbefaler" : navigator.language.startsWith("fi") ? "StreamVault suosittelee" : navigator.language.startsWith("de") ? "StreamVault empfiehlt" : "StreamVault recommends"}</div>
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
    <div class="row-scroll">${items.map(i => buildCard(i)).join("")}</div>
  </div>`;
}

function buildCard(item, wide = false) {
  const poster = item.poster_url
    ? `<img class="mcard-poster" src="${item.poster_url}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    : "";
  const ph = `<div class="mcard-poster-ph" ${item.poster_url ? 'style="display:none"' : ""}><span>${item.type === "tvshow" ? "📺" : item.type === "music" ? "🎵" : "🎬"}</span><span>${esc((item.title || "").slice(0, 14))}</span></div>`;
  const watchedBadge = item.completed ? `<div class="mcard-watched-badge" title="Sedd">✓</div>` : "";
  const progressBar = (!item.completed && item.position > 10 && item.duration)
    ? `<div class="mcard-progress"><div class="mcard-progress-fill" style="width:${Math.min(100, Math.round(item.position/item.duration*100))}%"></div></div>`
    : "";
  const clickFn = item.type === "tvshow" ? `openShowDetail("${item.id}")` : `openDetail("${item.id}")`;
  return `<div class="mcard${wide ? " mcard-wide" : ""}" onclick='${clickFn}'>
    <div style="position:relative">${poster}${ph}<div class="mcard-overlay"><span class="mcard-play">▶</span></div>${watchedBadge}${progressBar}</div>
    <div class="mcard-info">
      <div class="mcard-title">${esc(item.title)}</div>
      <div class="mcard-meta">${item.rating ? `<span class="mcard-rating">⭐ ${parseFloat(item.rating).toFixed(1)}</span> ` : ""}${item.year || ""}</div>
    </div>
  </div>`;
}

// ── DETAIL ────────────────────────────────────────────────────────────────────
async function openShowDetail(id) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  const sec = document.getElementById("sec-detail") || (() => {
    const s = document.createElement("section");
    s.id = "sec-detail"; s.className = "section";
    document.getElementById("appMain").appendChild(s);
    return s;
  })();
  sec.classList.add("active");
  sec.dataset.fromId = id;
  sec.innerHTML = `<div class="spinner-wrap" style="height:60vh"><div class="spinner"></div></div>`;
  try {
    const [item, details, seasonsData] = await Promise.all([
      API.get("/media/" + id),
      API.get("/media/" + id + "/details").catch(() => ({})),
      API.get("/tvshow/" + id + "/seasons").catch(() => ({ seasons: [] }))
    ]);
    const seasons = seasonsData.seasons || [];
    const genresHtml = (details.genres||[]).map(g => `<span class="detail-genre">${esc(g)}</span>`).join("");
    const directors = (details.crew||[]).filter(c => ["Creator","Director"].includes(c.job)).map(c => esc(c.name)).join(", ");
    const castHtml = (details.cast||[]).length ? `
      <div class="detail-section">
        <h3 class="detail-section-title">Skådespelare</h3>
        ${buildCastScroll(details.cast, "cast-show-${id}")}
      </div>` : "";
    const seasonsHtml = seasons.length ? `
      <div class="detail-section">
        <h3 class="detail-section-title">Säsonger</h3>
        <div class="row-scroll">
          ${seasons.map(s => `
            <div class="mcard" onclick="openSeason('${id}', ${s.season})">
              <div style="position:relative">
                ${s.poster_url
                  ? `<img class="mcard-poster" src="${s.poster_url}" alt="" loading="lazy">`
                  : `<div class="mcard-poster-ph"><span>📺</span><span>${esc(s.name.slice(0,14))}</span></div>`}
                <div class="mcard-overlay"><span class="mcard-play">▶</span></div>
              </div>
              <div class="mcard-info">
                <div class="mcard-title">${esc(s.name)}</div>
                <div class="mcard-meta">${s.episode_count} avsnitt${s.air_date ? " · " + s.air_date.slice(0,4) : ""}</div>
              </div>
            </div>`).join("")}
        </div>
      </div>` : "";
    sec.innerHTML = `
      <div class="detail-page">
        <div class="show-hero" ${item.backdrop_url ? `style="background-image:url('${item.backdrop_url}')"` : ""}>
          <div class="show-hero-overlay"></div>
          <button class="detail-back" onclick="closeDetail()">← Tillbaka</button>
          <div class="show-hero-content">
            <div class="detail-poster-col">
              ${item.poster_url ? `<img class="detail-poster" src="${item.poster_url}" alt="">` : `<div class="detail-poster-ph">📺</div>`}
            </div>
            <div class="detail-info-col">
              <h1 class="detail-page-title">${esc(item.title)}</h1>
              <div class="detail-meta-row">
                ${item.rating ? `<span class="detail-rating">⭐ ${parseFloat(item.rating).toFixed(1)}</span>` : ""}
                ${directors ? `<span class="detail-meta-item">🎬 ${directors}</span>` : ""}
              </div>
              ${genresHtml ? `<div class="detail-genres">${genresHtml}</div>` : ""}
              ${item.overview ? `<p class="detail-page-overview">${esc(item.overview)}</p>` : ""}
              <div class="detail-actions">
                <button class="btn-fav" onclick='openFixMeta("${item.id}","${esc(item.title)}","tv")'>🔍 Fixa info</button>
                <button class="btn-fav" onclick='openEditMedia("${item.id}")'>✏ Redigera</button>
              </div>
            </div>
          </div>
        </div>
        <div class="detail-content">
          ${seasonsHtml}
          ${castHtml}
        </div>
      </div>`;
  } catch(e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>${e.message}</h3></div>`;
  }
}

async function openSeason(showId, seasonNum) {
  const sec = document.getElementById("sec-detail");
  sec.innerHTML = `<div class="spinner-wrap" style="height:60vh"><div class="spinner"></div></div>`;
  try {
    const [show, seasonData] = await Promise.all([
      API.get("/media/" + showId),
      API.get("/tvshow/" + showId + "/season/" + seasonNum)
    ]);
    const episodes = seasonData.episodes || [];
    const cast = seasonData.cast || [];
    const castHtml = cast.length ? `
      <div class="detail-section">
        <h3 class="detail-section-title">Skådespelare</h3>
        ${buildCastScroll(cast, "cast-season-${showId}-${seasonNum}")}
      </div>` : "";
    const episodesHtml = `<div class="media-grid">${episodes.map(ep => {
      const label = `S${String(seasonNum).padStart(2,"0")} E${String(ep.episode||0).padStart(2,"0")}`;
      return `<div class="mcard" onclick='playEpisode("${ep.id}","${esc(show.title)}","${showId}",${seasonNum},${ep.episode||0})'>
        <div style="position:relative">
          ${ep.still_url
            ? `<img class="mcard-poster" src="${ep.still_url}" alt="" loading="lazy" style="aspect-ratio:16/9;object-fit:cover">`
            : `<div class="mcard-poster-ph" style="aspect-ratio:16/9"><span>📺</span><span>${esc(label)}</span></div>`}
          <div class="mcard-overlay"><span class="mcard-play">▶</span></div>
        </div>
        <div class="mcard-info">
          <div class="mcard-title">${esc(ep.title||"Avsnitt "+ep.episode)}</div>
          <div class="mcard-meta">Avsnitt ${ep.episode||""}${ep.runtime ? " · "+ep.runtime+" min" : ""}</div>
        </div>
      </div>`;
    }).join("")}</div>`;
    sec.innerHTML = `
      <div class="detail-page">
        <div class="show-hero" ${show.backdrop_url ? `style="background-image:url('${show.backdrop_url}')"` : ""}>
          <div class="show-hero-overlay"></div>
          <button class="detail-back" onclick="openShowDetail('${showId}')">← ${esc(show.title)}</button>
          <div class="show-hero-content">
            <div class="detail-poster-col">
              ${seasonData.poster_url ? `<img class="detail-poster" src="${seasonData.poster_url}" alt="">` : `<div class="detail-poster-ph">📺</div>`}
            </div>
            <div class="detail-info-col">
              <h1 class="detail-page-title">${esc(seasonData.name||"Säsong "+seasonNum)}</h1>
              <div class="detail-meta-row">
                <span class="detail-meta-item">${episodes.length} avsnitt</span>
              </div>
              ${seasonData.overview ? `<p class="detail-page-overview">${esc(seasonData.overview)}</p>` : ""}
            </div>
          </div>
        </div>
        <div class="detail-content">
          ${castHtml}
          <div class="detail-section">
            <h3 class="detail-section-title">Avsnitt</h3>
            ${episodesHtml || '<p style="color:var(--muted)">Inga avsnitt hittades</p>'}
          </div>
        </div>
      </div>`;
  } catch(e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>${e.message}</h3></div>`;
  }
}

async function openTmdbDetail(tmdbId) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  const sec = document.getElementById("sec-detail") || (() => {
    const s = document.createElement("section");
    s.id = "sec-detail"; s.className = "section";
    document.getElementById("appMain").appendChild(s);
    return s;
  })();
  sec.classList.add("active");
  sec.innerHTML = `<div class="spinner-wrap" style="height:60vh"><div class="spinner"></div></div>`;
  try {
    const item = await API.get("/tmdb/movie/" + tmdbId);
    const runtime = item.runtime ? `${Math.floor(item.runtime/60)}h ${item.runtime%60}m` : "";
    const genresHtml = (item.genres||[]).map(g => `<span class="detail-genre">${esc(g)}</span>`).join("");
    const directors = (item.crew||[]).filter(c => c.job === "Director").map(c => esc(c.name)).join(", ");
    const castHtml = (item.cast||[]).length ? `
      <div class="detail-section">
        <h3 class="detail-section-title">Skådespelare</h3>
        <div class="cast-scroll">
          ${(item.cast||[]).map(p => `
            <div class="cast-card" onclick="openPersonDetail(${p.id})">
              ${p.profile_url ? `<img class="cast-photo" src="${p.profile_url}" alt="" loading="lazy">` : `<div class="cast-photo-ph">👤</div>`}
              <div class="cast-name">${esc(p.name)}</div>
              <div class="cast-char">${esc(p.character||"")}</div>
            </div>`).join("")}
        </div>
      </div>` : "";
    sec.innerHTML = `
      <div class="detail-page">
        <div class="detail-hero" ${item.backdrop_url ? `style="background-image:url('${item.backdrop_url}')"` : ""}>
          <div class="detail-hero-overlay"></div>
          <button class="detail-back" onclick="closeDetail()">← Tillbaka</button>
        </div>
        <div class="detail-content">
          <div class="detail-main">
            <div class="detail-poster-col">
              ${item.poster_url ? `<img class="detail-poster" src="${item.poster_url}" alt="">` : `<div class="detail-poster-ph">🎬</div>`}
            </div>
            <div class="detail-info-col">
              <h1 class="detail-page-title">${esc(item.title)}</h1>
              <div class="detail-meta-row">
                ${item.rating ? `<span class="detail-rating">⭐ ${parseFloat(item.rating).toFixed(1)}</span>` : ""}
                ${item.year ? `<span class="detail-meta-item">${item.year}</span>` : ""}
                ${runtime ? `<span class="detail-meta-item">${runtime}</span>` : ""}
                ${directors ? `<span class="detail-meta-item">🎬 ${directors}</span>` : ""}
              </div>
              ${genresHtml ? `<div class="detail-genres">${genresHtml}</div>` : ""}
              ${item.overview ? `<p class="detail-page-overview">${esc(item.overview)}</p>` : ""}
              <div class="wtw-section">
                <div class="wtw-title">Var kan du se den?</div>
                <div class="wtw-providers" id="wtw-tmdb-${tmdbId}"><span style="font-size:13px;color:var(--muted)">Hämtar...</span></div>
              </div>
            </div>
          </div>
          ${castHtml}
        </div>
      </div>`;
    API.get("/watch-providers/" + tmdbId).then(data => {
      const el = document.getElementById("wtw-tmdb-" + tmdbId);
      if (!el) return;
      const flat = new Set((data.flatrate||[]).map(p => p.provider_name));
      const providers = [...new Set([...(data.flatrate||[]),...(data.rent||[])].map(p => p.provider_name))];
      el.innerHTML = providers.length
        ? providers.map(n => `<span class="wtw-pill ${flat.has(n)?"stream":"rent"}">${esc(n)}</span>`).join("")
        : `<span style="font-size:13px;color:var(--muted)">Ej tillgänglig på streaming i Sverige</span>`;
    }).catch(()=>{});
  } catch(e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>${e.message}</h3></div>`;
  }
}

async function openDetailByTmdb(tmdbId) {
  try {
    const libs = await API.get("/libraries");
    for (const lib of libs) {
      const data = await API.get("/libraries/" + lib.id + "/contents");
      const match = (data.items || []).find(i => String(i.tmdb_id) === String(tmdbId));
      if (match) { openDetail(match.id); return; }
    }
  } catch(e) { console.error("openDetailByTmdb:", e); }
}

async function openDetail(id) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  const sec = document.getElementById("sec-detail") || (() => {
    const s = document.createElement("section");
    s.id = "sec-detail"; s.className = "section";
    document.getElementById("appMain").appendChild(s);
    return s;
  })();
  sec.classList.add("active");
  sec.dataset.fromId = id;
  sec.innerHTML = `<div class="spinner-wrap" style="height:60vh"><div class="spinner"></div></div>`;
  try {
    const [item, progress, details] = await Promise.all([
      API.get("/media/" + id),
      API.get("/media/" + id + "/progress"),
      API.get("/media/" + id + "/details").catch(() => ({}))
    ]);
    const pct = progress?.duration ? Math.round((progress.position / progress.duration) * 100) : 0;
    const playLabel = pct > 5 && pct < 95 ? `▶ Fortsätt (${pct}%)` : "▶ Spela";
    const runtime = details.runtime ? `${Math.floor(details.runtime/60)}h ${details.runtime%60}m` : "";
    const genresHtml = (details.genres||[]).map(g => `<span class="detail-genre">${esc(g)}</span>`).join("");
    const directors = (details.crew||[]).filter(c => c.job === "Director").map(c => esc(c.name)).join(", ");
    const castHtml = (details.cast||[]).length ? `
      <div class="detail-section">
        <h3 class="detail-section-title">Skådespelare</h3>
        ${buildCastScroll(details.cast, "cast-movie-${id}")}
      </div>` : "";
    let episodesHtml = "";
    if (item.type === "tvshow" && item.episodes?.length) {
      episodesHtml = `<div class="detail-section">
        <h3 class="detail-section-title">Avsnitt (${item.episodes.length})</h3>
        <div class="episode-list">${item.episodes.map(ep => {
          const label = ep.season && ep.episode ? `S${String(ep.season).padStart(2,"0")} E${String(ep.episode).padStart(2,"0")}` : "Avsnitt";
          return `<div class="ep-item" onclick='playItem("${ep.id}","${esc(item.title)} · ${label}")'>
            <span class="ep-num">${label}</span><span class="ep-name">${esc(ep.title||"")}</span><span>▶</span>
          </div>`;
        }).join("")}</div></div>`;
    }
    sec.innerHTML = `
      <div class="detail-page">
        <div class="detail-hero" ${item.backdrop_url ? `style="background-image:url('${item.backdrop_url}')"` : ""}>
          <div class="detail-hero-overlay"></div>
          <button class="detail-back" onclick="closeDetail()">← Tillbaka</button>
        </div>
        <div class="detail-content">
          <div class="detail-main">
            <div class="detail-poster-col">
              ${item.poster_url ? `<img class="detail-poster" src="${item.poster_url}" alt="">` : `<div class="detail-poster-ph">${item.type==="tvshow"?"📺":"🎬"}</div>`}
            </div>
            <div class="detail-info-col">
              <h1 class="detail-page-title">${esc(item.title)}</h1>
              <div class="detail-meta-row">
                ${item.rating ? `<span class="detail-rating">⭐ ${parseFloat(item.rating).toFixed(1)}</span>` : ""}
                ${item.year ? `<span class="detail-meta-item">${item.year}</span>` : ""}
                ${runtime ? `<span class="detail-meta-item">${runtime}</span>` : ""}
                ${directors ? `<span class="detail-meta-item">🎬 ${directors}</span>` : ""}
              </div>
              ${genresHtml ? `<div class="detail-genres">${genresHtml}</div>` : ""}
              ${item.overview ? `<p class="detail-page-overview">${esc(item.overview)}</p>` : ""}
              <div class="detail-actions">
                <button class="btn-play" onclick='playItem("${item.id}","${esc(item.title)}")'>${playLabel}</button>
                <button class="btn-fav" onclick="toggleFav('${item.id}',this)">♡ Favorit</button>
                <button class="btn-fav" onclick='openFixMeta("${item.id}","${esc(item.title)}","${item.type==="tvshow"?"tv":"movie"}")'>🔍 Fixa info</button>
                <button class="btn-fav" onclick='openEditMedia("${item.id}")'>✏ Redigera</button>
                <button class="btn-fav" onclick='openSubtitles("${item.id}","${esc(item.title)}")'>🔤 Undertexter</button>
                ${currentUser?.role === "admin" ? `<button class="btn-fav" onclick='openMediaInfo("${item.id}")'>ℹ Filinfo</button>` : ""}
                ${progress?.completed
                  ? `<button class="btn-fav" id="watched-btn-${item.id}" onclick="markUnwatched('${item.id}')">↺ Osedd</button>`
                  : `<button class="btn-fav" id="watched-btn-${item.id}" onclick="markWatched('${item.id}', ${Math.floor(progress?.duration||0)})">✓ Sedd</button>`}
              </div>
              <div class="wtw-section">
                <div class="wtw-title">Var kan du se den?</div>
                <div class="wtw-providers" id="wtw-${id}">
                  <span class="wtw-pill stream">✓ ${esc((allLibraries.find(l => l.id === item.library_id)||{}).name || "Ditt bibliotek")}</span>
                  ${item.tmdb_id && item.type === "movie" ? `<span style="font-size:13px;color:var(--muted)">Hämtar streaming...</span>` : ""}
                </div>
              </div>
            </div>
          </div>
          ${castHtml}
          ${episodesHtml}
        </div>
      </div>`;
    if (item.tmdb_id && item.type === "movie") {
      API.get("/watch-providers/" + item.tmdb_id).then(data => {
        const el = document.getElementById("wtw-" + id);
        if (!el) return;
        const flat = new Set((data.flatrate||[]).map(p => p.provider_name));
        const providers = [...new Set([...(data.flatrate||[]),...(data.rent||[])].map(p => p.provider_name))];
        const lib = allLibraries.find(l => l.id === item?.library_id);
        const libraryPill = `<span class="wtw-pill stream">✓ ${esc(lib?.name || "Ditt bibliotek")}</span>`;
        el.innerHTML = libraryPill + (providers.length ? providers.map(n => `<span class="wtw-pill ${flat.has(n)?"stream":"rent"}">${esc(n)}</span>`).join("") : "");
      }).catch(()=>{});
    }
  } catch(e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>${e.message}</h3></div>`;
  }
}

function closeDetail() {
  const sec = document.getElementById("sec-detail");
  if (sec) sec.classList.remove("active");
  // Return to previous section - home as default
  document.getElementById("sec-home")?.classList.add("active");
  document.querySelectorAll(".sb-item").forEach(b => b.classList.remove("active"));
}



async function openPersonDetail(tmdbPersonId) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  const sec = document.getElementById("sec-detail");
  if (sec) { sec.classList.add("active"); sec.innerHTML = `<div class="spinner-wrap" style="height:60vh"><div class="spinner"></div></div>`; }
  try {
    const data = await API.get("/person/" + tmdbPersonId);
    const inLib = data.credits.filter(c => c.in_library);
    const notLib = data.credits.filter(c => !c.in_library);
    sec.innerHTML = `
      <div class="detail-page">
        <div class="person-hero">
          <button class="detail-back" onclick="closeDetail()">← Tillbaka</button>
          <div class="person-info">
            ${data.profile_url ? `<img class="person-photo" src="${data.profile_url}" alt="">` : `<div class="person-photo-ph">👤</div>`}
            <div>
              <h1 class="detail-page-title">${esc(data.name)}</h1>
              <div class="detail-meta-row">
                ${data.known_for ? `<span class="detail-meta-item">${esc(data.known_for)}</span>` : ""}
                ${data.birthday ? `<span class="detail-meta-item">Född ${data.birthday}</span>` : ""}
              </div>
              ${data.biography ? `<p class="person-bio">${esc(data.biography.substring(0,400))}${data.biography.length>400?"...":""}</p>` : ""}
            </div>
          </div>
        </div>
        <div class="detail-content">
          ${inLib.length ? `
          <div class="detail-section">
            <h3 class="detail-section-title">I ditt bibliotek</h3>
            <div class="cast-scroll">
              ${[...new Map(inLib.map(m => [m.tmdb_id, m])).values()].map(m => `
                <div class="lib-film-card" onclick="findAndOpenByTmdb(${m.tmdb_id})">
                  <img class="lib-film-poster" src="${m.poster_url}" alt="" loading="lazy">
                  <div class="cast-name">${esc(m.title)}</div>
                  <div class="cast-char">${m.year||""}</div>
                </div>`).join("")}
            </div>
          </div>` : ""}
          ${notLib.length ? `
          <div class="detail-section">
            <h3 class="detail-section-title">Mer från ${esc(data.name)}</h3>
            <div class="cast-scroll">
              ${notLib.slice(0,15).map(m => `
                <div class="cast-card" style="cursor:default;opacity:0.6">
                  <img class="cast-photo" src="${m.poster_url}" alt="" loading="lazy">
                  <div class="cast-name">${esc(m.title)}</div>
                  <div class="cast-char">${m.year||""}</div>
                </div>`).join("")}
            </div>
          </div>` : ""}
        </div>
      </div>`;
  } catch(e) {
    if(sec) sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>${e.message}</h3></div>`;
  }
}

async function findAndOpenByTmdb(tmdbId) {
  try {
    const libs = await API.get("/libraries");
    for (const lib of libs) {
      const data = await API.get(`/libraries/${lib.id}/contents`);
      const match = data.items.find(i => String(i.tmdb_id) === String(tmdbId));
      if (match) { openDetail(match.id); return; }
    }
  } catch(e) { console.error(e); }
}

async function openEditMedia(id) {
  try {
    const item = await API.get("/media/" + id);
    let images = { posters: [], backdrops: [] };
    if (item.tmdb_id) {
      try { images = await API.get("/media/" + id + "/images"); } catch {}
    }
    const modal = document.createElement("div");
    modal.id = "edit-media-modal";
    modal.style.cssText = "position:fixed;inset:0;z-index:500;background:rgba(0,0,0,0.88);display:flex;align-items:center;justify-content:center;padding:24px;";
    const posterGrid = images.posters.length ? `
      <div>
        <div class="info-section-title">Välj poster (${images.posters.length} tillgängliga)</div>
        <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:8px;scrollbar-width:thin">
          ${images.posters.map(p => `<img src="${p.url}" onclick="selectEditImage('poster','${p.full}',this)" style="height:120px;border-radius:6px;cursor:pointer;flex-shrink:0;border:2px solid transparent;transition:border-color 0.2s;opacity:0.8" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.8">`).join("")}
        </div>
      </div>` : "";
    const backdropGrid = images.backdrops.length ? `
      <div>
        <div class="info-section-title">Välj bakgrund (${images.backdrops.length} tillgängliga)</div>
        <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:8px;scrollbar-width:thin">
          ${images.backdrops.map(b => `<img src="${b.url}" onclick="selectEditImage('backdrop','${b.full}',this)" style="height:70px;border-radius:6px;cursor:pointer;flex-shrink:0;border:2px solid transparent;transition:border-color 0.2s;opacity:0.8" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.8">`).join("")}
        </div>
      </div>` : "";
    modal.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:720px;max-height:90vh;overflow-y:auto;">
        <div style="padding:18px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;position:sticky;top:0;background:var(--surface);z-index:1">
          <span style="font-size:18px">✏</span>
          <span style="font-weight:700;font-size:16px">Redigera – ${esc(item.title||"")}</span>
          <button onclick="document.getElementById('edit-media-modal').remove()" style="margin-left:auto;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer">✕</button>
        </div>
        <div style="padding:24px;display:flex;flex-direction:column;gap:20px">
          ${editField("edit-title","Titel",item.title||"")}
          ${editField("edit-year","År",item.year||"")}
          ${editField("edit-rating","Betyg (0–10)",item.rating||"")}
          ${editField("edit-overview","Beskrivning",item.overview||"",true)}
          ${posterGrid}
          <div>
            <div class="info-section-title">Poster URL</div>
            <input id="edit-poster" type="text" value="${esc(item.poster_url||"")}" style="width:100%;background:var(--card2);border:1px solid var(--border);color:var(--text);font-family:'DM Sans',sans-serif;font-size:13px;padding:9px 12px;border-radius:8px;outline:none;box-sizing:border-box">
          </div>
          ${backdropGrid}
          <div>
            <div class="info-section-title">Backdrop URL</div>
            <input id="edit-backdrop" type="text" value="${esc(item.backdrop_url||"")}" style="width:100%;background:var(--card2);border:1px solid var(--border);color:var(--text);font-family:'DM Sans',sans-serif;font-size:13px;padding:9px 12px;border-radius:8px;outline:none;box-sizing:border-box">
          </div>
        </div>
        <div style="padding:16px 24px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px;position:sticky;bottom:0;background:var(--surface)">
          <button onclick="document.getElementById('edit-media-modal').remove()" class="btn-fav">Avbryt</button>
          <button onclick="saveEditMedia('${id}')" class="btn-play" style="padding:10px 24px">Spara ändringar</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  } catch(e) { toast("Kunde inte öppna redigera: " + e.message, "error"); }
}

function selectEditImage(type, fullUrl, el) {
  el.parentElement.querySelectorAll("img").forEach(i => i.style.borderColor = "transparent");
  el.style.borderColor = "var(--accent)";
  document.getElementById("edit-" + type).value = fullUrl;
}

function editField(id, label, value, textarea = false) {
  value = value == null ? "" : String(value);
  const inputStyle = "width:100%;background:var(--card2);border:1px solid var(--border);color:var(--text);font-family:'DM Sans',sans-serif;font-size:14px;padding:10px 12px;border-radius:8px;outline:none;box-sizing:border-box;";
  return `<div>
    <div class="info-section-title">${label}</div>
    ${textarea ? `<textarea id="${id}" style="${inputStyle}min-height:100px;resize:vertical">${esc(value)}</textarea>` : `<input id="${id}" type="text" value="${esc(value)}" style="${inputStyle}">`}
  </div>`;
}

async function saveEditMedia(id) {
  try {
    const title = document.getElementById("edit-title")?.value?.trim();
    if (!title) { toast("Titel får inte vara tom", "error"); return; }
    await API.post("/media/" + id + "/edit", {
      title,
      year: document.getElementById("edit-year")?.value?.trim() || undefined,
      rating: document.getElementById("edit-rating")?.value?.trim() || undefined,
      overview: document.getElementById("edit-overview")?.value?.trim() || undefined,
      poster_url: document.getElementById("edit-poster")?.value?.trim() || undefined,
      backdrop_url: document.getElementById("edit-backdrop")?.value?.trim() || undefined
    });
    document.getElementById("edit-media-modal")?.remove();
    toast("Sparad ✓", "success");
    openDetail(id);
  } catch(e) { toast("Kunde inte spara: " + e.message, "error"); }
}

async function openMediaInfo(id) {
  try {
    const item = await API.get("/media/" + id + "/fileinfo");
    const modal = document.createElement("div");
    modal.id = "media-info-modal";
    modal.style.cssText = "position:fixed;inset:0;z-index:500;background:rgba(0,0,0,0.88);display:flex;align-items:center;justify-content:center;padding:24px;";
    const v = item.video;
    const audioHtml = (item.audio||[]).map((a,i) => `
      <div style="background:var(--card2);border-radius:8px;padding:12px;margin-bottom:8px">
        <div style="font-weight:600;font-size:13px;margin-bottom:6px">🔊 Spår ${i+1} – ${a.language?.toUpperCase()||"UND"} ${a.title?"· "+esc(a.title):""}</div>
        ${infoRow("Codec",a.codec)} ${infoRow("Kanaler",a.channel_layout||a.channels)} ${infoRow("Bitrate",a.bitrate)}
      </div>`).join("") || "<p style='color:var(--muted);font-size:13px'>Inga ljudspår hittades</p>";
    const subHtml = (item.subtitles||[]).length ? (item.subtitles||[]).map((s,i) => `
      <div style="background:var(--card2);border-radius:8px;padding:12px;margin-bottom:8px">
        <div style="font-weight:600;font-size:13px;margin-bottom:6px">💬 Spår ${i+1} – ${s.language?.toUpperCase()||"UND"} ${s.title?"· "+esc(s.title):""} ${s.forced?"[Tvingad]":""} ${s.default?"[Standard]":""}</div>
        ${infoRow("Format",s.codec)}
      </div>`).join("")
    : "<p style='color:var(--muted);font-size:13px'>Inga undertextspår</p>";
    modal.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:680px;max-height:85vh;overflow-y:auto;">
        <div style="padding:18px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;position:sticky;top:0;background:var(--surface);z-index:1">
          <span style="font-size:18px">ℹ</span>
          <span style="font-weight:700;font-size:16px">Mediainformation – ${esc(item.title||"")}</span>
          <button onclick="document.getElementById('media-info-modal').remove()" style="margin-left:auto;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer">✕</button>
        </div>
        <div style="padding:24px;display:flex;flex-direction:column;gap:24px">
          <div>
            <div class="info-section-title">Fil</div>
            <div style="background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:12px;font-family:monospace;color:var(--text);word-break:break-all;margin-bottom:8px">${esc(item.file_path||"–")}</div>
            ${infoRow("Storlek",item.container?.size||"–")}
            ${infoRow("Speltid",item.container?.duration?Math.floor(item.container.duration/3600)+"h "+Math.floor((item.container.duration%3600)/60)+"m":"–")}
            ${infoRow("Inlagt",item.added_at?new Date(item.added_at).toLocaleDateString("sv-SE"):"–")}
          </div>
          <div>
            <div class="info-section-title">Video</div>
            ${infoRow("Codec",v?.codec)} ${infoRow("Profil",v?.profile)} ${infoRow("Upplösning",v?.width&&v?.height?v.width+"x"+v.height:"–")} ${infoRow("Bildhastighet",v?.fps?v.fps+"fps":"–")} ${infoRow("Bitdjup",v?.bit_depth?v.bit_depth+" bit":"–")}
          </div>
          <div><div class="info-section-title">Ljud</div>${audioHtml}</div>
          <div><div class="info-section-title">Undertexter</div>${subHtml}</div>
          <div>
            <div class="info-section-title">Container</div>
            ${infoRow("Format",item.container?.format)} ${infoRow("Bitrate",item.container?.bitrate)}
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  } catch(e) { toast("Kunde inte hämta info: " + e.message, "error"); }
}

function infoRow(label, value) {
  return `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px">
    <span style="color:var(--muted)">${label}</span>
    <span style="color:var(--text);font-weight:500;text-align:right;max-width:300px;word-break:break-all">${esc(String(value||"–"))}</span>
  </div>`;
}

async function markWatched(id, duration) {
  try {
    await API.post("/media/" + id + "/progress", { position: duration || 0, duration: duration || 0, completed: 1 });
    const btn = document.getElementById("watched-btn-" + id);
    if (btn) {
      btn.textContent = "↺ Markera som osedd";
      btn.onclick = () => markUnwatched(id);
    }
    toast("Markerad som sedd ✓", "success");
    loadHome(); // Refresh cards
  } catch { toast("Kunde inte spara", "error"); }
}

async function markUnwatched(id) {
  try {
    await API.post("/media/" + id + "/progress", { position: 0, duration: 0, completed: 0 });
    const btn = document.getElementById("watched-btn-" + id);
    if (btn) {
      btn.textContent = "✓ Markera som sedd";
      btn.onclick = () => markWatched(id, 0);
    }
    // Update play button label to remove % indicator
    const playBtn = document.querySelector(".btn-play");
    if (playBtn && playBtn.textContent.includes("Fortsätt")) {
      playBtn.textContent = "▶ Spela";
    }
    toast("Markerad som osedd ↺", "success");
    loadHome(); // Refresh cards
  } catch { toast("Kunde inte spara", "error"); }
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
let currentHls = null;
let currentItemId = null;
let currentEpisodeData = null; // { showId, season, episode, episodes[] }
let _nextEpTimer = null;

function loadHlsJs() {
  return new Promise((resolve) => {
    if (window.Hls) return resolve();
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js";
    s.onload = resolve;
    document.head.appendChild(s);
  });
}

async function playItem(id, title) {
  const bar = document.getElementById("player-bar");
  const video = document.getElementById("main-video");
  const token = localStorage.getItem("sv_token") || API._token || "";

  // Stop previous transcode
  if (currentItemId) {
    if (currentHls) { currentHls.destroy(); currentHls = null; }
    if (window._dashPlayer) { try { window._dashPlayer.reset(); } catch {} window._dashPlayer = null; }
    API.post("/dash/" + currentItemId + "/stop").catch(() => {});
  }

  console.log(`[PLAY] ${new Date().toISOString().substring(11,23)} Play pressed: ${title}`);
  bar.style.display = "flex";
  document.getElementById("pb-title").textContent = title;
  document.getElementById("pb-sub").textContent = "Förbereder...";
  document.body.style.paddingBottom = "320px";
  nowPlayingId = id;
  currentItemId = id;

  try {
    // Ask server: direct play or HLS? Also fetch saved progress
    const [info, progress] = await Promise.all([
      API.get("/playback/" + id + "?token=" + encodeURIComponent(token)),
      API.get("/media/" + id + "/progress").catch(() => ({ position: 0 }))
    ]);
    document.getElementById("pb-sub").textContent = "";

    // Resume from saved position
    // Accept if position > 10s AND (no duration stored OR position < 95% of duration)
    const hasDur = progress?.duration > 0;
    const notDone = !hasDur || (progress.position / progress.duration) < 0.95;
    const resumeSec = (progress?.position > 10 && notDone) ? Math.floor(progress.position) : 0;
    console.log("[RESUME] position:", progress?.position, "duration:", progress?.duration, "resumeSec:", resumeSec);
    // Auto-load Swedish subtitles
    autoLoadSubtitles(id);

    if (info.method === "direct") {
      video.src = info.url;
      video.play().catch(() => {});
      // Reset DASH state for new episode
      window._dashStartSec = 0;
      window._dashFirstCT = null;
      window._dashSessionStart = Date.now();
      // Simple seek handler for direct play
      window._hlsSeekHandler = (seekSec) => {
        video.currentTime = seekSec;
        window._dashStartSec = seekSec;
        window._dashFirstCT = video.currentTime;
        video.play().catch(() => {});
      };
      video.onended = () => {
        const nextEp = getNextEpisode();
        if (nextEp) {
          document.getElementById("next-ep-banner")?.remove();
          clearInterval(_nextEpTimer);
          playEpisode(nextEp.id, currentEpisodeData?.showTitle||"", currentEpisodeData?.showId, currentEpisodeData?.season, nextEp.episode);
        }
      };
      video.onloadedmetadata = () => {
        initPlayerControls(info.duration || video.duration);
        if (resumeSec > 0) {
          video.currentTime = resumeSec;
          window._seekOffset = resumeSec;
          window._currentPlayPos = resumeSec;
        }
      };
    } else {
      // ── DASH (Plex-style) ────────────────────────────────────────────────
      // Plex uses DASH with offset=0 per session + incomplete segment streaming
      // video.currentTime always starts at 0 for each new session = no offset math
      document.getElementById("pb-sub").textContent = "Transcoding...";

      if (window._dashPlayer) { try { window._dashPlayer.reset(); } catch {} window._dashPlayer = null; }
      video.pause();
      video.removeAttribute("src");
      video.load();

      const freshToken = API._token || token;
      const startData = await API.post("/dash/" + id + "/start?token=" + encodeURIComponent(freshToken), { startSec: resumeSec });
      window._dashStartSec = resumeSec;
      document.getElementById("pb-sub").textContent = "";

      await new Promise((resolve, reject) => {
        if (window.dashjs) return resolve();
        const s = document.createElement("script");
        s.src = "https://cdn.dashjs.org/v4.7.4/dash.all.min.js";
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });

      function createDashPlayer(manifest, startSec) {
        if (window._dashPlayer) { try { window._dashPlayer.reset(); } catch {} window._dashPlayer = null; }
        video.pause();
        video.removeAttribute("src");
        video.load();
        window._dashStartSec = startSec;
        window._dashFirstCT = null;
        window._dashSessionStart = Date.now();
        // Increment session ID to invalidate old retry loops
        _subtitleSessionId++;
        stopSubtitleOverlay();
        // Inject pending subtitle track right after video.load() - before player.initialize
        if (_pendingSubtitle) {
          var ps = _pendingSubtitle;
          setTimeout(function() {
            Array.from(video.querySelectorAll("track")).forEach(function(t) { t.remove(); });
            var t2 = document.createElement("track");
            t2.kind = "subtitles";
            t2.label = ps.label || "Undertexter";
            t2.srclang = "sv";
            t2.src = ps.url;
            t2.default = true;
            video.appendChild(t2);
            setTimeout(function() {
              if (video.textTracks[0]) video.textTracks[0].mode = "showing";
            }, 1000);
          }, 100);
        }
        // Capture video.currentTime at first playback tick to use as offset baseline
        const _captureFirstCT = () => {
          if (window._dashFirstCT === null && video.currentTime > 0) {
            window._dashFirstCT = video.currentTime;
            console.log(`[DASH] ${new Date().toISOString().substring(11,23)} firstCT captured:`, window._dashFirstCT, "startSec:", startSec);
            // Now dash.js is fully running - safe to add subtitles
            if (window._pendingSubtitleLoad) {
              setTimeout(function() {
                if (window._pendingSubtitleLoad) {
                  window._pendingSubtitleLoad();
                  window._pendingSubtitleLoad = null;
                }
              }, 200);
            }
            video.removeEventListener("timeupdate", _captureFirstCT);
          }
        };
        video.addEventListener("timeupdate", _captureFirstCT);
        console.log(`[DASH] ${new Date().toISOString().substring(11,23)} session start, startSec:`, startSec);
        const player = dashjs.MediaPlayer().create();
        player.initialize(video, manifest, true);
        // Re-activate subtitles after first frame
        var _subtitleStartSec = startSec;
        window._pendingSubtitleLoad = function() {
          if (currentItemId) {
            console.log("[SUBTITLES] First frame captured, loading subtitles startSec:", _subtitleStartSec);
            autoLoadSubtitles(currentItemId, _subtitleStartSec);
          }
        };
        player.updateSettings({
          streaming: {
            buffer: {
              bufferTimeAtTopQuality: 30,
              bufferToKeep: 20,
              stallThreshold: 0.5
            },
            gaps: { jumpGaps: true, jumpLargeGaps: true },
            abr: { autoSwitchBitrate: { video: false } },
            fragmentRequestProgressTimeout: 60000,
            retryAttempts: {
              MPD: 3,
              InitializationSegment: 3,
              MediaSegment: 5,
              other: 3
            },
            retryIntervals: {
              MPD: 500,
              InitializationSegment: 1000,
              MediaSegment: 2000,
              other: 1000
            }
          }
        });
        player.on(dashjs.MediaPlayer.events.ERROR, (e) => { console.error("[DASH] Error:", e); });
        // Wait for MANIFEST_PARSED then sample currentTime to find true start value
        // Edge caches old currentTime; dash.js resets it after manifest loads
        // Position tracked via wall clock timer, not video.currentTime
        window._dashPlayer = player;
        return player;
      }

      createDashPlayer(startData.manifest, resumeSec);
      initPlayerControls(startData.duration);

      let _seekInProgress = false;
      async function doSeek(seekSec) {
        if (_seekInProgress) {
          console.log("[DASH] Seek already in progress, ignoring:", seekSec);
          return;
        }
        _seekInProgress = true;
        window._seekDragging = false;
        // Pause immediately so old content stops playing while we wait for server
        video.pause();
        document.getElementById("pb-sub").textContent = "⏳ Hoppar...";
        try {
          let freshToken = API._token || token;
          const seekData = await API.post("/dash/" + id + "/seek?token=" + encodeURIComponent(freshToken), { startSec: seekSec });
          document.getElementById("pb-sub").textContent = "";
          createDashPlayer(seekData.manifest, seekSec);  // createDashPlayer calls video.play()
          if (seekData.duration) initPlayerControls(seekData.duration);
        } catch(e) {
          if (e.status === 401 || (e.message && e.message.includes("401"))) {
            try {
              const refreshData = await API.post("/auth/refresh", { refreshToken: API._refresh });
              if (refreshData?.accessToken) {
                API.setTokens(refreshData.accessToken, refreshData.refreshToken);
                const freshToken2 = API._token;
                const seekData2 = await API.post("/dash/" + id + "/seek?token=" + encodeURIComponent(freshToken2), { startSec: seekSec });
                document.getElementById("pb-sub").textContent = "";
                createDashPlayer(seekData2.manifest, seekSec);
                if (seekData2.duration) initPlayerControls(seekData2.duration);
                return;
              }
            } catch(e2) {
              console.error("[DASH] Token refresh failed:", e2);
            }
          }
          document.getElementById("pb-sub").textContent = "Seek error";
          console.error("[DASH] Seek error:", e);
        } finally {
          _seekInProgress = false;
        }
      }
      window._hlsSeekHandler = doSeek;
    }

    // Progress: dashStartSec + video.currentTime = absolute position
    // video.currentTime always starts at 0 per session (Plex offset=0 approach)
    let _lastProgressSave = 0;
    let _nextEpShown = false;
    video.addEventListener("timeupdate", () => {
      const now = Date.now();
      const dur = playerDuration || info.duration || (isNaN(video.duration) ? 0 : video.duration);
      if (dur > 30) {
        const firstCT = window._dashFirstCT || 0;
        const ct = video.currentTime;
        const pos = ct > 0 ? (window._dashStartSec || 0) + Math.max(0, ct - firstCT)
                           : (window._dashStartSec || 0) + (Date.now() - (window._dashSessionStart || Date.now())) / 1000;
        const pct = pos / dur;
        // Show next episode banner at 92%
        if (pct > 0.98 && !_nextEpShown) {
          _nextEpShown = true;
          const nextEp = getNextEpisode();
          if (nextEp) showNextEpisodeBanner(nextEp);
        }
        if (now - _lastProgressSave < 5000) return;
        _lastProgressSave = now;
        if (pos < 5) return;
        API.post("/media/" + id + "/progress", {
          position: Math.floor(pos),
          duration: Math.floor(dur),
          completed: pct > 0.9 ? 1 : 0
        }).catch(() => {});
      }
    });

  } catch(e) {
    console.error("Playback error:", e);
    document.getElementById("pb-sub").textContent = "Fel: " + e.message;
  }
}

async function playEpisode(id, showTitle, showId, season, episodeNum) {
  // Load all episodes for this season to enable next episode
  try {
    const seasonData = await API.get("/tvshow/" + showId + "/season/" + season);
    currentEpisodeData = {
      showId, showTitle, season,
      episodes: seasonData.episodes || [],
      currentEpisode: episodeNum
    };
  } catch {
    currentEpisodeData = null;
  }
  const label = `S${String(season).padStart(2,"0")} E${String(episodeNum).padStart(2,"0")}`;
  playItem(id, showTitle + " · " + label);
}

function getNextEpisode() {
  if (!currentEpisodeData) return null;
  const { episodes, currentEpisode } = currentEpisodeData;
  const idx = episodes.findIndex(ep => ep.episode === currentEpisode);
  return idx >= 0 && idx < episodes.length - 1 ? episodes[idx + 1] : null;
}

function showNextEpisodeBanner(nextEp) {
  // Remove existing banner
  document.getElementById("next-ep-banner")?.remove();
  if (!nextEp) return;
  clearTimeout(_nextEpTimer);
  let countdown = 20;
  const banner = document.createElement("div");
  banner.id = "next-ep-banner";
  banner.style.cssText = "position:absolute;bottom:80px;right:24px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 20px;z-index:100;display:flex;align-items:center;gap:16px;min-width:280px;box-shadow:0 4px 24px rgba(0,0,0,0.5)";
  const update = () => {
    banner.innerHTML = `
      <div style="flex:1">
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Nästa avsnitt om ${countdown}s</div>
        <div style="font-size:14px;font-weight:600">${esc(nextEp.title||"Avsnitt "+nextEp.episode)}</div>
      </div>
      <button onclick="playEpisode('${nextEp.id}','${esc(currentEpisodeData.showTitle||"")}','${currentEpisodeData.showId}',${currentEpisodeData.season},${nextEp.episode})" 
        style="background:var(--accent);border:none;color:white;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;padding:8px 16px;border-radius:8px;cursor:pointer;white-space:nowrap">
        ▶ Spela nu
      </button>
      <button onclick="document.getElementById('next-ep-banner').remove();clearTimeout(_nextEpTimer)"
        style="background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer">✕</button>`;
  };
  update();
  document.getElementById("player-bar").appendChild(banner);
  _nextEpTimer = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      clearInterval(_nextEpTimer);
      banner.remove();
      playEpisode(nextEp.id, currentEpisodeData.showTitle||"", currentEpisodeData.showId, currentEpisodeData.season, nextEp.episode);
    } else {
      update();
    }
  }, 1000);
}

function playMusic(id, title, artist) {
  const bar = document.getElementById("player-bar");
  const video = document.getElementById("main-video");
  const token = localStorage.getItem("sv_token") || API._token || "";
  video.src = "/api/stream/" + id + "?token=" + encodeURIComponent(token);
  video.play();
  bar.style.display = "flex";
  document.getElementById("pb-title").textContent = title;
  document.getElementById("pb-sub").textContent = artist;
  document.body.style.paddingBottom = "100px";
  nowPlayingId = id;
  loadMusicPage();
}


// ── CUSTOM PLAYER CONTROLS ─────────────────────────────────────────────────
let playerDuration = 0;

function getAbsolutePosition() {
  const video = document.getElementById("main-video");
  const ct = video ? video.currentTime : 0;
  const startSec = window._dashStartSec || 0;
  // _dashFirstCT is video.currentTime at the moment playback started this session
  // Subtract it so position is relative to session start, not segment numbering
  const firstCT = window._dashFirstCT || 0;
  if (ct && ct > 0 && !isNaN(ct) && isFinite(ct)) {
    return startSec + Math.max(0, ct - firstCT);
  }
  // Fallback: wall clock
  const elapsed = (Date.now() - (window._dashSessionStart || Date.now())) / 1000;
  return startSec + elapsed;
}

function updateProgressBar() {
  const video = document.getElementById("main-video");
  const fill = document.getElementById("ctrl-progress-fill");
  const seek = document.getElementById("ctrl-seek");
  const time = document.getElementById("ctrl-time");
  const dur = playerDuration || (isNaN(video.duration) ? 0 : video.duration);
  if (!dur) return;
  const pos = getAbsolutePosition();
  window._currentPlayPos = pos;
  const pct = Math.min(100, (pos / dur) * 100);
  if (fill) fill.style.width = pct + "%";
  if (seek && !window._seekDragging) seek.value = Math.round(Math.min(1000, (pos / dur) * 1000));
  if (time && !window._seekDragging) time.textContent = formatTime(pos) + " / " + formatTime(dur);
}

function formatTime(sec) {
  if (!sec || isNaN(sec)) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return h + ":" + String(m).padStart(2,"0") + ":" + String(s).padStart(2,"0");
  return m + ":" + String(s).padStart(2,"0");
}

function initPlayerControls(duration) {
  const video = document.getElementById("main-video");
  playerDuration = duration || 0;
  // Add subtitle button if not already there
  if (!document.getElementById("ctrl-subtitles")) {
    var fsBtn = document.querySelector(".ctrl-btn[onclick*='toggleFullscreen']");
    if (fsBtn) {
      var subBtn = document.createElement("button");
      subBtn.className = "ctrl-btn";
      subBtn.id = "ctrl-subtitles";
      subBtn.textContent = "🔤";
      subBtn.title = "Undertexter";
      subBtn.onclick = toggleSubtitleMenu;
      fsBtn.parentNode.insertBefore(subBtn, fsBtn);
    }
  }
  console.log("[DURATION] playerDuration set to:", playerDuration, "seconds =", Math.floor(playerDuration/60), "min");

  video.ontimeupdate = () => {
    updateProgressBar();
  };

  // Seek via custom slider
  const seek = document.getElementById("ctrl-seek");
  if (seek) {
    // Show preview time while dragging without seeking
    seek.oninput = () => {
      window._seekDragging = true;
      const dur = playerDuration || (isNaN(video.duration) ? 0 : video.duration);
      if (dur) {
        const previewTime = (seek.value / 1000) * dur;
        const time = document.getElementById("ctrl-time");
        if (time) time.textContent = formatTime(previewTime) + " / " + formatTime(dur);
        const fill = document.getElementById("ctrl-progress-fill");
        if (fill) fill.style.width = (seek.value / 10) + "%";
      }
    };

    // Single unified seek handler - called ONCE on release
    const doSeekFromSlider = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      window._seekDragging = false;
      const dur = playerDuration || (isNaN(video.duration) ? 0 : video.duration);
      if (!dur) return;
      const newTime = Math.floor((seek.value / 1000) * dur);
      console.log("[SEEK] seeking to:", newTime, "s");
      if (window._hlsSeekHandler) {
        window._hlsSeekHandler(newTime);
      }
    };

    // Use ONLY mouseup - prevents mouseup+touchend double-fire on desktop
    // touchend handles mobile separately
    seek.addEventListener("mouseup", doSeekFromSlider, { once: false });
    seek.addEventListener("touchend", (e) => {
      // Only fire if not already handled by mouseup (mobile-only)
      if (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) {
        doSeekFromSlider(e);
      } else if (!e.sourceCapabilities) {
        doSeekFromSlider(e);
      }
    });

    // Hover: show time tooltip on progress bar
    const bg = document.getElementById("ctrl-progress-bg");
    const hoverTime = document.getElementById("ctrl-hover-time");
    if (bg && hoverTime) {
      bg.addEventListener("mousemove", (e) => {
        const dur = playerDuration || 0;
        if (!dur) return;
        const rect = bg.getBoundingClientRect();
        const pct = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
        const timeSec = pct * dur;
        hoverTime.textContent = formatTime(timeSec);
        hoverTime.style.left = (pct * 100) + "%";
        hoverTime.style.display = "block";
      });
      bg.addEventListener("mouseleave", () => {
        hoverTime.style.display = "none";
      });
    }
  }

  // Play/pause button
  video.onplay = () => { const b = document.getElementById("ctrl-play"); if (b) b.textContent = "⏸"; };
  video.onpause = () => { const b = document.getElementById("ctrl-play"); if (b) b.textContent = "▶"; };
}

// ── BUFFER POLLING ─────────────────────────────────────────────────────────
let _bufferPollTimer = null;

function startBufferPolling(itemId) {
  if (_bufferPollTimer) clearInterval(_bufferPollTimer);
  _bufferPollTimer = setInterval(async () => {
    try {
      const dur = playerDuration;
      if (!dur) return;
      const data = await API.get("/dash/" + itemId + "/progress");
      if (data && data.bufferedSec !== undefined) {
        const bufPct = Math.min((data.bufferedSec / dur) * 100, 100);
        const fill = document.getElementById("ctrl-buffer-fill");
        if (fill) fill.style.width = bufPct + "%";
      }
    } catch(e) {}
  }, 2000);
}

function stopBufferPolling() {
  if (_bufferPollTimer) { clearInterval(_bufferPollTimer); _bufferPollTimer = null; }
  const fill = document.getElementById("ctrl-buffer-fill");
  if (fill) fill.style.width = "0%";
}

function togglePlay() {
  const video = document.getElementById("main-video");
  if (video.paused) video.play().catch(() => {}); else video.pause();
}

function skipTime(sec) {
  const video = document.getElementById("main-video");
  const dur = playerDuration || (isNaN(video.duration) ? 0 : video.duration);
  const absPos = getAbsolutePosition();
  const newTime = Math.max(0, Math.min(absPos + sec, dur - 1));
  console.log("[SKIP] sec:", sec, "absPos:", Math.floor(absPos), "newTime:", Math.floor(newTime));
  if (window._hlsSeekHandler) {
    window._hlsSeekHandler(Math.floor(newTime));
  }
}

function toggleMute() {
  const video = document.getElementById("main-video");
  video.muted = !video.muted;
  const btn = document.querySelector(".ctrl-vol .ctrl-btn");
  if (btn) btn.textContent = video.muted ? "🔇" : "🔊";
}

function setVolume(val) {
  const video = document.getElementById("main-video");
  video.volume = val / 100;
}

var _fsHideTimer = null;

function showFsControls() {
  var controls = document.getElementById("custom-controls");
  var bar = document.getElementById("player-bar");
  if (!document.fullscreenElement) return;
  controls.style.opacity = "1";
  bar.style.cursor = "default";
  clearTimeout(_fsHideTimer);
  _fsHideTimer = setTimeout(function() {
    controls.style.opacity = "0";
    bar.style.cursor = "none";
  }, 3000);
}

function toggleFullscreen() {
  var bar = document.getElementById("player-bar");
  if (!document.fullscreenElement) {
    bar.requestFullscreen().catch(function() {});
  } else {
    document.exitFullscreen();
  }
}

document.addEventListener("fullscreenchange", function() {
  var bar = document.getElementById("player-bar");
  var controls = document.getElementById("custom-controls");
  if (document.fullscreenElement) {
    bar.addEventListener("mousemove", showFsControls);
    bar.addEventListener("click", showFsControls);
    showFsControls();
  } else {
    clearTimeout(_fsHideTimer);
    if (controls) controls.style.opacity = "1";
    if (bar) { bar.removeEventListener("mousemove", showFsControls); bar.removeEventListener("click", showFsControls); bar.style.cursor = "default"; }
  }
});


// ── SUBTITLES ─────────────────────────────────────────────────────────────────
var _currentSubtitleTrack = null;
var _pendingSubtitle = null; // {url, label} to inject on next DASH session
var _subtitleSessionId = 0; // Increments on each new DASH session

async function openSubtitles(mediaId, title) {
  document.getElementById("subtitle-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "subtitle-overlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:20px";
  
  const modal = document.createElement("div");
  modal.style.cssText = "background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:520px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden";
  
  // Header
  const header = document.createElement("div");
  header.style.cssText = "padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px";
  header.innerHTML = "<span style='font-size:18px'>🔤</span><div style='flex:1'><b style='font-size:15px'>Undertexter</b><div style='font-size:12px;color:var(--muted)'>" + esc(title) + "</div></div>";
  var closeBtn2 = document.createElement("button");
  closeBtn2.textContent = "✕";
  closeBtn2.style.cssText = "background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer";
  closeBtn2.onclick = function() { overlay.remove(); };
  header.appendChild(closeBtn2);
  modal.appendChild(header);
  
  // Content area
  const contentEl = document.createElement("div");
  contentEl.id = "subtitle-content";
  contentEl.style.cssText = "flex:1;overflow-y:auto;padding:12px";
  contentEl.innerHTML = "<div style='text-align:center;padding:20px;color:var(--muted)'>⏳ Hämtar undertexter...</div>";
  modal.appendChild(contentEl);
  
  // Search footer
  var footer = document.createElement("div");
  footer.style.cssText = "padding:12px 16px;border-top:1px solid var(--border)";
  
  var footerLabel = document.createElement("div");
  footerLabel.style.cssText = "font-size:13px;color:var(--muted);margin-bottom:8px";
  footerLabel.textContent = "Sök på OpenSubtitles:";
  footer.appendChild(footerLabel);
  
  var searchRow = document.createElement("div");
  searchRow.style.cssText = "display:flex;gap:8px";
  
  var searchInput = document.createElement("input");
  searchInput.id = "sub-search-input";
  searchInput.style.cssText = "flex:1;background:var(--card2);border:1px solid var(--border);color:var(--text);font-size:13px;padding:8px 12px;border-radius:8px;outline:none";
  searchInput.placeholder = "Sök undertexter...";
  searchInput.value = title;
  searchRow.appendChild(searchInput);
  
  var langSelect = document.createElement("select");
  langSelect.id = "sub-lang-select";
  langSelect.style.cssText = "background:var(--card2);border:1px solid var(--border);color:var(--text);font-size:13px;padding:8px;border-radius:8px";
  var optSv = document.createElement("option");
  optSv.value = "sv"; optSv.textContent = "Svenska";
  var optEn = document.createElement("option");
  optEn.value = "en"; optEn.textContent = "English";
  langSelect.appendChild(optSv);
  langSelect.appendChild(optEn);
  searchRow.appendChild(langSelect);
  footer.appendChild(searchRow);
  
  var searchBtn2 = document.createElement("button");
  searchBtn2.textContent = "Sök";
  searchBtn2.style.cssText = "background:var(--accent);border:none;color:white;font-size:13px;padding:8px 14px;border-radius:8px;cursor:pointer;margin-top:8px;width:100%";
  searchBtn2.onclick = function() { searchSubtitles(mediaId); };
  footer.appendChild(searchBtn2);
  modal.appendChild(footer);
  
  overlay.appendChild(modal);
  overlay.addEventListener("click", function(e) { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  // Load existing subtitles
  try {
    var data = await API.get("/media/" + mediaId + "/subtitles");
    var subs = data.subtitles || [];
    contentEl.innerHTML = "";

    // Remove subtitle button
    var removeRow = document.createElement("div");
    removeRow.style.cssText = "display:flex;align-items:center;gap:10px;padding:10px;border-radius:8px;margin-bottom:4px";
    removeRow.innerHTML = "<span style='font-size:18px'>🚫</span><div style='flex:1'><div style='font-size:13px;font-weight:500'>Ingen undertext</div></div>";
    var removeBtn = document.createElement("button");
    removeBtn.textContent = "Ta bort";
    removeBtn.style.cssText = "background:var(--danger,#e53);border:none;color:white;font-size:12px;padding:6px 12px;border-radius:6px;cursor:pointer";
    removeBtn.onclick = function() { stopSubtitleOverlay(); _currentSubtitleTrack = null; overlay.remove(); toast("Undertext borttagen", "info"); };
    removeRow.appendChild(removeBtn);
    contentEl.appendChild(removeRow);

    if (!subs.length) {
      var noSubs = document.createElement("div");
      noSubs.style.cssText = "text-align:center;padding:12px;color:var(--muted);font-size:13px";
      noSubs.textContent = "Inga undertexter hittade i biblioteket";
      contentEl.appendChild(noSubs);
    } else {
      var label2 = document.createElement("div");
      label2.style.cssText = "font-size:12px;color:var(--muted);margin:8px 4px 4px;";
      label2.textContent = "Tillgängliga undertexter:";
      contentEl.appendChild(label2);
      subs.forEach(function(s) {
        var row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:10px;padding:10px;border-radius:8px";
        var flag = s.lang === "sv" || s.lang === "swe" ? "🇸🇪" : s.lang === "en" || s.lang === "eng" ? "🇬🇧" : "🌐";
        row.innerHTML = "<span style='font-size:18px'>" + flag + "</span><div style='flex:1'><div style='font-size:13px;font-weight:500'>" + esc(s.label) + "</div><div style='font-size:11px;color:var(--muted)'>" + (s.type === "embedded" ? "Inbakad" : "SRT-fil") + "</div></div>";
        if (s.url) {
          var btn = document.createElement("button");
          btn.textContent = "Aktivera";
          btn.style.cssText = "background:var(--accent);border:none;color:white;font-size:12px;padding:6px 12px;border-radius:6px;cursor:pointer";
          var subUrl = s.url, subLabel = s.label;
          btn.onclick = function() { 
            if (s.type === "embedded") {
              // Use async extraction for embedded subtitles
              var freshUrl = subUrl + (subUrl.includes("?") ? "&" : "?") + "_t=" + Date.now();
              activateSubtitle(freshUrl, subLabel);
            } else {
              activateSubtitle(subUrl, subLabel);
            }
            overlay.remove();
          };
          row.appendChild(btn);
        }
        contentEl.appendChild(row);
      });
    }
  } catch(e) {
    contentEl.innerHTML = "<div style='text-align:center;padding:20px;color:var(--danger);font-size:13px'>Fel: " + e.message + "</div>";
  }
}

async function searchSubtitles(mediaId) {
  var query = document.getElementById("sub-search-input")?.value?.trim();
  var lang = document.getElementById("sub-lang-select")?.value || "sv";
  var el = document.getElementById("subtitle-content");
  if (!el || !query) return;
  el.innerHTML = "<div style='text-align:center;padding:20px;color:var(--muted)'>⏳ Söker...</div>";
  try {
    var data = await API.get("/subtitles/search?query=" + encodeURIComponent(query) + "&lang=" + lang + (mediaId ? "&media_id=" + encodeURIComponent(mediaId) : ""));
    var subs = data.subtitles || [];
    if (!subs.length) { el.innerHTML = "<div style='text-align:center;padding:20px;color:var(--muted);font-size:13px'>Inga träffar</div>"; return; }
    el.innerHTML = "";
    subs.forEach(function(s) {
      var row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:10px;padding:10px;border-radius:8px";
      row.innerHTML = "<div style='flex:1'><div style='font-size:13px;font-weight:500'>" + esc(s.release || "Okänd release") + "</div><div style='font-size:11px;color:var(--muted)'>" + (s.downloads || 0) + " nedladdningar</div></div>";
      var btn = document.createElement("button");
      btn.textContent = "⬇ Ladda ner";
      btn.style.cssText = "background:var(--accent);border:none;color:white;font-size:12px;padding:6px 12px;border-radius:6px;cursor:pointer";
      var fileId = s.file_id;
      btn.onclick = function() { downloadSubtitle(fileId, mediaId); };
      row.appendChild(btn);
      el.appendChild(row);
    });
  } catch(e) {
    el.innerHTML = "<div style='text-align:center;padding:20px;color:var(--danger);font-size:13px'>Fel: " + e.message + "</div>";
  }
}

async function downloadSubtitle(fileId, mediaId) {
  try {
    toast("⏳ Laddar ner undertext...", "info");
    var data = await API.post("/subtitles/download", { file_id: fileId, media_id: mediaId });
    if (data.ok) {
      toast("✓ Undertext nedladdad!", "success");
      activateSubtitle(data.url, "Svenska");
      document.getElementById("subtitle-overlay")?.remove();
    }
  } catch(e) { toast("Fel: " + e.message, "error"); }
}

function activateSubtitle(url, label) {
  var video = document.getElementById("main-video");
  if (!video) { toast("Starta filmen först för att aktivera undertext", "info"); return; }
  
  var urlWithOffset = url;
  
  // Fetch VTT and render via custom overlay div (works in ALL browsers including LG TV)
  var fetchUrl = urlWithOffset + (urlWithOffset.includes("?") ? "&" : "?") + "_t=" + Date.now();
  console.log("[SUBTITLES] Fetching VTT from:", fetchUrl);
  fetch(fetchUrl)
    .then(function(r) { return r.text(); })
    .then(function(vttText) {
      console.log("[SUBTITLES] VTT text length:", vttText.length, "first 100 chars:", vttText.substring(0, 100));
      // Parse VTT cues
      var cues = [];
      var lines = vttText.split("\n");
      var i = 0;
      while (i < lines.length) {
        if (lines[i] && lines[i].includes(" --> ")) {
          var times = lines[i].split(" --> ");
          var startT = parseVTTTime(times[0].trim());
          var endT = parseVTTTime(times[1].trim().split(" ")[0]);
          var cueText = "";
          i++;
          while (i < lines.length && lines[i].trim() !== "" && !lines[i].includes(" --> ")) {
            cueText += (cueText ? "\n" : "") + lines[i];
            i++;
          }
          if (!isNaN(startT) && !isNaN(endT) && cueText) {
            cues.push({ start: startT, end: endT, text: cueText });
          }
        } else {
          i++;
        }
      }
      console.log("[SUBTITLES] Parsed " + cues.length + " cues, first few:", cues.slice(0,3));
      startSubtitleOverlay(cues, video);
    })
    .catch(function(e) { console.log("[SUBTITLES] Fetch error:", e); });
  _currentSubtitleTrack = url;
  toast("✓ " + (label || "Undertexter") + " aktiverad!", "success");
  document.getElementById("subtitle-overlay")?.remove();
}

function toggleSubtitleMenu() {
  if (currentItemId) openSubtitles(currentItemId, document.getElementById("pb-title")?.textContent || "");
}

async function autoLoadSubtitles(mediaId, offsetSec) {
  try {
    var data = await API.get("/media/" + mediaId + "/subtitles");
    var subs = data.subtitles || [];
    // Swedish first, then English, then anything
    // Priority: 1) Any SRT file (always Swedish), 2) Embedded SV/SWE/Swedish, 3) Nothing
    var srtSub = subs.find(function(s) { return s.type === "srt"; });
    var embeddedSv = subs.find(function(s) { 
      return s.type === "embedded" && (s.lang === "sv" || s.lang === "swe" || (s.label || "").toLowerCase().includes("swedish")); 
    });
    var sub = srtSub || embeddedSv || null;
    if (!sub || !sub.url) return;
    // Apply offset to URL only for SRT files, not embedded (embedded have absolute times)
    if (offsetSec && offsetSec > 0 && sub.url && sub.type !== "embedded") {
      sub = Object.assign({}, sub);
      sub.url = sub.url + (sub.url.includes("?") ? "&" : "?") + "offset=" + offsetSec;
    }
    // For embedded subtitles, check if extraction is ready (may need retries)
    if (sub.type === "embedded") {
      // Embedded subtitles have absolute times - never apply offset
      var subUrl = sub.url.split("?")[0] + "?index=" + sub.index;
      var subLabel = sub.label;
      // Store as pending - will be injected on next DASH session reset
      _pendingSubtitle = { url: subUrl, label: subLabel };
      // Use a global flag to prevent multiple parallel retry loops
      var retryKey = "sub_retry_" + mediaId;
      if (window[retryKey]) return; // Already retrying
      window[retryKey] = true;
      var maxRetries = 40; // ~120 seconds total (40 × 3s)
      var retryCount = 0;
      var mySessionId = _subtitleSessionId;
      var checkReady = async function() {
        // Abort if a new DASH session has started
        if (_subtitleSessionId !== mySessionId) { window[retryKey] = false; return; }
        try {
          // Add cache-buster to avoid browser caching the 202 response
          var resp = await fetch(subUrl + (subUrl.includes("?") ? "&" : "?") + "_t=" + Date.now());
          if (resp.status === 202) {
            retryCount++;
            if (retryCount < maxRetries) {
              console.log("[SUBTITLES] Extracting embedded subtitle, retry " + retryCount + "...");
              setTimeout(checkReady, 3000);
            } else {
              window[retryKey] = false;
            }
            return;
          }
          if (resp.ok) {
            if (!window[retryKey]) return; // Already handled by another loop
            console.log("[SUBTITLES] Cache ready, activating!");
            window[retryKey] = false;
            // Use a fresh URL with cache-buster
            var freshUrl = subUrl + (subUrl.includes("?") ? "&" : "?") + "_t=" + Date.now();
            activateSubtitle(freshUrl, subLabel);
          } else {
            console.log("[SUBTITLES] Unexpected status:", resp.status);
            window[retryKey] = false;
          }
        } catch(e) {
          window[retryKey] = false;
          console.log("[SUBTITLES] Check error:", e.message, e);
        }
      };
      checkReady();
      return;
    }
    // Wait for video to be ready before adding track
    var video = document.getElementById("main-video");
    if (!video) return;
    var tryActivate = function() {
      Array.from(video.querySelectorAll("track")).forEach(function(t) { t.remove(); });
      var track = document.createElement("track");
      track.kind = "subtitles";
      track.label = sub.label || "Svenska";
      track.srclang = "sv";
      track.src = sub.url;
      track.default = true;
      video.appendChild(track);
      // Need small delay for track to load
      setTimeout(function() {
        if (video.textTracks.length > 0) {
          video.textTracks[0].mode = "showing";
          console.log("[SUBTITLES] Auto-activated:", sub.label);
        }
      }, 1000);
    };
    if (video.readyState >= 1) {
      tryActivate();
    } else {
      video.addEventListener("loadedmetadata", tryActivate, { once: true });
    }
  } catch(e) { console.log("[SUBTITLES] Auto-load error:", e.message); }
}


// ── SUBTITLE OVERLAY RENDERER ────────────────────────────────────────────────
var _subtitleOverlayInterval = null;
var _subtitleOverlayId = 0; // Unique ID to prevent multiple intervals

function startSubtitleOverlay(cues, video) {
  // Stop any existing overlay
  stopSubtitleOverlay();
  // Disable any native track elements to prevent double subtitles
  Array.from(video.querySelectorAll("track")).forEach(function(t) { t.remove(); });
  if (video.textTracks && video.textTracks.length > 0) {
    Array.from(video.textTracks).forEach(function(tt) { try { tt.mode = "disabled"; } catch(e) {} });
  }
  // Increment ID so any lingering callbacks know they're stale
  _subtitleOverlayId++;
  var myId = _subtitleOverlayId;

  // Create or reuse overlay div - attach to body and position over video
  var overlay = document.getElementById("sv-subtitle-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "sv-subtitle-overlay";
    document.body.appendChild(overlay);
  }
  overlay.style.display = "block";
  
  // Position overlay over the video element
  var positionOverlay = function() {
    var rect = video.getBoundingClientRect();
    overlay.style.cssText = [
      "position:fixed",
      "bottom:" + (window.innerHeight - rect.bottom + 60) + "px",
      "left:" + rect.left + "px",
      "width:" + rect.width + "px",
      "text-align:center",
      "pointer-events:none",
      "z-index:9999",
      "padding:0 40px",
      "display:block"
    ].join(";");
  };
  positionOverlay();
  // Reposition on window resize
  window._subtitleOverlayResize = positionOverlay;
  window.addEventListener("resize", positionOverlay);

  // Poll video currentTime and show correct cue
  _subtitleOverlayInterval = setInterval(function() {
    if (myId !== _subtitleOverlayId) { clearInterval(_subtitleOverlayInterval); return; }
    if (!video || !video.parentNode) { stopSubtitleOverlay(); return; }
    var ct = (window._dashStartSec || 0) + (video.currentTime || 0);
    // Adjust for firstCT offset
    if (window._dashFirstCT) ct = (window._dashStartSec || 0) + Math.max(0, video.currentTime - window._dashFirstCT);

    var activeCue = null;
    for (var i = 0; i < cues.length; i++) {
      if (ct >= cues[i].start && ct <= cues[i].end) {
        activeCue = cues[i];
        break;
      }
    }
    if (activeCue) {
      var html = activeCue.text
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>");
      overlay.innerHTML = "<span class='sv-sub-text'>" + html + "</span>";
    } else {
      overlay.innerHTML = "";
    }
  }, 100);
}

function stopSubtitleOverlay() {
  if (_subtitleOverlayInterval) {
    clearInterval(_subtitleOverlayInterval);
    _subtitleOverlayInterval = null;
  }
  var overlay = document.getElementById("sv-subtitle-overlay");
  if (overlay) overlay.innerHTML = "";
}

function parseVTTTime(timeStr) {
  // Parse HH:MM:SS.mmm or MM:SS.mmm
  var parts = timeStr.split(":");
  var seconds = 0;
  if (parts.length === 3) {
    seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  } else if (parts.length === 2) {
    seconds = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return seconds;
}

function closePlayer() {
  stopSubtitleOverlay();
  // Destroy dash.js player first to prevent SourceBuffer errors
  if (window._dashPlayer) {
    try { window._dashPlayer.destroy(); } catch {}
    window._dashPlayer = null;
  }
  const video = document.getElementById("main-video");
  video?.pause();
  if (video) { video.src = ""; video.load(); }
  document.getElementById("player-bar").style.display = "none";
  document.body.style.paddingBottom = "";
  nowPlayingId = null;
  currentItemId = null;
  currentEpisodeData = null;
  clearInterval(_nextEpTimer);
  document.getElementById("next-ep-banner")?.remove();
  stopBufferPolling();
}

// ── SEARCH ────────────────────────────────────────────────────────────────────
function loadSearchPage() {
  document.getElementById("sec-search").innerHTML = `
  <div class="search-wrap">
    <div class="search-big">Sök</div>
    <div id="search-results"></div>
  </div>`;
  // Focus topbar search
  const tb = document.getElementById("topbar-search-input");
  if (tb) { tb.focus(); if (tb.value) handleSearch(tb.value); }
}

function handleTopbarSearch() {
  const q = document.getElementById("topbar-search-input")?.value?.trim();
  // Switch to search section if not already there
  const sec = document.getElementById("sec-search");
  if (!sec?.classList.contains("active")) switchSection("search");
  handleSearch(q);
}

let searchTimer = null;
async function handleSearch(q) {
  clearTimeout(searchTimer);
  if (q === undefined) q = document.getElementById("topbar-search-input")?.value?.trim() || "";
  const res = document.getElementById("search-results");
  if (!q || q.length < 2) { if (res) res.innerHTML = ""; return; }
  searchTimer = setTimeout(async () => {
    res.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
    try {
      const [local, castLocal, online] = await Promise.all([
        API.get("/media?search=" + encodeURIComponent(q) + "&limit=24"),
        API.get("/search/cast?query=" + encodeURIComponent(q)).catch(() => ({ items: [] })),
        API.get("/search/streaming?query=" + encodeURIComponent(q)).catch(() => ({ results: [] }))
      ]);
      let html = "";
      // Merge local results - deduplicate by id
      const localItems = local.items || [];
      const castItems = (castLocal.items || []).filter(c => !localItems.find(l => l.id === c.id));
      const allLocal = [...localItems, ...castItems];
      if (allLocal.length) {
        html += `<div class="search-results-title">I ditt bibliotek</div>`;
        html += `<div class="media-grid">${allLocal.map(i => buildCard(i, i.type === "tvshow")).join("")}</div>`;
      }
      if (online.results?.length) {
        const persons = online.results.filter(r => r.type === "person");
        const media = online.results.filter(r => r.type !== "person");
        const localTmdbIds = new Set((local.items || []).map(i => String(i.tmdb_id)).filter(Boolean));
        if (persons.length) {
          html += `<div class="search-results-title" style="margin-top:28px">Skådespelare & regissörer</div>`;
          html += `<div class="cast-scroll" style="padding:8px 0">`;
          html += persons.map(r => `
            <div class="cast-card" onclick="openPersonDetail(${r.id})">
              ${r.poster ? `<img class="cast-photo" src="${r.poster}" alt="" loading="lazy" style="object-fit:cover">` : `<div class="cast-photo-ph">👤</div>`}
              <div class="cast-name">${esc(r.title)}</div>
            </div>`).join("");
          html += `</div>`;
        }
        if (media.length) {
          html += `<div class="search-results-title" style="margin-top:28px">Var kan du se det?</div>`;
          html += `<div class="media-grid">${media.slice(0, 8).map(r => {
            const inLib = localTmdbIds.has(String(r.id));
            const clickFn = inLib ? `openDetailByTmdb("${r.id}")` : `openTmdbDetail(${r.id})`;
            return `<div class="mcard" onclick='${clickFn}'>
              ${r.poster ? `<img class="mcard-poster" src="${r.poster}" loading="lazy">` : `<div class="mcard-poster-ph"><span>${r.type==="tv"?"📺":"🎬"}</span></div>`}
              <div class="mcard-overlay"><span class="mcard-play">▶</span></div>
              ${inLib ? `<div style="position:absolute;top:6px;right:6px;background:var(--accent);color:white;font-size:10px;font-weight:700;padding:3px 7px;border-radius:10px">✓ Bibliotek</div>` : ""}
              <div class="mcard-info"><div class="mcard-title">${esc(r.title)}</div><div class="mcard-meta">${r.year || ""}</div></div>
            </div>`;
          }).join("")}</div>`;
        }
      }
      res.innerHTML = html || `<div class="empty"><div class="empty-icon">🔍</div><h3>Inga träffar för "${esc(q)}"</h3></div>`;
    } catch { res.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>Sökning misslyckades</h3></div>`; }
  }, 400);
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────
var _cacheStatusInterval = null;

function startCacheStatusPolling() {
  if (_cacheStatusInterval) return; // already polling
  _cacheStatusInterval = setInterval(async () => {
    try {
      const cs = await API.get("/subtitles/cache-status");
      const bar = document.getElementById("subtitle-cache-bar");
      const label = document.getElementById("subtitle-cache-label");
      const status = document.getElementById("subtitle-cache-status");
      const cached = document.getElementById("subtitle-cache-cached");
      const withSweEl = document.getElementById("subtitle-cache-withswe");
      const isDone = !cs.running && cs.queued === 0;
      const pct = cs.withSwe > 0 ? Math.round((cs.done / cs.withSwe) * 100) : 0;
      if (bar) bar.style.width = pct + "%";
      if (label) label.textContent = cs.done + " av " + cs.withSwe + " klara";
      if (status) status.textContent = cs.running ? "⏳ Extraherar undertexter..." : cs.queued > 0 ? "⏳ Väntar i kö..." : "✅ Alla undertexter är redo!";
      const statsEl = document.getElementById("subtitle-cache-stats");
      if (statsEl) {
        let html = "";
        const hasMovieStats = (cs.withSwe||0) + (cs.withEng||0) + (cs.withExtSrt||0) > 0;
        const hasEpStats = (cs.withSweEps||0) + (cs.withEngEps||0) + (cs.withExtSrtEps||0) > 0;
        if (hasMovieStats || cs.total > 0) {
          html += `<div style="font-weight:500;margin-bottom:2px">Filmer</div>`;
          html += `<div style="padding-left:12px">${cs.withSwe||0} med inbyggd svensk text</div>`;
          html += `<div style="padding-left:12px">${cs.withEng||0} med inbyggd engelsk text</div>`;
          html += `<div style="padding-left:12px">${cs.withExtSrt||0} med extern SRT-fil</div>`;
        }
        if (hasEpStats || (cs.totalEps||0) > 0) {
          html += `<div style="font-weight:500;margin-top:6px;margin-bottom:2px">Serier → ${cs.totalShows||0} serier · ${cs.totalEps||0} avsnitt</div>`;
          html += `<div style="padding-left:12px">${cs.withSweEps||0} med inbyggd svensk text</div>`;
          html += `<div style="padding-left:12px">${cs.withEngEps||0} med inbyggd engelsk text</div>`;
          html += `<div style="padding-left:12px">${cs.withExtSrtEps||0} med extern SRT-fil</div>`;
        }
        statsEl.innerHTML = html;
      }
      if (cached) cached.textContent = "💾 " + cs.cached + " svenska undertextfiler extraherade och sparade";
      if (isDone) {
        clearInterval(_cacheStatusInterval);
        _cacheStatusInterval = null;
      }
    } catch {}
  }, 3000);
}

async function loadSettings() {
  if (currentUser.role !== "admin") {
    // Non-admin users see their own profile page instead
    // Fetch full user data via /me to get last_login etc
    const fullUser = await API.get("/me");
    if (fullUser._id && !fullUser.id) fullUser.id = fullUser._id;
    renderUserPage(fullUser);
    return;
  }
  const sec = document.getElementById("sec-settings");
  sec.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    // Start updating next scan label
    setTimeout(updateNextScanLabel, 500);
    setInterval(updateNextScanLabel, 30000);
    const [cfg, users, libs, scanStatus, updateInfo, cacheStatus] = await Promise.all([
      API.get("/config"), API.get("/users"), API.get("/libraries"),
      API.get("/scan/status"), API.get("/updates/check").catch(() => null),
      API.get("/subtitles/cache-status").catch(() => null)
    ]);
    console.log("[SETTINGS] cacheStatus:", JSON.stringify(cacheStatus)?.slice(0,100));
    const counts = Object.fromEntries((scanStatus.counts || []).map(c => [c.type, c.c]));
    const musicData = (scanStatus.counts || []).find(c => c.type === "music");
    if (musicData) counts.albums = musicData.albums || 0;
    const tvData = (scanStatus.counts || []).find(c => c.type === "tvshow");
    if (tvData) counts.episodes = tvData.episodes || 0;
    const movieData = (scanStatus.counts || []).find(c => c.type === "movie");
    if (movieData) counts.collections = movieData.collections || 0;
    // Auto-refresh cache status while queue is running
    if (cacheStatus && (cacheStatus.running || cacheStatus.queued > 0)) {
      startCacheStatusPolling();
    }

    sec.innerHTML = `<div class="settings-wrap">
      <div class="settings-title">Inställningar</div>



      <div class="settings-section">
        <div class="settings-section-title">Biblioteksstatus</div>
        <div style="display:flex;gap:12px;margin-bottom:12px">
          <div style="background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:14px 20px;text-align:center">
            <div style="font-size:22px;font-weight:600">${counts.movie || 0}</div>
            <div style="font-size:12px;color:var(--muted)">Filmer${counts.collections ? " · " + counts.collections + " samlingar" : ""}</div>
          </div>
          <div style="background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:14px 20px;text-align:center">
            <div style="font-size:22px;font-weight:600">${counts.tvshow || 0}</div>
            <div style="font-size:12px;color:var(--muted)">Serier · ${counts.episodes || 0} avsnitt</div>
          </div>
          <div style="background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:14px 20px;text-align:center">
            <div style="font-size:22px;font-weight:600">${counts.albums || 0}</div>
            <div style="font-size:12px;color:var(--muted)">Album · ${counts.music || 0} låtar</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="s-btn primary" onclick="rescan()">↻ Skanna efter nya filer</button>
          <button class="s-btn" onclick="fullRescan()" style="border-color:#e74c3c;color:#e74c3c;">🗑 Rensa och skanna om allt</button>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-top:8px;">👁 Filbevakning aktiv · <span id="next-scan-label">Beräknar...</span></div>
      </div>

      ${cacheStatus ? `<div class="settings-section" id="subtitle-cache-section">
        <div class="settings-section-title">Automatiska undertexter</div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:8px" id="subtitle-cache-stats">
          ${((cacheStatus.withSwe||0)+(cacheStatus.withEng||0)+(cacheStatus.withExtSrt||0)) > 0 ? `<div style="font-weight:500;margin-bottom:2px">Filmer</div>
            <div style="padding-left:12px">${cacheStatus.withSwe || 0} med inbyggd svensk text</div>
            <div style="padding-left:12px">${cacheStatus.withExtSrt || 0} med extern SRT-fil</div>` : ""}
          ${(cacheStatus.totalEps || 0) > 0 ? `<div style="font-weight:500;margin-top:6px;margin-bottom:2px">Serier → ${cacheStatus.totalShows || "?"} serier hittade med totalt ${cacheStatus.totalEps} avsnitt</div>
            <div style="padding-left:12px">${cacheStatus.withSweEps || 0} med inbyggd svensk text</div>
            <div style="padding-left:12px">${cacheStatus.withExtSrtEps || 0} med extern SRT-fil</div>` : ''}
        </div>
        <div style="margin-bottom:10px">
          <div style="font-size:13px;font-weight:500;margin-bottom:6px">
            <span id="subtitle-cache-status">${cacheStatus.running ? '⏳ Extraherar undertexter...' : cacheStatus.queued > 0 ? '⏳ Väntar i kö...' : '✅ Alla undertexter är redo!'}</span>
          </div>
          ${(cacheStatus.running || cacheStatus.queued > 0) ? `
          <div style="background:var(--card2);border-radius:4px;height:8px;overflow:hidden;margin-bottom:6px">
            <div id="subtitle-cache-bar" style="height:100%;background:var(--accent);border-radius:4px;animation:pulse 1.5s ease-in-out infinite;width:100%"></div>
          </div>` : ''}
          ${cacheStatus.errors > 0 ? `<div style="font-size:11px;color:var(--muted);margin-top:4px">⚠️ ${cacheStatus.errors} filer hoppades över (bildbaserade undertexter stöds ej)</div>` : ''}
        </div>
        <div id="subtitle-cache-cached" style="font-size:12px;color:var(--muted)">💾 ${cacheStatus.done > 0 ? cacheStatus.done : cacheStatus.cached} svenska undertextfiler extraherade och sparade</div>
      </div>` : ''}

      <div class="settings-section">

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
          ${users.map(u => `<div class="user-row" style="cursor:pointer" onclick="loadUserPage('${u.id}')">
            <div class="user-av">${(u.username || "?")[0].toUpperCase()}</div>
            <div class="user-info">
              <div class="user-name">${esc(u.username)}</div>
              <div class="user-role">Senast inloggad: ${u.last_login ? new Date(u.last_login).toLocaleDateString("sv-SE") : "Aldrig"}</div>
            </div>
            <span class="user-badge ${u.role === "admin" ? "badge-admin" : "badge-user"}">${u.role === "admin" ? "Admin" : "Användare"}</span>
            <button class="s-btn" onclick="event.stopPropagation();loadUserPage('${u.id}')">Hantera</button>
            ${u.id !== currentUser.id ? `<button class="s-btn danger" onclick="event.stopPropagation();deleteUser('${u.id}')">Ta bort</button>` : ""}
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
        <div class="settings-section-title">API-nycklar</div>
        <div class="setting-row">
          <div><div class="setting-label">TMDB API-nyckel</div><div class="setting-desc">Filmaffischer och beskrivningar</div></div>
          <input class="s-input" type="password" id="s-tmdb" value="${esc(cfg.tmdb_api_key || "")}" placeholder="Ej angiven" autocomplete="off"/>
        </div>
        <div class="setting-row">
          <div><div class="setting-label">OpenSubtitles API-nyckel</div><div class="setting-desc">Automatiska undertexter</div></div>
          <input class="s-input" type="password" id="s-opensub" value="${esc(cfg.opensubtitles_api_key || "")}" placeholder="Ej angiven" autocomplete="off"/>
        </div>
        <div class="setting-row">
<div><div class="setting-label">Last.fm API-nyckel</div><div class="setting-desc">Artistbilder i musikbiblioteket</div></div>
          <input class="s-input" type="password" id="s-lastfm" value="${esc(cfg.lastfm_api_key || '')}" placeholder="Ej angiven" autocomplete="off"/>
        </div>
        <div class="setting-row">
          <div><div class="setting-label">Spotify Client ID</div><div class="setting-desc">Artistbilder i musikbiblioteket</div></div>
          <input class="s-input" type="password" id="s-spotify-id" value="${esc(cfg.spotify_client_id || '')}" placeholder="Ej angiven" autocomplete="off"/>
        </div>
        <div class="setting-row">
          <div><div class="setting-label">Spotify Client Secret</div><div class="setting-desc">Krävs tillsammans med Client ID</div></div>
          <input class="s-input" type="password" id="s-spotify-secret" value="${esc(cfg.spotify_client_secret || '')}" placeholder="Ej angiven" autocomplete="off"/>
        </div>
        <div class="setting-row">
        </div>
        <div style="margin-top:12px"><button class="s-btn primary" onclick="saveApiKeys()">Spara nycklar</button></div>
      </div>

      <div style="padding:20px 0;font-size:12px;color:var(--muted)">StreamVault v${updateInfo?.current || "–"}</div>
    </div>`;
  } catch (e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>${e.message}</h3></div>`;
  }
}

async function rescan() {
  toast("⏳ Skannar efter nya filer...", "info");
  try { 
    await API.post("/scan", {}); 
    toast("✓ Skanning startad!", "success");
    setTimeout(() => loadSettings(), 3000);
  }
  catch (e) { toast(e.message, "error"); }
}

async function fullRescan() {
  if (!confirm("Detta raderar all filminformation från databasen och skannar om allt från noll.\n\nDina faktiska filer på disk rörs inte.\n\nFortsätt?")) return;
  toast("⏳ Rensar databas och skannar om allt...", "info");
  try {
    await API.post("/scan/full-rescan", {});
    toast("✓ Full skanning startad!", "success");
    setTimeout(() => { loadSettings(); switchSection("movies"); }, 3000);
  }
  catch (e) { toast(e.message, "error"); }
}

async function updateNextScanLabel() {
  try {
    const data = await API.get("/scan/auto-status");
    const el = document.getElementById("next-scan-label");
    if (!el) return;
    if (data.scanning) {
      el.textContent = "Skannar just nu...";
    } else if (data.watchersActive > 0) {
      el.textContent = `Bevakar ${data.watchersActive} bibliotek – nya filer hittas direkt`;
    } else if ((data.watchingLibraries || []).length > 0) {
      el.textContent = "Startar bevakning...";
    } else {
      el.textContent = "Lägg till ett bibliotek för att aktivera bevakning";
    }
  } catch {}
}

async function addUser() {
  const username = document.getElementById("new-user").value.trim();
  const password = document.getElementById("new-pass").value;
  const role = document.getElementById("new-role").value;
  if (!username || !password) { toast("Ange användarnamn och lösenord", "error"); return; }
  try { await API.post("/users", { username, password, role }); toast(`✓ ${username} skapad!`, "success"); loadSettings(); }
  catch (e) { toast(e.message, "error"); }
}

async function loadUserPage(userId) {
  let user;
  if (currentUser.role !== "admin" || userId === currentUser.id) {
    // Use /me endpoint for own profile
    user = await API.get("/me");
  } else {
    const data = await API.get("/users");
    const users = data.users || data || [];
    user = (Array.isArray(users) ? users : []).find(u => u.id === userId);
  }
  if (!user) return;
  // Normalize _id to id
  if (user._id && !user.id) user.id = user._id;
  // Hide all sections and show settings section with user page content
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  const sec = document.getElementById("sec-settings");
  if (sec) {
    sec.classList.add("active");
    renderUserPage(user);
  }
}

async function renderUserPage(user) {
  const main = document.getElementById("sec-settings");
  main.innerHTML = `
    <div style="max-width:600px;margin:0 auto;padding:24px">
      <button class="s-btn" onclick="switchSection('settings')" style="margin-bottom:20px">← Tillbaka</button>
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:24px">
        <div class="user-av" style="width:56px;height:56px;font-size:24px">${(user.username||"?")[0].toUpperCase()}</div>
        <div>
          <div style="font-size:20px;font-weight:600">${esc(user.username)}</div>
          <span class="user-badge ${user.role === "admin" ? "badge-admin" : "badge-user"}">${user.role === "admin" ? "Admin" : "Användare"}</span>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Användarinformation</div>
        <div style="font-size:13px;color:var(--muted)">Senast inloggad: ${user.last_login ? new Date(user.last_login).toLocaleDateString("sv-SE") : "Aldrig"}</div>
        <div style="font-size:13px;color:var(--muted);margin-top:4px">Skapad: ${user.created_at ? new Date(user.created_at).toLocaleDateString("sv-SE") : "Okänt"}</div>
      </div>
      ${currentUser.role === "admin" && user.role !== "admin" ? `<div class="settings-section">
        <div class="settings-section-title">Biblioteksbehörigheter</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Välj vilka bibliotek användaren har tillgång till.</div>
        <div id="lib-access-list" style="display:flex;flex-direction:column;gap:8px"></div>
        <button class="s-btn primary" style="margin-top:12px" onclick="saveLibraryAccess('${user.id}')">Spara behörigheter</button>
      </div>` : ""}
      <div class="settings-section">
        <div class="settings-section-title">Byt lösenord</div>
        <div style="display:flex;flex-direction:column;gap:10px;max-width:320px">
          <input id="up-new-pw" type="password" placeholder="Nytt lösenord" class="s-input">
          <input id="up-confirm-pw" type="password" placeholder="Bekräfta lösenord" class="s-input">
          <button class="s-btn" onclick="changeUserPassword('${user.id}')">Spara lösenord</button>
        </div>
      </div>
    </div>
  `;
  // Load library access checkboxes
  if (currentUser.role === "admin" && user.role !== "admin") {
    loadLibraryAccessUI(user);
  }
}

async function loadLibraryAccessUI(user) {
  const libs = await API.get("/libraries");
  const token = localStorage.getItem("sv_token") || API._token || "";
  const allLibs = await fetch("/api/libraries-all", { headers: { Authorization: "Bearer " + token } }).then(r => r.json()).catch(() => libs);
  const container = document.getElementById("lib-access-list");
  if (!container) return;
  const userLibIds = user.library_ids || [];
  container.innerHTML = (allLibs.length ? allLibs : libs).map(lib => `
    <div style="display:flex;align-items:center;gap:8px;font-size:13px">
      <input type="checkbox" value="${lib.id}" ${userLibIds.length === 0 || userLibIds.includes(lib.id) ? "checked" : ""} style="width:16px;height:16px;cursor:pointer">
      <span>${esc(lib.name)}</span> <span style="color:var(--muted);font-size:11px">(${lib.type})</span>
    </div>
  `).join("");
}

async function saveLibraryAccess(userId) {
  const checkboxes = document.querySelectorAll("#lib-access-list input[type=checkbox]");
  const library_ids = [...checkboxes].filter(c => c.checked).map(c => c.value);
  try {
    await API.patch("/users/" + userId + "/library-access", { library_ids });
    toast("Behörigheter sparade!", "success");
  } catch(e) { toast(e.message, "error"); }
}

async function changeUserPassword(userId) {
  const pw = document.getElementById("up-new-pw").value;
  const confirm = document.getElementById("up-confirm-pw").value;
  if (!pw || pw.length < 6) return toast("Lösenordet måste vara minst 6 tecken", "error");
  if (pw !== confirm) return toast("Lösenorden matchar inte", "error");
  try {
    await API.patch("/users/" + userId + "/password", { password: pw });
    toast("Lösenordet har ändrats!", "success");
    document.getElementById("up-new-pw").value = "";
    document.getElementById("up-confirm-pw").value = "";
  } catch(e) { toast(e.message, "error"); }
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
      opensubtitles_api_key: document.getElementById("s-opensub").value.trim(),
      lastfm_api_key: document.getElementById("s-lastfm")?.value?.trim() || "",
      spotify_client_id: document.getElementById("s-spotify-id")?.value?.trim() || "",
      spotify_client_secret: document.getElementById("s-spotify-secret")?.value?.trim() || ""
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
  // Remove any existing browser
  document.getElementById("fb-overlay")?.remove();
  fbCallback = callback;
  fbSelected = null;

  const overlay = document.createElement("div");
  overlay.className = "fb-overlay";
  overlay.style.cssText = "position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;z-index:9999!important;background:rgba(0,0,0,0.85)!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:20px!important;";
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
        <button class="s-btn" onclick="closeFolderBrowser()">Avbryt</button>
        <button class="s-btn primary" id="fb-select-btn" onclick="confirmFolderSelection()" disabled>Välj denna mapp</button>
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

    // Up button - always show, go to parent or root drive list
    const upTarget = (data.parent !== null && data.parent !== undefined) ? data.parent : "";
    if (folderPath !== "") {
      html += `<div class="fb-up" onclick='loadFolder(${JSON.stringify(upTarget)})'>
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

// ── FIX METADATA ──────────────────────────────────────────────────────────────
function cleanTitleForSearch(title) {
  let n = title;
  // Remove separators
  n = n.replace(/[\.\-\_]/g, " ");
  // Remove release tags
  n = n.replace(/\b(1080p|2160p|4k|uhd|720p|480p|bluray|bdrip|webrip|web-dl|hdtv|x264|x265|hevc|avc|aac|dts|ac3|h264|h265|remux|hdr|dolby|atmos|truehd|proper|repack|extended|unrated|remastered|imax|dvdrip)\b/gi, "");
  // Remove year and after
  n = n.replace(/\b(19|20)\d{2}\b.*$/, "");
  // Remove trailing numbers
  n = n.replace(/\s+\d+\s*$/, "");
  // Clean spaces
  n = n.replace(/\s+/g, " ").trim();
  return n;
}

async function openFixMeta(mediaId, currentTitle, type) {
  // Remove existing
  document.getElementById("fix-meta-overlay")?.remove();
  // Clean title for better search results
  currentTitle = cleanTitleForSearch(currentTitle);

  const overlay = document.createElement("div");
  overlay.id = "fix-meta-overlay";
  overlay.style.cssText = "position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;z-index:10000!important;background:rgba(0,0,0,0.9)!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:20px!important;";
  overlay.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:600px;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;">
      <div style="padding:18px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;">
        <span style="font-size:18px">🔍</span>
        <div style="flex:1">
          <div style="font-size:15px;font-weight:600">Fixa filminformation</div>
          <div style="font-size:12px;color:var(--muted)">${esc(currentTitle)}</div>
        </div>
        <button onclick="document.getElementById('fix-meta-overlay').remove()" style="background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;">✕</button>
      </div>
      <div style="padding:16px 20px;border-bottom:1px solid var(--border);">
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          <input id="fix-search-input" style="flex:1;background:var(--card2);border:1px solid var(--border);color:var(--text);font-family:inherit;font-size:14px;padding:10px 14px;border-radius:8px;outline:none;" 
            type="text" placeholder="Sök efter rätt film..." value="${esc(currentTitle)}"/>
          <button onclick="runFixSearch('${mediaId}','${type}')" style="background:var(--accent);border:none;color:white;font-family:inherit;font-size:14px;font-weight:500;padding:10px 18px;border-radius:8px;cursor:pointer;">Sök</button>
        </div>
        <div style="display:flex;gap:8px;">
          <input id="fix-tmdb-id-input" style="flex:1;background:var(--card2);border:1px solid var(--border);color:var(--text);font-family:inherit;font-size:14px;padding:8px 14px;border-radius:8px;outline:none;" 
            type="text" placeholder="TMDB-URL eller ID (t.ex. themoviedb.org/movie/123 eller 123)"/>
          <button onclick="applyTmdbId('${mediaId}','${type}')" style="background:var(--card2);border:1px solid var(--border);color:var(--text);font-family:inherit;font-size:13px;padding:8px 14px;border-radius:8px;cursor:pointer;">Använd ID</button>
        </div>
      </div>
      <div id="fix-search-results" style="flex:1;overflow-y:auto;padding:12px;">
        <div style="text-align:center;color:var(--muted);padding:32px;font-size:13px;">Skriv en sökning ovan och tryck Sök</div>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  document.getElementById("fix-search-input").addEventListener("keydown", e => {
    if (e.key === "Enter") runFixSearch(mediaId, type);
  });
}

async function applyFixedMeta(mediaId, tmdbId, type) {
  try {
    // Fetch full TMDB data first
    const data = await API.get("/tmdb/lookup?id=" + tmdbId + "&type=" + type);
    if (!data || !data.id) return toast("Kunde inte hämta filminfo", "error");
    await API.post(`/media/${mediaId}/fix-meta`, {
      tmdb_id: data.id,
      title: data.title,
      year: data.year,
      overview: data.overview,
      poster_url: data.poster_url,
      backdrop_url: data.backdrop_url,
      rating: data.rating
    });
    document.getElementById("fix-meta-overlay")?.remove();
    toast("✓ Filminformation uppdaterad!", "success");
    closeDetail();
    switchSection("home");
    setTimeout(() => openDetail(mediaId), 600);
  } catch(e) { toast(e.message || "Fel vid uppdatering", "error"); }
}

async function applyTmdbId(mediaId, type) {
  const raw = document.getElementById("fix-tmdb-id-input").value.trim();
  if (!raw) return toast("Ange ett TMDB-ID eller URL", "error");
  // Extract ID from URL or use directly
  let tmdbId = raw;
  const urlMatch = raw.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);
  if (urlMatch) tmdbId = urlMatch[2];
  else tmdbId = raw.replace(/\D/g, "");
  if (!tmdbId) return toast("Kunde inte hitta ett giltigt TMDB-ID", "error");
  const results = document.getElementById("fix-search-results");
  results.innerHTML = `<div style="text-align:center;padding:32px;color:var(--muted)">⏳ Hämtar info...</div>`;
  try {
    const data = await API.get("/tmdb/lookup?id=" + tmdbId + "&type=" + type);
    if (!data || !data.id) return toast("Hittade ingen film med det ID:t", "error");
    // Show result and confirm button
    results.innerHTML = `
      <div style="display:flex;align-items:center;gap:16px;padding:16px;border-radius:10px;background:var(--card2)">
        ${data.poster_url ? `<img src="${data.poster_url}" style="width:60px;height:90px;object-fit:cover;border-radius:6px;">` : ''}
        <div style="flex:1">
          <div style="font-size:15px;font-weight:600">${esc(data.title)}</div>
          <div style="font-size:13px;color:var(--muted)">${data.year || ""}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px">TMDB ID: ${data.id}</div>
        </div>
        <button onclick="applyFixedMeta('${mediaId}', ${data.id}, '${type}')" 
          style="background:var(--accent);border:none;color:white;font-family:inherit;font-size:13px;padding:10px 16px;border-radius:8px;cursor:pointer;">
          ✓ Använd denna
        </button>
      </div>`;
  } catch(e) { toast(e.message || "Fel vid hämtning", "error"); }
}

async function runFixSearch(mediaId, type) {
  const query = document.getElementById("fix-search-input").value.trim();
  const results = document.getElementById("fix-search-results");
  if (!query) return;
  results.innerHTML = `<div style="text-align:center;padding:32px;color:var(--muted)">⏳ Söker...</div>`;
  try {
    // Build multiple search variants
    const variants = new Set();

    // Step 1: Aggressively clean the title
    let cleaned = query;
    // Remove release tags (very comprehensive list)
    cleaned = cleaned.replace(/\b(1080p|2160p|4k|uhd|uhd|720p|480p|576p|bluray|blu ray|bdrip|bd rip|webrip|web rip|web dl|webdl|hdtv|x264|x265|h264|h265|hevc|avc|xvid|divx|aac|dts|ac3|mp3|remux|hdr|hdr10|dolby|atmos|truehd|proper|repack|extended|theatrical|directors cut|unrated|remastered|imax|3d|dvdrip|dvd rip|dvdscr|dvd|scr|cam|ts|r5|retail|limited|internal|readnfo|nfofix|real|dubbed|subbed|multi|nordic|swedish|norwegian|danish|finnish)\b/gi, "");
    // Remove trailing numbers
    cleaned = cleaned.replace(/\s+\d+\s*$/, "");
    // Remove year and everything after
    cleaned = cleaned.replace(/\b(19|20)\d{2}\b.*$/, "");
    // Clean extra spaces
    cleaned = cleaned.replace(/\s+/g, " ").trim();

    // Add cleaned version
    if (cleaned) variants.add(cleaned);
    // Add original query too
    if (query !== cleaned) variants.add(query);

    // Step 2: Progressive word reduction (4 words, 3 words, 2 words)
    const words = cleaned.split(" ").filter(w => w.length > 0);
    if (words.length > 4) variants.add(words.slice(0, 4).join(" "));
    if (words.length > 3) variants.add(words.slice(0, 3).join(" "));
    if (words.length > 2) variants.add(words.slice(0, 2).join(" "));

    // Search all variants in parallel
    const searches = await Promise.all([...variants].map(v =>
      API.get(`/search-meta?query=${encodeURIComponent(v)}&type=${type}`).catch(() => ({ results: [] }))
    ));

    // Merge and deduplicate by tmdb_id
    const seen = new Set();
    const merged = [];
    for (const search of searches) {
      for (const r of (search.results || [])) {
        if (!seen.has(r.tmdb_id)) {
          seen.add(r.tmdb_id);
          merged.push(r);
        }
      }
    }

    if (!merged.length) {
      results.innerHTML = `<div style="text-align:center;padding:32px;color:var(--muted);font-size:13px;">Inga träffar för "${esc(query)}"</div>`;
      return;
    }
    results.innerHTML = merged.map(r => `
      <div style="display:flex;gap:12px;padding:10px;border-radius:8px;cursor:pointer;transition:background 0.15s;" 
           onmouseover="this.style.background='var(--card2)'" onmouseout="this.style.background=''"
           onclick='applyFixMeta("${mediaId}", this.dataset.meta)' data-meta='${JSON.stringify(r).replace(/'/g, "&#39;")}'>
        ${r.poster_url 
          ? `<img src="${r.poster_url}" style="width:50px;height:75px;object-fit:cover;border-radius:5px;flex-shrink:0;" onerror="this.style.display='none'"/>`
          : `<div style="width:50px;height:75px;background:var(--card);border-radius:5px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:20px;">🎬</div>`
        }
        <div style="flex:1;overflow:hidden;">
          <div style="font-size:14px;font-weight:500;margin-bottom:3px;">${esc(r.title)}</div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:4px;">${r.year || "Okänt år"}${r.rating ? ` · ⭐ ${parseFloat(r.rating).toFixed(1)}` : ""}</div>
          <div style="font-size:12px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${esc(r.overview || "")}</div>
        </div>
        <div style="color:var(--accent);font-size:20px;align-self:center;">›</div>
      </div>`).join("");
  } catch(e) {
    results.innerHTML = `<div style="text-align:center;padding:32px;color:var(--danger);font-size:13px;">Fel: ${e.message}</div>`;
  }
}

async function applyFixMeta(mediaId, metaJson) {
  try {
    const meta = typeof metaJson === 'string' ? JSON.parse(metaJson) : metaJson;
    await API.post(`/media/${mediaId}/fix-meta`, meta);
    document.getElementById("fix-meta-overlay")?.remove();
    toast("✓ Filminformation uppdaterad!", "success");

    // Close detail, reload current section, then reopen detail
    closeDetail();
    // Reload current section to reflect changes
    switchSection("home");
    setTimeout(() => openDetail(mediaId), 600);
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

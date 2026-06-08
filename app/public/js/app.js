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
    const data = await API.get("/updates/check");
    if (data.hasUpdate) {
      showUpdateBanner(data.latest, data.releaseNotes, data.htmlUrl);
    }
  } catch {}
}

function showUpdateBanner(version, releaseNotes, url) {
  var existing = document.getElementById("update-banner");
  if (existing) existing.remove();
  var banner = document.createElement("div");
  banner.id = "update-banner";
  banner.style.cssText = "position:fixed;bottom:80px;right:24px;z-index:300;background:#0d3d24;border:1px solid #2ecc71;border-radius:12px;padding:16px 20px;font-size:13px;color:#2ecc71;display:flex;flex-direction:column;gap:10px;box-shadow:0 4px 24px rgba(0,0,0,0.5);max-width:320px;";
  var notesHtml = releaseNotes ? "<div>" + releaseNotes.substring(0,200) + "</div>" : "";
  var urlHtml = url ? "<a href=" + url + " target=_blank style='background:#2ecc71;color:#000;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:600;display:block;text-align:center'>Hämta uppdatering</a>" : "";
  banner.innerHTML = "<div><b>StreamVault " + version + " tillgänglig!</b><button onclick='document.getElementById(String.fromCharCode(34)+String.fromCharCode(34)).remove()' style='float:right;background:none;border:none;color:#2ecc71;cursor:pointer'>✕</button></div>" + notesHtml + urlHtml;
  banner.querySelector("button").onclick = function() { banner.remove(); };
  document.body.appendChild(banner);
}

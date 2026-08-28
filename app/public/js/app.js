// StreamVault v10 - Main App
let currentUser = null;

// Best-effort cleanup when the tab/browser closes (or the app is backgrounded on some
// platforms). Not the primary defense — the server also detects and kills orphaned
// transcodes on its own — but this stops them a lot sooner in the common "closed the tab"
// case. sendBeacon can't set headers, so the token goes in the query string here.
window.addEventListener("pagehide", () => {
  if (!currentItemId) return;
  const token = localStorage.getItem("sv_token") || API._token || "";
  try { navigator.sendBeacon("/api/dash/" + currentItemId + "/stop?token=" + encodeURIComponent(token)); } catch {}
});
let nowPlayingId = null;
let allLibraries = [];

// ── INIT ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", async () => {
  applyLoginScreenTranslations();
  const token = localStorage.getItem("sv_token");
  if (token) {
    const user = JSON.parse(localStorage.getItem("sv_user") || "null");
    if (user) {
      currentUser = user;
      applyTheme(user.theme || "standard");
      try {
        const c = await API.get("/public-config");
        window._serverName = c.server_name || "StreamVault";
        window._subtitleSearchLanguages = c.subtitleSearchLanguages || [];
        window._serverDefaultLanguage = c.defaultLanguage || null;
        window._iptvEnabled = !!c.iptvEnabled; window._watchedThresholdPct = c.watchedThresholdPct || 90;
      } catch(e) {}
      showApp();
      // The localStorage copy can go stale (e.g. after changing language/password on another
      // tab, or if a previous save didn't update it) — refresh from the server in the
      // background so a reload never silently reverts a setting back to an old value.
      API.get("/me").then(fresh => {
        if (fresh && fresh._id) {
          currentUser = Object.assign({}, currentUser, fresh, { id: fresh._id });
          localStorage.setItem("sv_user", JSON.stringify(currentUser));
          if (fresh.theme) applyTheme(fresh.theme);
          applyPostLoginTranslations();
        }
      }).catch(() => {});
      return;
    }
  }
  try {
    const data = await API.post("/auth/refresh", { refreshToken: API._refresh });
    if (data?.accessToken) {
      API.setTokens(data.accessToken, data.refreshToken);
      const user = JSON.parse(localStorage.getItem("sv_user") || "null");
      if (user) { currentUser = user; applyTheme(user.theme || "standard"); showApp(); return; }
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
    // The login response only returns a minimal user object (id/username/role) — unlike
    // restoring an existing session (DOMContentLoaded above), a fresh login never fetched
    // the full profile (language, subtitleLanguages, etc). AWAITED here (not fire-and-forget)
    // — a background refresh could be outraced by someone logging in and immediately
    // pressing play, leaving currentUser.language undefined right when autoLoadSubtitles
    // needs it. This is exactly what caused subtitle auto-select to silently fall back to
    // English after a fresh login. The extra wait is a single lightweight request, not
    // noticeable, and showApp() still isn't blocked on anything else.
    try {
      const fresh = await API.get("/me");
      if (fresh && fresh._id) {
        currentUser = Object.assign({}, currentUser, fresh, { id: fresh._id });
        localStorage.setItem("sv_user", JSON.stringify(currentUser));
        applyTheme(currentUser.theme || "standard");
        console.log("[LOGIN] Full profile refreshed — language:", currentUser.language, "subtitleLanguages:", currentUser.subtitleLanguages);
      } else {
        console.log("[LOGIN] /me returned no usable data:", fresh);
      }
    } catch(e) { console.log("[LOGIN] Could not refresh full profile:", e.message); }
    try {
      const cfg = await API.get("/public-config");
      window._serverName = cfg.server_name || "StreamVault";
      window._subtitleSearchLanguages = cfg.subtitleSearchLanguages || [];
      window._serverDefaultLanguage = cfg.defaultLanguage || null;
      window._iptvEnabled = !!cfg.iptvEnabled; window._watchedThresholdPct = cfg.watchedThresholdPct || 90;
      console.log("[LOGIN] Server default language:", window._serverDefaultLanguage);
    } catch(e) { console.log("[LOGIN] Could not fetch public config:", e.message); }
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

// ── URL ROUTER ──────────────────────────────────────────────────────────────
// Gives movie/show pages and admin settings real, shareable browser URLs (e.g.
// /filmer/bad-boys-ride-or-die, /admin/settings) instead of the whole app living behind one
// unchanging address. First pass covers the highest-value pages (movie/show details, admin
// settings) — more page types (seasons, episodes, collections, people) can follow the same
// pattern later.
// Season/episode URL words follow the server's own default language (window._serverDefaultLanguage,
// already fetched via /api/public-config) — an English-language server gets /season/2/episode/5
// instead of the Swedish /sasong/2/avsnitt/5. The router recognizes BOTH sets of words when
// reading an incoming URL (not just whichever matches the CURRENT language), so old links
// keep working even if the server's default language is changed later.
function seasonEpisodeWords() {
  const lang = window._serverDefaultLanguage || "sv-SE";
  return lang === "en-US" ? { season: "season", episode: "episode" } : { season: "sasong", episode: "avsnitt" };
}
const SEASON_WORDS = ["sasong", "season"];
const EPISODE_WORDS = ["avsnitt", "episode"];

// Remembers where the person had scrolled to on each page (keyed by URL path) so pressing
// back restores them to that exact spot instead of always landing at the top. Tracked
// continuously via a debounced scroll listener (not just "at the moment of navigating away")
// since history.back() — used by our own back buttons — never goes through navigateToPath,
// so there'd be no single reliable moment to capture it otherwise.
// IMPORTANT: this app scrolls #appMain internally, not the window/document — window.scrollY
// is always 0 in this layout, so tracking has to target the actual scrolling element.
const _scrollPositions = {};
let _scrollSaveTimer = null;
function _getScrollContainer() {
  return document.getElementById("appMain") || document.scrollingElement || document.documentElement;
}
document.addEventListener("scroll", () => {
  clearTimeout(_scrollSaveTimer);
  _scrollSaveTimer = setTimeout(() => {
    _scrollPositions[window.location.pathname] = _getScrollContainer().scrollTop;
  }, 150);
}, { passive: true, capture: true }); // capture:true so this catches scroll events on #appMain too, which don't bubble to document

function navigateToPath(path, title) {
  if (window.location.pathname === path) return; // avoid piling up duplicate history entries
  history.pushState({ path }, "", path);
  if (title) document.title = title;
}

async function resolveAndRenderPath(path) {
  const parts = path.split("/").filter(Boolean);
  if ((parts[0] === "filmer" || parts[0] === "serier") && parts[1] && !SEASON_WORDS.includes(parts[2])) {
    try {
      const r = await API.get("/media/slug/" + encodeURIComponent(parts[1]));
      if (r.id) return r.type === "tvshow" ? openShowDetail(r.id, true) : openDetail(r.id, true);
    } catch(e) {}
    return switchSection("home", true);
  }
  if (parts[0] === "serier" && parts[1] && SEASON_WORDS.includes(parts[2]) && parts[3]) {
    try {
      const r = await API.get("/media/slug/" + encodeURIComponent(parts[1]));
      if (!r.id) return switchSection("home", true);
      const seasonNum = parseInt(parts[3]);
      if (EPISODE_WORDS.includes(parts[4]) && parts[5]) {
        // Episode URL — resolve the season first to find this specific episode's actual ID,
        // then set up the same season-level context openEpisodeDetail expects, exactly as if
        // the person had clicked through from the season page themselves.
        const [show, seasonData] = await Promise.all([API.get("/media/" + r.id), API.get("/tvshow/" + r.id + "/season/" + seasonNum)]);
        const episodes = seasonData.episodes || [];
        window._currentSeasonEpisodes = episodes;
        window._currentSeasonShowId = r.id;
        window._currentSeasonShowTitle = show.title;
        window._currentSeasonShowSlug = show.slug;
        window._currentSeasonNum = seasonNum;
        window._currentSeasonCast = seasonData.cast || [];
        const ep = episodes.find(e => String(e.episode) === parts[5]);
        if (ep) return openEpisodeDetail(ep.id, true);
        return switchSection("home", true);
      }
      return openSeason(r.id, seasonNum, true);
    } catch(e) {}
    return switchSection("home", true);
  }
  if (parts[0] === "personer" && parts[1]) {
    const tmdbId = parts[1].slice(parts[1].lastIndexOf("-") + 1);
    if (tmdbId) return openPersonDetail(tmdbId, true);
    return switchSection("home", true);
  }
  if ((parts[0] === "titel-film" || parts[0] === "titel-serie") && parts[1]) {
    const tmdbId = parts[1].slice(parts[1].lastIndexOf("-") + 1);
    if (tmdbId) return openTmdbDetail(tmdbId, parts[0] === "titel-serie" ? "tv" : "movie", true);
    return switchSection("home", true);
  }
  if (parts[0] === "samlingar" && parts[1]) {
    // Format is "{slug}-{collectionId}" — the collection ID is TMDB's own numeric ID, so it
    // never contains a hyphen itself, making it safe to just take everything after the last one.
    const collectionId = parts[1].slice(parts[1].lastIndexOf("-") + 1);
    if (collectionId) return openCollection(collectionId, true);
    return switchSection("collections", true);
  }
  if (parts[0] === "utforska-filmer") return openExploreMovies(true);
  if (parts[0] === "utforska-serier") return openExploreTV(true);
  if (parts[0] === "iptv") {
    const params = new URLSearchParams(window.location.search);
    if (params.get("playlist")) {
      const playlistId = params.get("playlist"), name = decodeURIComponent(params.get("name") || "");
      if (params.get("country")) return openIptvPlaylistCountry(playlistId, decodeURIComponent(params.get("country")), params.get("isCountry") === "true", name, true);
      return openIptvPlaylist(playlistId, name, true);
    }
    if (params.get("playlists")) return loadIptvPlaylists(true);
    if (params.get("group")) return openIptvGroup(decodeURIComponent(params.get("group")), params.get("type") || "live", true);
    if (params.get("country")) return openIptvSubgroups(decodeURIComponent(params.get("country")), params.get("type") || "live", true);
    if (params.get("type")) return loadIptvGroups(params.get("type"), true);
    return loadIptv(true);
  }
  // Reserved names (main sidebar sections) always win — a library that happens to share one
  // of these exact names just won't get its own short URL, and stays reachable via the
  // sidebar as usual. Checked before the library lookup below for exactly that reason.
  const sectionsByPath = { filmer: "movies", serier: "tvshows", samlingar: "collections", sok: "search", musik: "music" };
  if (sectionsByPath[parts[0]] && !parts[1]) {
    return switchSection(sectionsByPath[parts[0]], true);
  }
  if (parts[0] === "admin" && parts[1] === "settings") {
    return switchSection("settings", true);
  }
  if (parts[0] && !parts[1] && parts[0] !== "admin") {
    const lib = (allLibraries || []).find(l => clientSlugify(l.name) === parts[0]);
    if (lib) return switchToLibrary(lib.id, lib.name, lib.type, true);
  }
  return switchSection("home", true);
}

window.addEventListener("popstate", () => {
  const path = window.location.pathname;
  resolveAndRenderPath(path).then(() => {
    // Small delay so the newly-rendered content (images, cast rows, etc.) has settled into
    // its final height before we scroll — otherwise a still-loading page can be shorter than
    // the saved position, and the scroll silently clamps to the bottom instead.
    const saved = _scrollPositions[path];
    setTimeout(() => {
      _getScrollContainer().scrollTop = typeof saved === "number" ? saved : 0;
    }, 80);
  });
});

async function showApp() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("main-app").style.display = "flex";
  document.getElementById("userAvatar").textContent = (currentUser.username || "?")[0].toUpperCase();
  document.getElementById("userName").textContent = currentUser.username;
  applyPostLoginTranslations();
  await loadSidebarLibraries();
  const path = window.location.pathname;
  if (path && path !== "/" && path !== "/index.html") {
    resolveAndRenderPath(path);
  } else {
    loadHome();
  }
  if (currentUser.role === "admin") {
    checkForUpdates();
    checkPendingOcrRequests();
  }
}

// Active admin notification: shows a badge on the "Inställningar" nav item and a toast
// when one or more users are waiting on a new bitmap-subtitle (OCR) language.
async function checkPendingOcrRequests() {
  try {
    const data = await API.get("/subtitles/ocr-pending");
    const pending = data.pending || [];
    const sbEl = document.getElementById("sb-settings");
    if (sbEl) {
      let dot = document.getElementById("sb-settings-badge");
      if (pending.length > 0) {
        if (!dot) {
          dot = document.createElement("span");
          dot.id = "sb-settings-badge";
          dot.style.cssText = "background:var(--danger,#e74c3c);color:#fff;border-radius:10px;font-size:10px;font-weight:600;padding:1px 6px;margin-left:6px;line-height:1.4";
          sbEl.appendChild(dot);
        }
        dot.textContent = pending.length;
      } else if (dot) {
        dot.remove();
      }
    }
    if (pending.length > 0) {
      const names = pending.map(p => `${SUBTITLE_LANG_ADJ[p.lang] || p.lang} (${p.username})`).join(", ");
      toast(`🔔 ${pending.length} väntar på nytt undertextspråk: ${names}`, "info");
    }
  } catch {}
}

// ── I18N ──────────────────────────────────────────────────────────────────────
// First pass: sidebar + movie/show detail pages only. Everything else (settings, admin
// panel, modals) still hardcoded Swedish for now — a deliberate, staged rollout rather than
// translating everything at once, since that would be much harder to review and test.
const I18N = {
  sv: {
    "sidebar.collections": "Samlingar",
    "sidebar.other": "ÖVRIGT",
    "sidebar.explore_movies": "Utforska Filmtrailers",
    "sidebar.explore_tv": "Utforska Serietrailers",
    "sidebar.iptv": "IPTV",
    "sidebar.back": "Tillbaka",
    "sidebar.settings": "INSTÄLLNINGAR",
    "home.recommends": "StreamVault rekommenderar",
    "home.more_info": "Mer info",
    "home.continue_watching": "Fortsätt titta",
    "home.recently_added_movies": "Nyligen tillagda filmer",
    "home.recently_added_shows": "Nyligen tillagda TV-serier",
    "detail.back": "Tillbaka",
    "detail.show_background": "Visa bakgrund",
    "detail.hide_background": "Dölj bakgrund",
    "detail.play": "Spela",
    "detail.continue": "Fortsätt",
    "detail.like": "Gillar",
    "detail.liked": "Gillad",
    "detail.like_tooltip": "Ger dig rekommendationer baserat på det du gillar",
    "detail.watched": "Sedd",
    "detail.unwatched": "Osedd",
    "detail.watched_tooltip": "Markera som sedd eller osedd",
    "detail.trailer": "Trailer",
    "detail.trailer_tooltip": "Se trailer",
    "detail.more": "Mer",
    "detail.fix_info": "Fixa info",
    "detail.edit": "Redigera",
    "detail.subtitles_menu": "Undertexter",
    "detail.fileinfo": "Filinfo",
    "detail.directed_by": "Directed by",
    "detail.video": "Video",
    "detail.audio": "Ljud",
    "detail.subtitles": "Undertexter",
    "detail.choose_subtitle": "Välj undertext",
    "detail.cast": "Skådespelare",
    "detail.cast_crew": "Skådespelare & Medverkande",
    "detail.reviews": "Betyg och recensioner",
    "detail.extras": "Extramaterial",
    "detail.seasons": "Säsonger",
    "detail.episodes": "avsnitt",
    "detail.where_to_watch": "Var kan du se den?",
    "detail.more_ways_to_watch": "Fler sätt att se den på",
    "detail.similar_movies": "Liknande filmer",
    "detail.similar_shows": "Liknande serier",
    "detail.in_library": "I biblioteket",
    "detail.not_found": "Hittades inte",
    "detail.anonymous": "Anonym",
    "detail.episodes_label": "Avsnitt",
    "detail.loading_streaming": "Hämtar streaming...",
    "detail.and_more": ", och mer",
    "detail.available_to_stream": "Tillgängligt att streama",
    "detail.rent": "Hyra",
    "detail.buy": "Köpa",
    "detail.streaming_label": "Streaming",
    "detail.done": "Klar",
    "profile.back": "← Tillbaka",
    "profile.role_admin": "Admin",
    "profile.role_user": "Användare",
    "profile.user_info": "Användarinformation",
    "profile.last_login": "Senast inloggad:",
    "profile.never": "Aldrig",
    "profile.created": "Skapad:",
    "profile.unknown": "Okänt",
    "profile.appearance": "Utseende",
    "profile.theme_desc_self": "Välj tema — sparas på ditt konto och gäller på alla enheter du loggar in på.",
    "profile.theme_desc_other": "Välj tema för den här användaren.",
    "profile.streaming_services": "Streamingtjänster",
    "profile.streaming_services_desc": "Välj de tjänster du använder. \"Fler sätt att se den på\" visar bara ditt val, istället för alla tjänster som finns.",
    "profile.loading": "Laddar...",
    "profile.save": "Spara",
    "profile.show_all_again": "Visa alla igen (rensa val)",
    "profile.smart_home": "Smarta hem (webhook)",
    "profile.enable_webhook": "Aktivera webhook för mitt konto",
    "profile.webhook_desc": "Av som standard. Låter t.ex. Home Assistant eller IFTTT reagera på när du börjar/slutar titta — se \"?\" ovan för hur man kommer igång.",
    "profile.language_setting": "Språkinställning",
    "profile.language_desc": "Välj språk för undertexter och sökning. Åsidosätter serverns globala inställning.",
    "profile.use_server_setting": "🌐 Använd serverns inställning",
    "profile.save_language": "Spara språk",
    "profile.subtitle_priority": "Undertextspråk (prioritetsordning)",
    "profile.subtitle_priority_desc": "För hushåll med fler än en nationalitet — lägg till flera språk i den ordning du vill att servern ska leta efter undertexter i. Första träffen vinner. Tomt = använd bara språkinställningen ovan, sen den vanliga eng→sv-kedjan.",
    "profile.add": "+ Lägg till",
    "profile.save_priority": "Spara prioritetsordning",
    "profile.change_password": "Byt lösenord",
    "profile.new_password": "Nytt lösenord",
    "profile.confirm_password": "Bekräfta lösenord",
    "profile.save_password": "Spara lösenord",
    "theme.standard": "Standard (mörk)",
    "theme.plexlik": "Plex-liknande (mörk, guld)",
    "theme.midnatt": "Midnattsblå (mörk)",
    "theme.skog": "Skog (mörk, grön)",
    "theme.ljus": "Ljus",
    "theme.ljusvarm": "Ljus (varm)",
    "static.login_sub": "Din personliga mediaserver",
    "static.username": "Användarnamn",
    "static.password": "Lösenord",
    "static.login_btn": "Logga in",
    "static.default_username": "Användare",
    "static.menu_settings": "⚙️ Inställningar",
    "static.menu_profile": "👤 Min profil",
    "static.menu_logout": "🚪 Logga ut",
    "static.search_placeholder": "🔍 Sök filmer, serier, skådespelare...",
    "static.back10": "⏮ 10s",
    "static.fwd10": "10s ⏭",
    "toast.added_to_liked": "Tillagd bland gillade!",
    "toast.removed": "Borttagen",
    "toast.save_error": "Fel vid sparande",
    "toast.marked_watched": "Markerad som sedd ✓",
    "toast.marked_unwatched": "Markerad som osedd ↺",
    "toast.save_failed": "Kunde inte spara",
    "resume.question": "Du har sett {label} av den här. Vill du fortsätta där du slutade, eller börja om?",
    "resume.continue": "▶ Fortsätt ({label})",
    "resume.restart": "↻ Börja om från början",
    "resume.cancel": "Avbryt",
    "explore.title": "🧭 Utforska trailers",
    "explore.movies_tab": "🎬 Filmer",
    "explore.tv_tab": "📺 Serier",
    "explore.all_genres": "Alla genrer",
    "explore.all_years": "Alla år",
    "explore.no_results": "Inga träffar med det här filtret",
    "explore.prev": "‹ Föregående",
    "explore.next": "Nästa ›",
    "explore.page_of": "Sida {page} av {total}",
    "explore.cat_popular": "Populära",
    "explore.cat_top_rated": "Topplistan",
    "explore.cat_now_playing": "Nu på bio",
    "explore.cat_upcoming": "Kommande",
    "explore.cat_on_the_air": "Sänds nu",
    "explore.cat_airing_today": "Sänds idag",
    "detail.created_by": "Skapad av",
    "detail.not_available_streaming_se": "Ej tillgänglig på streaming i Sverige",
    "home.you_liked": "Du gillade {names} — du kanske även gillar detta",
    "filter.search_in": "Sök i {name}...",
    "filter.search": "Sök...",
    "filter.sort_az": "A–Ö",
    "filter.sort_year": "År (nyast)",
    "filter.sort_rating": "Betyg",
    "filter.sort_genre": "Genre",
    "filter.all_genres": "Alla genrer",
    "filter.all_subtitle_langs": "Alla undertextspråk",
    "filter.no_results": "Inga träffar",
    "filter.count_movies": "titlar",
    "filter.count_shows": "serier",
    "filter.subtitle_tooltip": "Visa bara titlar med undertext på valt språk",
    "filter.empty_library": "Tomt bibliotek",
    "collections.none_found": "Inga samlingar hittades",
    "collections.rescan_hint": "Skanna om biblioteket för att hitta filmserier",
    "collections.count_label": "samlingar",
    "collections.new": "Ny samling",
    "collections.no_results": "Inga träffar",
    "collections.movie_count": "filmer",
    "detail.more_count": "+{n} mer",
    "person.born": "Född",
    "person.show_more": "Visa mer",
    "person.in_your_library": "I ditt bibliotek",
    "person.more_from": "Mer från {name}",
    "person.movies_by": "Filmer med {name}",
    "person.shows_by": "TV-serier med {name}",
    "person.dept_acting": "Skådespelare",
    "person.dept_directing": "Regi",
    "person.dept_writing": "Manus",
    "person.dept_production": "Produktion",
    "person.dept_sound": "Ljud",
    "person.dept_camera": "Foto",
    "person.dept_editing": "Klippning",
    "person.dept_art": "Scenografi",
    "person.dept_costume": "Kostym & Smink",
    "person.dept_crew": "Filmteam",
    "collections.in_library_heading": "I ditt bibliotek ({count})",
    "collections.missing_heading": "Saknas i ditt bibliotek ({count})",
    "collections.x_of_y_in_library": "{have} av {total} filmer i ditt bibliotek",
    "collections.edit": "✏️ Redigera samling"
  },
  en: {
    "sidebar.collections": "Collections",
    "sidebar.other": "OTHER",
    "sidebar.explore_movies": "Explore Movie Trailers",
    "sidebar.explore_tv": "Explore TV Trailers",
    "sidebar.iptv": "IPTV",
    "sidebar.back": "Back",
    "sidebar.settings": "SETTINGS",
    "home.recommends": "StreamVault recommends",
    "home.more_info": "More Info",
    "home.continue_watching": "Continue Watching",
    "home.recently_added_movies": "Recently Added Movies",
    "home.recently_added_shows": "Recently Added TV Shows",
    "detail.back": "Back",
    "detail.show_background": "Show Background",
    "detail.hide_background": "Hide Background",
    "detail.play": "Play",
    "detail.continue": "Continue",
    "detail.like": "Like",
    "detail.liked": "Liked",
    "detail.like_tooltip": "Gives you recommendations based on what you like",
    "detail.watched": "Watched",
    "detail.unwatched": "Unwatched",
    "detail.watched_tooltip": "Mark as watched or unwatched",
    "detail.trailer": "Trailer",
    "detail.trailer_tooltip": "Watch trailer",
    "detail.more": "More",
    "detail.fix_info": "Fix Info",
    "detail.edit": "Edit",
    "detail.subtitles_menu": "Subtitles",
    "detail.fileinfo": "File Info",
    "detail.directed_by": "Directed by",
    "detail.video": "Video",
    "detail.audio": "Audio",
    "detail.subtitles": "Subtitles",
    "detail.choose_subtitle": "Choose subtitle",
    "detail.cast": "Cast",
    "detail.cast_crew": "Cast & Crew",
    "detail.reviews": "Ratings and Reviews",
    "detail.extras": "Extras",
    "detail.seasons": "Seasons",
    "detail.episodes": "episodes",
    "detail.where_to_watch": "Where to watch",
    "detail.more_ways_to_watch": "More ways to watch",
    "detail.similar_movies": "Similar Movies",
    "detail.similar_shows": "Similar Shows",
    "detail.in_library": "In Library",
    "detail.not_found": "Not found",
    "detail.anonymous": "Anonymous",
    "detail.episodes_label": "Episodes",
    "detail.loading_streaming": "Loading streaming info...",
    "detail.and_more": ", and more",
    "detail.available_to_stream": "Available to Stream",
    "detail.rent": "Rent",
    "detail.buy": "Buy",
    "detail.streaming_label": "Streaming",
    "detail.done": "Done",
    "profile.back": "← Back",
    "profile.role_admin": "Admin",
    "profile.role_user": "User",
    "profile.user_info": "User Info",
    "profile.last_login": "Last login:",
    "profile.never": "Never",
    "profile.created": "Created:",
    "profile.unknown": "Unknown",
    "profile.appearance": "Appearance",
    "profile.theme_desc_self": "Choose a theme — saved to your account and applies on every device you log in on.",
    "profile.theme_desc_other": "Choose a theme for this user.",
    "profile.streaming_services": "Streaming Services",
    "profile.streaming_services_desc": "Choose the services you use. \"More ways to watch\" will only show your picks, instead of every available service.",
    "profile.loading": "Loading...",
    "profile.save": "Save",
    "profile.show_all_again": "Show all again (clear selection)",
    "profile.smart_home": "Smart Home (webhook)",
    "profile.enable_webhook": "Enable webhook for my account",
    "profile.webhook_desc": "Off by default. Lets e.g. Home Assistant or IFTTT react when you start/stop watching — see \"?\" above to get started.",
    "profile.language_setting": "Language",
    "profile.language_desc": "Choose the language for subtitles and search. Overrides the server's global setting.",
    "profile.use_server_setting": "🌐 Use server setting",
    "profile.save_language": "Save Language",
    "profile.subtitle_priority": "Subtitle Languages (priority order)",
    "profile.subtitle_priority_desc": "For households with more than one nationality — add several languages in the order the server should look for subtitles in. First match wins. Empty = just use the language setting above, then the usual English→Swedish chain.",
    "profile.add": "+ Add",
    "profile.save_priority": "Save Priority Order",
    "profile.change_password": "Change Password",
    "profile.new_password": "New password",
    "profile.confirm_password": "Confirm password",
    "profile.save_password": "Save Password",
    "theme.standard": "Standard (Dark)",
    "theme.plexlik": "Plex-like (Dark, Gold)",
    "theme.midnatt": "Midnight Blue (Dark)",
    "theme.skog": "Forest (Dark, Green)",
    "theme.ljus": "Light",
    "theme.ljusvarm": "Light (Warm)",
    "static.login_sub": "Your personal media server",
    "static.username": "Username",
    "static.password": "Password",
    "static.login_btn": "Log In",
    "static.default_username": "User",
    "static.menu_settings": "⚙️ Settings",
    "static.menu_profile": "👤 My Profile",
    "static.menu_logout": "🚪 Log Out",
    "static.search_placeholder": "🔍 Search movies, shows, cast...",
    "static.back10": "⏮ 10s",
    "static.fwd10": "10s ⏭",
    "toast.added_to_liked": "Added to your liked list!",
    "toast.removed": "Removed",
    "toast.save_error": "Error saving",
    "toast.marked_watched": "Marked as watched ✓",
    "toast.marked_unwatched": "Marked as unwatched ↺",
    "toast.save_failed": "Could not save",
    "resume.question": "You have watched {label} of this. Do you want to continue where you left off, or start over?",
    "resume.continue": "▶ Continue ({label})",
    "resume.restart": "↻ Start Over",
    "resume.cancel": "Cancel",
    "explore.title": "🧭 Explore Trailers",
    "explore.movies_tab": "🎬 Movies",
    "explore.tv_tab": "📺 TV Shows",
    "explore.all_genres": "All Genres",
    "explore.all_years": "All Years",
    "explore.no_results": "No results with this filter",
    "explore.prev": "‹ Previous",
    "explore.next": "Next ›",
    "explore.page_of": "Page {page} of {total}",
    "explore.cat_popular": "Popular",
    "explore.cat_top_rated": "Top Rated",
    "explore.cat_now_playing": "Now Playing",
    "explore.cat_upcoming": "Upcoming",
    "explore.cat_on_the_air": "On The Air",
    "explore.cat_airing_today": "Airing Today",
    "detail.created_by": "Created by",
    "detail.not_available_streaming_se": "Not available for streaming in Sweden",
    "home.you_liked": "You liked {names} — you might also like this",
    "filter.search_in": "Search in {name}...",
    "filter.search": "Search...",
    "filter.sort_az": "A–Z",
    "filter.sort_year": "Year (newest)",
    "filter.sort_rating": "Rating",
    "filter.sort_genre": "Genre",
    "filter.all_genres": "All Genres",
    "filter.all_subtitle_langs": "All Subtitle Languages",
    "filter.no_results": "No results",
    "filter.count_movies": "titles",
    "filter.count_shows": "shows",
    "filter.subtitle_tooltip": "Only show titles with subtitles in the selected language",
    "filter.empty_library": "Empty Library",
    "collections.none_found": "No collections found",
    "collections.rescan_hint": "Rescan the library to find movie franchises",
    "collections.count_label": "collections",
    "collections.new": "New Collection",
    "collections.no_results": "No results",
    "collections.movie_count": "movies",
    "detail.more_count": "+{n} more",
    "person.born": "Born",
    "person.show_more": "Show more",
    "person.in_your_library": "In Your Library",
    "person.more_from": "More From {name}",
    "person.movies_by": "Movies with {name}",
    "person.shows_by": "TV Shows with {name}",
    "person.dept_acting": "Acting",
    "person.dept_directing": "Directing",
    "person.dept_writing": "Writing",
    "person.dept_production": "Production",
    "person.dept_sound": "Sound",
    "person.dept_camera": "Camera",
    "person.dept_editing": "Editing",
    "person.dept_art": "Art",
    "person.dept_costume": "Costume & Make-Up",
    "person.dept_crew": "Crew",
    "collections.in_library_heading": "In Your Library ({count})",
    "collections.missing_heading": "Missing From Your Library ({count})",
    "collections.x_of_y_in_library": "{have} of {total} movies in your library",
    "collections.edit": "✏️ Edit Collection"
  },
  // Best-effort machine-assisted translation, not reviewed by a native Finnish speaker —
  // worth having someone fluent check this over before treating it as final.
  fi: {
    "sidebar.collections": "Kokoelmat",
    "sidebar.other": "MUUT",
    "sidebar.explore_movies": "Selaa elokuvatrailereita",
    "sidebar.explore_tv": "Selaa sarjatrailereita",
    "sidebar.iptv": "IPTV",
    "sidebar.back": "Takaisin",
    "sidebar.settings": "ASETUKSET",
    "home.recommends": "StreamVault suosittelee",
    "home.more_info": "Lisätietoja",
    "home.continue_watching": "Jatka katselua",
    "home.recently_added_movies": "Äskettäin lisätyt elokuvat",
    "home.recently_added_shows": "Äskettäin lisätyt sarjat",
    "detail.back": "Takaisin",
    "detail.show_background": "Näytä tausta",
    "detail.hide_background": "Piilota tausta",
    "detail.play": "Toista",
    "detail.continue": "Jatka",
    "detail.like": "Tykkää",
    "detail.liked": "Tykätty",
    "detail.like_tooltip": "Antaa suosituksia tykkäämiesi perusteella",
    "detail.watched": "Katsottu",
    "detail.unwatched": "Katsomaton",
    "detail.watched_tooltip": "Merkitse katsotuksi tai katsomattomaksi",
    "detail.trailer": "Traileri",
    "detail.trailer_tooltip": "Katso traileri",
    "detail.more": "Lisää",
    "detail.fix_info": "Korjaa tiedot",
    "detail.edit": "Muokkaa",
    "detail.subtitles_menu": "Tekstitykset",
    "detail.fileinfo": "Tiedostotiedot",
    "detail.directed_by": "Ohjaaja",
    "detail.video": "Video",
    "detail.audio": "Ääni",
    "detail.subtitles": "Tekstitykset",
    "detail.choose_subtitle": "Valitse tekstitys",
    "detail.cast": "Näyttelijät",
    "detail.cast_crew": "Näyttelijät ja tekijät",
    "detail.reviews": "Arvostelut",
    "detail.extras": "Lisämateriaali",
    "detail.seasons": "Kaudet",
    "detail.episodes": "jaksoa",
    "detail.episodes_label": "Jaksot",
    "detail.where_to_watch": "Mistä katsoa",
    "detail.more_ways_to_watch": "Muita tapoja katsoa",
    "detail.similar_movies": "Samankaltaiset elokuvat",
    "detail.similar_shows": "Samankaltaiset sarjat",
    "detail.in_library": "Kirjastossa",
    "detail.not_found": "Ei löytynyt",
    "detail.anonymous": "Anonyymi",
    "detail.loading_streaming": "Haetaan suoratoistoa...",
    "detail.and_more": ", ja muuta",
    "detail.available_to_stream": "Saatavilla suoratoistona",
    "detail.rent": "Vuokraa",
    "detail.buy": "Osta",
    "detail.streaming_label": "Suoratoisto",
    "detail.done": "Valmis",
    "profile.back": "← Takaisin",
    "profile.role_admin": "Ylläpitäjä",
    "profile.role_user": "Käyttäjä",
    "profile.user_info": "Käyttäjätiedot",
    "profile.last_login": "Viimeksi kirjautunut:",
    "profile.never": "Ei koskaan",
    "profile.created": "Luotu:",
    "profile.unknown": "Tuntematon",
    "profile.appearance": "Ulkoasu",
    "profile.theme_desc_self": "Valitse teema — tallennetaan tilillesi ja koskee kaikkia laitteita, joilla kirjaudut sisään.",
    "profile.theme_desc_other": "Valitse teema tälle käyttäjälle.",
    "profile.streaming_services": "Suoratoistopalvelut",
    "profile.streaming_services_desc": "Valitse käyttämäsi palvelut. \"Muita tapoja katsoa\" näyttää vain valintasi, kaikkien palveluiden sijaan.",
    "profile.loading": "Ladataan...",
    "profile.save": "Tallenna",
    "profile.show_all_again": "Näytä kaikki uudelleen (tyhjennä valinta)",
    "profile.smart_home": "Älykoti (webhook)",
    "profile.enable_webhook": "Ota webhook käyttöön tililläni",
    "profile.webhook_desc": "Pois päältä oletuksena. Antaa esim. Home Assistantin tai IFTTT:n reagoida kun aloitat/lopetat katselun — katso \"?\" yllä aloittaaksesi.",
    "profile.language_setting": "Kieliasetus",
    "profile.language_desc": "Valitse kieli tekstityksille ja haulle. Ohittaa palvelimen yleisasetuksen.",
    "profile.use_server_setting": "🌐 Käytä palvelimen asetusta",
    "profile.save_language": "Tallenna kieli",
    "profile.subtitle_priority": "Tekstityskielet (tärkeysjärjestys)",
    "profile.subtitle_priority_desc": "Useamman kansallisuuden talouksille — lisää useita kieliä siinä järjestyksessä, jossa palvelimen tulisi etsiä tekstityksiä. Ensimmäinen osuma voittaa. Tyhjä = käytä vain yllä olevaa kieliasetusta, sitten tavallista englanti→suomi-ketjua.",
    "profile.add": "+ Lisää",
    "profile.save_priority": "Tallenna järjestys",
    "profile.change_password": "Vaihda salasana",
    "profile.new_password": "Uusi salasana",
    "profile.confirm_password": "Vahvista salasana",
    "profile.save_password": "Tallenna salasana",
    "theme.standard": "Perus (tumma)",
    "theme.plexlik": "Plex-tyylinen (tumma, kulta)",
    "theme.midnatt": "Yönsininen (tumma)",
    "theme.skog": "Metsä (tumma, vihreä)",
    "theme.ljus": "Vaalea",
    "theme.ljusvarm": "Vaalea (lämmin)",
    "static.login_sub": "Oma henkilökohtainen mediapalvelimesi",
    "static.username": "Käyttäjätunnus",
    "static.password": "Salasana",
    "static.login_btn": "Kirjaudu sisään",
    "static.default_username": "Käyttäjä",
    "static.menu_settings": "⚙️ Asetukset",
    "static.menu_profile": "👤 Oma profiili",
    "static.menu_logout": "🚪 Kirjaudu ulos",
    "static.search_placeholder": "🔍 Hae elokuvia, sarjoja, näyttelijöitä...",
    "static.back10": "⏮ 10s",
    "static.fwd10": "10s ⏭",
    "toast.added_to_liked": "Lisätty tykättyihin!",
    "toast.removed": "Poistettu",
    "toast.save_error": "Virhe tallennuksessa",
    "toast.marked_watched": "Merkitty katsotuksi ✓",
    "toast.marked_unwatched": "Merkitty katsomattomaksi ↺",
    "toast.save_failed": "Tallennus epäonnistui",
    "resume.question": "Olet katsonut tästä {label}. Haluatko jatkaa siitä mihin jäit, vai aloittaa alusta?",
    "resume.continue": "▶ Jatka ({label})",
    "resume.restart": "↻ Aloita alusta",
    "resume.cancel": "Peruuta",
    "explore.title": "🧭 Selaa trailereita",
    "explore.movies_tab": "🎬 Elokuvat",
    "explore.tv_tab": "📺 Sarjat",
    "explore.all_genres": "Kaikki genret",
    "explore.all_years": "Kaikki vuodet",
    "explore.no_results": "Ei tuloksia tällä suodattimella",
    "explore.prev": "‹ Edellinen",
    "explore.next": "Seuraava ›",
    "explore.page_of": "Sivu {page} / {total}",
    "explore.cat_popular": "Suositut",
    "explore.cat_top_rated": "Parhaiten arvostellut",
    "explore.cat_now_playing": "Nyt elokuvateattereissa",
    "explore.cat_upcoming": "Tulevat",
    "explore.cat_on_the_air": "Käynnissä",
    "explore.cat_airing_today": "Tänään",
    "detail.created_by": "Luonut",
    "detail.not_available_streaming_se": "Ei saatavilla suoratoistona Ruotsissa",
    "home.you_liked": "Pidit näistä: {names} — saatat pitää myös tästä",
    "filter.search_in": "Hae kohteesta {name}...",
    "filter.search": "Hae...",
    "filter.sort_az": "A–Ö",
    "filter.sort_year": "Vuosi (uusin)",
    "filter.sort_rating": "Arvostelu",
    "filter.sort_genre": "Genre",
    "filter.all_genres": "Kaikki genret",
    "filter.all_subtitle_langs": "Kaikki tekstityskielet",
    "filter.no_results": "Ei tuloksia",
    "filter.count_movies": "nimikettä",
    "filter.count_shows": "sarjaa",
    "filter.subtitle_tooltip": "Näytä vain nimikkeet, joissa on tekstitys valitulla kielellä",
    "filter.empty_library": "Tyhjä kirjasto",
    "collections.none_found": "Kokoelmia ei löytynyt",
    "collections.rescan_hint": "Skannaa kirjasto uudelleen löytääksesi elokuvasarjoja",
    "collections.count_label": "kokoelmaa",
    "collections.new": "Uusi kokoelma",
    "collections.no_results": "Ei tuloksia",
    "collections.movie_count": "elokuvaa",
    "detail.more_count": "+{n} lisää",
    "person.born": "Syntynyt",
    "person.show_more": "Näytä lisää",
    "person.in_your_library": "Kirjastossasi",
    "person.more_from": "Lisää: {name}",
    "person.movies_by": "Elokuvat: {name}",
    "person.shows_by": "TV-sarjat: {name}",
    "person.dept_acting": "Näytteleminen",
    "person.dept_directing": "Ohjaus",
    "person.dept_writing": "Käsikirjoitus",
    "person.dept_production": "Tuotanto",
    "person.dept_sound": "Ääni",
    "person.dept_camera": "Kuvaus",
    "person.dept_editing": "Leikkaus",
    "person.dept_art": "Lavastus",
    "person.dept_costume": "Puvustus & Maskeeraus",
    "person.dept_crew": "Työryhmä",
    "collections.in_library_heading": "Kirjastossasi ({count})",
    "collections.missing_heading": "Puuttuu kirjastostasi ({count})",
    "collections.x_of_y_in_library": "{have}/{total} elokuvaa kirjastossasi",
    "collections.edit": "✏️ Muokkaa kokoelmaa"
  }
};
function t(key) {
  const raw = (currentUser?.language || "").toLowerCase();
  const lang = raw.startsWith("en") ? "en" : raw.startsWith("fi") ? "fi" : "sv";
  return I18N[lang][key] || I18N.sv[key] || key;
}

// Curated homepage links for the common streaming services — used instead of TMDB's shared
// aggregator link, so tapping "Netflix" actually takes you to Netflix (where you'd search for
// the title yourself) rather than every provider leading to the exact same generic page,
// which defeated the point of showing distinct, chosen services in the first place. Falls
// back to the TMDB link for anything not in this list, rather than nothing at all.
const PROVIDER_HOMEPAGES = {
  "Netflix": "https://www.netflix.com",
  "Netflix basic with Ads": "https://www.netflix.com",
  "Disney Plus": "https://www.disneyplus.com",
  "Max": "https://www.max.com",
  "HBO Max": "https://www.max.com",
  "Viaplay": "https://viaplay.se",
  "Amazon Prime Video": "https://www.primevideo.com",
  "Apple TV Plus": "https://tv.apple.com",
  "Apple TV": "https://tv.apple.com",
  "SkyShowtime": "https://www.skyshowtime.com",
  "SF Anytime": "https://www.sfanytime.com",
  "Google Play Movies": "https://play.google.com/store/movies",
  "YouTube": "https://www.youtube.com",
  "Rakuten TV": "https://www.rakuten.tv",
  "Blockbuster": "https://www.blockbuster.se",
  "TV4 Play": "https://www.tv4play.se",
  "Discovery Plus": "https://www.discoveryplus.com",
  "Paramount Plus": "https://www.paramountplus.com",
  "Crunchyroll": "https://www.crunchyroll.com"
};
function providerLink(providerName, fallbackLink) {
  return PROVIDER_HOMEPAGES[providerName] || fallbackLink || null;
}

// Login screen renders before any user is authenticated, so there's no currentUser.language
// to go on yet — the browser's own language is the only signal available at that point, same
// principle as any site showing a guess-language landing page before you've told it anything.
function applyLoginScreenTranslations() {
  const raw = navigator.language.toLowerCase();
  const lang = raw.startsWith("en") ? "en" : raw.startsWith("fi") ? "fi" : "sv";
  const tr = (key) => I18N[lang][key] || I18N.sv[key] || key;
  const sub = document.getElementById("login-sub-text");
  const userInput = document.getElementById("l-user");
  const passInput = document.getElementById("l-pass");
  const loginBtn = document.getElementById("login-btn-text");
  if (sub) sub.textContent = tr("static.login_sub");
  if (userInput) userInput.placeholder = tr("static.username");
  if (passInput) passInput.placeholder = tr("static.password");
  if (loginBtn) loginBtn.textContent = tr("static.login_btn");
}

// Static HTML elements that never get rebuilt dynamically once the app is running (sidebar
// user menu, topbar search box, player skip buttons) — called once the logged-in user's
// language is actually known, and again any time it changes (e.g. saving a new language on
// the profile page) since these elements otherwise sit untouched for the rest of the session.
function applyPostLoginTranslations() {
  const userNameEl = document.getElementById("userName");
  const menuSettings = document.getElementById("um-settings");
  const menuProfile = document.getElementById("um-profile");
  const menuLogout = document.getElementById("um-logout");
  const searchInput = document.getElementById("topbar-search-input");
  const back10 = document.getElementById("ctrl-back10");
  const fwd10 = document.getElementById("ctrl-fwd10");
  if (userNameEl && !currentUser?.username) userNameEl.textContent = t("static.default_username");
  if (menuSettings) menuSettings.textContent = t("static.menu_settings");
  if (menuProfile) menuProfile.textContent = t("static.menu_profile");
  if (menuLogout) menuLogout.textContent = t("static.menu_logout");
  if (searchInput) searchInput.placeholder = t("static.search_placeholder");
  if (back10) back10.textContent = t("static.back10");
  if (fwd10) fwd10.textContent = t("static.fwd10");
}

// Shows the admin-set translated name for the user's current language when one exists (e.g.
// name_en, name_fi — generic by design so adding another language later doesn't need a new
// field or UI pattern, just another admin input following the same lib.name_<code> shape),
// otherwise falls back to the library's regular name.
function libDisplayName(lib) {
  const raw = (currentUser?.language || "").toLowerCase();
  const langCode = raw.startsWith("en") ? "en" : raw.startsWith("fi") ? "fi" : null;
  return (langCode && lib["name_" + langCode]) ? lib["name_" + langCode] : lib.name;
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
      <div class="sb-item" id="sb-lib-${lib.id}" onclick="switchToLibrary('${lib.id}', '${libDisplayName(lib).replace(/'/g, "\'")}', '${lib.type}')">
        <span class="sb-icon">${icons[lib.type] || "📁"}</span>
        <span>${esc(libDisplayName(lib))}</span>
      </div>
    `).join("") + `
      <div class="sb-item" id="sb-collections" onclick="switchSection('collections')">
        <span class="sb-icon">🎬</span>
        <span>${t("sidebar.collections")}</span>
      </div>
      <div class="sb-sep">${t("sidebar.other")}</div>
      <div style="height:1px;background:var(--border);margin:0 18px 4px"></div>
      <div class="sb-item" id="sb-explore-movie" onclick="openExploreMovies()">
        <span class="sb-icon">🎬</span>
        <span>${t("sidebar.explore_movies")}</span>
      </div>
      <div class="sb-item" id="sb-explore-tv" onclick="openExploreTV()">
        <span class="sb-icon">📺</span>
        <span>${t("sidebar.explore_tv")}</span>
      </div>
      <div class="sb-item" id="sb-iptv" onclick="loadIptv()" style="${window._iptvEnabled && (!currentUser?.library_ids?.length || currentUser.library_ids.includes("iptv")) ? "" : "display:none"}">
        <span class="sb-icon">📡</span>
        <span>${t("sidebar.iptv")}</span>
      </div>` +
    musicLibs.map(lib => `
      <div class="sb-item" id="sb-lib-${lib.id}" onclick="switchToLibrary('${lib.id}', '${libDisplayName(lib).replace(/'/g, "\'")}', '${lib.type}')">
        <span class="sb-icon">🎵</span>
        <span>${esc(libDisplayName(lib))}</span>
      </div>`).join("");
  } catch {}
}


// ── UPDATE CHECK ──────────────────────────────────────────────────────────────
var _inSettingsSidebarMode = false;
var _settingsActiveTab = "overview";
const SETTINGS_TABS = [
  { id: "overview", icon: "📊", label: "Översikt" },
  { id: "subs", icon: "💬", label: "Undertexter" },
  { id: "library", icon: "📚", label: "Bibliotek" },
  { id: "users", icon: "👥", label: "Användare" },
  { id: "server", icon: "⚙️", label: "Server" }
];

function enterSettingsSidebarMode() {
  _inSettingsSidebarMode = true;
  const container = document.getElementById("sb-libraries");
  if (!container) return;
  container.innerHTML = `
    <div class="sb-item" onclick="exitSettingsSidebarMode()">
      <span class="sb-icon">←</span>
      <span>${t("sidebar.back")}</span>
    </div>
  ` + (currentUser?.role === "admin" ? `
    <div class="sb-sep">${t("sidebar.settings")}</div>
    <div style="height:1px;background:var(--border);margin:0 18px 4px"></div>
  ` + SETTINGS_TABS.map(tab => `
    <div class="sb-item${_settingsActiveTab === tab.id ? " active" : ""}" id="sb-stab-${tab.id}" onclick="switchSettingsTab('${tab.id}')">
      <span class="sb-icon">${tab.icon}</span>
      <span>${tab.label}</span>
    </div>`).join("") : "");
}

function exitSettingsSidebarMode() {
  _inSettingsSidebarMode = false;
  loadSidebarLibraries();
  switchSection("home");
}

// Lightweight housekeeping ONLY (deactivate other sections, create/activate #sec-iptv,
// highlight the sidebar entry) — deliberately does NOT go through switchSection(), since
// that function's own dispatch logic calls loadIptv() for name==="iptv", which would recurse
// straight back into whichever IPTV function called this in the first place.
function activateIptvSection() {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".sb-item").forEach(b => b.classList.remove("active"));
  if (!document.getElementById("sec-iptv")) {
    const s = document.createElement("section");
    s.id = "sec-iptv"; s.className = "section";
    document.getElementById("appMain")?.appendChild(s);
  }
  document.getElementById("sec-iptv")?.classList.add("active");
  document.getElementById("sb-iptv")?.classList.add("active");
}

function switchSection(name, fromRouter) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".sb-item").forEach(b => b.classList.remove("active"));
  document.getElementById("sidebar")?.style.removeProperty("background"); // undo the detail page's "blend into backdrop" effect, in case it was left on
  document.getElementById("sidebar")?.style.removeProperty("--border");
  document.getElementById("sidebar")?.style.removeProperty("border-color");
  document.getElementById("topbar")?.style.removeProperty("background");
  document.getElementById("topbar")?.style.removeProperty("--border");
  document.getElementById("topbar")?.style.removeProperty("border-color");
  document.getElementById("sec-detail")?.style.removeProperty("--border");
  document.querySelectorAll("#sec-detail .detail-section-title").forEach(el => el.style.removeProperty("border-color"));
  if (name !== "settings" && _liveActivityInterval) { clearInterval(_liveActivityInterval); _liveActivityInterval = null; }
  if (name !== "settings" && _systemStatsInterval) { clearInterval(_systemStatsInterval); _systemStatsInterval = null; }
  if (name !== "settings" && _downloadsInterval) { clearInterval(_downloadsInterval); _downloadsInterval = null; }
  if (name !== "settings" && _scanProgressInterval) { clearInterval(_scanProgressInterval); _scanProgressInterval = null; }
  if (name !== "settings" && _inSettingsSidebarMode) { _inSettingsSidebarMode = false; loadSidebarLibraries(); }
  if (!fromRouter) {
    const paths = { home: "/", settings: "/admin/settings", movies: "/filmer", tvshows: "/serier", collections: "/samlingar", search: "/sok", music: "/musik", iptv: "/iptv" };
    if (paths[name]) navigateToPath(paths[name], name === "home" ? "StreamVault" : undefined);
  }
  // "explore"/"iptv" don't exist in the static HTML (added after the fact) — create them
  // once, same self-creating pattern already used for sec-detail/sec-library.
  if ((name === "explore" || name === "iptv") && !document.getElementById("sec-" + name)) {
    const s = document.createElement("section");
    s.id = "sec-" + name; s.className = "section";
    document.getElementById("appMain")?.appendChild(s);
  }
  const sec = document.getElementById("sec-" + name);
  if (sec) sec.classList.add("active");
  const sbEl = document.getElementById("sb-" + name);
  if (sbEl) sbEl.classList.add("active");
  if (name === "home") loadHome();
  else if (name === "movies") loadMediaSection("movies");
  else if (name === "tvshows") loadMediaSection("tvshows");
  else if (name === "music") loadMusicPage();
  else if (name === "search") loadSearchPage();
  else if (name === "settings") { if (!_inSettingsSidebarMode) enterSettingsSidebarMode(); loadSettings(); }
  else if (name === "collections") loadCollections();
  else if (name === "explore") loadExplore();
  else if (name === "iptv") loadIptv();
  const userMenu = document.getElementById("userMenu");
  if (userMenu) userMenu.style.display = "none";
}

// ── IPTV ──────────────────────────────────────────────────────────────────────
async function refreshIptvChannels() {
  const btn = document.getElementById("iptv-refresh-btn");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Uppdaterar..."; }
  try {
    const data = await API.post("/iptv/refresh", {});
    toast(`✓ ${data.count} kanaler uppdaterade`, "success");
    loadIptv(true);
  } catch(e) {
    toast("Fel: " + e.message, "error");
    if (btn) { btn.disabled = false; btn.textContent = "🔄 Uppdatera kanallistan"; }
  }
}

// Rough country-name → ISO 3166-1 alpha-2 code mapping for IPTV group-titles, which are
// usually just plain country names (sometimes with " HD"/"4K" suffixes, hence the
// fuzzy/partial matching below). Used to build a real flag IMAGE (via flagcdn.com) rather
// than an emoji flag — emoji flags render poorly or not at all on many Windows browser/font
// combinations, while flag images work consistently everywhere.
const COUNTRY_CODES = {
  "sweden": "se", "sverige": "se", "norway": "no", "norge": "no", "denmark": "dk", "danmark": "dk",
  "finland": "fi", "iceland": "is", "uk": "gb", "united kingdom": "gb", "england": "gb", "britain": "gb",
  "usa": "us", "us": "us", "united states": "us", "america": "us", "canada": "ca", "germany": "de",
  "deutschland": "de", "france": "fr", "spain": "es", "espana": "es", "italy": "it", "italia": "it",
  "netherlands": "nl", "holland": "nl", "belgium": "be", "portugal": "pt", "poland": "pl", "polska": "pl",
  "russia": "ru", "turkey": "tr", "turkiye": "tr", "greece": "gr", "austria": "at", "switzerland": "ch",
  "ireland": "ie", "albania": "al", "arabic": "sa", "saudi": "sa", "uae": "ae", "emirates": "ae",
  "india": "in", "pakistan": "pk", "brazil": "br", "brasil": "br", "mexico": "mx", "australia": "au",
  "romania": "ro", "bulgaria": "bg", "croatia": "hr", "serbia": "rs", "hungary": "hu", "czech": "cz",
  "slovakia": "sk", "slovenia": "si", "lithuania": "lt", "latvia": "lv", "estonia": "ee", "ukraine": "ua",
  "china": "cn", "japan": "jp", "korea": "kr", "thailand": "th", "philippines": "ph", "vietnam": "vn",
  "indonesia": "id", "malaysia": "my", "israel": "il", "egypt": "eg", "morocco": "ma", "south africa": "za"
};
function flagImgForGroup(name) {
  const clean = name.toLowerCase().replace(/\bhd\b|\b4k\b|\buhd\b|\bfhd\b/g, "").trim();
  for (const [country, code] of Object.entries(COUNTRY_CODES)) {
    if (clean === country || clean.includes(country)) {
      return `<img src="https://flagcdn.com/w80/${code}.png" alt="" style="width:56px;height:auto;border-radius:3px;box-shadow:0 1px 4px rgba(0,0,0,0.4)">`;
    }
  }
  return `<span style="font-size:44px">📺</span>`;
}

// Spotify-style "save to..." picker — works for either a single channel ({channelId}) or a
// whole country/group ({country, isCountry}). Shows the person's existing playlists with
// checkboxes (pre-checked if this channel/country is already in that list) plus a "create
// new list" option, so adding to a brand new list works in one step without leaving the picker.
async function openSaveToPlaylistPicker(target) {
  document.getElementById("iptv-playlist-picker-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "iptv-playlist-picker-overlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:10004;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  const modal = document.createElement("div");
  modal.style.cssText = "background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:340px;max-height:70vh;display:flex;flex-direction:column;overflow:hidden";
  modal.innerHTML = `
    <div style="padding:14px 16px;border-bottom:1px solid var(--border);font-weight:600">Spara till spellista</div>
    <div id="iptv-playlist-picker-list" style="flex:1;overflow-y:auto;padding:8px"><div class="spinner-wrap" style="height:80px"><div class="spinner"></div></div></div>
    <div style="padding:10px 16px;border-top:1px solid var(--border);display:flex;gap:8px">
      <input type="text" id="iptv-new-playlist-name" placeholder="Ny spellista..." class="s-input" style="flex:1;font-size:13px">
      <button class="btn-fav" onclick="createIptvPlaylistFromPicker()">+ Skapa</button>
    </div>`;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  window._iptvPickerTarget = target;

  await reloadPlaylistPickerList();
}

async function reloadPlaylistPickerList() {
  const listEl = document.getElementById("iptv-playlist-picker-list");
  if (!listEl) return;
  const target = window._iptvPickerTarget;
  try {
    const data = target.channelId
      ? await API.get("/iptv/playlists/for-channel/" + target.channelId)
      : await API.get("/iptv/playlists/for-country?country=" + encodeURIComponent(target.country) + "&isCountry=" + !!target.isCountry);
    if (!data.playlists.length) {
      listEl.innerHTML = `<div style="padding:16px;text-align:center;color:var(--muted);font-size:13px">Inga spellistor än — skapa en nedan.</div>`;
      return;
    }
    listEl.innerHTML = data.playlists.map(p => `
      <label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:14px" onmouseover="this.style.background='var(--card2)'" onmouseout="this.style.background='transparent'">
        <input type="checkbox" ${p.contains ? "checked" : ""} onchange="onPlaylistPickerToggle('${p.id}', this.checked)" style="width:18px;height:18px;cursor:pointer">
        <span>${esc(p.name)}</span>
      </label>`).join("");
  } catch(e) {
    listEl.innerHTML = `<div style="padding:16px;color:var(--danger);font-size:13px">Fel: ${esc(e.message)}</div>`;
  }
}

async function onPlaylistPickerToggle(playlistId, add) {
  const target = window._iptvPickerTarget;
  try {
    if (target.channelId) {
      await API.post(`/iptv/playlists/${playlistId}/toggle-channel`, { channelId: target.channelId, add });
    } else {
      await API.post(`/iptv/playlists/${playlistId}/toggle-country`, { country: target.country, isCountry: target.isCountry, add });
    }
    toast(add ? "✓ Tillagt" : "Borttaget", "success");
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

async function createIptvPlaylistFromPicker() {
  const input = document.getElementById("iptv-new-playlist-name");
  const name = input?.value.trim();
  if (!name) { toast("Ange ett namn", "info"); return; }
  try {
    await API.post("/iptv/playlists", { name });
    input.value = "";
    toast(`✓ "${name}" skapad`, "success");
    await reloadPlaylistPickerList();
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

async function loadIptv(fromRouter) {
  activateIptvSection();
  const sec = document.getElementById("sec-iptv");
  if (!sec) return;
  if (!fromRouter) navigateToPath("/iptv", "IPTV - StreamVault");
  sec.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const data = await API.get("/iptv/groups"); // default type=live, just used here to get typeCounts + check if anything's configured at all
    const total = (data.typeCounts?.live || 0) + (data.typeCounts?.movie || 0) + (data.typeCounts?.series || 0);
    if (!total) {
      sec.innerHTML = `
        <div class="grid-wrap">
          <h2 style="margin-bottom:14px">📡 IPTV</h2>
          <p style="color:var(--muted)">Inga kanaler tillagda än. ${currentUser?.role === "admin" ? `Gå till Inställningar → Server → IPTV och klistra in en M3U-spellista-adress.` : `Be en admin lägga till en spellista i Inställningar.`}</p>
        </div>`;
      return;
    }
    const tiles = [
      { type: "live", icon: "📺", label: "LIVE TV", count: data.typeCounts.live },
      { type: "movie", icon: "🎬", label: "FILMER", count: data.typeCounts.movie },
      { type: "series", icon: "🎞️", label: "SERIER", count: data.typeCounts.series }
    ].filter(t => t.count > 0); // don't show a tile for a type the playlist doesn't actually have
    tiles.push({ type: "favorites", icon: "⭐", label: "FAVORITER", count: null });
    sec.innerHTML = `
      <div class="grid-wrap">
        <button onclick="history.back()" style="background:var(--card2, #1a1a28);color:var(--text, #fff);border:1px solid var(--border, #333);padding:8px 16px;border-radius:8px;cursor:pointer;font-size:14px;display:inline-block;margin-bottom:14px">← Tillbaka</button>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:8px">
          <h2 style="margin:0">📡 IPTV</h2>
          ${currentUser?.role === "admin" ? `<button class="btn-fav" onclick="refreshIptvChannels()" id="iptv-refresh-btn">🔄 Uppdatera kanallistan</button>` : ""}
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          ${tiles.map(t => `
            <div onclick="${t.type === "favorites" ? "loadIptvPlaylists()" : `loadIptvGroups('${t.type}')`}" style="cursor:pointer;width:180px;height:180px;border-radius:12px;background:var(--card2);border:1px solid var(--border);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;transition:border-color .15s" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
              <span style="font-size:44px">${t.icon}</span>
              <span style="font-weight:700;letter-spacing:0.5px">${t.label}</span>
              ${t.count !== null ? `<span style="color:var(--muted);font-size:12px">${t.count} st</span>` : ""}
            </div>`).join("")}
        </div>
      </div>`;
  } catch(e) {
    sec.innerHTML = `<p style="color:var(--danger)">Fel: ${esc(e.message)}</p>`;
  }
}

async function loadIptvGroups(type, fromRouter) {
  activateIptvSection();
  const sec = document.getElementById("sec-iptv");
  if (!sec) return;
  if (!fromRouter) navigateToPath("/iptv?type=" + type, "IPTV - StreamVault");
  sec.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const data = await API.get("/iptv/groups?type=" + type);
    const typeLabel = { live: "Live TV", movie: "Filmer", series: "Serier" }[type];
    sec.innerHTML = `
      <div class="grid-wrap">
        <button onclick="history.back()" style="background:var(--card2, #1a1a28);color:var(--text, #fff);border:1px solid var(--border, #333);padding:8px 16px;border-radius:8px;cursor:pointer;font-size:14px;display:inline-block;margin-bottom:14px">← Tillbaka</button>
        <h2 style="margin-bottom:14px">${typeLabel}</h2>
        <div class="media-grid">
          ${data.groups.map(g => `
            <div class="mcard" style="position:relative" onclick='${g.isCountry ? `openIptvSubgroups("${esc(g.name).replace(/"/g,"&quot;")}", "${type}")` : `openIptvGroup("${esc(g.name).replace(/"/g,"&quot;")}", "${type}")`}'>
              ${type === "live" ? `<button onclick='event.stopPropagation(); openSaveToPlaylistPicker({country:"${esc(g.name).replace(/"/g,"&quot;")}", isCountry:${g.isCountry}})' title="Spara till..." style="position:absolute;top:8px;right:8px;width:32px;height:32px;border-radius:50%;background:${g.inAnyPlaylist ? "var(--accent)" : "rgba(0,0,0,0.6)"};border:none;color:#fff;font-size:16px;cursor:pointer;z-index:2;display:flex;align-items:center;justify-content:center">${g.inAnyPlaylist ? "⭐" : "💾"}</button>` : ""}
              <div class="mcard-poster-ph" style="display:flex;align-items:center;justify-content:center">${type === "live" ? flagImgForGroup(g.name) : `<span style="font-size:44px">${type === "movie" ? "🎬" : "🎞️"}</span>`}</div>
              <div class="mcard-info">
                <div class="mcard-title">${esc(g.name)}</div>
                <div class="mcard-meta">${g.count} ${type === "live" ? "kanaler" : "titlar"}</div>
              </div>
            </div>`).join("")}
        </div>
      </div>`;
  } catch(e) {
    sec.innerHTML = `<p style="color:var(--danger)">Fel: ${esc(e.message)}</p>`;
  }
}

// Drills into a consolidated country card to show its original provider-specific
// sub-categories (Documentary, Sports, LOCAL CBC, etc.) before finally listing channels.
async function openIptvSubgroups(country, type, fromRouter) {
  activateIptvSection();
  const sec = document.getElementById("sec-iptv");
  if (!sec) return;
  if (!fromRouter) navigateToPath(`/iptv?type=${type}&country=${encodeURIComponent(country)}`, `${country} - StreamVault`);
  sec.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const data = await API.get("/iptv/subgroups?country=" + encodeURIComponent(country));
    sec.innerHTML = `
      <div class="grid-wrap">
        <button onclick="history.back()" style="background:var(--card2, #1a1a28);color:var(--text, #fff);border:1px solid var(--border, #333);padding:8px 16px;border-radius:8px;cursor:pointer;font-size:14px;display:inline-block;margin-bottom:14px">← Tillbaka</button>
        <h2 style="margin-bottom:14px">${esc(country)}</h2>
        <div style="display:flex;flex-direction:column;gap:8px;max-width:500px">
          ${data.groups.map(g => `
            <div class="s-row" style="cursor:pointer" onclick="openIptvGroup('${esc(g.name).replace(/'/g,"\\'")}', '${type}')">
              <span>${esc(g.name)}</span>
              <span style="color:var(--muted);font-size:13px">${g.count} kanaler</span>
            </div>`).join("")}
        </div>
      </div>`;
  } catch(e) {
    sec.innerHTML = `<p style="color:var(--danger)">Fel: ${esc(e.message)}</p>`;
  }
}

async function loadIptvPlaylists(fromRouter) {
  activateIptvSection();
  const sec = document.getElementById("sec-iptv");
  if (!sec) return;
  if (!fromRouter) navigateToPath("/iptv?playlists=1", "Mina spellistor - StreamVault");
  sec.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const data = await API.get("/iptv/playlists");
    sec.innerHTML = `
      <div class="grid-wrap">
        <button onclick="history.back()" style="background:var(--card2, #1a1a28);color:var(--text, #fff);border:1px solid var(--border, #333);padding:8px 16px;border-radius:8px;cursor:pointer;font-size:14px;display:inline-block;margin-bottom:14px">← Tillbaka</button>
        <h2 style="margin-bottom:14px">⭐ Mina spellistor</h2>
        ${!data.playlists.length ? `<p style="color:var(--muted)">Inga spellistor än. Tryck på 💾-ikonen på ett land eller en kanal för att skapa din första.</p>` : `
        <div style="display:flex;flex-direction:column;gap:8px;max-width:500px">
          ${data.playlists.map(p => `
            <div class="s-row" style="cursor:pointer" onclick="openIptvPlaylist('${p.id}', '${esc(p.name).replace(/'/g,"\\'")}')">
              <span>⭐ ${esc(p.name)}</span>
              <span style="color:var(--muted);font-size:13px">${p.count} kanaler</span>
            </div>`).join("")}
        </div>`}
      </div>`;
  } catch(e) {
    sec.innerHTML = `<p style="color:var(--danger)">Fel: ${esc(e.message)}</p>`;
  }
}

async function openIptvPlaylist(playlistId, name, fromRouter) {
  activateIptvSection();
  const sec = document.getElementById("sec-iptv");
  if (!sec) return;
  if (!fromRouter) navigateToPath(`/iptv?playlist=${playlistId}&name=${encodeURIComponent(name)}`, `${name} - StreamVault`);
  sec.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const data = await API.get("/iptv/playlists/" + playlistId + "/channels");
    const isEmpty = !data.countryEntries.length && !data.channels.length;
    sec.innerHTML = `
      <div class="grid-wrap">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <button onclick="history.back()" style="background:var(--card2, #1a1a28);color:var(--text, #fff);border:1px solid var(--border, #333);padding:8px 16px;border-radius:8px;cursor:pointer;font-size:14px;display:inline-block;margin-bottom:14px">← Tillbaka</button>
          <button class="btn-fav" style="color:var(--danger)" onclick="deleteIptvPlaylist('${playlistId}')">🗑 Ta bort lista</button>
        </div>
        <h2 style="margin-bottom:14px">⭐ ${esc(name)}</h2>
        ${isEmpty ? `<p style="color:var(--muted)">Listan är tom.</p>` : `
        <div style="display:flex;flex-direction:column;gap:6px;max-width:500px">
          ${data.countryEntries.map(c => `
            <div class="s-row" style="cursor:pointer" onclick='openIptvPlaylistCountry("${playlistId}", "${esc(c.name).replace(/"/g,"&quot;")}", ${c.isCountry}, "${esc(name).replace(/"/g,"&quot;")}")'>
              <span>🌍 ${esc(c.name)}</span>
              <span style="color:var(--muted);font-size:13px">${c.count} kanaler</span>
            </div>`).join("")}
          ${data.channels.map(c => `
            <div class="s-row" style="cursor:pointer" onclick='playIptvChannelInPlayer("${esc(c.name).replace(/"/g,"&quot;")}", "${c.url.replace(/"/g,"&quot;")}")'>
              ${c.logo ? `<img src="${c.logo}" style="width:32px;height:32px;object-fit:contain;border-radius:4px;margin-right:10px" onerror="this.style.display='none'">` : `<span style="margin-right:10px">${c.type === "movie" ? "🎬" : c.type === "series" ? "🎞️" : "📺"}</span>`}
              <span style="flex:1">${esc(c.name)}</span>
              <button onclick='event.stopPropagation(); openSaveToPlaylistPicker({channelId:"${c.id}"})' title="Spara till..." style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer">⭐</button>
            </div>`).join("")}
        </div>`}
      </div>`;
  } catch(e) {
    sec.innerHTML = `<p style="color:var(--danger)">Fel: ${esc(e.message)}</p>`;
  }
}

// Drills into a country entry WITHIN a playlist to see/play its channels — same idea as
// browsing normally, just scoped to this one playlist's "back" trail.
async function openIptvPlaylistCountry(playlistId, country, isCountry, playlistName, fromRouter) {
  activateIptvSection();
  const sec = document.getElementById("sec-iptv");
  if (!sec) return;
  if (!fromRouter) navigateToPath(`/iptv?playlist=${playlistId}&name=${encodeURIComponent(playlistName)}&country=${encodeURIComponent(country)}&isCountry=${isCountry}`, `${country} - StreamVault`);
  sec.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const data = await API.get(`/iptv/playlists/${playlistId}/country-channels?country=${encodeURIComponent(country)}&isCountry=${isCountry}`);
    sec.innerHTML = `
      <div class="grid-wrap">
        <button onclick="history.back()" style="background:var(--card2, #1a1a28);color:var(--text, #fff);border:1px solid var(--border, #333);padding:8px 16px;border-radius:8px;cursor:pointer;font-size:14px;display:inline-block;margin-bottom:14px">← Tillbaka</button>
        <h2 style="margin-bottom:14px">🌍 ${esc(country)}</h2>
        <div style="display:flex;flex-direction:column;gap:6px;max-width:500px">
          ${data.channels.map(c => `
            <div class="s-row" style="cursor:pointer" onclick='playIptvChannelInPlayer("${esc(c.name).replace(/"/g,"&quot;")}", "${c.url.replace(/"/g,"&quot;")}")'>
              ${c.logo ? `<img src="${c.logo}" style="width:32px;height:32px;object-fit:contain;border-radius:4px;margin-right:10px" onerror="this.style.display='none'">` : `<span style="margin-right:10px">📺</span>`}
              <span style="flex:1">${esc(c.name)}</span>
            </div>`).join("")}
        </div>
      </div>`;
  } catch(e) {
    sec.innerHTML = `<p style="color:var(--danger)">Fel: ${esc(e.message)}</p>`;
  }
}

async function deleteIptvPlaylist(playlistId) {
  if (!confirm("Ta bort den här spellistan? Går inte att ångra.")) return;
  try {
    await API.post("/iptv/playlists/" + playlistId + "/delete", {});
    toast("✓ Spellista borttagen", "success");
    loadIptvPlaylists(true);
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

async function openIptvGroup(groupName, type, fromRouter) {
  activateIptvSection();
  const sec = document.getElementById("sec-iptv");
  if (!sec) return;
  if (!fromRouter) navigateToPath(`/iptv?type=${type || "live"}&group=${encodeURIComponent(groupName)}`, `${groupName} - StreamVault`);
  sec.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const data = await API.get("/iptv/channels?group=" + encodeURIComponent(groupName) + "&type=" + (type || "live"));
    sec.innerHTML = `
      <div class="grid-wrap">
        <button onclick="history.back()" style="background:var(--card2, #1a1a28);color:var(--text, #fff);border:1px solid var(--border, #333);padding:8px 16px;border-radius:8px;cursor:pointer;font-size:14px;display:inline-block;margin-bottom:14px">← Tillbaka</button>
        <h2 style="margin-bottom:14px">${esc(groupName)}</h2>
        <div style="display:flex;flex-direction:column;gap:6px;max-width:500px">
          ${data.channels.map(c => `
            <div class="s-row" style="cursor:pointer" onclick='playIptvChannelInPlayer("${esc(c.name).replace(/"/g,"&quot;")}", "${c.url.replace(/"/g,"&quot;")}")'>
              <button onclick='event.stopPropagation(); openSaveToPlaylistPicker({channelId:"${c.id}"})' title="Spara till..." style="background:none;border:none;color:${c.inAnyPlaylist ? "var(--accent)" : "var(--muted)"};font-size:16px;cursor:pointer;margin-right:10px">${c.inAnyPlaylist ? "⭐" : "💾"}</button>
              ${c.logo ? `<img src="${c.logo}" style="width:32px;height:32px;object-fit:contain;border-radius:4px;margin-right:10px" onerror="this.style.display='none'">` : `<span style="margin-right:10px">${type === "movie" ? "🎬" : type === "series" ? "🎞️" : "📺"}</span>`}
              <span style="flex:1">${esc(c.name)}</span>
            </div>`).join("")}
        </div>
      </div>`;
  } catch(e) {
    sec.innerHTML = `<p style="color:var(--danger)">Fel: ${esc(e.message)}</p>`;
  }
}

// Loads HLS.js from CDN on first use — most IPTV streams are HLS (.m3u8), which only Safari
// plays natively; every other browser needs this library to decode the stream into
// something a plain <video> element can actually show.
let _hlsJsLoading = null;
function ensureHlsJs() {
  if (window.Hls) return Promise.resolve();
  if (_hlsJsLoading) return _hlsJsLoading;
  _hlsJsLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.15/hls.min.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Kunde inte ladda HLS-spelaren"));
    document.head.appendChild(script);
  });
  return _hlsJsLoading;
}

async function saveIptvEnabledToggle(enabled) {
  try {
    await API.patch("/config", { iptv_enabled: enabled });
    window._iptvEnabled = enabled;
    const sbEl = document.getElementById("sb-iptv");
    if (sbEl) sbEl.style.display = enabled ? "" : "none";
    toast(enabled ? "✓ IPTV aktiverat — syns nu i sidopanelen" : "IPTV avstängt — döljs i sidopanelen", "success");
  } catch(e) {
    toast("Fel: " + e.message, "error");
    const el = document.getElementById("iptv-enabled-toggle");
    if (el) el.checked = !enabled;
  }
}

async function parseIptvPlaylist() {
  const url = document.getElementById("iptv-url-input")?.value.trim();
  const statusEl = document.getElementById("iptv-status");
  if (!url) { toast("Ange en adress först", "info"); return; }
  if (statusEl) statusEl.textContent = "⏳ Hämtar och tolkar (kan ta en stund för stora listor)...";
  try {
    const data = await API.post("/iptv/parse", { url });
    if (statusEl) statusEl.textContent = `✓ ${data.count} kanaler hittades och sparades`;
    toast(`✓ ${data.count} kanaler tolkade`, "success");
  } catch(e) {
    if (statusEl) statusEl.textContent = "";
    toast("Fel: " + e.message, "error");
  }
}

// ── EXPLORE ───────────────────────────────────────────────────────────────────
let _exploreState = { mediaType: "movie", category: "popular", genre: "", year: "", page: 1 };
let _movieGenres = null;
let _tvGenres = null;
const EXPLORE_MOVIE_CATEGORIES = [["popular","explore.cat_popular"],["top_rated","explore.cat_top_rated"],["now_playing","explore.cat_now_playing"],["upcoming","explore.cat_upcoming"]];
const EXPLORE_TV_CATEGORIES = [["popular","explore.cat_popular"],["top_rated","explore.cat_top_rated"],["on_the_air","explore.cat_on_the_air"],["airing_today","explore.cat_airing_today"]];

async function loadExplore() {
  const sec = document.getElementById("sec-explore");
  if (!sec) return;
  await ensureExploreGenres();
  renderExploreShell(sec);
  loadExploreResults();
}

// Two dedicated sidebar entries (Filmtrailers / Serietrailers) instead of one combined page
// with just a toggle — same underlying page either way, just pre-set to the right type and
// given its own URL so each is directly linkable/bookmarkable on its own.
function openExploreMovies(fromRouter) {
  _exploreState.mediaType = "movie";
  _exploreState.category = "popular";
  _exploreState.genre = ""; _exploreState.year = ""; _exploreState.page = 1;
  switchSection("explore", true);
  if (!fromRouter) navigateToPath("/utforska-filmer", "Utforska Filmtrailers - StreamVault");
  document.querySelectorAll(".sb-item").forEach(b => b.classList.remove("active"));
  document.getElementById("sb-explore-movie")?.classList.add("active");
}
function openExploreTV(fromRouter) {
  _exploreState.mediaType = "tv";
  _exploreState.category = "popular";
  _exploreState.genre = ""; _exploreState.year = ""; _exploreState.page = 1;
  switchSection("explore", true);
  if (!fromRouter) navigateToPath("/utforska-serier", "Utforska Serietrailers - StreamVault");
  document.querySelectorAll(".sb-item").forEach(b => b.classList.remove("active"));
  document.getElementById("sb-explore-tv")?.classList.add("active");
}

async function ensureExploreGenres() {
  if (_exploreState.mediaType === "movie" && !_movieGenres) {
    try { _movieGenres = (await API.get("/genres/movie")).genres || []; } catch(e) { _movieGenres = []; }
  } else if (_exploreState.mediaType === "tv" && !_tvGenres) {
    try { _tvGenres = (await API.get("/genres/tv")).genres || []; } catch(e) { _tvGenres = []; }
  }
}

function renderExploreShell(sec) {
  const currentYear = new Date().getFullYear();
  const categories = _exploreState.mediaType === "tv" ? EXPLORE_TV_CATEGORIES : EXPLORE_MOVIE_CATEGORIES;
  const genres = _exploreState.mediaType === "tv" ? (_tvGenres||[]) : (_movieGenres||[]);
  sec.innerHTML = `
    <div class="grid-wrap">
      <h2 style="margin-bottom:14px">${t("explore.title")}</h2>
      <div style="display:flex;gap:6px;margin-bottom:12px">
        <button class="btn-fav" id="explore-type-movie" onclick="setExploreMediaType('movie')" style="${_exploreState.mediaType==='movie'?"background:var(--accent);color:#fff":""}">${t("explore.movies_tab")}</button>
        <button class="btn-fav" id="explore-type-tv" onclick="setExploreMediaType('tv')" style="${_exploreState.mediaType==='tv'?"background:var(--accent);color:#fff":""}">${t("explore.tv_tab")}</button>
      </div>
      <div class="filter-bar" style="flex-wrap:wrap;gap:8px">
        <div style="display:flex;gap:6px;flex-wrap:wrap" id="explore-category-tabs">
          ${categories.map(([key,labelKey]) => `
            <button class="btn-fav explore-cat-btn" data-cat="${key}" onclick="setExploreCategory('${key}')" style="${_exploreState.category===key?"background:var(--accent);color:#fff":""}">${t(labelKey)}</button>
          `).join("")}
        </div>
        <select class="filter-select" id="explore-genre" onchange="setExploreGenre(this.value)">
          <option value="">${t("explore.all_genres")}</option>
          ${genres.map(g => `<option value="${g.id}" ${String(_exploreState.genre)===String(g.id)?"selected":""}>${esc(g.name)}</option>`).join("")}
        </select>
        <select class="filter-select" id="explore-year" onchange="setExploreYear(this.value)">
          <option value="">${t("explore.all_years")}</option>
          ${Array.from({length: currentYear-1919}, (_,i) => currentYear-i).map(y => `<option value="${y}" ${String(_exploreState.year)===String(y)?"selected":""}>${y}</option>`).join("")}
        </select>
      </div>
      <div class="media-grid" id="explore-grid">
        <div class="spinner-wrap"><div class="spinner"></div></div>
      </div>
      <div style="text-align:center;margin-top:20px;display:flex;align-items:center;justify-content:center;gap:8px" id="explore-pagination"></div>
    </div>`;
}

async function setExploreMediaType(type) {
  if (_exploreState.mediaType === type) return;
  _exploreState.mediaType = type;
  _exploreState.category = "popular";
  _exploreState.genre = "";
  _exploreState.year = "";
  _exploreState.page = 1;
  const sec = document.getElementById("sec-explore");
  await ensureExploreGenres();
  renderExploreShell(sec);
  loadExploreResults();
}

function setExploreCategory(cat) {
  _exploreState.category = cat;
  _exploreState.page = 1;
  document.querySelectorAll(".explore-cat-btn").forEach(b => {
    b.style.background = b.getAttribute("data-cat") === cat ? "var(--accent)" : "";
    b.style.color = b.getAttribute("data-cat") === cat ? "#fff" : "";
  });
  loadExploreResults();
}
function setExploreGenre(genre) { _exploreState.genre = genre; _exploreState.page = 1; loadExploreResults(); }
function setExploreYear(year) { _exploreState.year = year; _exploreState.page = 1; loadExploreResults(); }
function setExplorePage(page) { if (page < 1) return; _exploreState.page = page; loadExploreResults(); document.getElementById("sec-explore")?.scrollIntoView({block:"start"}); }

async function loadExploreResults() {
  const grid = document.getElementById("explore-grid");
  const pagination = document.getElementById("explore-pagination");
  if (!grid) return;
  grid.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const endpoint = _exploreState.mediaType === "tv" ? "/explore/tvshows" : "/explore/movies";
    const params = new URLSearchParams({ category: _exploreState.category, page: _exploreState.page });
    if (_exploreState.genre) params.set("genre", _exploreState.genre);
    if (_exploreState.year) params.set("year", _exploreState.year);
    const data = await API.get(endpoint + "?" + params.toString());
    grid.innerHTML = data.items.length
      ? data.items.map(item => buildExploreCard(item, _exploreState.mediaType)).join("")
      : `<p style="color:var(--muted)">${t("explore.no_results")}</p>`;
    if (pagination) {
      const totalPages = Math.min(data.totalPages || 1, 500); // TMDB itself caps at 500 pages
      pagination.innerHTML = `
        <button class="btn-fav" ${_exploreState.page<=1?"disabled":""} onclick="setExplorePage(${_exploreState.page-1})">${t("explore.prev")}</button>
        <span style="color:var(--muted);font-size:13px">${t("explore.page_of").replace("{page}", data.page).replace("{total}", totalPages)}</span>
        <button class="btn-fav" ${_exploreState.page>=totalPages?"disabled":""} onclick="setExplorePage(${_exploreState.page+1})">${t("explore.next")}</button>`;
    }
  } catch(e) {
    grid.innerHTML = `<p style="color:var(--danger)">Fel: ${esc(e.message)}</p>`;
  }
}

function buildExploreCard(item, mediaType) {
  const clickFn = item.owned
    ? (mediaType === "tv" ? `openShowDetail("${item.id}")` : `openDetail("${item.id}")`)
    : `openTmdbDetail(${item.tmdb_id}, "${mediaType}")`;
  return `<div class="mcard" onclick='${clickFn}'>
    <div style="position:relative">
      ${item.poster_url
        ? `<img class="mcard-poster" src="${item.poster_url}" alt="" loading="lazy">`
        : `<div class="mcard-poster-ph"><span>${mediaType==="tv"?"📺":"🎬"}</span><span>${esc((item.title||"").slice(0,14))}</span></div>`}
      <div class="mcard-overlay"><span class="mcard-play">▶</span></div>
      ${item.owned ? `<div style="position:absolute;top:6px;right:6px;background:#2ecc71;color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;font-weight:600">${t("detail.in_library")}</div>` : ""}
    </div>
    <div class="mcard-info">
      <div class="mcard-title">${esc(item.title||"")}</div>
      <div class="mcard-meta">${item.rating ? "⭐ "+item.rating.toFixed(1)+" · " : ""}${item.year||""}</div>
    </div>
  </div>`;
}

function clientSlugify(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "bibliotek";
}

function switchToLibrary(libId, libName, libType, fromRouter) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".sb-item").forEach(b => b.classList.remove("active"));
  const sec = document.getElementById("sec-library");
  if (sec) sec.classList.add("active");
  const sbEl = document.getElementById("sb-lib-" + libId);
  if (sbEl) sbEl.classList.add("active");
  loadLibraryView(libId, libName, libType);
  if (!fromRouter) navigateToPath(`/${clientSlugify(libName)}`, libName + " - StreamVault");
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
    <div class="cast-scroll" id="${scrollId}" style="gap:22px !important">
      ${cast.map(p => `
        <div class="cast-card" onclick="openPersonDetail(${p.id})" style="min-width:110px !important;flex-shrink:0">
          ${p.profile_url ? `<img class="cast-photo" src="${p.profile_url}" alt="" loading="lazy" style="width:90px !important;height:90px !important">` : `<div class="cast-photo-ph" style="width:90px !important;height:90px !important">👤</div>`}
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

// Data-only fetch (no DOM rendering) — used as a fallback by openCollection() when opened
// directly via a bookmarked/shared link, since the Samlingar list page's own fetch (which
// normally populates this) never ran in that case.
async function loadCollectionsData() {
  const collections = await API.get("/collections");
  window._collectionsData = collections;
  return collections;
}

async function loadCollections() {
  const sec = document.getElementById("sec-collections");
  sec.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const collections = await API.get("/collections");
    if (!collections.length) {
      sec.innerHTML = `<div class="empty"><div class="empty-icon">🎬</div><h3>${t("collections.none_found")}</h3><p>${t("collections.rescan_hint")}</p></div>`;
      return;
    }
    const genreSet = new Set();
    collections.forEach(c => c.movies.forEach(m => (m.genres || []).forEach(g => genreSet.add(g))));
    const sortedGenres = [...genreSet].sort((a, b) => a.localeCompare(b));
    sec.innerHTML = `
      <div class="grid-wrap" style="padding-right:32px">
        <div class="row-header" style="margin-bottom:20px">
          <span class="row-title">${t("sidebar.collections")}</span>
          <div style="display:flex;align-items:center;gap:12px">
  <select class="filter-select" id="coll-filter-genre" onchange="filterCollections()">
    <option value="">${t("filter.all_genres")}</option>
    ${sortedGenres.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join("")}
  </select>
  <span class="row-count" id="coll-count">${collections.length} ${t("collections.count_label")}</span>
  ${currentUser?.role === "admin" ? `<button class="s-btn s-btn-primary" onclick="createCollection()" style="padding:6px 14px;font-size:13px">➕ ${t("collections.new")}</button>` : ""}
</div>
        </div>
        <div class="media-grid" id="lib-grid">
          ${collections.map(c => buildCollectionCard(c)).join("")}
        </div>
      </div>
      ${buildAbcNav(collections.map(c => ({ title: c.name })))}`;
    // Store for openCollection and the genre filter
    window._collectionsData = collections;
  } catch(e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>${e.message}</h3></div>`;
  }
}

function buildCollectionCard(c) {
  return `
    <div class="mcard" onclick="openCollection('${c.id}')">
      <div style="position:relative">
        ${c.poster_url
          ? `<img class="mcard-poster" src="${c.poster_url}" alt="" loading="lazy">`
          : `<div class="mcard-poster-ph"><span>🎬</span><span>${esc((c.name||"").slice(0,14))}</span></div>`}
        <div class="mcard-overlay"><span class="mcard-play">▶</span></div>
      </div>
      <div class="mcard-info">
        <div class="mcard-title">${esc(c.name||"")}</div>
        <div class="mcard-meta">${c.movies.length} ${t("collections.movie_count")}</div>
      </div>
    </div>`;
}

function filterCollections() {
  const genre = document.getElementById("coll-filter-genre")?.value || "";
  const all = window._collectionsData || [];
  const filtered = genre ? all.filter(c => c.movies.some(m => (m.genres || []).includes(genre))) : all;
  document.getElementById("lib-grid").innerHTML = filtered.length
    ? filtered.map(c => buildCollectionCard(c)).join("")
    : `<div style="color:var(--muted);font-size:14px;padding:20px 0">${t("collections.no_results")}</div>`;
  const countEl = document.getElementById("coll-count");
  if (countEl) countEl.textContent = `${filtered.length} ${t("collections.count_label")}`;
}
async function createCollection() {
  const modal = document.createElement("div");
  modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px";
  modal.innerHTML = `
    <div style="background:var(--card);border-radius:16px;padding:28px;width:100%;max-width:500px;display:flex;flex-direction:column;gap:16px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0;font-size:18px">Ny samling</h2>
        <button onclick="this.closest('[style*=fixed]').remove()" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer">✕</button>
      </div>
      <div>
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Namn</label>
        <input id="new-coll-name" type="text" placeholder="t.ex. Johan Falk" style="width:100%;background:var(--card2);border:1px solid var(--border);color:var(--text);font-size:14px;padding:9px 12px;border-radius:8px;outline:none;box-sizing:border-box">
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px">
        <button onclick="this.closest('[style*=fixed]').remove()" style="background:var(--card2);border:1px solid var(--border);color:var(--text);padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px">Avbryt</button>
        <button onclick="saveNewCollection()" style="background:var(--accent);border:none;color:white;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600">➕ Skapa</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  setTimeout(() => document.getElementById("new-coll-name")?.focus(), 100);
}

async function saveNewCollection() {
  const name = document.getElementById("new-coll-name")?.value?.trim();
  if (!name) { toast("Ange ett namn!", "error"); return; }
  document.querySelector("[style*=fixed]")?.remove();
  openNewCollectionEditor(name);
}

async function openNewCollectionEditor(name) {
  let allMovies = [];
  try { allMovies = (await API.get("/media?type=movie&limit=9999")).items || []; } catch {}
  window._collEditMovies = allMovies.sort((a,b) => (a.title||"").localeCompare(b.title||""));
  window._collEditLinkedIds = new Set();
  window._newCollectionName = name;
  const modal = document.createElement("div");
  modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px";
  modal.innerHTML = `
    <div style="background:var(--card);border-radius:16px;padding:28px;width:100%;max-width:600px;max-height:85vh;overflow-y:auto;display:flex;flex-direction:column;gap:16px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0;font-size:18px">Ny samling – ${esc(name)}</h2>
        <button onclick="this.closest('[style*=fixed]').remove()" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer">✕</button>
      </div>
      <div>
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:6px">Lägg till filmer</label>
        <input id="coll-movie-search" type="text" placeholder="Sök film..." oninput="filterCollectionMovies()" style="width:100%;background:var(--card2);border:1px solid var(--border);color:var(--text);font-size:13px;padding:8px 12px;border-radius:8px;outline:none;box-sizing:border-box;margin-bottom:8px">
        <div id="coll-edit-movies" style="display:flex;flex-direction:column;gap:4px;max-height:300px;overflow-y:auto">
          <div style="font-size:12px;color:var(--muted);padding:8px">Sök för att hitta filmer att lägga till.</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px">
        <button onclick="this.closest('[style*=fixed]').remove()" style="background:var(--card2);border:1px solid var(--border);color:var(--text);padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px">Avbryt</button>
        <button onclick="saveNewCollectionWithMovies()" style="background:var(--accent);border:none;color:white;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600">💾 Spara samling</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function saveNewCollectionWithMovies() {
  const name = window._newCollectionName;
  const movieIds = Array.from(window._collEditLinkedIds || []);
  if (!movieIds.length) { toast("Lägg till minst en film!", "error"); return; }
  try {
    const collId = 9000000 + Date.now() % 1000000;
    await API.patch("/collections/" + collId, { name, movie_ids: movieIds });
    toast("✓ Samling skapad!", "success");
    document.querySelector("[style*=fixed]")?.remove();
    const fresh = await API.get("/collections");
    window._collectionsData = Array.isArray(fresh) ? fresh : [];
    switchSection("collections");
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}
async function editCollection(collectionId) {
  const collection = window._collectionsData?.find(c => String(c.id) === String(collectionId));
  if (!collection) return;

  // Fetch all movies for linking
  let allMovies = [];
  try { allMovies = (await API.get("/media?type=movie&limit=9999")).items || []; } catch {}

  // Get locally linked movies by collection_id
  const linkedMovies = allMovies.filter(m => String(m.collection_id) === String(collectionId));
  window._collEditMovies = allMovies.sort((a,b) => (a.title||"").localeCompare(b.title||""));
  window._collEditLinkedIds = new Set(linkedMovies.map(m => m._id || m.id));

  const modal = document.createElement("div");
  modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px";
  modal.innerHTML = `
    <div style="background:var(--card);border-radius:16px;padding:28px;width:100%;max-width:600px;max-height:85vh;overflow-y:auto;display:flex;flex-direction:column;gap:16px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0;font-size:18px">Redigera samling</h2>
        <button onclick="this.closest('[style*=fixed]').remove()" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer">✕</button>
      </div>

      <div>
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Namn</label>
        <input id="coll-edit-name" type="text" value="${esc(collection.name||"")}" style="width:100%;background:var(--card2);border:1px solid var(--border);color:var(--text);font-size:14px;padding:9px 12px;border-radius:8px;outline:none;box-sizing:border-box">
      </div>

      <div style="display:flex;gap:16px">
        <div style="flex:1">
          <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:6px">Poster</label>
          <div style="position:relative;width:120px">
            <img id="coll-poster-preview" src="${collection.poster_url||''}" style="width:120px;height:180px;object-fit:cover;border-radius:8px;background:var(--card2);display:${collection.poster_url?'block':'none'}">
            <div id="coll-poster-ph" style="width:120px;height:180px;background:var(--card2);border-radius:8px;display:${collection.poster_url?'none':'flex'};align-items:center;justify-content:center;font-size:32px">🎬</div>
            <div style="display:flex;gap:4px;margin-top:6px">
              <button onclick="browseCollectionImages('${collectionId}','poster',-1)" style="flex:1;background:var(--card2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px;cursor:pointer;font-size:12px">◀</button>
              <button onclick="browseCollectionImages('${collectionId}','poster',1)" style="flex:1;background:var(--card2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px;cursor:pointer;font-size:12px">▶</button>
            </div>
          </div>
          <input id="coll-edit-poster" type="hidden" value="${esc(collection.poster_url||'')}">
        </div>
        <div style="flex:2">
          <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:6px">Bakgrundsbild</label>
          <img id="coll-backdrop-preview" src="${collection.backdrop_url||''}" style="width:100%;height:120px;object-fit:cover;border-radius:8px;background:var(--card2);display:${collection.backdrop_url?'block':'none'}">
          <div id="coll-backdrop-ph" style="width:100%;height:120px;background:var(--card2);border-radius:8px;display:${collection.backdrop_url?'none':'flex'};align-items:center;justify-content:center;font-size:32px">🖼️</div>
          <div style="display:flex;gap:4px;margin-top:6px">
            <button onclick="browseCollectionImages('${collectionId}','backdrop',-1)" style="flex:1;background:var(--card2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px;cursor:pointer;font-size:12px">◀ Föregående</button>
            <button onclick="browseCollectionImages('${collectionId}','backdrop',1)" style="flex:1;background:var(--card2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px;cursor:pointer;font-size:12px">Nästa ▶</button>
          </div>
          <input id="coll-edit-backdrop" type="hidden" value="${esc(collection.backdrop_url||'')}">
        </div>
      </div>

      <div>
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:6px">Filmer i samlingen</label>
        <input id="coll-movie-search" type="text" placeholder="Sök film..." oninput="filterCollectionMovies()" style="width:100%;background:var(--card2);border:1px solid var(--border);color:var(--text);font-size:13px;padding:8px 12px;border-radius:8px;outline:none;box-sizing:border-box;margin-bottom:8px">
        <div id="coll-edit-movies" style="display:flex;flex-direction:column;gap:4px;max-height:220px;overflow-y:auto"></div>
      </div>

      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px">
        <button onclick="this.closest('[style*=fixed]').remove()" style="background:var(--card2);border:1px solid var(--border);color:var(--text);padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px">Avbryt</button>
        <button onclick="saveCollectionEdit('${collectionId}')" style="background:var(--accent);border:none;color:white;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600">💾 Spara</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Initial render - show only linked movies + search results
  renderCollectionMovieList("");
}

function renderCollectionMovieList(query) {
  const container = document.getElementById("coll-edit-movies");
  if (!container) return;
  const movies = window._collEditMovies || [];
  const linkedIds = window._collEditLinkedIds || new Set();
  const q = (query || "").toLowerCase().trim();
  const getId = m => m._id || m.id;

  let toShow = [];
  if (!q) {
    // No search - only show linked movies
    toShow = movies.filter(m => linkedIds.has(getId(m)));
    if (toShow.length === 0) {
      container.innerHTML = "<div style='font-size:12px;color:var(--muted);padding:8px'>Inga filmer länkade. Sök för att lägga till.</div>";
      return;
    }
  } else {
    // Search - show matching movies (max 30) + always show linked
    const linked = movies.filter(m => linkedIds.has(getId(m)));
    const matching = movies.filter(m => !linkedIds.has(getId(m)) && (m.title||"").toLowerCase().includes(q)).slice(0, 30);
    toShow = [...linked, ...matching];
  }

  container.innerHTML = toShow.map(m => {
    const isLinked = linkedIds.has(getId(m));
    const mid = getId(m);
    return `<label style="display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px;cursor:pointer;background:var(--card2)">
      <input type="checkbox" data-movie-id="${mid}" ${isLinked ? "checked" : ""} style="width:16px;height:16px;cursor:pointer" onchange="toggleCollectionMovie('${mid}', this.checked)">
      <span style="font-size:13px">${esc(m.title||"")} ${m.year ? '<span style="color:var(--muted)">('+m.year+')</span>' : ""}</span>
    </label>`;
  }).join("");
}

function toggleCollectionMovie(movieId, checked) {
  if (!window._collEditLinkedIds) window._collEditLinkedIds = new Set();
  if (checked) window._collEditLinkedIds.add(movieId);
  else window._collEditLinkedIds.delete(movieId);
}

// Collection image browsing
let _collImages = { poster: [], backdrop: [], posterIdx: 0, backdropIdx: 0, loadedFor: null };

async function browseCollectionImages(collectionId, type, direction) {
  // Reset if different collection
  if (_collImages.loadedFor !== collectionId) {
    _collImages = { poster: [], backdrop: [], posterIdx: 0, backdropIdx: 0, loadedFor: collectionId };
  }
  // Load images if not loaded yet
  if (_collImages[type].length === 0) {
    try {
      const data = await API.get("/tmdb/collection-images?id=" + collectionId);
      _collImages.poster = (data.posters || []).map(p => "https://image.tmdb.org/t/p/w500" + p.file_path);
      _collImages.backdrop = (data.backdrops || []).map(b => "https://image.tmdb.org/t/p/w1280" + b.file_path);
      _collImages.posterIdx = 0;
      _collImages.backdropIdx = 0;
    } catch(e) {
      toast("Kunde inte hämta bilder från TMDB", "error");
      return;
    }
  }

  const images = _collImages[type];
  if (!images.length) { toast("Inga bilder hittades", "info"); return; }

  const idxKey = type + "Idx";
  _collImages[idxKey] = (_collImages[idxKey] + direction + images.length) % images.length;
  const url = images[_collImages[idxKey]];

  // Update preview
  const preview = document.getElementById("coll-" + (type === "poster" ? "poster" : "backdrop") + "-preview");
  const ph = document.getElementById("coll-" + (type === "poster" ? "poster" : "backdrop") + "-ph");
  const input = document.getElementById("coll-edit-" + (type === "poster" ? "poster" : "backdrop"));
  if (preview) { preview.src = url; preview.style.display = "block"; }
  if (ph) ph.style.display = "none";
  if (input) input.value = url;
}

function filterCollectionMovies() {
  const q = document.getElementById("coll-movie-search")?.value || "";
  renderCollectionMovieList(q);
}

async function saveCollectionEdit(collectionId) {
  const name = document.getElementById("coll-edit-name")?.value?.trim();
  const poster_url = document.getElementById("coll-edit-poster")?.value?.trim();
  const backdrop_url = document.getElementById("coll-edit-backdrop")?.value?.trim();
  const movieIds = Array.from(window._collEditLinkedIds || []);

  try {
    await API.patch("/collections/" + collectionId, { name, poster_url, backdrop_url, movie_ids: movieIds });
    toast("✓ Samling sparad!", "success");
    document.querySelector("[style*=fixed]")?.remove();
    // Reload collections data and re-open collection
    const fresh = await API.get("/collections");
    window._collectionsData = Array.isArray(fresh) ? fresh : (fresh.collections || []);
    await openCollection(collectionId);
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

async function openCollection(collectionId, fromRouter) {
  if (!window._collectionsData) {
    // Opened directly (bookmark/shared link) rather than via the Samlingar list page —
    // that list's data was never fetched, so fetch it now before looking up this collection.
    try { await loadCollectionsData(); } catch {}
  }
  const collection = window._collectionsData?.find(c => String(c.id) === String(collectionId));
  if (!collection) return;
  if (!fromRouter) navigateToPath(`/samlingar/${clientSlugify(collection.name)}-${collectionId}`, collection.name + " - StreamVault");
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
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:4px">
          <h3 class="detail-section-title" style="margin:0">${t("collections.in_library_heading").replace("{count}", inLib.length)}</h3>
          <select class="filter-select" id="collection-filter-sublang" onchange="filterCollectionBySubLang()" title="${t("filter.subtitle_tooltip")}" style="font-size:12px">
            <option value="">🔤 ${t("filter.all_subtitle_langs")}</option>
            ${Object.keys(SUBTITLE_LANG_ADJ).filter(l => l !== "und").map(l => `<option value="${l}">${esc(SUBTITLE_LANG_ADJ[l])}</option>`).join("")}
          </select>
        </div>
        <div class="media-grid" id="collection-movies-grid" data-items='${esc(JSON.stringify(localMovies.map(m => ({ id: m.id, title: m.title, year: m.year, rating: m.rating, poster_url: m.poster_url, type: m.type, cached_subtitle_langs: m.cached_subtitle_langs || [] }))))}'>
          ${localMovies.map(m => buildCard(m)).join("")}
        </div>
      </div>`;
    }

    if (missing.length) {
      filmsHtml += `<div class="detail-section">
        <h3 class="detail-section-title">${t("collections.missing_heading").replace("{count}", missing.length)}</h3>
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
        <button class="detail-back" onclick="history.back()">← Tillbaka</button>
        <div class="show-hero-content">
          <div class="detail-poster-col">
            ${collection.poster_url ? `<img class="detail-poster" src="${collection.poster_url}" alt="">` : `<div class="detail-poster-ph">🎬</div>`}
          </div>
          <div class="detail-info-col">
            <h1 class="detail-page-title">${esc(collection.name||"")}</h1>
            <div class="detail-meta-row">
              <span class="detail-meta-item">${t("collections.x_of_y_in_library").replace("{have}", localMovies.length).replace("{total}", allParts?.parts?.length||localMovies.length)}</span>
            </div>
            <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
              ${currentUser?.role === "admin" ? `<button class="s-btn s-btn-primary" onclick="editCollection('${collectionId}')">${t("collections.edit")}</button>` : ""}
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
    const genreSet = new Set();
    items.forEach(i => (i.genres || []).forEach(g => genreSet.add(g)));
    const sortedGenres = [...genreSet].sort((a, b) => a.localeCompare(b));
    sec.innerHTML = `
      <div class="grid-wrap" style="padding-right:32px">
        <div class="filter-bar">
          <h2 style="font-size:22px;font-weight:700;margin:0;flex:1">${esc(libName)}</h2>
          <input class="filter-input" type="text" placeholder="${t("filter.search_in").replace("{name}", esc(libName))}" id="lib-filter-q" oninput="filterLibraryView()"/>
          <select class="filter-select" id="lib-filter-sort" onchange="onLibrarySortChange()">
            <option value="title">${t("filter.sort_az")}</option>
            <option value="year">${t("filter.sort_year")}</option>
            <option value="rating">${t("filter.sort_rating")}</option>
            <option value="genre">${t("filter.sort_genre")}</option>
          </select>
          <select class="filter-select" id="lib-filter-genre" onchange="filterLibraryView()" style="display:none">
            <option value="">${t("filter.all_genres")}</option>
            ${sortedGenres.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join("")}
          </select>
          <select class="filter-select" id="lib-filter-sublang" onchange="filterLibraryView()" title="${t("filter.subtitle_tooltip")}">
            <option value="">🔤 ${t("filter.all_subtitle_langs")}</option>
            ${Object.keys(SUBTITLE_LANG_ADJ).filter(l => l !== "und").map(l => `<option value="${l}">${esc(SUBTITLE_LANG_ADJ[l])}</option>`).join("")}
          </select>
        </div>
        <div class="media-grid" id="lib-grid">
          ${items.length ? items.map(i => buildCard(i)).join("") : `<div class="empty"><div class="empty-icon">📭</div><h3>${t("filter.empty_library")}</h3></div>`}
        </div>
      </div>
      ${buildAbcNav(items)}`;
    sec.dataset.items = JSON.stringify(items);
  } catch(e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>Kunde inte ladda</h3><p>${e.message}</p></div>`;
  }
}

// Builds a single episode's poster card — extracted so both the initial season render and
// the subtitle-language filter's re-render use identical markup.
function buildEpisodeCard(ep, showId, showTitle, seasonNum) {
  const label = `S${String(seasonNum).padStart(2,"0")} E${String(ep.episode||0).padStart(2,"0")}`;
  return `<div class="mcard" onclick='openEpisodeDetail("${ep.id}")'>
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
}

function filterSeasonBySubLang() {
  const grid = document.getElementById("season-episodes-grid");
  if (!grid) return;
  const subLang = document.getElementById("season-filter-sublang")?.value || "";
  const showId = grid.getAttribute("data-show-id");
  const showTitle = grid.getAttribute("data-show-title");
  const seasonNum = grid.getAttribute("data-season");
  let items = JSON.parse(grid.getAttribute("data-items") || "[]");
  if (subLang) items = items.filter(ep => (ep.cached_subtitle_langs || []).includes(subLang));
  grid.innerHTML = items.length
    ? items.map(ep => buildEpisodeCard(ep, showId, showTitle, seasonNum)).join("")
    : '<div style="color:var(--muted);font-size:14px;padding:20px 0">Inga avsnitt hittades med det språket</div>';
}

// Plex-style episode detail page — shown when clicking an episode instead of playing
// immediately, so file info/watched-state/subtitles can be checked or changed first, same
// set of actions the movie detail page already has. Looks up the episode from the season
// page's already-fetched data (no redundant round-trip) when available, falling back to a
// fresh fetch if opened some other way.
async function openEpisodeDetail(episodeId, fromRouter) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  const sec = document.getElementById("sec-detail");
  sec.classList.add("active");
  sec.innerHTML = `<div class="spinner-wrap" style="height:60vh"><div class="spinner"></div></div>`;
  try {
    let ep = (window._currentSeasonEpisodes || []).find(e => e.id === episodeId);
    let showId = window._currentSeasonShowId;
    let showTitle = window._currentSeasonShowTitle || "";
    let showSlug = null;
    if (!ep) {
      // Opened directly (e.g. a bookmark/refresh) rather than from the season page — fetch
      // fresh, including the parent show's info (needed for both the title shown here and
      // the URL, since none of the season page's data was ever loaded in this case).
      ep = await API.get("/media/" + episodeId);
      showId = ep.parent_id;
      if (showId) {
        try {
          const show = await API.get("/media/" + showId);
          showTitle = show.title; showSlug = show.slug;
        } catch {}
      }
    }
    const seasonNum = ep?.season || window._currentSeasonNum;
    if (!fromRouter) {
      const slugForUrl = showSlug || (window._currentSeasonShowSlug);
      if (slugForUrl) { const w = seasonEpisodeWords(); navigateToPath(`/serier/${slugForUrl}/${w.season}/${seasonNum}/${w.episode}/${ep.episode||0}`, `${showTitle} - ${ep.title||"Avsnitt "+ep.episode}`); }
    }
    const progress = await API.get("/media/" + episodeId + "/progress").catch(() => ({}));
    const label = `S${String(seasonNum||0).padStart(2,"0")} E${String(ep.episode||0).padStart(2,"0")}`;
    const pct = progress?.duration ? Math.round((progress.position / progress.duration) * 100) : 0;
    const watchedMin = Math.floor((progress?.position || 0) / 60);
    const watchedLabel = watchedMin >= 60 ? `${Math.floor(watchedMin/60)}h ${watchedMin%60}m` : `${watchedMin}m`;
    const playLabel = pct > 5 && pct < 95 ? `▶ Fortsätt (${watchedLabel})` : "▶ Spela";

    sec.innerHTML = `
      <div class="detail-page">
        <div class="person-hero" style="padding-top:20px">
          <button onclick="history.back()" style="background:var(--card2, #1a1a28);color:var(--text, #fff);border:1px solid var(--border, #333);padding:8px 16px;border-radius:8px;cursor:pointer;font-size:14px;display:inline-block;margin-bottom:20px">← Tillbaka</button>
          <div class="person-info">
            ${ep.still_url
              ? `<img class="person-photo" src="${ep.still_url}" alt="" style="width:220px;aspect-ratio:16/9;border-radius:8px;object-fit:cover">`
              : `<div class="person-photo-ph" style="width:220px;aspect-ratio:16/9">📺</div>`}
            <div>
              <div class="detail-meta-row" style="margin-bottom:4px">
                <span class="detail-meta-item">${esc(label)}</span>
              </div>
              <h1 class="detail-page-title">${esc(ep.title || "Avsnitt " + ep.episode)}</h1>
              <div class="detail-meta-row">
                ${ep.air_date ? `<span class="detail-meta-item">${esc(ep.air_date)}</span>` : ""}
                ${ep.runtime ? `<span class="detail-meta-item">${ep.runtime} min</span>` : ""}
                ${ep.rating ? `<span class="detail-meta-item">⭐ ${ep.rating.toFixed(1)}</span>` : ""}
              </div>
              ${ep.overview ? `<p class="person-bio" style="max-width:600px">${esc(ep.overview)}</p>` : ""}
              <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
                <button class="btn-play" onclick='playEpisode("${ep.id}","${esc(showTitle)}","${showId}",${seasonNum},${ep.episode||0})'>${playLabel}</button>
                <button class="btn-fav" onclick='openSubtitles("${ep.id}","${esc(showTitle)} · ${esc(label)}")'>🔤 Undertexter</button>
                ${currentUser?.role === "admin" ? `<button class="btn-fav" onclick='openMediaInfo("${ep.id}")'>ℹ Filinfo</button>` : ""}
                ${progress?.completed
                  ? `<button class="btn-fav" id="watched-btn-${ep.id}" onclick="markUnwatched('${ep.id}')">↺ Osedd</button>`
                  : `<button class="btn-fav" id="watched-btn-${ep.id}" onclick="markWatched('${ep.id}', ${Math.floor(progress?.duration||0)})">✓ Sedd</button>`}
              </div>
            </div>
          </div>
        </div>
        ${(window._currentSeasonCast || []).length ? `<div class="detail-content">
          <div class="detail-section">
            <h3 class="detail-section-title">${t("detail.cast")}</h3>
            ${buildCastScroll(window._currentSeasonCast, `cast-ep-${ep.id}`)}
          </div>
        </div>` : ""}
      </div>`;
  } catch(e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>${e.message}</h3></div>`;
  }
}

function filterCollectionBySubLang() {
  const grid = document.getElementById("collection-movies-grid");
  if (!grid) return;
  const subLang = document.getElementById("collection-filter-sublang")?.value || "";
  let items = JSON.parse(grid.getAttribute("data-items") || "[]");
  if (subLang) items = items.filter(m => (m.cached_subtitle_langs || []).includes(subLang));
  grid.innerHTML = items.length
    ? items.map(i => buildCard(i)).join("")
    : '<div style="color:var(--muted);font-size:14px;padding:20px 0">Inga träffar</div>';
}

function onLibrarySortChange() {
  const sort = document.getElementById("lib-filter-sort")?.value;
  const genreSelect = document.getElementById("lib-filter-genre");
  if (genreSelect) {
    genreSelect.style.display = sort === "genre" ? "inline-block" : "none";
    if (sort !== "genre") genreSelect.value = "";
  }
  filterLibraryView();
}

function filterLibraryView() {
  const sec = document.getElementById("sec-library");
  const q = (document.getElementById("lib-filter-q")?.value || "").toLowerCase();
  const sort = document.getElementById("lib-filter-sort")?.value || "title";
  const genre = document.getElementById("lib-filter-genre")?.value || "";
  const subLang = document.getElementById("lib-filter-sublang")?.value || "";
  let items = JSON.parse(sec.dataset.items || "[]");
  if (q) items = items.filter(m => (m.title||"").toLowerCase().includes(q) || String(m.year||"").includes(q));
  if (genre) items = items.filter(m => (m.genres || []).includes(genre));
  if (subLang) items = items.filter(m => ((m.cached_subtitle_langs && m.cached_subtitle_langs.length ? m.cached_subtitle_langs : m.episode_subtitle_langs) || []).includes(subLang));
  if (sort === "title" || sort === "genre") items.sort((a,b) => (a.title||"").localeCompare(b.title||""));
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
    const [libs, continueW, recentMovies, recentShows, ongoingShows, recs] = await Promise.all([
      API.get("/libraries"),
      API.get("/continue-watching"),
      API.get("/recently-added?type=movie"),
      API.get("/recently-added?type=tvshow"),
      API.get("/ongoing-shows"),
      API.get("/recommendations").catch(() => ({ movies: { items: [] }, tvshows: { items: [] } }))
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
        const heroItem = allMovies[idx];
        // The library-contents list only ever has the STORED overview (scanned once, always
        // in the server's own default language) — unlike the detail page, which does a live,
        // per-user-language fetch. Same fix here, just scoped to the one hero movie instead
        // of the whole list, so this doesn't cost anything for the common case where the
        // user's language already matches the server's.
        const userLang = (currentUser?.language || "").toLowerCase();
        if (userLang && !userLang.startsWith("sv")) {
          try {
            const heroDetails = await API.get(`/media/${heroItem.id}/details`);
            if (heroDetails?.overview) heroItem.overview = heroDetails.overview;
          } catch(e) {}
        }
        html += buildHero(heroItem);
      }
    }

    if (continueW?.length) html += buildRow(t("home.continue_watching"), continueW);
    // Movies and TV shows each get their own independent recommendation row — liking a show
    // no longer silently replaces a movie-based row (or vice versa), since each is generated
    // from that type's own liked titles only.
    html += buildRecommendationRow(recs?.movies, "recs-movies-scroll");
    html += buildRecommendationRow(recs?.tvshows, "recs-tvshows-scroll");
    if (recentMovies?.length) html += buildRow(t("home.recently_added_movies"), recentMovies.slice(0, 16));
    if (recentShows?.length) html += buildRow(t("home.recently_added_shows"), recentShows.slice(0, 16));

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
  const alphaNav = `<div class="abc-nav" id="alpha-nav-${sectionType}">${letters.map(l => 
    `<a onclick="jumpToLetter('${sectionType}','${l}')">${l}</a>`
  ).join("")}</div>`;

    // Fetch all libraries and render each as its own section
    const allItemsForGenres = [];
    let libraryContentsCache = {};
    for (const lib of relevantLibs) {
      const data = await API.get(`/libraries/${lib.id}/contents`);
      libraryContentsCache[lib.id] = data;
      allItemsForGenres.push(...data.items);
    }
    // Genre list built from what's ACTUALLY in this collection, not TMDB's master list — no
    // point offering "Documentary" as a filter option if nothing in the library has it.
    const genreSet = new Set();
    allItemsForGenres.forEach(i => (i.genres || []).forEach(g => genreSet.add(g)));
    const sortedGenres = [...genreSet].sort((a, b) => a.localeCompare(b));

    let html = `<div class="grid-wrap" style="position:relative">
      <div class="filter-bar">
        <input class="filter-input" type="text" placeholder="${t("filter.search")}" id="filter-q-${sectionType}" oninput="filterMediaSection('${sectionType}')"/>
        <select class="filter-select" id="filter-sort-${sectionType}" onchange="onSortChange('${sectionType}')">
          <option value="title">${t("filter.sort_az")}</option>
          <option value="year">${t("filter.sort_year")}</option>
          <option value="rating">${t("filter.sort_rating")}</option>
          <option value="genre">${t("filter.sort_genre")}</option>
        </select>
        <select class="filter-select" id="filter-genre-${sectionType}" onchange="filterMediaSection('${sectionType}')" style="display:none">
          <option value="">${t("filter.all_genres")}</option>
          ${sortedGenres.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join("")}
        </select>
        <select class="filter-select" id="filter-sublang-${sectionType}" onchange="filterMediaSection('${sectionType}')" title="${t("filter.subtitle_tooltip")}">
          <option value="">🔤 ${t("filter.all_subtitle_langs")}</option>
          ${Object.keys(SUBTITLE_LANG_ADJ).filter(l => l !== "und").map(l => `<option value="${l}">${esc(SUBTITLE_LANG_ADJ[l])}</option>`).join("")}
        </select>
      </div>
      ${alphaNav}`;

    for (const lib of relevantLibs) {
      const data = libraryContentsCache[lib.id];
      html += `
        <div class="section-group" data-lib="${lib.id}" data-type="${sectionType}">
          <div class="row-header" style="margin-bottom:14px">
            <span class="row-title">📁 ${esc(lib.name)}</span>
            <span class="row-count">${data.items.length} ${sectionType === "movies" ? "titlar" : "serier"}</span>
          </div>
          <div class="media-grid lib-grid-${lib.id}" data-items='${esc(JSON.stringify(data.items.map(i => ({ id: i.id, title: i.title, year: i.year, rating: i.rating, poster_url: i.poster_url, type: i.type, added_at: i.added_at, genres: i.genres || [], cached_subtitle_langs: (i.cached_subtitle_langs && i.cached_subtitle_langs.length ? i.cached_subtitle_langs : i.episode_subtitle_langs) || [] }))))}'>
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
        document.querySelectorAll(`#alpha-nav-${sectionType} a`).forEach(el => el.classList.remove("active"));
        document.querySelectorAll(`#alpha-nav-${sectionType} a`).forEach(el => {
          if (el.textContent === letter) el.classList.add("active");
        });
        return;
      }
    }
  }
}

function onSortChange(sectionType) {
  const sort = document.getElementById(`filter-sort-${sectionType}`)?.value;
  const genreSelect = document.getElementById(`filter-genre-${sectionType}`);
  if (genreSelect) {
    genreSelect.style.display = sort === "genre" ? "inline-block" : "none";
    if (sort !== "genre") genreSelect.value = ""; // don't let a leftover genre choice keep silently filtering once its picker is hidden
  }
  filterMediaSection(sectionType);
}

function filterMediaSection(sectionType) {
  const q = (document.getElementById(`filter-q-${sectionType}`)?.value || "").toLowerCase();
  const sort = document.getElementById(`filter-sort-${sectionType}`)?.value || "title";
  const genre = document.getElementById(`filter-genre-${sectionType}`)?.value || "";
  const subLang = document.getElementById(`filter-sublang-${sectionType}`)?.value || "";
  document.querySelectorAll(`.section-group[data-type="${sectionType}"]`).forEach(group => {
    const libId = group.getAttribute("data-lib");
    const grid = group.querySelector(`.lib-grid-${libId}`);
    if (!grid) return;
    let items = JSON.parse(grid.getAttribute("data-items") || "[]");
    if (q) items = items.filter(i => (i.title || "").toLowerCase().includes(q));
    if (genre) items = items.filter(i => (i.genres || []).includes(genre));
    if (subLang) items = items.filter(i => ((i.cached_subtitle_langs && i.cached_subtitle_langs.length ? i.cached_subtitle_langs : i.episode_subtitle_langs) || []).includes(subLang));
    if (sort === "title" || sort === "genre") items.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === "year") items.sort((a, b) => (b.year || 0) - (a.year || 0));
    else if (sort === "rating") items.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    grid.innerHTML = items.map(i => buildCard(i)).join("") ||
      `<div style="color:var(--muted);font-size:14px;padding:20px 0">Inga träffar</div>`;
    // Show/hide the group based on results
    group.style.display = (q || genre || subLang) && !items.length ? "none" : "block";
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
  // Load images: check local cover first, fall back to Spotify
  (async () => {
    for (const [id, data] of artists) {
      const artistKey = "aimg-" + encodeURIComponent(data.name).slice(0,30).replace(/%/g,"");
      try {
        // Check for local cover art first (no rate limit, instant)
        const local = await API.get("/music/has-local-cover/" + encodeURIComponent(id)).catch(() => null);
        if (local?.hasLocal) {
          const el = document.getElementById(artistKey);
          if (el) el.outerHTML = `<img class="mcard-poster" src="${local.url}" alt="" loading="lazy" style="aspect-ratio:1/1;object-fit:cover">`;
          continue; // Skip Spotify entirely
        }
        // Fall back to Spotify
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
  const artistImgKey = "aimg-" + encodeURIComponent(data.name).slice(0,30).replace(/%/g,"");
  let html = `<div class="detail-page">
    <div class="show-hero" id="artist-hero-bg">
      <div class="show-hero-overlay"></div>
      <button class="detail-back" onclick="renderArtistGrid(_musicData)">← Alla artister</button>
      <div class="show-hero-content">
        <div class="detail-poster-col">
          <div class="detail-poster" id="${artistImgKey}-hero" style="width:180px;height:180px;border-radius:50%;background:var(--card2);display:flex;align-items:center;justify-content:center;font-size:48px;overflow:hidden">🎤</div>
        </div>
        <div class="detail-info-col">
          <h1 class="detail-page-title">${esc(data.name)}</h1>
          <div class="detail-meta-row" id="artist-meta-row">
            <span class="detail-meta-item">${albums.length} album</span>
          </div>
          <div id="artist-genres" class="detail-genres"></div>
          <p id="artist-bio-text" class="detail-page-overview"></p>
          <div class="detail-actions">
            ${currentUser?.role === "admin" ? `<button class="btn-fav" onclick='openMusicFixMeta("artist","${encodeURIComponent(data.name)}","${esc(data.name)}")'>🔍 Fixa info</button>` : ""}
          </div>
        </div>
      </div>
    </div>
    <div class="detail-content">
      <div class="detail-section">
        <h3 class="detail-section-title">Album</h3>
        <div class="media-grid">`;
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
  html += `</div></div></div></div>`;
  sec.innerHTML = html;

  // Load artist image for hero (poster + backdrop)
  (async () => {
    try {
      const local = await API.get("/music/has-local-cover/" + encodeURIComponent(id)).catch(() => null);
      const imgUrl = local?.hasLocal ? local.url : (await API.get("/spotify/artist/" + encodeURIComponent(data.name)).catch(() => null))?.image;
      if (imgUrl) {
        const posterEl = document.getElementById(artistImgKey + "-hero");
        if (posterEl) posterEl.outerHTML = `<img class="detail-poster" src="${imgUrl}" style="width:180px;height:180px;border-radius:50%;object-fit:cover">`;
        const heroBg = document.getElementById("artist-hero-bg");
        if (heroBg) heroBg.style.backgroundImage = `url('${imgUrl}')`;
      }
    } catch {}
  })();

  // Load artist bio from Last.fm
  API.get("/lastfm/artist/" + encodeURIComponent(data.name)).then(r => {
    if (r.tags?.length) {
      const genresEl = document.getElementById("artist-genres");
      if (genresEl) genresEl.innerHTML = r.tags.map(t => `<span class="detail-genre">${esc(t)}</span>`).join("");
    }
    if (r.bio) {
      const bioEl = document.getElementById("artist-bio-text");
      if (bioEl) bioEl.textContent = r.bio;
    }
    if (r.listeners) {
      const metaRow = document.getElementById("artist-meta-row");
      if (metaRow) metaRow.innerHTML += `<span class="detail-meta-item">${parseInt(r.listeners).toLocaleString("sv-SE")} lyssnare</span>`;
    }
  }).catch(() => {});
  // Load album images: check local cover first, fall back to Spotify
  (async () => {
    for (let idx = 0; idx < albums.length; idx++) {
      const [albumId, albumData] = albums[idx];
      const albumImgId = "album-img-" + idx;
      try {
        const local = await API.get("/music/has-local-cover/" + encodeURIComponent(albumId)).catch(() => null);
        if (local?.hasLocal) {
          const el = document.getElementById(albumImgId);
          if (el) el.outerHTML = `<img class="mcard-poster" src="${local.url}" alt="" loading="lazy" style="object-fit:cover">`;
          continue;
        }
        const r = await API.get("/spotify/album/" + encodeURIComponent(data.name) + "/" + encodeURIComponent(albumData.name));
        if (r.image) {
          const el = document.getElementById(albumImgId);
          if (el) el.outerHTML = `<img class="mcard-poster" src="${r.image}" alt="" loading="lazy" style="object-fit:cover">`;
        }
      } catch {}
    }
  })();
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
      ${currentUser?.role === "admin" ? `<button class="btn-fav" style="margin-left:12px" onclick='openMusicFixMeta("${artistData.isStandalone ? "artist" : "album"}","${artistData.isStandalone ? encodeURIComponent(artistData.name) : encodeURIComponent(albumData.name)}","${esc(albumData.name)}","${encodeURIComponent(artistData.name)}")'>🔍 Fixa info</button>` : ""}
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
      <div class="hero-badge">${t("home.recommends")}</div>
      <div class="hero-title" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-overflow:ellipsis">${esc(item.title)}</div>
      <div class="hero-meta">
        ${item.rating ? `<span class="hero-rating">⭐ ${parseFloat(item.rating).toFixed(1)}</span>` : ""}
        ${item.year ? `<span>${item.year}</span>` : ""}
      </div>
      ${item.overview ? `<div class="hero-overview">${esc(item.overview)}</div>` : ""}
      <div class="hero-actions">
        <button class="btn-play" onclick='playItem("${item.id}","${esc(item.title)}")'>▶ ${t("detail.play")}</button>
        <button class="btn-info" onclick='openDetail("${item.id}")'>ℹ ${t("home.more_info")}</button>
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

// Same idea as buildRow but for a "you liked X, you might also like this" recommendation
// set — handles unowned items (no local id yet) with the same "I biblioteket" badge pattern
// used elsewhere, and simply renders nothing if there's no source title for this type yet.
function buildRecommendationRow(rec, scrollId) {
  if (!rec?.items?.length) return "";
  const names = (rec.sourceTitles || []).slice(0, 3).join(", ") + (rec.sourceTitles?.length > 3 ? " m.fl." : "");
  return `
    <div class="row-section">
      <div class="row-header"><span class="row-title">${t("home.you_liked").replace("{names}", esc(names))}</span></div>
      <div class="cast-scroll-wrap">
        <button class="cast-scroll-btn left" onclick="document.getElementById('${scrollId}').scrollBy({left:-300,behavior:'smooth'})">‹</button>
        <div class="cast-scroll" id="${scrollId}">
          ${rec.items.map(r => `
            <div class="mcard" style="width:140px;flex-shrink:0;position:relative" onclick='${r.owned ? `openDetail("${r.id}")` : `openTmdbDetail(${r.tmdb_id}, "${r.type === "tvshow" ? "tv" : "movie"}")`}'>
              ${r.owned ? `<span style="position:absolute;top:6px;right:6px;background:rgba(46,204,113,0.9);color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;z-index:2">✓ I biblioteket</span>` : ""}
              ${r.poster_url
                ? `<img class="mcard-poster" src="${r.poster_url}" alt="" loading="lazy">`
                : `<div class="mcard-poster-ph"><span>${r.type==="tvshow"?"📺":"🎬"}</span><span>${esc((r.title||"").slice(0,14))}</span></div>`}
              <div class="mcard-info"><div class="mcard-title">${esc(r.title||"")}</div></div>
            </div>`).join("")}
        </div>
        <button class="cast-scroll-btn right" onclick="document.getElementById('${scrollId}').scrollBy({left:300,behavior:'smooth'})">›</button>
      </div>
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
async function openShowDetail(id, fromRouter) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.getElementById("sidebar")?.style.removeProperty("background");
  document.getElementById("sidebar")?.style.removeProperty("--border");
  document.getElementById("sidebar")?.style.removeProperty("border-color");
  document.getElementById("topbar")?.style.removeProperty("background");
  document.getElementById("topbar")?.style.removeProperty("--border");
  document.getElementById("topbar")?.style.removeProperty("border-color");
  document.getElementById("sec-detail")?.style.removeProperty("--border");
  document.querySelectorAll("#sec-detail .detail-section-title").forEach(el => el.style.removeProperty("border-color"));
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
    const [item, details, seasonsData, progress] = await Promise.all([
      API.get("/media/" + id),
      API.get("/media/" + id + "/details").catch(() => ({})),
      API.get("/tvshow/" + id + "/seasons").catch(() => ({ seasons: [] })),
      API.get("/media/" + id + "/progress").catch(() => ({}))
    ]);
    if (!fromRouter && item.slug) {
      navigateToPath(`/serier/${item.slug}`, item.title);
    }
    const seasons = seasonsData.seasons || [];
    const genresHtml = (details.genres||[]).slice(0, 3).join(", ") + (details.genres?.length > 3 ? t("detail.and_more") : "");
    const directors = (details.crew||[]).filter(c => ["Creator","Director"].includes(c.job)).map(c => esc(c.name)).join(", ");
    const castHtml = (details.cast||[]).length ? `
      <div class="detail-section">
        <h3 class="detail-section-title">${t("detail.cast")}</h3>
        ${buildCastScroll(details.cast, "cast-show-${id}")}
      </div>` : "";
    const reviewsHtml = (details.reviews||[]).length ? `
      <div class="detail-section">
        <h3 class="detail-section-title">${t("detail.reviews")}</h3>
        <div class="cast-scroll-wrap">
          <button class="cast-scroll-btn left" onclick="document.getElementById('reviews-scroll-${id}').scrollBy({left:-320,behavior:'smooth'})">‹</button>
          <div class="cast-scroll" id="reviews-scroll-${id}">
            ${details.reviews.map(r => `
              <div style="background:var(--card2);border-radius:10px;padding:14px;width:260px;flex-shrink:0">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                  ${r.avatar ? `<img src="${r.avatar}" style="width:36px;height:36px;border-radius:50%;object-fit:cover">` : `<div style="width:36px;height:36px;border-radius:50%;background:var(--border);display:flex;align-items:center;justify-content:center">👤</div>`}
                  <div>
                    <div style="font-size:13px;font-weight:600">${esc(r.author||t("detail.anonymous"))}</div>
                    <div style="font-size:11px;color:var(--muted)">${r.date ? new Date(r.date).toLocaleDateString("sv-SE") : ""}</div>
                  </div>
                </div>
                ${r.rating ? `<div style="color:#f5c518;font-size:13px;margin-bottom:6px">${"★".repeat(Math.round(r.rating/2))}${"☆".repeat(5-Math.round(r.rating/2))}</div>` : ""}
                <div style="font-size:13px;color:var(--text);line-height:1.4">${esc(r.content||"")}</div>
              </div>`).join("")}
          </div>
          <button class="cast-scroll-btn right" onclick="document.getElementById('reviews-scroll-${id}').scrollBy({left:320,behavior:'smooth'})">›</button>
        </div>
      </div>` : "";
    const seasonsHtml = seasons.length ? `
      <div class="detail-section">
        <h3 class="detail-section-title">${t("detail.seasons")}</h3>
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
                <div class="mcard-meta">${s.episode_count} ${t("detail.episodes")}${s.air_date ? " · " + s.air_date.slice(0,4) : ""}</div>
              </div>
            </div>`).join("")}
        </div>
      </div>` : "";
    sec.innerHTML = `
      <div class="detail-page">
        ${item.backdrop_url ? `<div id="detail-fullbg-${item.id}" style="position:fixed;inset:0;z-index:-1;background-size:cover;background-position:70% 25%;opacity:0;transition:opacity .3s;background-image:url('${item.backdrop_url}');filter:saturate(30%) brightness(0.75)"></div>
        <div id="detail-fullbg-overlay-${item.id}" style="position:fixed;inset:0;z-index:-1;background:rgba(0,0,0,0.5);opacity:0;transition:opacity .3s"></div>` : ""}
        <div class="detail-hero-bar" style="display:flex !important;align-items:center !important;justify-content:space-between !important;padding:14px 20px !important;position:relative !important;z-index:50 !important;background:transparent !important;margin:0 !important">
          <button class="detail-back" onclick="closeDetail()" style="position:static !important;background:var(--card2, #1a1a28);color:var(--text, #fff);border:1px solid var(--border, #333);padding:8px 16px;border-radius:8px;cursor:pointer;font-size:14px;top:auto !important;left:auto !important">← ${t("detail.back")}</button>
          ${item.backdrop_url ? `<button id="show-bg-btn-${item.id}" onclick="toggleDetailBackground('${item.id}', this)" title="${t("detail.show_background")}" style="position:static !important;display:flex;align-items:center;gap:6px;background:var(--card2, #1a1a28);color:var(--muted);border:1px solid var(--border, #333);padding:6px 12px;border-radius:8px;cursor:pointer;font-size:13px;top:auto !important;right:auto !important">🖼 ${t("detail.show_background")}</button>` : ""}
        </div>
        <div class="detail-content" style="position:relative !important;z-index:2;padding-top:115px !important;margin-top:0 !important">
          <div class="detail-main">
            <div class="detail-poster-col" style="overflow:visible !important;height:auto !important;max-height:none !important">
              ${item.poster_url ? `<img class="detail-poster" src="${item.poster_url}" alt="" style="max-width:230px;width:100%;height:auto !important;max-height:none !important;object-fit:contain">` : `<div class="detail-poster-ph" style="max-width:230px">📺</div>`}
            </div>
            <div class="detail-info-col">
              <h1 class="detail-page-title">${esc(item.title)}</h1>
              ${directors ? `<div class="detail-director-line" style="color:var(--muted);font-size:13px;margin-top:2px">${directors}</div>` : ""}
              <div class="detail-meta-row" style="margin-top:8px">
                ${item.rating ? `<span class="detail-meta-item" style="background:#01b4e4;color:#fff;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px">⭐ TMDB ${parseFloat(item.rating).toFixed(1)}</span>` : ""}
                <span id="extra-ratings-${item.id||id}"></span>
                ${genresHtml ? `<span class="detail-meta-item">${esc(genresHtml)}</span>` : ""}
              </div>
              ${item.overview ? `<p class="detail-page-overview">${esc(item.overview)}</p>` : ""}
              <div class="detail-actions" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
                <span id="like-btn-${item.id}">${pillBtn("👍", t("detail.like"), `toggleFav("${item.id}",this)`, `like-btn-inner-${item.id}`, t("detail.like_tooltip"))}</span>
                ${progress?.completed
                  ? pillBtn("↺", t("detail.unwatched"), `markUnwatched("${item.id}")`, `watched-btn-${item.id}`, t("detail.watched_tooltip"))
                  : pillBtn("✓", t("detail.watched"), `markWatched("${item.id}", 0)`, `watched-btn-${item.id}`, t("detail.watched_tooltip"))}
                ${pillBtn("🎬", t("detail.trailer"), `toggleTrailer("${item.id}")`, `trailer-btn-${item.id}`, t("detail.trailer_tooltip"))}
                <div style="position:relative">
                  <button onclick="toggleDetailMoreMenu('${item.id}')" title="${t("detail.more")}" style="width:38px;height:38px;border-radius:50%;background:var(--card2, #1a1a28);border:1px solid var(--border, #333);color:var(--text, #fff);font-size:16px;cursor:pointer">⋯</button>
                  <div id="detail-more-menu-${item.id}" style="display:none;position:absolute;top:44px;left:0;background:var(--surface, #141420);border:1px solid var(--border);border-radius:10px;padding:6px;z-index:10;min-width:170px;box-shadow:0 6px 20px rgba(0,0,0,0.4)">
                    ${currentUser?.role === "admin" ? `<div onclick='openFixMeta("${item.id}","${esc(item.title)}","tv")' style="padding:8px 12px;cursor:pointer;font-size:13px;border-radius:6px;display:flex;align-items:center;gap:8px">🔍 ${t("detail.fix_info")}</div>` : ""}
                    ${currentUser?.role === "admin" ? `<div onclick='openEditMedia("${item.id}")' style="padding:8px 12px;cursor:pointer;font-size:13px;border-radius:6px;display:flex;align-items:center;gap:8px">✏ ${t("detail.edit")}</div>` : ""}
                  </div>
                </div>
              </div>
            </div>
          </div>
          ${seasonsHtml}
          ${castHtml}
          ${reviewsHtml}
          ${item.tmdb_id ? `<div class="detail-section" id="extras-${id}"></div>` : ""}
          ${item.tmdb_id ? `<div class="wtw-section" style="padding:0 20px 20px">
            <div id="wtw-${id}"><span style="font-size:13px;color:var(--muted)">Hämtar streaming...</span></div>
          </div>` : ""}
          ${item.tmdb_id ? `<div class="detail-section" id="related-${id}"></div>` : ""}
        </div>
      </div>`;
    loadLikeStatus(item.id);
    loadExtraRatings(`extra-ratings-${item.id}`, item.title, item.year);
    if (item.backdrop_url && localStorage.getItem("sv_detail_bg_shown") === "1") {
      const btn = document.getElementById(`show-bg-btn-${item.id}`);
      toggleDetailBackground(item.id, btn, true);
    }
    if (item.tmdb_id) {
      API.get("/media/" + id + "/extras").then(data => {
        const el = document.getElementById("extras-" + id);
        if (!el || !data.extras || !data.extras.length) return;
        el.innerHTML = `
          <h3 class="detail-section-title">${t("detail.extras")}</h3>
          <div class="cast-scroll-wrap">
            <button class="cast-scroll-btn left" onclick="document.getElementById('extras-scroll-${id}').scrollBy({left:-300,behavior:'smooth'})">‹</button>
            <div class="cast-scroll" id="extras-scroll-${id}">
              ${data.extras.map(v => `
                <div style="width:220px;flex-shrink:0;cursor:pointer" onclick='openTrailerModal("${v.key}","${esc(v.name).replace(/"/g,"&quot;")}")'>
                  <div style="position:relative;border-radius:8px;overflow:hidden">
                    <img src="${v.thumbnail}" style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block">
                    <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.25);font-size:28px;color:#fff">▶</span>
                  </div>
                  <div style="font-size:13px;font-weight:600;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(v.name)}</div>
                  <div style="font-size:11px;color:var(--muted)">${esc(v.type)}</div>
                </div>`).join("")}
            </div>
            <button class="cast-scroll-btn right" onclick="document.getElementById('extras-scroll-${id}').scrollBy({left:300,behavior:'smooth'})">›</button>
          </div>`;
      }).catch(()=>{});
    }
    if (item.tmdb_id) {
      API.get("/watch-providers/" + item.tmdb_id + "?kind=tv").then(data => {
        const el = document.getElementById("wtw-" + id);
        if (!el) return;
        window._wtwData = window._wtwData || {};
        window._wtwData[id] = data;
        const flatrateList = (data.flatrate||[]).map(p => ({ ...p, kind: t("detail.streaming_label") }));
        const payList = [
          ...(data.rent||[]).map(p => ({ ...p, kind: t("detail.rent") })),
          ...(data.buy||[]).map(p => ({ ...p, kind: t("detail.buy") }))
        ];
        if (!flatrateList.length && !payList.length) { el.innerHTML = ""; return; }
        // Services included in a subscription you might already have are far more actionable
        // than ones that cost extra, so those are always shown in full rather than hidden
        // behind "+N more" — only rent/buy count toward that. If nothing is available on
        // subscription at all, the first pay option is shown directly instead (still clearly
        // labeled Hyr/Köp) so there's always something visible, not just a count.
        const primaryList = flatrateList.length ? flatrateList : payList.slice(0, 1);
        const extraCount = flatrateList.length ? payList.length : payList.length - 1;
        const providerCard = (p) => `
            <div ${providerLink(p.name, data.link) ? `onclick="window.open('${providerLink(p.name, data.link)}','_blank')" style="cursor:pointer;` : `style="`}background:var(--card2);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px;min-width:160px">
              ${p.logo ? `<img src="${p.logo}" style="width:36px;height:36px;border-radius:6px;object-fit:cover">` : `<div style="width:36px;height:36px;border-radius:6px;background:var(--border)"></div>`}
              <div>
                <div style="font-size:13px;font-weight:600">${esc(p.name)}</div>
                <div style="font-size:11px;color:var(--muted)">${esc(p.kind)}</div>
              </div>
            </div>`;
        el.innerHTML = `
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">${t("detail.more_ways_to_watch")}</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            ${primaryList.map(providerCard).join("")}
            ${extraCount > 0 ? `<div onclick="openWatchProvidersModal('${id}')" style="background:var(--card2);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer;min-width:120px">
              <span style="font-size:20px">☰</span>
              <span style="font-size:13px;color:var(--muted)">${t("detail.more_count").replace("{n}", extraCount)}</span>
            </div>` : ""}
          </div>`;
      }).catch(()=>{});
    }
    if (item.tmdb_id) {
      API.get("/media/" + id + "/related").then(data => {
        const el = document.getElementById("related-" + id);
        if (!el || !data.items || !data.items.length) return;
        el.innerHTML = `
          <h3 class="detail-section-title">${t("detail.similar_shows")}</h3>
          <div class="cast-scroll-wrap">
            <button class="cast-scroll-btn left" onclick="document.getElementById('related-scroll-${id}').scrollBy({left:-300,behavior:'smooth'})">‹</button>
            <div class="cast-scroll" id="related-scroll-${id}">
              ${data.items.map(r => `
                <div class="mcard" style="width:140px;flex-shrink:0;position:relative" onclick='${r.owned ? `openDetail("${r.id}")` : `openTmdbDetail(${r.tmdb_id}, "tv")`}'>
                  ${r.owned ? `<span style="position:absolute;top:6px;right:6px;background:rgba(46,204,113,0.9);color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;z-index:2">✓ I biblioteket</span>` : ""}
                  ${r.poster_url
                    ? `<img class="mcard-poster" src="${r.poster_url}" alt="" loading="lazy">`
                    : `<div class="mcard-poster-ph"><span>📺</span><span>${esc((r.title||"").slice(0,14))}</span></div>`}
                  <div class="mcard-info"><div class="mcard-title">${esc(r.title||"")}</div></div>
                </div>`).join("")}
            </div>
            <button class="cast-scroll-btn right" onclick="document.getElementById('related-scroll-${id}').scrollBy({left:300,behavior:'smooth'})">›</button>
          </div>`;
      }).catch(()=>{});
    }
  } catch(e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>${e.message}</h3></div>`;
  }
}

async function openSeason(showId, seasonNum, fromRouter) {
  const sec = document.getElementById("sec-detail");
  sec.innerHTML = `<div class="spinner-wrap" style="height:60vh"><div class="spinner"></div></div>`;
  try {
    const [show, seasonData] = await Promise.all([
      API.get("/media/" + showId),
      API.get("/tvshow/" + showId + "/season/" + seasonNum)
    ]);
    if (!fromRouter && show.slug) {
      navigateToPath(`/serier/${show.slug}/${seasonEpisodeWords().season}/${seasonNum}`, `${show.title} - Säsong ${seasonNum}`);
    }
    const episodes = seasonData.episodes || [];
    // Stored so openEpisodeDetail() can look up an episode's already-fetched data (title,
    // overview, still, runtime, air_date) instead of a redundant round-trip.
    window._currentSeasonEpisodes = episodes;
    window._currentSeasonShowId = showId;
    window._currentSeasonShowTitle = show.title;
    window._currentSeasonShowSlug = show.slug;
    window._currentSeasonNum = seasonNum;
    const cast = seasonData.cast || [];
    window._currentSeasonCast = cast;
    const castHtml = cast.length ? `
      <div class="detail-section">
        <h3 class="detail-section-title">${t("detail.cast")}</h3>
        ${buildCastScroll(cast, "cast-season-${showId}-${seasonNum}")}
      </div>` : "";
    const episodesHtml = `
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:4px">
        <h3 class="detail-section-title" style="margin:0">Avsnitt</h3>
        <select class="filter-select" id="season-filter-sublang" onchange="filterSeasonBySubLang()" title="Visa bara avsnitt med undertext på valt språk" style="font-size:12px">
          <option value="">🔤 Alla undertextspråk</option>
          ${Object.keys(SUBTITLE_LANG_ADJ).filter(l => l !== "und").map(l => `<option value="${l}">${esc(SUBTITLE_LANG_ADJ[l])}</option>`).join("")}
        </select>
      </div>
      <div class="media-grid" id="season-episodes-grid" data-items='${esc(JSON.stringify(episodes.map(ep => ({ id: ep.id, title: ep.title, episode: ep.episode, runtime: ep.runtime, still_url: ep.still_url, cached_subtitle_langs: ep.cached_subtitle_langs || [] }))))}' data-show-id="${showId}" data-show-title="${esc(show.title)}" data-season="${seasonNum}">${episodes.map(ep => buildEpisodeCard(ep, showId, show.title, seasonNum)).join("")}</div>`;
    sec.innerHTML = `
      <div class="detail-page">
        <div class="show-hero" ${show.backdrop_url ? `style="background-image:url('${show.backdrop_url}')"` : ""}>
          <div class="show-hero-overlay"></div>
          <button class="detail-back" onclick="history.back()">← Tillbaka</button>
          <div class="show-hero-content">
            <div class="detail-poster-col">
              ${seasonData.poster_url ? `<img class="detail-poster" src="${seasonData.poster_url}" alt="">` : `<div class="detail-poster-ph">📺</div>`}
            </div>
            <div class="detail-info-col">
              <h1 class="detail-page-title">${esc(seasonData.name||"Säsong "+seasonNum)}</h1>
              <div class="detail-meta-row">
                <span class="detail-meta-item">${episodes.length} avsnitt</span>
              </div>
              <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
                <button class="btn-fav" style="font-size:12px" onclick="batchSearchSeasonSubtitles('${showId}', ${seasonNum})">🔍 Sök undertexter för hela säsongen</button>
                <button class="btn-fav" style="font-size:12px" onclick="batchRemoveSeasonSubtitles('${showId}', ${seasonNum})">🗑 Ta bort externa undertexter för säsongen</button>
              </div>
              ${seasonData.overview ? `<p class="detail-page-overview">${esc(seasonData.overview)}</p>` : ""}
            </div>
          </div>
        </div>
        <div class="detail-content">
          ${castHtml}
          <div class="detail-section">
            ${episodesHtml || '<p style="color:var(--muted)">Inga avsnitt hittades</p>'}
          </div>
        </div>
      </div>`;
  } catch(e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>${e.message}</h3></div>`;
  }
}

async function openTmdbDetail(tmdbId, kind, fromRouter) {
  kind = kind === "tv" ? "tv" : "movie";
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
    const item = await API.get(`/tmdb/${kind}/${tmdbId}`);
    // Without this, clicking through Explore Trailers → a title → a cast member's page and
    // then hitting the browser's back button skipped straight past this page entirely,
    // since nothing here had ever registered as its own step in the browser history.
    if (!fromRouter) navigateToPath(`/titel-${kind === "tv" ? "serie" : "film"}/${clientSlugify(item.title)}-${tmdbId}`, item.title + " - StreamVault");
    const runtime = item.runtime ? `${Math.floor(item.runtime/60)}h ${item.runtime%60}m` : "";
    const genresHtml = (item.genres||[]).map(g => `<span class="detail-genre">${esc(g)}</span>`).join("");
    const directors = (item.crew||[]).map(c => esc(c.name)).join(", ");
    const directorLabel = kind === "tv" ? t("detail.created_by") : "🎬";
    const castHtml = (item.cast||[]).length ? `
      <div class="detail-section">
        <h3 class="detail-section-title">${t("detail.cast")}</h3>
        <div class="cast-scroll">
          ${(item.cast||[]).map(p => `
            <div class="cast-card" onclick="openPersonDetail(${p.id})">
              ${p.profile_url ? `<img class="cast-photo" src="${p.profile_url}" alt="" loading="lazy">` : `<div class="cast-photo-ph">👤</div>`}
              <div class="cast-name">${esc(p.name)}</div>
              <div class="cast-char">${esc(p.character||"")}</div>
            </div>`).join("")}
        </div>
      </div>` : "";
    const reviewsHtml = (item.reviews||[]).length ? `
      <div class="detail-section">
        <h3 class="detail-section-title">${t("detail.reviews")}</h3>
        <div class="cast-scroll-wrap">
          <button class="cast-scroll-btn left" onclick="document.getElementById('reviews-scroll-tmdb-${tmdbId}').scrollBy({left:-320,behavior:'smooth'})">‹</button>
          <div class="cast-scroll" id="reviews-scroll-tmdb-${tmdbId}">
            ${item.reviews.map(r => `
              <div style="background:var(--card2);border-radius:10px;padding:14px;width:260px;flex-shrink:0">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                  ${r.avatar ? `<img src="${r.avatar}" style="width:36px;height:36px;border-radius:50%;object-fit:cover">` : `<div style="width:36px;height:36px;border-radius:50%;background:var(--border);display:flex;align-items:center;justify-content:center">👤</div>`}
                  <div>
                    <div style="font-size:13px;font-weight:600">${esc(r.author||"Anonym")}</div>
                    <div style="font-size:11px;color:var(--muted)">${r.date ? new Date(r.date).toLocaleDateString("sv-SE") : ""}</div>
                  </div>
                </div>
                ${r.rating ? `<div style="color:#f5c518;font-size:13px;margin-bottom:6px">${"★".repeat(Math.round(r.rating/2))}${"☆".repeat(5-Math.round(r.rating/2))}</div>` : ""}
                <div style="font-size:13px;color:var(--text);line-height:1.4">${esc(r.content||"")}</div>
              </div>`).join("")}
          </div>
          <button class="cast-scroll-btn right" onclick="document.getElementById('reviews-scroll-tmdb-${tmdbId}').scrollBy({left:320,behavior:'smooth'})">›</button>
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
              ${item.poster_url ? `<img class="detail-poster" src="${item.poster_url}" alt="">` : `<div class="detail-poster-ph">${kind === "tv" ? "📺" : "🎬"}</div>`}
            </div>
            <div class="detail-info-col">
              <h1 class="detail-page-title">${esc(item.title)}</h1>
              <div class="detail-meta-row">
                ${item.rating ? `<span class="detail-meta-item" style="background:#01b4e4;color:#fff;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px">⭐ TMDB ${parseFloat(item.rating).toFixed(1)}</span>` : ""}
                <span id="extra-ratings-tmdb-${tmdbId}"></span>
                ${item.year ? `<span class="detail-meta-item">${item.year}</span>` : ""}
                ${runtime ? `<span class="detail-meta-item">${runtime}</span>` : ""}
                ${directors ? `<span class="detail-meta-item">${directorLabel} ${directors}</span>` : ""}
              </div>
              ${genresHtml ? `<div class="detail-genres">${genresHtml}</div>` : ""}
              ${item.overview ? `<p class="detail-page-overview">${esc(item.overview)}</p>` : ""}
              <div class="detail-actions">
                <button class="btn-fav" id="trailer-btn-tmdb-${tmdbId}" onclick='toggleTrailerByTmdb(${tmdbId}, "${kind}")'>▶ ${t("detail.trailer_tooltip")}</button>
              </div>
              <div class="wtw-section">
                <div class="wtw-title">${t("detail.where_to_watch")}</div>
                <div class="wtw-providers" id="wtw-tmdb-${tmdbId}"><span style="font-size:13px;color:var(--muted)">Hämtar...</span></div>
              </div>
            </div>
          </div>
          ${castHtml}
          ${reviewsHtml}
        </div>
      </div>`;
    loadExtraRatings(`extra-ratings-tmdb-${tmdbId}`, item.title, item.year);
    API.get(`/watch-providers/${tmdbId}?kind=${kind}`).then(data => {
      const el = document.getElementById("wtw-tmdb-" + tmdbId);
      if (!el) return;
      window._wtwData = window._wtwData || {};
      window._wtwData["tmdb-" + tmdbId] = data;
      const flatrateList = (data.flatrate||[]).map(p => ({ ...p, kind: t("detail.streaming_label") }));
      const payList = [
        ...(data.rent||[]).map(p => ({ ...p, kind: t("detail.rent") })),
        ...(data.buy||[]).map(p => ({ ...p, kind: t("detail.buy") }))
      ];
      if (!flatrateList.length && !payList.length) { el.innerHTML = `<span style="font-size:13px;color:var(--muted)">${t("detail.not_available_streaming_se")}</span>`; return; }
      const primaryList = flatrateList.length ? flatrateList : payList.slice(0, 1);
      const extraCount = flatrateList.length ? payList.length : payList.length - 1;
      const providerCard = (p) => `
          <div ${providerLink(p.name, data.link) ? `onclick="window.open('${providerLink(p.name, data.link)}','_blank')" style="cursor:pointer;` : `style="`}background:var(--card2);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px;min-width:160px">
            ${p.logo ? `<img src="${p.logo}" style="width:36px;height:36px;border-radius:6px;object-fit:cover">` : `<div style="width:36px;height:36px;border-radius:6px;background:var(--border)"></div>`}
            <div>
              <div style="font-size:13px;font-weight:600">${esc(p.name)}</div>
              <div style="font-size:11px;color:var(--muted)">${esc(p.kind)}</div>
            </div>
          </div>`;
      el.innerHTML = `
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${primaryList.map(providerCard).join("")}
          ${extraCount > 0 ? `<div onclick="openWatchProvidersModal('tmdb-${tmdbId}')" style="background:var(--card2);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer;min-width:120px">
            <span style="font-size:20px">☰</span>
            <span style="font-size:13px;color:var(--muted)">${t("detail.more_count").replace("{n}", extraCount)}</span>
          </div>` : ""}
        </div>`;
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

// Compact, icon-only circular button matching Plex's action-row style — a tooltip (title)
// carries the label instead of visible text, so a row of 6-7 actions doesn't sprawl.
// Compact pill button — icon + short text, kept small so a row of 3-4 still doesn't take up
// much more room than the icon-only version did. Deliberately not identical to Plex's
// icon-only row, per Christian's own "let's not just be a Plex clone" note.
function pillBtn(icon, label, onclick, id, tooltip) {
  return `<button ${id ? `id="${id}"` : ""} onclick='${onclick}' ${tooltip ? `title="${esc(tooltip)}"` : ""} style="display:flex;align-items:center;gap:5px;padding:8px 14px;border-radius:20px;background:var(--card2, #1a1a28);border:1px solid var(--border, #333);color:var(--text, #fff);font-size:13px;cursor:pointer;white-space:nowrap">${icon} ${esc(label)}</button>`;
}

function iconBtn(icon, label, onclick, id) {
  return `<button ${id ? `id="${id}"` : ""} onclick='${onclick}' title="${esc(label)}" style="width:38px;height:38px;border-radius:50%;background:var(--card2, #1a1a28);border:1px solid var(--border, #333);color:var(--text, #fff);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center">${icon}</button>`;
}

async function loadExtraRatings(elementId, title, year) {
  const el = document.getElementById(elementId);
  if (!el) return;
  try {
    const data = await API.get(`/ratings?title=${encodeURIComponent(title)}&year=${year||""}`);
    const badges = [];
    if (data.imdb) badges.push(`<span class="detail-meta-item" style="background:#f5c518;color:#000;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px" title="IMDb${data.imdb_votes ? ' · ' + data.imdb_votes + ' röster' : ''}">IMDb ${data.imdb.toFixed(1)}</span>`);
    if (data.rotten_tomatoes !== null) {
      const fresh = data.rotten_tomatoes >= 60;
      badges.push(`<span class="detail-meta-item" style="background:${fresh ? '#fa320a' : '#7dc855'};color:#fff;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px">${fresh ? "🍅" : "🤢"} ${data.rotten_tomatoes}%</span>`);
    }
    el.innerHTML = badges.join(" ");
  } catch(e) {}
}

async function loadDetailTechInfo(itemId, itemTitle) {
  const el = document.getElementById(`detail-techinfo-${itemId}`);
  if (!el) return;
  try {
    const info = await API.get(`/media/${itemId}/techinfo`);
    el.innerHTML = `
      <div style="margin-top:14px;font-size:13px">
        ${info.video ? `<div style="display:flex;gap:10px;margin-bottom:4px"><span class="techinfo-label" style="color:var(--muted);width:80px;flex-shrink:0">${t("detail.video")}</span><span>${esc(info.video)}</span></div>` : ""}
        ${info.audio ? `<div style="display:flex;gap:10px;margin-bottom:4px"><span class="techinfo-label" style="color:var(--muted);width:80px;flex-shrink:0">${t("detail.audio")}</span><span>${esc(info.audio)}</span></div>` : ""}
        <div style="display:flex;gap:10px;align-items:center">
          <span class="techinfo-label" style="color:var(--muted);width:80px;flex-shrink:0">${t("detail.subtitles")}</span>
          <button onclick='openSubtitles("${itemId}","${esc(itemTitle||"")}")' style="background:none;border:none;color:var(--accent, #e05724);font-size:13px;cursor:pointer;display:flex;align-items:center;gap:4px;padding:0">🔤 ${t("detail.choose_subtitle")} ▾</button>
        </div>
      </div>`;
  } catch(e) {
    el.innerHTML = "";
  }
}

function openWatchProvidersModal(itemId) {
  const data = window._wtwData?.[itemId];
  if (!data) return;
  const overlay = document.createElement("div");
  overlay.id = "wtw-modal-overlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:600;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:20px";
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

  const section = (title, list) => !list.length ? "" : `
    <div style="margin-bottom:18px">
      <div style="font-size:13px;color:var(--muted);margin-bottom:10px">${esc(title)}</div>
      ${list.map(p => `
        <div ${providerLink(p.name, data.link) ? `onclick="window.open('${providerLink(p.name, data.link)}','_blank')" style="cursor:pointer;` : `style="`}display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border)">
          ${p.logo ? `<img src="${p.logo}" style="width:36px;height:36px;border-radius:6px;object-fit:cover">` : `<div style="width:36px;height:36px;border-radius:6px;background:var(--card2)"></div>`}
          <span style="font-size:14px;flex:1">${esc(p.name)}</span>
        </div>`).join("")}
    </div>`;

  overlay.innerHTML = `
    <div style="background:var(--surface, #141420);border:1px solid var(--border);border-radius:14px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto">
      <div style="padding:16px 20px">
        ${section(t("detail.available_to_stream"), data.flatrate || [])}
        ${section(t("detail.rent"), data.rent || [])}
        ${section(t("detail.buy"), data.buy || [])}
      </div>
      <div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;justify-content:flex-end">
        <button onclick="document.getElementById('wtw-modal-overlay').remove()" style="background:var(--accent,#e05724);color:#fff;border:none;padding:8px 20px;border-radius:8px;font-size:14px;cursor:pointer">${t("detail.done")}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

function toggleDetailMoreMenu(itemId) {
  const menu = document.getElementById(`detail-more-menu-${itemId}`);
  if (!menu) return;
  const isOpen = menu.style.display === "block";
  menu.style.display = isOpen ? "none" : "block";
  if (!isOpen) {
    const closeOnOutsideClick = (e) => {
      if (!menu.contains(e.target) && e.target.title !== "Mer") {
        menu.style.display = "none";
        document.removeEventListener("click", closeOnOutsideClick);
      }
    };
    setTimeout(() => document.addEventListener("click", closeOnOutsideClick), 0);
  }
}

// Samples the backdrop image via an offscreen canvas to get its actual average brightness,
// so the sidebar/label text color can be chosen correctly regardless of whether a given
// backdrop happens to be light or dark — a fixed color (all-white, or all-black) only ever
// worked for one of the two cases. Accounts for the CSS brightness(0.75) filter already
// applied to the visible backdrop, so the measurement matches what's actually shown, not
// the raw source image. Falls back to null (caller defaults to white) if the image can't be
// read — e.g. if TMDB's CDN ever doesn't allow canvas pixel access for a given request.
function getImageBrightness(url, callback) {
  const img = new Image();
  img.crossOrigin = "Anonymous";
  img.onload = () => {
    try {
      const size = 20;
      const canvas = document.createElement("canvas");
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;
      let total = 0;
      for (let i = 0; i < data.length; i += 4) {
        total += 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
      }
      callback((total / (data.length / 4)) * 0.75); // *0.75 to match the CSS filter already applied when displayed
    } catch(e) { callback(null); }
  };
  img.onerror = () => callback(null);
  img.src = url;
}

// Applies the chosen text color to every element that previously had a hardcoded white (or,
// briefly, black) color when the backdrop is shown — shared so the brightness check only
// needs to run once and every affected element updates together.
function applyDetailBackdropTextColor(itemId, textColor) {
  document.querySelectorAll("#sidebar .sb-item, #sidebar .sb-section-title, #sidebar .sb-sep").forEach(el => el.style.color = textColor);
  // Unlike the others, techinfo-label's normal color comes from its own inline style
  // (color:var(--muted)), not a CSS class rule — clearing it entirely would leave it with no
  // color set at all rather than back to the correct muted gray, so "off" needs an explicit
  // value here instead of just "".
  document.querySelectorAll(`#detail-techinfo-${itemId} .techinfo-label`).forEach(el => el.style.color = textColor || "var(--muted)");
  document.querySelectorAll(".detail-director-line, .detail-meta-item, .detail-page-overview").forEach(el => el.style.color = textColor);
}

function toggleDetailBackground(itemId, btn, skipSave) {
  const bg = document.getElementById(`detail-fullbg-${itemId}`);
  const overlay = document.getElementById(`detail-fullbg-overlay-${itemId}`);
  const sidebar = document.getElementById("sidebar");
  const topbar = document.getElementById("topbar");
  if (!bg || !overlay) return;
  const isOn = bg.style.opacity === "1";
  bg.style.opacity = isOn ? "0" : "1";
  overlay.style.opacity = isOn ? "0" : "1";
  if (btn) {
    btn.style.color = isOn ? "var(--muted)" : "var(--accent, #e05724)";
    const label = isOn ? t("detail.show_background") : t("detail.hide_background");
    btn.innerHTML = `🖼 ${label}`;
    btn.title = label;
  }
  // Blend the sidebar AND topbar into the backdrop too (Plex's own background doesn't have a
  // hard edge anywhere) — made transparent only while this is on, restored the moment it's
  // turned off or the detail page closes, so it never accidentally stays see-through
  // elsewhere in the app. Both the CSS variable AND border-color are set — the divider lines
  // inside the sidebar are colored via var(--border) directly, but the sidebar's own outer
  // border turned out not to be driven by that same variable, so only handling one or the
  // other left something still visible either way.
  if (sidebar) {
    sidebar.style.background = isOn ? "" : "transparent";
    sidebar.style.borderColor = isOn ? "" : "transparent";
    if (isOn) sidebar.style.removeProperty("--border"); else sidebar.style.setProperty("--border", "transparent");
  }
  if (topbar) {
    topbar.style.background = isOn ? "" : "transparent";
    topbar.style.borderColor = isOn ? "" : "transparent";
    if (isOn) topbar.style.removeProperty("--border"); else topbar.style.setProperty("--border", "transparent");
  }
  // Same treatment for the detail page's own content area — section headings like
  // Skådespelare/Betyg och recensioner/Extramaterial have their own underline borders that
  // are just as out of place against a backdrop as the sidebar's were, and use the same
  // var(--border) mechanism.
  const detailContentEl = document.getElementById(`sec-detail`);
  if (detailContentEl) {
    if (isOn) detailContentEl.style.removeProperty("--border"); else detailContentEl.style.setProperty("--border", "transparent");
    document.querySelectorAll("#sec-detail .detail-section-title").forEach(el => el.style.borderColor = isOn ? "" : "transparent");
  }
  if (isOn) {
    // Turning off — no brightness check needed, just restore each element's normal CSS color.
    applyDetailBackdropTextColor(itemId, "");
  } else {
    // Turning on — figure out the backdrop's actual brightness before deciding text color,
    // rather than assuming. Extracted straight from the div's own inline style so this
    // doesn't need the backdrop URL passed in separately.
    const urlMatch = bg.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
    if (urlMatch) {
      getImageBrightness(urlMatch[1], (brightness) => {
        // 130 splits roughly light/dark on a 0-255 scale; null (couldn't measure) defaults
        // to white since dark backdrops have been the more common case so far.
        const isLight = brightness !== null && brightness > 130;
        applyDetailBackdropTextColor(itemId, isLight ? "#111" : "#fff");
      });
    } else {
      applyDetailBackdropTextColor(itemId, "#fff");
    }
  }
  // Remembered across navigation/refresh — this was the one thing missing before: toggling it
  // on, then switching movies or hitting F5, silently reset back to off every time.
  if (!skipSave) localStorage.setItem("sv_detail_bg_shown", isOn ? "0" : "1");
}

async function openDetail(id, fromRouter) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.getElementById("sidebar")?.style.removeProperty("background");
  document.getElementById("sidebar")?.style.removeProperty("--border");
  document.getElementById("sidebar")?.style.removeProperty("border-color");
  document.getElementById("topbar")?.style.removeProperty("background");
  document.getElementById("topbar")?.style.removeProperty("--border");
  document.getElementById("topbar")?.style.removeProperty("border-color");
  document.getElementById("sec-detail")?.style.removeProperty("--border");
  document.querySelectorAll("#sec-detail .detail-section-title").forEach(el => el.style.removeProperty("border-color"));
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
    if (!fromRouter && item.slug) {
      navigateToPath(`/${item.type === "tvshow" ? "serier" : "filmer"}/${item.slug}`, item.title);
    }
    const pct = progress?.duration ? Math.round((progress.position / progress.duration) * 100) : 0;
    const watchedMin = Math.floor((progress?.position || 0) / 60);
    const watchedLabel = watchedMin >= 60 ? `${Math.floor(watchedMin/60)}h ${watchedMin%60}m` : `${watchedMin}m`;
    const playLabel = pct > 5 && pct < 95 ? `▶ ${t("detail.continue")} (${watchedLabel})` : `▶ ${t("detail.play")}`;
    const playBtnState = pct > 5 && pct < 95 ? "continue" : "play";
    const runtime = details.runtime ? `${Math.floor(details.runtime/60)}h ${details.runtime%60}m` : "";
    const genresHtml = (details.genres||[]).slice(0, 3).join(", ") + (details.genres?.length > 3 ? t("detail.and_more") : "");
    const directors = (details.crew||[]).filter(c => c.job === "Director").map(c => esc(c.name)).join(", ");
    const castHtml = (details.cast||[]).length ? `
      <div class="detail-section">
        <h3 class="detail-section-title">${t("detail.cast")}</h3>
        ${buildCastScroll(details.cast, "cast-movie-${id}")}
      </div>` : "";
    const reviewsHtml = (details.reviews||[]).length ? `
      <div class="detail-section">
        <h3 class="detail-section-title">${t("detail.reviews")}</h3>
        <div class="cast-scroll-wrap">
          <button class="cast-scroll-btn left" onclick="document.getElementById('reviews-scroll-${id}').scrollBy({left:-320,behavior:'smooth'})">‹</button>
          <div class="cast-scroll" id="reviews-scroll-${id}">
            ${details.reviews.map(r => `
              <div style="background:var(--card2);border-radius:10px;padding:14px;width:260px;flex-shrink:0">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                  ${r.avatar ? `<img src="${r.avatar}" style="width:36px;height:36px;border-radius:50%;object-fit:cover">` : `<div style="width:36px;height:36px;border-radius:50%;background:var(--border);display:flex;align-items:center;justify-content:center">👤</div>`}
                  <div>
                    <div style="font-size:13px;font-weight:600">${esc(r.author||t("detail.anonymous"))}</div>
                    <div style="font-size:11px;color:var(--muted)">${r.date ? new Date(r.date).toLocaleDateString("sv-SE") : ""}</div>
                  </div>
                </div>
                ${r.rating ? `<div style="color:#f5c518;font-size:13px;margin-bottom:6px">${"★".repeat(Math.round(r.rating/2))}${"☆".repeat(5-Math.round(r.rating/2))}</div>` : ""}
                <div style="font-size:13px;color:var(--text);line-height:1.4">${esc(r.content||"")}</div>
              </div>`).join("")}
          </div>
          <button class="cast-scroll-btn right" onclick="document.getElementById('reviews-scroll-${id}').scrollBy({left:320,behavior:'smooth'})">›</button>
        </div>
      </div>` : "";
    let episodesHtml = "";
    if (item.type === "tvshow" && item.episodes?.length) {
      episodesHtml = `<div class="detail-section">
        <h3 class="detail-section-title">${t("detail.episodes_label")} (${item.episodes.length})</h3>
        <div class="episode-list">${item.episodes.map(ep => {
          const label = ep.season && ep.episode ? `S${String(ep.season).padStart(2,"0")} E${String(ep.episode).padStart(2,"0")}` : t("detail.episodes_label");
          return `<div class="ep-item" onclick='playItem("${ep.id}","${esc(item.title)} · ${label}")'>
            <span class="ep-num">${label}</span><span class="ep-name">${esc(ep.title||"")}</span><span>▶</span>
          </div>`;
        }).join("")}</div></div>`;
    }
    // "Visa bakgrund" — off by default (plain dark page), toggling shows the backdrop as a
    // full-page fixed background behind everything, not just a bounded strip at the top.
    sec.innerHTML = `
      <div class="detail-page">
        ${item.backdrop_url ? `<div id="detail-fullbg-${item.id}" style="position:fixed;inset:0;z-index:-1;background-size:cover;background-position:70% 25%;opacity:0;transition:opacity .3s;background-image:url('${item.backdrop_url}');filter:saturate(30%) brightness(0.75)"></div>
        <div id="detail-fullbg-overlay-${item.id}" style="position:fixed;inset:0;z-index:-1;background:rgba(0,0,0,0.5);opacity:0;transition:opacity .3s"></div>` : ""}
        <div class="detail-hero-bar" style="display:flex !important;align-items:center !important;justify-content:space-between !important;padding:14px 20px !important;position:relative !important;z-index:50 !important;background:transparent !important;margin:0 !important">
          <button class="detail-back" onclick="closeDetail()" style="position:static !important;background:var(--card2, #1a1a28);color:var(--text, #fff);border:1px solid var(--border, #333);padding:8px 16px;border-radius:8px;cursor:pointer;font-size:14px;top:auto !important;left:auto !important">← ${t("detail.back")}</button>
          ${item.backdrop_url ? `<button id="show-bg-btn-${item.id}" onclick="toggleDetailBackground('${item.id}', this)" title="${t("detail.show_background")}" style="position:static !important;display:flex;align-items:center;gap:6px;background:var(--card2, #1a1a28);color:var(--muted);border:1px solid var(--border, #333);padding:6px 12px;border-radius:8px;cursor:pointer;font-size:13px;top:auto !important;right:auto !important">🖼 ${t("detail.show_background")}</button>` : ""}
        </div>
        <div class="detail-content" style="position:relative !important;z-index:2;padding-top:115px !important;margin-top:0 !important">
          <div class="detail-main">
            <div class="detail-poster-col" style="overflow:visible !important;height:auto !important;max-height:none !important">
              ${item.poster_url ? `<img class="detail-poster" src="${item.poster_url}" alt="" style="max-width:230px;width:100%;height:auto !important;max-height:none !important;object-fit:contain">` : `<div class="detail-poster-ph" style="max-width:230px">${item.type==="tvshow"?"📺":"🎬"}</div>`}
            </div>
            <div class="detail-info-col">
              <h1 class="detail-page-title">${esc(item.title)}</h1>
              ${directors ? `<div class="detail-director-line" style="color:var(--muted);font-size:13px;margin-top:2px">${t("detail.directed_by")} ${directors}</div>` : ""}
              <div class="detail-meta-row" style="margin-top:8px">
                ${item.rating ? `<span class="detail-meta-item" style="background:#01b4e4;color:#fff;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px">⭐ TMDB ${parseFloat(item.rating).toFixed(1)}</span>` : ""}
                <span id="extra-ratings-${item.id||id}"></span>
                ${item.year ? `<span class="detail-meta-item">${item.year}</span>` : ""}
                ${runtime ? `<span class="detail-meta-item">${runtime}</span>` : ""}
                ${genresHtml ? `<span class="detail-meta-item">${esc(genresHtml)}</span>` : ""}
              </div>
              ${(details.overview || item.overview) ? `<p class="detail-page-overview">${esc(details.overview || item.overview)}</p>` : ""}
              <div class="detail-actions" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
                <button class="btn-play" data-state="${playBtnState}" onclick='playItem("${item.id}","${esc(item.title)}")' style="display:flex;align-items:center;gap:8px;padding:10px 20px">${playLabel}</button>
                <span id="like-btn-${item.id}">${pillBtn("👍", t("detail.like"), `toggleFav("${item.id}",this)`, `like-btn-inner-${item.id}`, t("detail.like_tooltip"))}</span>
                ${progress?.completed
                  ? pillBtn("↺", t("detail.unwatched"), `markUnwatched("${item.id}")`, `watched-btn-${item.id}`, t("detail.watched_tooltip"))
                  : pillBtn("✓", t("detail.watched"), `markWatched("${item.id}", ${Math.floor(progress?.duration||0)})`, `watched-btn-${item.id}`, t("detail.watched_tooltip"))}
                ${pillBtn("🎬", t("detail.trailer"), `toggleTrailer("${item.id}")`, `trailer-btn-${item.id}`, t("detail.trailer_tooltip"))}
                <div style="position:relative">
                  <button onclick="toggleDetailMoreMenu('${item.id}')" title="${t("detail.more")}" style="width:38px;height:38px;border-radius:50%;background:var(--card2, #1a1a28);border:1px solid var(--border, #333);color:var(--text, #fff);font-size:16px;cursor:pointer">⋯</button>
                  <div id="detail-more-menu-${item.id}" style="display:none;position:absolute;top:44px;left:0;background:var(--surface, #141420);border:1px solid var(--border, #333);border-radius:10px;padding:6px;z-index:10;min-width:170px;box-shadow:0 6px 20px rgba(0,0,0,0.4)">
                    <div onclick='openSubtitles("${item.id}","${esc(item.title)}")' style="padding:8px 12px;cursor:pointer;font-size:13px;border-radius:6px;display:flex;align-items:center;gap:8px">🔤 ${t("detail.subtitles_menu")}</div>
                    ${currentUser?.role === "admin" ? `<div onclick='openFixMeta("${item.id}","${esc(item.title)}","${item.type==="tvshow"?"tv":"movie"}")' style="padding:8px 12px;cursor:pointer;font-size:13px;border-radius:6px;display:flex;align-items:center;gap:8px">🔍 ${t("detail.fix_info")}</div>` : ""}
                    ${currentUser?.role === "admin" ? `<div onclick='openEditMedia("${item.id}")' style="padding:8px 12px;cursor:pointer;font-size:13px;border-radius:6px;display:flex;align-items:center;gap:8px">✏ ${t("detail.edit")}</div>` : ""}
                    ${currentUser?.role === "admin" ? `<div onclick='openMediaInfo("${item.id}")' style="padding:8px 12px;cursor:pointer;font-size:13px;border-radius:6px;display:flex;align-items:center;gap:8px">ℹ ${t("detail.fileinfo")}</div>` : ""}
                  </div>
                </div>
              </div>
              <div id="detail-techinfo-${item.id}"></div>
            </div>
          </div>
          ${castHtml}
          ${reviewsHtml}
          ${item.tmdb_id ? `<div class="detail-section" id="extras-${id}"></div>` : ""}
          ${episodesHtml}
          ${item.tmdb_id && item.type === "movie" ? `<div class="wtw-section" style="padding:0 20px 20px">
            <div id="wtw-${id}"><span style="font-size:13px;color:var(--muted)">${t("detail.loading_streaming")}</span></div>
          </div>` : ""}
          ${item.tmdb_id ? `<div class="detail-section" id="related-${id}"></div>` : ""}
        </div>
      </div>`;
    loadDetailTechInfo(item.id, item.title);
    loadExtraRatings(`extra-ratings-${item.id}`, item.title, item.year);
    loadLikeStatus(item.id);
    if (item.backdrop_url && localStorage.getItem("sv_detail_bg_shown") === "1") {
      // Restore the person's last choice — was silently forgotten before, resetting to off
      // on every new movie or page refresh regardless of what they'd picked.
      const btn = document.getElementById(`show-bg-btn-${item.id}`);
      toggleDetailBackground(item.id, btn, true);
    }
    if (item.tmdb_id && item.type === "movie") {
      API.get("/watch-providers/" + item.tmdb_id).then(data => {
        const el = document.getElementById("wtw-" + id);
        if (!el) return;
        window._wtwData = window._wtwData || {};
        window._wtwData[id] = data;
        const flatrateList = (data.flatrate||[]).map(p => ({ ...p, kind: t("detail.streaming_label") }));
        const payList = [
          ...(data.rent||[]).map(p => ({ ...p, kind: t("detail.rent") })),
          ...(data.buy||[]).map(p => ({ ...p, kind: t("detail.buy") }))
        ];
        if (!flatrateList.length && !payList.length) { el.innerHTML = ""; return; }
        const primaryList = flatrateList.length ? flatrateList : payList.slice(0, 1);
        const extraCount = flatrateList.length ? payList.length : payList.length - 1;
        // Whole card links out to the provider's own homepage where possible (curated list of
        // common services), falling back to TMDB's aggregator link for anything not in that
        // list, and finally just not being clickable if neither is available.
        const providerCard = (p) => `
            <div ${providerLink(p.name, data.link) ? `onclick="window.open('${providerLink(p.name, data.link)}','_blank')" style="cursor:pointer;` : `style="`}background:var(--card2);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px;min-width:160px">
              ${p.logo ? `<img src="${p.logo}" style="width:36px;height:36px;border-radius:6px;object-fit:cover">` : `<div style="width:36px;height:36px;border-radius:6px;background:var(--border)"></div>`}
              <div>
                <div style="font-size:13px;font-weight:600">${esc(p.name)}</div>
                <div style="font-size:11px;color:var(--muted)">${esc(p.kind)}</div>
              </div>
            </div>`;
        el.innerHTML = `
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">${t("detail.more_ways_to_watch")}</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            ${primaryList.map(providerCard).join("")}
            ${extraCount > 0 ? `<div onclick="openWatchProvidersModal('${id}')" style="background:var(--card2);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer;min-width:120px">
              <span style="font-size:20px">☰</span>
              <span style="font-size:13px;color:var(--muted)">${t("detail.more_count").replace("{n}", extraCount)}</span>
            </div>` : ""}
          </div>`;
      }).catch(()=>{});
    }
    if (item.tmdb_id) {
      API.get("/media/" + id + "/extras").then(data => {
        const el = document.getElementById("extras-" + id);
        if (!el || !data.extras || !data.extras.length) return;
        el.innerHTML = `
          <h3 class="detail-section-title">${t("detail.extras")}</h3>
          <div class="cast-scroll-wrap">
            <button class="cast-scroll-btn left" onclick="document.getElementById('extras-scroll-${id}').scrollBy({left:-300,behavior:'smooth'})">‹</button>
            <div class="cast-scroll" id="extras-scroll-${id}">
              ${data.extras.map(v => `
                <div style="width:220px;flex-shrink:0;cursor:pointer" onclick='openTrailerModal("${v.key}","${esc(v.name).replace(/"/g,"&quot;")}")'>
                  <div style="position:relative;border-radius:8px;overflow:hidden">
                    <img src="${v.thumbnail}" style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block">
                    <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.25);font-size:28px;color:#fff">▶</span>
                  </div>
                  <div style="font-size:13px;font-weight:600;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(v.name)}</div>
                  <div style="font-size:11px;color:var(--muted)">${esc(v.type)}</div>
                </div>`).join("")}
            </div>
            <button class="cast-scroll-btn right" onclick="document.getElementById('extras-scroll-${id}').scrollBy({left:300,behavior:'smooth'})">›</button>
          </div>`;
      }).catch(()=>{});
    }
    if (item.tmdb_id) {
      API.get("/media/" + id + "/related").then(data => {
        const el = document.getElementById("related-" + id);
        if (!el || !data.items || !data.items.length) return;
        const label = item.type === "tvshow" ? t("detail.similar_shows") : t("detail.similar_movies");
        el.innerHTML = `
          <h3 class="detail-section-title">${label}</h3>
          <div class="cast-scroll-wrap">
            <button class="cast-scroll-btn left" onclick="document.getElementById('related-scroll-${id}').scrollBy({left:-300,behavior:'smooth'})">‹</button>
            <div class="cast-scroll" id="related-scroll-${id}">
              ${data.items.map(r => `
                <div class="mcard" style="width:140px;flex-shrink:0;position:relative" onclick='${r.owned ? `openDetail("${r.id}")` : `openTmdbDetail(${r.tmdb_id}, "${r.type === "tvshow" ? "tv" : "movie"}")`}'>
                  ${r.owned ? `<span style="position:absolute;top:6px;right:6px;background:rgba(46,204,113,0.9);color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;z-index:2">✓ I biblioteket</span>` : ""}
                  ${r.poster_url
                    ? `<img class="mcard-poster" src="${r.poster_url}" alt="" loading="lazy">`
                    : `<div class="mcard-poster-ph"><span>${r.type==="tvshow"?"📺":"🎬"}</span><span>${esc((r.title||"").slice(0,14))}</span></div>`}
                  <div class="mcard-info">
                    <div class="mcard-title">${esc(r.title||"")}</div>
                  </div>
                </div>`).join("")}
            </div>
            <button class="cast-scroll-btn right" onclick="document.getElementById('related-scroll-${id}').scrollBy({left:300,behavior:'smooth'})">›</button>
          </div>`;
      }).catch(()=>{});
    }
  } catch(e) {
    sec.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>${e.message}</h3></div>`;
  }
}

function closeDetail() {
  // Goes back one REAL step in the browsing history (whatever library/search/collection the
  // person actually came from) instead of always landing on home regardless of where they
  // started. Works because every "open X" action already pushes a proper history entry —
  // this just uses the same mechanism the browser's own back button already uses correctly.
  history.back();
}



async function openPersonDetail(tmdbPersonId, fromRouter) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  const sec = document.getElementById("sec-detail");
  if (sec) { sec.classList.add("active"); sec.innerHTML = `<div class="spinner-wrap" style="height:60vh"><div class="spinner"></div></div>`; }
  try {
    const data = await API.get("/person/" + tmdbPersonId);
    if (!fromRouter) navigateToPath(`/personer/${clientSlugify(data.name)}-${tmdbPersonId}`, data.name + " - StreamVault");
    const inLib = data.credits.filter(c => c.in_library);
    const notLib = data.credits.filter(c => !c.in_library);
    const notLibMovies = notLib.filter(c => c.media_type !== "tv");
    const notLibShows = notLib.filter(c => c.media_type === "tv");
    // TMDB's known_for_department always comes back in English ("Acting", "Directing", ...)
    // — translated via a fixed lookup since it's one of a known, small set of values, same
    // idea as translating a status code rather than freeform text.
    const DEPT_KEYS = { "Acting":"person.dept_acting", "Directing":"person.dept_directing", "Writing":"person.dept_writing", "Production":"person.dept_production", "Sound":"person.dept_sound", "Camera":"person.dept_camera", "Editing":"person.dept_editing", "Art":"person.dept_art", "Costume & Make-Up":"person.dept_costume", "Crew":"person.dept_crew" };
    const knownForLabel = data.known_for ? t(DEPT_KEYS[data.known_for] || data.known_for) : "";
    sec.innerHTML = `
      <div class="detail-page">
        <div class="person-hero" style="padding-top:20px">
          <button onclick="history.back()" style="background:var(--card2, #1a1a28);color:var(--text, #fff);border:1px solid var(--border, #333);padding:8px 16px;border-radius:8px;cursor:pointer;font-size:14px;display:inline-block;margin-bottom:20px">← ${t("detail.back")}</button>
          <div class="person-info">
            ${data.profile_url ? `<img class="person-photo" src="${data.profile_url}" alt="">` : `<div class="person-photo-ph">👤</div>`}
            <div>
              <h1 class="detail-page-title">${esc(data.name)}</h1>
              <div class="detail-meta-row" style="display:flex;gap:10px;flex-wrap:wrap">
                ${knownForLabel ? `<span class="detail-meta-item">${esc(knownForLabel)}</span>` : ""}
                ${data.birthday ? `<span class="detail-meta-item">${t("person.born")} ${data.birthday}</span>` : ""}
              </div>
              ${data.biography ? (data.biography.length > 400 ? `
              <p class="person-bio">
                <span id="bio-short">${esc(truncateAtWord(data.biography, 400))}</span><span id="bio-full" style="display:none">${esc(data.biography)}</span>
                <a href="#" onclick="event.preventDefault(); toggleBio()" id="bio-toggle-link" style="color:var(--accent);cursor:pointer;margin-left:4px;white-space:nowrap">${t("person.show_more")}</a>
              </p>` : `<p class="person-bio">${esc(data.biography)}</p>`) : ""}
            </div>
          </div>
        </div>
        <div class="detail-content">
          ${inLib.length ? `
          <div class="detail-section">
            <h3 class="detail-section-title">${t("person.in_your_library")}</h3>
            <div class="cast-scroll">
              ${[...new Map(inLib.map(m => [m.tmdb_id, m])).values()].map(m => `
                <div class="lib-film-card" onclick="findAndOpenByTmdb(${m.tmdb_id})">
                  <img class="lib-film-poster" src="${m.poster_url}" alt="" loading="lazy">
                  <div class="cast-name">${esc(m.title)}</div>
                  <div class="cast-char">${m.year||""}</div>
                </div>`).join("")}
            </div>
          </div>` : ""}
          ${notLibMovies.length ? `
          <div class="detail-section">
            <h3 class="detail-section-title">${t("person.movies_by").replace("{name}", esc(data.name))}</h3>
            <div class="cast-scroll">
              ${notLibMovies.slice(0,15).map(m => `
                <div class="cast-card" style="opacity:0.75" onclick='openTmdbDetail(${m.tmdb_id}, "movie")'>
                  <img class="cast-photo" src="${m.poster_url}" alt="" loading="lazy">
                  <div class="cast-name">${esc(m.title)}</div>
                  <div class="cast-char">${m.year||""}</div>
                </div>`).join("")}
            </div>
          </div>` : ""}
          ${notLibShows.length ? `
          <div class="detail-section">
            <h3 class="detail-section-title">${t("person.shows_by").replace("{name}", esc(data.name))}</h3>
            <div class="cast-scroll">
              ${notLibShows.slice(0,15).map(m => `
                <div class="cast-card" style="opacity:0.75" onclick='openTmdbDetail(${m.tmdb_id}, "tv")'>
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

// Opens a centered, focused trailer modal (TMDB-style) — same YouTube embed as before, just
// presented as an overlay instead of inline in the page. Click outside, press Escape, or hit
// the ✕ to close.
// Same as toggleTrailer, but for a title found via search that isn't owned — looked up by
// raw TMDB ID instead of our own media ID.
async function toggleTrailerByTmdb(tmdbId, kind) {
  const btn = document.getElementById("trailer-btn-tmdb-" + tmdbId);
  if (!btn) return;
  const original = btn.textContent;
  btn.textContent = "⏳ Laddar...";
  try {
    const data = await API.get(`/tmdb/trailer/${kind}/${tmdbId}`);
    if (!data.key) {
      toast("Ingen trailer hittades för den här titeln", "info");
      btn.textContent = original;
      return;
    }
    openTrailerModal(data.key, data.name);
    btn.textContent = original;
  } catch(e) {
    toast("Kunde inte hämta trailer: " + e.message, "error");
    btn.textContent = original;
  }
}

async function toggleTrailer(id) {
  const btn = document.getElementById("trailer-btn-" + id);
  if (!btn) return;
  const original = btn.textContent;
  btn.textContent = "⏳ Laddar...";
  try {
    const data = await API.get("/media/" + id + "/trailer");
    if (!data.key) {
      toast("Ingen trailer hittades för den här titeln", "info");
      btn.textContent = original;
      return;
    }
    openTrailerModal(data.key, data.name);
    btn.textContent = original;
  } catch(e) {
    toast("Kunde inte hämta trailer: " + e.message, "error");
    btn.textContent = original;
  }
}

function openTrailerModal(youtubeKey, name) {
  const overlay = document.createElement("div");
  overlay.id = "trailer-modal-overlay";
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px";
  overlay.innerHTML = `
    <div style="width:100%;max-width:900px;position:relative">
      <button onclick="closeTrailerModal()" style="position:absolute;top:-42px;right:0;background:none;border:none;color:#fff;font-size:28px;cursor:pointer;line-height:1;padding:4px 8px" title="Stäng (Esc)">✕</button>
      <div style="position:relative;padding-top:56.25%;border-radius:10px;overflow:hidden;background:#000;box-shadow:0 20px 60px rgba(0,0,0,0.6)">
        <iframe src="https://www.youtube.com/embed/${youtubeKey}?autoplay=1" title="${esc(name||"Trailer")}"
          style="position:absolute;top:0;left:0;width:100%;height:100%;border:0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
      </div>
    </div>`;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeTrailerModal(); });
  document.body.appendChild(overlay);
  document.addEventListener("keydown", _trailerModalEscHandler);
}

function _trailerModalEscHandler(e) {
  if (e.key === "Escape") closeTrailerModal();
}

function closeTrailerModal() {
  const overlay = document.getElementById("trailer-modal-overlay");
  if (overlay) overlay.remove();
  document.removeEventListener("keydown", _trailerModalEscHandler);
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
        <div style="font-weight:600;font-size:13px;margin-bottom:6px">🔊 Spår ${i+1} – ${esc(a.display_title||"")}</div>
        ${infoRow("Codec",a.codec)} ${infoRow("Kanaler",a.channels)} ${infoRow("Kanallayout",a.channel_layout)} ${infoRow("Bitrate",a.bitrate)}
        ${infoRow("Samplingsfrekvens",a.sampling_rate)} ${infoRow("Språk",a.language?.toUpperCase())} ${infoRow("Språktagg",a.language_tag)}
        ${a.title ? infoRow("Titel",a.title) : ""}
      </div>`).join("") || "<p style='color:var(--muted);font-size:13px'>Inga ljudspår hittades</p>";
    const subHtml = (item.subtitles||[]).length ? (item.subtitles||[]).map((s,i) => `
      <div style="background:var(--card2);border-radius:8px;padding:12px;margin-bottom:8px">
        <div style="font-weight:600;font-size:13px;margin-bottom:6px">💬 Spår ${i+1} – ${esc(s.display_title||"")} ${s.default?"[Standard]":""}</div>
        ${infoRow("Format",s.codec)} ${infoRow("Tvingad",s.forced?"Ja":"Nej")} ${infoRow("Språk",s.language?.toUpperCase())} ${infoRow("Språktagg",s.language_tag)}
        ${s.title ? infoRow("Titel",s.title) : ""}
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
            ${v ? esc(v.display_title||"") ? `<div style="font-size:12px;color:var(--accent,#e05724);margin-bottom:8px;font-weight:600">${esc(v.display_title)}</div>` : "" : ""}
            ${infoRow("Codec",v?.codec)} ${infoRow("Profil",v?.profile)} ${infoRow("Nivå",v?.level)}
            ${infoRow("Upplösning",v?.resolution_label)} ${infoRow("Bredd",v?.width)} ${infoRow("Höjd",v?.height)}
            ${infoRow("Kodad bredd",v?.coded_width)} ${infoRow("Kodad höjd",v?.coded_height)}
            ${infoRow("Bildförhållande",v?.aspect_ratio)} ${infoRow("Bildhastighet",v?.fps?v.fps+" fps":"–")}
            ${infoRow("Bitrate",v?.bitrate)} ${infoRow("Bitdjup",v?.bit_depth?v.bit_depth+" bit":"–")}
            ${infoRow("Färgrymd",v?.color_space)} ${infoRow("Färgomfång",v?.color_range)} ${infoRow("Färgöverföring",v?.color_transfer)} ${infoRow("Färgprimärer",v?.color_primaries)}
            ${infoRow("Chroma-plats",v?.chroma_location)} ${infoRow("Chroma-subsampling",v?.chroma_subsampling)}
            ${infoRow("Referensbilder",v?.ref_frames)} ${infoRow("Språk",v?.language?.toUpperCase())}
          </div>
          <div><div class="info-section-title">Ljud</div>${audioHtml}</div>
          <div><div class="info-section-title">Undertexter</div>${subHtml}</div>
          <div>
            <div class="info-section-title">Container</div>
            ${infoRow("Format",item.container?.format)} ${infoRow("Bitrate",item.container?.bitrate)}
          </div>
          <div style="text-align:center">
            <a href="#" onclick="event.preventDefault(); showRawFileInfo('${id}')" style="color:var(--accent,#e05724);font-size:12px;text-decoration:none">Visa rådata (JSON)</a>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  } catch(e) { toast("Kunde inte hämta info: " + e.message, "error"); }
}

async function showRawFileInfo(id) {
  try {
    const raw = await API.get("/media/" + id + "/fileinfo/raw");
    const modal = document.createElement("div");
    modal.id = "raw-fileinfo-modal";
    modal.style.cssText = "position:fixed;inset:0;z-index:600;background:rgba(0,0,0,0.9);display:flex;align-items:center;justify-content:center;padding:24px";
    modal.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:800px;max-height:85vh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
          <span style="font-weight:700">Rådata (ffprobe)</span>
          <button onclick="document.getElementById('raw-fileinfo-modal').remove()" style="margin-left:auto;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer">✕</button>
        </div>
        <pre style="padding:16px;overflow:auto;font-size:11px;color:var(--text);margin:0;white-space:pre-wrap;word-break:break-all">${esc(JSON.stringify(raw, null, 2))}</pre>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  } catch(e) { toast("Kunde inte hämta rådata: " + e.message, "error"); }
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
      btn.innerHTML = `↺ ${t("detail.unwatched")}`;
      btn.onclick = () => markUnwatched(id);
    }
    toast(t("toast.marked_watched"), "success");
    loadHome(); // Refresh cards
  } catch { toast(t("toast.save_failed"), "error"); }
}

async function markUnwatched(id) {
  try {
    await API.post("/media/" + id + "/progress", { position: 0, duration: 0, completed: 0 });
    const btn = document.getElementById("watched-btn-" + id);
    if (btn) {
      btn.innerHTML = `✓ ${t("detail.watched")}`;
      btn.onclick = () => markWatched(id, 0);
    }
    // Update play button label to remove % indicator — checks a data attribute rather than
    // matching translated text, since comparing against a hardcoded Swedish substring would
    // silently fail to reset the button on any other language.
    const playBtn = document.querySelector(".btn-play");
    if (playBtn && playBtn.dataset.state === "continue") {
      playBtn.textContent = `▶ ${t("detail.play")}`;
      playBtn.dataset.state = "play";
    }
    toast(t("toast.marked_unwatched"), "success");
    loadHome(); // Refresh cards
  } catch { toast(t("toast.save_failed"), "error"); }
}
document.getElementById("detail-overlay")?.addEventListener("click", e => {
  if (e.target === document.getElementById("detail-overlay")) closeDetail();
});

async function toggleFav(id, btn) {
  try {
    const data = await API.post("/favorites/" + id, {});
    if (data.liked) {
      btn.innerHTML = `👍 ${t("detail.liked")}`;
      btn.style.color = "var(--accent2, #e05724)";
      btn.style.borderColor = "var(--accent2, #e05724)";
      toast(t("toast.added_to_liked"), "success");
    } else {
      btn.innerHTML = `👍 ${t("detail.like")}`;
      btn.style.color = "";
      btn.style.borderColor = "";
      toast(t("toast.removed"), "info");
    }
  } catch { toast(t("toast.save_error"), "error"); }
}

async function loadLikeStatus(itemId) {
  const wrap = document.getElementById(`like-btn-${itemId}`);
  const btn = document.getElementById(`like-btn-inner-${itemId}`);
  if (!wrap || !btn) return;
  try {
    const data = await API.get(`/favorites/${itemId}/status`);
    if (data.liked) {
      btn.innerHTML = `👍 ${t("detail.liked")}`;
      btn.style.color = "var(--accent2, #e05724)";
      btn.style.borderColor = "var(--accent2, #e05724)";
    }
  } catch {}
}

// ── PLAYBACK ──────────────────────────────────────────────────────────────────
let currentHls = null;
window._iptvPlaying = false; // lets closePlayer() know to skip movie-specific cleanup (DASH stop call, subtitle overlay) that doesn't apply to a live channel

// Plays an IPTV channel in the SAME main player used for movies/shows (full-area takeover,
// same controls bar) instead of a separate floating modal — reuses player-bar/main-video
// directly. No resume position, no subtitles, no DASH transcode: those are VOD concepts that
// don't apply to a live stream.
async function playIptvChannelInPlayer(name, url) {
  const bar = document.getElementById("player-bar");
  const video = document.getElementById("main-video");
  if (!bar || !video) return;

  if (currentItemId || currentHls) {
    if (currentHls) { try { currentHls.destroy(); } catch {} currentHls = null; }
    if (window._dashPlayer) { try { window._dashPlayer.reset(); } catch {} window._dashPlayer = null; }
    if (currentItemId && !window._iptvPlaying) API.post("/dash/" + currentItemId + "/stop").catch(() => {});
  }

  window._iptvPlaying = true;
  currentItemId = null;
  nowPlayingId = null;
  bar.style.display = "flex";
  document.getElementById("pb-title").textContent = name;
  document.getElementById("pb-sub").textContent = "📡 Live";
  document.body.style.paddingBottom = "320px";
  resetFillScreen();
  ensureFillScreenButton();
  bar.style.overflow = "hidden";

  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  if (isSafari) {
    video.src = url;
    video.play().catch(() => {});
    return;
  }
  try {
    await ensureHlsJs();
    if (window.Hls.isSupported()) {
      currentHls = new window.Hls();
      currentHls.loadSource(url);
      currentHls.attachMedia(video);
      currentHls.on(window.Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
      currentHls.on(window.Hls.Events.ERROR, (event, data) => {
        console.log("[IPTV] HLS.js error:", JSON.stringify({ type: data.type, details: data.details, fatal: data.fatal }));
        if (data.fatal) document.getElementById("pb-sub").textContent = "⚠️ Kunde inte spela strömmen";
      });
      return;
    }
  } catch(e) {
    console.log("[IPTV] Could not set up HLS.js:", e.message);
  }
  video.src = url; // last-resort fallback
  video.play().catch(() => {});
}

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

// Shows a modal asking whether to continue from the saved position or start over, and
// resolves with the chosen start second (0 for "start over"). Used by playItem() whenever
// there's a meaningful saved position to resume from.
function askResumeChoice(savedSec) {
  return new Promise((resolve) => {
    const min = Math.floor(savedSec / 60);
    const label = min >= 60 ? `${Math.floor(min/60)}h ${min%60}m` : `${min}m`;
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center";
    overlay.innerHTML = `
      <div style="background:var(--card2);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:340px;width:90%;text-align:center;position:relative">
        <button id="resume-close-btn" style="position:absolute;top:10px;right:10px;background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;line-height:1;padding:4px" title="${t("resume.cancel")}">✕</button>
        <div style="font-size:15px;margin-bottom:20px">${t("resume.question").replace("{label}", label)}</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <button id="resume-continue-btn" class="s-btn primary">${t("resume.continue").replace("{label}", label)}</button>
          <button id="resume-restart-btn" class="s-btn">${t("resume.restart")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    function cleanup(sec) { overlay.remove(); resolve(sec); }
    // null is a distinct "cancelled, don't play at all" signal — separate from 0, which
    // means "play from the start" (a real, valid choice, not a cancellation).
    overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(null); });
    overlay.querySelector("#resume-close-btn").onclick = () => cleanup(null);
    overlay.querySelector("#resume-continue-btn").onclick = () => cleanup(savedSec);
    overlay.querySelector("#resume-restart-btn").onclick = () => cleanup(0);
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
  // Fill-screen (letterbox-aware zoom) is per-file — never carry a previous movie's zoom
  // state into a new one, and re-check the button exists (controls markup is static HTML).
  resetFillScreen();
  ensureFillScreenButton();
  bar.style.overflow = "hidden"; // so a fill-screen zoom crops visually instead of overflowing
  currentItemId = id;

  // Check for a meaningful saved position BEFORE fetching playback info / starting anything,
  // so we can ask the user what they want instead of silently always resuming.
  let progress;
  try { progress = await API.get("/media/" + id + "/progress"); } catch { progress = { position: 0 }; }
  const hasDur = progress?.duration > 0;
  const notDone = !hasDur || (progress.position / progress.duration) < 0.95;
  const savedResumeSec = (progress?.position > 10 && notDone) ? Math.floor(progress.position) : 0;
  const resumeSec = savedResumeSec > 0 ? await askResumeChoice(savedResumeSec) : 0;
  if (resumeSec === null) return; // person closed the popup instead of choosing — don't start playback at all

  try {
    // Ask server: direct play or HLS?
    const info = await API.get("/playback/" + id + "?token=" + encodeURIComponent(token));
    document.getElementById("pb-sub").textContent = "";
    // From the server's already-cached probe — used by fill-screen instead of the <video>
    // element's own videoWidth/videoHeight, which aren't populated until the browser has
    // loaded enough of the stream to read metadata (a race if fill-screen is clicked early).
    window._currentVideoDims = { width: info.videoWidth || 0, height: info.videoHeight || 0 };

    console.log("[RESUME] position:", progress?.position, "duration:", progress?.duration, "resumeSec:", resumeSec);
    // NOTE: subtitles are NOT auto-loaded here anymore. Loading them before we know whether
    // playback will be direct or DASH caused a race: DASH resets the video's local clock to
    // 0 on resume, so a subtitle activated with no offset (absolute timestamps) could win the
    // race against the correctly-offset load below, leaving captions off by exactly the
    // resume position. Direct play loads its subtitles right after `video.src` is set below;
    // DASH loads its (offset-aware) subtitles via _pendingSubtitleLoad once the first frame
    // is captured, further down.

    if (info.method === "direct") {
      video.src = info.url;
      video.play().catch(() => {});
      autoLoadSubtitles(id); // safe here: direct play's video.currentTime matches the real position, no offset needed
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
              bufferTimeAtTopQuality: 12,
              bufferToKeep: 8,
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

        // Auto-resume on DEMUXER_UNDERFLOW (Chrome HDR issue)
        // Only activate after video has been playing for 30+ seconds
        let _lowReadyStateCount = 0;
        let _stallMonitorActive = false;
        setTimeout(() => { _stallMonitorActive = true; }, 30000);
        const _stallMonitor = setInterval(() => {
          const video = document.getElementById("main-video");
          if (!video || video.paused || video.ended || !_stallMonitorActive) return;
          if (video.currentTime < 10) return; // Don't trigger during initial buffering
          if (video.readyState <= 2) {
            _lowReadyStateCount++;
            if (_lowReadyStateCount >= 3) {
              console.log("[DASH] DEMUXER_UNDERFLOW recovery: seeking +2s at", Math.round(video.currentTime));
              _lowReadyStateCount = 0;
              video.currentTime += 2;
            }
          } else {
            _lowReadyStateCount = 0;
          }
        }, 1000);

        player.on(dashjs.MediaPlayer.events.ERROR, (e) => { clearInterval(_stallMonitor); });
        // Wait for MANIFEST_PARSED then sample currentTime to find true start value
        // Edge caches old currentTime; dash.js resets it after manifest loads
        // Position tracked via wall clock timer, not video.currentTime
        window._dashPlayer = player;
        // Ensure video is not muted (Edge auto-mutes on stream start)
        setTimeout(function() {
          var video = document.getElementById("main-video");
          if (video) { video.muted = false; }
        }, 500);
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
          completed: pct > ((window._watchedThresholdPct || 90) / 100) ? 1 : 0
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

      var audioBtn = document.createElement("button");
      audioBtn.className = "ctrl-btn";
      audioBtn.id = "ctrl-audio";
      audioBtn.textContent = "🎚️";
      audioBtn.title = "Ljudspår";
      audioBtn.onclick = toggleAudioTrackMenu;
      fsBtn.parentNode.insertBefore(audioBtn, subBtn);
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

// Injects the "Fyll skärmen" toggle into the static player controls markup, once per
// player-bar lifetime (idempotent — safe to call on every playItem()).
function ensureFillScreenButton() {
  var controls = document.querySelector("#custom-controls .ctrl-row");
  if (!controls || document.getElementById("fill-screen-btn")) return;
  var btn = document.createElement("button");
  btn.className = "ctrl-btn";
  btn.id = "fill-screen-btn";
  btn.onclick = toggleFillScreen;
  var fsBtn = controls.querySelector("[onclick*='toggleFullscreen']");
  if (fsBtn) controls.insertBefore(btn, fsBtn); else controls.appendChild(btn);
  setFillScreenBtnState("idle");

  // Separate, much simpler alternative: stretch the whole picture (including any black
  // bars) to fill the screen, distorting the aspect ratio — same as the "Stretch"/"Panorama"
  // mode on most TVs. No analysis needed, purely cosmetic, entirely the viewer's own call
  // (unlike the smart zoom button, this one WILL warp people/objects if used on genuine
  // widescreen content — that trade-off is exactly the point of offering it as a separate,
  // explicit option instead of folding it into the "smart" button).
  var stretchBtn = document.createElement("button");
  stretchBtn.className = "ctrl-btn";
  stretchBtn.id = "stretch-btn";
  stretchBtn.title = "Sträck ut bilden för att fylla skärmen (förvränger proportionerna — inte smart, bara sträcker rakt av)";
  stretchBtn.textContent = "↔️";
  stretchBtn.onclick = toggleStretch;
  if (fsBtn) controls.insertBefore(stretchBtn, fsBtn); else controls.appendChild(stretchBtn);
}

var _stretchActive = false;
function toggleStretch() {
  var video = document.getElementById("main-video");
  if (!video) return;
  _stretchActive = !_stretchActive;
  video.style.objectFit = _stretchActive ? "fill" : "";
  var btn = document.getElementById("stretch-btn");
  if (btn) btn.classList.toggle("active", _stretchActive);
}

// Single source of truth for both the button's icon AND its hover tooltip, so you can always
// tell what's going on just by hovering — no need to click and guess.
function setFillScreenBtnState(state, extra) {
  var btn = document.getElementById("fill-screen-btn");
  if (!btn) return;
  var labels = {
    idle:       { text: "⛶+", title: "Fyll skärmen — av. Klicka för att kolla om filmen har inbäddade svarta kanter att zooma bort." },
    checking:   { text: "⏳" + (extra ? " " + extra : ""), title: "Analyserar bildformat" + (extra ? " (försök " + extra + ")" : "") + " — kan ta upp till 30 sekunder första gången för just den här filmen." },
    active:     { text: "⛶+", title: "Fyll skärmen — PÅ. Inbäddad svart kant borttagen. Klicka för att stänga av." },
    none_found: { text: "⛶+", title: "Fyll skärmen — av. Ingen inbäddad svart kant hittades i den här filmen (troligen genuint bredbildsformat, går inte att fylla utan att klippa bild)." },
    error:      { text: "⛶+", title: "Fyll skärmen — kunde inte analysera den här filens bildformat. Klicka för att försöka igen." }
  };
  var l = labels[state] || labels.idle;
  btn.textContent = l.text;
  btn.title = l.title;
  btn.classList.toggle("active", state === "active");
}

var _fillScreenActive = false;
var _fillScreenPending = false;

function resetFillScreen() {
  _fillScreenActive = false;
  _fillScreenPending = false;
  var video = document.getElementById("main-video");
  if (video) { video.style.transform = ""; video.style.transformOrigin = ""; }
  setFillScreenBtnState("idle");
  _stretchActive = false;
  if (video) video.style.objectFit = "";
  var stretchBtn = document.getElementById("stretch-btn");
  if (stretchBtn) stretchBtn.classList.remove("active");
}

async function toggleFillScreen() {
  if (_fillScreenActive) { resetFillScreen(); return; }
  if (_fillScreenPending || !nowPlayingId) return;
  _fillScreenPending = true;
  setFillScreenBtnState("checking");
  try {
    await applyFillScreen(nowPlayingId, 0);
  } finally {
    _fillScreenPending = false;
  }
}

// Fetches the (possibly-not-yet-computed) letterbox layout and applies a CSS zoom that crops
// exactly the detected black bars — not a blind aspect-ratio guess — so genuine widescreen
// content never gets cropped by mistake. Polls a few times if the server is still analyzing
// this file for the first time.
async function applyFillScreen(mediaId, attempt) {
  try {
    var data = await API.get("/media/" + mediaId + "/video-layout");
    if (data.status === "computing") {
      if (mediaId !== nowPlayingId) { setFillScreenBtnState("idle"); return; } // user moved to a different title, quietly drop it
      if (attempt >= 6) {
        toast("Kunde inte analysera filmen i tid — försök igen om en liten stund", "info");
        setFillScreenBtnState("error");
        return;
      }
      setFillScreenBtnState("checking", (attempt + 1) + "/6");
      await new Promise(function(r) { setTimeout(r, (data.retryAfter || 5) * 1000); });
      return applyFillScreen(mediaId, attempt + 1);
    }
    var pic = data.activePicture;
    var video = document.getElementById("main-video");
    if (!pic || !video || !pic.width || !pic.height) {
      toast("Kunde inte analysera bildformatet för den här filen", "error");
      setFillScreenBtnState("error");
      return;
    }
    var dims = window._currentVideoDims || {};
    var fullW = dims.width || video.videoWidth || pic.width;
    var fullH = dims.height || video.videoHeight || pic.height;
    var scale = Math.max(fullW / pic.width, fullH / pic.height);
    if (scale <= 1.01) {
      // No meaningful letterboxing detected — nothing to zoom, don't pretend otherwise
      toast("Ingen inbäddad svart kant hittades att zooma bort — filmen är troligen genuint bredbild", "info");
      setFillScreenBtnState("none_found");
      return;
    }
    video.style.transform = "scale(" + scale.toFixed(4) + ")";
    video.style.transformOrigin = "center center";
    _fillScreenActive = true;
    setFillScreenBtnState("active");
    toast("✓ Zoomade bort inbäddad svart kant", "success");
  } catch(e) {
    toast("Fel vid analys av bildformat: " + e.message, "error");
    setFillScreenBtnState("error");
  }
}

document.addEventListener("fullscreenchange", function() {
  var bar = document.getElementById("player-bar");
  var controls = document.getElementById("custom-controls");
  var subOverlay = document.getElementById("sv-subtitle-overlay");
  if (document.fullscreenElement) {
    bar.addEventListener("mousemove", showFsControls);
    bar.addEventListener("click", showFsControls);
    showFsControls();
    // Move subtitle overlay into fullscreen element so position:fixed works
    if (subOverlay && bar) bar.appendChild(subOverlay);
  } else {
    clearTimeout(_fsHideTimer);
    if (controls) controls.style.opacity = "1";
    if (bar) { bar.removeEventListener("mousemove", showFsControls); bar.removeEventListener("click", showFsControls); bar.style.cursor = "default"; }
    // Move subtitle overlay back to body
    if (subOverlay) document.body.appendChild(subOverlay);
  }
  // Reposition overlay after fullscreen change
  if (window._subtitleOverlayResize) window._subtitleOverlayResize();
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

  // Manual sync adjustment — nudges the currently active subtitle's timing, no reload needed.
  // Only meaningful once a subtitle is actually playing, but harmless to show always (the
  // adjust function just tells you if nothing's active yet).
  var syncRow = document.createElement("div");
  syncRow.style.cssText = "padding:10px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)";
  syncRow.innerHTML = `
    <span>Synk:</span>
    <button class="btn-fav" style="font-size:12px;padding:4px 10px" onclick="adjustSubtitleSync(-0.5)">−0.5s</button>
    <button class="btn-fav" style="font-size:12px;padding:4px 10px" onclick="adjustSubtitleSync(-0.1)">−0.1s</button>
    <span id="sv-sync-offset-display" style="min-width:40px;text-align:center;color:var(--text)">${(window._subtitleSyncOffset || 0).toFixed(1)}s</span>
    <button class="btn-fav" style="font-size:12px;padding:4px 10px" onclick="adjustSubtitleSync(0.1)">+0.1s</button>
    <button class="btn-fav" style="font-size:12px;padding:4px 10px" onclick="adjustSubtitleSync(0.5)">+0.5s</button>
    <button class="btn-fav" style="font-size:12px;padding:4px 10px;margin-left:auto" onclick="resetSubtitleSync()">Nollställ</button>
  `;
  modal.appendChild(syncRow);

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
  // Populated from the household's language list (same one that governs subtitle caching),
  // plus the logged-in user's own language if it isn't already on that list — so someone
  // like a Norwegian guest isn't stuck with only Swedish/English options. Falls back to
  // those two if the list hasn't loaded yet for some reason.
  var langOptions = (window._subtitleSearchLanguages && window._subtitleSearchLanguages.length)
    ? window._subtitleSearchLanguages
    : [{ code: "sv", label: "Svenska" }, { code: "en", label: "English" }];
  langOptions.forEach(function(l) {
    var opt = document.createElement("option");
    opt.value = l.code; opt.textContent = l.label;
    langSelect.appendChild(opt);
  });
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
    removeBtn.onclick = function() { stopSubtitleOverlay(); _currentSubtitleTrack = null; _activeSubtitleUrl = null; overlay.remove(); toast("Undertext borttagen", "info"); };
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
          var isActiveSub = _activeSubtitleUrl && s.url && subtitleIdentityUrl(s.url) === _activeSubtitleUrl;
          btn.textContent = isActiveSub ? "✅ Aktiv" : "Aktivera";
          btn.style.cssText = isActiveSub
            ? "background:#1a7a3c;border:none;color:#4eff8a;font-size:12px;padding:6px 12px;border-radius:6px;cursor:default;font-weight:700"
            : "background:var(--accent);border:none;color:white;font-size:12px;padding:6px 12px;border-radius:6px;cursor:pointer";
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

// Admin-only: shows recent subtitle-cache log entries (successes, warnings, failures)
// so it's easy to see what went wrong, for which file, and when.
// Server-wide log viewer — everything (all console output + every API request), unlike the
// subtitle-specific log above which stays focused on just subtitle events. Filters via ?q=
// server-side so filtering a large buffer doesn't have to happen in the browser.
async function checkDependencyUpdates() {
  const el = document.getElementById("dependency-results");
  if (!el) return;
  el.innerHTML = "<div style='color:var(--muted);font-size:13px'>⏳ Söker efter uppdateringar (kan ta en stund)...</div>";
  try {
    const data = await API.get("/admin/dependency-check");
    window._lastDependencyCheck = data;
    let html = "";

    if (data.nodeUpdate) {
      html += `
        <div style="background:var(--card2);border:1px solid #e0a030;border-radius:8px;padding:12px 14px;margin-bottom:14px">
          <div style="font-weight:600;margin-bottom:4px">⚠️ Ny Node.js-version tillgänglig</div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Du kör v${esc(data.nodeUpdate.current)} — senaste LTS är v${esc(data.nodeUpdate.latest)} (${esc(data.nodeUpdate.ltsName)}). Installeras aldrig automatiskt.</div>
          <div style="font-size:12px;line-height:1.6">
            <b>Så uppdaterar du manuellt:</b><br>
            1. Stoppa StreamVault-tjänsten (<code>nssm stop StreamVault</code> eller motsvarande)<br>
            2. Ladda ner v${esc(data.nodeUpdate.latest)} LTS från <a href="https://nodejs.org" target="_blank" style="color:var(--accent)">nodejs.org</a><br>
            3. Installera (skriver över den gamla versionen)<br>
            4. Starta tjänsten igen
          </div>
        </div>`;
    } else {
      html += `<div style="font-size:12px;color:var(--muted);margin-bottom:14px">✓ Node.js är redan på senaste LTS-versionen</div>`;
    }

    if (!data.packages.length) {
      html += `<div style="font-size:13px;color:var(--muted)">✓ Alla bibliotek är redan uppdaterade.</div>`;
    } else {
      html += `<div style="font-size:13px;font-weight:500;margin-bottom:8px">${data.packages.length} bibliotek har nyare versioner:</div>`;
      html += `<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">`;
      html += data.packages.map(p => `
        <label style="display:flex;align-items:center;gap:10px;background:var(--card2);border-radius:8px;padding:8px 12px;font-size:13px;cursor:pointer">
          <input type="checkbox" class="dep-pkg-checkbox" value="${esc(p.name)}">
          <span style="flex:1">${esc(p.name)}</span>
          <span style="color:var(--muted)">${esc(p.current)} → ${esc(p.latest)}</span>
          ${p.majorUpdate ? `<span style="color:#e0a030;font-size:11px" title="Huvudversion — kan innehålla brytande ändringar, kolla changelog innan du uppdaterar">⚠️ stor uppdatering</span>` : `<span style="color:#2ecc71;font-size:11px">liten uppdatering</span>`}
        </label>`).join("");
      html += `</div>`;
      html += `<button class="btn-fav" onclick="installSelectedDependencies()">Installera valda</button>`;
    }

    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = `<div style="color:var(--danger);font-size:13px">Fel: ${esc(e.message)}</div>`;
  }
}

async function installSelectedDependencies() {
  const checked = [...document.querySelectorAll(".dep-pkg-checkbox:checked")].map(c => c.value);
  if (!checked.length) { toast("Välj minst ett bibliotek att installera", "info"); return; }
  if (!confirm(`Installera senaste version av: ${checked.join(", ")}?\n\nServern måste startas om manuellt efteråt för att uppdateringen ska börja gälla.`)) return;
  const el = document.getElementById("dependency-results");
  el.innerHTML = "<div style='color:var(--muted);font-size:13px'>⏳ Installerar... (kan ta en minut per bibliotek)</div>";
  try {
    const data = await API.post("/admin/dependency-install", { packages: checked });
    const failed = data.results.filter(r => !r.ok);
    if (failed.length) {
      toast(`${data.results.length - failed.length} lyckades, ${failed.length} misslyckades`, "error");
    } else {
      toast("✓ Installerat! Starta om servern för att uppdateringen ska gälla.", "success");
    }
    checkDependencyUpdates();
  } catch(e) {
    toast("Fel: " + e.message, "error");
    checkDependencyUpdates();
  }
}

async function openServerLog(query) {
  document.getElementById("server-log-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "server-log-overlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:10002;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:20px";

  const modal = document.createElement("div");
  modal.style.cssText = "background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:900px;max-height:85vh;display:flex;flex-direction:column;overflow:hidden";

  const header = document.createElement("div");
  header.style.cssText = "padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-wrap:wrap";
  header.innerHTML = "<span style='font-size:18px'>🖥️</span><div style='flex:1;min-width:140px'><b style='font-size:15px'>Systemlogg</b><div id='server-log-subtitle' style='font-size:12px;color:var(--muted)'>Allt servern loggar — request, fel, händelser</div></div>";
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "Filtrera (t.ex. HTTP, error, /trailer)";
  searchInput.value = query || "";
  searchInput.style.cssText = "background:var(--card2);border:1px solid var(--border);color:var(--text);font-size:12px;padding:6px 10px;border-radius:8px;width:220px";
  searchInput.onkeydown = function(e) { if (e.key === "Enter") openServerLog(searchInput.value); };
  header.appendChild(searchInput);
  const refreshBtn = document.createElement("button");
  refreshBtn.textContent = "↻";
  refreshBtn.title = "Uppdatera";
  refreshBtn.style.cssText = "background:var(--card2);border:1px solid var(--border);color:var(--text);font-size:14px;padding:6px 10px;border-radius:8px;cursor:pointer";
  refreshBtn.onclick = function() { openServerLog(searchInput.value); };
  header.appendChild(refreshBtn);
  const downloadBtn = document.createElement("button");
  downloadBtn.textContent = "⬇";
  downloadBtn.title = "Ladda ner bufflad logg som textfil";
  downloadBtn.style.cssText = "background:var(--card2);border:1px solid var(--border);color:var(--text);font-size:14px;padding:6px 10px;border-radius:8px;cursor:pointer";
  downloadBtn.onclick = async function() {
    try {
      const data = await API.get("/admin/server-log?limit=5000");
      const blob = new Blob([(data.lines || []).join("\n")], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "streamvault-log-" + new Date().toISOString().slice(0, 10) + ".txt";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch(e) {
      toast("Kunde inte ladda ner logg: " + e.message, "error");
    }
  };
  header.appendChild(downloadBtn);
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.cssText = "background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer";
  closeBtn.onclick = function() { overlay.remove(); };
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const contentEl = document.createElement("div");
  contentEl.style.cssText = "flex:1;overflow-y:auto;padding:12px;font-family:monospace;font-size:11px;white-space:pre-wrap;line-height:1.5";
  contentEl.innerHTML = "<div style='text-align:center;padding:20px;color:var(--muted)'>⏳ Hämtar logg...</div>";
  modal.appendChild(contentEl);

  overlay.appendChild(modal);
  overlay.addEventListener("click", function(e) { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  try {
    var url = "/admin/server-log" + (query ? "?q=" + encodeURIComponent(query) : "");
    var data = await API.get(url);
    var lines = data.lines || [];
    document.getElementById("server-log-subtitle").textContent = `${lines.length} av ${data.totalBuffered} bufflade rader` + (query ? ` — filtrerat på "${query}"` : "");
    if (!lines.length) {
      contentEl.innerHTML = "<div style='text-align:center;padding:20px;color:var(--muted)'>Inga loggrader matchade.</div>";
      return;
    }
    contentEl.innerHTML = lines.map(function(l) {
      var isDeprecation = l.includes("DeprecationWarning") || l.includes("[DEP0");
      var color = isDeprecation ? "var(--muted)" : l.includes("[ERROR]") ? "var(--danger)" : l.includes("[WARN]") ? "#e0a030" : "var(--text)";
      return `<div style="color:${color};border-bottom:1px solid var(--border);padding:3px 0">${esc(l)}</div>`;
    }).join("");
    contentEl.scrollTop = contentEl.scrollHeight;
  } catch(e) {
    contentEl.innerHTML = "<div style='text-align:center;padding:20px;color:var(--danger)'>Kunde inte hämta logg: " + esc(e.message) + "</div>";
  }
}

async function openSubtitleLog(onlyErrors) {
  document.getElementById("subtitle-log-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "subtitle-log-overlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:10002;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:20px";

  const modal = document.createElement("div");
  modal.style.cssText = "background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:640px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden";

  const header = document.createElement("div");
  header.style.cssText = "padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px";
  header.innerHTML = "<span style='font-size:18px'>📋</span><div style='flex:1'><b style='font-size:15px'>Undertext-logg</b><div style='font-size:12px;color:var(--muted)'>Senaste händelserna från undertextcachning</div></div>";
  const filterBtn = document.createElement("button");
  filterBtn.textContent = onlyErrors ? "Visa alla" : "Visa endast fel";
  filterBtn.style.cssText = "background:var(--card2);border:1px solid var(--border);color:var(--text);font-size:12px;padding:6px 10px;border-radius:8px;cursor:pointer;white-space:nowrap";
  filterBtn.onclick = function() { openSubtitleLog(!onlyErrors); };
  header.appendChild(filterBtn);
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.cssText = "background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer";
  closeBtn.onclick = function() { overlay.remove(); };
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const contentEl = document.createElement("div");
  contentEl.style.cssText = "flex:1;overflow-y:auto;padding:12px;font-family:monospace;font-size:12px";
  contentEl.innerHTML = "<div style='text-align:center;padding:20px;color:var(--muted)'>⏳ Hämtar logg...</div>";
  modal.appendChild(contentEl);

  overlay.appendChild(modal);
  overlay.addEventListener("click", function(e) { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  try {
    var url = "/subtitles/log" + (onlyErrors ? "?level=error" : "");
    var data = await API.get(url);
    var entries = data.entries || [];
    if (!entries.length) {
      contentEl.innerHTML = "<div style='text-align:center;padding:20px;color:var(--muted)'>Inga" + (onlyErrors ? " fel" : " loggposter") + " ännu.</div>";
      return;
    }
    var colors = { error: "var(--danger)", warn: "#e0a030", info: "var(--muted)", debug: "#8e7cc3" };
    var icons = { error: "❌", warn: "⚠️", info: "ℹ️", debug: "🔬" };
    contentEl.innerHTML = entries.map(function(e) {
      var time = new Date(e.time).toLocaleString("sv-SE");
      var color = colors[e.level] || "var(--muted)";
      return "<div style='padding:6px 0;border-bottom:1px solid var(--border)'>" +
        "<div style='color:" + color + "'>" + (icons[e.level]||"") + " " + esc(time) + (e.title ? " – <b>" + esc(e.title) + "</b>" : "") + "</div>" +
        "<div style='color:var(--text);margin-top:2px'>" + esc(e.message) + "</div>" +
        (e.extra ? "<div style='color:var(--muted);margin-top:2px'>" + esc(JSON.stringify(e.extra)) + "</div>" : "") +
        "</div>";
    }).join("");
  } catch(e) {
    contentEl.innerHTML = "<div style='text-align:center;padding:20px;color:var(--danger);font-size:13px'>Fel: " + e.message + "</div>";
  }
}

// Admin-only: re-queues subtitle caching for the ENTIRE existing library. Needed once
// after upgrading, since a normal scan only picks up new files, not already-added ones.
async function recacheAllSubtitles() {
  if (!confirm("Detta köar om undertextcachning för hela biblioteket, enligt din språklista i Inställningar (inte nödvändigtvis alla språk som finns i filerna). Kan ta lång tid (timmar/dagar) för stora bibliotek, men körs i bakgrunden utan att störa uppspelning. Fortsätt?")) return;
  try {
    var data = await API.post("/subtitles/recache-all", {});
    toast(data.message || "Omcachning startad", "success");
    startCacheStatusPolling();
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

// Admin-only: wipes every cached subtitle file and resets the counters/DB fields, for testing
// the whole pipeline (OCR gating, auto-download of Tesseract data, etc.) from a clean slate.
// Detailed per-request subtitle logging on the server, for actively debugging what the app
// is asking for and what the server decides — off by default (noisy), toggled here.
async function toggleVerboseSubtitleLogging() {
  var btn = document.getElementById("verbose-sub-log-btn");
  try {
    var current = await API.get("/admin/verbose-subtitle-logging");
    var data = await API.post("/admin/verbose-subtitle-logging", { enabled: !current.enabled });
    if (btn) btn.textContent = data.enabled ? "🔬 Detaljerad loggning: PÅ" : "🔬 Detaljerad loggning: AV";
    toast(data.enabled ? "✓ Detaljerad undertextloggning påslagen" : "Detaljerad undertextloggning avstängd", "success");
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}
async function initVerboseSubtitleLoggingButton() {
  var btn = document.getElementById("verbose-sub-log-btn");
  if (!btn) return;
  try {
    var data = await API.get("/admin/verbose-subtitle-logging");
    btn.textContent = data.enabled ? "🔬 Detaljerad loggning: PÅ" : "🔬 Detaljerad loggning: AV";
  } catch(e) { btn.textContent = "🔬 Detaljerad loggning"; }
}

async function clearSubtitleCache() {
  if (!confirm("Detta raderar ALLA cachade undertextfiler (både textbaserade och OCR-konverterade) och nollställer statistiken.\n\nDina videofiler påverkas inte, och du kan köra 'Cacha om enligt språklistan' igen efteråt för att bygga upp allt på nytt.\n\nFortsätt?")) return;
  try {
    var data = await API.post("/subtitles/clear-cache", {});
    toast(`✓ ${data.removed} cachade undertextfiler borttagna`, "success");
    loadSettings();
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

// Batch-searches OpenSubtitles for every episode in a season and downloads the best match for
// each, instead of doing it one episode at a time. Runs in the background on the server —
// this just kicks it off and points to the subtitle log for progress/results.
async function batchSearchSeasonSubtitles(showId, seasonNum) {
  var lang = prompt("Vilket språk vill du söka undertexter på?\n\nSkriv en språkkod, t.ex. \"sv\" för svenska eller \"en\" för engelska.", "sv");
  if (!lang) return;
  lang = lang.trim().toLowerCase();
  if (!confirm(`Söker och laddar ner undertexter (${lang}) för hela säsongen från OpenSubtitles. Det här kan ta någon minut och körs i bakgrunden — du kan lämna sidan under tiden. Fortsätt?`)) return;
  try {
    var res = await API.post("/subtitles/batch-search", { show_id: showId, season: seasonNum, lang: lang });
    toast(`✓ ${res.queued} avsnitt köade för undertextsökning – kolla undertext-loggen i Inställningar om en stund för resultat`, "success");
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

// Cleans up external .{lang}.srt files (and their cache entries) for a whole season — mainly
// meant for undoing a bad batch-search result before trying again.
async function batchRemoveSeasonSubtitles(showId, seasonNum) {
  var lang = prompt("Ta bort externa undertexter för vilket språk?\n\nSkriv en språkkod, t.ex. \"sv\" för svenska.", "sv");
  if (!lang) return;
  lang = lang.trim().toLowerCase();
  if (!confirm(`Detta tar bort ALLA externa ${lang}-undertextfiler (och deras cache) för samtliga avsnitt i den här säsongen. Går inte att ångra. Fortsätt?`)) return;
  try {
    var res = await API.post("/subtitles/batch-remove-external", { show_id: showId, season: seasonNum, lang: lang });
    toast(`✓ ${res.removed} undertextfiler borttagna`, "success");
  } catch(e) {
    toast("Fel: " + e.message, "error");
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

// Strips only volatile query params (token, offset, cache-buster) when comparing subtitle
// URLs for "is this the active one" — NOT the whole query string. Embedded subtitle tracks
// are only distinguished by their ?index=N param, and cached ones by ?file=X, so stripping
// everything after "?" made every embedded track (or every cached file) compare as identical.
function subtitleIdentityUrl(url) {
  if (!url) return null;
  var parts = url.split("?");
  if (parts.length < 2) return parts[0];
  var keep = parts[1].split("&").filter(function(p) {
    var key = p.split("=")[0];
    return key !== "token" && key !== "dtoken" && key !== "offset" && key !== "_t";
  });
  return keep.length ? parts[0] + "?" + keep.join("&") : parts[0];
}

function activateSubtitle(url, label) {
  _activeSubtitleUrl = subtitleIdentityUrl(url);
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

let _currentAudioTrack = null;
let _activeSubtitleUrl = null; // Track active subtitle URL
// Restore saved audio track preference
try { _currentAudioTrack = JSON.parse(sessionStorage.getItem("sv_audioTrack") || "null"); } catch {}

async function toggleAudioTrackMenu() {
  document.getElementById("audio-track-overlay")?.remove();
  if (!currentItemId) return;

  const overlay = document.createElement("div");
  overlay.id = "audio-track-overlay";
  overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:rgba(0,0,0,0.7);display:flex;align-items:flex-end;justify-content:center;padding-bottom:100px";
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };

  const box = document.createElement("div");
  box.style.cssText = "background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:400px;overflow:hidden";

  const header = document.createElement("div");
  header.style.cssText = "padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px";
  var closeBtn = document.createElement("button");
  closeBtn.style.cssText = "background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer";
  closeBtn.textContent = "✕";
  closeBtn.onclick = function() { overlay.remove(); };
  header.innerHTML = "<span style='font-size:18px'>🎚️</span><div style='flex:1'><b style='font-size:15px'>Ljudspår</b></div>";
  header.appendChild(closeBtn);
  box.appendChild(header);

  const list = document.createElement("div");
  list.style.cssText = "max-height:300px;overflow-y:auto;padding:8px 0";
  list.innerHTML = "<div style='padding:16px;text-align:center;color:var(--muted)'>Laddar...</div>";
  box.appendChild(list);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  try {
    const data = await API.get("/media/" + currentItemId + "/audio-tracks");
    const tracks = data.tracks || [];
    if (!tracks.length) {
      list.innerHTML = "<div style='padding:16px;text-align:center;color:var(--muted)'>Inga ljudspår hittades</div>";
      return;
    }
    list.innerHTML = tracks.map((t, i) => {
      const isActive = _currentAudioTrack === t.trackIndex;
      const label = [
        t.language !== "und" ? t.language.toUpperCase() : null,
        t.codec,
        t.channel_layout || (t.channels ? t.channels + "ch" : null),
        t.title
      ].filter(Boolean).join(" · ");
      return `<div onclick="switchAudioTrack(${t.trackIndex})" style="padding:14px 20px;cursor:pointer;display:flex;align-items:center;gap:12px;background:${isActive ? "var(--card2)" : "none"};transition:background 0.15s" onmouseover="this.style.background='var(--card2)'" onmouseout="this.style.background='${isActive ? "var(--card2)" : "none"}'">
        ${isActive ? '<span style="font-size:20px">✅</span>' : ''}
        <div>
          <div style="font-size:13px;font-weight:${isActive ? "600" : "400"}">${esc(label)}</div>
        </div>
      </div>`;
    }).join("");
  } catch(e) {
    list.innerHTML = `<div style='padding:16px;text-align:center;color:var(--muted)'>Fel: ${e.message}</div>`;
  }
}

async function switchAudioTrack(trackIndex) {
  document.getElementById("audio-track-overlay")?.remove();
  if (!currentItemId) return;
  _currentAudioTrack = trackIndex;
  try { sessionStorage.setItem("sv_audioTrack", JSON.stringify(trackIndex)); } catch {}
  toast("Byter ljudspår...", "info");

  // Get current playback position
  const video = document.getElementById("main-video");
  const currentPos = video ? (window._dashStartSec || 0) + Math.max(0, video.currentTime - (window._dashFirstCT || 0)) : 0;

  try {
    // Restart DASH transcode with new audio track
    const token = localStorage.getItem("sv_token") || "";
    await fetch(`/api/dash/${currentItemId}/start?token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({ startSec: Math.floor(currentPos), audioTrack: trackIndex })
    });
    toast("✓ Ljudspår bytt!", "success");
    // Ensure video is not muted (Edge auto-mutes on stream restart)
    setTimeout(function() {
      var video = document.getElementById("main-video");
      if (video) { video.muted = false; video.volume = video.volume || 1; }
    }, 500);
  } catch(e) {
    toast("Fel vid byte av ljudspår", "error");
  }
}

async function saveUserLanguage(userId) {
  const language = document.getElementById("up-language")?.value || "";
  try {
    const result = await API.patch("/users/" + userId + "/language", { language: language || null });
    toast("✓ Språk sparat!", "success");
    // Keep the in-memory currentUser AND the localStorage copy in sync immediately —
    // otherwise a page reload reverts back to whatever language was cached at last login,
    // which is worse than doing nothing (looks like the change silently didn't take).
    if (currentUser && (userId === currentUser._id || userId === currentUser.id)) {
      currentUser.language = language || null;
      localStorage.setItem("sv_user", JSON.stringify(currentUser));
      applyPostLoginTranslations();
    }
    if (result?.needsOcrLanguage) {
      if (currentUser?.role === "admin") {
        promptAddOcrLanguage(result.needsOcrLanguage);
      } else {
        // Regular users can't add OCR languages themselves (admin-only endpoint) —
        // just let them know who to ask, instead of showing a button that would 403.
        var label = SUBTITLE_LANG_ADJ[result.needsOcrLanguage] || result.needsOcrLanguage;
        toast(`ℹ️ Bildbaserade undertexter på ${label} är inte aktiverat än – be en administratör lägga till det i Inställningar`, "info");
      }
    }
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

// Renders the current in-memory working list of subtitle-priority languages, with reorder
// (↑/↓) and remove controls, plus keeps the "add" dropdown populated with whatever isn't
// already in the list.
function renderSubtitlePriorityList() {
  var list = window._subPriorityWorkingList || [];
  var container = document.getElementById("sub-priority-list");
  var addSelect = document.getElementById("sub-priority-add-select");
  if (!container) return;
  container.innerHTML = list.length ? list.map(function(lang, i) {
    return `<div style="display:flex;align-items:center;gap:8px;background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:13px">
      <span style="color:var(--muted);min-width:16px">${i + 1}.</span>
      <span style="flex:1">${esc(SUBTITLE_LANG_ADJ[lang] || lang)}</span>
      <button onclick="moveSubtitlePriorityLang(${i},-1)" ${i === 0 ? "disabled" : ""} style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:2px 6px" title="Flytta upp">↑</button>
      <button onclick="moveSubtitlePriorityLang(${i},1)" ${i === list.length - 1 ? "disabled" : ""} style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:2px 6px" title="Flytta ner">↓</button>
      <button onclick="removeSubtitlePriorityLang(${i})" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:2px 6px" title="Ta bort">✕</button>
    </div>`;
  }).join("") : `<p style="color:var(--muted);font-size:13px;margin:0">Inga språk tillagda — använder bara språkinställningen ovan.</p>`;

  if (addSelect) {
    addSelect.innerHTML = Object.keys(SUBTITLE_LANG_ADJ)
      .filter(function(l) { return l !== "und" && list.indexOf(l) === -1; })
      .map(function(l) { return `<option value="${l}">${esc(SUBTITLE_LANG_ADJ[l])}</option>`; })
      .join("");
  }
}

function addSubtitlePriorityLang(userId) {
  var select = document.getElementById("sub-priority-add-select");
  var lang = select?.value;
  if (!lang) return;
  window._subPriorityWorkingList = window._subPriorityWorkingList || [];
  window._subPriorityWorkingList.push(lang);
  renderSubtitlePriorityList();
}

function moveSubtitlePriorityLang(index, delta) {
  var list = window._subPriorityWorkingList || [];
  var newIndex = index + delta;
  if (newIndex < 0 || newIndex >= list.length) return;
  var tmp = list[index];
  list[index] = list[newIndex];
  list[newIndex] = tmp;
  renderSubtitlePriorityList();
}

function removeSubtitlePriorityLang(index) {
  var list = window._subPriorityWorkingList || [];
  list.splice(index, 1);
  renderSubtitlePriorityList();
}

async function saveSubtitlePriority(userId) {
  var list = window._subPriorityWorkingList || [];
  try {
    var result = await API.patch("/users/" + userId + "/subtitle-languages", { languages: list });
    toast("✓ Prioritetsordning sparad!", "success");
    if (currentUser && (userId === currentUser._id || userId === currentUser.id)) {
      currentUser.subtitleLanguages = list;
      localStorage.setItem("sv_user", JSON.stringify(currentUser));
    }
    if (result?.needsOcrLanguage) {
      if (currentUser?.role === "admin") {
        promptAddOcrLanguage(result.needsOcrLanguage);
      } else {
        var label = SUBTITLE_LANG_ADJ[result.needsOcrLanguage] || result.needsOcrLanguage;
        toast(`ℹ️ Bildbaserade undertexter på ${label} är inte aktiverat än – be en administratör lägga till det i Inställningar`, "info");
      }
    }
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

// Half-automatic step: a user just got a language that isn't in the bitmap-subtitle
// OCR allowlist yet. Ask before kicking off any conversion work.
function promptAddOcrLanguage(lang) {
  var label = SUBTITLE_LANG_ADJ[lang] || lang;
  if (!confirm(`Lägg till ${label} i undertext-OCR-listan?\n\nDetta köar en riktad omcachning som bara konverterar bildbaserade undertexter på ${label} – övriga språk påverkas inte.`)) return;
  API.post("/subtitles/ocr-languages", { lang: lang, backfill: true })
    .then(function(res) {
      if (res.tessdataWarning) {
        toast("⚠️ " + res.tessdataWarning, "error");
      } else if (res.tessdataDownloaded) {
        toast(`✓ ${label} tillagt – språkdata för Tesseract hämtades automatiskt, ${res.queued || 0} filer köade`, "success");
      } else {
        toast(`✓ ${label} tillagt – ${res.queued || 0} filer köade`, "success");
      }
      startCacheStatusPolling();
      checkPendingOcrRequests();
    })
    .catch(function(e) { toast("Fel: " + e.message, "error"); });
}

async function saveOcrMode(mode) {
  try {
    await API.post("/subtitles/ocr-mode", { mode });
    toast(mode === "all" ? "✓ Cachar nu alla språk automatiskt" : "✓ Bara valda språk cachas", "success");
    loadSettings();
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

async function addOcrLanguage(explicitLang) {
  var lang = explicitLang || document.getElementById("ocr-add-lang-select")?.value;
  if (!lang) return;
  var label = SUBTITLE_LANG_ADJ[lang] || lang;
  if (!confirm(`Lägg till ${label} i OCR-listan och köa en riktad omcachning för det språket?`)) return;
  try {
    var res = await API.post("/subtitles/ocr-languages", { lang: lang, backfill: true });
    if (res.tessdataWarning) {
      toast("⚠️ " + res.tessdataWarning, "error");
    } else if (res.tessdataDownloaded) {
      toast(`✓ ${label} tillagt – språkdata för Tesseract hämtades automatiskt, ${res.queued || 0} filer köade`, "success");
    } else {
      toast(`✓ ${label} tillagt – ${res.queued || 0} filer köade`, "success");
    }
    startCacheStatusPolling();
    checkPendingOcrRequests();
    loadSettings();
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

async function removeOcrLanguage(lang) {
  var label = SUBTITLE_LANG_ADJ[lang] || lang;
  if (!confirm(`Ta bort ${label} från OCR-listan? Redan cachade filer på ${label} rörs inte, men inga nya konverteras.`)) return;
  try {
    await API.delete("/subtitles/ocr-languages/" + encodeURIComponent(lang));
    toast(`✓ ${label} borttaget från listan`, "success");
    loadSettings();
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

// Dismiss a pending "someone wants a new language" notification without adding it.
async function dismissOcrRequest(lang, userId) {
  var label = SUBTITLE_LANG_ADJ[lang] || lang;
  if (!confirm(`Avvisa förfrågan om ${label}? Notisen försvinner, men inget cachas.`)) return;
  try {
    await API.post("/subtitles/ocr-pending/dismiss", { lang: lang, userId: userId });
    toast(`Förfrågan om ${label} avvisad`, "info");
    checkPendingOcrRequests();
    loadSettings();
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

async function saveLanguageSetting(language) {
  try {
    await API.patch("/config", { language });
    toast("✓ Språk sparat! Ny metadata hämtas med valt språk.", "success");
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

async function saveChannelSetting(channel) {
  try {
    await API.patch("/config", { update_channel: channel });
    toast(channel === "beta" ? "🧪 Beta-kanal aktiverad" : "🟢 Stabil kanal aktiverad", "success");
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

async function saveTrailerStreamToggle(enabled) {
  try {
    await API.patch("/config", { trailer_stream_enabled: enabled });
    toast(enabled ? "✓ Trailer-strömning aktiverad" : "Trailer-strömning avstängd", "success");
  } catch(e) {
    toast("Fel: " + e.message, "error");
    const el = document.getElementById("trailer-stream-toggle");
    if (el) el.checked = !enabled; // revert the checkbox if the save failed
  }
}

async function installPgsToSrt() {
  const btn = document.getElementById("pgstosrt-install-btn");
  const progressDiv = document.getElementById("pgstosrt-progress");
  const progressMsg = document.getElementById("pgstosrt-progress-msg");
  const progressBar = document.getElementById("pgstosrt-progress-bar");
  if (btn) btn.style.display = "none";
  if (progressDiv) progressDiv.style.display = "block";

  try {
    await API.post("/tools/pgstosrt-install", {});
    // Poll progress
    const poll = setInterval(async () => {
      const status = await API.get("/tools/pgstosrt-status").catch(() => null);
      if (!status) return;
      const p = status.progress;
      if (p) {
        if (progressMsg) progressMsg.textContent = p.message;
        if (progressBar) progressBar.style.width = p.percent + "%";
        if (p.done) {
          clearInterval(poll);
          if (p.error) {
            toast("Installation misslyckades: " + p.error, "error");
            if (btn) btn.style.display = "block";
            if (progressDiv) progressDiv.style.display = "none";
          } else {
            toast("✓ PgsToSrt installerat!", "success");
            setTimeout(() => loadSettings(), 1000);
          }
        }
      }
    }, 500);
  } catch(e) {
    toast("Fel: " + e.message, "error");
    if (btn) btn.style.display = "block";
    if (progressDiv) progressDiv.style.display = "none";
  }
}

function toggleSubtitleMenu() {
  if (currentItemId) openSubtitles(currentItemId, document.getElementById("pb-title")?.textContent || "");
}

async function autoLoadSubtitles(mediaId, offsetSec) {
  try {
    var data = await API.get("/media/" + mediaId + "/subtitles");
    var subs = data.subtitles || [];
    // Map the user's UI language (e.g. "sv-SE") to the 3-letter subtitle code used by the server
    var USER_LANG_TO_SUB_LANG = { "sv-SE":"swe","en-US":"eng","no-NO":"nor","da-DK":"dan","de-DE":"deu","fr-FR":"fra","es-ES":"spa","nl-NL":"nld","fi-FI":"fin","ja-JP":"jpn" };
    // If the user's account has no explicit language of its own ("🌐 Använd serverns
    // inställning" in their profile), fall back to the server's own configured default
    // language instead of treating it as "no preference at all". This was the actual root
    // cause of subtitle auto-select silently landing on English: an account relying on the
    // server default LOOKS like it's "in Swedish" everywhere else in the UI (since that
    // happens to be the server's own default), but currentUser.language itself is genuinely
    // empty, and the subtitle-matching code never used to know to fall back any further.
    var effectiveLanguage = currentUser?.language || window._serverDefaultLanguage || null;
    var userSubLang = USER_LANG_TO_SUB_LANG[effectiveLanguage] || null;
    function matchesLang(s, code) {
      if (!code) return false;
      var l = (s.lang || "").toLowerCase();
      return l === code || (code === "swe" && l === "sv") || (code === "eng" && l === "en");
    }
    // Priority: 1) each language in the user's own priority list, in order (if set) —
    // otherwise just their single primary language, 2) English (widely understood fallback),
    // 3) Swedish (server default), 4) embedded Swedish, 5) nothing.
    // Deliberately NOT "any srt file" — with multiple languages now cached, that used to
    // silently resolve to whatever the server happened to sort first (usually Swedish),
    // even for a user whose language is e.g. Finnish and who can't read Swedish at all.
    var priorityList = (currentUser?.subtitleLanguages && currentUser.subtitleLanguages.length)
      ? currentUser.subtitleLanguages
      : [userSubLang].filter(Boolean);
    console.log("[SUBTITLES] Auto-select debug — currentUser.language:", currentUser?.language, "serverDefault:", window._serverDefaultLanguage, "effectiveLanguage:", effectiveLanguage, "subtitleLanguages:", currentUser?.subtitleLanguages, "→ priorityList used:", priorityList);
    var userSub = null;
    for (var pi = 0; pi < priorityList.length; pi++) {
      userSub = subs.find(function(s) { return matchesLang(s, priorityList[pi]); });
      if (userSub) break;
    }
    var engSub = subs.find(function(s) { return s.type === "srt" && matchesLang(s, "eng"); });
    var sweSub = subs.find(function(s) { return s.type === "srt" && matchesLang(s, "swe"); });
    var embeddedSv = subs.find(function(s) { 
      return s.type === "embedded" && (s.lang === "sv" || s.lang === "swe" || (s.label || "").toLowerCase().includes("swedish")); 
    });
    var sub = userSub || engSub || sweSub || embeddedSv || null;
    if (!sub || !sub.url) return;
    // Apply offset to URL only for SRT files, not embedded (embedded have absolute times)
    if (offsetSec && offsetSec > 0 && sub.url && sub.type !== "embedded") {
      sub = Object.assign({}, sub);
      sub.url = sub.url + (sub.url.includes("?") ? "&" : "?") + "offset=" + offsetSec;
    }
    // For embedded subtitles, check if extraction is ready (may need retries)
    if (sub.type === "embedded") {
      // Embedded subtitles have absolute times - never apply offset (offset is only ever
      // added above for non-embedded types, so sub.url is already correct as-is here —
      // including the ?token= the server appended, which must NOT be stripped).
      var subUrl = sub.url;
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
    // Use custom overlay system instead of <track> (works on all browsers including Android/LG TV)
    var video = document.getElementById("main-video");
    if (!video) return;
    var tryActivate = function() {
      // Remove any existing track elements
      Array.from(video.querySelectorAll("track")).forEach(function(t) { t.src = ""; t.remove(); });
      // Activate via our overlay system
      activateSubtitle(sub.url, sub.label || "Svenska");
      console.log("[SUBTITLES] Auto-activated:", sub.label);
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
  // Stop any existing overlay (this also resets window._currentSubtitleCues to null, so it's
  // important that the two lines below run AFTER this, not before)
  stopSubtitleOverlay();
  // Stored so adjustSubtitleSync() can shift these live, in place, without re-fetching —
  // the rendering loop below reads from this same array reference on every tick.
  window._currentSubtitleCues = cues;
  window._subtitleSyncOffset = 0;
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
  window._currentSubtitleCues = null;
  window._subtitleSyncOffset = 0;
  if (_subtitleOverlayInterval) {
    clearInterval(_subtitleOverlayInterval);
    _subtitleOverlayInterval = null;
  }
  var overlay = document.getElementById("sv-subtitle-overlay");
  if (overlay) overlay.innerHTML = "";
  // Also disable and remove any native HTML5 text tracks on the video element
  var video = document.getElementById("main-video");
  if (video) {
    // Disable all text tracks
    if (video.textTracks) {
      for (var i = 0; i < video.textTracks.length; i++) {
        video.textTracks[i].mode = "disabled";
      }
    }
    // Remove all <track> elements
    var tracks = video.querySelectorAll("track");
    tracks.forEach(function(t) { t.src = ""; t.remove(); });
  }
}

// Nudges the currently active subtitle's timing by deltaSeconds — shifts every cue already
// in memory, in place, so the change is visible on the very next overlay render tick (100ms
// later) with no server round-trip or reload. Positive delta = subtitle appears LATER
// (use this if the text currently shows too early), negative = appears EARLIER.
function adjustSubtitleSync(deltaSeconds) {
  var cues = window._currentSubtitleCues;
  if (!cues || !cues.length) { toast("Ingen undertext aktiv just nu", "info"); return; }
  for (var i = 0; i < cues.length; i++) {
    cues[i].start += deltaSeconds;
    cues[i].end += deltaSeconds;
  }
  window._subtitleSyncOffset = (window._subtitleSyncOffset || 0) + deltaSeconds;
  updateSubtitleSyncDisplay();
}

function resetSubtitleSync() {
  var cues = window._currentSubtitleCues;
  var current = window._subtitleSyncOffset || 0;
  if (cues && cues.length && current) {
    for (var i = 0; i < cues.length; i++) {
      cues[i].start -= current;
      cues[i].end -= current;
    }
  }
  window._subtitleSyncOffset = 0;
  updateSubtitleSyncDisplay();
}

function updateSubtitleSyncDisplay() {
  var el = document.getElementById("sv-sync-offset-display");
  if (!el) return;
  var v = window._subtitleSyncOffset || 0;
  el.textContent = (v > 0 ? "+" : "") + v.toFixed(1) + "s";
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
  if (!window._iptvPlaying) stopSubtitleOverlay(); // subtitle overlay is a VOD concept, not relevant to live TV
  // Destroy dash.js player first to prevent SourceBuffer errors
  if (window._dashPlayer) {
    try { window._dashPlayer.destroy(); } catch {}
    window._dashPlayer = null;
  }
  if (currentHls) {
    try { currentHls.destroy(); } catch {}
    currentHls = null;
  }
  const video = document.getElementById("main-video");
  video?.pause();
  if (video) { video.src = ""; video.load(); }
  document.getElementById("player-bar").style.display = "none";
  document.body.style.paddingBottom = "";
  // Tell the server to actually kill the FFmpeg transcode (if any) — otherwise it just
  // keeps running/counting on the server after the player is closed, wasting CPU forever.
  // Not applicable to a live IPTV channel — there's no server-side transcode job for it.
  if (currentItemId && !window._iptvPlaying) API.post("/dash/" + currentItemId + "/stop").catch(() => {});
  if (currentItemId && !window._iptvPlaying) API.post("/media/" + currentItemId + "/stop").catch(() => {});
  window._iptvPlaying = false;
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

// Adjective forms for the "X med Y text" lines in the subtitle-cache dashboard.
// Falls back to the raw code for anything not in the list, so new/rare languages still show up.
var SUBTITLE_LANG_ADJ = { swe:"svensk", eng:"engelsk", nor:"norsk", dan:"dansk", deu:"tysk", fra:"fransk", spa:"spansk", nld:"nederländsk", fin:"finsk", ita:"italiensk", por:"portugisisk", pol:"polsk", jpn:"japansk", und:"okänd" };
// ── LIVE ACTIVITY (admin dashboard) ────────────────────────────────────────────
// ── THEMES ────────────────────────────────────────────────────────────────────
// Each theme is just a different set of values for the same CSS custom properties the whole
// app already uses (--bg, --card, --text, --accent, etc.) — switching themes never touches
// any actual page markup, just re-points what those variables resolve to.
const THEMES = {
  standard: {
    label: "Standard (mörk)",
    vars: { "--bg":"#0a0a12", "--surface":"#0f0f1a", "--card":"#141420", "--card2":"#1a1a28", "--border":"#222235", "--accent":"#e05724", "--accent2":"#e05724", "--text":"#eeeef8", "--muted":"#8080a0", "--success":"#2ecc71", "--danger":"#e05724" }
  },
  plexlik: {
    label: "Plex-liknande (mörk, guld)",
    vars: { "--bg":"#1f1f1f", "--surface":"#232323", "--card":"#282828", "--card2":"#2f2f2f", "--border":"#3a3a3a", "--accent":"#cc7b19", "--accent2":"#e5a00d", "--text":"#f2f2f2", "--muted":"#a3a3a3", "--success":"#2ecc71", "--danger":"#e5541b" }
  },
  midnatt: {
    label: "Midnattsblå (mörk)",
    vars: { "--bg":"#0a0e1a", "--surface":"#0f1524", "--card":"#141b2e", "--card2":"#1b2338", "--border":"#253048", "--accent":"#3498db", "--accent2":"#5dade2", "--text":"#e8ecf5", "--muted":"#7c8aa8", "--success":"#2ecc71", "--danger":"#e74c3c" }
  },
  skog: {
    label: "Skog (mörk, grön)",
    vars: { "--bg":"#0d1410", "--surface":"#111c15", "--card":"#16211a", "--card2":"#1c2921", "--border":"#28382c", "--accent":"#4caf7d", "--accent2":"#6ec99a", "--text":"#e8f0ea", "--muted":"#84998c", "--success":"#4caf7d", "--danger":"#e05724" }
  },
  ljus: {
    label: "Ljus",
    vars: { "--bg":"#f4f4f7", "--surface":"#ffffff", "--card":"#ffffff", "--card2":"#eef0f4", "--border":"#dcdfe6", "--accent":"#d9531e", "--accent2":"#d9531e", "--text":"#1a1a24", "--muted":"#6b6b7d", "--success":"#27ae60", "--danger":"#d9531e" }
  },
  ljusvarm: {
    label: "Ljus (varm)",
    vars: { "--bg":"#faf6f0", "--surface":"#fffdf9", "--card":"#fffdf9", "--card2":"#f3ece1", "--border":"#e5dbc9", "--accent":"#c1701e", "--accent2":"#c1701e", "--text":"#2b2418", "--muted":"#7a6f5c", "--success":"#27ae60", "--danger":"#c1381e" }
  }
};

function applyTheme(themeName) {
  const theme = THEMES[themeName] || THEMES.standard;
  for (const [key, val] of Object.entries(theme.vars)) {
    document.documentElement.style.setProperty(key, val);
  }
  // Belt-and-suspenders: some chrome elements (sidebar, topbar) may have their own hardcoded
  // background/border colors in the stylesheet rather than referencing the CSS variables
  // above, which would make them not update live when switching themes. Setting them
  // directly here guarantees they follow the theme regardless of how the stylesheet itself
  // is written.
  const sidebar = document.getElementById("sidebar");
  if (sidebar) { sidebar.style.background = theme.vars["--surface"]; sidebar.style.borderColor = theme.vars["--border"]; }
  const topbar = document.getElementById("topbar");
  if (topbar) { topbar.style.background = theme.vars["--surface"]; topbar.style.borderColor = theme.vars["--border"]; }
  window._currentTheme = themeName;
}

async function toggleUserWebhookEnabled(userId, enabled) {
  try {
    await API.patch("/users/" + userId + "/webhook", { webhook_enabled: enabled });
    const input = document.getElementById("webhook-url-input-" + userId);
    if (input) input.disabled = !enabled;
    toast(enabled ? "✓ Webhook aktiverad" : "Webhook avstängd", "success");
  } catch(e) {
    toast("Fel: " + e.message, "error");
    const cb = document.getElementById("webhook-enabled-" + userId);
    if (cb) cb.checked = !enabled;
  }
}

async function saveUserWebhook(userId) {
  const input = document.getElementById("webhook-url-input-" + userId);
  const url = input?.value.trim() || "";
  try {
    await API.patch("/users/" + userId + "/webhook", { webhook_url: url });
    toast(url ? "✓ Webhook sparad" : "Webhook borttagen", "success");
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

function showWebhookHelp() {
  const overlay = document.createElement("div");
  overlay.id = "webhook-help-modal";
  overlay.style.cssText = "position:fixed;inset:0;z-index:600;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:20px";
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:560px;max-height:85vh;overflow-y:auto">
      <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center">
        <span style="font-weight:700">Hur webhooks fungerar</span>
        <button onclick="document.getElementById('webhook-help-modal').remove()" style="margin-left:auto;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer">✕</button>
      </div>
      <div style="padding:20px;font-size:13px;line-height:1.6;color:var(--text)">
        <p>En webhook är bara en webbadress som StreamVault skickar ett litet meddelande till, automatiskt, när du börjar eller slutar titta på något. Något annat system lyssnar på den adressen och kan sen göra vad du vill — dimma lampor, stänga persienner, vad som helst.</p>

        <p style="margin-top:14px">StreamVault vet ingenting om just din utrustning (Hue, IKEA Trådfri, Home Assistant, eller något helt annat) — den skickar bara meddelandet. <b>Något annat</b> behöver ta emot det och bestämma vad som ska hända. Nedan är två vanliga, gratis vägar in, beroende på vad du redan har.</p>

        <p style="margin-top:16px"><b>🅰 Har du bara smarta lampor (Hue, Trådfri, etc) och inget annat?</b><br>
        Då är <b>IFTTT</b> (ifttt.com, gratis app) den enklaste vägen — den kan prata direkt med de flesta lampmärken, utan att du behöver installera något extra hemma.</p>
        <ol style="margin:8px 0 0 18px;padding:0">
          <li>Skapa ett konto på ifttt.com</li>
          <li>Skapa en ny "Applet": som utlösare (<i>"If This"</i>), välj tjänsten <b>Webhooks</b></li>
          <li>IFTTT ger dig en unik webbadress — klistra in den här i StreamVault</li>
          <li>Som åtgärd (<i>"Then That"</i>), välj din lamp-tjänst (t.ex. Philips Hue) och vad som ska hända</li>
        </ol>

        <p style="margin-top:16px"><b>🅱 Har du (eller vill sätta upp) Home Assistant?</b><br>
        Ger mer kontroll och stödjer nästan allt smart hem-relaterat, men kräver lite mer teknisk uppsättning initialt.</p>
        <ol style="margin:8px 0 0 18px;padding:0">
          <li>Inställningar → Automationer → Skapa automation</li>
          <li>Som utlösare, välj <b>Webhook</b> — den ger dig en unik adress</li>
          <li>Klistra in den adressen här i StreamVault</li>
          <li>Bygg vidare med vilken åtgärd du vill (dimma, stänga av, m.m.)</li>
        </ol>

        <p style="margin-top:16px"><b>Vad skickas?</b><br>
        Ett litet JSON-meddelande, ungefär så här:</p>
        <pre style="background:var(--card2);border-radius:8px;padding:12px;font-size:11px;overflow-x:auto;margin-top:6px">{
  "event": "started",
  "username": "Pilen",
  "title": "Bad Boys: Ride or Die",
  "timestamp": "2026-08-13T20:15:00.000Z"
}</pre>
        <p style="margin-top:8px"><code>event</code> är antingen <code>"started"</code> eller <code>"stopped"</code>.</p>

        <p style="margin-top:14px"><b>Bra att veta:</b></p>
        <ul style="margin:4px 0 0 18px;padding:0">
          <li>Funktionen är avstängd som standard — ingenting skickas förrän du aktivt kryssar i rutan ovan</li>
          <li>Bara start och stopp skickas — inte paus/återuppta. Pausar du för att gå på toa och fortsätter sen, skickas inget nytt förrän du helt stänger spelaren</li>
          <li>Fungerar bara med tjänster som kan ta emot en webbadress som "webhook" — vilket både IFTTT och Home Assistant gör, men även många andra (Zapier, Make/Integromat, egna skript, m.fl.)</li>
        </ul>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

async function loadStreamingServicesList(userId, currentPrefs) {
  const el = document.getElementById(`streaming-services-list-${userId}`);
  if (!el) return;
  try {
    const data = await API.get("/watch-providers/all");
    const prefs = new Set(currentPrefs || []);
    el.innerHTML = data.providers.map(p => `
      <label style="display:flex;align-items:center;gap:10px;padding:6px 8px;cursor:pointer;font-size:13px">
        <input type="checkbox" value="${esc(p.name)}" ${prefs.has(p.name) ? "checked" : ""}>
        ${p.logo ? `<img src="${p.logo}" style="width:24px;height:24px;border-radius:4px;object-fit:cover">` : `<span style="width:24px"></span>`}
        <span>${esc(p.name)}</span>
      </label>`).join("");
  } catch(e) {
    el.innerHTML = `<div style="color:var(--danger);font-size:13px;padding:10px">Kunde inte hämta listan: ${esc(e.message)}</div>`;
  }
}

async function saveStreamingServices(userId) {
  const checked = [...document.querySelectorAll(`#streaming-services-list-${userId} input:checked`)].map(c => c.value);
  try {
    await API.patch(`/users/${userId}/preferred-providers`, { providers: checked });
    toast(checked.length ? `✓ ${checked.length} tjänster sparade` : "✓ Sparat (visar alla tjänster igen)", "success");
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

async function clearStreamingServices(userId) {
  document.querySelectorAll(`#streaming-services-list-${userId} input`).forEach(c => c.checked = false);
  await saveStreamingServices(userId);
}

async function saveUserTheme(userId, themeName) {
  const isOwnProfile = userId === currentUser?.id;
  if (isOwnProfile) applyTheme(themeName); // no reason to visually change YOUR OWN screen when setting someone else's theme
  try {
    await API.patch("/users/" + userId + "/theme", { theme: themeName });
    toast("✓ Tema sparat", "success");
    if (currentUser.role === "admin") loadUserPage(userId); // refresh to show the new selection highlighted
  } catch(e) {
    toast("Kunde inte spara tema: " + e.message, "error");
  }
}

var _liveActivityInterval = null;
var _systemStatsInterval = null;

// Simple, dependency-free SVG line chart — deliberately basic for now (this is the "does the
// live data even work" pass, not the visual polish pass that comes later). Draws one or two
// series normalized to a 0-100 scale, redraws completely on every poll rather than trying to
// animate/append, which is simpler and plenty fast at this data volume (60 points × 2 lines).
function renderLiveLineChart(containerId, samples, seriesConfig, mode) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const w = 700, h = 140, pad = 4;
  if (!samples.length) { el.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:20px;text-align:center">Samlar data...</div>`; return; }
  const n = samples.length;
  const xStep = (w - pad * 2) / Math.max(1, n - 1);
  // Percentages (CPU/RAM) use a fixed 0-100 scale — always comparable, and 100% has a real
  // ceiling meaning. Mbps has no natural ceiling, so scale dynamically to whatever the
  // highest value in view actually is (with a little headroom so a line hugging the top
  // doesn't look clipped), same idea as the existing daily-playback bar chart.
  const maxVal = mode === "mbps" ? Math.max(1, ...samples.flatMap(s => seriesConfig.map(sc => s[sc.key] || 0))) * 1.15 : 100;
  const toY = (val) => h - pad - (Math.max(0, Math.min(maxVal, val)) / maxVal) * (h - pad * 2);

  const lines = seriesConfig.map(s => {
    const points = samples.map((sample, i) => `${(pad + i * xStep).toFixed(1)},${toY(sample[s.key]).toFixed(1)}`).join(" ");
    return `<polyline points="${points}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join("");

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(frac => {
    const val = frac * maxVal;
    const y = toY(val);
    return `<line x1="${pad}" y1="${y}" x2="${w-pad}" y2="${y}" stroke="var(--border)" stroke-width="1" opacity="0.5"/>`;
  }).join("");

  const unit = mode === "mbps" ? " Mbps" : "%";
  const latest = samples[samples.length - 1];
  const legend = seriesConfig.map(s => `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px"><span style="width:8px;height:8px;border-radius:50%;background:${s.color};display:inline-block"></span>${s.label} — ${latest[s.key]?.toFixed(2) ?? "–"}${unit}</span>`).join("");

  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;display:block">${gridLines}${lines}</svg>
    <div style="font-size:12px;color:var(--muted);margin-top:6px">${legend}</div>`;
}

async function refreshSystemStatsGraphs() {
  const sec = document.getElementById("system-stats-section");
  if (!sec) return;
  try {
    const data = await API.get("/admin/system-stats");
    if (!document.getElementById("system-stats-cpu-chart")) {
      // First load — build the section shell once, then just update the charts in place on
      // every subsequent poll (avoids replacing the whole section, which would cause a
      // visible flicker every 3 seconds).
      sec.innerHTML = `
        <div style="display:flex;gap:20px;flex-wrap:wrap">
          <div style="flex:1;min-width:220px">
            <div class="settings-section-title">Bandbredd</div>
            <div id="system-stats-bandwidth-chart"></div>
          </div>
          <div style="flex:1;min-width:220px">
            <div class="settings-section-title">CPU</div>
            <div id="system-stats-cpu-chart"></div>
          </div>
          <div style="flex:1;min-width:220px">
            <div class="settings-section-title">RAM</div>
            <div id="system-stats-ram-chart"></div>
          </div>
        </div>`;
    }
    renderLiveLineChart("system-stats-bandwidth-chart", data.samples, [
      { key: "localMbps", label: "Lokalt", color: "#3498db" },
      { key: "remoteMbps", label: "Fjärrserver", color: "#f39c12" }
    ], "mbps");
    renderLiveLineChart("system-stats-cpu-chart", data.samples, [
      { key: "processCpuPct", label: "StreamVault", color: "#2ecc71" },
      { key: "systemCpuPct", label: "System", color: "#e74c3c" }
    ]);
    renderLiveLineChart("system-stats-ram-chart", data.samples, [
      { key: "processMemPct", label: "StreamVault", color: "#2ecc71" },
      { key: "systemMemPct", label: "System", color: "#9b59b6" }
    ]);
  } catch(e) {
    sec.innerHTML = `<div style="color:var(--danger);font-size:13px">Kunde inte hämta systemstatistik: ${esc(e.message)}</div>`;
  }
}

function startSystemStatsPolling() {
  if (_systemStatsInterval) return;
  refreshSystemStatsGraphs();
  _systemStatsInterval = setInterval(refreshSystemStatsGraphs, 3000); // matches the server's own 3s sampling interval — no point polling faster than new data actually arrives
}


// Historical playback analytics (Tautulli-style) — direct-play vs transcode rates over time,
// which container/codec combos transcode most, and most-watched titles. Loaded async after
// the initial Settings render, same pattern as Live Activity/watch-providers.
async function resetPlaybackStats() {
  if (!confirm("Detta raderar all uppspelningsstatistik permanent (t.ex. all testdata från utveckling). Går inte att ångra. Fortsätt?")) return;
  try {
    const data = await API.post("/admin/playback-stats/reset", {});
    toast(`✓ ${data.removed} poster raderade`, "success");
    loadPlaybackStats();
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

let _allHistoryState = { user: "", days: "", offset: 0, sortKey: "at", sortDir: "desc" };

async function loadAllHistoryPage() {
  const sec = document.getElementById("sec-settings");
  if (!sec) return;
  _allHistoryState = { user: "", days: "", offset: 0, sortKey: "at", sortDir: "desc" };
  let users = [];
  try { users = (await API.get("/users")).users || []; } catch(e) {}
  sec.innerHTML = `
    <div class="settings-wrap" style="max-width:1400px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">
        <button class="btn-fav" onclick="loadSettings()">← Översikt</button>
        <h2 style="margin:0">Spelningshistorik</h2>
        <select class="s-input" id="ah-user-filter" onchange="onAllHistoryFilterChange()" style="max-width:180px">
          <option value="">Alla användare</option>
          ${users.map(u => `<option value="${esc(u.username)}">${esc(u.username)}</option>`).join("")}
        </select>
        <select class="s-input" id="ah-days-filter" onchange="onAllHistoryFilterChange()" style="max-width:160px">
          <option value="">Alla tider</option>
          <option value="7">Senaste 7 dagarna</option>
          <option value="30">Senaste 30 dagarna</option>
          <option value="90">Senaste 90 dagarna</option>
        </select>
        <span id="ah-total-count" style="color:var(--muted);font-size:13px;margin-left:auto"></span>
      </div>
      <div id="ah-table-container"></div>
      <div style="display:flex;justify-content:center;gap:10px;margin-top:16px" id="ah-pagination"></div>
    </div>`;
  loadAllHistoryTable();
}

function onAllHistoryFilterChange() {
  _allHistoryState.user = document.getElementById("ah-user-filter")?.value || "";
  _allHistoryState.days = document.getElementById("ah-days-filter")?.value || "";
  _allHistoryState.offset = 0;
  loadAllHistoryTable();
}

function setAllHistorySort(key) {
  if (_allHistoryState.sortKey === key) {
    _allHistoryState.sortDir = _allHistoryState.sortDir === "asc" ? "desc" : "asc";
  } else {
    _allHistoryState.sortKey = key;
    _allHistoryState.sortDir = "asc";
  }
  loadAllHistoryTable();
}

function setAllHistoryPage(offset) {
  if (offset < 0) return;
  _allHistoryState.offset = offset;
  loadAllHistoryTable();
}

const ALL_HISTORY_TYPE_LABELS = { movie: "🎬 Film", tvshow: "📺 Serie", episode: "📺 Avsnitt", music: "🎵 Musik" };
const ALL_HISTORY_PAGE_SIZE = 100;

async function loadAllHistoryTable() {
  const container = document.getElementById("ah-table-container");
  if (!container) return;
  container.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const params = new URLSearchParams({ limit: ALL_HISTORY_PAGE_SIZE, offset: _allHistoryState.offset });
    if (_allHistoryState.user) params.set("user", _allHistoryState.user);
    if (_allHistoryState.days) params.set("days", _allHistoryState.days);
    const data = await API.get("/admin/all-history?" + params.toString());

    // Sorting happens client-side, on whichever page of results is currently loaded — the
    // server already did the heavier job of filtering + only sending back one page's worth.
    const sorted = [...data.entries].sort((a, b) => {
      const key = _allHistoryState.sortKey;
      const av = a[key] || "", bv = b[key] || "";
      const cmp = key === "at" ? new Date(av) - new Date(bv) : String(av).localeCompare(String(bv));
      return _allHistoryState.sortDir === "asc" ? cmp : -cmp;
    });

    const totalEl = document.getElementById("ah-total-count");
    if (totalEl) totalEl.textContent = `${data.total} spelningar totalt`;

    const cols = [["username","Användare"],["type","Typ"],["title","Titel"],["device","Spelare"],["method","Metod"],["at","Spelad"]];
    container.innerHTML = `
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="border-bottom:1px solid var(--border)">
              ${cols.map(([key,label]) => `<th onclick="setAllHistorySort('${key}')" style="text-align:left;padding:8px 10px;cursor:pointer;color:var(--muted);white-space:nowrap;user-select:none">${label}${_allHistoryState.sortKey===key ? (_allHistoryState.sortDir==="asc"?" ▲":" ▼") : ""}</th>`).join("")}
            </tr>
          </thead>
          <tbody>
            ${sorted.map(e => `
              <tr style="border-bottom:1px solid var(--border)">
                <td style="padding:7px 10px;white-space:nowrap">${esc(e.username||"–")}</td>
                <td style="padding:7px 10px;white-space:nowrap">${ALL_HISTORY_TYPE_LABELS[e.type] || esc(e.type||"–")}</td>
                <td style="padding:7px 10px">${esc(e.title||"–")}</td>
                <td style="padding:7px 10px;white-space:nowrap;color:var(--muted)">${esc(e.device||"–")}</td>
                <td style="padding:7px 10px;white-space:nowrap">${e.method === "direct" ? "Direct" : "Transkodning"}</td>
                <td style="padding:7px 10px;white-space:nowrap;color:var(--muted)">${new Date(e.at).toLocaleString("sv-SE")}</td>
              </tr>`).join("")}
          </tbody>
        </table>
        ${!sorted.length ? `<div style="text-align:center;color:var(--muted);padding:30px">Inga träffar</div>` : ""}
      </div>`;

    const paginationEl = document.getElementById("ah-pagination");
    if (paginationEl) {
      const page = Math.floor(_allHistoryState.offset / ALL_HISTORY_PAGE_SIZE) + 1;
      const totalPages = Math.max(1, Math.ceil(data.total / ALL_HISTORY_PAGE_SIZE));
      paginationEl.innerHTML = `
        <button class="btn-fav" ${_allHistoryState.offset<=0?"disabled":""} onclick="setAllHistoryPage(${_allHistoryState.offset - ALL_HISTORY_PAGE_SIZE})">‹ Föregående</button>
        <span style="color:var(--muted);font-size:13px;align-self:center">Sida ${page} av ${totalPages}</span>
        <button class="btn-fav" ${_allHistoryState.offset + ALL_HISTORY_PAGE_SIZE >= data.total?"disabled":""} onclick="setAllHistoryPage(${_allHistoryState.offset + ALL_HISTORY_PAGE_SIZE})">Nästa ›</button>`;
    }
  } catch(e) {
    container.innerHTML = `<p style="color:var(--danger)">Fel: ${esc(e.message)}</p>`;
  }
}

function fmtHoursShort(minutes) {
  const h = minutes / 60;
  return h >= 1 ? `${h.toFixed(1)}h` : `${Math.round(minutes)}m`;
}

async function loadWeeklyHistoryChart() {
  const el = document.getElementById("weekly-history-section");
  if (!el) return;
  try {
    const data = await API.get("/admin/weekly-history?weeks=5");
    const maxVal = Math.max(1, ...data.weeks.map(w => w.movie + w.tvshow + w.music));
    const barAreaH = 220;
    const typeColors = { movie: "#8bc98b", tvshow: "#e91e63", music: "#3498db" };
    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <div class="settings-section-title" style="margin:0">Spelningshistorik</div>
        <button class="btn-fav" onclick="loadAllHistoryPage()">Visa all historik</button>
      </div>
      <div style="display:flex;align-items:flex-end;gap:14px;height:${barAreaH}px;padding:0 4px 24px;position:relative;border-bottom:1px solid var(--border)">
        ${data.weeks.map(w => {
          const total = w.movie + w.tvshow + w.music;
          const segments = [["movie",w.movie],["tvshow",w.tvshow],["music",w.music]].filter(([,v]) => v > 0);
          return `
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;height:100%;justify-content:flex-end;min-width:0;position:relative">
            <div style="width:70%;display:flex;flex-direction:column-reverse;border-radius:4px 4px 0 0;overflow:hidden;height:${Math.max(2, (total/maxVal)*barAreaH)}px">
              ${segments.map(([type,val]) => `<div style="background:${typeColors[type]};height:${(val/total)*100}%;width:100%" title="${type}: ${fmtHoursShort(val)}"></div>`).join("")}
            </div>
            <div style="position:absolute;bottom:-22px;font-size:11px;color:var(--muted);white-space:nowrap">${w.label}</div>
          </div>`;
        }).join("")}
      </div>
      <div style="display:flex;gap:16px;margin-top:10px;font-size:12px;color:var(--muted);flex-wrap:wrap">
        <span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${typeColors.movie};margin-right:5px"></span>Filmer</span>
        <span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${typeColors.tvshow};margin-right:5px"></span>TV</span>
        <span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${typeColors.music};margin-right:5px"></span>Musik</span>
        <span style="margin-left:auto">Totalt: Filmer — ${fmtHoursShort(data.totals.movie)} | TV — ${fmtHoursShort(data.totals.tvshow)} | Musik — ${fmtHoursShort(data.totals.music)}</span>
      </div>`;
  } catch(e) {
    el.innerHTML = "";
  }
}

function fmtRelativeTime(isoString) {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "nu";
  if (mins < 60) return `${mins} min sedan`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h sedan`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d sedan`;
  return new Date(isoString).toLocaleDateString("sv-SE");
}

async function loadRecentActivity() {
  const el = document.getElementById("recent-activity-section");
  if (!el) return;
  try {
    const data = await API.get("/admin/recent-activity?limit=20");
    if (!data.activity.length) { el.innerHTML = ""; return; }
    el.innerHTML = `
      <div class="settings-section-title" style="display:flex;align-items:center;gap:8px">🕐 Senaste aktivitet</div>
      <div style="display:flex;flex-direction:column;gap:2px">
        ${data.activity.map(a => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 4px;font-size:13px;border-bottom:1px solid var(--border)">
            <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              <span style="color:var(--accent,#3498db);font-weight:600">${esc(a.username)}</span>
              <span style="color:var(--muted)"> ${a.completed ? "såg klart" : "tittade på"} </span>
              <span style="font-weight:600">${esc(a.title)}</span>
            </div>
            <span style="color:var(--muted);font-size:12px;white-space:nowrap;padding-left:12px">${fmtRelativeTime(a.watched_at)}</span>
          </div>`).join("")}
      </div>`;
  } catch(e) {
    el.innerHTML = "";
  }
}

async function loadPlaybackStats() {
  const el = document.getElementById("playback-stats-section");
  const activeUsersEl = document.getElementById("most-active-users-section");
  if (!el) return;
  try {
    const s = await API.get("/admin/playback-stats?days=30");
    if (!s.totalPlays) {
      el.innerHTML = `<div class="settings-section-title">Uppspelningsstatistik (senaste 30 dagarna)</div>
        <p style="color:var(--muted);font-size:13px">Inga uppspelningar loggade än.</p>`;
      if (activeUsersEl) activeUsersEl.innerHTML = "";
      return;
    }
    const maxDaily = Math.max(1, ...s.dailyStats.map(d => d.direct + d.transcode));

    // Bottom row, matching the sketch: Format som transkodas mest (small) | Uppspelningsstatistik (wide, middle) | Mest sedda (small)
    el.innerHTML = `
      <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:1;min-width:200px">
          <div class="settings-section-title">Format som transkodas mest</div>
          ${s.byContainerCodec.length ? `<div style="display:flex;flex-direction:column;gap:4px">
            ${s.byContainerCodec.map(c => `
              <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;background:var(--card2);border-radius:6px;padding:6px 10px">
                <span>${esc(c.combo)}</span>
                <span style="color:${c.transcodePct > 50 ? "#e67e22" : "var(--muted)"}">${c.transcodePct}% (${c.total}x)</span>
              </div>`).join("")}
          </div>` : `<p style="color:var(--muted);font-size:12px">Inget ännu</p>`}
        </div>

        <div style="flex:2;min-width:280px">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
            <div class="settings-section-title" style="margin:0">Uppspelningsstatistik (senaste ${s.days} dagarna)</div>
            <button class="btn-fav" style="font-size:11px;color:var(--muted)" onclick="resetPlaybackStats()" title="Rensar all uppspelningshistorik permanent">🗑 Nollställ</button>
          </div>
          <div style="display:flex;gap:10px;margin:10px 0;flex-wrap:wrap">
            <div style="background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:10px 16px;text-align:center;flex:1;min-width:100px">
              <div style="font-size:20px;font-weight:600">${s.totalPlays}</div>
              <div style="font-size:11px;color:var(--muted)">Uppspelningar</div>
            </div>
            <div style="background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:10px 16px;text-align:center;flex:1;min-width:100px">
              <div style="font-size:20px;font-weight:600;color:#2ecc71">${s.directPct}%</div>
              <div style="font-size:11px;color:var(--muted)">Direkt</div>
            </div>
            <div style="background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:10px 16px;text-align:center;flex:1;min-width:100px">
              <div style="font-size:20px;font-weight:600;color:#e67e22">${100 - s.directPct}%</div>
              <div style="font-size:11px;color:var(--muted)">Transkodning</div>
            </div>
          </div>
          ${s.dailyStats.length ? `<div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Per dag (Direkt/Transkodning)</div>
            <div style="display:flex;align-items:flex-end;gap:3px;height:80px">
              ${s.dailyStats.map(d => {
                const total = d.direct + d.transcode;
                const h = Math.max(2, Math.round((total / maxDaily) * 76));
                const directH = total ? Math.round((d.direct / total) * h) : 0;
                return `<div title="${d.date}: ${d.direct} direkt, ${d.transcode} transkodat" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:76px">
                  <div style="background:#e67e22;height:${h - directH}px;border-radius:2px 2px 0 0"></div>
                  <div style="background:#2ecc71;height:${directH}px;border-radius:${h - directH > 0 ? "0" : "2px 2px"} 0 0"></div>
                </div>`;
              }).join("")}
            </div>
          </div>` : ""}
        </div>

        <div style="flex:1;min-width:200px">
          <div class="settings-section-title">Mest sedda</div>
          ${s.mostWatched.length ? `<div style="display:flex;flex-direction:column;gap:4px">
            ${s.mostWatched.map(m => `
              <div style="display:flex;justify-content:space-between;font-size:12px;background:var(--card2);border-radius:6px;padding:6px 10px">
                <span>${m.type === "episode" ? "📺" : "🎬"} ${esc(m.title)}</span>
                <span style="color:var(--muted)">${m.plays}x</span>
              </div>`).join("")}
          </div>` : `<p style="color:var(--muted);font-size:12px">Inget ännu</p>`}
        </div>
      </div>
    `;

    if (activeUsersEl && s.mostActiveUsers?.length) {
      activeUsersEl.innerHTML = `
        <div class="settings-section-title">Mest aktiva användare</div>
        <div style="display:flex;flex-wrap:wrap;gap:12px">
          ${s.mostActiveUsers.map(u => `
            <div style="background:var(--card2);border-radius:8px;overflow:hidden;flex:1;min-width:240px">
              <div style="display:flex;align-items:center;gap:10px;padding:10px 12px">
                <span style="width:28px;height:28px;border-radius:50%;background:var(--accent,#3498db);color:#fff;font-size:13px;display:flex;align-items:center;justify-content:center;flex-shrink:0">${esc((u.username||"?")[0].toUpperCase())}</span>
                <div>
                  <div style="font-weight:600;font-size:13px">${esc(u.username)}</div>
                  <div style="font-size:11px;color:var(--muted)">${u.plays} spelningar · ${fmtHoursMin(u.totalMinutes)}</div>
                </div>
              </div>
              <div style="font-size:12px">
                <div style="display:flex;justify-content:space-between;padding:5px 12px;background:rgba(0,0,0,0.15)"><span style="color:var(--muted)">Filmer</span><span>${fmtHoursMin(u.minutesByType.movie)}</span></div>
                <div style="display:flex;justify-content:space-between;padding:5px 12px"><span style="color:var(--muted)">Serier</span><span>${fmtHoursMin(u.minutesByType.tvshow)}</span></div>
                <div style="display:flex;justify-content:space-between;padding:5px 12px;background:rgba(0,0,0,0.15)"><span style="color:var(--muted)">Musik</span><span>${fmtHoursMin(u.minutesByType.music)}</span></div>
              </div>
            </div>`).join("")}
        </div>`;
    } else if (activeUsersEl) {
      activeUsersEl.innerHTML = "";
    }
  } catch(e) {
    el.innerHTML = "";
  }
}

function renderLiveActivitySection(data) {
  var sessions = data.sessions || [];
  return `
    <div class="settings-section" id="now-playing-section">
      <div class="settings-section-title">📺 Nu spelas</div>
      <div id="now-playing-content">${renderNowPlayingContent(sessions)}</div>
    </div>`;
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}` : `${m}:${String(s).padStart(2,"0")}`;
}

function fmtHoursMin(minutes) {
  minutes = Math.max(0, Math.round(minutes || 0));
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function renderNowPlayingContent(sessions) {
  if (!sessions.length) return `<div style="font-size:12px;color:var(--muted)">Ingen tittar just nu</div>`;
  return `<div style="display:flex;flex-direction:column;gap:10px">` + sessions.map(s => `
    <div style="background:var(--card2);border-radius:10px;overflow:hidden;display:flex">
      <div style="width:60px;flex-shrink:0;position:relative">
        ${s.posterUrl ? `<img src="${s.posterUrl}" style="width:100%;height:100%;object-fit:cover;display:block">` : `<div style="width:100%;height:100%;min-height:90px;background:var(--border);display:flex;align-items:center;justify-content:center;font-size:20px">${s.type==="tvshow"?"📺":"🎬"}</div>`}
      </div>
      <div style="flex:1;padding:10px 12px;min-width:0">
        <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.title)}</div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
          <span style="width:18px;height:18px;border-radius:50%;background:var(--accent,#3498db);color:#fff;font-size:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0">${esc((s.username||"?")[0].toUpperCase())}</span>
          <span style="font-size:12px;color:var(--muted)">${esc(s.username)}</span>
          <span style="font-size:11px;padding:1px 7px;border-radius:10px;margin-left:auto;background:${s.method === "direct" ? "rgba(46,204,113,0.15)" : "rgba(230,126,34,0.15)"};color:${s.method === "direct" ? "#2ecc71" : "#e67e22"}">${s.method === "direct" ? "Direct" : "Transkodning"}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
          <div style="flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden"><div style="height:100%;width:${s.progressPct}%;background:var(--accent,#3498db)"></div></div>
          <span style="font-size:11px;color:var(--muted);white-space:nowrap">${fmtTime(s.position)} / ${fmtTime(s.duration)}</span>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px">${esc(s.device || "Okänd klient")} · ${esc(s.ip || "?")}</div>
        ${s.videoInfo ? `<div style="font-size:11px;color:var(--muted);margin-top:6px;border-top:1px solid var(--border);padding-top:6px">
          <span style="opacity:0.7">Video</span> ${esc(s.videoInfo.source)}
          ${s.videoInfo.target ? `<div style="margin-left:14px">↳ ${esc(s.videoInfo.target)}</div>` : ""}
        </div>` : ""}
        ${s.audioInfo ? `<div style="font-size:11px;color:var(--muted);margin-top:4px">
          <span style="opacity:0.7">Ljud</span> ${esc(s.audioInfo.source)}
          <div style="margin-left:14px">↳ ${esc(s.audioInfo.target)}</div>
        </div>` : ""}
      </div>
    </div>`).join("") + `</div>`;
}

function renderDownloadsContent(downloads) {
  if (!downloads.length) return `<div style="font-size:12px;color:var(--muted)">Inga pågående</div>`;
  return `<div style="display:flex;flex-direction:column;gap:6px">` + downloads.map(d => `
    <div style="background:var(--card2);border-radius:8px;padding:8px 12px;font-size:13px">
      <div style="display:flex;justify-content:space-between;gap:8px">
        <div><b>${esc(d.username)}</b> – ${esc(d.title)}</div>
        ${d.stalled ? `<span style="font-size:11px;color:var(--muted)">Pausad/klar</span>` : ""}
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
        <div style="flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden"><div style="height:100%;width:${d.progressPct}%;background:var(--accent,#3498db)"></div></div>
        <span style="font-size:11px;color:var(--muted);white-space:nowrap">${d.progressPct}%</span>
      </div>
    </div>`).join("") + `</div>`;
}

function startLiveActivityPolling() {
  if (_liveActivityInterval) return;
  _liveActivityInterval = setInterval(async () => {
    try {
      var data = await API.get("/admin/live-activity");
      var el = document.getElementById("now-playing-content");
      if (el) el.innerHTML = renderNowPlayingContent(data.sessions || []);
    } catch {}
  }, 5000);
}

var _downloadsInterval = null;
function startDownloadsPolling() {
  if (_downloadsInterval) return;
  const refresh = async () => {
    try {
      var data = await API.get("/admin/live-activity");
      var el = document.getElementById("downloads-content");
      if (el) el.innerHTML = renderDownloadsContent(data.downloads || []);
    } catch {}
  };
  refresh();
  _downloadsInterval = setInterval(refresh, 5000);
}

function subtitleLangBreakdownHtml(counts, featured) {
  counts = counts || {};
  featured = featured && featured.length ? featured : ["eng"];
  var seen = {};
  var lines = featured.map(function(l) {
    seen[l] = true;
    var adj = SUBTITLE_LANG_ADJ[l] || l;
    return `<div style="padding-left:12px">${counts[l] || 0} med ${adj} text</div>`;
  });
  var otherCount = 0;
  Object.keys(counts).forEach(function(l) {
    if (!seen[l]) otherCount += counts[l];
  });
  if (otherCount > 0) {
    lines.push(`<div style="padding-left:12px;color:var(--muted)">${otherCount} med övriga språk</div>`);
  }
  return lines.join("");
}

// Files are found on disk almost instantly; TMDB lookups for each one are what's actually
// slow. This shows both numbers so "found 150, processed 7" is visible immediately instead
// of the admin seeing nothing until the first couple of TMDB calls finish.
function scanProgressText(progress) {
  if (!progress || !progress.found) return "⏳ Söker efter filer...";
  return `⏳ Skannar "${progress.library || "?"}": ${progress.processed} av ${progress.found} bearbetade (hämtar filminfo...)`;
}

var _scanProgressInterval = null;
function startScanProgressPolling() {
  if (_scanProgressInterval) return;
  _scanProgressInterval = setInterval(async () => {
    try {
      var data = await API.get("/scan/status");
      var el = document.getElementById("scan-progress-info");
      if (el) el.textContent = data.scanning ? scanProgressText(data.progress) : "";
      if (!data.scanning) {
        clearInterval(_scanProgressInterval);
        _scanProgressInterval = null;
        loadSettings(); // refresh the counts once the scan is actually done
      }
    } catch {}
  }, 3000);
}

function startCacheStatusPolling() {
  if (_cacheStatusInterval) return; // already polling
  _cacheStatusInterval = setInterval(async () => {
    try {
      const cs = await API.get("/subtitles/cache-status");
      const bar = document.getElementById("subtitle-cache-bar");
      const label = document.getElementById("subtitle-cache-label");
      const status = document.getElementById("subtitle-cache-status");
      const cached = document.getElementById("subtitle-cache-cached");
      const isDone = !cs.running && cs.queued === 0;
      const totalQueued = (cs.total || 0) + (cs.totalEps || 0);
      const pct = totalQueued > 0 ? Math.round((cs.done / totalQueued) * 100) : 0;
      if (bar) bar.style.width = pct + "%";
      if (label) label.textContent = cs.done + " av " + totalQueued + " klara";
      if (status) status.textContent = cs.running ? "⏳ Extraherar undertexter..." : cs.queued > 0 ? "⏳ Väntar i kö..." : "✅ Alla undertexter är redo!";
      const statsEl = document.getElementById("subtitle-cache-stats");
      if (statsEl) {
        let html = "";
        const lb = cs.languageBreakdown || { movies: {}, episodes: {} };
        const hasMovieStats = Object.keys(lb.movies || {}).length > 0;
        const hasEpStats = Object.keys(lb.episodes || {}).length > 0;
        if (hasMovieStats || cs.total > 0) {
          html += `<div style="font-weight:500;margin-bottom:2px">Filmer</div>`;
          html += subtitleLangBreakdownHtml(lb.movies, cs.featuredLanguages);
        }
        if (hasEpStats || (cs.totalEps || 0) > 0) {
          html += `<div style="font-weight:500;margin-top:6px;margin-bottom:2px">Serier → ${cs.totalShows || 0} serier · ${cs.totalEps || 0} avsnitt</div>`;
          html += subtitleLangBreakdownHtml(lb.episodes, cs.featuredLanguages);
        }
        statsEl.innerHTML = html;
      }
      if (cached) cached.textContent = "💾 " + cs.cached + " undertextfiler extraherade och sparade";
      if (isDone) {
        clearInterval(_cacheStatusInterval);
        _cacheStatusInterval = null;
      }
    } catch {}
  }, 3000);
}

function switchSettingsTab(tabId) {
  _settingsActiveTab = tabId;
  document.querySelectorAll("#sb-libraries .sb-item").forEach(el => el.classList.remove("active"));
  const el = document.getElementById("sb-stab-" + tabId);
  if (el) el.classList.add("active");
  loadSettings();
}

async function backfillGenres() {
  toast("⏳ Hämtar genrer, kan ta en stund...", "info");
  try {
    const data = await API.post("/admin/backfill-genres", {});
    toast(`✓ ${data.updated} av ${data.checked} titlar uppdaterade med genrer`, "success");
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

async function saveLibraryTuning() {
  try {
    await API.patch("/config", {
      periodic_scan_enabled: document.getElementById("periodic-scan-enabled")?.checked || false,
      periodic_scan_interval_hours: parseInt(document.getElementById("periodic-scan-interval")?.value) || 12,
      scan_low_priority: document.getElementById("scan-low-priority")?.checked || false,
      continue_watching_max_weeks: parseInt(document.getElementById("cw-max-weeks")?.value) ?? 16,
      continue_watching_max_items: parseInt(document.getElementById("cw-max-items")?.value) ?? 20,
      watched_threshold_pct: parseInt(document.getElementById("watched-threshold")?.value) || 90
    });
    window._watchedThresholdPct = parseInt(document.getElementById("watched-threshold")?.value) || 90;
    toast("✓ Sparat", "success");
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
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
    const [cfg, users, libs, scanStatus, updateInfo, cacheStatus, pgsStatus, ocrLangConfig, pendingOcr, liveActivity] = await Promise.all([
      API.get("/config"), API.get("/users"), API.get("/libraries"),
      API.get("/scan/status"), API.get("/updates/check").catch(() => null),
      API.get("/subtitles/cache-status").catch(() => null),
      API.get("/tools/pgstosrt-status").catch(() => ({ installed: false })),
      API.get("/subtitles/ocr-languages").catch(() => ({ mode: "selected", languages: [] })),
      currentUser?.role === "admin" ? API.get("/subtitles/ocr-pending").catch(() => ({ pending: [] })) : Promise.resolve({ pending: [] }),
      currentUser?.role === "admin" ? API.get("/admin/live-activity").catch(() => null) : Promise.resolve(null)
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
    if (scanStatus.scanning) {
      startScanProgressPolling();
    }

    sec.innerHTML = `<div class="settings-wrap" style="${_settingsActiveTab === "overview" ? "max-width:1400px" : ""}">
      <div class="settings-title">Inställningar</div>

      ${_settingsActiveTab === "overview" ? `
      ${(pendingOcr.pending || []).length > 0 ? `<div class="settings-section" style="border:1px solid var(--danger,#e74c3c);background:rgba(231,76,60,0.08)">
        <div class="settings-section-title">🔔 Väntande undertextspråk (${pendingOcr.pending.length})</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">Dessa användare har valt ett språk som inte cachas för bildbaserade (OCR) undertexter än.</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${pendingOcr.pending.map(p => `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--card2);border-radius:8px;padding:8px 12px">
              <div style="font-size:13px">
                <b>${esc(SUBTITLE_LANG_ADJ[p.lang] || p.lang)}</b> – begärt av ${esc(p.username)}
                <div style="font-size:11px;color:var(--muted)">${new Date(p.requestedAt).toLocaleString("sv-SE")}</div>
              </div>
              <div style="display:flex;gap:6px;flex-shrink:0">
                <button class="btn-fav" style="font-size:12px" onclick="addOcrLanguage('${p.lang}')">+ Lägg till</button>
                <button class="btn-fav" style="font-size:12px" onclick="dismissOcrRequest('${p.lang}','${p.userId}')">Avvisa</button>
              </div>
            </div>`).join("")}
        </div>
      </div>` : ""}

      ${liveActivity ? renderLiveActivitySection(liveActivity) : ""}

      <div class="settings-section" id="system-stats-section"></div>

      <div class="settings-section" id="recent-activity-section"></div>

      <div class="settings-section" id="weekly-history-section"></div>

      <div class="settings-section" id="most-active-users-section"></div>

      <div class="settings-section" id="playback-stats-section"></div>

      ` : ""}

      ${_settingsActiveTab === "subs" ? `
      ${cacheStatus ? `<div class="settings-section" id="subtitle-cache-section">
        <div class="settings-section-title">Automatiska undertexter</div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:8px" id="subtitle-cache-stats">
          ${(Object.keys(cacheStatus.languageBreakdown?.movies || {}).length > 0 || (cacheStatus.total || 0) > 0) ? `<div style="font-weight:500;margin-bottom:2px">Filmer</div>
            ${subtitleLangBreakdownHtml(cacheStatus.languageBreakdown?.movies, cacheStatus.featuredLanguages)}` : ""}
          ${(Object.keys(cacheStatus.languageBreakdown?.episodes || {}).length > 0 || (cacheStatus.totalEps || 0) > 0) ? `<div style="font-weight:500;margin-top:6px;margin-bottom:2px">Serier${cacheStatus.totalEps ? ` → ${cacheStatus.totalShows || "?"} serier · ${cacheStatus.totalEps} avsnitt` : ""}</div>
            ${subtitleLangBreakdownHtml(cacheStatus.languageBreakdown?.episodes, cacheStatus.featuredLanguages)}` : ''}
        </div>
        <div style="margin-bottom:10px">
          <div style="font-size:13px;font-weight:500;margin-bottom:6px">
            <span id="subtitle-cache-status">${cacheStatus.running ? '⏳ Extraherar undertexter...' : cacheStatus.queued > 0 ? '⏳ Väntar i kö...' : '✅ Alla undertexter är redo!'}</span>
          </div>
          ${(cacheStatus.running || cacheStatus.queued > 0) ? `
          <div style="background:var(--card2);border-radius:4px;height:8px;overflow:hidden;margin-bottom:6px">
            <div id="subtitle-cache-bar" style="height:100%;background:var(--accent);border-radius:4px;animation:pulse 1.5s ease-in-out infinite;width:100%"></div>
          </div>` : ''}
          ${((cacheStatus.gated||0) + (cacheStatus.gatedEps||0)) > 0 ? `<div style="font-size:11px;color:var(--muted);margin-top:4px">⏸ ${(cacheStatus.gated||0) + (cacheStatus.gatedEps||0)} filer har bildbaserade spår som väntar på OCR (inte i språklistan än, eller PgsToSrt ej installerat)</div>` : ''}
          ${(cacheStatus.errors||0) > 0 ? `<div style="font-size:11px;color:var(--danger,#e74c3c);margin-top:4px">⚠️ ${cacheStatus.errors} filer misslyckades – se undertext-loggen för orsak</div>` : ''}
        </div>
        <div id="subtitle-cache-cached" style="font-size:12px;color:var(--muted)">💾 ${cacheStatus.done > 0 ? cacheStatus.done : cacheStatus.cached} undertextfiler extraherade och sparade</div>
        ${currentUser?.role === "admin" ? `<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="btn-fav" style="font-size:12px" onclick="openSubtitleLog()">📋 Visa undertext-logg${cacheStatus.errors > 0 ? ` (${cacheStatus.errors} fel)` : ""}</button>
          <button class="btn-fav" style="font-size:12px" onclick="recacheAllSubtitles()">🔄 Cacha om enligt språklistan</button>
          <button class="btn-fav" style="font-size:12px" onclick="clearSubtitleCache()">🗑 Rensa all undertextcache</button>
          <button class="btn-fav" style="font-size:12px" id="verbose-sub-log-btn" onclick="toggleVerboseSubtitleLogging()">🔬 Detaljerad loggning: laddar...</button>
        </div>` : ""}
      </div>` : ''}

      ${currentUser?.role === "admin" ? `<div class="settings-section" id="subtitle-ocr-section">
        <div class="settings-section-title">Undertextspråk att cacha</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">Styr vilka språk som cachas överhuvudtaget — textbaserade spår, externa .srt-filer, OCH bildbaserade (PGS/VOBSUB, som dessutom kräver tung OCR-konvertering). Med många filer och många språkspår per fil blir "cacha allt" fort tungt även för textspår — särskilt på svagare hårdvara.</div>
        <div style="margin-bottom:10px">
          <select class="s-input" id="s-ocr-mode" onchange="saveOcrMode(this.value)" style="cursor:pointer">
            <option value="selected" ${ocrLangConfig.mode !== "all" ? "selected" : ""}>Cacha bara valda språk (rekommenderas)</option>
            <option value="all" ${ocrLangConfig.mode === "all" ? "selected" : ""}>Cacha alla språk automatiskt (för stora bibliotek/många användare)</option>
          </select>
        </div>
        ${ocrLangConfig.mode !== "all" ? `
        <div id="ocr-lang-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
          ${(ocrLangConfig.languages || []).map(l => `
            <span style="background:var(--card2);border:1px solid var(--border);border-radius:20px;padding:4px 6px 4px 12px;font-size:12px;display:flex;align-items:center;gap:6px">
              ${esc(SUBTITLE_LANG_ADJ[l] || l)}
              <button onclick="removeOcrLanguage('${l}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;line-height:1;padding:2px">✕</button>
            </span>`).join("")}
        </div>
        <div style="display:flex;gap:8px">
          <select class="s-input" id="ocr-add-lang-select" style="flex:1">
            ${Object.keys(SUBTITLE_LANG_ADJ).filter(l => l !== "und" && !(ocrLangConfig.languages || []).includes(l)).map(l => `<option value="${l}">${esc(SUBTITLE_LANG_ADJ[l])}</option>`).join("")}
          </select>
          <button class="btn-fav" style="font-size:12px" onclick="addOcrLanguage()">+ Lägg till</button>
        </div>` : ''}
      </div>` : ''}

      <div class="settings-section">
        <div class="settings-section-title">Bildbaserade undertexter (PGS/VOBSUB)</div>
        <div id="pgstosrt-status-section">
          ${pgsStatus.installed ? `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <span style="color:var(--accent)">✅</span>
            <span style="font-size:13px">PgsToSrt är installerat och redo</span>
          </div>` : `
          <div style="font-size:13px;color:var(--muted);margin-bottom:12px">
            Krävs för att konvertera bildbaserade undertexter (PGS/VOBSUB) till text. 
            Utan detta kan dessa undertexter inte visas.
          </div>
          <button class="s-btn s-btn-primary" onclick="installPgsToSrt()" id="pgstosrt-install-btn">
            📥 Installera nu (~50MB)
          </button>`}
          <div id="pgstosrt-progress" style="display:none;margin-top:12px">
            <div style="font-size:13px;margin-bottom:6px" id="pgstosrt-progress-msg">Förbereder...</div>
            <div style="background:var(--card2);border-radius:4px;height:8px;overflow:hidden">
              <div id="pgstosrt-progress-bar" style="height:100%;background:var(--accent);border-radius:4px;width:0%;transition:width 0.3s"></div>
            </div>
          </div>
        </div>
      </div>
      ` : ""}

      ${_settingsActiveTab === "library" ? `
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
          <button class="s-btn" onclick="updateCollections()">🎬 Uppdatera samlingar</button>
          <button class="s-btn" onclick="fullRescan()" style="border-color:#e74c3c;color:#e74c3c;">🗑 Rensa och skanna om allt</button>
          <button class="s-btn" onclick="backfillGenres()">🎭 Hämta genrer för befintliga titlar</button>
        </div>
        <div id="scan-progress-info" style="font-size:12px;color:var(--muted);margin-top:8px;">${scanStatus.scanning ? scanProgressText(scanStatus.progress) : ""}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px;">👁 Filbevakning aktiv · <span id="next-scan-label">Beräknar...</span></div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Skanning</div>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:14px;margin-bottom:10px">
          <input type="checkbox" id="periodic-scan-enabled" ${cfg.periodic_scan_enabled ? "checked" : ""} onchange="saveLibraryTuning()">
          <span>Kör en schemalagd säkerhetsskanning, utöver filbevakningen</span>
        </label>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;margin-left:28px">
          <span style="font-size:13px;color:var(--muted)">Intervall:</span>
          <select id="periodic-scan-interval" class="s-input" style="max-width:140px" onchange="saveLibraryTuning()">
            <option value="6" ${cfg.periodic_scan_interval_hours==6?"selected":""}>Var 6:e timme</option>
            <option value="12" ${!cfg.periodic_scan_interval_hours||cfg.periodic_scan_interval_hours==12?"selected":""}>Var 12:e timme</option>
            <option value="24" ${cfg.periodic_scan_interval_hours==24?"selected":""}>Var 24:e timme</option>
          </select>
        </div>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:14px">
          <input type="checkbox" id="scan-low-priority" ${cfg.scan_low_priority ? "checked" : ""} onchange="saveLibraryTuning()">
          <span>Kör skanning med lägre prioritet (stör pågående uppspelning mindre)</span>
        </label>
        <div style="font-size:11px;color:var(--muted);margin-top:4px;margin-left:28px">Endast Windows. Sänker serverns processprioritet under en skanning, återställs efteråt.</div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Fortsätt titta</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <div>
            <label style="font-size:13px;color:var(--muted)">Ta bort objekt efter (veckor)</label><br>
            <input type="number" id="cw-max-weeks" class="s-input" value="${cfg.continue_watching_max_weeks ?? 16}" style="width:80px" onchange="saveLibraryTuning()">
          </div>
          <div>
            <label style="font-size:13px;color:var(--muted)">Max antal objekt</label><br>
            <input type="number" id="cw-max-items" class="s-input" value="${cfg.continue_watching_max_items ?? 20}" style="width:80px" onchange="saveLibraryTuning()">
          </div>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:8px">Media som inte setts på så här många veckor visas inte längre i Fortsätt titta — förutom om en ny episod nyligen lagts till (t.ex. en säsongspremiär), då visas den ändå.</div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Uppspelning</div>
        <label style="font-size:13px;color:var(--muted)">Gräns för när något räknas som "sett"</label><br>
        <select id="watched-threshold" class="s-input" style="max-width:160px" onchange="saveLibraryTuning()">
          <option value="80" ${cfg.watched_threshold_pct==80?"selected":""}>80%</option>
          <option value="90" ${!cfg.watched_threshold_pct||cfg.watched_threshold_pct==90?"selected":""}>90%</option>
          <option value="95" ${cfg.watched_threshold_pct==95?"selected":""}>95%</option>
        </select>
        <div style="font-size:11px;color:var(--muted);margin-top:6px">Vid vilken spelningsprocent en video markeras som sedd.</div>
      </div>

      <div class="settings-section" id="downloads-section">
        <div class="settings-section-title">⬇️ Nedladdningar</div>
        <div id="downloads-content"><div style="font-size:12px;color:var(--muted)">Laddar...</div></div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Bibliotek</div>
        <div class="user-list" id="lib-list">
          ${libs.map(l => {
            const icons = { movies:"🎬", tvshows:"📺", music:"🎵" };
            return `<div class="user-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span style="font-size:20px;flex-shrink:0">${icons[l.type] || "📁"}</span>
              <div class="user-info" style="flex-shrink:0"><div class="user-name">${esc(l.name)}</div><div class="user-role">${esc(l.path)}</div></div>
              <input class="s-input" id="lib-name-en-${l.id}" placeholder="Engelskt namn (valfritt)" value="${esc(l.name_en||"")}" style="width:150px;font-size:12px;flex-shrink:0" onblur="saveLibraryNameEn('${l.id}')">
              <input class="s-input" id="lib-name-fi-${l.id}" placeholder="Finskt namn (valfritt)" value="${esc(l.name_fi||"")}" style="width:150px;font-size:12px;flex-shrink:0" onblur="saveLibraryNameFi('${l.id}')">
              <button class="s-btn" style="flex-shrink:0" onclick="rescanOneLibrary('${l.id}','${esc(l.name)}')" title="Skanna efter nya filer i just detta bibliotek">↻ Skanna</button>
              <button class="s-btn" style="border-color:#e74c3c;color:#e74c3c;flex-shrink:0" onclick="fullRescanOneLibrary('${l.id}','${esc(l.name)}')" title="Rensa och skanna om bara detta bibliotek från grunden">🗑 Rensa om</button>
              <button class="s-btn danger" style="flex-shrink:0" onclick="removeLib('${l.id}')">Ta bort</button>
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
      ` : ""}

      ${_settingsActiveTab === "users" ? `
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
          <select class="s-input" id="new-user-language" style="cursor:pointer">
            <option value="">🌐 Använd serverns inställning</option>
            <option value="en-US">🇺🇸 English</option>
            <option value="sv-SE">🇸🇪 Svenska</option>
            <option value="no-NO">🇳🇴 Norsk</option>
            <option value="da-DK">🇩🇰 Dansk</option>
            <option value="fi-FI">🇫🇮 Suomi</option>
            <option value="de-DE">🇩🇪 Deutsch</option>
            <option value="fr-FR">🇫🇷 Français</option>
            <option value="es-ES">🇪🇸 Español</option>
            <option value="nl-NL">🇳🇱 Nederlands</option>
          </select>
          <button class="s-btn primary" onclick="addUser()">Lägg till</button>
        </div>
        <div style="margin-top:8px">
          <button class="btn-fav" style="font-size:11px;color:var(--muted)" onclick="purgeGhostUsers()" title="Städar bort gamla borttagna konton som blockerar återanvändning av användarnamn">🧹 Städa bort gamla borttagna konton</button>
        </div>
      </div>
      ` : ""}

      ${_settingsActiveTab === "server" ? `
      <div class="settings-section">
        <div class="settings-section-title">Server</div>
        <div class="setting-row">
          <div><div class="setting-label">Servernamn</div><div class="setting-desc">Visas på filmsidan under "Var kan du se den?"</div></div>
          <input class="s-input" type="text" id="s-server-name" value="${esc(cfg.server_name || "StreamVault")}" placeholder="StreamVault"/>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Språk</div>
        <div class="setting-row">
          <div><div class="setting-label">Gränssnittsspråk & metadata</div><div class="setting-desc">Styr språk för filmbeskrivningar från TMDB och OCR-undertexter</div></div>
          <select class="s-input" id="s-language" onchange="saveLanguageSetting(this.value)" style="cursor:pointer">
            <option value="en-US" ${(cfg.language||'en-US')==='en-US'?'selected':''}>🇺🇸 English</option>
            <option value="sv-SE" ${cfg.language==='sv-SE'?'selected':''}>🇸🇪 Svenska</option>
            <option value="no-NO" ${cfg.language==='no-NO'?'selected':''}>🇳🇴 Norsk</option>
            <option value="da-DK" ${cfg.language==='da-DK'?'selected':''}>🇩🇰 Dansk</option>
            <option value="fi-FI" ${cfg.language==='fi-FI'?'selected':''}>🇫🇮 Suomi</option>
            <option value="de-DE" ${cfg.language==='de-DE'?'selected':''}>🇩🇪 Deutsch</option>
            <option value="fr-FR" ${cfg.language==='fr-FR'?'selected':''}>🇫🇷 Français</option>
            <option value="es-ES" ${cfg.language==='es-ES'?'selected':''}>🇪🇸 Español</option>
            <option value="nl-NL" ${cfg.language==='nl-NL'?'selected':''}>🇳🇱 Nederlands</option>
            <option value="ja-JP" ${cfg.language==='ja-JP'?'selected':''}>🇯🇵 日本語</option>
          </select>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">API-nycklar</div>
        <div class="setting-row">
          <div><div class="setting-label">TMDB API-nyckel</div><div class="setting-desc">Filmaffischer och beskrivningar</div></div>
          <input class="s-input" type="password" id="s-tmdb" value="${esc(cfg.tmdb_api_key || "")}" placeholder="Ej angiven" autocomplete="off"/>
        </div>
        <div style="margin:-4px 0 12px"><button class="btn-fav" style="font-size:12px" onclick="testTmdbConnection()">🔍 Testa TMDB-anslutning</button></div>
        <div class="setting-row">
          <div><div class="setting-label">OMDb API-nyckel</div><div class="setting-desc">IMDb, Rotten Tomatoes och Metacritic-betyg</div></div>
          <input class="s-input" type="password" id="s-omdb" value="${esc(cfg.omdb_api_key || "")}" placeholder="Ej angiven" autocomplete="off"/>
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
        <div style="margin-top:12px"><button class="s-btn primary" onclick="saveApiKeys()">Spara nycklar</button></div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Serveruppdateringar (bibliotek)</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">
          Söker efter nyare versioner av de bibliotek StreamVault bygger på, plus om det finns en nyare Node.js-version (installeras aldrig automatiskt — bara en påminnelse med en liten guide).
        </div>
        <button class="btn-fav" onclick="checkDependencyUpdates()">🔍 Sök efter uppdateringar</button>
        <div id="dependency-results" style="margin-top:14px"></div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Systemlogg</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">
          Allt servern loggar — varje API-anrop (inklusive vad appen faktiskt begär), alla [SCAN]/[DASH]/[CROPDETECT]-rader, fel och varningar. Rullas om dagligen, sparas i 3 dagar.
        </div>
        <button class="btn-fav" onclick="openServerLog()">🖥️ Visa systemlogg</button>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">IPTV</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">
          🧪 Experimentell funktion, under utveckling. Syns inte i sidopanelen för någon förrän du aktivt slår på den här nedan.
        </div>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:14px;margin-bottom:14px">
          <input type="checkbox" id="iptv-enabled-toggle" ${cfg.iptv_enabled ? "checked" : ""} onchange="saveIptvEnabledToggle(this.checked)">
          <span>Aktivera IPTV (visa i sidopanelen)</span>
        </label>
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">
          Klistra in en M3U-spellista-adress för att hämta och tolka kanalerna.
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <input type="text" id="iptv-url-input" class="s-input" placeholder="https://exempel.se/spellista.m3u" value="${esc(cfg.iptv_m3u_url||"")}" style="flex:1">
          <button class="btn-fav" onclick="parseIptvPlaylist()">Hämta & tolka</button>
        </div>
        <div id="iptv-status" style="font-size:13px;color:var(--muted)"></div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Trailer-uppspelning på Android TV</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px;line-height:1.5">
          Löser trailer-uppspelning på Android TV-enheter där YouTubes inbäddade spelare inte fungerar (svart skärm). Använder tredjepartstjänster för att hämta en direkt videoström, utanför YouTubes officiella API och användarvillkor.
          <br><br><strong>Av som standard.</strong> Tänkt för privat, eget bruk — inte något att ha på om servern delas brett med andra utanför din familj. Om avstängd faller Android-appen tillbaka på att öppna YouTube-appen istället.
        </div>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:14px">
          <input type="checkbox" id="trailer-stream-toggle" ${cfg.trailer_stream_enabled ? "checked" : ""} onchange="saveTrailerStreamToggle(this.checked)">
          <span>Aktivera trailer-strömning via tredjepartstjänst</span>
        </label>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Uppdateringskanal</div>
        <div style="margin-bottom:12px">
          <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Välj vilken kanal du vill ta emot uppdateringar från.</div>
          <div style="display:flex;gap:12px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px">
              <input type="radio" name="update_channel" value="stable" ${(cfg.update_channel||"stable")==="stable"?"checked":""} onchange="saveChannelSetting('stable')">
              <span>🟢 Stabil</span>
            </label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px">
              <input type="radio" name="update_channel" value="beta" ${cfg.update_channel==="beta"?"checked":""} onchange="saveChannelSetting('beta')">
              <span>🧪 Beta</span>
            </label>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:6px">Beta-kanalen kan innehålla instabila funktioner under testning.</div>
        </div>
      </div>
      ` : ""}

      <div style="padding:20px 0;font-size:12px;color:var(--muted)">StreamVault v${updateInfo?.current || "–"}</div>
    </div>`;

    if (currentUser?.role === "admin" && liveActivity) startLiveActivityPolling();
    if (currentUser?.role === "admin" && _settingsActiveTab === "library") startDownloadsPolling();
    if (currentUser?.role === "admin" && _settingsActiveTab === "overview") { loadPlaybackStats(); startSystemStatsPolling(); loadRecentActivity(); loadWeeklyHistoryChart(); }
    if (currentUser?.role === "admin" && _settingsActiveTab === "subs") initVerboseSubtitleLoggingButton();
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

async function updateCollections() {
  if (!confirm("Uppdatera samlingar? Detta kör igenom alla matchade filmer och söker efter samlingstillhörighet på TMDB.")) return;
  try {
    toast("⏳ Uppdaterar samlingar...", "info");
    const result = await API.post("/scan/update-collections", {});
    toast(`✓ ${result.updated} filmer uppdaterade i samlingar!`, "success");
    setTimeout(() => loadSettings(), 1000);
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
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

// Rescans just one library for new files, leaving everything else (and every other library)
// completely untouched.
async function rescanOneLibrary(libId, libName) {
  toast(`⏳ Skannar "${libName}"...`, "info");
  try {
    var data = await API.post(`/scan/library/${libId}/rescan`, {});
    toast(data.message || "Skanning startad", "success");
    startScanProgressPolling();
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

// Clears everything belonging to just this one library (its entries, their history, their
// subtitle cache) and rescans it from scratch — every other library is left completely alone.
async function fullRescanOneLibrary(libId, libName) {
  if (!confirm(`Detta raderar all filminformation för biblioteket "${libName}" (bara det här biblioteket) och skannar om det från noll.\n\nDina faktiska filer på disk rörs inte, och andra bibliotek påverkas inte alls.\n\nFortsätt?`)) return;
  toast(`⏳ Rensar och skannar om "${libName}"...`, "info");
  try {
    var data = await API.post(`/scan/library/${libId}/full-rescan`, {});
    toast(data.message || "Rensning och skanning startad", "success");
    startScanProgressPolling();
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
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
  const language = document.getElementById("new-user-language")?.value || "";
  if (!username || !password) { toast("Ange användarnamn och lösenord", "error"); return; }
  try {
    const result = await API.post("/users", { username, password, role, language: language || null });
    toast(`✓ ${username} skapad!`, "success");
    if (result?.needsOcrLanguage) {
      if (currentUser?.role === "admin") {
        promptAddOcrLanguage(result.needsOcrLanguage);
      } else {
        var label = SUBTITLE_LANG_ADJ[result.needsOcrLanguage] || result.needsOcrLanguage;
        toast(`ℹ️ Bildbaserade undertexter på ${label} är inte aktiverat än – be en administratör lägga till det i Inställningar`, "info");
      }
    }
    loadSettings();
  }
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
  // Refresh user data from server to get latest language setting
  if (user.id === currentUser?.id || user._id === currentUser?.id) {
    try {
      const fresh = await API.get("/me");
      if (fresh) user = { ...user, ...fresh };
    } catch {}
  }
  const main = document.getElementById("sec-settings");
  main.innerHTML = `
    <div style="max-width:600px;margin:0 auto;padding:24px">
      <button class="s-btn" onclick="switchSection('settings')" style="margin-bottom:20px">${t("profile.back")}</button>
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:24px">
        <div class="user-av" style="width:56px;height:56px;font-size:24px">${(user.username||"?")[0].toUpperCase()}</div>
        <div>
          <div style="font-size:20px;font-weight:600">${esc(user.username)}</div>
          <span class="user-badge ${user.role === "admin" ? "badge-admin" : "badge-user"}">${user.role === "admin" ? t("profile.role_admin") : t("profile.role_user")}</span>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">${t("profile.user_info")}</div>
        <div style="font-size:13px;color:var(--muted)">${t("profile.last_login")} ${user.last_login ? new Date(user.last_login).toLocaleDateString("sv-SE") : t("profile.never")}</div>
        <div style="font-size:13px;color:var(--muted);margin-top:4px">${t("profile.created")} ${user.created_at ? new Date(user.created_at).toLocaleDateString("sv-SE") : t("profile.unknown")}</div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">${t("profile.appearance")}</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">${(user.id === currentUser?.id || user._id === currentUser?.id) ? t("profile.theme_desc_self") : t("profile.theme_desc_other")}</div>
        <div style="display:flex;flex-wrap:wrap;gap:10px">
          ${Object.entries(THEMES).map(([key, theme]) => `
            <div onclick="saveUserTheme('${user.id}', '${key}')" style="cursor:pointer;width:120px;border-radius:10px;overflow:hidden;border:2px solid ${(user.theme||"standard")===key ? "var(--accent)" : "var(--border)"}">
              <div style="height:50px;background:${theme.vars["--bg"]};display:flex;align-items:center;justify-content:center">
                <span style="width:16px;height:16px;border-radius:50%;background:${theme.vars["--accent"]}"></span>
                <span style="width:24px;height:10px;border-radius:3px;background:${theme.vars["--card2"]};margin-left:6px"></span>
              </div>
              <div style="padding:6px 8px;font-size:11px;background:var(--card2);color:var(--text)">${t("theme." + key)}</div>
            </div>`).join("")}
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">${t("profile.streaming_services")}</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">${t("profile.streaming_services_desc")}</div>
        <div id="streaming-services-list-${user.id}" style="max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px"><div style="color:var(--muted);font-size:13px;padding:10px">${t("profile.loading")}</div></div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="s-btn primary" onclick="saveStreamingServices('${user.id}')">${t("profile.save")}</button>
          <button class="s-btn" onclick="clearStreamingServices('${user.id}')">${t("profile.show_all_again")}</button>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title" style="display:flex;align-items:center;gap:8px">
          ${t("profile.smart_home")}
          <span onclick="showWebhookHelp()" style="cursor:pointer;width:18px;height:18px;border-radius:50%;background:var(--card2);border:1px solid var(--border);display:inline-flex;align-items:center;justify-content:center;font-size:12px;color:var(--muted)">?</span>
        </div>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;margin-bottom:10px">
          <input type="checkbox" id="webhook-enabled-${user.id}" ${user.webhook_enabled ? "checked" : ""} onchange="toggleUserWebhookEnabled('${user.id}', this.checked)">
          <span>${t("profile.enable_webhook")}</span>
        </label>
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">${t("profile.webhook_desc")}</div>
        <div style="display:flex;gap:8px">
          <input type="text" id="webhook-url-input-${user.id}" class="s-input" placeholder="https://din-hemautomation.se/webhook/..." value="${esc(user.webhook_url||"")}" style="flex:1" ${!user.webhook_enabled ? "disabled" : ""}>
          <button class="s-btn primary" onclick="saveUserWebhook('${user.id}')">${t("profile.save")}</button>
        </div>
      </div>
      ${currentUser.role === "admin" && user.role !== "admin" ? `<div class="settings-section">
        <div class="settings-section-title">Biblioteksbehörigheter</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Välj vilka bibliotek användaren har tillgång till.</div>
        <div id="lib-access-list" style="display:flex;flex-direction:column;gap:8px"></div>
        <button class="s-btn primary" style="margin-top:12px" onclick="saveLibraryAccess('${user.id}')">Spara behörigheter</button>
      </div>` : ""}
      <div class="settings-section">
        <div class="settings-section-title">${t("profile.language_setting")}</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px">${t("profile.language_desc")}</div>
        <select class="s-input" id="up-language" style="cursor:pointer">
          <option value="" ${!user.language?'selected':''}>${t("profile.use_server_setting")}</option>
          <option value="en-US" ${user.language==='en-US'?'selected':''}>🇺🇸 English</option>
          <option value="sv-SE" ${user.language==='sv-SE'?'selected':''}>🇸🇪 Svenska</option>
          <option value="no-NO" ${user.language==='no-NO'?'selected':''}>🇳🇴 Norsk</option>
          <option value="da-DK" ${user.language==='da-DK'?'selected':''}>🇩🇰 Dansk</option>
          <option value="fi-FI" ${user.language==='fi-FI'?'selected':''}>🇫🇮 Suomi</option>
          <option value="de-DE" ${user.language==='de-DE'?'selected':''}>🇩🇪 Deutsch</option>
          <option value="fr-FR" ${user.language==='fr-FR'?'selected':''}>🇫🇷 Français</option>
          <option value="es-ES" ${user.language==='es-ES'?'selected':''}>🇪🇸 Español</option>
          <option value="nl-NL" ${user.language==='nl-NL'?'selected':''}>🇳🇱 Nederlands</option>
        </select>
        <button class="s-btn s-btn-primary" style="margin-top:10px" onclick="saveUserLanguage('${user.id}')">${t("profile.save_language")}</button>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">${t("profile.subtitle_priority")}</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">
          ${t("profile.subtitle_priority_desc")}
        </div>
        <div id="sub-priority-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px"></div>
        <div style="display:flex;gap:8px">
          <select class="s-input" id="sub-priority-add-select" style="flex:1"></select>
          <button class="btn-fav" style="font-size:12px" onclick="addSubtitlePriorityLang('${user.id}')">${t("profile.add")}</button>
        </div>
        <button class="s-btn s-btn-primary" style="margin-top:10px" onclick="saveSubtitlePriority('${user.id}')">${t("profile.save_priority")}</button>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">${t("profile.change_password")}</div>
        <div style="display:flex;flex-direction:column;gap:10px;max-width:320px">
          <input id="up-new-pw" type="password" placeholder="${t("profile.new_password")}" class="s-input">
          <input id="up-confirm-pw" type="password" placeholder="${t("profile.confirm_password")}" class="s-input">
          <button class="s-btn" onclick="changeUserPassword('${user.id}')">${t("profile.save_password")}</button>
        </div>
      </div>
    </div>
  `;
  // Working copy of the priority list, edited in-memory until "Spara" is clicked
  window._subPriorityWorkingList = Array.isArray(user.subtitleLanguages) ? [...user.subtitleLanguages] : [];
  renderSubtitlePriorityList();
  // Load library access checkboxes
  if (currentUser.role === "admin" && user.role !== "admin") {
    loadLibraryAccessUI(user);
  }
  loadStreamingServicesList(user.id, user.preferred_watch_providers);
}

async function loadLibraryAccessUI(user) {
  const libs = await API.get("/libraries");
  const token = localStorage.getItem("sv_token") || API._token || "";
  const allLibs = await fetch("/api/libraries-all", { headers: { Authorization: "Bearer " + token } }).then(r => r.json()).catch(() => libs);
  const container = document.getElementById("lib-access-list");
  if (!container) return;
  const userLibIds = user.library_ids || [];
  const noRestrictions = userLibIds.length === 0;
  container.innerHTML = (allLibs.length ? allLibs : libs).map(lib => `
    <div style="display:flex;align-items:center;gap:8px;font-size:13px">
      <input type="checkbox" value="${lib.id}" ${noRestrictions || userLibIds.includes(lib.id) ? "checked" : ""} style="width:16px;height:16px;cursor:pointer">
      <span>${esc(lib.name)}</span> <span style="color:var(--muted);font-size:11px">(${lib.type})</span>
    </div>
  `).join("") + (window._iptvEnabled ? `
    <div style="display:flex;align-items:center;gap:8px;font-size:13px;border-top:1px solid var(--border);padding-top:8px;margin-top:4px">
      <input type="checkbox" value="iptv" ${noRestrictions || userLibIds.includes("iptv") ? "checked" : ""} style="width:16px;height:16px;cursor:pointer">
      <span>📡 IPTV</span> <span style="color:var(--muted);font-size:11px">(kanaler)</span>
    </div>` : "");
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

// One-time cleanup for accounts removed by the OLD (soft-delete) behavior — they're invisible
// in the user list above but still occupy their username. Safe to click even if there's
// nothing to clean up.
async function testTmdbConnection() {
  toast("⏳ Testar TMDB-anslutning...", "info");
  try {
    var result = await API.get("/tmdb/test");
    toast(result.ok ? "✅ " + result.message : "❌ " + result.message, result.ok ? "success" : "error");
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}

async function purgeGhostUsers() {
  if (!confirm("Detta letar reda på och permanent tar bort gamla konton som tidigare bara \"inaktiverades\" istället för att raderas helt (från innan den här uppdateringen). Deras användarnamn blir lediga igen. Fortsätt?")) return;
  try {
    var data = await API.post("/users/purge-inactive", {});
    if (data.purged > 0) {
      toast(`✓ ${data.purged} gammalt konto städat bort: ${data.usernames.join(", ")}`, "success");
    } else {
      toast("Inga gamla borttagna konton hittades – redan rent", "info");
    }
  } catch (e) { toast(e.message, "error"); }
}

async function addLib() {
  const name = document.getElementById("new-lib-name").value.trim();
  const type = document.getElementById("new-lib-type").value;
  const path = document.getElementById("new-lib-path").value.trim();
  if (!name || !path) { toast("Ange namn och sökväg", "error"); return; }
  try { await API.post("/libraries", { name, type, path }); toast(`✓ ${name} tillagd!`, "success"); loadSettings(); }
  catch (e) { toast(e.message, "error"); }
}

async function saveLibraryTranslatedName(libId, langCode) {
  const input = document.getElementById(`lib-name-${langCode}-${libId}`);
  if (!input) return;
  try {
    await API.patch(`/libraries/${libId}`, { [`name_${langCode}`]: input.value.trim() });
    toast("✓ Sparat", "success");
    loadSidebarLibraries(); // refresh so the change shows immediately if you're viewing as a user of that language
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
}
const saveLibraryNameEn = (libId) => saveLibraryTranslatedName(libId, "en");
const saveLibraryNameFi = (libId) => saveLibraryTranslatedName(libId, "fi");

async function removeLib(id) {
  if (!confirm("Ta bort biblioteket? Mediaobjekten tas bort från databasen men filerna på disk rörs inte.")) return;
  try { await API.delete("/libraries/" + id); toast("Bibliotek borttaget", "success"); loadSettings(); }
  catch (e) { toast(e.message, "error"); }
}

async function saveApiKeys() {
  try {
    await API.patch("/config", {
      server_name: document.getElementById("s-server-name")?.value?.trim() || "StreamVault",
      tmdb_api_key: document.getElementById("s-tmdb").value.trim(),
      omdb_api_key: document.getElementById("s-omdb").value.trim(),
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

// Truncates text to roughly maxLen characters, but backs up to the end of the last full word
// instead of cutting mid-word (e.g. "...Royal Academy o" — chopped a character-count cutoff
// happened to land inside "of"). Only adds "..." if the text was actually truncated.
function truncateAtWord(text, maxLen) {
  if (!text || text.length <= maxLen) return text || "";
  var cut = text.slice(0, maxLen);
  var lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  return cut.trim() + "...";
}

function toggleBio() {
  var short = document.getElementById("bio-short");
  var full = document.getElementById("bio-full");
  var link = document.getElementById("bio-toggle-link");
  if (!short || !full || !link) return;
  var isExpanded = full.style.display !== "none";
  short.style.display = isExpanded ? "inline" : "none";
  full.style.display = isExpanded ? "none" : "inline";
  link.textContent = isExpanded ? "Visa mer" : "Visa mindre";
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

async function openMusicFixMeta(kind, folderKey, currentName, artistFolderKey) {
  // kind: "artist" or "album"
  document.getElementById("fix-meta-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "fix-meta-overlay";
  overlay.style.cssText = "position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;z-index:10000!important;background:rgba(0,0,0,0.9)!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:20px!important;";
  overlay.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:600px;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;">
      <div style="padding:18px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;">
        <span style="font-size:18px">🔍</span>
        <div style="flex:1">
          <div style="font-size:15px;font-weight:600">Fixa ${kind === "artist" ? "artistinfo" : "albuminfo"}</div>
          <div style="font-size:12px;color:var(--muted)">${esc(currentName)}</div>
        </div>
        <button onclick="document.getElementById('fix-meta-overlay').remove()" style="background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;">✕</button>
      </div>
      <div style="padding:16px 20px;border-bottom:1px solid var(--border);">
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <input id="fix-music-search-input" style="flex:1;background:var(--card2);border:1px solid var(--border);color:var(--text);font-family:inherit;font-size:14px;padding:10px 14px;border-radius:8px;outline:none;" 
            type="text" placeholder="Sök på Spotify..." value="${esc(currentName)}"/>
          <button onclick="runMusicFixSearch('${kind}','${folderKey}','${artistFolderKey||""}')" style="background:var(--accent);border:none;color:white;font-family:inherit;font-size:14px;font-weight:500;padding:10px 18px;border-radius:8px;cursor:pointer;">Sök</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="file" id="fix-music-file-input" accept="image/*" style="display:none" onchange="handleMusicCoverUpload('${kind}','${folderKey}','${artistFolderKey||""}')"/>
          <button onclick="document.getElementById('fix-music-file-input').click()" style="background:var(--card2);border:1px solid var(--border);color:var(--text);font-family:inherit;font-size:13px;padding:8px 14px;border-radius:8px;cursor:pointer;">📁 Ladda upp egen bild</button>
          <span style="font-size:11px;color:var(--muted)">JPG/PNG, max 10MB</span>
        </div>
      </div>
      <div id="fix-music-results" style="flex:1;overflow-y:auto;padding:12px;">
        <div style="text-align:center;color:var(--muted);padding:32px;font-size:13px;">Skriv en sökning ovan och tryck Sök</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById("fix-music-search-input").addEventListener("keydown", e => {
    if (e.key === "Enter") runMusicFixSearch(kind, folderKey, artistFolderKey || "");
  });
  // Auto-run search immediately
  runMusicFixSearch(kind, folderKey, artistFolderKey || "");
}

async function runMusicFixSearch(kind, folderKey, artistFolderKey) {
  const q = document.getElementById("fix-music-search-input").value.trim();
  const resultsDiv = document.getElementById("fix-music-results");
  resultsDiv.innerHTML = `<div style="text-align:center;color:var(--muted);padding:32px;font-size:13px;">Söker...</div>`;
  try {
    const endpoint = kind === "artist" ? "/spotify/search-artists" : "/spotify/search-albums";
    const data = await API.get(endpoint + "?q=" + encodeURIComponent(q));
    if (data.rateLimited) {
      resultsDiv.innerHTML = `<div style="text-align:center;color:var(--muted);padding:32px;font-size:13px;">⏳ Spotify är tillfälligt begränsad. Försök igen om ${data.retryAfterSec}s</div>`;
      return;
    }
    const results = data.results || [];
    if (!results.length) {
      resultsDiv.innerHTML = `<div style="text-align:center;color:var(--muted);padding:32px;font-size:13px;">Inga resultat hittades</div>`;
      return;
    }
    resultsDiv.innerHTML = results.map(r => `
      <div style="display:flex;align-items:center;gap:12px;padding:10px;border-radius:8px;cursor:pointer;transition:background 0.15s" 
        onmouseover="this.style.background='var(--card2)'" onmouseout="this.style.background='none'"
        onclick='applyMusicFix("${kind}","${folderKey}","${artistFolderKey}",${JSON.stringify(r.image)},${JSON.stringify(r.name)})'>
        ${r.image ? `<img src="${r.image}" style="width:56px;height:56px;border-radius:8px;object-fit:cover;flex-shrink:0">` : `<div style="width:56px;height:56px;border-radius:8px;background:var(--card2);display:flex;align-items:center;justify-content:center;flex-shrink:0">${kind==="artist"?"🎤":"💿"}</div>`}
        <div style="flex:1;overflow:hidden">
          <div style="font-size:14px;font-weight:600">${esc(r.name)}</div>
          ${r.artist ? `<div style="font-size:12px;color:var(--muted)">${esc(r.artist)}</div>` : ""}
        </div>
      </div>`).join("");
  } catch(e) {
    resultsDiv.innerHTML = `<div style="text-align:center;color:var(--muted);padding:32px;font-size:13px;">Fel: ${e.message}</div>`;
  }
}

async function handleMusicCoverUpload(kind, folderKey, artistFolderKey) {
  const fileInput = document.getElementById("fix-music-file-input");
  const file = fileInput.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) return toast("Filen är för stor (max 10MB)", "error");
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const result = await API.post("/music/upload-cover", {
        imageBase64: reader.result,
        kind, folderKey, artistFolderKey
      });
      document.getElementById("fix-meta-overlay")?.remove();
      toast("✓ Bild uppladdad! Ladda om sidan för att se ändringen.", "success");
    } catch(e) {
      toast("Fel vid uppladdning: " + e.message, "error");
    }
  };
  reader.readAsDataURL(file);
}

async function applyMusicFix(kind, folderKey, artistFolderKey, image, name) {
  try {
    const folderName = decodeURIComponent(folderKey);
    if (kind === "artist") {
      await API.post("/spotify/artist-override", { folderName, image, name });
    } else {
      const artistFolder = decodeURIComponent(artistFolderKey);
      await API.post("/spotify/album-override", { artistFolder, albumFolder: folderName, image, name });
    }
    document.getElementById("fix-meta-overlay")?.remove();
    toast("✓ Uppdaterad! Ladda om sidan för att se ändringen.", "success");
  } catch(e) {
    toast("Fel: " + e.message, "error");
  }
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

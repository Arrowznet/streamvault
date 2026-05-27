// StreamVault - Internationalization (i18n)
const TRANSLATIONS = {
  sv: {
    // Nav
    home: "Hem", movies: "Filmer", tvshows: "Serier", music: "Musik",
    search: "Sök", settings: "Inställningar", logout: "Logga ut",
    // Home
    featured: "Utvalda", continueWatching: "Fortsätt titta",
    recentlyAdded: "Nytt i biblioteket", noContent: "Biblioteket är tomt",
    noContentSub: "Lägg till mediabibliotek under Inställningar → Bibliotek",
    // Playback
    play: "Spela", resume: "Fortsätt", moreInfo: "Mer info",
    favorite: "Favorit", favoriteAdded: "Tillagd i favoriter!",
    // Search
    searchPlaceholder: "Sök filmer, serier, musik...",
    inLibrary: "I ditt bibliotek", whereToWatch: "Var kan du se den?",
    noResults: "Inga träffar",
    // Settings
    library: "Bibliotek", users: "Användare", apiKeys: "API-nycklar",
    network: "Nätverk", language: "Språk", addLibrary: "Lägg till bibliotek",
    addUser: "Lägg till användare", saveKeys: "Spara nycklar",
    rescan: "Skanna om biblioteket", scanning: "Skannar biblioteket...",
    scanDone: "Biblioteket uppdaterat!",
    libraryName: "Biblioteksnamn", libraryPath: "Sökväg", libraryType: "Typ",
    movies: "Filmer", tvshows: "TV-serier", music: "Musik",
    username: "Användarnamn", password: "Lösenord", role: "Roll",
    admin: "Admin", user: "Användare",
    tmdbKey: "TMDB API-nyckel", opensubKey: "OpenSubtitles API-nyckel",
    port: "Port", // Login
    loginTitle: "Logga in", loginButton: "Logga in",
    loginError: "Fel användarnamn eller lösenord",
    // Episodes
    episodes: "Avsnitt", season: "Säsong",
    // Where to watch
    streamOn: "Streama på", rentOn: "Hyr på",
    notAvailable: "Inte tillgänglig på streamingtjänster just nu",
    // Misc
    loading: "Laddar...", error: "Fel", close: "Stäng",
    remove: "Ta bort", cancel: "Avbryt", save: "Spara",
    never: "Aldrig", lastLogin: "Senast inloggad",
    episodes_count: "avsnitt", tracks: "låtar", titles: "titlar",
    shows: "serier", unknownArtist: "Okänd artist",
    noDescription: "Ingen beskrivning tillgänglig.",
    connectionError: "Kunde inte ansluta till servern.",
    serverNotRunning: "Kontrollera att servern körs.",
  },
  en: {
    home: "Home", movies: "Movies", tvshows: "Series", music: "Music",
    search: "Search", settings: "Settings", logout: "Log out",
    featured: "Featured", continueWatching: "Continue Watching",
    recentlyAdded: "Recently Added", noContent: "Library is empty",
    noContentSub: "Add media libraries under Settings → Libraries",
    play: "Play", resume: "Resume", moreInfo: "More Info",
    favorite: "Favorite", favoriteAdded: "Added to favorites!",
    searchPlaceholder: "Search movies, series, music...",
    inLibrary: "In your library", whereToWatch: "Where to watch",
    noResults: "No results",
    library: "Libraries", users: "Users", apiKeys: "API Keys",
    network: "Network", language: "Language", addLibrary: "Add library",
    addUser: "Add user", saveKeys: "Save keys",
    rescan: "Rescan library", scanning: "Scanning library...",
    scanDone: "Library updated!",
    libraryName: "Library name", libraryPath: "Path", libraryType: "Type",
    movies: "Movies", tvshows: "TV Shows", music: "Music",
    username: "Username", password: "Password", role: "Role",
    admin: "Admin", user: "User",
    tmdbKey: "TMDB API Key", opensubKey: "OpenSubtitles API Key",
    port: "Port",
    loginTitle: "Sign in", loginButton: "Sign in",
    loginError: "Incorrect username or password",
    episodes: "Episodes", season: "Season",
    streamOn: "Stream on", rentOn: "Rent on",
    notAvailable: "Not available on streaming services right now",
    loading: "Loading...", error: "Error", close: "Close",
    remove: "Remove", cancel: "Cancel", save: "Save",
    never: "Never", lastLogin: "Last login",
    episodes_count: "episodes", tracks: "tracks", titles: "titles",
    shows: "shows", unknownArtist: "Unknown artist",
    noDescription: "No description available.",
    connectionError: "Could not connect to server.",
    serverNotRunning: "Check that the server is running.",
  }
};

const I18n = {
  lang: "en",

  detect() {
    // Check saved preference first
    const saved = localStorage.getItem("sv_lang");
    if (saved && TRANSLATIONS[saved]) { this.lang = saved; return; }
    // Auto-detect from browser
    const browser = (navigator.language || navigator.userLanguage || "en").toLowerCase();
    if (browser.startsWith("sv")) { this.lang = "sv"; return; }
    this.lang = "en";
  },

  set(lang) {
    if (!TRANSLATIONS[lang]) return;
    this.lang = lang;
    localStorage.setItem("sv_lang", lang);
    this.apply();
  },

  t(key) {
    return TRANSLATIONS[this.lang][key] || TRANSLATIONS["en"][key] || key;
  },

  apply() {
    // Update all elements with data-i18n attribute
    document.querySelectorAll("[data-i18n]").forEach(el => {
      const key = el.getAttribute("data-i18n");
      const attr = el.getAttribute("data-i18n-attr");
      if (attr) el.setAttribute(attr, this.t(key));
      else el.textContent = this.t(key);
    });
  }
};

I18n.detect();

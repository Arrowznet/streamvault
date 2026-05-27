// StreamVault API client
const API = {
  _token: null,
  _refresh: null,

  init() {
    this._token = localStorage.getItem("sv_token");
    this._refresh = localStorage.getItem("sv_refresh");
  },

  setTokens(access, refresh) {
    this._token = access;
    this._refresh = refresh;
    localStorage.setItem("sv_token", access);
    localStorage.setItem("sv_refresh", refresh);
  },

  clearTokens() {
    this._token = null;
    this._refresh = null;
    localStorage.removeItem("sv_token");
    localStorage.removeItem("sv_refresh");
    localStorage.removeItem("sv_user");
  },

  async request(method, path, body) {
    const opts = {
      method,
      headers: { "Content-Type": "application/json" }
    };
    if (this._token) opts.headers["Authorization"] = "Bearer " + this._token;
    if (body) opts.body = JSON.stringify(body);

    let res = await fetch("/api" + path, opts);

    // Try token refresh on 401
    if (res.status === 401 && this._refresh) {
      const r = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: this._refresh })
      });
      if (r.ok) {
        const data = await r.json();
        this.setTokens(data.accessToken, data.refreshToken);
        opts.headers["Authorization"] = "Bearer " + this._token;
        res = await fetch("/api" + path, opts);
      } else {
        this.clearTokens();
        window.location.reload();
        return;
      }
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Okänt fel" }));
      throw new Error(err.error || "Serverfel");
    }
    return res.json();
  },

  get: (path) => API.request("GET", path),
  post: (path, body) => API.request("POST", path, body),
  patch: (path, body) => API.request("PATCH", path, body),
  delete: (path) => API.request("DELETE", path),

  streamUrl(id) { return `/api/stream/${id}?token=${this._token}`; }
};

API.init();

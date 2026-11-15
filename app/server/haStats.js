"use strict";
// Pure helpers for GET /api/ha/stats: a read-only summary for Home Assistant (who is watching
// what, and current bandwidth). No server state, so they can be tested with node.
//
// The endpoint is OFF unless config.ha_stats_key is set to a long random string, so nothing
// changes on installs that don't configure it (Windows included).

const crypto = require("crypto");

const MIN_KEY_LENGTH = 32;

// config.ha_stats_key -> the key, or null when the feature is off (missing, not a string, too short).
function haStatsKey(configValue) {
  if (typeof configValue !== "string") return null;
  const key = configValue.trim();
  return key.length >= MIN_KEY_LENGTH ? key : null;
}

// "Bearer <key>" header -> the key part, or "" when missing/malformed.
function bearerFromHeader(header) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return "";
  return header.slice(7).trim();
}

// Constant-time comparison. Both sides are hashed first so their lengths always match
// (timingSafeEqual throws on different lengths) and the key length doesn't leak.
function keyMatches(expected, provided) {
  if (!expected || typeof provided !== "string" || !provided) return false;
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(provided).digest();
  return crypto.timingSafeEqual(a, b);
}

// sessions: values of _activeSessions; transcodingIds: Set of media ids with a running DASH
// transcode; lastSample: newest system-stats sample (or undefined). Only whitelisted fields
// are copied, so IP addresses, user ids and devices never leave the server through this.
function buildHaStats(sessions, transcodingIds, lastSample, now) {
  const watching = (sessions || [])
    .map(s => ({
      user: s.username || "?",
      title: s.title || "Okänd",
      type: s.type || "unknown",
      progress_pct: s.duration > 0 ? Math.min(100, Math.round((s.position / s.duration) * 100)) : 0,
      method: transcodingIds && transcodingIds.has(s.mediaId) ? "transcode" : "direct",
      started_at: s.startedAt ? new Date(s.startedAt).toISOString() : null
    }))
    .sort((a, b) => a.user.localeCompare(b.user) || a.title.localeCompare(b.title));
  const local = lastSample && Number.isFinite(lastSample.localMbps) ? lastSample.localMbps : 0;
  const remote = lastSample && Number.isFinite(lastSample.remoteMbps) ? lastSample.remoteMbps : 0;
  return {
    watching_count: watching.length,
    transcoding_count: watching.filter(w => w.method === "transcode").length,
    watching,
    bandwidth_local_mbps: local,
    bandwidth_remote_mbps: remote,
    bandwidth_total_mbps: Math.round((local + remote) * 100) / 100,
    updated: new Date(now).toISOString()
  };
}

module.exports = { haStatsKey, bearerFromHeader, keyMatches, buildHaStats, MIN_KEY_LENGTH };

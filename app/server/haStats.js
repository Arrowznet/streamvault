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
// Picture/sound quality for one session, from the media item's stored fields (no I/O here).
// source = the file; output = what the viewer actually gets (direct = same as source;
// transcode = H.264, 4K HDR scaled to 1080p and tone mapped to SDR, audio AAC 2.0).
function resLabel(w, h) {
  w = Number(w) || 0; h = Number(h) || 0;
  if (!w && !h) return null;
  if (w >= 3200 || h >= 2000) return "4K";
  if (w >= 1800 || h >= 1000) return "1080p";
  if (w >= 1200 || h >= 700) return "720p";
  return (h || Math.round(w * 9 / 16)) + "p";
}
function codecLabel(c) {
  const k = String(c || "").toLowerCase();
  const map = { h264: "H.264", avc: "H.264", hevc: "HEVC", h265: "HEVC", av1: "AV1", vp9: "VP9", mpeg4: "MPEG-4", mpeg2video: "MPEG-2", vc1: "VC-1",
    aac: "AAC", ac3: "Dolby Digital", eac3: "Dolby Digital Plus", truehd: "Dolby TrueHD", dts: "DTS", mp3: "MP3", flac: "FLAC", opus: "Opus", vorbis: "Vorbis", pcm_s16le: "PCM", pcm_s24le: "PCM" };
  return map[k] || (k ? k.toUpperCase() : null);
}
function channelLabel(ch) {
  ch = Number(ch) || 0;
  return ({ 1: "1.0", 2: "2.0", 3: "2.1", 6: "5.1", 7: "6.1", 8: "7.1" })[ch] || (ch ? ch + " kan." : null);
}
function qualityOf(item, method) {
  if (!item) return null;
  const hdr = item.color_transfer === "smpte2084" ? "HDR10" : item.color_transfer === "arib-std-b67" ? "HLG" : null;
  const a = item.audio_info && typeof item.audio_info === "object" ? item.audio_info : null;
  let audioName = a ? codecLabel(a.codec) : null;
  if (a && a.codec === "dts" && /MA/i.test(a.profile || "")) audioName = "DTS-HD MA";
  const atmos = !!(a && /atmos/i.test(a.profile || ""));
  const source = {
    res: resLabel(item.width, item.height),
    video: codecLabel(item.codec),
    bit_depth: Number(item.bit_depth) || null,
    hdr,
    audio: a ? { codec: audioName, channels: channelLabel(a.channels), atmos } : null
  };
  const is4kHdr = (Number(item.width) || 0) >= 3000 && Number(item.bit_depth) === 10 && /hevc/i.test(item.codec || "");
  const output = method === "transcode"
    ? { res: is4kHdr ? "1080p" : source.res, video: "H.264", bit_depth: 8, hdr: null, audio: { codec: "AAC", channels: "2.0", atmos: false } }
    : source;
  return { source, output };
}

function buildHaStats(sessions, transcodingIds, lastSample, now, itemsById) {
  const watching = (sessions || [])
    .map(s => ({
      user: s.username || "?",
      title: s.title || "Okänd",
      type: s.type || "unknown",
      progress_pct: s.duration > 0 ? Math.min(100, Math.round((s.position / s.duration) * 100)) : 0,
      method: transcodingIds && transcodingIds.has(s.mediaId) ? "transcode" : "direct",
      started_at: s.startedAt ? new Date(s.startedAt).toISOString() : null,
      quality: qualityOf(itemsById && itemsById.get ? itemsById.get(s.mediaId) : null, transcodingIds && transcodingIds.has(s.mediaId) ? "transcode" : "direct"),
      // Public TMDB poster only (never a local or signed URL)
      poster: typeof s.posterUrl === "string" && /^https:\/\/image\.tmdb\.org\/t\/p\/[\w/.-]+$/.test(s.posterUrl) ? s.posterUrl : null
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

module.exports = { haStatsKey, bearerFromHeader, keyMatches, buildHaStats, qualityOf, MIN_KEY_LENGTH };

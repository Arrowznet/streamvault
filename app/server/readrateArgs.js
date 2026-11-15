"use strict";
// Pure helpers for DASH transcoding on Linux. No server state, so they can be tested with node.
//
// 1. readrateArgs(): the "-readrate N -readrate_initial_burst 20" input flags.
//    Why: on a fast computer ffmpeg encodes a whole film in about a minute. The player (dash.js)
//    treats the manifest as a live stream until ffmpeg is finished, then switches to "finished" and
//    cuts the duration to what it had fetched so far — playback stops. -readrate makes ffmpeg read the
//    film at (about) playback speed, so it finishes when the film does, like the old server did.
// 2. dashIdleMinutes() / shouldKillIdle(): how long a DASH session may go without any request
//    before the server kills its ffmpeg (a transcode now lives as long as the film).
// 3. dashKillDecision(): what the periodic safety net does per transcode — the old "no viewer" rule
//    on Windows, the idle time limit on Linux.

const BURST_SECONDS = 20;

// config.dash_readrate -> { value, invalid }. Missing -> 1. 0 -> off. Not a finite number >= 0 -> 1
// (invalid = true so the caller can log it).
function parseReadrate(configValue) {
  if (configValue === undefined || configValue === null) return { value: 1, invalid: false };
  let n = NaN;
  if (typeof configValue === "number") n = configValue;
  else if (typeof configValue === "string" && configValue.trim() !== "") n = Number(configValue.trim());
  if (!Number.isFinite(n) || n < 0) return { value: 1, invalid: true };
  return { value: n, invalid: false };
}

// opts: { platform, configValue, test, durationSec }
//   test: { state: "pending" | "done", readrateOk, burstOk, readrateReason, burstReason }
//   durationSec: the film's length, only used to word the warning (optional)
// returns { args, text, warn, invalid }
//   args: flags to put among the INPUT options (before -i); text: for the log; warn: string or null
function readrateArgs(opts) {
  const { platform, configValue, test, durationSec } = opts;
  if (platform !== "linux") return { args: [], text: "av: bara Linux", warn: null, invalid: false };

  const { value, invalid } = parseReadrate(configValue);
  if (value === 0) return { args: [], text: "av: avstängd (dash_readrate 0)", warn: null, invalid };

  const n = String(value);
  let warn = null;
  if (value > 1) {
    const when = Number.isFinite(durationSec) && durationSec > 0
      ? `ungefär efter ${Math.round(durationSec / value / 60)} min (filmlängd ${Math.round(durationSec / 60)} min delat med ${n})`
      : "ungefär vid filmlängd delat med " + n;
    warn = `dash_readrate ${n} är över 1 – ffmpeg blir klar före filmens slut, vilket kan ge frysning ${when}`;
  }

  const t = test || { state: "pending" };
  if (t.state === "pending") {
    return { args: ["-readrate", n], text: `readrate: ${n} (utan burst, starttestet pågår)`, warn, invalid };
  }
  if (!t.readrateOk) {
    return { args: [], text: `av: ffmpeg avvisade -readrate (${t.readrateReason || "okänt fel"})`, warn: null, invalid };
  }
  if (!t.burstOk) {
    return { args: ["-readrate", n], text: `readrate: ${n} (utan burst: ${t.burstReason || "avvisad"})`, warn, invalid };
  }
  return {
    args: ["-readrate", n, "-readrate_initial_burst", String(BURST_SECONDS)],
    text: `readrate: ${n} (burst ${BURST_SECONDS} s)`, warn, invalid
  };
}

// config.dash_idle_minutes -> minutes. Missing or invalid (not a finite number >= 0) -> 20. 0 -> off.
function dashIdleMinutes(configValue) {
  if (configValue === undefined || configValue === null) return 20;
  let n = NaN;
  if (typeof configValue === "number") n = configValue;
  else if (typeof configValue === "string" && configValue.trim() !== "") n = Number(configValue.trim());
  return Number.isFinite(n) && n >= 0 ? n : 20;
}

// True when a session that last got a request at lastActivity (ms) has been idle for idleMinutes or
// more. idleMinutes 0 = never. An unknown lastActivity is never killed.
function shouldKillIdle({ lastActivity, now, idleMinutes }) {
  if (!(idleMinutes > 0) || !Number.isFinite(lastActivity) || !Number.isFinite(now)) return false;
  return now - lastActivity >= idleMinutes * 60000;
}

// The periodic safety net: should this DASH transcode be killed now? Returns null (leave it),
// "inga tittare" (the old rule) or "övergiven" (the idle time limit).
//   Windows (anything but Linux): the OLD rule, unchanged — no active viewer (no /progress heartbeat
//     in the last 20 s, hasActiveViewer) and older than graceMs.
//   Linux: ONLY the idle time limit (lastActivity vs dash_idle_minutes), so a paused film isn't
//     killed after 30–40 s. dash_idle_minutes 0 therefore means "never killed by the safety net".
// opts: { platform, now, startTime, lastActivity, hasActiveViewer, idleMinutes, graceMs }
function dashKillDecision(opts) {
  const { platform, now, startTime, lastActivity, hasActiveViewer, idleMinutes, graceMs } = opts;
  if (platform === "linux") {
    return shouldKillIdle({ lastActivity, now, idleMinutes }) ? "övergiven" : null;
  }
  return !hasActiveViewer && (now - startTime) > graceMs ? "inga tittare" : null;
}

module.exports = { parseReadrate, readrateArgs, dashIdleMinutes, shouldKillIdle, dashKillDecision, BURST_SECONDS };

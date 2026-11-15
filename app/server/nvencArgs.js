"use strict";
// Builds the encoder flags for NVENC (Linux + h264_nvenc only). Pure — no server state — so it can
// be tested directly with node.
//
// Two things are decided here:
//  1. the quality profile ("fast" = the flags built at startup, "balanced"/"high" = slower, better
//     quality profiles), falling back to "fast" until/unless the startup test of those flags passed
//  2. "-forced-idr 1": with h264_nvenc a frame forced by -force_key_frames is NOT an IDR frame, so the
//     DASH muxer ends up waiting for the encoder's own keyframes (about every 10.4 s) instead of
//     cutting a clean 4 s segment. -forced-idr 1 makes the forced keyframes real IDR frames. It is only
//     added when -force_key_frames is actually used (forcesKeyFrames), and only if ffmpeg accepted it
//     in the startup test.
//
// For any other platform or encoder (Windows, amf, qsv, libx264) nothing changes: applies is false
// and the caller keeps the original flags.
//
// opts: { platform, encoder, wanted: "fast"|"balanced"|"high", baseArgs, profiles,
//         qualityTest: {state, reason}, forcedIdrTest: {state, reason}, forcesKeyFrames }
// returns { applies, extraArgs, skipBitrate, profileText, forcedIdr }
function nvencEncoderArgs(opts) {
  const { platform, encoder, wanted, baseArgs, profiles, qualityTest, forcedIdrTest, forcesKeyFrames } = opts;
  if (platform !== "linux" || encoder !== "h264_nvenc") {
    return { applies: false, extraArgs: baseArgs, skipBitrate: false, profileText: null, forcedIdr: null };
  }

  let args = baseArgs, skipBitrate = false, profileText;
  if (wanted === "fast") {
    profileText = "fast";
  } else if (qualityTest.state === "pending") {
    profileText = `${wanted} är inte testad än (starttestet pågår) – använder fast den här gången`;
  } else if (qualityTest.state === "failed") {
    profileText = `${wanted} fungerar inte här (${qualityTest.reason}) – använder fast`;
  } else {
    args = profiles[wanted];
    skipBitrate = true;           // the profiles carry "-b:v 0", a later "-b:v 4000k" would cap their quality
    profileText = wanted;
  }

  let forcedIdr;
  if (!forcesKeyFrames) {
    forcedIdr = "av: inga tvingade nyckelbilder";
  } else if (args.includes("-forced-idr")) {
    forcedIdr = "på";             // already in the flags — never add it twice
  } else if (forcedIdrTest.state === "pending") {
    forcedIdr = "av: testet pågår";
  } else if (forcedIdrTest.state === "failed") {
    forcedIdr = `av: ${forcedIdrTest.reason}`;
  } else {
    args = [...args, "-forced-idr", "1"];
    forcedIdr = "på";
  }
  return { applies: true, extraArgs: args, skipBitrate, profileText, forcedIdr };
}

module.exports = { nvencEncoderArgs };

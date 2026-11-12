"use strict";
// Which reverse proxies the server trusts to tell it a visitor's real IP address (X-Forwarded-For).
// Pure functions, no server state, so they can be tested directly with node.
//
// Trusting too much is dangerous: anything that is "trusted" can claim any visitor IP, which
// defeats rate limiting and the login lockout. So entries that trust (nearly) everyone are rejected.

const net = require("net");

const KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);
const DEFAULT_TRUST = ["loopback"];   // what the server has always used
const MIN_IPV4_PREFIX = 8;            // 10.0.0.0/8 is the largest private network and is fine
const MIN_IPV6_PREFIX = 16;           // ...except private IPv6 ranges (see isPrivateIpv6Range)

// First 16 bits of an IPv6 address (the part before the first ":"), as a number.
function firstIpv6Group(ip) {
  if (ip.startsWith("::")) return 0;
  const g = ip.split(":")[0];
  return /^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : null;
}

// A wide IPv6 network is still fine if it lies entirely inside a private range:
// unique-local fc00::/7 (so "fd00::/8" is fine) or link-local fe80::/10.
function isPrivateIpv6Range(ip, prefix) {
  const g = firstIpv6Group(ip);
  if (g === null) return false;
  if ((g & 0xfe00) === 0xfc00 && prefix >= 7) return true;
  if ((g & 0xffc0) === 0xfe80 && prefix >= 10) return true;
  return false;
}

// -> { ok: value } | { rejected: reason } | { invalid: reason } | { skip: true }
function checkEntry(item) {
  if (item === true) return { rejected: "true litar på alla" };
  if (typeof item !== "string") return { invalid: `ogiltig post (${JSON.stringify(item)})` };
  const s = item.trim();
  if (!s) return { skip: true };
  const lower = s.toLowerCase();
  if (lower === "true" || s === "*") return { rejected: "litar på alla" };
  if (KEYWORDS.has(lower)) return { ok: lower };

  if (s.includes("/")) {
    const [ip, pfx, ...extra] = s.split("/");
    const family = net.isIP(ip);
    if (!family || extra.length || !/^\d{1,3}$/.test(pfx)) return { invalid: "ogiltigt nätverk (CIDR)" };
    const prefix = parseInt(pfx, 10);
    if (prefix > (family === 4 ? 32 : 128)) return { invalid: "ogiltig prefixlängd" };
    if (prefix === 0) return { rejected: "litar på alla" };
    if (family === 4 && prefix < MIN_IPV4_PREFIX) return { rejected: `för brett nät (prefix under ${MIN_IPV4_PREFIX}), litar på nästan alla` };
    if (family === 6 && prefix < MIN_IPV6_PREFIX && !isPrivateIpv6Range(ip, prefix)) return { rejected: `för brett nät (prefix under ${MIN_IPV6_PREFIX}), litar på nästan alla` };
    return { ok: s };
  }
  if (net.isIP(s)) return { ok: s };
  return { invalid: "inte en IP-adress, ett nät eller ett nyckelord" };
}

// Turns config.trusted_proxies into the list Express should trust.
//  - missing, empty or nothing valid -> ["loopback"] (as before this setting existed)
//  - a string counts as a list (comma-separated allowed)
//  - every entry is checked on its own: invalid ones are skipped with a note, and entries that
//    trust everyone or nearly everyone ("*", true, "0.0.0.0/0", "::/0", too wide networks) are
//    rejected with a warning — only that entry, the rest of the list is still used
// Returns { trust: [...], warnings: [...] }.
function buildTrustProxy(input) {
  const warnings = [];
  if (input === undefined || input === null) return { trust: [...DEFAULT_TRUST], warnings };

  let items;
  if (Array.isArray(input)) items = input;
  else if (typeof input === "string") items = input.split(",");
  else items = [input];

  const trust = [];
  for (const item of items) {
    const r = checkEntry(item);
    if (r.skip) continue;
    const label = typeof item === "string" ? `"${item.trim()}"` : JSON.stringify(item);
    if (r.rejected) warnings.push(`VARNING: ${label} avvisades i trusted_proxies (${r.rejected}). Det skulle låta vem som helst förfalska sin IP-adress.`);
    else if (r.invalid) warnings.push(`${label} i trusted_proxies hoppades över: ${r.invalid}`);
    else if (!trust.includes(r.ok)) trust.push(r.ok);
  }
  if (!trust.length) {
    if (warnings.length) warnings.push('Ingen giltig post kvar i trusted_proxies – använder ["loopback"].');
    return { trust: [...DEFAULT_TRUST], warnings };
  }
  return { trust, warnings };
}

// The value to hand to app.set("trust proxy", ...). When it is just ["loopback"] this is the plain
// string "loopback", exactly what the server set before this setting existed.
function expressTrustValue(trust) {
  return trust.length === 1 && trust[0] === "loopback" ? "loopback" : trust;
}

module.exports = { buildTrustProxy, expressTrustValue };

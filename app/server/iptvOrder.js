"use strict";
// Pure helpers for the IPTV channel list: the order channels are shown in, and keeping channel
// ids stable when a playlist is refreshed. No server state, so they can be tested with node.

const hasOrder = c => Number.isInteger(c && c.order);
const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));

// mode "list": the provider's own order (the position in the M3U file, `order`, ascending).
//              Channels without an order (saved before this existed) come after, A–Z.
// mode "name": alphabetical on the name, as it has always been.
// Returns a new array.
function sortChannels(channels, mode) {
  const list = [...(channels || [])];
  if (mode === "list") {
    return list.sort((a, b) => {
      const oa = hasOrder(a), ob = hasOrder(b);
      if (oa && ob) return (a.order - b.order) || byName(a, b);
      if (oa) return -1;
      if (ob) return 1;
      return byName(a, b);
    });
  }
  return list.sort(byName);
}

// Groups (with a channel count) in the order they first appear in the provider's list: sorted on
// the LOWEST order among a group's channels. Groups without any order come last, A–Z.
function groupsByFirstOrder(channels) {
  const groups = new Map();
  for (const c of channels || []) {
    const g = groups.get(c.group) || { name: c.group, count: 0, min: Infinity };
    g.count++;
    if (hasOrder(c) && c.order < g.min) g.min = c.order;
    groups.set(c.group, g);
  }
  return [...groups.values()]
    .sort((a, b) => (a.min === b.min ? String(a.name).localeCompare(String(b.name)) : a.min - b.min))
    .map(({ name, count }) => ({ name, count }));
}

// A refresh replaces the whole channel list. To keep channels that were saved individually in
// favorite lists (channel_ids), a fresh channel with the same url as a previous one gets that
// previous channel's _id. Several channels sharing one url are paired in order (the previous ones
// in their own list order). Everything else comes from the fresh list; channels without a match
// keep the new _id they were given. Returns { channels, preserved }.
function reuseChannelIds(previous, fresh) {
  const prevSorted = [...(previous || [])]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const oa = hasOrder(a.c), ob = hasOrder(b.c);
      if (oa && ob) return (a.c.order - b.c.order) || (a.i - b.i);
      if (oa) return -1;
      if (ob) return 1;
      return a.i - b.i;
    })
    .map(x => x.c);
  const idsByUrl = new Map();
  for (const c of prevSorted) {
    if (!c.url || !c._id) continue;
    if (!idsByUrl.has(c.url)) idsByUrl.set(c.url, []);
    idsByUrl.get(c.url).push(c._id);
  }
  let preserved = 0;
  const channels = (fresh || []).map(c => {
    const queue = idsByUrl.get(c.url);
    if (queue && queue.length) { preserved++; return { ...c, _id: queue.shift() }; }
    return c;
  });
  return { channels, preserved };
}

// Per-user choice of which top-level live-TV groups (countries/languages) are shown. The filter
// only applies when the user has saved a choice (iptv_group_filter === true with a saved list);
// otherwise everything is shown, as it always was. Groups that appear after the choice was saved
// are not in the list, so they stay hidden until the user ticks them. Channels, favorite lists and
// EPG are not affected — this only trims the list of groups. Returns a new array.
function filterVisibleGroups(groups, user) {
  const all = [...(groups || [])];
  if (!user || user.iptv_group_filter !== true || !Array.isArray(user.iptv_visible_groups)) return all;
  const visible = new Set(user.iptv_visible_groups);
  return all.filter(g => visible.has(g.name));
}

// ── Dividers ("rubrikkanaler") ─────────────────────────────────────────────────────
// Some providers put fake channels in their list that only act as section headings ("Barnkanaler",
// "Sport", ...). They can't be recognised from the data, so they're picked out by NAME, from a list
// the admin can edit (config.iptv_divider_names). Without that setting this default list is used.
const DEFAULT_DIVIDER_NAMES = [
  "SWEDEN", "Barnkanaler", "AlienPlay", "Nyheter", "Entertainment", "Sport", "Film kanaler", "Lokala kanaler", "Pay Per View"
];

// The names in effect: the saved list (only if it really is a list of strings), else the default.
// A saved EMPTY list is a real choice ("no headings") and is kept as it is.
function dividerNames(configValue) {
  if (Array.isArray(configValue) && configValue.every(n => typeof n === "string")) return configValue;
  return [...DEFAULT_DIVIDER_NAMES];
}

// Marks channels that are dividers with divider: true (returns new objects; the input is not
// changed). A channel is a divider if it is a live channel whose name, trimmed and case-insensitive,
// is EXACTLY equal to one of the names — no partial matching ("AlienPlay: Wild Nature" is not one).
function markDividers(channels, names) {
  const set = new Set((names || []).map(n => String(n).trim().toLowerCase()).filter(Boolean));
  return (channels || []).map(c => {
    const isLive = (c.type || "live") === "live";
    return isLive && set.has(String(c.name || "").trim().toLowerCase()) ? { ...c, divider: true } : c;
  });
}

module.exports = { sortChannels, groupsByFirstOrder, reuseChannelIds, filterVisibleGroups, DEFAULT_DIVIDER_NAMES, dividerNames, markDividers };

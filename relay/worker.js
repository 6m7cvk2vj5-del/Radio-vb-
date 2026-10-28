// Dial relay — a tiny Cloudflare Worker that lets the Dial web page read "now playing" info
// that browsers otherwise block (no CORS header) or that only exists inside the audio stream.
//
//   GET /icy?u=<https stream url>   reads the song title embedded in an Icecast/Shoutcast
//                                   stream (ICY metadata) and returns {raw, artist, title}
//   GET /json?u=<https json url>    passes a JSON response through with CORS allowed
//   GET /fip?slug=fip/radio-pop     latest track on a FIP webradio, read from radiofrance.fr's
//                                   own site (an unofficial endpoint that could change)
//   POST /likes                     syncs the "Liked songs" list between devices: the page sends
//                                   {code, items}, the relay merges that into what it holds for
//                                   the code and answers with the merged list. Needs a KV
//                                   namespace bound to this Worker as LIKES (docs/relay-setup.md).
//   POST /history                   same idea for the "Recently played" list: {code, items,
//                                   clearedAt} in, merged {items, clearedAt} out. Same KV namespace.
//
// It is NOT an open proxy: it only talks to hosts that appear as station URLs in the live Dial
// page (PAGE_URL), so adding a station to index.html needs no change here, and it only answers
// browsers loading Dial from ORIGIN. See docs/relay-setup.md for the one-time setup.

const ORIGIN = 'https://6m7cvk2vj5-del.github.io';

const PAGE_URL = 'https://6m7cvk2vj5-del.github.io/Radio-vb-/';
const HOSTS_TTL_MS = 10 * 60 * 1000;   // re-read the page at most every 10 minutes

// Fallback only: used if the live page can't be read and nothing is cached yet.
const FALLBACK_STREAM_HOSTS = [
  'icecast.radiofrance.fr',
  'stream.radioparadise.com',
  'ice1.somafm.com',
  'stream-mixtape-geo.ntslive.net',
  'stream-relay-geo.ntslive.net',
  'admin.stream.rinse.fm',
  'ibizasonica.streaming-pro.com:8001',
  'radiomeuh.ice.infomaniak.ch',
  'sohoradiomusic.doughunt.co.uk:8010',
  'stream.tm-radio.com',
  'streaming.radio.co',
  'subfm.radioca.st',
  'peacefulpiano.stream.publicradio.org',
  'relax.stream.publicradio.org',
  'solopiano-high.rautemusik.fm',
  'playerservices.streamtheworld.com',
  'q2stream.wqxr.org',
  'radio.chinesemusicworld.com',
  'stream.srg-ssr.ch',
  'nature-rex.radioca.st',
  'radio.moss.garden',
];

let hostCache = { hosts: null, at: 0 };

// Every host[:port] that appears as a station `url:` / `lowUrl:` in the live Dial page.
async function allowedStreamHosts() {
  const now = Date.now();
  if (hostCache.hosts && now - hostCache.at < HOSTS_TTL_MS) return hostCache.hosts;
  try {
    const res = await fetch(PAGE_URL);
    if (res.ok) {
      const html = await res.text();
      const hosts = new Set();
      for (const m of html.matchAll(/\b(?:url|lowUrl)\s*:\s*['"](https:\/\/[^'"]+)['"]/g)) {
        try { hosts.add(new URL(m[1]).host); } catch (e) {}
      }
      if (hosts.size >= 5) {            // sanity check: a real station list, not an error page
        hostCache = { hosts, at: now };
        return hosts;
      }
    }
  } catch (e) {}
  if (hostCache.hosts) return hostCache.hosts;          // stale list beats none
  return new Set(FALLBACK_STREAM_HOSTS);
}

// JSON endpoints that may be passed through.
const JSON_HOSTS = ['api.radioparadise.com', 'api.radiofrance.fr', 'rms.api.bbc.co.uk'];

// radiofrance.fr's own "recent tracks" call for a FIP webradio page. Unofficial: it is the site's
// internal SvelteKit remote function, so the id (1wiyrg4) or the reply format may change.
const FIP_REMOTE = 'https://www.radiofrance.fr/_app/remote/1wiyrg4/loadTracks';

const TIMEOUT_MS = 8000;
const MAX_METAINT = 65536;      // sanity cap on the metadata interval (SomaFM uses 45000)
const MAX_BLOCKS = 12;          // metadata is only sent on change; look at up to 12 intervals...
const MAX_TOTAL_BYTES = 160000; // ...but never read more than this much audio

function reply(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Vary': 'Origin',
      'Cache-Control': 'public, max-age=10',
    }, extra || {}),
  });
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function splitTitle(raw) {
  const i = raw.indexOf(' - ');
  if (i > 0) return { raw, artist: raw.slice(0, i).trim(), title: raw.slice(i + 3).trim() };
  return { raw, artist: null, title: raw };
}

// Reads ICY metadata from an already-opened stream response. Returns {raw, artist, title}
// or null if the stream has none. Exported shape kept simple so it can be unit-tested.
async function readIcyFromResponse(res, trace) {
  const metaint = parseInt(res.headers.get('icy-metaint'), 10);
  if (trace) {
    trace.status = res.status;
    trace.finalUrl = res.url || null;
    trace.metaint = metaint || null;
    trace.headers = {};
    res.headers.forEach((v, k) => { if (/^(content-type|server|icy-.*|ice-.*|x-.*|location|content-encoding)$/i.test(k)) trace.headers[k] = v; });
    trace.blocks = [];
  }
  if (!res.ok || !metaint || metaint > MAX_METAINT || !res.body) {
    if (trace) trace.stoppedBecause = !res.ok ? 'upstream status not OK' : (!metaint ? 'no icy-metaint header (server sent no metadata)' : (metaint > MAX_METAINT ? 'metaint too large' : 'no body'));
    return null;
  }
  const reader = res.body.getReader();
  let buf = new Uint8Array(0);
  let done = false;
  async function ensure(n) {
    while (buf.length < n && !done) {
      const r = await reader.read();
      if (r.done) { done = true; break; }
      buf = concat(buf, r.value);
    }
    return buf.length >= n;
  }
  try {
    let pos = 0;
    for (let block = 0; block < MAX_BLOCKS; block++) {
      if (block > 0 && pos + metaint + 1 > MAX_TOTAL_BYTES) break;
      if (!(await ensure(pos + metaint + 1))) { if (trace) trace.stoppedBecause = 'stream ended early'; return null; }
      const len = buf[pos + metaint] * 16;
      if (trace) trace.blocks.push(len);
      const start = pos + metaint + 1;
      if (len > 0) {
        if (!(await ensure(start + len))) return null;
        const text = new TextDecoder('utf-8').decode(buf.slice(start, start + len)).replace(/\0+$/, '');
        if (trace) trace.metadataText = text;
        const m = text.match(/StreamTitle='([\s\S]*?)';/) || text.match(/StreamTitle='([\s\S]*)$/)
          || text.match(/StreamTitle="([^"]*)"/);
        const raw = m ? m[1].trim() : '';
        if (raw) return splitTitle(raw);
        pos = start + len; // metadata present but the title is blank — keep looking
        continue;
      }
      pos = start; // empty block: "unchanged" — look at the next interval
    }
    if (trace) trace.stoppedBecause = trace.metadataText !== undefined
      ? 'metadata present but StreamTitle is blank (the station sends no song info)'
      : 'no metadata in the first ' + trace.blocks.length + ' intervals';
    return null;
  } finally {
    try { await reader.cancel(); } catch (e) {}
  }
}

async function readIcy(url, trace) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'Icy-MetaData': '1', 'User-Agent': 'Mozilla/5.0 (compatible; DialRelay/1.0)' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    return await readIcyFromResponse(res, trace);
  } catch (e) {
    if (trace) trace.error = String(e && e.message || e);
    throw e;
  } finally {
    clearTimeout(timer);
    ctrl.abort(); // drop the audio stream as soon as we have what we need
  }
}

async function passJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok || text.length > 200000) return null;
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// Minimal "devalue" decoder (SvelteKit's wire format): a flat array where objects and arrays
// refer to each other by index, and -1 means undefined.
function unflatten(parsed) {
  const memo = new Map();
  function hydrate(i) {
    if (i === -1) return undefined;
    if (i === -2) return NaN;
    if (i === -3) return Infinity;
    if (i === -4) return -Infinity;
    if (i === -5) return -0;
    if (memo.has(i)) return memo.get(i);
    const v = parsed[i];
    if (v === null || typeof v !== 'object') { memo.set(i, v); return v; }
    if (Array.isArray(v)) {
      const out = [];
      memo.set(i, out);
      for (const ref of v) out.push(hydrate(ref));
      return out;
    }
    const out = {};
    memo.set(i, out);
    for (const k of Object.keys(v)) out[k] = hydrate(v[k]);
    return out;
  }
  return hydrate(0);
}

function parisDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// The newest entry of a decoded loadTracks reply, as {title, artist, time}; null if none.
function newestFipTrack(outerText) {
  const outer = JSON.parse(outerText);
  if (!outer || outer.type !== 'result') return null;
  const root = unflatten(JSON.parse(outer.result));
  const first = root && root.items && root.items[0];
  const tp = first && first.data && first.data.titleProps;
  if (!tp || !tp.text) return null;
  return { title: tp.text, artist: tp.title || null, time: first.label || null };
}

async function fipLatest(slug) {
  // The payload is the page's own request: today's date (Paris), limit 10, this slug. Just after
  // midnight today's list can still be empty, so fall back to yesterday.
  for (const offset of [0, -1]) {
    const payload = btoa(JSON.stringify([['__skrao', 1], { date: 2, limit: 3, slug: 4, timeslot: -1 }, parisDate(offset), 10, slug]))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(FIP_REMOTE + '?payload=' + payload, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
      if (!res.ok) continue;
      const info = newestFipTrack(await res.text());
      if (info) return info;
    } catch (e) {
      // try the next date
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// ---------- Liked songs sync ----------
// The list is a set of records {id, title, artist, cover, query, station, at, ts, del?}. `ts` is
// the last time the record changed; a deleted song stays as a tombstone (del: true) so the
// deletion reaches the other devices. Merging keeps, per id, whichever record has the newest ts.
// The same rule lives in index.html (mergeLikes) — keep the two in step.
const CODE_RE = /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/;
const MAX_LIKES = 2000;
const MAX_BODY_BYTES = 400000;
const TOMBSTONE_MS = 60 * 86400000;
const LIKES_TTL_S = 400 * 86400;   // an untouched list expires after about 13 months

function cleanText(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function cleanLike(r) {
  if (!r || typeof r !== 'object') return null;
  const id = cleanText(r.id, 200);
  const ts = Number(r.ts);
  if (!id || !isFinite(ts)) return null;
  const out = { id, ts: Math.floor(ts) };
  if (r.del) { out.del = true; return out; }
  out.title = cleanText(r.title, 200);
  if (!out.title) return null;
  out.artist = cleanText(r.artist, 200);
  out.query = cleanText(r.query, 400);
  out.station = cleanText(r.station, 100);
  out.cover = /^https:\/\//.test(r.cover) ? cleanText(r.cover, 500) : '';
  out.at = isFinite(Number(r.at)) ? Math.floor(Number(r.at)) : out.ts;
  return out;
}

function mergeLikes(a, b) {
  const byId = new Map();
  for (const r of [].concat(a || [], b || [])) {
    const c = cleanLike(r);
    if (!c) continue;
    const cur = byId.get(c.id);
    if (!cur || c.ts > cur.ts || (c.ts === cur.ts && c.del && !cur.del)) byId.set(c.id, c);
  }
  const cutoff = Date.now() - TOMBSTONE_MS;
  const out = [...byId.values()].filter(r => !r.del || r.ts > cutoff);
  out.sort((x, y) => y.ts - x.ts);
  return out.slice(0, MAX_LIKES);
}

async function likeKey(code) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('dial-likes:' + code));
  return 'likes:' + [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function syncLikes(req, env) {
  if (!env || !env.LIKES) return reply({ error: 'sync not set up' }, 501, { 'Cache-Control': 'no-store' });
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return reply({ error: 'too large' }, 413, { 'Cache-Control': 'no-store' });
  let body;
  try { body = JSON.parse(text); } catch (e) { return reply({ error: 'bad json' }, 400, { 'Cache-Control': 'no-store' }); }
  const code = body && typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (!CODE_RE.test(code) || !Array.isArray(body.items)) return reply({ error: 'bad request' }, 400, { 'Cache-Control': 'no-store' });

  const key = await likeKey(code);
  const storedText = await env.LIKES.get(key);
  let stored = [];
  try { stored = storedText ? JSON.parse(storedText) : []; } catch (e) {}
  const merged = mergeLikes(stored, body.items);
  const mergedText = JSON.stringify(merged);
  // Write only when something changed (KV's free plan allows 1,000 writes a day).
  if (mergedText !== storedText) await env.LIKES.put(key, mergedText, { expirationTtl: LIKES_TTL_S });
  return reply({ items: merged }, 200, { 'Cache-Control': 'no-store' });
}

// ---------- Recently played sync ----------
// One record per song: {id, title, artist, cover, query, station, at}, `at` being the last time it
// was played. Merging keeps, per id, the newest `at`. Clearing the list sets `clearedAt`; records
// at or before it are dropped, and the larger clearedAt wins. Same rule as mergeHistory in
// index.html — keep the two in step. Stored under the same LIKES namespace as the likes.
const MAX_HISTORY = 100;

function cleanPlay(r) {
  if (!r || typeof r !== 'object') return null;
  const id = cleanText(r.id, 200);
  const at = Number(r.at);
  const title = cleanText(r.title, 200);
  if (!id || !title || !isFinite(at)) return null;
  return {
    id, title, at: Math.floor(at),
    artist: cleanText(r.artist, 200),
    query: cleanText(r.query, 400),
    station: cleanText(r.station, 100),
    cover: /^https:\/\//.test(r.cover) ? cleanText(r.cover, 500) : '',
  };
}

function mergeHistory(a, b, clearedA, clearedB) {
  const clearedAt = Math.max(Number(clearedA) || 0, Number(clearedB) || 0);
  const byId = new Map();
  for (const r of [].concat(a || [], b || [])) {
    const c = cleanPlay(r);
    if (!c || c.at <= clearedAt) continue;
    const cur = byId.get(c.id);
    if (!cur || c.at > cur.at) byId.set(c.id, c);
  }
  const items = [...byId.values()].sort((x, y) => y.at - x.at).slice(0, MAX_HISTORY);
  return { items, clearedAt };
}

async function historyKey(code) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('dial-history:' + code));
  return 'history:' + [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function syncHistory(req, env) {
  if (!env || !env.LIKES) return reply({ error: 'sync not set up' }, 501, { 'Cache-Control': 'no-store' });
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return reply({ error: 'too large' }, 413, { 'Cache-Control': 'no-store' });
  let body;
  try { body = JSON.parse(text); } catch (e) { return reply({ error: 'bad json' }, 400, { 'Cache-Control': 'no-store' }); }
  const code = body && typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (!CODE_RE.test(code) || !Array.isArray(body.items)) return reply({ error: 'bad request' }, 400, { 'Cache-Control': 'no-store' });

  const key = await historyKey(code);
  const storedText = await env.LIKES.get(key);
  let stored = {};
  try { stored = storedText ? JSON.parse(storedText) : {}; } catch (e) {}
  const merged = mergeHistory(stored.items, body.items, stored.clearedAt, body.clearedAt);
  const mergedText = JSON.stringify(merged);
  // Write only when something changed (KV's free plan allows 1,000 writes a day).
  if (mergedText !== storedText) await env.LIKES.put(key, mergedText, { expirationTtl: LIKES_TTL_S });
  return reply(merged, 200, { 'Cache-Control': 'no-store' });
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': ORIGIN,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin',
      } });
    }
    // Browsers loading Dial send an Origin header; reject any other web page. (Requests with
    // no Origin, like opening the address in a tab for testing, are allowed — the host
    // allowlists below are what actually limit what this can reach.)
    const origin = req.headers.get('Origin');
    if (origin && origin !== ORIGIN) return reply({ error: 'forbidden' }, 403);
    const url = new URL(req.url);

    if (url.pathname === '/likes') {
      // Unlike the read-only calls, this stores data, so a real Dial page (Origin header) is required.
      if (req.method !== 'POST' || origin !== ORIGIN) return reply({ error: 'forbidden' }, 403);
      try { return await syncLikes(req, env); } catch (e) { return reply({ error: 'sync failed' }, 502, { 'Cache-Control': 'no-store' }); }
    }

    if (url.pathname === '/history') {
      if (req.method !== 'POST' || origin !== ORIGIN) return reply({ error: 'forbidden' }, 403);
      try { return await syncHistory(req, env); } catch (e) { return reply({ error: 'sync failed' }, 502, { 'Cache-Control': 'no-store' }); }
    }

    if (req.method !== 'GET') return reply({ error: 'method not allowed' }, 405);

    if (url.pathname === '/fip') {
      const slug = url.searchParams.get('slug') || '';
      if (!/^fip\/[a-z0-9-]+$/.test(slug)) return reply({ error: 'bad slug' }, 400);
      const info = await fipLatest(slug);
      return reply(info || { title: null, artist: null, time: null }, 200);
    }

    let target;
    try { target = new URL(url.searchParams.get('u')); } catch (e) { return reply({ error: 'bad url' }, 400); }
    if (target.protocol !== 'https:') return reply({ error: 'https only' }, 400);

    try {
      if (url.pathname === '/icy') {
        if (!(await allowedStreamHosts()).has(target.host)) return reply({ error: 'host not allowed' }, 403);
        if (url.searchParams.get('debug') === '1') {
          const trace = {};
          let info = null;
          try { info = await readIcy(target.toString(), trace); } catch (e) {}
          return reply({ result: info, trace }, 200, { 'Cache-Control': 'no-store' });
        }
        const info = await readIcy(target.toString());
        return reply(info || { raw: null, artist: null, title: null }, 200);
      }
      if (url.pathname === '/json') {
        if (!JSON_HOSTS.includes(target.host)) return reply({ error: 'host not allowed' }, 403);
        const data = await passJson(target.toString());
        return data ? reply(data, 200) : reply({ error: 'upstream failed' }, 502);
      }
      return reply({ error: 'not found' }, 404);
    } catch (e) {
      return reply({ error: 'upstream failed' }, 502);
    }
  },
};

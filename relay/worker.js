// Dial relay — a tiny Cloudflare Worker that lets the Dial web page read "now playing" info
// that browsers otherwise block (no CORS header) or that only exists inside the audio stream.
//
//   GET /icy?u=<https stream url>   reads the song title embedded in an Icecast/Shoutcast
//                                   stream (ICY metadata) and returns {raw, artist, title}
//   GET /json?u=<https json url>    passes a JSON response through with CORS allowed
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
const JSON_HOSTS = ['api.radioparadise.com'];

const TIMEOUT_MS = 8000;
const MAX_METAINT = 32768;      // sanity cap on the metadata interval
const MAX_BLOCKS = 3;           // metadata is only sent on change; look at up to 3 intervals

function reply(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
      if (!(await ensure(pos + metaint + 1))) { if (trace) trace.stoppedBecause = 'stream ended early'; return null; }
      const len = buf[pos + metaint] * 16;
      if (trace) trace.blocks.push(len);
      const start = pos + metaint + 1;
      if (len > 0) {
        if (!(await ensure(start + len))) return null;
        const text = new TextDecoder('utf-8').decode(buf.slice(start, start + len)).replace(/\0+$/, '');
        if (trace) trace.metadataText = text;
        const m = text.match(/StreamTitle='([\s\S]*?)';/) || text.match(/StreamTitle='([\s\S]*)$/);
        const raw = m ? m[1].trim() : '';
        return raw ? splitTitle(raw) : null;
      }
      pos = start; // empty block: "unchanged" — look at the next interval
    }
    if (trace) trace.stoppedBecause = 'no title in the first ' + MAX_BLOCKS + ' metadata blocks';
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

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': ORIGIN,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Vary': 'Origin',
      } });
    }
    // Browsers loading Dial send an Origin header; reject any other web page. (Requests with
    // no Origin, like opening the address in a tab for testing, are allowed — the host
    // allowlists below are what actually limit what this can reach.)
    const origin = req.headers.get('Origin');
    if (origin && origin !== ORIGIN) return reply({ error: 'forbidden' }, 403);
    if (req.method !== 'GET') return reply({ error: 'method not allowed' }, 405);

    const url = new URL(req.url);
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

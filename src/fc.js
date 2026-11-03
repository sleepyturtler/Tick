// Football player counting: turns "lamine yamal:fc25" (or just "lamine yamal") into that player's EA FC overall rating.
const { LATEST_FC, FC_API_BASE, FC_RATE_PER_MIN } = require('./config');

const HIT_TTL = 24 * 60 * 60 * 1000;   // a player's launch rating never changes
const MISS_TTL = 10 * 60 * 1000;       // retry unknown names after a while (typos, API gaps)
const CACHE_MAX = 2000, TIMEOUT_MS = 4000;
const cache = new Map();               // key -> { val, ttl, at }   (val is null for a cached miss)
const inflight = new Map();            // key -> Promise, so identical lookups share one request
let callTimes = [];

// lowercase, strip accents, turn punctuation into spaces: "N'Golo Kanté" -> "n golo kante"
const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[.'\u2019\-]/g, ' ').replace(/\s+/g, ' ').trim();

// Accepts "name" or "name:fc25" (spaces around the colon are fine). Anything else (digits, symbols, long text) is not a player attempt.
const RE = /^([\p{L}][\p{L}\p{M}\s.'\u2019\-]{1,39}?)(?:\s*:\s*fc\s*(\d{2}))?$/iu;
function parseQuery(raw) {
    if (!raw || raw.length > 60) return null;
    const m = RE.exec(raw);
    if (!m) return null;
    const name = m[1].trim();
    if (name.length < 3 || name.split(/\s+/).length > 4) return null;
    const explicit = m[2] !== undefined;
    return { name, game: explicit ? parseInt(m[2], 10) : LATEST_FC, explicit };
}

function allow() {
    const now = Date.now();
    callTimes = callTimes.filter(t => now - t < 60_000);
    if (callTimes.length >= FC_RATE_PER_MIN) return false;
    callTimes.push(now);
    return true;
}
function remember(key, val, ttl) {
    cache.delete(key);
    cache.set(key, { val, ttl, at: Date.now() });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function extractRows(json) {
    if (Array.isArray(json)) return json;
    if (json && typeof json === 'object') {
        for (const k of ['players', 'data', 'results']) if (Array.isArray(json[k])) return json[k];
        if (json.name || json.Name) return [json];
    }
    return [];
}
// Prefer an exact name, then rows containing every typed word as a whole word. Highest overall wins ("silva" -> best Silva).
function pick(rows, q) {
    const want = norm(q.name), toks = want.split(' ');
    const list = rows.map(r => ({ name: String(r.name ?? r.Name ?? ''), ovr: parseInt(r.ovr ?? r.OVR, 10) }))
        .map(r => ({ ...r, n: norm(r.name) }))
        .filter(r => r.n && Number.isFinite(r.ovr) && r.ovr > 0);
    const exact = list.filter(r => r.n === want);
    const words = list.filter(r => { const w = r.n.split(' '); return toks.every(t => w.includes(t)); });
    const tier = exact.length ? exact : words;
    if (!tier.length) return null;
    const best = tier.reduce((a, b) => (b.ovr > a.ovr ? b : a));
    return { name: best.name, ovr: best.ovr, game: q.game };
}

async function fetchPlayer(q, key) {
    if (!allow()) return null;   // over the rate limit: treat as "unknown" without caching it
    const url = `${FC_API_BASE}/players?name=${encodeURIComponent(norm(q.name))}&game=fc${q.game}`;
    let rows;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
        if (res.status === 404) { remember(key, null, MISS_TTL); return null; }
        if (!res.ok) return null;   // API trouble: don't cache, try again next time
        rows = extractRows(await res.json());
    } catch (e) { console.error('fc lookup:', e.message); return null; }
    const val = pick(rows, q);
    remember(key, val, val ? HIT_TTL : MISS_TTL);
    return val;
}

// -> { name, ovr, game } or null
async function lookup(q) {
    const key = `${q.game}|${norm(q.name)}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) { cache.delete(key); cache.set(key, hit); return hit.val; }
    if (inflight.has(key)) return inflight.get(key);
    const p = fetchPlayer(q, key).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

module.exports = { parseQuery, lookup, pick, norm };

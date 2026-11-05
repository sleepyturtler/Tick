// Football player counting: turns "lamine yamal:fc25" (or just "lamine yamal") into that player's launch rating
// for that game, read from the fc_players table (loaded from SQL files, see scripts/make-ratings-sql.js).
const { LATEST_FC } = require('./config');
const { pool } = require('./db');
const { norm } = require('./fcdata');

const HIT_TTL = 24 * 60 * 60 * 1000;   // ratings in the table never change
const MISS_TTL = 10 * 60 * 1000;       // unknown names are re-checked after a while (typos, newly imported games)
const CACHE_MAX = 2000, ROW_LIMIT = 2000;
const cache = new Map();               // key -> { val, ttl, at }   (val is null for a cached miss)
const inflight = new Map();            // key -> Promise, so identical lookups share one query

// Accepts "name" or "name:fc25" / "name:fifa23" (spaces around the colon are fine). Anything else (digits, symbols, long text) is not a player attempt.
const RE = /^([\p{L}][\p{L}\p{M}\s.'\u2019\-]{1,39}?)(?:\s*:\s*(?:fc|fifa)\s*(\d{2}))?$/iu;
function parseQuery(raw) {
    if (!raw || raw.length > 60) return null;
    const m = RE.exec(raw);
    if (!m) return null;
    const name = m[1].trim();
    if (name.length < 3 || name.split(/\s+/).length > 4) return null;
    const explicit = m[2] !== undefined;
    return { name, game: explicit ? parseInt(m[2], 10) : LATEST_FC, explicit };
}

function remember(key, val, ttl) {
    cache.delete(key);
    cache.set(key, { val, ttl, at: Date.now() });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// Matching order, first non-empty step wins, and within a step the highest overall wins:
//   1. exact full-name match (only when two or more words are typed)
//   2. every typed word appears as a whole word in the display name ("silva" -> the best Silva)
//   3. every typed word appears as a whole word in the long legal name ("kylian mbappe" -> "Kylian Mbappe Lottin")
// Step 3 comes last because legal names hold extra words (Neymar's contains "da Silva").
// One word never counts as "exact", otherwise a player literally named "Silva" would beat Bernardo Silva.
// rows: [{ name, alt_name, norm_name, norm_alt, overall }]
function pick(rows, q) {
    const want = norm(q.name);
    if (!want) return null;
    const toks = want.split(' ');
    const hasAll = n => { if (!n) return false; const w = n.split(' '); return toks.every(t => w.includes(t)); };
    const list = rows.filter(r => Number.isFinite(r.overall) && r.overall > 0);
    const steps = [
        toks.length > 1 ? list.filter(r => r.norm_name === want || r.norm_alt === want) : [],
        list.filter(r => hasAll(r.norm_name)),
        list.filter(r => hasAll(r.norm_alt)),
    ];
    const tier = steps.find(t => t.length);
    if (!tier) return null;
    const best = tier.reduce((a, b) => (b.overall > a.overall ? b : a));
    return { name: best.name, alt: best.alt_name || '', ovr: best.overall, game: q.game };
}

async function query(q, key) {
    const want = norm(q.name);
    if (!want) return null;
    const longest = want.split(' ').reduce((a, b) => (b.length > a.length ? b : a));
    let rows;
    try {
        const res = await pool.query(
            'SELECT name, alt_name, norm_name, norm_alt, overall FROM fc_players WHERE game=$1 AND (norm_name LIKE $2 OR norm_alt LIKE $2) ORDER BY overall DESC LIMIT $3',
            [q.game, `%${longest}%`, ROW_LIMIT]);
        rows = res.rows;
    } catch (e) { console.error('fc lookup:', e.message); return null; }   // database trouble: don't cache, try again next time
    const val = pick(rows, q);
    remember(key, val, val ? HIT_TTL : MISS_TTL);
    return val;
}

// -> { name, alt, ovr, game } or null
async function lookup(q) {
    const key = `${q.game}|${norm(q.name)}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) { cache.delete(key); cache.set(key, hit); return hit.val; }
    if (inflight.has(key)) return inflight.get(key);
    const p = query(q, key).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

// FC 24 was the first game released as "EA SPORTS FC"; everything before it was FIFA.
const gameLabel = g => (g >= 24 ? `FC ${g}` : `FIFA ${g}`);

// FIFA 15 to FC 24 store an abbreviated display name ("K. Mbappe") plus the long name ("Kylian Mbappe Lottin").
// Show the long name when it is in Latin letters; otherwise keep the abbreviation and add the native name in brackets.
function fullName(p) {
    const abbreviated = /^\p{Lu}\.\s/u.test(p.name);
    if (!abbreviated || !p.alt) return p.name;
    return /\p{Script=Latin}/u.test(p.alt) ? p.alt : `${p.name} (${p.alt})`;
}

// Up to `count` random players with this overall, each from a different game.
// -> { picks: [{ game, name, alt }] newest game first, games: how many games have a player with this overall }
async function randomByOvr(ovr, count = 3) {
    const { rows } = await pool.query('SELECT DISTINCT ON (game) game, name, alt_name FROM fc_players WHERE overall=$1 ORDER BY game, random()', [ovr]);
    for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
    const picks = rows.slice(0, count).sort((a, b) => b.game - a.game).map(r => ({ game: r.game, name: r.name, alt: r.alt_name }));
    return { picks, games: rows.length };
}

module.exports = { parseQuery, lookup, pick, norm, gameLabel, fullName, randomByOvr };

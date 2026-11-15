// An in-memory stand-in for the few SQL statements the bot runs in the tests. It checks the bot's logic (cooldowns, rating maths,
// saved games), NOT the SQL itself: the statements are matched by shape, so a real Postgres run is still needed for the SQL.
const db = global.__fakeDb = global.__fakeDb || {};
function reset() {
    Object.assign(db, { now: Date.now(), purges: new Map(), rows: { counting: [], counting_channels: [], user_stats: [], fail_roles: [], support_announced: [] }, failOn: null, userStats: new Map(), globalUsers: [], pairs: new Map(), elo: new Map(), games: new Map(), players: [], snapshot: null, log: [] });
}
reset(); db.reset = reset;
const nowSec = () => db.now / 1000;
function query(text, params = []) {
    const t = text.replace(/\s+/g, ' ').trim();
    db.log.push(t.slice(0, 60));
    if (db.failOn && db.failOn.test(t)) throw new Error('simulated database failure');
    let m;
    if (/^(BEGIN)/.test(t)) { db.snapshot = { pairs: new Map(db.pairs), elo: new Map([...db.elo].map(([k, v]) => [k, { ...v }])), rows: JSON.parse(JSON.stringify(db.rows)), games: new Map(db.games), purges: new Map(db.purges) }; return { rows: [], rowCount: 0 }; }
    if (/^COMMIT/.test(t)) { db.snapshot = null; return { rows: [], rowCount: 0 }; }
    if (/^ROLLBACK/.test(t)) { if (db.snapshot) { db.pairs = db.snapshot.pairs; db.elo = db.snapshot.elo; db.rows = db.snapshot.rows; db.games = db.snapshot.games; db.purges = db.snapshot.purges; db.snapshot = null; } return { rows: [], rowCount: 0 }; }
    if (/^INSERT INTO game_pairs/.test(t)) { const k = params.join('|'); if (!db.pairs.has(k)) db.pairs.set(k, 0); return { rows: [], rowCount: 1 }; }
    if (/^SELECT EXTRACT\(EPOCH FROM \(NOW\(\) - last_rated\)\)/.test(t)) { const k = params.join('|'); return { rows: [{ age: String(nowSec() - db.pairs.get(k) / 1000) }] }; }
    if (/^UPDATE game_pairs SET last_rated=NOW\(\)/.test(t)) { db.pairs.set(params.join('|'), db.now); return { rows: [], rowCount: 1 }; }
    if (/^SELECT data FROM user_stats WHERE guild_id=\$1 AND user_id=\$2/.test(t)) { const d = db.userStats.get(params.join('|')); return { rows: d ? [{ data: d }] : [] }; }
    if (/^SELECT COUNT\(\*\)\+1 AS rank FROM user_stats/.test(t)) return { rows: [{ rank: '1' }] };
    if (/^SELECT user_id, SUM\(COALESCE\(\(data->>'correct'\)::int,0\)\) AS correct, SUM/.test(t)) return { rows: db.globalUsers.slice(params[1], params[1] + params[0]) };
    if (/^SELECT COUNT\(DISTINCT user_id\) AS cnt FROM user_stats/.test(t)) return { rows: [{ cnt: String(db.globalUsers.length) }] };
    if (/^INSERT INTO guild_purges/.test(t)) { if (db.purges.has(params[0])) return { rows: [], rowCount: 0 }; db.purges.set(params[0], { delete_after: String(params[1]), reason: params[2] }); return { rows: [], rowCount: 1 }; }
    if (/^DELETE FROM guild_purges WHERE guild_id=\$1/.test(t)) { const had = db.purges.delete(params[0]); return { rows: [], rowCount: had ? 1 : 0 }; }
    if (/^SELECT guild_id, delete_after, reason FROM guild_purges/.test(t)) return { rows: [...db.purges].map(([guild_id, v]) => ({ guild_id, ...v })) };
    if (/^SELECT guild_id FROM counting UNION SELECT guild_id FROM counting_channels/.test(t)) return { rows: [...new Set(['counting', 'counting_channels', 'user_stats', 'fail_roles'].flatMap(k => db.rows[k].map(r => r.guild_id)))].map(guild_id => ({ guild_id })) };
    if (/^SELECT DISTINCT guild_id FROM games/.test(t)) return { rows: [...new Set([...db.games.values()].map(g => g.data.guildId))].map(guild_id => ({ guild_id })) };
    if ((m = /^DELETE FROM (counting|counting_channels|user_stats|fail_roles|support_announced) WHERE guild_id=\$1/.exec(t))) { const before = db.rows[m[1]].length; db.rows[m[1]] = db.rows[m[1]].filter(r => r.guild_id !== params[0]); return { rows: [], rowCount: before - db.rows[m[1]].length }; }
    if (/^SELECT to_regclass\('games'\) AS t/.test(t)) return { rows: [{ t: 'games' }] };
    if (/^DELETE FROM games WHERE guild_id=\$1/.test(t)) { let n = 0; for (const [k, g] of [...db.games]) if (g.data.guildId === params[0]) { db.games.delete(k); n++; } return { rows: [], rowCount: n }; }
    if (/^SELECT COUNT\(\*\) AS cnt FROM/.test(t)) return { rows: [{ cnt: '0' }] };   // list pages: nothing stored
    if (/^INSERT INTO dedup/.test(t)) { db.dedup ??= new Set(); if (db.dedup.has(params[0])) return { rows: [], rowCount: 0 }; db.dedup.add(params[0]); return { rows: [{ message_id: params[0] }], rowCount: 1 }; }
    if (/^DELETE FROM game_pairs/.test(t)) return { rows: [], rowCount: 0 };
    if (/^INSERT INTO game_elo/.test(t)) { const k = `${params[0]}|${params[1]}`; if (!db.elo.has(k)) db.elo.set(k, { user_id: params[0], game: params[1], rating: params[2], games: 0, wins: 0, losses: 0, draws: 0 }); return { rows: [], rowCount: 1 }; }
    if (/^SELECT user_id, rating FROM game_elo WHERE game=\$1 AND user_id = ANY\(\$2\)/.test(t)) return { rows: params[1].map(id => db.elo.get(`${id}|${params[0]}`)).filter(Boolean).map(r => ({ user_id: r.user_id, rating: r.rating })) };
    if (/^UPDATE game_elo SET rating=\$3/.test(t)) { const r = db.elo.get(`${params[0]}|${params[1]}`); Object.assign(r, { rating: params[2], games: r.games + 1, wins: r.wins + params[3], losses: r.losses + params[4], draws: r.draws + params[5] }); return { rows: [], rowCount: 1 }; }
    if (/^SELECT user_id, rating, games, wins, losses, draws FROM game_elo WHERE game=\$1 AND games > 0/.test(t)) return { rows: [...db.elo.values()].filter(r => r.game === params[0] && r.games > 0).sort((a, b) => b.rating - a.rating || b.games - a.games).slice(0, params[1]) };
    if (/^SELECT rating, games, \(SELECT COUNT/.test(t)) { const mine = db.elo.get(`${params[1]}|${params[0]}`); if (!mine || !mine.games) return { rows: [] }; return { rows: [{ rating: mine.rating, games: mine.games, rank: String(1 + [...db.elo.values()].filter(r => r.game === params[0] && r.games > 0 && r.rating > mine.rating).length) }] }; }
    if (/^INSERT INTO games /.test(t)) { db.games.set(params[0], { data: JSON.parse(params[4]), at: db.now }); return { rows: [], rowCount: 1 }; }
    if (/^DELETE FROM games WHERE id=/.test(t)) { db.games.delete(params[0]); return { rows: [], rowCount: 1 }; }
    if (/^SELECT data FROM games/.test(t)) return { rows: [...db.games.values()].map(g => ({ data: g.data })) };
    if ((m = /^SELECT name, alt_name, norm_name, norm_alt, overall FROM fc_players WHERE game=\$1/.exec(t))) {
        const needle = params[1].replace(/%/g, '');
        return { rows: db.players.filter(p => p.game === params[0] && (p.norm_name.includes(needle) || (p.norm_alt || '').includes(needle))).sort((a, b) => b.overall - a.overall) };
    }
    return { rows: [], rowCount: 0 };   // everything else (table creation, counting settings, stats, ...)
}
class Pool {
    constructor() {}
    on() {}
    query(text, params) { return Promise.resolve().then(() => query(text, params)); }
    async connect() { return { query: (t, p) => Promise.resolve().then(() => query(t, p)), release() {} }; }
}
module.exports = { Pool };

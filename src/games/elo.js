// Elo ratings for the 1v1 games. Ratings are bot-wide: one rating per player per game, shared by every server.
const { pool } = require('../db');
const { ELO_START, ELO_K, PAIR_COOLDOWN_MIN } = require('../config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS game_elo (
    user_id TEXT NOT NULL,
    game TEXT NOT NULL,
    rating INT NOT NULL,
    games INT NOT NULL DEFAULT 0,
    wins INT NOT NULL DEFAULT 0,
    losses INT NOT NULL DEFAULT 0,
    draws INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, game)
);
CREATE INDEX IF NOT EXISTS game_elo_rank ON game_elo (game, rating DESC);
-- when each pair of players last had a game that counted for Elo (user_a is the smaller id), for the win trading cooldown
CREATE TABLE IF NOT EXISTS game_pairs (
    game TEXT NOT NULL,
    user_a TEXT NOT NULL,
    user_b TEXT NOT NULL,
    last_rated TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (game, user_a, user_b)
);
`;
const RATED = new Set(['tictactoe', 'connect4', 'guesswho', 'sinkship']);
const init = async () => { await pool.query(SCHEMA); await cleanup(); };
// Pairs whose cooldown is over carry no information, so they are dropped.
const cleanup = () => pool.query(`DELETE FROM game_pairs WHERE last_rated < NOW() - ($1 || ' minutes')::interval`, [String(PAIR_COOLDOWN_MIN)]).catch(e => console.error('elo cleanup:', e.message));
const expected = (ra, rb) => 1 / (1 + 10 ** ((rb - ra) / 400));

// { userId: rating } with the starting rating for anyone who has not played yet
async function ratings(game, ids) {
    const out = Object.fromEntries(ids.map(id => [id, ELO_START]));
    try {
        const r = await pool.query('SELECT user_id, rating FROM game_elo WHERE game=$1 AND user_id = ANY($2)', [game, ids]);
        for (const row of r.rows) out[row.user_id] = row.rating;
    } catch (e) { console.error('elo ratings:', e.message); }
    return out;
}

// scoreA: 1 = a won, 0 = a lost, 0.5 = draw. Returns { a: {before, after, delta}, b: {...} } keyed by user id, or null if the database failed.
// Win trading guard: if these two players already had a game that counted for this game type less than PAIR_COOLDOWN_MIN minutes ago,
// nothing changes and { cooldown: minutesLeft } comes back instead. The pair row is locked for the whole transaction, so two games
// finishing at the same moment cannot both count.
async function record(game, aId, bId, scoreA) {
    const cl = await pool.connect();
    try {
        await cl.query('BEGIN');
        const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
        await cl.query('INSERT INTO game_pairs (game, user_a, user_b, last_rated) VALUES ($1,$2,$3,to_timestamp(0)) ON CONFLICT DO NOTHING', [game, lo, hi]);
        const pair = (await cl.query('SELECT EXTRACT(EPOCH FROM (NOW() - last_rated)) AS age FROM game_pairs WHERE game=$1 AND user_a=$2 AND user_b=$3 FOR UPDATE', [game, lo, hi])).rows[0];
        const age = Number(pair.age), limit = PAIR_COOLDOWN_MIN * 60;
        if (age < limit) { await cl.query('ROLLBACK'); return { cooldown: Math.ceil((limit - age) / 60) }; }
        for (const id of [aId, bId]) await cl.query('INSERT INTO game_elo (user_id, game, rating) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, game, ELO_START]);
        const rows = (await cl.query('SELECT user_id, rating FROM game_elo WHERE game=$1 AND user_id = ANY($2) FOR UPDATE', [game, [aId, bId]])).rows;
        const ra = rows.find(r => r.user_id === aId).rating, rb = rows.find(r => r.user_id === bId).rating;
        const na = Math.round(ra + ELO_K * (scoreA - expected(ra, rb))), nb = Math.round(rb + ELO_K * ((1 - scoreA) - expected(rb, ra)));
        const upd = (id, rating, s) => cl.query('UPDATE game_elo SET rating=$3, games=games+1, wins=wins+$4, losses=losses+$5, draws=draws+$6, updated_at=NOW() WHERE user_id=$1 AND game=$2',
            [id, game, rating, s === 1 ? 1 : 0, s === 0 ? 1 : 0, s === 0.5 ? 1 : 0]);
        await upd(aId, na, scoreA); await upd(bId, nb, 1 - scoreA);
        await cl.query('UPDATE game_pairs SET last_rated=NOW() WHERE game=$1 AND user_a=$2 AND user_b=$3', [game, lo, hi]);
        await cl.query('COMMIT');
        return { [aId]: { before: ra, after: na, delta: na - ra }, [bId]: { before: rb, after: nb, delta: nb - rb } };
    } catch (e) { await cl.query('ROLLBACK').catch(() => {}); console.error('elo record:', e.message); return null; }
    finally { cl.release(); }
}
// A win by forfeit (conceded, forfeited, or ran out of time). Friendly games record nothing.
async function settle(game, winnerId, loserId) {
    if (game.friendly) return { friendly: true };
    return record(game.type, winnerId, loserId, 1);
}
// winnerId null = a draw. The two players are game.userIds.
async function finish(game, winnerId) {
    const [a, b] = game.userIds;
    if (!RATED.has(game.type) || !a || !b) return null;
    if (game.friendly) return { friendly: true };   // friendly games never touch ratings or the cooldown
    if (!winnerId) return record(game.type, a, b, 0.5);
    return record(game.type, winnerId, winnerId === a ? b : a, 1);
}
async function top(game, limit = 10) {
    const r = await pool.query('SELECT user_id, rating, games, wins, losses, draws FROM game_elo WHERE game=$1 AND games > 0 ORDER BY rating DESC, games DESC LIMIT $2', [game, limit]);
    return r.rows;
}
async function standing(game, userId) {
    const r = await pool.query('SELECT rating, games, (SELECT COUNT(*) + 1 FROM game_elo o WHERE o.game=$1 AND o.games > 0 AND o.rating > e.rating) AS rank FROM game_elo e WHERE user_id=$2 AND game=$1 AND games > 0', [game, userId]);
    return r.rows[0] ?? null;
}

// Text helpers used in game messages
const withRating = (game, id) => `<@${id}>${game.elo?.[id] != null ? ` (${game.elo[id]})` : ''}`;
const sign = n => (n > 0 ? `+${n}` : String(n));
const resultLine = res => (res?.friendly ? '\u{1F91D} Friendly game: no Elo.' : res?.cooldown ? `\u{1F4C8} No Elo change: these two played each other recently (it counts again in ${res.cooldown} min).` : res ? `\u{1F4C8} Elo: ${Object.entries(res).map(([id, r]) => `<@${id}> ${r.before} \u2192 ${r.after} (${sign(r.delta)})`).join('  |  ')}` : '');

module.exports = { RATED, init, cleanup, ratings, record, finish, settle, top, standing, withRating, resultLine };

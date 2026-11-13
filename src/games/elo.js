// Elo ratings for the 1v1 games. Ratings are bot-wide: one rating per player per game, shared by every server.
const { pool } = require('../db');
const { ELO_START, ELO_K } = require('../config');

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
`;
const RATED = new Set(['tictactoe', 'connect4', 'guesswho', 'sinkship']);
const init = () => pool.query(SCHEMA);
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
async function record(game, aId, bId, scoreA) {
    const cl = await pool.connect();
    try {
        await cl.query('BEGIN');
        for (const id of [aId, bId]) await cl.query('INSERT INTO game_elo (user_id, game, rating) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, game, ELO_START]);
        const rows = (await cl.query('SELECT user_id, rating FROM game_elo WHERE game=$1 AND user_id = ANY($2) FOR UPDATE', [game, [aId, bId]])).rows;
        const ra = rows.find(r => r.user_id === aId).rating, rb = rows.find(r => r.user_id === bId).rating;
        const na = Math.round(ra + ELO_K * (scoreA - expected(ra, rb))), nb = Math.round(rb + ELO_K * ((1 - scoreA) - expected(rb, ra)));
        const upd = (id, rating, s) => cl.query('UPDATE game_elo SET rating=$3, games=games+1, wins=wins+$4, losses=losses+$5, draws=draws+$6, updated_at=NOW() WHERE user_id=$1 AND game=$2',
            [id, game, rating, s === 1 ? 1 : 0, s === 0 ? 1 : 0, s === 0.5 ? 1 : 0]);
        await upd(aId, na, scoreA); await upd(bId, nb, 1 - scoreA);
        await cl.query('COMMIT');
        return { [aId]: { before: ra, after: na, delta: na - ra }, [bId]: { before: rb, after: nb, delta: nb - rb } };
    } catch (e) { await cl.query('ROLLBACK').catch(() => {}); console.error('elo record:', e.message); return null; }
    finally { cl.release(); }
}
// winnerId null = a draw. The two players are game.userIds.
async function finish(game, winnerId) {
    const [a, b] = game.userIds;
    if (!RATED.has(game.type) || !a || !b) return null;
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
const resultLine = res => (res ? `\u{1F4C8} Elo: ${Object.entries(res).map(([id, r]) => `<@${id}> ${r.before} \u2192 ${r.after} (${sign(r.delta)})`).join('  |  ')}` : '');

module.exports = { RATED, init, ratings, record, finish, top, standing, withRating, resultLine };

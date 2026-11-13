// Active games live in memory and are saved to the database after every change, then deleted when the game ends.
// On startup, games with activity inside the last GAME_TTL_MIN minutes are loaded back, so a restart doesn't end them.
const { pool } = require('../db');
const { GAME_TTL_MIN } = require('../config');

const games = new Map();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

async function init() {
    await pool.query(SCHEMA);
    await pool.query(`DELETE FROM games WHERE updated_at < NOW() - ($1 || ' minutes')::interval`, [String(GAME_TTL_MIN)]);
    const r = await pool.query('SELECT data FROM games');
    games.clear();
    for (const row of r.rows) games.set(row.data.id, row.data);
    return [...games.values()];
}

// Database writes for one game run strictly in the order they were made. Without this, a slow "save" from an earlier move could
// land after the "delete" at the end of the game and bring a finished game back to life in the database.
const queues = new Map();
function enqueue(id, fn, what) {
    const prev = queues.get(id) ?? Promise.resolve();
    const next = prev.then(fn).catch(e => console.error(`${what} game:`, e.message));
    queues.set(id, next);
    next.finally(() => { if (queues.get(id) === next) queues.delete(id); });
    return next;
}
const flush = () => Promise.all([...queues.values()]);   // waits for pending writes (used by tests)

function add(game) { game.updatedAt = Date.now(); games.set(game.id, game); persist(game); return game; }
function save(game) { game.updatedAt = Date.now(); persist(game); }
function persist(game) {
    const snapshot = JSON.stringify(game);   // the state as it is right now, not as it will be when the write runs
    enqueue(game.id, () => pool.query('INSERT INTO games (id, type, guild_id, channel_id, data, updated_at) VALUES ($1,$2,$3,$4,$5::jsonb,NOW()) ON CONFLICT (id) DO UPDATE SET data=$5::jsonb, updated_at=NOW()',
        [game.id, game.type, game.guildId, game.channelId, snapshot]), 'save');
}
function remove(game) {
    games.delete(game.id);
    enqueue(game.id, () => pool.query('DELETE FROM games WHERE id=$1', [game.id]), 'delete');
}
const get = id => games.get(id);
const all = () => [...games.values()];
const forUserInChannel = (userId, channelId) => all().filter(g => g.channelId === channelId && g.messageId && g.userIds.includes(userId));

module.exports = { init, add, save, remove, flush, get, all, forUserInChannel };

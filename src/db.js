const { Pool } = require('pg');
const { envInt, PS, SLB_MAX, COUNTDOWN_START, LEGACY_GUILD_KEYS, safeMode } = require('./config');

// DB limits are configurable so slow/spiky databases can be tuned without a code change.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    statement_timeout: envInt('DB_STATEMENT_TIMEOUT_MS', 8000),
    connectionTimeoutMillis: envInt('DB_CONNECTION_TIMEOUT_MS', 5000),
    idleTimeoutMillis: envInt('DB_IDLE_TIMEOUT_MS', 600000),
    max: envInt('DB_POOL_MAX', 3),
});
// An unhandled 'error' on the pool (e.g. an idle connection dropping) would otherwise crash the process.
pool.on('error', e => console.error('pg pool error:', e.message));

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS counting   (guild_id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS counting_channels (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, data JSONB NOT NULL DEFAULT '{}', PRIMARY KEY (guild_id, channel_id));
        CREATE INDEX IF NOT EXISTS counting_channels_channel ON counting_channels(channel_id);
        CREATE TABLE IF NOT EXISTS user_stats (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, data JSONB NOT NULL DEFAULT '{}', PRIMARY KEY (guild_id, user_id));
        CREATE INDEX IF NOT EXISTS user_stats_user ON user_stats(user_id);
        CREATE TABLE IF NOT EXISTS dedup (message_id TEXT PRIMARY KEY, claimed_at TIMESTAMPTZ DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS support_announced (guild_id TEXT PRIMARY KEY, announced_at TIMESTAMPTZ DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS fail_roles (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, role_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (guild_id, user_id));
    `);
    await migrateLegacyChannels();
    cleanupDedup();
    setInterval(cleanupDedup, 10 * 60 * 1000).unref();
}
const cleanupDedup = () => pool.query(`DELETE FROM dedup WHERE claimed_at < NOW() - INTERVAL '5 minutes'`).catch(() => {});
async function claimMessage(mid) {
    try { const r = await pool.query('INSERT INTO dedup (message_id) VALUES ($1) ON CONFLICT (message_id) DO NOTHING RETURNING message_id', [mid]); return r.rowCount > 0; }
    catch { return true; }
}

// One-time move of the old single-channel-per-server layout into the counting_channels table.
async function migrateLegacyChannels() {
    const r = await pool.query('SELECT guild_id, data FROM counting');
    for (const { guild_id: gid, data: d } of r.rows) {
        if (d.migratedToChannels) continue;
        const cl = await pool.connect();
        try {
            await cl.query('BEGIN');
            if (d.channelId) {
                const type = d.countType === 'random' ? 'modifiers' : (safeMode(d.countType) ?? 'interactive');
                const start = d.countdownStart ?? COUNTDOWN_START;
                const c = { guildId: gid, channelId: d.channelId, countType: type, current: d.current ?? 0, lastUserId: d.lastUserId ?? null, consecutiveCount: d.consecutiveCount ?? 0, lastMessageId: null, highScore: d.highScore ?? 0, countdownCycles: d.countdownCycles ?? 0, countdownStart: start, modifier: d.randomModifier ?? null, modifierLabel: d.randomModifierLabel ?? null, checkpoint: 0 };
                // Old countdowns parked at 100 after a reset and then demanded 99. "Nothing counted yet" is now start+1.
                if (type === 'countdown' && (!c.current || c.current >= start)) c.current = start + 1;
                await cl.query('INSERT INTO counting_channels (guild_id, channel_id, data) VALUES ($1,$2,$3) ON CONFLICT (guild_id, channel_id) DO NOTHING', [gid, d.channelId, c]);
            }
            const g = { ...d };
            for (const k of LEGACY_GUILD_KEYS) delete g[k];
            g.migratedToChannels = true;
            await cl.query('UPDATE counting SET data=$2 WHERE guild_id=$1', [gid, g]);
            await cl.query('COMMIT');
        } catch (e) {
            await cl.query('ROLLBACK').catch(() => {});
            console.error(`migrate ${gid}:`, e.message);
        } finally { cl.release(); }
    }
}

async function updateUserStat(gid, uid, delta) {
    try {
        const r = await pool.query('SELECT data FROM user_stats WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
        const cur = r.rows[0]?.data ?? { correct: 0, ruined: 0, saves: 0, savesUsed: 0 };
        for (const [k, v] of Object.entries(delta)) cur[k] = (cur[k] || 0) + v;
        await pool.query('INSERT INTO user_stats (guild_id,user_id,data) VALUES ($1,$2,$3) ON CONFLICT (guild_id,user_id) DO UPDATE SET data=$3', [gid, uid, cur]);
        return cur;
    } catch (e) { console.error('updateUserStat:', e.message); return null; }
}
async function getUserStats(gid, uid) {
    const r = await pool.query('SELECT data FROM user_stats WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
    return r.rows[0]?.data ?? { correct: 0, ruined: 0, saves: 0, savesUsed: 0 };
}
async function getUserRank(gid, uid) {
    const r = await pool.query(`SELECT COUNT(*)+1 AS rank FROM user_stats WHERE guild_id=$1 AND COALESCE((data->>'correct')::int,0) > COALESCE((SELECT (data->>'correct')::int FROM user_stats WHERE guild_id=$1 AND user_id=$2),0)`, [gid, uid]);
    return parseInt(r.rows[0]?.rank ?? 1);
}
async function getServerStats(gid) {
    const r = await pool.query(`SELECT COUNT(*) AS tu, SUM(COALESCE((data->>'correct')::int,0)) AS tc, SUM(COALESCE((data->>'ruined')::int,0)) AS tr FROM user_stats WHERE guild_id=$1`, [gid]);
    return r.rows[0] ?? {};
}
async function getServerLbPage(gid, page) {
    const off = Math.min((page-1)*PS, SLB_MAX-PS);
    const [rows, tot] = await Promise.all([
        pool.query(`SELECT user_id,data FROM user_stats WHERE guild_id=$1 ORDER BY COALESCE((data->>'correct')::int,0) DESC LIMIT $2 OFFSET $3`, [gid, PS, off]),
        pool.query(`SELECT LEAST(COUNT(*), $2) AS cnt FROM user_stats WHERE guild_id=$1`, [gid, SLB_MAX]),
    ]);
    return { rows: rows.rows, total: parseInt(tot.rows[0].cnt) };
}
async function getGlobalUsersPage(page) {
    const off = (page-1)*PS;
    const [rows, tot] = await Promise.all([
        pool.query(`SELECT user_id, SUM(COALESCE((data->>'correct')::int,0)) AS correct, SUM(COALESCE((data->>'ruined')::int,0)) AS ruined FROM user_stats GROUP BY user_id ORDER BY correct DESC LIMIT $1 OFFSET $2`, [PS, off]),
        pool.query(`SELECT COUNT(DISTINCT user_id) AS cnt FROM user_stats`),
    ]);
    return { rows: rows.rows, total: parseInt(tot.rows[0].cnt) };
}

const whereMode = i => `WHERE COALESCE(data->>'countType','interactive')=$${i}`;
async function getGlobalServersPage(page, filter) {
    const off = (page - 1) * PS, mode = safeMode(filter);
    const orderExpr = mode === 'countdown' ? `COALESCE((data->>'countdownCycles')::int,0)` : `COALESCE((data->>'current')::int,0)`;
    const [rows, tot] = await Promise.all([
        pool.query(`SELECT guild_id, channel_id, COALESCE((data->>'current')::int,0) AS cur, COALESCE((data->>'highScore')::int,0) AS hs, COALESCE((data->>'countdownCycles')::int,0) AS cycles, COALESCE(data->>'countType','interactive') AS mode FROM counting_channels ${mode ? whereMode(3) : ''} ORDER BY ${orderExpr} DESC LIMIT $1 OFFSET $2`, mode ? [PS, off, mode] : [PS, off]),
        pool.query(`SELECT COUNT(*) AS cnt FROM counting_channels ${mode ? whereMode(1) : ''}`, mode ? [mode] : []),
    ]);
    return { rows: rows.rows, total: parseInt(tot.rows[0].cnt) };
}
async function getHighscoresPage(page, filter) {
    const off = (page - 1) * PS, mode = safeMode(filter) ?? 'interactive';
    const scoreExpr = mode === 'countdown' ? `COALESCE((data->>'countdownCycles')::int,0)` : `COALESCE((data->>'highScore')::int,0)`;
    const [rows, tot] = await Promise.all([
        pool.query(`SELECT guild_id, channel_id, ${scoreExpr} AS score, COALESCE((data->>'current')::int,0) AS cur FROM counting_channels ${whereMode(3)} ORDER BY score DESC LIMIT $1 OFFSET $2`, [PS, off, mode]),
        pool.query(`SELECT COUNT(*) AS cnt FROM counting_channels ${whereMode(1)}`, [mode]),
    ]);
    return { rows: rows.rows, total: parseInt(tot.rows[0].cnt) };
}

module.exports = {
    pool, initDB, claimMessage, updateUserStat, getUserStats, getUserRank, getServerStats, getServerLbPage,
    getGlobalUsersPage, getGlobalServersPage, getHighscoresPage,
};

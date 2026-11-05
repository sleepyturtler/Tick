// On startup, loads any game from the sql/ folder that has no rows in fc_players yet.
// So you deploy the sql/ folder with the bot and nothing has to be run by hand.
//
//   - A game that already has rows is skipped (one cheap query), so normal restarts cost nothing.
//   - Each sql file is a single transaction, so a failure leaves that game empty and it retries on the next start.
//   - To reload a game: DELETE FROM fc_players WHERE game = 26;  and restart.
//   - Set FC_AUTOLOAD=0 to turn this off.
const fs = require('fs'), path = require('path');
const { pool } = require('./db');
const { FC_AUTOLOAD } = require('./config');

const SQL_DIR = path.join(__dirname, '..', 'sql');
const LOCK_KEY = 7270001;   // advisory lock so two instances (e.g. overlapping deploys) can't import the same game twice

async function importFile(dir, file, game) {
    const client = await pool.connect();
    try {
        // The pool's short statement timeout is for the bot's normal queries; a big import (and waiting on the lock) needs longer.
        await client.query('SET statement_timeout = 0');
        await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
        try {
            // Check again now that we hold the lock: another instance may have just finished this game.
            const have = await client.query('SELECT 1 FROM fc_players WHERE game=$1 LIMIT 1', [game]).catch(() => null);
            if (have && have.rowCount) return false;
            const started = Date.now();
            try {
                await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
            } catch (e) {
                await client.query('ROLLBACK').catch(() => {});   // the file opens its own transaction; don't leave it hanging
                throw e;
            }
            const n = (await client.query('SELECT COUNT(*) AS n FROM fc_players WHERE game=$1', [game])).rows[0].n;
            console.log(`Imported ratings for game ${game}: ${n} players (${((Date.now() - started) / 1000).toFixed(1)}s)`);
            return true;
        } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
        }
    } finally {
        await client.query('RESET statement_timeout').catch(() => {});
        client.release();
    }
}

// Newest game first, so the one bare player names use becomes available soonest. Returns how many games were imported.
async function loadMissingRatings(dir = SQL_DIR) {
    if (!FC_AUTOLOAD) return 0;
    let files;
    try { files = fs.readdirSync(dir).filter(f => /^fc\d{2}\.sql$/.test(f)).sort().reverse(); }
    catch { return 0; }   // no sql folder deployed: nothing to do
    let imported = 0;
    for (const file of files) {
        const game = parseInt(file.slice(2, 4), 10);
        try {
            const have = await pool.query('SELECT 1 FROM fc_players WHERE game=$1 LIMIT 1', [game]);
            if (have.rowCount) continue;
            if (await importFile(dir, file, game)) imported++;
        } catch (e) { console.error(`ratings import ${file}:`, e.message); }
    }
    return imported;
}

module.exports = { loadMissingRatings };

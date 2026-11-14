// Check the player lookup against your database.
//   DATABASE_URL=... node scripts/fc-check.js "lamine yamal:fc25"
//   DATABASE_URL=... node scripts/fc-check.js --stats        (how many players are loaded per game)
const { LATEST_FC } = require('../src/config');
const { pool } = require('../src/db');
const fc = require('../src/fc');

(async () => {
    const input = process.argv.slice(2).join(' ').trim();
    if (!input) { console.log('usage: node scripts/fc-check.js "lamine yamal:fc25"   or   node scripts/fc-check.js --stats'); process.exit(1); }
    try {
        if (input === '--stats') {
            const r = await pool.query('SELECT game, COUNT(*) AS players, MAX(overall) AS top FROM fc_players GROUP BY game ORDER BY game');
            console.log('latest game (LATEST_FC):', LATEST_FC);
            console.table(r.rows);
            return;
        }
        const q = fc.parseQuery(input);
        console.log('latest game (LATEST_FC):', LATEST_FC);
        if (!q) { console.log('parse: not a player attempt (the bot would treat it as normal chat or math)'); return; }
        console.log('parse:', q);
        const want = fc.norm(q.name), longest = want.split(' ').reduce((a, b) => (b.length > a.length ? b : a));
        const rows = (await pool.query('SELECT name, alt_name, overall FROM fc_players WHERE game=$1 AND (norm_name LIKE $2 OR norm_alt LIKE $2) ORDER BY overall DESC LIMIT 8', [q.game, `%${longest}%`])).rows;
        console.log(`candidates containing "${longest}" in game ${q.game}:`); console.table(rows);
        console.log('bot would use:', await fc.lookup(q));
    } catch (e) { console.error('failed:', e.message); }
    finally { await pool.end(); }
})();

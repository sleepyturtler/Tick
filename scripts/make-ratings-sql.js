// Turns ratings CSV files into one SQL file per game that you load into Postgres.
//
//   node scripts/make-ratings-sql.js male_players.csv female_players.csv          (several games in one file: one SQL per game)
//   node scripts/make-ratings-sql.js all_players.csv --game 25                   (a file with no game column needs --game)
//   node scripts/make-ratings-sql.js players.csv --out sql                       (default output folder is ./sql)
//
// Then load each result:  psql "<External Database URL>" -f sql/fc25.sql
// Each SQL file replaces that game's rows, so re-running it is safe.
//
// Three CSV layouts are recognised from their header row:
//   sofifa style    fifa_version, fifa_update, short_name, long_name, overall   (game from fifa_version; earliest update only = launch)
//   edition style   edition (e.g. fc27), common_name, first_name, last_name, overall_rating
//   EA site style   Name, OVR   (no game column, so pass --game)
// Pass several files in one run when a game is split across them (men and women); their rows are merged.
const fs = require('fs'), path = require('path');
const { norm, FC_SCHEMA_SQL } = require('../src/fcdata');

function parseCsv(text, onRow) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    let field = '', row = [], inQ = false;
    for (let i = 0, n = text.length; i < n; i++) {
        const c = text[i];
        if (inQ) {
            if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
            else field += c;
        } else if (c === '"') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (!(row.length === 1 && row[0] === '')) onRow(row);
            row = [];
        } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); onRow(row); }
}

const args = process.argv.slice(2), files = [];
let forcedGame = null, outDir = 'sql';
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--game') forcedGame = parseInt(args[++i], 10);
    else if (args[i] === '--out') outDir = args[++i];
    else files.push(args[i]);
}
if (!files.length) { console.log('usage: node scripts/make-ratings-sql.js <csv...> [--game N] [--out dir]'); process.exit(1); }

// game -> update -> Map(dedupe key -> row)
const games = new Map();
const stats = { skipped: 0 };
function add(game, update, date, name, alt, overall) {
    name = String(name || '').trim(); alt = String(alt || '').trim(); overall = Math.round(Number(overall));
    if (!Number.isFinite(game) || !name || !Number.isFinite(overall) || overall <= 0) { stats.skipped++; return; }
    if (!games.has(game)) games.set(game, new Map());
    const g = games.get(game);
    if (!g.has(update)) g.set(update, { date, rows: new Map() });
    g.get(update).rows.set(`${name}|${alt}|${overall}`, { name, alt, overall });
}

for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    let idx = null, layout = null, count = 0;
    parseCsv(text, r => {
        if (!idx) {
            idx = {}; r.forEach((h, i) => { idx[h.trim().toLowerCase()] = i; });
            if ('fifa_version' in idx && 'short_name' in idx && 'overall' in idx) layout = 'sofifa';
            else if ('edition' in idx && 'overall_rating' in idx) layout = 'edition';
            else if ('name' in idx && 'ovr' in idx) layout = 'ea';
            else { console.error(`${f}: unrecognised columns: ${r.slice(0, 12).join(', ')}`); process.exit(1); }
            if (layout === 'ea' && !forcedGame) { console.error(`${f}: this file has no game column, pass --game N (for example --game 25)`); process.exit(1); }
            return;
        }
        count++;
        const v = k => (r[idx[k]] ?? '');
        if (layout === 'sofifa') add(forcedGame ?? parseInt(v('fifa_version'), 10), parseInt(v('fifa_update'), 10) || 0, v('fifa_update_date') || v('update_as_of'), v('short_name'), v('long_name'), v('overall'));
        else if (layout === 'edition') {
            const full = `${v('first_name')} ${v('last_name')}`.trim(), common = v('common_name').trim();
            add(forcedGame ?? parseInt((v('edition').match(/\d{2}/) || [])[0], 10), 0, v('snapshot_date'), common || full, common ? full : '', v('overall_rating'));
        } else add(forcedGame, 0, '', v('name'), '', v('ovr'));
    });
    console.log(`${path.basename(f)}: ${count} rows read (${layout} layout)`);
}

fs.mkdirSync(outDir, { recursive: true });
const q = s => "'" + String(s).replace(/\u0000/g, '').replace(/'/g, "''") + "'";
for (const game of [...games.keys()].sort((a, b) => a - b)) {
    const updates = games.get(game), first = Math.min(...updates.keys());   // earliest update = launch ratings
    const { date, rows: map } = updates.get(first), rows = [...map.values()];
    const tuples = rows.map(r => `(${game},${q(r.name)},${q(r.alt)},${q(norm(r.name))},${q(norm(r.alt))},${r.overall})`);
    const parts = [
        `-- Launch ratings for game ${game}: ${rows.length} players${updates.size > 1 ? `, update ${first} of ${updates.size} in the source` : ''}${date ? `, source date ${date}` : ''}.`,
        '-- Generated by scripts/make-ratings-sql.js. Safe to re-run: it replaces this game\'s rows.',
        "SET client_encoding = 'UTF8';", 'BEGIN;', FC_SCHEMA_SQL.trim(), `DELETE FROM fc_players WHERE game = ${game};`,
    ];
    for (let i = 0; i < tuples.length; i += 500)
        parts.push(`INSERT INTO fc_players (game, name, alt_name, norm_name, norm_alt, overall) VALUES\n${tuples.slice(i, i + 500).join(',\n')};`);
    parts.push('COMMIT;');
    const file = path.join(outDir, `fc${String(game).padStart(2, '0')}.sql`);
    fs.writeFileSync(file, parts.join('\n') + '\n');
    const top = [...rows].sort((a, b) => b.overall - a.overall).slice(0, 3).map(r => `${r.name} ${r.overall}`).join(', ');
    console.log(`game ${String(game).padStart(2)}: ${String(rows.length).padStart(6)} players -> ${file}  (${(fs.statSync(file).size / 1e6).toFixed(1)} MB, top: ${top})`);
}
if (stats.skipped) console.log(`skipped ${stats.skipped} rows with no name or no valid rating`);

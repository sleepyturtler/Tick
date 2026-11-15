// Shared by the bot (lookups) and scripts/make-ratings-sql.js (building the SQL), so a name is
// always normalized the same way when it is stored and when it is searched. No dependencies on purpose.

// Letters that don't split into "letter + accent" under Unicode normalization.
const MAP = { '\u00f8': 'o', '\u0111': 'd', '\u0142': 'l', '\u00df': 'ss', '\u00e6': 'ae', '\u0153': 'oe', '\u00fe': 'th', '\u00f0': 'd', '\u0131': 'i' };

// "N'Golo Kant\u00e9" -> "n golo kante", "Son Heung-min" -> "son heung min", "\u00d8degaard" -> "odegaard"
function norm(s) {
    s = String(s ?? '').normalize('NFD').toLowerCase();
    let out = '';
    for (const ch of s) {
        if (/\p{Mn}/u.test(ch)) continue;                 // drop accents
        if (MAP[ch] !== undefined) out += MAP[ch];
        else if (/[\p{L}\p{N}]/u.test(ch)) out += ch;     // keep letters and digits
        else out += ' ';                                  // everything else becomes a space
    }
    return out.replace(/\s+/g, ' ').trim();
}

// One row per player per game. name/alt_name are what is shown and what is searched (alt_name is the longer legal name when there is one).
const FC_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS fc_players (
    game INT NOT NULL,
    name TEXT NOT NULL,
    alt_name TEXT NOT NULL DEFAULT '',
    norm_name TEXT NOT NULL,
    norm_alt TEXT NOT NULL DEFAULT '',
    overall INT NOT NULL
);
CREATE INDEX IF NOT EXISTS fc_players_game_name ON fc_players (game, norm_name);
CREATE INDEX IF NOT EXISTS fc_players_overall ON fc_players (overall);
`;

module.exports = { norm, FC_SCHEMA_SQL };

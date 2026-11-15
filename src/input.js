// Reads what a person typed in a counting channel and says what it means. Used by the live counter and by the edit check,
// so both agree on what a message is worth. The things a message can be:
//   a plain number or expression         2+3*4, |x-9|, pi^2
//   a football player's name with its game   lamine yamal:fc25     (when player counting is on; a name without :fcNN is just chat)
//   players inside an expression          lamine yamal:fc25+25, 2*pedri:fc24
//   an equation to solve for x            2x+3=13, x^2=25, x=lamine yamal:fc25+24
// Equations and players follow the same server settings as before: expressions on/off, and player counting on/off.
const fc = require('./fc');
const { safeMath, parseEquation } = require('./math');

// -> {
//   skip:   null, or 'react' / 'silent' when the message is a player attempt that cannot be used (never ruins the count)
//   player: the player when the whole message is one name, else null
//   inline: { text, plain, players } when players sit inside an expression, else null
//   text:   what the math parser sees (players already replaced by their overall)
//   isEq:   true for a message with exactly one "="
//   eq:     the parsed equation, or null when it has no x or does not parse
//   value:  the number, for everything except equations (those are solved against the expected number later)
// }
async function read(raw, g) {
    const out = { skip: null, player: null, inline: null, text: raw, isEq: false, eq: null, value: null };
    if (g.playerCount === true && safeMath(raw) === null) {
        const q = fc.parseQuery(raw);
        // A name only counts with its game tag (":fc25", ":fifa19"). A bare name is ordinary chat: ignored, and no lookup is made for it.
        if (q?.explicit) {
            const player = await fc.lookup(q);
            // Unknown player, missing game version or API trouble: never ruins the count, and gets a question mark.
            if (!player) { out.skip = 'react'; return out; }
            out.player = player; out.value = player.ovr; out.text = String(player.ovr);
            return out;
        }
    }
    if (g.playerCount === true && fc.hasTag(raw)) {
        const sub = await fc.substitute(raw);
        if (sub.unknown) { out.skip = 'react'; return out; }
        if (sub.players.length) { out.inline = sub; out.text = sub.text; }
    }
    if ((out.text.match(/=/g) || []).length === 1) {
        out.isEq = true; out.eq = parseEquation(out.text);
    } else out.value = safeMath(out.text);
    return out;
}

// The number a message stands for when the channel expects `expected`, or null. Used by the edit check.
function valueFor(r, expected) {
    if (r.isEq) { const s = r.eq?.solve(expected); return s && (s.status === 'ok' || s.status === 'wrong') ? s.value : null; }
    return r.value;
}

module.exports = { read, valueFor };

const { assert, test, db } = require('./lib');
const fc = require('../src/fc');
const { norm } = require('../src/fcdata');
const { read, valueFor } = require('../src/input');

const P = (game, name, overall, alt = '') => ({ game, name, alt_name: alt, norm_name: norm(name), norm_alt: norm(alt), overall });
function seed() {
    db().reset();
    db().players.push(P(25, 'Lamine Yamal', 81), P(24, 'Pedri', 85), P(25, 'Pedri', 86), P(23, 'Son Heung-min', 89), P(25, 'Trent Alexander-Arnold', 86), P(25, 'Gavi', 83), P(25, 'Pi', 70));
}
const on = { playerCount: true, allowExpressions: true }, off = { playerCount: false, allowExpressions: true };

test('Lamine Yamal:fc25+25 is 106', async () => {
    seed();
    const r = await read('Lamine Yamal:fc25+25', on);
    assert.equal(r.text, '(81)+25');
    assert.equal(r.value, 106);
    assert.deepEqual(r.inline.players.map(p => [p.name, p.ovr]), [['Lamine Yamal', 81]]);
});
test('players combine with each other and with operators, brackets and abs', async () => {
    seed();
    assert.equal((await read('lamine yamal:fc25 + pedri:fc24', on)).value, 166);
    assert.equal((await read('2*pedri:fc24', on)).value, 170);
    assert.equal((await read('|pedri:fc24-lamine yamal:fc25|', on)).value, 4);
    assert.equal((await read('(pedri:fc25+gavi:fc25)/2', on)).value, 85);   // 169/2 = 84.5 rounds up
    assert.equal((await read('10-lamine yamal:fc25', on)).value, -71);
    assert.equal((await read('2lamine yamal:fc25', on)).value, 162);        // no operator: multiplication, never the digits glued together
});
test('spaces around the colon and the game tag are fine', async () => {
    seed();
    assert.equal((await read('lamine yamal : FC 25 + 25', on)).value, 106);
    assert.equal((await read('lamine yamal:fifa 25+1', on)).value, 82);
});
test('hyphenated names are names, and a hyphen can still be a minus', async () => {
    seed();
    assert.equal((await read('Trent Alexander-Arnold:fc25+1', on)).value, 87);
    assert.equal((await read('son heung-min:fc23-9', on)).value, 80);
    assert.equal((await read('gavi-gavi:fc25', on)).value, 83);               // the existing name matcher treats repeated words as one, so this is just Gavi
    assert.equal((await read('pedri:fc25-gavi:fc25', on)).value, 3);          // 86 - 83: the hyphen after a tag is a minus
});
test('extra words before a name are left for the math to deal with', async () => {
    seed();
    assert.equal((await read('x lamine yamal:fc25', on)).text.startsWith('x '), true);
});
test('an unknown player inside an expression is skipped, never counted', async () => {
    seed();
    const r = await read('zzqq xxww:fc25+1', on);
    assert.equal(r.skip, 'react'); assert.equal(r.value, null);
});
test('players only work inside expressions when player counting is on', async () => {
    seed();
    const r = await read('lamine yamal:fc25+25', off);
    assert.equal(r.inline, null); assert.equal(r.value, null);
});
test('a lone player name still works exactly as before', async () => {
    seed();
    const r = await read('lamine yamal:fc25', on);
    assert.equal(r.player.ovr, 81); assert.equal(r.value, 81); assert.equal(r.inline, null);
    const bare = await read('pedri', on);   // no tag: the latest game, FC 27, has no Pedri here
    assert.equal(bare.skip, 'silent');
});
test('players work inside equations, on either side', async () => {
    seed();
    const a = await read('x=lamine yamal:fc25+24', on);
    assert.equal(a.isEq, true); assert.equal(valueFor(a, 105), 105); assert.equal(valueFor(a, 106), 105);
    const b = await read('x+24=lamine yamal:fc25', on);
    assert.equal(valueFor(b, 57), 57);
    const c = await read('2x=lamine yamal:fc25+pedri:fc24', on);   // 81 + 85 = 166
    assert.equal(valueFor(c, 83), 83);
});
test('the brackets added around players do not turn chatter into an expression', async () => {
    seed();
    const r = await read('lamine yamal:fc25 lol', on);
    assert.equal(r.value, null); assert.equal(/[+\-*/^()!|]/.test(r.inline.plain), false);
});
test('more than four tagged players in one message is not substituted', async () => {
    seed();
    const r = await read('pedri:fc24+pedri:fc24+pedri:fc24+pedri:fc24+pedri:fc24', on);
    assert.equal(r.value, null);
});

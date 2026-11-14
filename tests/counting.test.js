const { assert, test, db, fakeChannel, fakeMessage, tick } = require('./lib');
const state = require('../src/state');
const { handleCount, register } = require('../src/handlers/messages');
const { norm } = require('../src/fcdata');

let registered = false;
async function setup({ mode = 'interactive', current = 4, guild = {}, players = true } = {}) {
    if (!registered) { register(); registered = true; }
    db().reset();
    db().players.push({ game: 25, name: 'Lamine Yamal', alt_name: '', norm_name: norm('Lamine Yamal'), norm_alt: '', overall: 81 });
    state.chanCache.clear(); state.loadedGuilds.clear();
    const g = await state.getGuild('g1');
    Object.assign(g, { playerCount: players, allowExpressions: true, maxStreak: 0, antiCheat: true, ...guild });
    const c = state.defaultChannel('g1', 'c1', mode);
    c.current = current; c.lastUserId = null; c.consecutiveCount = 0;
    state.chanCache.set('c1', c);
    return { g, c, ch: fakeChannel('c1') };
}
async function say(ch, content, userId = 'u1') { const m = fakeMessage({ content, userId, channel: ch }); await handleCount(m); await tick(); return m; }

test('an equation counts when x solves to the next number', async () => {
    const { c, ch } = await setup({ current: 4 });
    const m = await say(ch, '2x+3=13');
    assert.equal(c.current, 5); assert.ok(m.reactions.includes('5\uFE0F\u20E3'), m.reactions.join());
});
test('an equation with the wrong solution ruins the count and says what it solved to', async () => {
    const { c, ch } = await setup({ current: 5 });
    const m = await say(ch, '2x+3=13');   // solves to 5, but 6 was expected
    assert.equal(c.current, 0); assert.ok(m.reactions.includes('\u274C'));
    assert.ok(ch.sent.map(s => JSON.stringify(s.payload)).join().includes('sent `5`'), 'ruin message names the solved number');
});
test('quadratic: either root can be the count', async () => {
    const { c, ch } = await setup({ current: 4 });
    await say(ch, 'x^2=25');
    assert.equal(c.current, 5);
});
test('identities and chatter are not counts and never ruin', async () => {
    const { c, ch } = await setup({ current: 4 });
    const a = await say(ch, 'x=x'); assert.equal(c.current, 4); assert.ok(a.reactions.includes('\u2753'));
    const b = await say(ch, '1+1=2'); assert.equal(c.current, 4); assert.equal(b.reactions.length, 0);
    const d = await say(ch, 'x+1=x+2'); assert.equal(c.current, 4); assert.ok(d.reactions.includes('\u2753'));
});
test('equations follow the expressions setting', async () => {
    const { c, ch } = await setup({ current: 4, guild: { allowExpressions: false } });
    const m = await say(ch, '2x+3=13');
    assert.equal(c.current, 4); assert.ok(m.reactions.includes('\u274C'));
    assert.ok(JSON.stringify(ch.sent.map(s => s.payload)).includes('Expressions disabled'));
});
test('players inside an expression count: Lamine Yamal:fc25+25 is 106', async () => {
    const { c, ch } = await setup({ current: 105 });
    const m = await say(ch, 'Lamine Yamal:fc25+25');
    assert.equal(c.current, 106); assert.ok(m.reactions.includes('\u26bd'));
    assert.ok(m.replies[0].content.includes('Lamine Yamal') && m.replies[0].content.includes('81'));
});
test('players inside an expression follow the expressions setting too', async () => {
    const { c, ch } = await setup({ current: 105, guild: { allowExpressions: false } });
    const m = await say(ch, 'Lamine Yamal:fc25+25');
    assert.equal(c.current, 105); assert.ok(m.reactions.includes('\u274C'));
});
test('player counting off: the same text does nothing', async () => {
    const { c, ch } = await setup({ current: 105, players: false });
    const m = await say(ch, 'Lamine Yamal:fc25+25');
    assert.equal(c.current, 105); assert.equal(m.reactions.length, 0);
});
test('an unknown player inside an expression gets a question mark and never ruins', async () => {
    const { c, ch } = await setup({ current: 10 });
    const m = await say(ch, 'nobody atall:fc25+1');
    assert.equal(c.current, 10); assert.deepEqual(m.reactions, ['\u2753']);
});
test('a lone player name and plain numbers behave as before', async () => {
    const { c, ch } = await setup({ current: 80 });
    await say(ch, 'lamine yamal:fc25'); assert.equal(c.current, 81);
    await say(ch, '82', 'u2'); assert.equal(c.current, 82);
    await say(ch, 'hello there', 'u1'); assert.equal(c.current, 82);
});
test('simple mode: a right equation counts, a wrong one is deleted', async () => {
    const { c, ch } = await setup({ mode: 'simple', current: 9 });
    const ok = await say(ch, 'x*2=20'); assert.equal(c.current, 10); assert.equal(ok.deleted, false);
    const bad = await say(ch, 'x+1=50', 'u2'); assert.equal(bad.deleted, true); assert.equal(c.current, 10);
});
test('countdown mode and modifiers mode use their own expected number', async () => {
    const { c, ch } = await setup({ mode: 'countdown', current: 100 });
    c.countdownStart = 99; c.current = 100;
    await say(ch, 'x+1=100');   // expected 99
    assert.equal(c.current, 99);
    const t = await setup({ mode: 'modifiers', current: 0 });
    t.c.modifier = 'every2'; t.c.modifierLabel = 'x';
    await say(t.ch, '|x|=2'); assert.equal(t.c.current, 2);
});
test('editing a counted equation without changing it is not called out as cheating', async () => {
    const { c, ch } = await setup({ current: 4 });
    const m = await say(ch, '2x+3=13');
    assert.equal(c.lastMessageId, m.id);
    state.guildCache?.get?.('g1');
    // the same check the live bot runs on a message edit
    const before = ch.sent.length;
    const mod = require('../src/handlers/messages');
    const client = require('../src/client'); client.channels.cache.set('c1', ch);
    client.emit('messageUpdate', { id: m.id }, { guildId: 'g1', channelId: 'c1', id: m.id, author: { bot: false }, partial: false, content: '2x+3=13' });
    await tick(20);
    assert.equal(ch.sent.length, before, 'no accusation');
    assert.equal(c.lastMessageId, m.id);
});
test('editing a counted equation to something else is called out', async () => {
    const { c, ch } = await setup({ current: 4 });
    const m = await say(ch, '2x+3=13');
    const client = require('../src/client'); client.channels.cache.set('c1', ch);
    client.emit('messageUpdate', { id: m.id }, { guildId: 'g1', channelId: 'c1', id: m.id, author: { bot: false }, partial: false, content: '3x=15 + 1' });
    await tick(20);
    assert.ok(JSON.stringify(ch.sent.map(s => s.payload)).includes('edited'));
});

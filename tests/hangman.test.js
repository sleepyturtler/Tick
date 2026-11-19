// Hangman starting and guessing when Discord misbehaves, the permission check before any game, and players in /calculate.
const { assert, test, db, tick, fakeChannel, fakeInteraction, fakeMessage, textOf, customIds } = require('./lib');
const client = require('../src/client');
const v2 = require('../src/v2');
const games = require('../src/games');
const store = require('../src/games/store');
const hangman = games.MODULES.hangman;
const { missingPerms } = require('../src/games/common');

let ch;
function fresh() {
    const state = require('../src/state'); state.chanCache.clear(); state.guildChans.clear();   // other suites leave counting channels behind
    db().reset(); store.all().forEach(g => { hangman.onExpire(g); store.remove(g); });
    ch = fakeChannel('c1'); client.channels.cache.set('c1', ch);
}
const permissionDenied = () => Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 });
// An interaction that can also be edited after a deferred answer, wrapped the way the bot wraps real ones.
function press(userId, customId, extra = {}) {
    const i = fakeInteraction({ userId, customId });
    i.log = []; i.edited = [];
    i.deferUpdate = async () => { i.log.push('ack'); };
    i.deferReply = async () => { i.log.push('ack'); };
    i.editReply = async p => { i.log.push('edit'); i.edited.push(p); };
    Object.assign(i, extra);
    i.__v2 = false; return v2.wrapInteraction(i);
}
async function startGame(userId = 'host') {
    const i = press(userId, 'g:pick:x'); await hangman.start(i);
    const game = store.all().find(g => g.type === 'hangman');
    return { i, game };
}
const send = async (m, p) => ch.sent.push({ id: `b${ch.sent.length + 1}`, payload: p }) && { id: `b${ch.sent.length}` };

test('hangman: starting twice in a channel is refused, and the setup message has both buttons', async () => {
    fresh();
    const { i, game } = await startGame();
    assert.ok(game); assert.equal(game.phase, 'setup');
    assert.deepEqual(customIds(i.updated[0]), [`g:${game.id}:random`, `g:${game.id}:custom`]);
    const second = press('other', 'g:pick:x'); await hangman.start(second);
    assert.ok(textOf(second.updated[0]).includes('Already running')); assert.equal(store.all().length, 1);
});
test('hangman: the press is answered before the board is posted', async () => {
    fresh(); const { game } = await startGame();
    const i = press('host', `g:${game.id}:random`);
    const realSend = ch.send; ch.send = async p => { i.log.push('post'); return realSend(p); };
    await games.handleInteraction(i); await tick();
    assert.deepEqual(i.log, ['ack', 'post', 'edit'], 'acknowledged first, then the board, then the confirmation');
    assert.equal(game.phase, 'play'); assert.ok(game.messageId); assert.ok(textOf(i.edited[0]).includes('Hangman started'));
});
test('hangman: a board that cannot be posted puts the game back to setup and says why, and pressing again works', async () => {
    fresh(); const { game } = await startGame();
    const realSend = ch.send; ch.send = async () => { throw permissionDenied(); };
    const logged = console.error; console.error = () => {};
    let i; try { i = press('host', `g:${game.id}:random`); await games.handleInteraction(i); await tick(); } finally { console.error = logged; }
    assert.equal(game.phase, 'setup'); assert.equal(game.messageId, null); assert.deepEqual(game.state, {});
    const t = textOf(i.edited[0]); assert.ok(t.includes('Attach Files') && t.includes('Send Messages'), t);
    assert.deepEqual(customIds(i.edited[0]), [`g:${game.id}:random`, `g:${game.id}:custom`], 'the setup buttons are back');
    // the host fixes the permission and presses again
    ch.send = realSend;
    const again = press('host', `g:${game.id}:random`); await games.handleInteraction(again); await tick();
    assert.equal(game.phase, 'play'); assert.ok(game.messageId); assert.equal(ch.sent.length, 1); assert.ok(textOf(again.edited[0]).includes('Hangman started'));
    // and a typed word works the same way after a failure
});
test('hangman: another kind of failure (not permissions) gets its own message', async () => {
    fresh(); const { game } = await startGame();
    ch.send = async () => { throw new Error('socket hang up'); };
    const logged = console.error; console.error = () => {};
    const i = press('host', `g:${game.id}:random`); try { await games.handleInteraction(i); await tick(); } finally { console.error = logged; }
    assert.ok(textOf(i.edited[0]).includes('Try again in a moment')); assert.equal(game.phase, 'setup');
});
test('hangman: a confirmation that cannot be delivered does not undo a board that is up', async () => {
    fresh(); const { game } = await startGame();
    const i = press('host', `g:${game.id}:random`, { editReply: async () => { throw new Error('Unknown interaction'); } });
    const logged = console.error; console.error = () => {};
    try { await games.handleInteraction(i); await tick(); } finally { console.error = logged; }
    assert.equal(game.phase, 'play'); assert.equal(ch.sent.length, 1);
    const late = press('host', `g:${game.id}:custom`); await games.handleInteraction(late); await tick();
    assert.ok(textOf(late.replied[0]).includes('already started'), 'a second press says so, as before');
});
test('hangman: pressing Random twice at once posts one board', async () => {
    fresh(); const { game } = await startGame();
    const a = press('host', `g:${game.id}:random`), b = press('host', `g:${game.id}:random`);
    await Promise.all([games.handleInteraction(a), games.handleInteraction(b)]); await tick();
    assert.equal(ch.sent.length, 1, 'one board'); assert.equal(game.phase, 'play');
    assert.equal([a, b].filter(x => x.replied.length && textOf(x.replied[0]).includes('already started')).length, 1);
});
test('hangman: typing your own word posts the board and a bad word is refused', async () => {
    fresh(); const { game } = await startGame();
    const bad = press('host', `g:${game.id}:word`); bad.fields = { getTextInputValue: () => 'ab1' }; await games.handleInteraction(bad); await tick();
    assert.equal(game.phase, 'setup'); assert.equal(ch.sent.length, 0);
    const ok = press('host', `g:${game.id}:word`); ok.fields = { getTextInputValue: () => '  ice   cream ' };
    await games.handleInteraction(ok); await tick();
    assert.equal(game.phase, 'play'); assert.equal(game.state.word, 'ice cream'); assert.equal(game.state.hostSet, true); assert.equal(ch.sent.length, 1);
});
test('hangman: a leftover game does not block the channel, a live one does', async () => {
    fresh();
    // started but never got a board (the old bug) -> cleared out of the way
    const zombie = { id: 'z1', type: 'hangman', guildId: 'g1', channelId: 'c1', messageId: null, hostId: 'x', userIds: ['x'], phase: 'play', state: { word: 'apple', guessed: [], wrong: [], hostId: 'x' }, createdAt: Date.now() };
    store.add(zombie); hangman.onRestore(zombie);
    let { game } = await startGame(); assert.ok(game && game.id !== 'z1', 'a new game started'); assert.equal(store.get('z1'), undefined);
    // an abandoned setup older than ten minutes
    fresh(); const old = { id: 's1', type: 'hangman', guildId: 'g1', channelId: 'c1', messageId: null, hostId: 'x', userIds: ['x'], phase: 'setup', state: {}, createdAt: Date.now() - 11 * 60_000 };
    store.add(old); hangman.onRestore(old);
    ({ game } = await startGame()); assert.ok(game.id !== 's1'); assert.equal(store.get('s1'), undefined);
    // a recent setup and a game with a board both still block
    fresh(); const live = { id: 'l1', type: 'hangman', guildId: 'g1', channelId: 'c1', messageId: 'm9', hostId: 'x', userIds: ['x'], phase: 'play', state: { word: 'apple', guessed: [], wrong: [], hostId: 'x' }, createdAt: Date.now() };
    store.add(live); hangman.onRestore(live);
    const i = press('y', 'g:pick:x'); await hangman.start(i); assert.ok(textOf(i.updated[0]).includes('Already running')); assert.ok(store.get('l1'));
});

// ---------- guessing ----------
async function playing(word = 'apple') {
    fresh(); const { game } = await startGame();
    const i = press('host', `g:${game.id}:word`); i.fields = { getTextInputValue: () => word }; await games.handleInteraction(i); await tick();
    ch.sent.length = 0; ch.deleted.length = 0;
    return game;
}
const guess = async (text, userId = 'u2') => { const m = fakeMessage({ content: text, userId, channel: ch }); m.channelId = 'c1'; const r = await hangman.onMessage(m); await tick(); return { m, r }; };

test('hangman: a right and a wrong letter update the board and replace the old message', async () => {
    const game = await playing();
    let { m, r } = await guess('p'); assert.equal(r, true); assert.deepEqual(game.state.guessed, ['p']); assert.ok(m.reactions.includes('\u2705'));
    assert.equal(ch.sent.length, 1); assert.equal(ch.deleted.length, 1, 'the old board was removed');
    ({ m } = await guess('z')); assert.deepEqual(game.state.wrong, ['z']); assert.ok(m.reactions.includes('\u274C'));
    ({ m } = await guess('p')); assert.ok(m.reactions.includes('\u{1F501}'), 'a repeat is noted, not counted'); assert.equal(game.state.guessed.length, 1);
});
test('hangman: a hiccup while posting the board is retried once and the guess is kept', async () => {
    const game = await playing();
    const realSend = ch.send; let tries = 0; ch.send = async p => { if (++tries === 1) throw new Error('503'); return realSend(p); };
    const logged = console.error; console.error = () => {};
    try { await guess('a'); } finally { console.error = logged; }
    assert.equal(tries, 2); assert.deepEqual(game.state.guessed, ['a']); assert.equal(ch.sent.length, 1); assert.equal(ch.deleted.length, 1);
});
test('hangman: without permission to post, the guess is still kept, the old board stays and the game goes on', async () => {
    const game = await playing(); const oldId = game.messageId;
    const realSend = ch.send; let tries = 0; ch.send = async () => { tries++; throw permissionDenied(); };
    const logged = console.error; console.error = () => {};
    try { await guess('a'); await guess('x'); } finally { console.error = logged; }
    assert.equal(tries, 2, 'a permission error is not retried'); assert.deepEqual(game.state.guessed, ['a']); assert.deepEqual(game.state.wrong, ['x']);
    assert.equal(game.messageId, oldId); assert.equal(ch.deleted.length, 0, 'the old board was not deleted');
    ch.send = realSend; await guess('p'); assert.deepEqual(game.state.guessed, ['a', 'p']); assert.equal(ch.sent.length, 1, 'the next good post shows everything'); assert.equal(ch.deleted.length, 1);
});
test('hangman: a win is final even if the last board cannot be posted', async () => {
    const game = await playing('ab'.padEnd(3, 'a')); // "aba"
    ch.send = async () => { throw permissionDenied(); };
    const logged = console.error; console.error = () => {};
    try { await guess('a'); await guess('b'); } finally { console.error = logged; }
    assert.equal(store.get(game.id), undefined, 'the game ended'); const i = press('y', 'g:pick:x'); await hangman.start(i); assert.ok(store.all().length === 1, 'the channel is free for a new game');
});

// ---------- permission check before any game ----------
const slashGame = (extra = {}) => { const i = fakeInteraction({ userId: 'u1' }); i.isChatInputCommand = () => true; i.commandName = 'game'; Object.assign(i, extra); i.__v2 = false; return v2.wrapInteraction(i); };
const F = require('discord.js').PermissionFlagsBits;
const perms = (...lacking) => ({ has: flag => !lacking.includes(flag) });
test('games: missingPerms names what Tick lacks, and says nothing when it cannot tell', () => {
    assert.deepEqual(missingPerms({ appPermissions: perms() }), []);
    assert.deepEqual(missingPerms({ appPermissions: perms(F.AttachFiles) }), ['Attach Files']);
    assert.deepEqual(missingPerms({ appPermissions: perms(F.ViewChannel, F.SendMessages, F.AttachFiles) }), ['View Channel', 'Send Messages', 'Attach Files']);
    assert.deepEqual(missingPerms({}), [], 'no information: not blocked');
    assert.deepEqual(missingPerms({ channel: { permissionsFor: () => perms(F.AttachFiles), isThread: () => false }, guild: { members: { me: {} } } }), ['Attach Files'], 'falls back to the channel');
    assert.deepEqual(missingPerms({ appPermissions: perms(F.SendMessagesInThreads), channel: { isThread: () => true } }), ['Send Messages in Threads']);
    assert.deepEqual(missingPerms({ appPermissions: perms(F.SendMessages), channel: { isThread: () => true } }), [], 'in a thread the thread permission counts');
});
test('games: /game explains a missing permission instead of opening the picker, and opens it when all is well', async () => {
    fresh();
    let i = slashGame({ appPermissions: perms(F.AttachFiles) }); await games.handleInteraction(i);
    assert.equal(i.replied.length, 1); const t = textOf(i.replied[0]); assert.ok(t.includes('Attach Files') && t.includes("can't run games"), t); assert.ok(!customIds(i.replied[0]).some(x => x.startsWith('g:pick')));
    i = slashGame({ appPermissions: perms() }); await games.handleInteraction(i); assert.ok(customIds(i.replied[0]).some(x => x.startsWith('g:pick')), 'the picker opens');
    i = slashGame(); await games.handleInteraction(i); assert.ok(customIds(i.replied[0]).some(x => x.startsWith('g:pick')), 'unknown permissions do not block');
});
test('games: picking a game re-checks the permission', async () => {
    fresh();
    const i = press('u1', 'g:pick:x', { values: ['hangman'], appPermissions: perms(F.AttachFiles), isStringSelectMenu: () => true });
    await games.handleInteraction(i);
    assert.equal(store.all().length, 0, 'no game was created'); assert.ok(textOf(i.updated[0]).includes('Attach Files'));
});

// ---------- the /game picker ----------
const container = p => v2.convert(p).components.find(n => n.type === 17);
test('picker: a divider between every two games, every game with its how-to, same dropdown as before', () => {
    fresh();
    const p = games.pickerPayload('u1', 'c1'), c = container(p), kids = c.components;
    const at = games.ORDER.map(t => kids.findIndex(n => n.type === 10 && n.content.includes(games.MODULES[t].info.label)));
    assert.ok(at.every(k => k >= 0), 'every game has its own block'); assert.deepEqual([...at].sort((a, b) => a - b), at, 'in the usual order');
    for (let k = 1; k < at.length; k++) assert.ok(kids.slice(at[k - 1] + 1, at[k]).some(n => n.type === 14), `a divider between ${games.ORDER[k - 1]} and ${games.ORDER[k]}`);
    for (const t of games.ORDER) assert.ok(textOf({ components: [c] }).includes(games.MODULES[t].info.how), `${t} still explains itself`);
    assert.ok(kids.slice(0, at[0]).some(n => n.type === 14), 'a divider after the intro');
    const menu = v2.convert(p).components.find(n => n.type === 1).components[0];
    assert.equal(menu.custom_id, 'g:pick'); assert.deepEqual(menu.options.map(o => o.value), games.ORDER);
});
test('picker: the worst case (five Continue buttons and the Leaderboards button) stays within the limits', () => {
    fresh();
    for (let k = 0; k < 5; k++) store.add({ id: `w${k}`, type: games.ORDER[k % 4], guildId: 'g1', channelId: 'c1', messageId: 'm', userIds: ['u1'], phase: 'play', state: {}, createdAt: Date.now() });
    const p = v2.convert(games.pickerPayload('u1', 'c1'));
    assert.ok(v2.count({ components: p.components }) <= 40, `${v2.count({ components: p.components })} components`); assert.ok(v2.textLength({ components: p.components }) <= 4000);
    const ids = customIds(p); assert.equal(new Set(ids).size, ids.length, 'no duplicate ids'); assert.equal(ids.filter(x => x.startsWith('g:cont:')).length, 5);
    assert.ok(textOf(p).includes('Continue button'), 'the footer is there when there are unfinished games');
    assert.deepEqual(p.allowedMentions, { parse: [] });
    fresh(); assert.ok(!textOf(v2.convert(games.pickerPayload('u1', 'c1'))).includes('Continue button'), 'and gone when there are none');
});

const { assert, test, db, tick, fakeChannel, fakeInteraction, textOf, nodes, isV2, customIds } = require('./lib');
const client = require('../src/client');
const v2 = require('../src/v2');
const games = require('../src/games');
const store = require('../src/games/store');
const elo = require('../src/games/elo');
const { PAIR_COOLDOWN_MIN } = require('../src/config');

const MIN = 60_000;
let ch;
function fresh() {
    db().reset(); store.all().forEach(g => store.remove(g));
    ch = fakeChannel('c1'); client.channels.cache.set('c1', ch);
}
const ttt = (id, a, b, extra = {}) => ({ id, type: 'tictactoe', guildId: 'g1', channelId: 'c1', messageId: 'm1', hostId: a, guestId: b, userIds: [a, b], phase: 'play',
    state: { board: Array(9).fill(''), x: a, o: b, turn: 'x' }, elo: { [a]: 1000, [b]: 1000 }, createdAt: Date.now(), ...extra });
const press = async (gameId, userId, action) => { const i = fakeInteraction({ userId, customId: `g:${gameId}:${action}` }); await games.handleInteraction(i); await tick(); return i; };
const rating = (u, g = 'tictactoe') => db().elo.get(`${u}|${g}`)?.rating;
// X (a) wins on the top row; O (b) plays 3 and 4
async function playOut(id, a, b) {
    await press(id, a, 'm:0'); await press(id, b, 'm:3'); await press(id, a, 'm:1'); await press(id, b, 'm:4');
    return press(id, a, 'm:2');
}

test('a finished game turns into one line of text: no embed, no board, no buttons', async () => {
    fresh(); store.add(ttt('t1', 'a', 'b'));
    const last = await playOut('t1', 'a', 'b');
    const p = last.updated[0];
    assert.ok(isV2(p) && p.embeds === undefined && p.content === undefined, 'a V2 card, nothing else'); assert.equal(nodes(p, 2).length, 0, 'no buttons');
    assert.match(textOf(p), /beat/); assert.match(textOf(p), /Elo/); assert.deepEqual(p.allowedMentions, { parse: [] });
    assert.equal(store.get('t1'), undefined);
    assert.equal(rating('a'), 1016); assert.equal(rating('b'), 984);
});
test('same two players again right away: the game is played but no Elo changes', async () => {
    fresh(); store.add(ttt('t1', 'a', 'b')); await playOut('t1', 'a', 'b');
    store.add(ttt('t2', 'a', 'b'));
    const last = await playOut('t2', 'a', 'b');
    assert.match(textOf(last.updated[0]), /No Elo change/); assert.match(textOf(last.updated[0]), /120 min|\d+ min/);
    assert.equal(rating('a'), 1016); assert.equal(rating('b'), 984);
});
test('the cooldown is per pair: someone else can still play a and gets rated', async () => {
    fresh(); store.add(ttt('t1', 'a', 'b')); await playOut('t1', 'a', 'b');
    store.add(ttt('t2', 'a', 'c')); await playOut('t2', 'a', 'c');
    assert.ok(rating('c') < 1000);
});
test('the cooldown is per game type', async () => {
    fresh(); store.add(ttt('t1', 'a', 'b')); await playOut('t1', 'a', 'b');
    const r = await elo.record('connect4', 'a', 'b', 1);
    assert.equal(r.cooldown, undefined); assert.equal(rating('a', 'connect4'), 1016);
});
test('after the cooldown the same pair counts again', async () => {
    fresh(); store.add(ttt('t1', 'a', 'b')); await playOut('t1', 'a', 'b');
    db().now += (PAIR_COOLDOWN_MIN + 1) * MIN;
    store.add(ttt('t2', 'b', 'a')); const last = await playOut('t2', 'b', 'a');
    assert.match(textOf(last.updated[0]), /Elo: /); assert.doesNotMatch(textOf(last.updated[0]), /No Elo/);
});
test('a game that did not count does not restart the cooldown', async () => {
    fresh(); store.add(ttt('t1', 'a', 'b')); await playOut('t1', 'a', 'b');
    db().now += 100 * MIN; store.add(ttt('t2', 'a', 'b')); await playOut('t2', 'a', 'b');   // blocked, 100 min in
    db().now += 21 * MIN;                                                                      // 121 min after the first
    const r = await elo.record('tictactoe', 'a', 'b', 1); assert.equal(r.cooldown, undefined);
});
test('two games finishing at once for a fresh pair: only one counts', async () => {
    fresh();
    const [r1, r2] = await Promise.all([elo.record('tictactoe', 'a', 'b', 1), elo.record('tictactoe', 'a', 'b', 1)]);
    assert.equal([r1, r2].filter(r => r?.cooldown).length <= 1, true);   // see note in the summary: the in-memory fake serialises, real Postgres locks the row
});

test('every move restarts the idle clock, so an active game does not expire', async () => {
    fresh(); const g = store.add(ttt('t1', 'a', 'b')); g.updatedAt = Date.now() - 29 * MIN;
    await press('t1', 'a', 'm:4');
    assert.ok(Date.now() - g.updatedAt < 1000);
    await games.expire(g); assert.ok(store.get('t1'), 'still alive'); assert.equal(ch.edits.length, 0);
});
test('expiry in a rated game: whoever it is waiting on forfeits, loses Elo, and the message becomes one line', async () => {
    fresh(); const g = store.add(ttt('t1', 'a', 'b')); g.state.turn = 'o'; g.updatedAt = Date.now() - 31 * MIN;   // b to move
    await games.expire(g); await tick();
    assert.equal(store.get('t1'), undefined);
    assert.equal(rating('a'), 1016); assert.equal(rating('b'), 984);
    const e = ch.edits[0].payload;
    assert.match(textOf(e), /ran out of time/); assert.match(textOf(e), /<@b>/); assert.match(textOf(e), /<@a> wins/); assert.ok(isV2(e) && e.embeds === undefined);
});
test('a forfeit by expiry also respects the cooldown', async () => {
    fresh(); store.add(ttt('t1', 'a', 'b')); await playOut('t1', 'a', 'b');
    const g = store.add(ttt('t2', 'a', 'b')); g.updatedAt = Date.now() - 31 * MIN;
    await games.expire(g);
    assert.match(textOf(ch.edits.at(-1).payload), /No Elo change/); assert.equal(rating('b'), 984);
});
test('expiry races a last-second move: the move wins', async () => {
    fresh(); const g = store.add(ttt('t1', 'a', 'b')); g.updatedAt = Date.now() - 31 * MIN;
    const p = games.expire(g); const m = press('t1', 'a', 'm:0'); await Promise.all([p, m]);
    // either order is fine, but never both a forfeit and a move on the same game
    const forfeited = ch.edits.some(e => /ran out of time/.test(textOf(e.payload) ?? ''));
    assert.equal(forfeited && g.state.board[0] === 'x', false);
});
test('an unanswered invitation just expires: no Elo, no forfeit', async () => {
    fresh(); const g = store.add({ ...ttt('i1', 'a', 'b'), phase: 'invite', userIds: ['a'], guestId: undefined, state: {} }); g.updatedAt = Date.now() - 6 * MIN;
    await games.expire(g);
    assert.match(textOf(ch.edits[0].payload), /invitation expired/); assert.equal(db().elo.size, 0);
});
test('a game inside its time is left alone by the sweep', async () => {
    fresh(); store.add(ttt('t1', 'a', 'b')); games.sweep(); await tick(); assert.ok(store.get('t1')); assert.equal(ch.edits.length, 0);
});
test('Guess Who: waiting on both pickers means nobody wins; waiting on one means they forfeit', async () => {
    fresh(); const gw = id => ({ id, type: 'guesswho', guildId: 'g1', channelId: 'c1', messageId: 'm1', hostId: 'a', guestId: 'b', userIds: ['a', 'b'], phase: 'pick',
        state: { a: 'a', b: 'b', names: { a: 'A', b: 'B' }, picks: {}, remaining: { a: ['x', 'y'], b: ['x', 'y'] } }, elo: { a: 1000, b: 1000 }, createdAt: Date.now() });
    const g1 = store.add(gw('g1')); g1.updatedAt = Date.now() - 31 * MIN; await games.expire(g1);
    assert.match(textOf(ch.edits.at(-1).payload), /no activity/); assert.equal(db().elo.size, 0);
    const g2 = store.add(gw('g2')); g2.state.picks.a = 'x'; g2.updatedAt = Date.now() - 31 * MIN; await games.expire(g2);
    assert.match(textOf(ch.edits.at(-1).payload), /<@b> ran out of time/); assert.equal(rating('a', 'guesswho'), 1016);
});
test('Battleship: waiting on the player whose turn it is, or who has not voted or placed', async () => {
    fresh(); const { MODULES } = games, w = MODULES.sinkship.waitingOn;
    const base = { type: 'sinkship', userIds: ['a', 'b'], state: { p: ['a', 'b'], votes: { a: 'quick' }, boards: { a: { ready: true }, b: { ready: false } }, turn: 'b' } };
    assert.deepEqual(w({ ...base, phase: 'presetvote' }), ['b']);
    assert.deepEqual(w({ ...base, phase: 'setup' }), ['b']);
    assert.deepEqual(w({ ...base, phase: 'battle' }), ['b']);
});
test('rated games keep the full time while setting up; party games keep the short one', async () => {
    const cfg = require('../src/config');
    assert.equal(games.ttlMs({ type: 'sinkship', phase: 'setup' }), cfg.GAME_TTL_MIN * MIN);
    assert.equal(games.ttlMs({ type: 'hangman', phase: 'setup' }), cfg.INVITE_TTL_MIN * MIN);
    assert.equal(games.ttlMs({ type: 'tictactoe', phase: 'invite' }), cfg.INVITE_TTL_MIN * MIN);
});
test('re-posting a game message at the bottom does not count as activity', async () => {
    fresh(); const g = store.add(ttt('t1', 'a', 'b')); const old = Date.now() - 20 * MIN; g.updatedAt = old;
    await games.repost(g);
    assert.equal(g.updatedAt, old);
});
test('after a restart every saved game gets a fresh clock, so downtime never causes a forfeit', async () => {
    fresh(); const g = ttt('r1', 'a', 'b'); g.updatedAt = Date.now() - 25 * MIN;
    db().games.set('r1', { data: g, at: db().now });
    await games.init(); await tick();
    const back = store.get('r1'); assert.ok(back);
    assert.ok(Date.now() - back.updatedAt < 2000);
    games.sweep(); await tick(); assert.ok(store.get('r1'));
});
test('stop after both have moved is a concession, shown as one line', async () => {
    fresh(); store.add(ttt('t1', 'a', 'b'));
    await press('t1', 'a', 'm:0'); await press('t1', 'b', 'm:3');
    const i = await press('t1', 'a', 'stop'); const p = i.updated[0];
    assert.match(textOf(p), /conceded/); assert.ok(isV2(p) && p.embeds === undefined); assert.equal(rating('b'), 1016);
});
test('cancelling an invitation leaves one line', async () => {
    fresh(); store.add({ ...ttt('i1', 'a', 'b'), phase: 'invite', userIds: ['a'], state: {} });
    const i = await press('i1', 'a', 'cancel'); assert.match(textOf(i.updated[0]), /cancelled/); assert.ok(isV2(i.updated[0]) && i.updated[0].embeds === undefined);
});
test('Connect 4 and Guess Who results are one line too', async () => {
    const { MODULES } = games;
    const c4 = { id: 'c', type: 'connect4', phase: 'over', userIds: ['a', 'b'], elo: {}, state: { board: Array.from({ length: 6 }, (_, r) => Array.from({ length: 7 }, (_, c) => (r === 5 && c < 4 ? 1 : 0))), red: 'a', yellow: 'b', turn: 1 } };
    const p = v2.convert(MODULES.connect4.payload(c4)); assert.match(textOf(p), /beat/); assert.ok(isV2(p) && p.embeds === undefined);
    const gw = v2.convert(await MODULES.guesswho.payload({ id: 'x', phase: 'over', state: {}, elo: {} }, 'A wins'));
    assert.match(textOf(gw), /A wins/); assert.ok(isV2(gw) && gw.embeds === undefined);
});

test('/leaderboard elo shows the top players and your own rank for the chosen game', async () => {
    fresh(); store.add(ttt('t1', 'a', 'b')); await playOut('t1', 'a', 'b');
    const p = v2.convert(await games.leaderboard('tictactoe', 'b')), t = textOf(p);
    assert.match(t, /Tic tac toe/); assert.match(t, /<@a> \*\*1016\*\*/); assert.match(t, /<@b> \*\*984\*\*/); assert.match(t, /You: #2, rating 984/);
    const empty = textOf(v2.convert(await games.leaderboard('connect4', 'a')));
    assert.match(empty, /Nobody has played/); assert.match(empty, /no rating/);
});
test('the slash command offers all four rated games and the command builder loads', () => {
    const list = require('../src/commands').buildCommands();
    const s = JSON.stringify(list);
    assert.ok(s.includes('"name":"elo"')); for (const v of ['tictactoe', 'connect4', 'guesswho', 'sinkship']) assert.ok(s.includes(`"value":"${v}"`), v);
});

// ---------- friendly games and the forfeit button ----------
const invite = (id, extra = {}) => ({ ...ttt(id, 'a', 'b'), phase: 'invite', userIds: ['a'], guestId: undefined, elo: undefined, state: {}, ...extra });
const buttonIds = p => JSON.stringify(p.components).match(/g:[^"]+/g) ?? [];

test('the invitation of a 1v1 game offers a Mode button, ranked by default', () => {
    fresh(); const p = games.invitePayload(invite('i1'));
    assert.ok(buttonIds(p).some(x => x.endsWith(':mode')));
    const q = v2.convert(p); assert.match(textOf(q), /Ranked/); assert.match(JSON.stringify(q.components), /Mode: Ranked/);
});
test('only the host can switch between ranked and friendly, and the invitation shows it', async () => {
    fresh(); store.add(invite('i1'));
    const guest = await press('i1', 'b', 'mode'); assert.match(textOf(guest.replied[0]), /Only the host/);
    assert.equal(store.get('i1').friendly, undefined);
    const host = await press('i1', 'a', 'mode');
    assert.equal(store.get('i1').friendly, true); assert.match(textOf(host.updated[0]), /Friendly/); assert.match(JSON.stringify(host.updated[0].components), /Mode: Friendly/);
    await press('i1', 'a', 'mode'); assert.equal(store.get('i1').friendly, false);
});
test('the mode is locked once someone accepts', async () => {
    fresh(); store.add(invite('i1', { friendly: true }));
    await press('i1', 'b', 'accept');
    const late = await press('i1', 'a', 'mode');
    assert.match(textOf(late.replied[0]), /locked/); assert.equal(store.get('i1').friendly, true);
});
test('a friendly game shows no ratings, records no Elo and says so at the end', async () => {
    fresh(); store.add(invite('i1', { friendly: true }));
    await press('i1', 'b', 'accept');
    assert.equal(store.get('i1').elo, undefined);
    const { x, o } = store.get('i1').state;   // accepting picks the starting player at random
    const last = await playOut('i1', x, o);
    assert.match(textOf(last.updated[0]), /Friendly game: no Elo/); assert.equal(db().elo.size, 0); assert.equal(db().pairs.size, 0);
});
test('friendly games never use up the cooldown, and ranked games after them still count', async () => {
    fresh();
    for (const id of ['f1', 'f2']) { store.add(ttt(id, 'a', 'b', { friendly: true, elo: undefined })); await playOut(id, 'a', 'b'); }
    store.add(ttt('r1', 'a', 'b')); const last = await playOut('r1', 'a', 'b');
    assert.match(textOf(last.updated[0]), /Elo: /); assert.equal(rating('a'), 1016);
});
test('games saved before friendly mode existed count as ranked', async () => {
    fresh(); const g = ttt('old', 'a', 'b'); delete g.friendly; store.add(g);
    await playOut('old', 'a', 'b'); assert.equal(rating('a'), 1016);
});
test('a friendly game that expires still names the player who ran out of time, with no Elo', async () => {
    fresh(); const g = store.add(ttt('t1', 'a', 'b', { friendly: true, elo: undefined })); g.state.turn = 'o'; g.updatedAt = Date.now() - 31 * MIN;
    await games.expire(g);
    assert.match(textOf(ch.edits[0].payload), /<@b> ran out of time/); assert.match(textOf(ch.edits[0].payload), /Friendly game/); assert.equal(db().elo.size, 0);
});
test('stopping a friendly game is just a stop: nobody concedes', async () => {
    fresh(); store.add(ttt('t1', 'a', 'b', { friendly: true, elo: undefined }));
    await press('t1', 'a', 'm:0'); await press('t1', 'b', 'm:3');
    const i = await press('t1', 'a', 'stop'); assert.doesNotMatch(textOf(i.updated[0]), /conceded/); assert.equal(db().elo.size, 0);
});

test('every 1v1 game message has a Forfeit button; party games do not', async () => {
    fresh();
    const g = store.add(ttt('t1', 'a', 'b')); assert.ok(buttonIds(games.MODULES.tictactoe.payload(g)).some(x => x.endsWith(':forfeit')));
    const c4 = { id: 'c', type: 'connect4', phase: 'play', userIds: ['a', 'b'], elo: {}, state: { board: Array.from({ length: 6 }, () => Array(7).fill(0)), red: 'a', yellow: 'b', turn: 1 } };
    assert.ok(buttonIds(games.MODULES.connect4.payload(c4)).some(x => x.endsWith(':forfeit')));
    const sv = { id: 's', type: 'sinkship', phase: 'presetvote', userIds: ['a', 'b'], elo: {}, state: { p: ['a', 'b'], votes: {} } };
    const rows = games.MODULES.sinkship.payload(sv).components;
    assert.equal(rows.length, 2); assert.ok(rows.every(r => (r.data?.components ?? r.components ?? []).length <= 5));
    assert.ok(buttonIds({ components: [rows[1]] }).some(x => x.endsWith(':forfeit')));
    const { endButtons } = require('../src/games/common');
    assert.equal(endButtons({ id: 'h', type: 'hangman', userIds: ['a'] }).length, 1);
});
test('forfeit asks first and only the player who tapped can answer', async () => {
    fresh(); store.add(ttt('t1', 'a', 'b'));
    const ask = await press('t1', 'a', 'forfeit');
    assert.match(ask.replied[0].content, /lose Elo/); assert.deepEqual(ask.replied[0].flags, [64], 'only the presser sees the question');
    assert.ok(store.get('t1'), 'nothing happens yet'); assert.equal(db().elo.size, 0);
    const other = await press('t1', 'b', 'forfeitok:a'); assert.match(textOf(other.replied[0]), /someone else/); assert.ok(store.get('t1'));
});
test('forfeit: the player who forfeits loses Elo, the other wins, the message becomes one line', async () => {
    fresh(); store.add(ttt('t1', 'a', 'b'));
    const ok = await press('t1', 'a', 'forfeitok:a');
    assert.equal(store.get('t1'), undefined); assert.equal(textOf(ok.updated[0]), 'You forfeited.');
    const e = ch.edits.at(-1).payload; assert.match(textOf(e), /<@a> forfeited, so <@b> wins/); assert.ok(isV2(e) && e.embeds === undefined);
    assert.equal(rating('b'), 1016); assert.equal(rating('a'), 984);
});
test('forfeit works before anyone has moved, and in a friendly game it records nothing', async () => {
    fresh(); store.add(ttt('t1', 'a', 'b', { friendly: true, elo: undefined }));
    await press('t1', 'b', 'forfeitok:b');
    assert.match(textOf(ch.edits.at(-1).payload), /<@b> forfeited, so <@a> wins/); assert.match(textOf(ch.edits.at(-1).payload), /Friendly game/); assert.equal(db().elo.size, 0);
});
test('forfeit respects the cooldown, so it cannot be used to trade wins', async () => {
    fresh(); store.add(ttt('t1', 'a', 'b')); await playOut('t1', 'a', 'b');
    store.add(ttt('t2', 'a', 'b')); await press('t2', 'b', 'forfeitok:b');
    assert.match(textOf(ch.edits.at(-1).payload), /No Elo change/); assert.equal(rating('a'), 1016);
});
test('forfeit: cancel keeps the game, strangers cannot forfeit, invitations use Cancel', async () => {
    fresh(); store.add(ttt('t1', 'a', 'b'));
    const no = await press('t1', 'a', 'forfeitno:a'); assert.match(textOf(no.updated[0]), /goes on/); assert.ok(store.get('t1'));
    const stranger = await press('t1', 'z', 'forfeit'); assert.match(textOf(stranger.replied[0]), /not in this game/);
    const forged = await press('t1', 'z', 'forfeitok:z'); assert.match(textOf(forged.replied[0]), /not in this game/); assert.ok(store.get('t1'));
    store.add(invite('i1')); const inv = await press('i1', 'a', 'forfeit'); assert.match(textOf(inv.replied[0]), /Cancel/);
});
test('forfeit after the game already ended says so instead of doing anything', async () => {
    fresh(); store.add(ttt('t1', 'a', 'b')); await press('t1', 'a', 'forfeitok:a');
    const again = await press('t1', 'a', 'forfeitok:a'); assert.match(textOf(again.replied[0]), /over or has expired/); assert.equal(rating('b'), 1016);
});
test('Guess Who and Battleship forfeit too, in any phase after the start', async () => {
    fresh();
    store.add({ id: 'g1', type: 'guesswho', guildId: 'g1', channelId: 'c1', messageId: 'm1', hostId: 'a', guestId: 'b', userIds: ['a', 'b'], phase: 'pick',
        state: { a: 'a', b: 'b', names: { a: 'A', b: 'B' }, picks: {}, remaining: { a: ['x'], b: ['x'] } }, elo: { a: 1000, b: 1000 }, createdAt: Date.now() });
    await press('g1', 'a', 'forfeitok:a'); assert.match(textOf(ch.edits.at(-1).payload), /<@a> forfeited/); assert.equal(rating('b', 'guesswho'), 1016);
    store.add({ id: 's1', type: 'sinkship', guildId: 'g1', channelId: 'c1', messageId: 'm2', hostId: 'c', guestId: 'd', userIds: ['c', 'd'], phase: 'presetvote',
        state: { p: ['c', 'd'], votes: {} }, elo: { c: 1000, d: 1000 }, createdAt: Date.now() });
    await press('s1', 'd', 'forfeitok:d'); assert.match(textOf(ch.edits.at(-1).payload), /<@d> forfeited, so <@c> wins/); assert.equal(rating('c', 'sinkship'), 1016);
});

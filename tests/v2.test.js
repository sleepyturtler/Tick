// Components V2: the layout of the screens designed in Discohook, the shared style of every other message, and the Discord limits.
const { assert, test, db, tick, fakeChannel, fakeInteraction, fakeMessage, textOf, nodes, isV2, customIds } = require('./lib');
const v2 = require('../src/v2');
const help = require('../src/help');
const ui = require('../src/ui');
const client = require('../src/client');
const games = require('../src/games');
const store = require('../src/games/store');
const state = require('../src/state');
const { handleCount, register } = require('../src/handlers/messages');

const GREEN = 0x22CE60, STATS = 0x24E066, ENEMY = 0xA71E10, FLEET = 0x3498DB;
const types = c => c.components.map(n => n.type);
const allIds = p => { const ids = []; const walk = n => { if (!n) return; if (typeof n.toJSON === 'function') n = n.toJSON(); if (n.custom_id) ids.push(n.custom_id); (n.components ?? []).forEach(walk); if (n.accessory) walk(n.accessory); }; (p.components ?? []).forEach(walk); return ids; };
const withinLimits = (p, label = '') => {
    const ids = allIds(p); assert.equal(new Set(ids).size, ids.length, `${label} has a duplicate custom_id: ${ids.filter((x, i) => ids.indexOf(x) !== i)}`);
    const all = { components: p.components };
    assert.ok(v2.count(all) <= 40, `${label} has ${v2.count(all)} components`);
    assert.ok(v2.textLength(all) <= 4000, `${label} has ${v2.textLength(all)} characters`);
    assert.ok(isV2(p) && p.embeds === undefined && p.content === undefined, `${label} is a clean V2 payload`);
    assert.deepEqual(p.allowedMentions, { parse: [] }, `${label} pings nobody`);
};

// ---------- the shared style ----------
test('an old-style embed becomes a green container: ### title, dividers, bold labels, -# footer', () => {
    const p = v2.convert({ embeds: [v2.E('#5865F2', '\u{1F4CA} Stats \u2014 Me').setDescription('hello').addFields({ name: '\u2705 Correct', value: '**58**' }, { name: 'Rules', value: 'a\nb' }).setFooter({ text: 'Page 1/2' })], components: [] });
    const c = p.components[0];
    assert.equal(c.type, 17); assert.equal(c.accent_color, GREEN);
    assert.deepEqual(c.components.map(n => n.content ?? '---'), ['### Stats - Me', '---', 'hello', '---', '\u2705 **Correct:** 58', '---', '**Rules**\na\nb', '---', '-# Page 1/2']);
    withinLimits(p);
});
test('flags: ephemeral stays, V2 is added; plain messages and ready-made V2 payloads are left alone', () => {
    const p = v2.convert({ embeds: [v2.E('#fff', 'x').setDescription('y')], flags: [64] });
    assert.equal(p.flags & 64, 64); assert.equal(p.flags & 32768, 32768);
    const plain = { content: 'No permission.', flags: [64] };
    assert.equal(v2.convert(plain), plain);
    const ready = { components: [], flags: 32768 }; assert.equal(v2.convert(ready).flags, 32768);
});
test('the colour an embed asks for is ignored: everything is the default green unless a screen sets its own', () => {
    for (const color of ['#ff4444', '#00cc88', '#9b59b6', '#888888']) assert.equal(v2.convert({ embeds: [v2.E(color, 't').setDescription('d')] }).components[0].accent_color, GREEN);
});
test('a long message is trimmed to the component and character limits instead of failing', () => {
    const e = v2.E('c', 'Big'); for (let i = 0; i < 30; i++) e.addFields({ name: `Field ${i}`, value: 'x'.repeat(300) });
    const p = v2.convert({ embeds: [e], components: [new (require('discord.js').ActionRowBuilder)().addComponents(...Array.from({ length: 5 }, (_, i) => new (require('discord.js').ButtonBuilder)().setCustomId(`b${i}`).setLabel('b').setStyle(2)))] });
    withinLimits(p, 'oversized card');
});
test('every settings and help screen fits the limits', async () => {
    const g = await state.getGuild('g1'); Object.assign(g, { failRoleId: 'r1', accessRoleId: 'r2', playerCount: true });
    state.chanCache.clear(); for (const id of ['c1', 'c2', 'c3']) { const c = state.defaultChannel('g1', id, 'interactive'); state.chanCache.set(id, c); }
    withinLimits(v2.convert(ui.buildChannelsPanel('g1')), 'channels panel');
    for (const t of help.TOPICS) withinLimits(v2.convert(help.buildHelpPage(t.id)), `help ${t.id}`);
});

// ---------- 1. user stats ----------
test('user stats: title with the avatar beside it, five stat lines with dividers, then the two tab buttons', async () => {
    db().reset(); db().userStats.set('g1|u1', { correct: 58, ruined: 10, savesUsed: 0 });
    const user = { id: 'u1', username: 'sleepyturtles', displayAvatarURL: () => 'https://cdn.example/av.png' };
    const p = v2.convert({ embeds: [await ui.buildUserStatsEmbed('g1', user)], components: [ui.statsRow('u1', 'g1', 'user')] });
    const c = p.components[0];
    assert.equal(c.accent_color, STATS);
    assert.deepEqual(c.components[0], { type: 9, components: [{ type: 10, content: '### Stats - sleepyturtles' }], accessory: { type: 11, media: { url: 'https://cdn.example/av.png' } } });
    assert.deepEqual(c.components.filter(n => n.type === 10).map(n => n.content), ['\u2705 **Correct:** 58', '\u{1F4A5} **Ruined:** 10', '\u{1F3AF} **Accuracy:** 85%', '\u{1F947} **Rank:** #1', '\u{1F6E1}\uFE0F **Saves used:** 0']);
    assert.deepEqual(types(c), [9, 14, 10, 14, 10, 14, 10, 14, 10, 14, 10]);
    const [user_, server] = p.components[1].components;
    assert.deepEqual([user_.label, user_.style, server.label, server.style], ['User Stats', 1, 'Server Stats', 2]);
    withinLimits(p, 'user stats');
});

// ---------- 2. global leaderboard ----------
test('global leaderboard: title, 25 rows, page footer, then Users/Modes tabs and the page buttons', async () => {
    db().reset(); db().globalUsers = Array.from({ length: 260 }, (_, i) => ({ user_id: String(1000 + i), correct: String(1049 - i), ruined: '3' }));
    const { embed, totalPages } = await ui.buildGlobalUsersEmbed(1);
    assert.equal(totalPages, 11);
    const p = v2.convert({ embeds: [embed], components: [...ui.globalTabRows('gu'), ui.paginationRow('gu', '', 1, totalPages)] });
    const c = p.components[0], t = c.components.filter(n => n.type === 10).map(n => n.content);
    assert.equal(c.accent_color, STATS);
    assert.equal(t[0], '### Global Leaderboard - Users');
    const rows = t[1].split('\n'); assert.equal(rows.length, 25);
    assert.match(rows[0], /^\u{1F947} <@1000> \(@user1000\) \u2014 1049 counts$/u); assert.match(rows[3], /^4\. /); assert.match(rows[24], /^25\. /);
    assert.equal(t[2], '-# **Page 1/11 \u00b7 1\u201325 of 260 users**');
    const [tabs, pager] = p.components.slice(1).map(r => r.components);
    assert.deepEqual(tabs.map(b => [b.label, b.style]), [['Users', 1], ['Modes', 2]]);
    assert.deepEqual(pager.map(b => [b.label, b.disabled ?? false]), [['\u25c0', true], ['1/11', true], ['\u25b6', false], ['\u21ba', false]]);
    withinLimits(p, 'global leaderboard');
});
test('global leaderboard: opening Modes adds the mode row and makes Modes the active tab', () => {
    const rows = ui.globalTabRows('gs_countdown').map(r => r.toJSON().components);
    assert.deepEqual(rows[0].map(b => [b.label, b.style]), [['Users', 2], ['Modes', 1]]);
    assert.deepEqual(rows[1].map(b => b.custom_id), ['lbt_gs_interactive', 'lbt_gs_simple', 'lbt_gs_countdown', 'lbt_gs_modifiers', 'lbt_gs_floors']);
    assert.equal(rows[1][2].style, 1);
    assert.equal(ui.globalTabRows('gu').length, 1);
});

// ---------- 3. tic tac toe ----------
const ttt = (extra = {}) => ({ id: 't1', type: 'tictactoe', guildId: 'g1', channelId: 'c1', messageId: 'm1', hostId: 'a', guestId: 'b', userIds: ['a', 'b'], phase: 'play',
    state: { board: Array(9).fill(''), x: 'a', o: 'b', turn: 'x' }, elo: { a: 1000, b: 1000 }, createdAt: Date.now(), ...extra });
test('tic tac toe: title, players with Elo, who plays next, the board picture, three rows of numbers, Stop Game and Forfeit', () => {
    const p = v2.convert(games.MODULES.tictactoe.payload(ttt()));
    const c = p.components[0];
    assert.equal(c.accent_color, GREEN);
    assert.deepEqual(c.components.filter(n => n.type === 10).map(n => n.content), ['### Tic-Tac-Toe', '\u274C <@a> (1000) **vs** \u2B55 <@b> (1000)', '\u274C <@a> plays next']);
    assert.deepEqual(types(c), [10, 14, 10, 14, 10, 12]);
    assert.deepEqual(c.components[5], { type: 12, items: [{ media: { url: 'attachment://board.png' } }] });
    const rows = p.components.slice(1).map(r => r.components);
    assert.deepEqual(rows.slice(0, 3).map(r => r.map(b => b.label)), [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']]);
    assert.deepEqual(rows[3].map(b => [b.label, b.style, b.custom_id.split(':')[2]]), [['Stop Game', 4, 'stop'], ['Forfeit', 4, 'forfeit']]);
    assert.equal(p.files.length, 1);
    withinLimits(p, 'tic tac toe');
});
test('tic tac toe: taken squares are disabled and a friendly game shows no ratings', () => {
    const g = ttt({ friendly: true, elo: undefined }); g.state.board[4] = 'x'; g.state.turn = 'o';
    const p = v2.convert(games.MODULES.tictactoe.payload(g));
    assert.match(textOf(p), /\u274C <@a> \*\*vs\*\* \u2B55 <@b>/); assert.match(textOf(p), /\u2B55 <@b> plays next/);
    const five = nodes(p, 2).find(b => b.custom_id.endsWith(':m:4')); assert.equal(five.label, 'X'); assert.equal(five.disabled, true);
});

// ---------- 4. Battleship ----------
const sink = (phase, extra = {}) => {
    const ships = [{ x: 0, y: 0, dir: 'H' }, { x: 0, y: 2, dir: 'H' }, { x: 0, y: 4, dir: 'H' }];
    const board = ready => ({ ships, ready, shots: {}, prefire: null });
    return { id: 's1', type: 'sinkship', guildId: 'g1', channelId: 'c1', messageId: 'm1', hostId: 'a', guestId: 'b', userIds: ['a', 'b'], phase, elo: { a: 1000, b: 1000 },
        state: { p: ['a', 'b'], names: { a: 'A', b: 'B' }, votes: {}, preset: 'quick', size: 6, lens: [3, 2, 1], boards: { a: board(phase === 'battle'), b: board(phase === 'battle') }, selected: {}, turn: 'a', log: [], winner: null, ...extra } };
};
test('Battleship in battle: red Enemy Waters card, blue Your fleet card, then Fire, Refresh and Forfeit', () => {
    const p = v2.convert(games.MODULES.sinkship.viewFor(sink('battle'), 'a'));
    const [enemy, fleet] = p.components;
    assert.equal(enemy.accent_color, ENEMY); assert.equal(fleet.accent_color, FLEET);
    assert.equal(enemy.components[0].content, '### Enemy Waters (0/3 Sunk)'); assert.equal(fleet.components[0].content, '### Your fleet');
    assert.match(enemy.components[2].content, /Your turn\.\*\* Press \*\*Fire\*\* and type a square like `b7`\. A hit lets you shoot again\./);
    assert.equal(fleet.components[2].content, 'Ships placed: 3/3 | Your ships sunk: 0/3');
    assert.deepEqual(enemy.components.at(-1), { type: 12, items: [{ media: { url: 'attachment://enemy.png' } }] });
    assert.deepEqual(fleet.components.at(-1), { type: 12, items: [{ media: { url: 'attachment://own.png' } }] });
    assert.deepEqual(p.components[2].components.map(b => [b.label, b.style]), [['Fire', 4], ['Refresh', 2], ['Forfeit', 4]]);
    assert.equal(p.files.length, 2);
    withinLimits(p, 'battleship');
});
test('Battleship while waiting for the opponent: line up a shot, refresh, forfeit', () => {
    const g = sink('battle'); g.state.turn = 'b';
    const p = v2.convert(games.MODULES.sinkship.viewFor(g, 'a'));
    assert.deepEqual(p.components[2].components.map(b => b.label), ['Line up shot', 'Refresh', 'Forfeit']);
});
test('Battleship while placing ships: only your own board, the placement controls and Forfeit', () => {
    const p = v2.convert(games.MODULES.sinkship.viewFor(sink('setup'), 'a'));
    const cards = p.components.filter(n => n.type === 17);
    assert.equal(cards.length, 1); assert.equal(cards[0].accent_color, FLEET); assert.equal(cards[0].components[0].content, '### Your fleet');
    assert.ok(!textOf(p).includes('Enemy Waters'));
    assert.equal(p.files.length, 1, 'only the own board is drawn and attached');
    assert.ok(!JSON.stringify(p.components).includes('enemy.png'));
    const ids = customIds(p).map(i => i.split(':')[2]); for (const want of ['ship', 'place', 'random', 'clear', 'ready', 'forfeit']) assert.ok(ids.includes(want), want);
    withinLimits(p, 'battleship placing');
});
test('Battleship: a player who is ready still sees only their fleet, with Refresh and Forfeit', () => {
    const g = sink('setup'); g.state.boards.a.ready = true;
    const p = v2.convert(games.MODULES.sinkship.viewFor(g, 'a'));
    assert.equal(p.components.filter(n => n.type === 17).length, 1);
    assert.deepEqual(customIds(p).map(i => i.split(':')[2]), ['refresh', 'forfeit']);
});
test('Battleship private views are edited with V2 payloads too', async () => {
    const g = sink('battle'), seen = [];
    const ref = fakeInteraction({ userId: 'a', customId: 'x' }); ref.webhook = { editMessage: async (id, body) => { seen.push(body); } };
    ref.fetchReply = async () => ({ id: 'eph1' });
    await ref.reply(games.MODULES.sinkship.viewFor(g, 'a')); assert.ok(isV2(ref.replied[0]));
});

// ---------- 5. Save Earned ----------
test('Save Earned: green card, title, the earned line and the count, then the next milestone', async () => {
    db().reset(); state.chanCache.clear(); state.loadedGuilds.clear(); register();
    const g = await state.getGuild('g1'); Object.assign(g, { allowExpressions: true, maxStreak: 0, antiCheat: true, saves: 0 });
    const c = state.defaultChannel('g1', 'c1', 'interactive'); c.current = 249; state.chanCache.set('c1', c);
    const ch = fakeChannel('c1'); const m = fakeMessage({ content: '250', channel: ch }); await handleCount(m); await tick();
    const sent = ch.sent.map(s => s.payload).find(p => /Save Earned/.test(textOf(p)));
    assert.ok(sent, 'a Save Earned card was sent'); withinLimits(sent, 'save earned');
    const card = sent.components[0];
    assert.equal(card.accent_color, GREEN);
    assert.deepEqual(card.components.map(n => n.content ?? '---'), ['### Save Earned!', '---', 'The server earned a Save for reaching 250!\nThe server now has 1/5 save(s).', '---', 'Next save at 500.']);
});
test('milestone, ruin and notice messages in the counting channel are all V2 cards', async () => {
    db().reset(); state.chanCache.clear(); state.loadedGuilds.clear();
    const g = await state.getGuild('g1'); Object.assign(g, { allowExpressions: false, maxStreak: 0, antiCheat: true });
    const c = state.defaultChannel('g1', 'c1', 'interactive'); c.current = 99; state.chanCache.set('c1', c);
    const ch = fakeChannel('c1');
    await handleCount(fakeMessage({ content: '100', channel: ch })); await handleCount(fakeMessage({ content: '1+1', userId: 'u2', channel: ch })); await handleCount(fakeMessage({ content: '5', userId: 'u3', channel: ch })); await tick(20);
    assert.ok(ch.sent.length >= 2);
    for (const s of ch.sent) withinLimits(s.payload, `counting message ${textOf(s.payload).slice(0, 25)}`);
});

// ---------- other game screens ----------
test('the party games and invitations are V2 and fit: Impostor vote with 25 players, lobby, picker, invitation', () => {
    const players = Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, name: `Player number ${i}`.padEnd(30, 'x'), role: i === 0 ? 'impostor' : 'crew', alive: true }));
    const g = { id: 'i1', type: 'impostor', phase: 'vote', hostId: 'p0', userIds: players.map(p => p.id), state: { players, names: {}, votes: {}, round: 1, endsAt: Date.now() + 60000, settings: { impostors: 1, clue: 'category' }, log: '' } };
    const p = v2.convert(games.MODULES.impostor.payload(g)); withinLimits(p, 'impostor vote');
    assert.equal(nodes(p, 2).length, 25);
    withinLimits(v2.convert(games.invitePayload({ id: 'x', type: 'tictactoe', hostId: 'a', phase: 'invite', userIds: ['a'] })), 'invitation');
    withinLimits(v2.convert(games.pickerPayload('u1', 'c1')), 'picker');
});

// ---------- old messages and deploys ----------
test('a button on a message from before the V2 update is answered with a pointer, not an edit', () => {
    const old = { isMessageComponent: () => true, message: { embeds: [{}], flags: { bitfield: 0 } } };
    assert.equal(v2.isOutdated(old), true);
    assert.equal(v2.isOutdated({ ...old, message: { embeds: [], flags: { bitfield: 32768 } } }), false, 'a V2 message is current');
    assert.equal(v2.isOutdated({ ...old, message: { embeds: [], flags: { bitfield: 0 } } }), false, 'our plain confirmation messages are current');
    assert.equal(v2.isOutdated({ isMessageComponent: () => false, message: null }), false);
});
test('editing a V2 message with plain text turns the text into a V2 card instead of failing', async () => {
    const i = fakeInteraction({ userId: 'a', customId: 'x' }); i.message = { id: 'm', flags: { bitfield: 32768 } }; i.__v2 = false;
    const w = v2.wrapInteraction(Object.assign(fakeInteraction({ userId: 'a', customId: 'x' }), { message: { id: 'm', flags: { bitfield: 32768 } } }));
    // the helper above already wrapped once with a plain message; wrap a fresh object that is attached to a V2 message
    const raw = { user: { id: 'a' }, message: { id: 'm', flags: { bitfield: 32768 } }, sent: [], editReply: async function (p) { this.sent.push(p); } };
    v2.wrapInteraction(raw); await raw.editReply({ content: 'Failed to load stats.' });
    assert.ok(isV2(raw.sent[0]) && raw.sent[0].content === undefined); assert.match(textOf(raw.sent[0]), /Failed to load stats/);
});
test('after a deploy every saved game is re-posted as a new V2 message and the old one is deleted', async () => {
    db().reset(); store.all().forEach(g => store.remove(g));
    const ch = fakeChannel('c1'); client.channels.cache.set('c1', ch);
    const g = ttt(); g.updatedAt = Date.now() - 5 * 60_000; db().games.set('t1', { data: g, at: db().now });
    await games.init(); await tick();
    assert.equal(ch.sent.length, 1); assert.ok(isV2(ch.sent[0].payload)); assert.match(textOf(ch.sent[0].payload), /Tic-Tac-Toe/);
    assert.deepEqual(ch.deleted, ['m1']); assert.equal(store.get('t1').messageId, ch.sent[0].id);
    assert.ok(Date.now() - store.get('t1').updatedAt < 2000, 'restart gave a fresh timer');
});
test('Guess Who fits the limits in both phases, with 30 characters left each', async () => {
    const { NAMES } = games.MODULES.guesswho;
    const g = phase => ({ id: 'w1', type: 'guesswho', phase, hostId: 'a', guestId: 'b', userIds: ['a', 'b'], elo: { a: 1000, b: 1000 },
        state: { a: 'a', b: 'b', names: { a: 'Alice', b: 'Bob' }, picks: phase === 'play' ? { a: NAMES[0], b: NAMES[1] } : {}, remaining: { a: [...NAMES], b: [...NAMES] }, turn: 'a' } });
    for (const phase of ['pick', 'play']) {
        const p = v2.convert(await games.MODULES.guesswho.payload(g(phase))); withinLimits(p, `guess who ${phase}`);
        assert.equal(p.components.filter(n => n.type === 17).length, 2, 'one card per board');
    }
    const done = v2.convert(await games.MODULES.guesswho.payload({ ...g('over') }, 'Alice wins'));
    assert.match(textOf(done), /Alice wins/);
});


// ---------- leaderboard Modes tab, end to end ----------
const { register: registerInteractions } = require('../src/handlers/interactions');
let wired = false;
async function press(customId, extra = {}) {
    if (!wired) { registerInteractions(); wired = true; }
    db().reset();
    const i = fakeInteraction({ userId: 'u1', customId });
    Object.assign(i, { guildId: 'g1', isButton: () => true, isMessageComponent: () => true, isChatInputCommand: () => false, isStringSelectMenu: () => false, isRoleSelectMenu: () => false, isChannelSelectMenu: () => false, isModalSubmit: () => false, isAutocomplete: () => false, edits: [],
        message: { id: 'm', embeds: [], flags: { bitfield: 32768 } }, ...extra });
    // the real entry point wraps the interaction, so the collector goes in underneath it and sees what Discord would receive
    const edits = []; i.editReply = async p => { edits.push(p); }; i.deferUpdate = async () => {}; i.__v2 = false;
    client.emit('interactionCreate', i); await tick(40);
    return { i, edits };
}
const rowsOf = p => p.components.filter(n => n.type === 1).map(r => r.components);
test('Modes tab: pressing it shows the five modes under the tabs, with Modes and Interactive highlighted', async () => {
    const { edits } = await press('lbt_modes_interactive');
    assert.equal(edits.length, 1, 'the message was edited'); const p = edits[0]; withinLimits(p, 'modes tab');
    const rows = rowsOf(p); assert.equal(rows.length, 3, 'tabs, modes, pager');
    assert.deepEqual(rows[0].map(b => [b.label, b.style]), [['Users', 2], ['Modes', 1]]);
    assert.deepEqual(rows[1].map(b => b.label.replace(/^\S+ /, '')), ['Interactive', 'Simple', 'Countdown', 'Modifiers', 'Floors']);
    assert.deepEqual(rows[1].map(b => b.style), [1, 2, 2, 2, 2]);
    assert.deepEqual(rows[2].map(b => b.label).slice(0, 2), ['\u25c0', '1/1']);
});
test('Modes tab: choosing another mode keeps the tabs and highlights that mode; the Modes tab keeps the mode open', async () => {
    const simple = (await press('lbt_gs_simple')).edits[0]; withinLimits(simple, 'simple');
    assert.deepEqual(rowsOf(simple)[1].map(b => b.style), [2, 1, 2, 2, 2]); assert.equal(rowsOf(simple)[0][1].style, 1);
    assert.equal(rowsOf(simple)[0][1].custom_id, 'lbt_modes_simple');
    const stay = (await press('lbt_modes_countdown')).edits[0]; assert.deepEqual(rowsOf(stay)[1].map(b => b.style), [2, 2, 1, 2, 2]);
});
test('Modes tab: Users brings back the single tab row', async () => {
    const p = (await press('lbt_gu')).edits[0]; withinLimits(p, 'users tab'); assert.equal(rowsOf(p).length, 2);
    assert.deepEqual(rowsOf(p)[0].map(b => [b.label, b.style]), [['Users', 1], ['Modes', 2]]);
});
test('no two buttons in any leaderboard, highscore or stats screen share an id', async () => {
    for (const id of ['lbt_gu', 'lbt_modes_interactive', 'lbt_gs_floors', 'hst_simple', 'lb_gs_finteractive_p1']) { const { edits } = await press(id); if (edits[0]) withinLimits(edits[0], id); }
});

// ---------- /help: the Links page ----------
test('/help has a Links page: each link is a line of text with a link button beside it', () => {
    const p = v2.convert(help.buildHelpPage('links')), c = p.components[0];
    assert.equal(c.components[0].content, '### Links');
    const sections = c.components.filter(n => n.type === 9);
    const by = Object.fromEntries(sections.map(s => [s.components[0].content, s.accessory]));
    const gh = by['**GitHub:** source code'];
    assert.deepEqual(gh, { type: 2, style: 5, label: 'Open', url: 'https://github.com/sleepyturtler/Tick' });
    assert.equal(by['**top.gg:** vote and review'].url, 'https://top.gg/bot/1507450543419822242');
    assert.equal(by['**Support server:** help, bugs and updates'].url, 'https://discord.gg/Qrp82cRhUW');
    assert.match(by['**Add Tick:** invite the bot to a server'].url, /^https:\/\/discord\.com\/oauth2\/authorize\?client_id=\w+&permissions=\d+&scope=bot%20applications\.commands$/);
    for (const s of sections) assert.ok(s.accessory.type === 2 && s.accessory.style === 5 && !s.accessory.custom_id, 'link buttons carry a url, not an id');
    withinLimits(p, 'links page');
});
test('/help: one dropdown with every topic (the open one marked) and a Home button on every page but Home', () => {
    for (const t of help.TOPICS) {
        const p = v2.convert(help.buildHelpPage(t.id)), rows = p.components.filter(n => n.type === 1);
        const menu = rows[0].components[0];
        assert.equal(menu.custom_id, 'help_select'); assert.deepEqual(menu.options.map(o => o.value), help.TOPICS.map(x => x.id));
        assert.deepEqual(menu.options.filter(o => o.default).map(o => o.value), [t.id], `${t.id} is the marked option`);
        assert.ok(menu.options.every(o => o.description.length <= 100 && o.label.length <= 100));
        if (t.id === 'home') assert.equal(rows.length, 1); else { assert.equal(rows.length, 2); assert.equal(rows[1].components[0].custom_id, 'help_home'); }
    }
});
test('/help Links: the website, terms and privacy buttons appear when the site address is known', () => {
    const { execFileSync } = require('child_process');
    const out = execFileSync(process.execPath, ['-r', require.resolve('./lib'), '-e', "const v2=require('./src/v2');const p=v2.convert(require('./src/help').buildHelpPage('links'));console.log(JSON.stringify(p.components[0].components.filter(n=>n.type===9).map(s=>s.accessory.url)))"],
        { cwd: require('path').join(__dirname, '..'), env: { ...process.env, PUBLIC_URL: 'https://tick.example/' } }).toString();
    const urls = JSON.parse(out.trim().split('\n').pop());
    assert.ok(urls.includes('https://tick.example') && urls.includes('https://tick.example/terms') && urls.includes('https://tick.example/privacy'));
    assert.equal(urls.length, 7);
});
test('pressing a Links tab button shows the page', async () => {
    const { i } = await press('help_6', {});
    const sent = i.updated[0]; assert.ok(sent && isV2(sent)); assert.match(textOf(sent), /GitHub/);
});


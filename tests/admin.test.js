// /counting settings, /transfer and the welcome tour. Fake Discord objects and a fake database, like every other suite.
const { assert, test, db, tick, fakeChannel, fakeInteraction, fakeMessage, textOf, nodes, isV2, customIds } = require('./lib');
const v2 = require('../src/v2');
const state = require('../src/state');
const settings = require('../src/settings');
const transfer = require('../src/transfer');
const tour = require('../src/tour');
const { handleCount, register: registerMessages } = require('../src/handlers/messages');

const allIds = p => { const ids = []; const walk = n => { if (!n) return; if (typeof n.toJSON === 'function') n = n.toJSON(); if (n.custom_id) ids.push(n.custom_id); (n.components ?? []).forEach(walk); if (n.accessory) walk(n.accessory); }; (p.components ?? []).forEach(walk); return ids; };
const withinLimits = (p, label = '') => {
    const ids = allIds(p); assert.equal(new Set(ids).size, ids.length, `${label} duplicate custom_id: ${ids.filter((x, i) => ids.indexOf(x) !== i)}`);
    const all = { components: p.components };
    assert.ok(v2.count(all) <= 40, `${label} has ${v2.count(all)} components`);
    assert.ok(v2.textLength(all) <= 4000, `${label} has ${v2.textLength(all)} characters`);
    assert.ok(isV2(p) && p.embeds === undefined && p.content === undefined, `${label} is a clean V2 payload`);
    assert.deepEqual(p.allowedMentions, { parse: [] }, `${label} pings nobody`);
};


// Registering a handler adds listeners to the one shared client; take them off again so later suites do not see everything twice.
async function withRegistered(register, events, fn) {
    const client = require('../src/client'), before = Object.fromEntries(events.map(e => [e, client.listeners(e)]));
    register();
    try { return await fn(client); }
    finally { for (const e of events) for (const l of client.listeners(e)) if (!before[e].includes(l)) client.removeListener(e, l); }
}

async function setup({ channels = ['c1'], guild = {} } = {}) {
    db().reset();
    state.guildCache.clear(); state.chanCache.clear(); state.guildChans.clear(); state.loadedGuilds.clear();
    const g = state.defaultGuild(); Object.assign(g, guild); state.guildCache.set('g1', g);
    const list = channels.map(id => { const c = state.defaultChannel('g1', id, 'interactive'); state.indexChan(c); return c; });
    return { g, chans: list };
}
// A button, select or modal in the settings panel. Replies and updates are collected on the object.
function press(customId, { perms = true, values = [], fields = {}, roles = [] } = {}) {
    const i = fakeInteraction({ userId: 'u1', customId, values, perms });
    i.guild = { id: 'g1', members: { me: {} }, roles: { cache: new Map(roles.map(r => [r.id, r])), create: async o => ({ id: 'newrole', editable: true, managed: false, ...o }) }, channels: { cache: new Map() } };
    i.member.roles = { cache: new Set() };
    i.modals = []; i.showModal = async m => { i.modals.push(m.toJSON ? m.toJSON() : m); };
    i.fields = { getTextInputValue: k => fields[k] };
    const modalSubmit = /^cs_(streakm|frm)_/.test(customId);
    i.isMessageComponent = () => !modalSubmit; i.isFromMessage = modalSubmit ? () => true : undefined;   // like discord.js: buttons and menus have no isFromMessage
    return i;
}
const shown = i => i.updated.at(-1) ?? i.replied.at(-1);

// ---------- /counting settings ----------
test('settings: the panel is a clean V2 message with every control and unique ids', async () => {
    const { chans } = await setup();
    const i = press('x'); i.options = { getChannel: () => null }; i.channel = { isThread: () => false }; i.channelId = 'c1';
    await settings.open(i);
    const p = i.replied[0]; withinLimits(p, 'settings panel');
    const t = textOf(p); for (const w of ['Counting Settings', 'Mode:', 'Max streak:', 'Expressions:', 'Equations:', 'Players:', 'Fail role:']) assert.ok(t.includes(w), w);
    const ids = allIds(p); for (const w of [`cs_mode_${chans[0].channelId}`, 'cs_expr_c1', 'cs_eq_c1', 'cs_players_c1', 'cs_streak_c1', 'cs_failrole_c1', 'cs_frmake_c1']) assert.ok(ids.includes(w), w);
});
test('settings: opening needs permission', async () => {
    await setup();
    const i = press('x', { perms: false }); i.options = { getChannel: () => null };
    await settings.open(i);
    assert.ok(textOf(i.replied[0]).includes('No permission'));
});
test('settings: with several channels and none picked, the mode row is a channel picker', async () => {
    await setup({ channels: ['c1', 'c2'] });
    const i = press('x'); i.options = { getChannel: () => null }; i.channel = { isThread: () => false }; i.channelId = 'zzz';
    await settings.open(i);
    const ids = allIds(i.replied[0]); assert.ok(ids.includes('pick_mode')); assert.ok(!ids.some(x => x.startsWith('cs_mode_')));
    withinLimits(i.replied[0], 'picker panel');
});
test('settings: expressions toggle, and equations need expressions', async () => {
    const { g } = await setup();
    let i = press('cs_eq_c1'); assert.equal(await settings.handle(i), true);
    assert.equal(g.allowEquations, false); assert.ok(textOf(i.updated[0]).includes('Equations:** Off')); assert.equal(i.replied.length, 0, 'the panel is edited, not answered with a new message');
    i = press('cs_eq_c1'); await settings.handle(i); assert.equal(g.allowEquations, true);
    i = press('cs_expr_c1'); await settings.handle(i); assert.equal(g.allowExpressions, false);
    assert.ok(textOf(shown(i)).includes('Off (needs expressions)'));
    const eq = nodes(shown(i), 2).find(b => b.custom_id === 'cs_eq_c1'); assert.equal(eq.disabled, true, 'equations button is disabled');
    i = press('cs_eq_c1'); await settings.handle(i); assert.equal(g.allowEquations, true, 'unchanged while expressions are off');
    assert.ok(textOf(i.replied[0]).includes('expressions on first'));
});
test('settings: every control edits the panel in place instead of posting a new message', async () => {
    const { chans } = await setup(); const cid = chans[0].channelId;
    const cases = [['cs_expr_c1', {}], ['cs_players_c1', {}], [`cs_mode_${cid}`, { values: ['simple'] }], ['cs_streakm_c1', { fields: { amount: '3' } }], ['cs_frm_c1', { fields: { minutes: '5' } }],
        ['cs_failrole_c1', { values: ['r1'], roles: [{ id: 'r1', editable: true }] }], ['cs_froff_c1', {}]];
    for (const [id, extra] of cases) { const i = press(id, extra); await settings.handle(i); assert.equal(i.updated.length, 1, `${id} updated the panel`); assert.equal(i.replied.length, 0, `${id} posted nothing new`); withinLimits(i.updated[0], id); }
});
test('settings: players toggle', async () => {
    const { g } = await setup(); assert.equal(g.playerCount, true, 'on by default'); assert.ok(textOf(v2.convert(settings.panel('g1', g, null))).includes('Players:** On'));
    let i = press('cs_players_c1'); await settings.handle(i); assert.equal(g.playerCount, false); assert.ok(textOf(shown(i)).includes('Players:** Off'));
    i = press('cs_players_c1'); await settings.handle(i); assert.equal(g.playerCount, true); assert.ok(textOf(shown(i)).includes('Players:** On'));
});
test('settings: max streak opens a modal, and only 1 to 100 is accepted', async () => {
    const { g } = await setup();
    let i = press('cs_streak_c1'); await settings.handle(i); assert.equal(i.modals.length, 1); assert.equal(i.modals[0].customId ?? i.modals[0].custom_id, 'cs_streakm_c1');
    for (const bad of ['0', '101', 'abc', '2.5', '']) { i = press('cs_streakm_c1', { fields: { amount: bad } }); await settings.handle(i); assert.equal(g.maxStreak, 1, `rejects "${bad}"`); assert.ok(textOf(i.replied[0]).includes('1 to 100')); }
    i = press('cs_streakm_c1', { fields: { amount: ' 7 ' } }); await settings.handle(i);
    assert.equal(g.maxStreak, 7); assert.ok(textOf(shown(i)).includes('7 in a row'));
});
test('settings: the mode select switches a channel and resets its count, picking the same mode does not', async () => {
    const { chans } = await setup(); const c = chans[0]; c.current = 40;
    let i = press(`cs_mode_${c.channelId}`, { values: ['interactive'] }); await settings.handle(i); assert.equal(c.current, 40, 'same mode: untouched');
    i = press(`cs_mode_${c.channelId}`, { values: ['countdown'] }); await settings.handle(i);
    assert.equal(c.countType, 'countdown'); assert.equal(c.current, c.countdownStart + 1, 'reset to a fresh countdown');
    assert.ok(textOf(shown(i)).includes('Countdown'));
    i = press(`cs_mode_nope`, { values: ['simple'] }); await settings.handle(i); assert.ok(textOf(i.replied[0]).includes('no longer exists'));
});
test('settings: fail role controls are administrator only', async () => {
    const { g } = await setup();
    // hasPerm passes through the access role, so give this member one but no Administrator
    g.accessRoleId = 'acc';
    const make = (id, extra) => { const i = press(id, extra); i.member.permissions = { has: () => false }; i.member.roles = { cache: new Set(['acc']) }; return i; };
    for (const id of ['cs_frmake_c1', 'cs_frmins_c1', 'cs_froff_c1', 'cs_failrole_c1']) { const i = make(id, { values: ['r1'], roles: [{ id: 'r1', editable: true }] }); await settings.handle(i); assert.ok(textOf(i.replied[0]).includes('administrators'), id); }
    assert.equal(g.failRoleId, null);
    // the other controls still work for the access role
    const i = make('cs_players_c1'); await settings.handle(i); assert.equal(g.playerCount, false, 'the access role can switch it off (it starts on)');
});
test('settings: pick, create, time and switch off the fail role', async () => {
    const { g } = await setup();
    let i = press('cs_failrole_c1', { values: ['r1'], roles: [{ id: 'r1', editable: false }] }); await settings.handle(i);
    assert.equal(g.failRoleId, 'r1'); assert.ok(textOf(shown(i)).includes('<@&r1>')); assert.ok(textOf(shown(i)).includes('Manage Roles'), 'warns when the role cannot be assigned');
    i = press('cs_failrole_c1', { values: ['g1'], roles: [{ id: 'g1' }] }); await settings.handle(i);   // @everyone
    assert.equal(g.failRoleId, 'r1'); assert.ok(textOf(i.replied[0]).includes('@everyone'));
    i = press('cs_frm_c1', { fields: { minutes: '30' } }); await settings.handle(i); assert.equal(g.failRoleMinutes, 30);
    i = press('cs_frm_c1', { fields: { minutes: '2000' } }); await settings.handle(i); assert.equal(g.failRoleMinutes, 30);
    i = press('cs_froff_c1'); await settings.handle(i); assert.equal(g.failRoleId, null); assert.ok(textOf(shown(i)).includes('Fail role:** Off'));
    i = press('cs_frmake_c1'); await settings.handle(i); assert.equal(g.failRoleId, 'newrole');
    withinLimits(shown(i), 'panel after creating a role');
});
test('settings: the created fail role uses the current colour option', async () => {
    await setup(); const seen = []; const i = press('cs_frmake_c1');
    i.guild.roles.create = async o => { seen.push(o); return { id: 'nr', editable: true, managed: false, ...o }; };
    await settings.handle(i);
    assert.equal(seen.length, 1); assert.deepEqual(seen[0].colors, { primaryColor: 0xff4444 }); assert.equal('color' in seen[0], false, 'the old option is not used');
});
test('settings: anti-cheat is always on, even for servers that had switched it off', async () => {
    const { chans } = await setup({ guild: { antiCheat: false } }); const c = chans[0];
    c.current = 5; c.lastUserId = 'u1'; c.lastMessageId = 'last';
    await withRegistered(registerMessages, ['messageCreate', 'messageUpdate', 'messageDelete'], async client => {
        client.emit('messageDelete', { guildId: 'g1', channelId: 'c1', id: 'last' });
        await tick(20);
    });
    assert.equal(c.lastMessageId, null, 'the delete was noticed');
});
test('equations switched off: refused in interactive mode, deleted in simple mode, plain numbers still count', async () => {
    const { g, chans } = await setup({ guild: { allowEquations: false, maxStreak: 0 } }); const c = chans[0]; c.current = 4;
    let ch = fakeChannel('c1'); let m = fakeMessage({ content: '2x+3=13', channel: ch }); await handleCount(m); await tick();
    assert.equal(c.current, 4, 'the count did not move'); assert.ok(m.reactions.includes('\u274C')); assert.ok(JSON.stringify(ch.sent.map(s => s.payload)).includes('Equations disabled'));
    m = fakeMessage({ content: '2+3', channel: ch }); await handleCount(m); await tick(); assert.equal(c.current, 5, 'expressions still work');
    c.countType = 'simple'; c.current = 4; ch = fakeChannel('c1');
    m = fakeMessage({ content: '2x+3=13', channel: ch }); await handleCount(m); await tick(); assert.equal(m.deleted, true); assert.equal(c.current, 4);
    g.allowEquations = true; m = fakeMessage({ content: '2x+3=13', channel: ch }); await handleCount(m); await tick(); assert.equal(c.current, 5, 'back on: it counts');
});

// ---------- /transfer ----------
const H = (list) => list.map(([id, content, authorId = 'u1', bot = false]) => ({ id: String(id), content, authorId, bot }));
const G = { playerCount: false, allowExpressions: true, allowEquations: true };

test('transfer scan: the latest count of a clean run, with the person who made it', async () => {
    const r = await transfer.scan(H([[1, '1'], [2, '2', 'u2'], [3, '3'], [4, '4', 'u2']]), G, 'interactive');
    assert.deepEqual([r.found, r.value, r.userId, r.messageId], [true, 4, 'u2', '4']);
});
test('transfer scan: chatter, bot messages and stray numbers are ignored', async () => {
    const r = await transfer.scan(H([[1, '10'], [2, '11'], [3, 'lol nice'], [4, 'we are 100 people', 'u2'], [5, '12', 'u2'], [6, '13', 'bot', true], [7, '7'], [8, '13']]), G, 'interactive');
    assert.equal(r.value, 13); assert.equal(r.messageId, '8'); assert.equal(r.ignoredAfter, 0);
});
test('transfer scan: expressions and equations count against the running number', async () => {
    const r = await transfer.scan(H([[1, '5'], [2, '3+3'], [3, 'x^2=49'], [4, '2x=16'], [5, '9']]), G, 'interactive');
    assert.equal(r.value, 9);
    const q = await transfer.scan(H([[1, '5'], [2, '2x+3=13'], [3, '6'], [4, '14/2']]), G, 'interactive');   // 2x+3=13 is 5 again, not 6
    assert.equal(q.value, 7, 'the equation that does not fit is ignored');
});
test('transfer scan: after a reset a new run takes over, and a lone start number at the end is a reset', async () => {
    let r = await transfer.scan(H([[1, '50'], [2, '51'], [3, '52'], [4, '1'], [5, '2'], [6, '3']]), G, 'interactive'); assert.equal(r.value, 3);
    r = await transfer.scan(H([[1, '50'], [2, '51'], [3, '52'], [4, '1']]), G, 'interactive'); assert.equal(r.value, 1);
    r = await transfer.scan(H([[1, '50'], [2, '51'], [3, '52'], [4, '60']]), G, 'interactive');
    assert.equal(r.value, 52); assert.equal(r.ignoredAfter, 1, 'a later number that did not fit is reported');
});
test('transfer scan: countdown counts down, modifiers follow a modifier rule, nothing found is reported', async () => {
    assert.equal((await transfer.scan(H([[1, '100'], [2, '99'], [3, '98']]), G, 'countdown')).value, 98);
    assert.equal((await transfer.scan(H([[1, '2'], [2, '3'], [3, '5'], [4, '7'], [5, '11']]), G, 'modifiers')).value, 11);
    assert.equal((await transfer.scan(H([[1, '3'], [2, '5'], [3, '500 people lol'], [4, '500'], [5, '7'], [6, '11']]), G, 'modifiers')).value, 11, 'a stray big number is not a modifier count');
    assert.equal((await transfer.scan(H([[1, '1'], [2, '4'], [3, '9'], [4, '16']]), G, 'modifiers')).value, 16, 'squares have growing gaps');
    for (const hist of [[], [[1, 'hello'], [2, 'world']], [[1, '57']]]) assert.equal((await transfer.scan(H(hist), G, 'interactive')).found, false, JSON.stringify(hist));
    assert.equal((await transfer.scan(H([[1, '1']]), G, 'interactive')).found, true, 'a single 1 is a start');
});
test('transfer scan: absurd numbers are never a count', async () => {
    const r = await transfer.scan(H([[1, '5'], [2, '99999999999'], [3, '99999999999+1']]), G, 'interactive');
    assert.equal(r.found, false);
});
test('transfer: history is read in batches, oldest first', async () => {
    const msgs = Array.from({ length: 230 }, (_, k) => ({ id: String(1000 + k), content: String(k + 1), author: { id: 'u1', bot: false } }));
    const calls = [];
    const channel = { messages: { fetch: async ({ limit, before }) => {
        calls.push(before ?? null);
        const upto = before ? msgs.filter(m => Number(m.id) < Number(before)) : msgs;
        const batch = upto.slice(-limit).reverse();   // newest first, like Discord
        return { size: batch.length, values: () => batch[Symbol.iterator]() };
    } } };
    const h = await transfer.fetchHistory(channel, 500);
    assert.equal(h.length, 230); assert.equal(h[0].content, '1'); assert.equal(h.at(-1).content, '230'); assert.equal(calls.length, 3);
    assert.equal((await transfer.scan(h, G, 'interactive')).value, 230);
    assert.equal((await transfer.fetchHistory(channel, 100)).length, 100, 'stops at the limit');
});

function slash({ channel, mode = null, perms = true, missing = [] }) {
    const i = press('x', { perms });
    i.options = { getChannel: () => channel, getString: () => mode };
    i.deferred = false; i.edited = []; i.deferReply = async () => { i.deferred = true; }; i.editReply = async p => { i.edited.push(p); };
    i.guild.channels.cache.set(channel.id, channel);
    i.__v2 = false; return v2.wrapInteraction(i);   // wrap again so editReply goes through the V2 conversion like in production
}
function historyChannel(id, contents, { missing = [] } = {}) {
    const msgs = contents.map((content, k) => ({ id: String(100 + k), content, author: { id: k % 2 ? 'u2' : 'u1', bot: false } }));
    return { id, permissionsFor: () => ({ has: p => !missing.includes(p) }), messages: { fetch: async ({ limit, before }) => { const up = before ? msgs.filter(m => Number(m.id) < Number(before)) : msgs; const b = up.slice(-limit).reverse(); return { size: b.length, values: () => b[Symbol.iterator]() }; } }, sent: [], send: async function (p) { this.sent.push(p); return { id: 'x' }; }, isTextBased: () => true, isThread: () => false };
}
test('transfer: /transfer shows what it found and nothing changes until Confirm', async () => {
    await setup({ channels: [] });
    const ch = historyChannel('c9', ['1', '2', '3', 'hi', '4']);
    const i = slash({ channel: ch }); await transfer.run(i);
    const p = i.edited[0]; withinLimits(p, 'transfer card');
    assert.ok(textOf(p).includes('**4**')); assert.ok(textOf(p).includes('<@u1>'));
    assert.deepEqual(customIds(p), ['tr_ok_c9_interactive_4', 'tr_no']);
    assert.equal(state.chanCache.has('c9'), false, 'not a counting channel yet');
});
test('transfer: confirming makes the channel count from there, once, with one announcement', async () => {
    await setup({ channels: [] });
    const ch = historyChannel('c9', ['1']);
    const i = press('tr_ok_c9_interactive_4'); i.guild.channels.cache.set('c9', ch);
    assert.equal(await transfer.handle(i), true);
    const c = state.chanCache.get('c9'); assert.ok(c); assert.equal(c.current, 4); assert.equal(c.highScore, 4); assert.equal(c.lastUserId, null);
    assert.equal(c.countType, 'interactive'); assert.equal(state.channelsOf('g1').length, 1);
    await tick(); assert.equal(ch.sent.length, 1, 'one announcement, not two'); assert.ok(JSON.stringify(ch.sent[0]).includes('Next number: **5**'));
    assert.ok(textOf(shown(i)).includes('**4**'));
    // and the next count works
    const m = fakeMessage({ content: '5', userId: 'u7', channel: fakeChannel('c9') }); await handleCount(m); await tick();
    assert.equal(state.chanCache.get('c9').current, 5);
});
test('transfer: modes. countdown, floors and a different mode for an existing channel', async () => {
    const { chans } = await setup({ channels: ['c1'] });
    const ch = historyChannel('c1', ['1']);
    let i = press('tr_ok_c1_floors_250'); i.guild.channels.cache.set('c1', ch); await transfer.handle(i);
    let c = state.chanCache.get('c1'); assert.deepEqual([c.countType, c.current, c.checkpoint], ['floors', 250, 200]);
    i = press('tr_ok_c1_countdown_40'); i.guild.channels.cache.set('c1', ch); await transfer.handle(i);
    assert.deepEqual([c.countType, c.current], ['countdown', 40]);
    i = press('tr_ok_c1_countdown_1'); i.guild.channels.cache.set('c1', ch); await transfer.handle(i);
    assert.equal(c.current, c.countdownStart + 1, 'a finished countdown starts over');
    i = press('tr_ok_c1_interactive_0'); i.guild.channels.cache.set('c1', ch); await transfer.handle(i);
    assert.deepEqual([c.countType, c.current], ['interactive', 0]);
});
test('transfer: no count found offers a fresh start; missing permissions and a full server are explained', async () => {
    await setup({ channels: [] });
    let i = slash({ channel: historyChannel('c9', ['hello', 'there']) }); await transfer.run(i);
    assert.ok(textOf(i.edited[0]).includes("couldn't find a count")); assert.deepEqual(customIds(i.edited[0]), ['tr_ok_c9_interactive_0', 'tr_no']);
    i = slash({ channel: historyChannel('c9', ['1', '2'], { missing: ['ReadMessageHistory'] }) }); i.guild.members.me = {};
    const missing = historyChannel('c9', ['1', '2']); missing.permissionsFor = () => ({ has: () => false });
    i = slash({ channel: missing }); await transfer.run(i); assert.ok(i.edited[0].content.includes('Read Message History'));
    await setup({ channels: Array.from({ length: require('../src/config').MAX_COUNTING_CHANNELS }, (_, k) => `full${k}`) });
    i = slash({ channel: historyChannel('z', ['1', '2']) }); await transfer.run(i); assert.ok(i.edited[0].content.includes('up to'), i.edited[0].content);
});
test('transfer: a channel without readable history (a forum) is explained', async () => {
    await setup({ channels: [] });
    const i = slash({ channel: { id: 'f1', permissionsFor: () => ({ has: () => true }) } }); await transfer.run(i);
    assert.ok(i.edited[0].content.includes('Pick a text or announcement channel'));
});
test('transfer: needs permission, and Cancel changes nothing', async () => {
    await setup({ channels: [] });
    let i = slash({ channel: historyChannel('c9', ['1']), perms: false }); await transfer.run(i); assert.ok(textOf(i.replied[0]).includes('No permission'));
    i = press('tr_ok_c9_interactive_4', { perms: false }); await transfer.handle(i); assert.ok(textOf(i.replied[0]).includes('No permission')); assert.equal(state.chanCache.has('c9'), false);
    i = press('tr_no'); await transfer.handle(i); assert.ok(textOf(shown(i)).includes('Cancelled')); assert.equal(state.chanCache.has('c9'), false);
    i = press('tr_ok_c9_bogus_4'); assert.equal(await transfer.handle(i), false);
});

// ---------- the welcome tour ----------
test('tour: the welcome message has a Get a tour button, and the button opens a private first page', async () => {
    const w = v2.convert(tour.welcome()); withinLimits(w, 'welcome');
    assert.ok(textOf(w).includes('Thanks for adding Tick')); assert.deepEqual(customIds(w), ['tour_start']);
    const i = fakeInteraction({ userId: 'u1', customId: 'tour_start' });
    assert.equal(await tour.handle(i, () => ({ flags: 64 })), true);
    const p = i.replied[0]; withinLimits(p, 'tour page 1'); assert.ok(textOf(p).includes('Welcome to Tick'));
});
test('tour: every page is clean, and Back and Next walk through all of them', async () => {
    assert.equal(tour.TOTAL, 6);
    for (let n = 1; n <= tour.TOTAL; n++) {
        const p = v2.convert(tour.page(n)); withinLimits(p, `page ${n}`);
        const ids = customIds(p); const [back, , next] = nodes(p, 2);
        assert.equal(back.disabled === true, n === 1, `back on ${n}`); assert.equal(next.disabled === true, n === tour.TOTAL, `next on ${n}`);
        assert.ok(textOf(p).includes(`Tour ${n}/6`));
        assert.ok(ids.includes('tour_info'));
    }
    const i = fakeInteraction({ userId: 'u1', customId: 'tour_3' }); await tour.handle(i, () => ({}));
    assert.ok(textOf(i.updated[0]).includes('Counting modes'));
    assert.equal(await tour.handle(fakeInteraction({ userId: 'u1', customId: 'tour_info' }), () => ({})), false);
});
test('tour: no page names a command that no longer exists', () => {
    const all = Array.from({ length: tour.TOTAL }, (_, k) => textOf(v2.convert(tour.page(k + 1)))).join('\n');
    for (const gone of ['setcount', 'anticheat', '/counting failrole', '/counting expressions', '/counting players', '/counting maxstreak', '/counting mode', '/setup']) assert.ok(!all.includes(gone), gone);
    for (const real of ['/counting channel', '/counting settings', '/transfer', '/game', '/help']) assert.ok(all.includes(real), real);
});
test('the command list: settings and transfer exist, the folded-in subcommands are gone', () => {
    const cmds = require('../src/commands').buildCommands();
    const counting = cmds.find(c => c.name === 'counting'); const subs = (counting.subcommand ?? counting.options ?? []).map(o => (o.data ?? o).name).sort();   // the stand-in builders keep subcommands under `subcommand`
    assert.deepEqual(subs, ['channel', 'reset', 'settings', 'view']);
    assert.ok(cmds.find(c => c.name === 'transfer'));
    assert.ok(cmds.find(c => c.name === 'players'), 'the /players lookup stays');
});

// ---------- Guess Who: each player's menus sit directly under their own board ----------
const { MODULES } = require('../src/games');
const { CHARACTERS } = require('../src/games/guesswho/characters');
const gwGame = (phase, extra = {}) => {
    const names = CHARACTERS.map(c => c.name);
    return { id: 'gw1', type: 'guesswho', phase, userIds: ['a', 'b'], elo: { a: 1000, b: 1000 }, hostId: 'a', guestId: 'b',
        state: { a: 'a', b: 'b', names: { a: 'Ann', b: 'Bob' }, picks: {}, turn: 'a', remaining: { a: [...names], b: names.slice(0, 12) }, ...extra } };
};
const containers = p => p.components.filter(n => n.type === 17);
const kinds = c => c.components.map(n => n.type);
test('Guess Who (play): board, divider, own menus inside each card, shared buttons after both', async () => {
    const p = v2.convert(await MODULES.guesswho.payload(gwGame('play'))); withinLimits(p, 'guess who play');
    assert.equal(p.components.length, 3); assert.deepEqual(p.components.map(n => n.type), [17, 17, 1], 'two cards, then the button row');
    const [a, b] = containers(p);
    assert.ok(textOf({ components: [a] }).includes("Ann's board")); assert.ok(textOf({ components: [b] }).includes("Bob's board"));
    // Ann has 30 characters: two menus (25 is the limit), both under her board; Bob has 12: one menu
    assert.deepEqual(kinds(a).filter(t => t === 1), [1, 1]); assert.deepEqual(kinds(b).filter(t => t === 1), [1]);
    const first = (c, t) => kinds(c).indexOf(t), last = (c, t) => kinds(c).lastIndexOf(t);
    assert.ok(first(a, 12) < last(a, 14) && last(a, 14) < first(a, 1), 'image, then a divider, then the menus');
    const ids = c => nodes({ components: [c] }, 3).map(m => m.custom_id);
    assert.deepEqual(ids(a), ['g:gw1:rm:a:0', 'g:gw1:rm:a:1']); assert.deepEqual(ids(b), ['g:gw1:rm:b:0']);
    const sel = nodes({ components: [a, b] }, 3); assert.equal(sel.filter(m => m.disabled === true).length, 1, "only the waiting player's menu is disabled"); assert.equal(nodes({ components: [b] }, 3)[0].disabled, true);
    assert.ok(sel.every(m => m.options.length <= 25));
    const tail = customIds({ components: [p.components[2]] }); assert.ok(tail.includes('g:gw1:me') && tail.includes('g:gw1:end'));
    assert.equal(p.files.length, 2, 'both boards are attached');
});
test('Guess Who (pick): each player picks from menus under their own board', async () => {
    const p = v2.convert(await MODULES.guesswho.payload(gwGame('pick', { picks: { a: 'X' } }))); withinLimits(p, 'guess who pick');
    const [a, b] = containers(p);
    const ids = c => nodes({ components: [c] }, 3).map(m => m.custom_id);
    assert.deepEqual(ids(a), ['g:gw1:pick:a:0', 'g:gw1:pick:a:1']); assert.deepEqual(ids(b), ['g:gw1:pick:b:0', 'g:gw1:pick:b:1']);
    assert.ok(textOf({ components: [a] }).includes('Character picked')); assert.ok(textOf({ components: [b] }).includes('Choosing a character'));
    assert.ok(!customIds({ components: [p.components[2]] }).includes('g:gw1:end'), 'no End turn while picking');
});
test('Guess Who: the menus still work after the layout change', async () => {
    const p = await MODULES.guesswho.payload(gwGame('play', { turn: 'b' }));
    assert.equal(nodes({ components: v2.convert(p).components }, 3).filter(m => m.disabled !== true).length, 1, 'only the player on turn can use a menu');
});

// ---------- wiring: the real interaction handler routes to the new modules ----------
const wire = (over) => {
    const i = fakeInteraction({ userId: 'u1', customId: undefined, perms: true });
    Object.assign(i, { isButton: () => false, isRoleSelectMenu: () => false, isChannelSelectMenu: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false, isChatInputCommand: () => true, isFromMessage: () => false,
        replied: [], channelId: 'c1', channel: { isThread: () => false }, deferred: false, edited: [] });
    i.guild = { id: 'g1', members: { me: {} }, roles: { cache: new Map() }, channels: { cache: new Map() } };
    i.member.roles = { cache: new Set() };
    i.deferReply = async () => { i.deferred = true; }; i.editReply = async p => { i.edited.push(p); };
    Object.assign(i, over);
    i.__v2 = false; return v2.wrapInteraction(i);
};
test('wiring: /counting settings, /transfer, an old /setup button and the tour button reach their modules', async () => {
    await setup({ channels: ['c1'] });
    await withRegistered(require('../src/handlers/interactions').register, ['interactionCreate'], async client => {
    const fire = async i => { client.emit('interactionCreate', i); await tick(30); return i; };

    let i = await fire(wire({ commandName: 'counting', options: { getSubcommand: () => 'settings', getChannel: () => null } }));
    assert.ok(i.replied.length === 1 && textOf(i.replied[0]).includes('Counting Settings'), 'settings');

    const ch = historyChannel('c9', ['1', '2', '3']);
    i = wire({ commandName: 'transfer', options: { getChannel: () => ch, getString: () => null } }); i.guild.channels.cache.set('c9', ch);
    i = await fire(i); assert.ok(i.edited.length === 1 && textOf(i.edited[0]).includes('Transfer count'), 'transfer');

    i = await fire(wire({ isChatInputCommand: () => false, isButton: () => true, customId: 'setup_settings' }));
    assert.ok(i.replied.length === 1 && textOf(i.replied[0]).includes('was removed') && textOf(i.replied[0]).includes('/counting settings'), 'an old /setup button explains where things went');

    i = await fire(wire({ isChatInputCommand: () => false, isButton: () => true, customId: 'tour_start' }));
    assert.ok(i.replied.length === 1 && textOf(i.replied[0]).includes('Welcome to Tick'), 'tour button');

    i = await fire(wire({ isChatInputCommand: () => false, isButton: () => true, customId: 'tour_2', message: { id: 'm', flags: 32768, embeds: [] } }));
    assert.ok(i.updated.length === 1 && textOf(i.updated[0]).includes('Get started'), 'tour page');

    i = await fire(wire({ isChatInputCommand: () => false, isButton: () => true, customId: 'tr_no', message: { id: 'm', flags: 32768, embeds: [] } }));
    assert.ok(i.updated.length === 1 && textOf(i.updated[0]).includes('Cancelled'), 'transfer cancel');
    });
});

// ---------- player counting is on by default ----------
test('players: a new server has player counting on, and a tagged player counts without touching any setting', async () => {
    assert.equal(state.defaultGuild().playerCount, true); assert.equal(state.normGuild(null).playerCount, true); assert.equal(state.normGuild(undefined).playerCount, true);
    const { chans } = await setup({ guild: { maxStreak: 0 } }); const c = chans[0];
    db().players.push({ game: 25, name: 'Lamine Yamal', alt_name: '', norm_name: 'lamine yamal', norm_alt: '', overall: 81 });
    c.current = 105; const ch = fakeChannel('c1');
    const m = fakeMessage({ content: 'Lamine Yamal:fc25+25', userId: 'u5', channel: ch }); await handleCount(m); await tick();
    assert.equal(c.current, 106, 'the tagged player counted');
});
test('players: servers saved before the change are switched on once, and an admin turning it off sticks', async () => {
    const old = { maxStreak: 3, playerCount: false, failRoleId: 'r1' };                    // saved by an older version: no marker
    let g = state.normGuild(old); assert.equal(g.playerCount, true, 'switched on'); assert.equal(g.playersOnByDefault, true); assert.equal(g.maxStreak, 3, 'nothing else changes'); assert.equal(g.failRoleId, 'r1');
    assert.equal(state.normGuild({ playerCount: true }).playerCount, true, 'already on stays on');
    // the admin turns it off: the saved copy carries the marker, so the next load leaves it off
    g.playerCount = false; const saved = JSON.parse(JSON.stringify(g));
    assert.equal(state.normGuild(saved).playerCount, false, 'turned off after the switch-on stays off');
    // a copy without the marker (never saved since) repeats the switch-on, with the same result as before
    assert.equal(state.normGuild(old).playerCount, true);
    // new and legacy data both load through getGuild too
    db().reset(); state.guildCache.clear(); state.loadedGuilds.clear();
    assert.equal((await state.getGuild('gnew')).playerCount, true);
});

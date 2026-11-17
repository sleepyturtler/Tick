// Clickable command mentions, the /help dropdown, and the removal of /setup.
const { assert, test, fakeInteraction, textOf, customIds } = require('./lib');
const v2 = require('../src/v2');
const mentions = require('../src/mentions');
const help = require('../src/help');
const tour = require('../src/tour');
const state = require('../src/state');
const { buildCommands } = require('../src/commands');

// The real command tree: { name: Set of subcommand names }.
const tree = () => Object.fromEntries(buildCommands().map(c => [c.name, new Set((c.subcommand ?? c.options ?? []).filter(o => o.data?.name || o.name).map(o => (o.data ?? o).name))]));
const fakeIds = () => new Map(Object.keys(tree()).map((n, k) => [String(k), { name: n, id: String(900000000000000000n + BigInt(k)) }]));
const withIds = async fn => { mentions.setCommands(fakeIds()); try { return await fn(); } finally { mentions.clear(); } };

// Every command named in a text must exist: as a clickable mention, or as `/name sub` in backticks.
function problems(text) {
    const t = tree(), bad = [];
    const check = path => { const [c, sub, ...rest] = path.trim().split(' '); if (!t[c]) bad.push(path); else if (t[c].size ? !t[c].has(sub) || rest.length : sub) bad.push(path); };
    for (const m of text.matchAll(/<\/([a-z ]+):(\d+)>/g)) check(m[1]);
    for (const m of text.matchAll(/`\/([a-z]+(?: [a-z]+)?)`/g)) check(m[1]);
    return bad;
}
const allTours = () => Array.from({ length: tour.TOTAL }, (_, k) => textOf(v2.convert(tour.page(k + 1)))).join('\n');
const allHelp = () => help.TOPICS.map(t => textOf(v2.convert(help.buildHelpPage(t.id)))).join('\n');

test('mentions: a command with its ID is clickable, a subcommand uses its parent ID, and without an ID it is plain text', async () => {
    mentions.clear();
    assert.equal(mentions.cmd('help'), '`/help`'); assert.equal(mentions.cmd('counting settings'), '`/counting settings`');
    mentions.setCommands(new Map([['1', { name: 'counting', id: '111' }], ['2', { name: 'help', id: '222' }]]));
    try {
        assert.equal(mentions.cmd('help'), '</help:222>'); assert.equal(mentions.cmd('counting settings'), '</counting settings:111>');
        assert.equal(mentions.cmd('transfer'), '`/transfer`', 'a command Discord did not return stays plain');
        mentions.setCommands(new Map([['9', { name: 'game', id: '333' }]]));
        assert.equal(mentions.cmd('help'), '`/help`', 'a new registration replaces the old IDs');
        mentions.setCommands(undefined); assert.equal(mentions.cmd('game'), '`/game`');
    } finally { mentions.clear(); }
});
test('mentions: help and tour text use clickable mentions once the IDs are known, and name real commands only', async () => {
    await withIds(() => {
        for (const text of [allHelp(), allTours()]) {
            assert.ok(/<\/[a-z ]+:\d+>/.test(text), 'has clickable mentions'); assert.ok(!/`\/[a-z]/.test(text), 'no command is left as plain text');
            assert.deepEqual(problems(text), []);
        }
    });
});
test('mentions: before the IDs are known the same text still names real commands', () => {
    mentions.clear();
    for (const text of [allHelp(), allTours()]) { assert.ok(!/<\/[a-z ]+:\d+>/.test(text)); assert.deepEqual(problems(text), []); }
});
test('mentions: nothing in help or the tour names a command that was removed', async () => {
    for (const ids of [false, true]) {
        const run = () => { const t = allHelp() + allTours(); for (const gone of ['/setup', 'setcount', 'anticheat', 'counting failrole', 'counting expressions', 'counting players', 'counting maxstreak', 'counting mode']) assert.ok(!t.includes(gone), gone); };
        if (ids) await withIds(run); else run();
    }
});
test('mentions: the welcome card and the texts in state and settings use them too', async () => {
    await withIds(() => {
        const e = state.resolveCounting({ channelId: 'x', channel: { isThread: () => false }, guild: { id: 'gg' } }, null).error;
        assert.match(e, /<\/counting channel:\d+>/); assert.match(e, /<\/transfer:\d+>/); assert.ok(!e.includes('/setup'));
    });
});
test('mentions: a payload with mentions still pings nobody and stays within limits', async () => {
    await withIds(() => {
        for (const t of help.TOPICS) { const p = v2.convert(help.buildHelpPage(t.id)); assert.deepEqual(p.allowedMentions, { parse: [] }); assert.ok(v2.count({ components: p.components }) <= 40); assert.ok(v2.textLength({ components: p.components }) <= 4000, t.id); }
    });
});

test('/setup is gone, and /help has a topic option that matches the help topics', () => {
    const t = tree(); assert.ok(!t.setup, 'no /setup command'); assert.ok(t.help && t.transfer);
    const helpCmd = buildCommands().find(c => c.name === 'help'); const opt = (helpCmd.stringOption ?? helpCmd.options ?? [])[0];   // the stand-in builders keep options under `stringOption`
    const choices = opt && (opt.data ?? opt).choices;
    assert.deepEqual((choices ?? []).map(c => c.value), help.TOPICS.filter(x => x.id !== 'home').map(x => x.id));
});
test('/help: opening it, the dropdown, Home and the old numbered buttons', async () => {
    const ep = () => ({ flags: 64 });
    let i = fakeInteraction({ userId: 'u1' }); i.options = { getString: () => null }; await help.run(i, ep);
    assert.ok(textOf(i.replied[0]).includes('Tick Help')); assert.deepEqual(customIds(i.replied[0]), ['help_select']);
    i = fakeInteraction({ userId: 'u1' }); i.options = { getString: () => 'games' }; await help.run(i, ep);
    assert.ok(textOf(i.replied[0]).includes('Games')); assert.ok(customIds(i.replied[0]).includes('help_home'));
    for (const t of help.TOPICS) { i = fakeInteraction({ userId: 'u1', customId: 'help_select', values: [t.id] }); assert.equal(await help.handle(i), true); assert.equal(i.updated.length, 1, t.id); assert.ok(textOf(i.updated[0]).includes(t.id === 'home' ? 'Tick Help' : t.label === 'All commands' ? 'All commands' : t.label), t.id); }
    i = fakeInteraction({ userId: 'u1', customId: 'help_home' }); await help.handle(i); assert.ok(textOf(i.updated[0]).includes('Tick Help'));
    const legacy = { help_1: 'How to play', help_2: 'All commands', help_3: 'Admin', help_4: 'Modes', help_5: 'Expressions', help_6: 'Links' };
    for (const [id, want] of Object.entries(legacy)) { i = fakeInteraction({ userId: 'u1', customId: id }); assert.equal(await help.handle(i), true, id); assert.ok(textOf(i.updated[0]).toLowerCase().includes(want === 'How to play' ? 'how to play' : want.toLowerCase()), `${id} -> ${want}`); }
    i = fakeInteraction({ userId: 'u1', customId: 'help_select', values: ['nope'] }); assert.equal(await help.handle(i), false);
    i = fakeInteraction({ userId: 'u1', customId: 'help_9' }); assert.equal(await help.handle(i), false);
    assert.equal(await help.handle(fakeInteraction({ userId: 'u1', customId: 'tour_1' })), false);
});
test('/help: the games page lists every game, the admin page every admin command', async () => {
    const { MODULES, ORDER } = require('../src/games');
    const games = textOf(v2.convert(help.buildHelpPage('games'))); for (const t of ORDER) assert.ok(games.includes(MODULES[t].info.label), t);
    const admin = textOf(v2.convert(help.buildHelpPage('admin'))); for (const c of ['/counting channel', '/counting settings', '/transfer', '/counting reset', '/counting view', '/config access']) assert.ok(admin.includes(c), c);
    const all = textOf(v2.convert(help.buildHelpPage('commands')));
    // /killbot is a private owner tool and is never listed
    for (const [name, subs] of Object.entries(tree()).filter(([n]) => n !== 'killbot')) for (const sub of subs.size ? subs : [null]) { const path = sub ? `${name} ${sub}` : name; assert.ok(all.includes(`/${path}`), `/commands lists ${path}`); }
});

// Every handler the settings, help and /setup work touched, run once through the real interaction entry point.
// The aim is to catch what the focused suites cannot: a leftover reference to something removed, or a swallowed error.
const { assert, test, tick, fakeInteraction, textOf, customIds } = require('./lib');
const v2 = require('../src/v2');
const state = require('../src/state');

async function withRegistered(register, events, fn) {
    const client = require('../src/client'), before = Object.fromEntries(events.map(e => [e, client.listeners(e)]));
    register();
    try { return await fn(client); }
    finally { for (const e of events) for (const l of client.listeners(e)) if (!before[e].includes(l)) client.removeListener(e, l); }
}
function fresh(channels = ['c1']) {
    state.guildCache.clear(); state.chanCache.clear(); state.guildChans.clear(); state.loadedGuilds.clear();
    state.guildCache.set('g1', state.defaultGuild());
    for (const id of channels) state.indexChan(state.defaultChannel('g1', id, 'interactive'));
}
// kind: slash | button | string | role | channel
function ix(kind, over = {}) {
    const i = fakeInteraction({ userId: 'u1', customId: over.customId, values: over.values ?? [], perms: true });
    const is = { slash: 'isChatInputCommand', button: 'isButton', string: 'isStringSelectMenu', role: 'isRoleSelectMenu', channel: 'isChannelSelectMenu' };
    for (const m of ['isChatInputCommand', 'isButton', 'isStringSelectMenu', 'isRoleSelectMenu', 'isChannelSelectMenu', 'isModalSubmit']) i[m] = () => m === is[kind];
    i.isMessageComponent = () => kind !== 'slash'; i.isFromMessage = undefined;
    Object.assign(i, { channelId: 'c1', channel: { isThread: () => false }, deferred: false, edited: [], guild: { id: 'g1', members: { me: {} }, roles: { cache: new Map(), create: async o => ({ id: 'nr', editable: true, managed: false, ...o }) }, channels: { cache: new Map([['c2', { id: 'c2', permissionsFor: () => ({ has: () => true }), send: async () => ({ id: 'm' }), isTextBased: () => true, isThread: () => false, type: 0 }]]) } } });
    i.member.roles = { cache: new Set() };
    i.deferReply = async () => { i.deferred = true; }; i.editReply = async p => { i.edited.push(p); };
    Object.assign(i, over);
    i.__v2 = false; return v2.wrapInteraction(i);
}
const slash = (commandName, sub, opts = {}) => ix('slash', { commandName, options: { getSubcommand: () => sub, getChannel: () => opts.channel ?? null, getString: k => opts[k] ?? null, getUser: () => null, getInteger: () => null, getBoolean: () => null, getRole: () => null } });
const answered = i => [...i.replied, ...i.updated, ...i.edited];

async function run(cases) {
    const seen = [], realError = console.error; console.error = (...a) => seen.push(a.map(String).join(' '));
    try {
        await withRegistered(require('../src/handlers/interactions').register, ['interactionCreate'], async client => {
            for (const [label, make, check] of cases) {
                fresh(label.includes('no channels') ? [] : ['c1']);
                const i = make(); seen.length = 0;
                client.emit('interactionCreate', i); await tick(40);
                assert.deepEqual(seen, [], `${label}: no error was logged`);
                assert.ok(answered(i).length >= 1, `${label}: the interaction was answered`);
                if (check) check(i, answered(i));
            }
        });
    } finally { console.error = realError; }
}

test('smoke: every command and component the changes touched answers without an error', async () => {
    await run([
        ['/counting view', () => slash('counting', 'view'), (i, a) => { const t = a.map(textOf).join(' '); assert.ok(t.includes('Equations'), 'has the equations field'); assert.ok(/Anti-cheat[\s\S]{0,12}Always on/.test(t), 'anti-cheat is shown as always on, not as a setting that can be Off'); }],
        ['/counting channel', () => slash('counting', 'channel'), (i, a) => assert.ok(customIds(a[0]).includes('cc_add'))],
        ['/counting reset', () => slash('counting', 'reset')],
        ['/counting settings', () => slash('counting', 'settings'), (i, a) => assert.ok(textOf(a[0]).includes('Counting Settings'))],
        ['/config access', () => slash('config', 'access'), (i, a) => assert.ok(JSON.stringify(a[0]).includes('access_role_g1'))],
        ['access role select', () => ix('role', { customId: 'access_role_g1', values: ['r9'] }), (i, a) => assert.ok(textOf(a[0]).includes('<@&r9>'))],
        ['cc_add button', () => ix('button', { customId: 'cc_add' }), (i, a) => assert.ok(JSON.stringify(a[0]).includes('setup_channel_select'))],
        ['cc_remove button', () => ix('button', { customId: 'cc_remove' }), (i, a) => assert.ok(customIds(a[0]).includes('pick_remove'))],
        ['cc_remove with no channels', () => ix('button', { customId: 'cc_remove' })],
        ['channel select adds a channel', () => ix('channel', { customId: 'setup_channel_select', values: ['c2'] }), (i, a) => { assert.ok(state.chanCache.has('c2')); assert.ok(customIds(a[0]).some(x => x.startsWith('ct_'))); }],
        ['pick_mode opens the mode buttons', () => ix('string', { customId: 'pick_mode', values: ['c1'] }), (i, a) => assert.ok(customIds(a[0]).some(x => x.startsWith('ct_')))],
        ['pick_reset resets a channel', () => ix('string', { customId: 'pick_reset', values: ['c1'] }), (i, a) => assert.ok(textOf(a[0]).includes('was reset'))],
        ['pick_remove removes a channel', () => ix('string', { customId: 'pick_remove', values: ['c1'] }), () => assert.equal(state.chanCache.has('c1'), false)],
        ['old /setup button', () => ix('button', { customId: 'setup_refresh' }), (i, a) => assert.ok(textOf(a[0]).includes('was removed'))],
        ['old /setup add button', () => ix('button', { customId: 'setup_addchannel' }), (i, a) => assert.ok(textOf(a[0]).includes('/counting channel'))],
        ['/help', () => slash('help', null), (i, a) => assert.ok(textOf(a[0]).includes('Tick Help'))],
        ['/help topic', () => slash('help', null, { topic: 'admin' }), (i, a) => assert.ok(textOf(a[0]).includes('Admin'))],
        ['/invite', () => slash('invite', null)],
        ['/calculate', () => slash('calculate', null, { input: '2+3' })],
        ['/transfer', () => slash('transfer', null, { channel: { id: 'c2', permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => ({ size: 0, values: () => [][Symbol.iterator]() }) } } })],
    ]);
});

test('smoke: command definitions meet Discord\'s limits (names, descriptions, choices)', () => {
    const bad = [];
    const walk = (n, path) => {
        if (Array.isArray(n)) return n.forEach((x, k) => walk(x, `${path}[${k}]`));
        if (!n || typeof n !== 'object') return;
        const d = n.data && typeof n.data === 'object' ? n.data : n;
        if (typeof d.name === 'string' && d.description !== undefined) {
            if (!/^[a-z0-9_-]{1,32}$/.test(d.name)) bad.push(`${path}: name "${d.name}"`);
            if (typeof d.description !== 'string' || d.description.length < 1 || d.description.length > 100) bad.push(`${path}: description of ${d.name} is ${String(d.description).length} long`);
        }
        if (Array.isArray(d.choices)) { if (d.choices.length > 25) bad.push(`${path}: ${d.choices.length} choices`); for (const c of d.choices) if (!c.name || c.name.length > 100) bad.push(`${path}: choice ${c.name}`); }
        for (const [k, v] of Object.entries(d)) if (v && typeof v === 'object' && k !== 'choices' && k !== 'channelTypes') walk(v, `${path}.${k}`);
    };
    for (const c of require('../src/commands').buildCommands()) walk(c, `/${c.name}`);
    assert.deepEqual(bad, []);
});

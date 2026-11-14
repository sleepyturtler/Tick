// Tiny test runner and fake Discord objects. Everything here runs offline: no Discord, no database server.
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

// Always use the stand-ins for discord.js, pg and @napi-rs/canvas, even if the real ones are installed (the real pg would try to connect).
const STUBS = { 'discord.js': 'discord.js', pg: 'pg', '@napi-rs/canvas': '@napi-rs/canvas' };
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (STUBS[request]) return orig.call(this, path.join(__dirname, 'stubs', STUBS[request]), ...rest);
    return orig.call(this, request, ...rest);
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
async function runAll() {
    let pass = 0, fail = 0;
    for (const t of tests.filter(t => !process.env.ONLY || t.name.includes(process.env.ONLY))) {
        try { await t.fn(); pass++; console.log(`  ok   ${t.name}`); }
        catch (e) { fail++; console.log(`  FAIL ${t.name}\n       ${String(e.stack || e).split('\n').slice(0, 4).join('\n       ')}`); }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    return fail;
}

const db = () => global.__fakeDb;
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

// ---------- fake Discord ----------
function fakeChannel(id = 'c1') {
    const ch = { id, sent: [], edits: [], deleted: [], isThread: () => false, isTextBased: () => true };
    ch.send = async p => { const m = { id: `m${ch.sent.length + 1}`, payload: p }; ch.sent.push(m); return m; };
    ch.messages = { edit: async (mid, p) => { ch.edits.push({ id: mid, payload: p }); return { id: mid }; }, delete: async mid => { ch.deleted.push(mid); } };
    return ch;
}
// A button press / select / modal. `i.updated` and `i.replied` collect what the bot answered.
function fakeInteraction({ userId, customId, channelId = 'c1', values = [], perms = false }) {
    const i = {
        user: { id: userId, bot: false, username: `u${userId}` }, customId, channelId, guild: { id: 'g1' }, values, updated: [], replied: [], followed: [],
        member: { displayName: `Name${userId}`, permissions: { has: () => perms } }, message: { id: 'm1' },
        isChatInputCommand: () => false, isStringSelectMenu: () => values.length > 0, isFromMessage: () => true,
    };
    i.update = async p => { i.updated.push(p); }; i.reply = async p => { i.replied.push(p); }; i.followUp = async p => { i.followed.push(p); };
    i.deferUpdate = async () => {}; i.fetchReply = async () => ({ id: 'ephemeral1' }); i.showModal = async () => {};
    return i;
}
// A message in a counting channel
function fakeMessage({ content, userId = 'u1', id = `msg${Math.random().toString(36).slice(2)}`, channel }) {
    const m = { id, content, author: { id: userId, bot: false }, reactions: [], replies: [], deleted: false,
        guild: { id: 'g1', members: { me: { permissionsIn: () => ({ has: () => true }) } }, channels: { cache: new Map() } }, channel: channel ?? fakeChannel('c1') };
    m.react = async e => { m.reactions.push(e); }; m.reply = async p => { m.replies.push(p); }; m.delete = async () => { m.deleted = true; };
    return m;
}
const texts = ch => ch.sent.map(s => JSON.stringify(s.payload));

module.exports = { assert, test, runAll, db, tick, fakeChannel, fakeInteraction, fakeMessage, texts };

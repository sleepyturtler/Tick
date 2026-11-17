// Deleting a server's data after the bot is removed: queueing, the grace period, the safeguards, and what is and is not deleted.
const { assert, test, db, tick } = require('./lib');
const client = require('../src/client');
const cleanup = require('../src/guildCleanup');
const state = require('../src/state');
const store = require('../src/games/store');
const cfg = require('../src/config');

const DAY = 86_400_000;
let registered = false;
function setup({ inGuilds = ['KEEP'], unavailable = [] } = {}) {
    db().reset(); store.all().forEach(g => store.remove(g)); state.guildCache.clear(); state.chanCache.clear(); state.guildChans.clear(); state.loadedGuilds.clear();
    if (!registered) { cleanup.register(); registered = true; }
    client.guilds.cache.clear();
    for (const id of inGuilds) client.guilds.cache.set(id, { id, available: true });
    for (const id of unavailable) client.guilds.cache.set(id, { id, available: false });
}
// everything stored for a server, in every table
function seed(gid, n = 1) {
    for (const k of Object.keys(db().rows)) db().rows[k].push({ guild_id: gid });
    db().rows.user_stats.push({ guild_id: gid });
    state.guildCache.set(gid, state.defaultGuild()); state.indexChan(state.defaultChannel(gid, `chan-${gid}`, 'interactive'));
    db().games.set(`game-${gid}`, { data: { id: `game-${gid}`, guildId: gid }, at: db().now });
    store.add({ id: `game-${gid}`, type: 'tictactoe', guildId: gid, channelId: 'c', userIds: ['a', 'b'], phase: 'play', state: {} });
}
const rowsOf = gid => Object.values(db().rows).reduce((n, list) => n + list.filter(r => r.guild_id === gid).length, 0);
const queued = gid => db().purges.get(gid);
const ago = ms => { db().purges.forEach(v => { v.delete_after = String(Number(v.delete_after) - ms); }); };

test('the grace period is seven days unless overridden', () => {
    assert.equal(cfg.GUILD_PURGE_GRACE_MS, process.env.GUILD_PURGE_GRACE_MINUTES ? Number(process.env.GUILD_PURGE_GRACE_MINUTES) * 60_000 : 7 * DAY);
});
test('removing the bot queues the server for deletion a grace period later, and deletes nothing yet', async () => {
    setup(); seed('GONE'); const t = Date.now();
    client.emit('guildDelete', { id: 'GONE', available: true }); await tick(20);
    const q = queued('GONE'); assert.ok(q, 'queued');
    assert.ok(Math.abs(Number(q.delete_after) - (t + cfg.GUILD_PURGE_GRACE_MS)) < 5000);
    assert.ok(rowsOf('GONE') > 0, 'data is still there'); assert.ok(store.get('game-GONE'));
});
test('a server that is only unavailable (an outage) is not a removal', async () => {
    setup(); client.emit('guildDelete', { id: 'OUT', available: false }); await tick(20);
    assert.equal(queued('OUT'), undefined);
});
test('adding the bot back cancels the deletion', async () => {
    setup(); client.emit('guildDelete', { id: 'BACK', available: true }); await tick(20); assert.ok(queued('BACK'));
    client.emit('guildCreate', { id: 'BACK' }); await tick(20); assert.equal(queued('BACK'), undefined);
});
test('removing the bot twice keeps the first deadline', async () => {
    setup(); client.emit('guildDelete', { id: 'TWICE', available: true }); await tick(20); const first = queued('TWICE').delete_after;
    await tick(10); client.emit('guildDelete', { id: 'TWICE', available: true }); await tick(20);
    assert.equal(queued('TWICE').delete_after, first);
});
test('before the grace period is over nothing is deleted; after it, that server and only that server is', async () => {
    setup(); seed('GONE'); seed('KEEP');
    client.emit('guildDelete', { id: 'GONE', available: true }); await tick(20);
    await cleanup.sweepRemovedGuilds(); assert.ok(rowsOf('GONE') > 0, 'too early');
    ago(cfg.GUILD_PURGE_GRACE_MS + 1000); await cleanup.sweepRemovedGuilds();
    assert.equal(rowsOf('GONE'), 0, 'every table is empty for the removed server'); assert.equal(queued('GONE'), undefined, 'and it is no longer queued');
    assert.ok(rowsOf('KEEP') > 0, 'the server the bot is still in is untouched');
    assert.equal(store.get('game-GONE'), undefined, 'running games of that server are gone from memory'); assert.ok(store.get('game-KEEP'));
    assert.equal(db().games.has('game-GONE'), false); assert.equal(db().games.has('game-KEEP'), true);
    assert.equal(state.chanCache.has('chan-GONE'), false, 'cached channels'); assert.equal(state.guildCache.has('GONE'), false, 'cached settings');
    assert.equal(state.chanCache.has('chan-KEEP'), true);
});
test('Elo ratings and the same-opponent history survive: they belong to the player', async () => {
    setup(); seed('GONE');
    const elo = require('../src/games/elo'); await elo.record('tictactoe', 'a', 'b', 1);
    client.emit('guildDelete', { id: 'GONE', available: true }); await tick(20); ago(cfg.GUILD_PURGE_GRACE_MS + 1000); await cleanup.sweepRemovedGuilds();
    assert.equal(db().elo.get('a|tictactoe').rating, 1016); assert.equal(db().pairs.size, 1);
});
test('a server the bot is in again is not deleted even when its grace period is over, and is taken off the queue', async () => {
    setup({ inGuilds: ['KEEP', 'RETURNED'] }); seed('RETURNED');
    db().purges.set('RETURNED', { delete_after: String(Date.now() - 1000), reason: 'x' });
    await cleanup.sweepRemovedGuilds();
    assert.ok(rowsOf('RETURNED') > 0); assert.equal(queued('RETURNED'), undefined);
});
test('nothing is deleted while the server list cannot be trusted', async () => {
    setup({ inGuilds: [] }); seed('GONE'); db().purges.set('GONE', { delete_after: String(Date.now() - 1000), reason: 'x' });
    await cleanup.sweepRemovedGuilds(); assert.ok(rowsOf('GONE') > 0, 'empty server list'); assert.ok(queued('GONE'), 'still queued');
    setup({ inGuilds: ['KEEP'], unavailable: ['OTHER'] }); seed('GONE'); db().purges.set('GONE', { delete_after: String(Date.now() - 1000), reason: 'x' });
    await cleanup.sweepRemovedGuilds(); assert.ok(rowsOf('GONE') > 0, 'a server is unavailable');
});
test('a failed deletion changes nothing, stays queued, and does not stop the sweep', async () => {
    setup(); seed('BAD'); seed('GONE2');
    db().purges.set('BAD', { delete_after: String(Date.now() - 2000), reason: 'x' }); db().purges.set('GONE2', { delete_after: String(Date.now() - 1000), reason: 'x' });
    db().failOn = /^DELETE FROM user_stats WHERE guild_id=\$1/;
    const r = await cleanup.purgeGuild('BAD', 'test'); assert.equal(r, null);
    assert.ok(rowsOf('BAD') > 0, 'rolled back: nothing was removed'); assert.ok(queued('BAD'));
    db().failOn = null; await cleanup.sweepRemovedGuilds(); assert.equal(rowsOf('BAD'), 0); assert.equal(rowsOf('GONE2'), 0);
});
test('the startup sweep queues stored servers the bot is no longer in', async () => {
    setup({ inGuilds: ['KEEP', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8'] }); seed('KEEP'); seed('K2'); seed('K3'); seed('K4'); seed('K5'); seed('K6'); seed('K7'); seed('K8'); seed('LEFT');
    await cleanup.purgeOrphanedGuilds(); assert.ok(queued('LEFT')); assert.equal(queued('KEEP'), undefined);
    assert.ok(rowsOf('LEFT') > 0, 'queued, not deleted');
});
test('the startup sweep trusts neither an empty nor an incomplete server list', async () => {
    setup({ inGuilds: [] }); seed('LEFT'); await cleanup.purgeOrphanedGuilds(); assert.equal(db().purges.size, 0);
    setup({ inGuilds: ['KEEP'], unavailable: ['X'] }); seed('LEFT'); await cleanup.purgeOrphanedGuilds(); assert.equal(db().purges.size, 0);
});
test('the startup sweep refuses to queue a large share of stored servers (wrong database?) unless told to', async () => {
    setup({ inGuilds: ['KEEP'] }); for (let i = 0; i < 10; i++) seed(`OLD${i}`); seed('KEEP');   // 10 of 11 stored servers are missing
    const warn = console.warn; let warned = ''; console.warn = m => { warned += m; };
    try { await cleanup.purgeOrphanedGuilds(); } finally { console.warn = warn; }
    assert.equal(db().purges.size, 0); assert.match(warned, /REFUSED/);
    process.env.ALLOW_BULK_ORPHAN_PURGE = 'true';
    try { await cleanup.purgeOrphanedGuilds(); } finally { delete process.env.ALLOW_BULK_ORPHAN_PURGE; }
    assert.equal(db().purges.size, 10);
});
test('a handful of missing servers is fine: the limit is a quarter of the stored ones, at least five', async () => {
    setup({ inGuilds: ['KEEP'] }); for (let i = 0; i < 5; i++) seed(`OLD${i}`); seed('KEEP');
    await cleanup.purgeOrphanedGuilds(); assert.equal(db().purges.size, 5);
});
test('a server with only saved games (no counting data) is still found and deleted', async () => {
    setup(); db().games.set('lonely', { data: { id: 'lonely', guildId: 'ONLYGAMES' }, at: db().now });
    assert.deepEqual(await require('../src/db').getStoredGuildIds(), ['ONLYGAMES']);
    await cleanup.purgeGuild('ONLYGAMES', 'test'); assert.equal(db().games.size, 0);
});

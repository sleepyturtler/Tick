// Deleting a server's data after the bot is removed from it.
//
// Nothing is deleted straight away. Removing the bot (guildDelete) and a sweep at startup for servers the bot left while it was
// offline both only QUEUE the server. sweepRemovedGuilds() deletes it once GUILD_PURGE_GRACE_MS (7 days) has passed, and adding
// the bot back before then cancels it, with everything still in place. Deleting is not reversible, so the sweeps refuse to act
// when the server list cannot be trusted: empty, some servers unavailable, or an unusually large share of stored servers missing,
// which points at a Discord or connection problem (or the wrong database) rather than real removals.
//
// Removed: the server's settings, counting channels, member stats, fail roles, welcome flag and saved games.
// Kept: Elo ratings and the same-opponent history. They belong to the player and are bot-wide, not tied to a server.
const client = require('./client');
const { cancelGuildPurge, deleteGuildData, getQueuedGuildPurges, getStoredGuildIds, scheduleGuildPurge } = require('./db');
const { GUILD_PURGE_GRACE_MS, GUILD_SWEEP_INTERVAL_MS } = require('./config');
const state = require('./state');
const gameStore = require('./games/store');

// Never throws. Returns what was removed, or null if the deletion itself failed.
async function purgeGuild(guildId, why) {
    let result;
    try {
        result = await deleteGuildData(guildId);
    } catch (e) {
        console.error(`purgeGuild (${guildId}): deletion failed, nothing was removed:`, e.message);
        return null;
    }
    // memory too: cached settings and channels, and any game still running in that server
    state.forgetGuild(guildId);
    for (const g of gameStore.all()) if (g.guildId === guildId) gameStore.remove(g);
    console.log(`Removed all stored data for server ${guildId} (${why}): ${result.channels} channel(s), ${result.members} member record(s), ${result.games} saved game(s)`);
    return result;
}

// Never throws. Starts the grace period for a server the bot is no longer in.
async function queueGuildPurge(guildId, why) {
    try {
        const deleteAfter = Date.now() + GUILD_PURGE_GRACE_MS;
        if (await scheduleGuildPurge(guildId, deleteAfter, why)) console.log(`Server ${guildId} (${why}): its data will be deleted after ${new Date(deleteAfter).toISOString()} unless the bot is added back before then`);
    } catch (e) {
        console.error(`queueGuildPurge (${guildId}):`, e.message);
    }
}

// The bot is in this server again: forget the pending deletion. Never throws.
async function cancelQueuedPurge(guildId) {
    try {
        if (await cancelGuildPurge(guildId)) console.log(`Server ${guildId}: the bot is back, so its pending data deletion was cancelled`);
    } catch (e) {
        console.error(`cancelQueuedPurge (${guildId}):`, e.message);
    }
}

// Cancels queued servers the bot is in again, and deletes those whose grace period is over and the bot is still not in.
// Postpones deleting when the server list cannot be trusted. Never throws.
async function sweepRemovedGuilds() {
    try {
        const guilds = client.guilds.cache;
        const queued = await getQueuedGuildPurges();
        if (!queued.length) return;
        for (const q of queued) if (guilds.has(q.guild_id)) await cancelQueuedPurge(q.guild_id);
        const due = queued.filter(q => q.delete_after <= Date.now() && !guilds.has(q.guild_id));
        if (!due.length) return;
        if (guilds.size === 0 || [...guilds.values()].some(g => g.available === false)) { console.log('Removed-server deletion postponed: the server list is empty or incomplete (Discord outage?).'); return; }
        for (const q of due) await purgeGuild(q.guild_id, q.reason || 'the bot was removed from the server');
    } catch (e) {
        console.error('removed-server sweep:', e.message);
    }
}

// Queues data for servers that are stored but no longer in the bot's server list. Never throws.
async function purgeOrphanedGuilds() {
    try {
        const guilds = client.guilds.cache;
        if (guilds.size === 0) { console.log('Orphan sweep skipped: the bot reports no servers (not trusting an empty server list).'); return; }
        if ([...guilds.values()].some(g => g.available === false)) { console.log('Orphan sweep skipped: some servers are unavailable (Discord outage?). It will run on a later start.'); return; }
        const stored = await getStoredGuildIds();
        const orphans = stored.filter(id => !guilds.has(id));
        if (!orphans.length) return;
        const limit = Math.max(5, Math.floor(stored.length * 0.25));
        if (orphans.length > limit && process.env.ALLOW_BULK_ORPHAN_PURGE !== 'true') {
            console.warn(`Orphan sweep REFUSED: ${orphans.length} of ${stored.length} stored servers are not in this bot's server list (the bot is in ${guilds.size}), more than the safe limit of ${limit}. Nothing was queued.\n`
                + `   Examples: ${orphans.slice(0, 8).join(', ')}${orphans.length > 8 ? ', ...' : ''}\n`
                + '   If this database belongs to a different bot (wrong DATABASE_URL?), fix that first. Only if these servers really are gone, set ALLOW_BULK_ORPHAN_PURGE=true and restart once.');
            return;
        }
        for (const id of orphans) await queueGuildPurge(id, 'the bot is no longer in this server');
    } catch (e) {
        console.error('orphan sweep:', e.message);
    }
}

// Events, and the periodic check. Called once when the bot is ready.
function register() {
    // A server that is only unavailable (a Discord outage) also fires guildDelete: that is not a removal.
    client.on('guildDelete', guild => { if (guild.available === false) return; queueGuildPurge(guild.id, 'the bot was removed from the server'); });
    client.on('guildCreate', guild => { cancelQueuedPurge(guild.id); });
}
async function start() {
    await purgeOrphanedGuilds();
    await sweepRemovedGuilds();
    setInterval(sweepRemovedGuilds, GUILD_SWEEP_INTERVAL_MS).unref();
}

module.exports = { cancelQueuedPurge, purgeGuild, purgeOrphanedGuilds, queueGuildPurge, sweepRemovedGuilds, register, start };

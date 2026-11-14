const { PermissionFlagsBits } = require('discord.js');
const client = require('./client');
const { pool } = require('./db');
const { COUNTDOWN_START, MODE_EMOJI } = require('./config');
const { safeMode } = require('./config');
const { resetChannel } = require('./modes');

// Guild settings (shared by every counting channel in the server) live in `counting`.
// Each counting channel has its own row in `counting_channels` with its own mode and count.
const guildCache = new Map(), chanCache = new Map(), guildChans = new Map(), loadedGuilds = new Set();
// Object so other modules see the change (a bare `let` can't be shared across files).
const flags = { fullyLoaded: false };

function defaultGuild() {
    return { maxStreak: 1, allowExpressions: true, accessRoleId: null, saves: 0, savesUsed: 0, failRoleId: null, failRoleMinutes: 10, antiCheat: true, playerCount: false, migratedToChannels: true };
}
function defaultChannel(gid, cid, type = 'interactive') {
    const c = { guildId: gid, channelId: cid, countType: type, current: 0, lastUserId: null, consecutiveCount: 0, lastMessageId: null, highScore: 0, countdownCycles: 0, countdownStart: COUNTDOWN_START, modifier: null, modifierLabel: null, checkpoint: 0 };
    resetChannel(c, true);
    return c;
}
const normGuild = d => ({ ...defaultGuild(), ...(d || {}) });
function normChan(d) {
    const c = { ...defaultChannel(d.guildId, d.channelId), ...d };
    if (c.countType === 'random') c.countType = 'modifiers';
    if (!safeMode(c.countType)) c.countType = 'interactive';
    return c;
}
function indexChan(c) {
    chanCache.set(c.channelId, c);
    if (!guildChans.has(c.guildId)) guildChans.set(c.guildId, new Set());
    guildChans.get(c.guildId).add(c.channelId);
}
function unindexChan(c) { chanCache.delete(c.channelId); guildChans.get(c.guildId)?.delete(c.channelId); }
const channelsOf = gid => [...(guildChans.get(gid) ?? [])].map(id => chanCache.get(id)).filter(Boolean);

async function loadGuild(gid) {
    if (flags.fullyLoaded || loadedGuilds.has(gid)) return;
    const [g, ch] = await Promise.all([
        pool.query('SELECT data FROM counting WHERE guild_id=$1', [gid]),
        pool.query('SELECT channel_id, data FROM counting_channels WHERE guild_id=$1', [gid]),
    ]);
    if (!guildCache.has(gid)) guildCache.set(gid, normGuild(g.rows[0]?.data));
    for (const r of ch.rows) if (!chanCache.has(r.channel_id)) indexChan(normChan({ ...r.data, guildId: gid, channelId: r.channel_id }));
    loadedGuilds.add(gid);
}
async function getGuild(gid) {
    if (!guildCache.has(gid)) {
        await loadGuild(gid);
        if (!guildCache.has(gid)) guildCache.set(gid, defaultGuild());
    }
    return guildCache.get(gid);
}
function saveGuild(gid, data) {
    guildCache.set(gid, data);
    pool.query('INSERT INTO counting (guild_id,data) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET data=$2', [gid, data]).catch(e => console.error('saveGuild:', e.message));
}
function saveChan(c) {
    pool.query('INSERT INTO counting_channels (guild_id,channel_id,data) VALUES ($1,$2,$3) ON CONFLICT (guild_id,channel_id) DO UPDATE SET data=$3', [c.guildId, c.channelId, c]).catch(e => console.error('saveChan:', e.message));
}
async function removeCountingChannel(gid, cid) {
    const c = chanCache.get(cid);
    if (!c || c.guildId !== gid) return false;
    unindexChan(c);
    await pool.query('DELETE FROM counting_channels WHERE guild_id=$1 AND channel_id=$2', [gid, cid]).catch(e => console.error('removeCountingChannel:', e.message));
    return true;
}

async function hasPerm(interaction, gid) {
    if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const g = await getGuild(gid);
    return g.accessRoleId ? interaction.member.roles.cache.has(g.accessRoleId) : false;
}

// ---------- channel helpers ----------
const chanName = cid => client.channels.cache.get(cid)?.name;
const countingIdFor = channelId => { const ch = client.channels.cache.get(channelId); return ch?.isThread?.() ? ch.parentId : channelId; };
const isFresh = c => c.countType === 'countdown' && c.current > c.countdownStart;
const showCur = c => isFresh(c) ? `starts at ${c.countdownStart}` : `${c.current}`;
function channelLine(c) {
    const parts = [`${MODE_EMOJI[c.countType]} <#${c.channelId}> — **${showCur(c)}**`];
    parts.push(c.countType === 'countdown' ? `${c.countdownCycles ?? 0} cycles` : `high ${c.highScore}`);
    if (c.countType === 'modifiers' && c.modifierLabel) parts.push(c.modifierLabel);
    if (c.countType === 'floors') parts.push(`checkpoint ${c.checkpoint}`);
    return parts.join(' · ');
}
// Pick which counting channel a command is about: the option, else the channel it was run in, else the only one.
function resolveCounting(interaction, opt) {
    const gid = interaction.guild.id, list = channelsOf(gid);
    let cid = opt ? (opt.isThread?.() ? opt.parentId : opt.id) : null;
    if (!cid) {
        const here = interaction.channel?.isThread?.() ? interaction.channel.parentId : interaction.channelId;
        if (chanCache.has(here)) cid = here; else if (list.length === 1) cid = list[0].channelId;
    }
    const c = cid ? chanCache.get(cid) : null;
    if (c && c.guildId === gid) return { c };
    if (opt) return { error: `${opt} isn't a counting channel. Add it with \`/counting channel\` first.` };
    if (!list.length) return { error: 'No counting channel set up yet. Use `/counting channel` or `/setup`.' };
    return { error: 'You have more than one counting channel. Pick one with the `channel` option, or run this command inside it.' };
}

module.exports = {
    guildCache, chanCache, guildChans, loadedGuilds, flags,
    defaultGuild, defaultChannel, normGuild, normChan, indexChan, unindexChan, channelsOf,
    loadGuild, getGuild, saveGuild, saveChan, removeCountingChannel, hasPerm,
    chanName, countingIdFor, isFresh, showCur, channelLine, resolveCounting,
};

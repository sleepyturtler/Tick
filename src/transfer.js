// /transfer: point Tick at a channel that already has a count (usually one another counting bot ran), read the latest real count
// from its history, and carry on from there. The admin confirms the number before anything is saved.
//
// What counts as "the latest count": walking the channel's recent human messages from oldest to newest, a message is part of the count
// when it is the next number after the one before it (+1, or -1 in countdown, or what one of the modifier rules gives in modifiers mode). Chatter that
// happens to be a number does not line up with its neighbours, so it is ignored. After a mismatch two numbers in a row start a new chain
// (a reset), and a lone start number (1, or 100 in countdown) at the very end counts as a reset too.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { MAX_COUNTING_CHANNELS, COUNTDOWN_START, FLOOR_SIZE, MODE_EMOJI, MODE_LABEL, safeMode } = require('./config');
const { chanCache, channelsOf, getGuild, saveChan, hasPerm } = require('./state');
const { resetChannel, nextText, MODIFIERS } = require('./modes');
const { addCountingChannel, announce } = require('./ruin');
const { read, valueFor } = require('./input');
const { E, ep } = require('./ui');
const v2 = require('./v2');
const { cmd } = require('./mentions');

const HISTORY_LIMIT = 500, MAX_VALUE = 1e9;
const idCmp = (a, b) => (String(a.id).length - String(b.id).length) || String(a.id).localeCompare(String(b.id));

// Up to `max` recent messages of a channel, oldest first: [{ id, content, authorId, bot }].
async function fetchHistory(channel, max = HISTORY_LIMIT) {
    const out = [];
    let before = null;
    while (out.length < max) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!batch || !batch.size) break;
        const arr = [...batch.values()].sort((a, b) => idCmp(b, a));   // newest first
        out.push(...arr);
        before = arr[arr.length - 1].id;
        if (batch.size < 100) break;
    }
    return out.sort(idCmp).map(m => ({ id: m.id, content: m.content ?? '', authorId: m.author?.id ?? null, bot: !!m.author?.bot }));
}

// -> { found, value, userId, messageId, chain, ignoredAfter }
async function scan(history, g, mode) {
    const startVal = mode === 'countdown' ? COUNTDOWN_START : 1;
    // Modifiers mode: the next number has to be what one of Tick's own modifier rules gives after the previous one (primes, squares, every 3rd...), so a stray big number is not mistaken for a count.
    const isNext = (prev, v) => mode === 'countdown' ? v === prev - 1 : mode === 'modifiers' ? MODIFIERS.some(m => m.next(prev) === v) : v === prev + 1;
    let main = null, alt = null, ignored = 0;   // main: { value, userId, messageId, chain }, alt: a possible new chain after a mismatch
    for (const m of history) {
        if (m.bot || !m.content) continue;
        const r = await read(m.content.trim(), g).catch(() => null);
        if (!r || r.skip) continue;
        let v = r.value;
        if (r.isEq) {
            if (!main || !r.eq) continue;
            const s = r.eq.solve(mode === 'countdown' ? main.value - 1 : main.value + 1);
            v = s && (s.status === 'ok' || s.status === 'wrong') ? s.value : null;
        }
        if (v === null || !Number.isSafeInteger(v) || v < 0 || v > MAX_VALUE) continue;
        const hit = { value: v, userId: m.authorId, messageId: m.id, chain: 1 };
        if (main && isNext(main.value, v)) { main = { ...hit, chain: main.chain + 1 }; alt = null; ignored = 0; }
        else if (alt && isNext(alt.value, v)) { main = { ...hit, chain: 2 }; alt = null; ignored = 0; }
        else if (!main) main = hit;
        else { alt = hit; ignored++; }
    }
    // A lone start number after a mismatch is a reset: the count is back at its beginning.
    if (alt && alt.value === startVal) { main = alt; ignored = 0; }
    if (!main) return { found: false, ignoredAfter: 0 };
    const confident = main.chain >= 2 || main.value === startVal;
    return confident ? { found: true, ...main, ignoredAfter: ignored } : { found: false, ignoredAfter: ignored };
}

// Puts a channel at count n (0 or less: a fresh start) in its current mode.
function applyCount(c, n) {
    resetChannel(c, true);
    if (n > 0) {
        if (c.countType === 'countdown') c.current = n < 2 || n > c.countdownStart ? c.countdownStart + 1 : n;   // 1 finishes a cycle, which starts over
        else {
            c.current = n; if (n > c.highScore) c.highScore = n;
            if (c.countType === 'floors') c.checkpoint = Math.floor(n / FLOOR_SIZE) * FLOOR_SIZE;
        }
    }
    saveChan(c);
}

const buttons = (cid, mode, n, label) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tr_ok_${cid}_${mode}_${n}`).setLabel(label).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('tr_no').setLabel('Cancel').setStyle(ButtonStyle.Secondary));

async function run(interaction) {
    const gid = interaction.guild.id;
    if (!await hasPerm(interaction, gid)) return interaction.reply({ content: 'No permission.', ...ep() });
    const ch = interaction.options.getChannel('channel');
    await interaction.deferReply(ep());
    if (!ch.messages?.fetch) return interaction.editReply({ content: `<#${ch.id}> has no message history I can read (forum channels work through their posts). Pick a text or announcement channel.` });
    const existing = chanCache.get(ch.id);
    const mode = safeMode(interaction.options.getString('mode')) ?? existing?.countType ?? 'interactive';
    if (!existing && channelsOf(gid).length >= MAX_COUNTING_CHANNELS) return interaction.editReply({ content: `A server can have up to **${MAX_COUNTING_CHANNELS}** counting channels. Remove one first with ${cmd('counting channel')}.` });
    const need = { ViewChannel: 'View Channel', ReadMessageHistory: 'Read Message History', SendMessages: 'Send Messages', AddReactions: 'Add Reactions' };
    const have = ch.permissionsFor?.(interaction.guild.members.me);
    const missing = Object.entries(need).filter(([k]) => !have?.has(PermissionFlagsBits[k])).map(([, label]) => label);
    if (missing.length) return interaction.editReply({ content: `I'm missing permissions in <#${ch.id}>: **${missing.join(', ')}**.` });

    const g = await getGuild(gid);
    let res;
    try { res = await scan(await fetchHistory(ch), g, mode); }
    catch (e) { console.error('transfer scan:', e.message); return interaction.editReply({ content: `I couldn't read the history of <#${ch.id}>. Check my permissions there and try again.` }); }

    const label = `${MODE_EMOJI[mode]} ${MODE_LABEL[mode]}`;
    if (!res.found) {
        return interaction.editReply({ embeds: [v2.card({ title: 'Transfer count', blocks: [
            `I couldn't find a count in the last ${HISTORY_LIMIT} messages of <#${ch.id}>.`,
            `You can start fresh there in **${label}** mode instead.`,
        ] })], components: [buttons(ch.id, mode, 0, 'Start from the beginning')] });
    }
    const blocks = [`Latest count in <#${ch.id}>: **${res.value}**${res.userId ? ` by <@${res.userId}>` : ''}.`,
        `Confirm to set the count to **${res.value}** and start counting there in **${label}** mode.`];
    if (res.ignoredAfter) blocks.push(`${res.ignoredAfter} number message(s) after it didn't fit the count and were ignored. If the count was reset since, cancel and start fresh instead.`);
    return interaction.editReply({ embeds: [v2.card({ title: 'Transfer count', blocks, footer: 'Nothing is saved until you confirm' })], components: [buttons(ch.id, mode, res.value, 'Confirm')] });
}

// Buttons: tr_ok_<channel>_<mode>_<number> and tr_no. Returns true when the interaction was one of ours.
async function handle(interaction) {
    const id = interaction.customId;
    if (typeof id !== 'string' || !id.startsWith('tr_') || !interaction.guild) return false;
    const gid = interaction.guild.id;
    if (!await hasPerm(interaction, gid)) { await interaction.reply({ content: 'No permission.', ...ep() }); return true; }
    if (id === 'tr_no') { await interaction.update({ embeds: [v2.card({ title: 'Transfer count', blocks: ['Cancelled. Nothing was changed.'] })], components: [] }); return true; }
    const [, , cid, modeRaw, nRaw] = id.split('_'), mode = safeMode(modeRaw), n = Number(nRaw);
    if (!cid || !mode || !Number.isSafeInteger(n) || n < 0) return false;
    const guild = interaction.guild, ch = guild.channels.cache.get(cid);
    if (!ch) { await interaction.update({ embeds: [v2.card({ title: 'Transfer count', blocks: ['That channel no longer exists.'] })], components: [] }); return true; }
    await getGuild(gid);
    let c = chanCache.get(cid);
    if (!c) {
        const res = await addCountingChannel(guild, cid, mode, { quiet: true });
        if (res.error) { await interaction.update({ embeds: [E('#ff4444', 'Could not start counting').setDescription(res.error)], components: [] }); return true; }
        c = res.c;
    }
    c.countType = mode;
    applyCount(c, n);
    announce(guild, c, E('#5865F2', `${MODE_EMOJI[mode]} Counting starts here \u2014 ${MODE_LABEL[mode]} mode`).setDescription(n > 0 ? `Count carried over: the last count was **${n}**.\n${nextText(c)}.` : `Fresh start.\n${nextText(c)}.`));
    await interaction.update({ embeds: [v2.card({ title: 'Transfer count', blocks: [n > 0 ? `Done. <#${cid}> is at **${n}** in **${MODE_EMOJI[mode]} ${MODE_LABEL[mode]}** mode.` : `Done. <#${cid}> starts fresh in **${MODE_EMOJI[mode]} ${MODE_LABEL[mode]}** mode.`] })], components: [] });
    return true;
}

module.exports = { run, handle, scan, fetchHistory, applyCount };

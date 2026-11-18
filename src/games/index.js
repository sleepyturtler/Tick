// /game: a picker for the party games, plus routing for every button, dropdown and popup the games use.
// Custom ids look like  g:<gameId>:<action>[:arg...]   (g:pick = the picker dropdown, g:cont:<gameId> = a Continue button).
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, PermissionFlagsBits } = require('discord.js');
const { GAME_TTL_MIN, INVITE_TTL_MIN, BUMP_AFTER_MESSAGES, BUMP_MIN_SECONDS } = require('../config');
const client = require('../client');
const { cmd } = require('../mentions');
const { chanCache, countingIdFor } = require('../state');
const { E } = require('../ui');
const store = require('./store');
const elo = require('./elo');
const { EPH, newId, mention, displayName, reject, sendTo, editMessage, deleteMessage, withLock, textPayload, permsBlock } = require('./common');

const MODULES = {
    tictactoe: require('./tictactoe'),
    connect4: require('./connect4'),
    hangman: require('./hangman'),
    wyr: require('./wyr'),
    tod: require('./tod'),
    impostor: require('./impostor'),
    guesswho: require('./guesswho'),
    sinkship: require('./sinkship'),
};
const ORDER = ['tictactoe', 'connect4', 'hangman', 'wyr', 'tod', 'impostor', 'guesswho', 'sinkship'];

const command = new SlashCommandBuilder().setName('game').setDescription('Play a party game with the server');

function pickerPayload(userId, channelId) {
    const lines = ORDER.map(t => { const i = MODULES[t].info; return `${i.emoji} **${i.label}**\n${i.how}`; });
    const embed = E('#5865F2', '\u{1F3AE} Party games').setDescription(`Pick a game from the list below. Here is how each one works:\n\n${lines.join('\n\n')}`);
    const select = new StringSelectMenuBuilder().setCustomId('g:pick').setPlaceholder('Choose a game to start')
        .addOptions(ORDER.map(t => { const i = MODULES[t].info; return { label: i.label, description: i.short.slice(0, 100), value: t, emoji: i.emoji }; }));
    const rows = [new ActionRowBuilder().addComponents(select)];
    const mine = store.forUserInChannel(userId, channelId).filter(g => g.phase !== 'invite' && g.phase !== 'setup').slice(0, 5);
    if (mine.length) {
        rows.push(new ActionRowBuilder().addComponents(mine.map(g => new ButtonBuilder().setCustomId(`g:cont:${g.id}`).setLabel(`Continue: ${MODULES[g.type].info.label}`.slice(0, 80)).setStyle(ButtonStyle.Success))));
        embed.setFooter({ text: 'Your unfinished games in this channel have a Continue button.' });
    }
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`g:lb:${[...elo.RATED][0]}`).setLabel('Leaderboards').setStyle(ButtonStyle.Secondary)));
    return { embeds: [embed], components: rows };
}

// ---------- leaderboards (Elo is bot-wide) ----------
const LB_ORDER = ['tictactoe', 'connect4', 'guesswho', 'sinkship'];
async function lbPayload(type, userId) {
    const rows = await elo.top(type, 10), me = await elo.standing(type, userId), info = MODULES[type].info, medal = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];
    const lines = rows.length ? rows.map((r, i) => `${medal[i] ?? `**${i + 1}.**`} <@${r.user_id}> **${r.rating}**  (${r.wins}W ${r.losses}L ${r.draws}D)`).join('\n') : 'Nobody has played a rated game yet.';
    const select = new StringSelectMenuBuilder().setCustomId('g:lb:view').setPlaceholder('Choose a game').addOptions(LB_ORDER.map(t => ({ label: MODULES[t].info.label, value: t, emoji: MODULES[t].info.emoji, default: t === type })));
    return { embeds: [E('#fee75c', `${info.emoji} ${info.label}: Elo leaderboard`).setDescription(lines).setFooter({ text: `${me ? `You: #${me.rank}, rating ${me.rating}. ` : 'You have no rating here yet. '}Ratings are shared across every server.` })], components: [new ActionRowBuilder().addComponents(select)] };
}

// ---------- invitations (tic tac toe, connect 4, guess who, sink the ship) ----------
function invitePayload(game) {
    const info = MODULES[game.type].info;
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`g:${game.id}:accept`).setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`g:${game.id}:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
    const rated = elo.RATED.has(game.type);
    if (rated) row.addComponents(new ButtonBuilder().setCustomId(`g:${game.id}:mode`).setLabel(game.friendly ? 'Mode: Friendly' : 'Mode: Ranked').setStyle(ButtonStyle.Primary));
    const preset = MODULES[game.type].presetText?.(game);
    const modeLine = rated ? `\nMode: ${game.friendly ? '\u{1F91D} **Friendly** (no Elo)' : '\u{1F4C8} **Ranked** (Elo counts)'}. The host can switch it with the Mode button before someone accepts.` : '';
    return { embeds: [E('#5865F2', `${info.emoji} ${info.label}: invitation`).setDescription(`${mention(game.hostId)} wants to play **${info.label}**.${preset ? `\n${preset}` : ''}${modeLine}\nPress **Accept** to join. ${info.how}`).setFooter({ text: `The invitation expires in ${INVITE_TTL_MIN} minutes.` })], components: [row] };
}
// Used by the games that start with an invitation. Posts it in the channel and tells the host.
async function postInvite(interaction, type, extra = {}) {
    const game = { id: newId(), type, guildId: interaction.guild.id, channelId: interaction.channelId, messageId: null, hostId: interaction.user.id, hostName: displayName(interaction), userIds: [interaction.user.id], phase: 'invite', state: {}, createdAt: Date.now(), ...extra };
    const msg = await sendTo(game.channelId, invitePayload(game));
    game.messageId = msg.id;
    store.add(game);
    await interaction.update({ embeds: [E('#57f287', 'Invitation sent').setDescription(`Waiting for someone to press Accept in the channel.`)], components: [] });
    return game;
}

// ---------- picking a game ----------
async function onPick(interaction) {
    const type = interaction.values[0], mod = MODULES[type];
    if (!mod) return;
    if (chanCache.has(countingIdFor(interaction.channelId))) return interaction.update({ embeds: [E('#ff4444', 'Not in a counting channel').setDescription('Start games in a different channel.')], components: [] });
    const blocked = permsBlock(interaction); if (blocked) return interaction.update({ embeds: [E('#ff4444', 'Missing permissions').setDescription(blocked.content)], components: [] });
    await mod.start(interaction, { postInvite });
}

const payloadFor = async game => (game.phase === 'invite' ? invitePayload(game) : MODULES[game.type].payload(game));
// Sends the game's message again at the bottom of the channel and deletes the old one.
async function repost(game) {
    return withLock(game.id, async () => {
        if (!store.get(game.id) || !game.messageId) return false;
        const old = game.messageId;
        const msg = await sendTo(game.channelId, await payloadFor(game));
        game.messageId = msg.id; store.save(game, { touch: false });   // moving the message is not a move: the idle timer keeps running
        bumps.set(game.id, { count: 0, last: Date.now() });
        await deleteMessage(game.channelId, old);
        return true;
    });
}

// ---------- keep games near the bottom ----------
// Every BUMP_AFTER_MESSAGES other messages in the channel, a game's message is re-posted at the bottom (at most once per BUMP_MIN_SECONDS).
const bumps = new Map();   // gameId -> { count, last }
function noteMessage(message) {
    if (!message.guild || message.author?.id === client.user?.id) return;
    const now = Date.now();
    for (const g of store.all()) {
        if (g.channelId !== message.channelId || !g.messageId || g.phase === 'setup') continue;
        const b = bumps.get(g.id) ?? { count: 0, last: g.updatedAt };
        b.count++; bumps.set(g.id, b);
        if (b.count >= BUMP_AFTER_MESSAGES && now - b.last >= BUMP_MIN_SECONDS * 1000) {
            b.count = 0; b.last = now;
            setImmediate(() => repost(g).catch(e => console.error('repost game:', e.message)));
        }
    }
}

async function onContinue(interaction, gameId) {
    const game = store.get(gameId);
    if (!game) return interaction.update({ embeds: [E('#ff4444', 'That game is over').setDescription('It ended or expired.')], components: [] });
    if (!game.userIds.includes(interaction.user.id)) return reject(interaction, "You're not in that game.");
    const mod = MODULES[game.type];
    if (mod.resume) return mod.resume(interaction, game);
    // default: put the game's message back at the bottom of the channel
    await repost(game);
    return interaction.update({ embeds: [E('#57f287', 'Back on screen').setDescription('The game was re-posted at the bottom of the channel.')], components: [] });
}

// ---------- the one entry point used by the bot ----------
async function handleInteraction(interaction) {
    if (interaction.isChatInputCommand?.() && interaction.commandName === 'game') {
        if (!interaction.guild) { await interaction.reply({ content: 'Server only.', ...EPH }); return true; }
        if (chanCache.has(countingIdFor(interaction.channelId))) { await interaction.reply({ content: "Games can't be started in a counting channel. Use another channel.", ...EPH }); return true; }
        const blocked = permsBlock(interaction); if (blocked) { await interaction.reply(blocked); return true; }
        await interaction.reply({ ...pickerPayload(interaction.user.id, interaction.channelId), ...EPH });
        return true;
    }
    const cid = interaction.customId;
    if (typeof cid !== 'string' || !cid.startsWith('g:')) return false;
    const [, gid, action, ...args] = cid.split(':');
    try {
        if (gid === 'pick') return (await onPick(interaction), true);
        if (gid === 'cont') return (await onContinue(interaction, action), true);
        if (gid === 'lb') {
            const type = interaction.isStringSelectMenu?.() ? interaction.values[0] : action;
            if (!LB_ORDER.includes(type)) return true;
            const p = await lbPayload(type, interaction.user.id);
            if (interaction.isStringSelectMenu?.()) await interaction.update(p); else await interaction.reply({ ...p, ...EPH });
            return true;
        }
        const game = store.get(gid);
        if (!game) { await reject(interaction, `This game is over or has expired. Start a new one with ${cmd('game')}.`); return true; }
        const mod = MODULES[game.type];
        // The game may have ended (expired, been stopped) while this press was waiting its turn for the game's lock.
        const gone = () => reject(interaction, `This game is over or has expired. Start a new one with ${cmd('game')}.`);
        const alive = () => store.get(game.id) === game;
        if (action === 'stop') { await withLock(game.id, () => (alive() ? askStop(interaction, game) : gone())); return true; }
        if (action === 'stopok' || action === 'stopno') { await withLock(game.id, () => (alive() || action === 'stopno' ? answerStop(interaction, game, mod, action, args) : gone())); return true; }
        if (action === 'forfeit') { await withLock(game.id, () => (alive() ? askForfeit(interaction, game) : gone())); return true; }
        if (action === 'forfeitok' || action === 'forfeitno') { await withLock(game.id, () => (alive() || action === 'forfeitno' ? answerForfeit(interaction, game, mod, action, args) : gone())); return true; }
        if ((action === 'accept' || action === 'cancel' || action === 'mode') && game.phase !== 'invite') { await reject(interaction, action === 'mode' ? 'The game already started, so the mode is locked.' : 'Someone already took this invitation.'); return true; }
        if (game.phase === 'invite' && (action === 'accept' || action === 'cancel' || action === 'mode')) {
            await withLock(game.id, async () => {
                if (!alive()) return gone();
                if (game.phase !== 'invite') return reject(interaction, 'Someone already took this invitation.');
                if (action === 'mode') {
                    if (interaction.user.id !== game.hostId) return reject(interaction, 'Only the host can change the mode.');
                    game.friendly = !game.friendly; store.save(game);
                    return interaction.update(invitePayload(game));
                }
                if (action === 'cancel') {
                    if (interaction.user.id !== game.hostId) return reject(interaction, 'Only the person who started it can cancel.');
                    store.remove(game);
                    return interaction.update(textPayload(`${mod.info.emoji} **${mod.info.label}**: the invitation was cancelled.`));
                }
                if (interaction.user.id === game.hostId) return reject(interaction, "You can't accept your own invitation.");
                if (interaction.user.bot) return;
                game.userIds.push(interaction.user.id); game.guestId = interaction.user.id; game.guestName = displayName(interaction); game.phase = 'play';
                if (elo.RATED.has(game.type) && !game.friendly) game.elo = await elo.ratings(game.type, game.userIds);   // ratings shown next to the names (friendly games show none)
                return mod.onAccept(interaction, game);
            });
            return true;
        }
        await withLock(game.id, () => (alive() ? mod.handle(interaction, game, action, args) : gone()));
    } catch (e) {
        console.error('game interaction:', e);
        try { if (interaction.deferred || interaction.replied) await interaction.followUp({ content: 'Something went wrong with that game.', ...EPH }); else await interaction.reply({ content: 'Something went wrong with that game.', ...EPH }); } catch {}
    }
    return true;
}

// Typed letters for hangman (and nothing else). Returns true when the message was a guess.
async function handleMessage(message) {
    let consumed = false;
    try { consumed = await MODULES.hangman.onMessage(message); }
    catch (e) { console.error('hangman message:', e.message); }
    if (!consumed) { try { noteMessage(message); } catch (e) { console.error('note message:', e.message); } }
    return consumed;
}

// ---------- stopping a game ----------
// Any player, the host or a moderator can stop a game. In a rated 1v1 game, once both players have made a move, stopping
// counts as the presser conceding (a loss for Elo). Before that, or when a moderator stops it, nothing is rated.
// ---------- stop button ----------
// Stop asks first: a private question only the person who pressed can answer, so a stray tap never ends a game.
// In a ranked 1v1 game where both players have moved, stopping is a concession (the other player wins, Elo is recorded);
// anywhere else nobody wins. The question says which of the two it is, and if the answer changed while it was open
// (the opponent moved in the meantime) the question is asked again instead of conceding behind the player's back.
const canStop = (game, interaction) => {
    const uid = interaction.user.id, perms = interaction.member?.permissions;
    const isPlayer = game.userIds.includes(uid) || uid === game.hostId, isMod = perms?.has?.(PermissionFlagsBits.ManageMessages) || perms?.has?.(PermissionFlagsBits.Administrator);
    return isPlayer || isMod;
};
function wouldConcede(game, mod, uid) {
    if (!elo.RATED.has(game.type) || game.friendly || game.userIds.length !== 2 || !game.userIds.includes(uid)) return false;
    const mv = mod.moved?.(game) ?? {};
    return game.userIds.every(id => (mv[id] ?? 0) >= 1);
}
const promptCard = (title, body, ...buttons) => ({ embeds: [E('', title).setDescription(body)], components: buttons.length ? [new ActionRowBuilder().addComponents(...buttons)] : [] });
function stopPrompt(game, mod, uid) {
    const concede = wouldConcede(game, mod, uid);
    return promptCard('Stop Game', concede ? 'Stop and concede? Your opponent wins and you lose Elo.' : 'Stop this game? Nobody wins.',
        new ButtonBuilder().setCustomId(`g:${game.id}:stopok:${uid}:${concede ? 1 : 0}`).setLabel('Yes, stop').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`g:${game.id}:stopno:${uid}`).setLabel('Keep playing').setStyle(ButtonStyle.Secondary));
}
async function askStop(interaction, game) {
    if (game.phase === 'invite') return reject(interaction, 'Use Cancel on an invitation.');
    if (!canStop(game, interaction)) return reject(interaction, 'Only the players, the host or a moderator can stop this game.');
    return interaction.reply({ ...stopPrompt(game, MODULES[game.type], interaction.user.id), ...EPH });
}
async function answerStop(interaction, game, mod, action, args) {
    const uid = args[0];
    if (interaction.user.id !== uid) return reject(interaction, 'That question was for someone else.');
    if (action === 'stopno') return interaction.update(promptCard('Stop Game', 'Okay, the game goes on.'));
    if (game.phase === 'invite') return reject(interaction, 'Use Cancel on an invitation.');
    if (!canStop(game, interaction)) return reject(interaction, 'Only the players, the host or a moderator can stop this game.');
    const concede = wouldConcede(game, mod, uid);
    if (concede && args[1] !== '1') return interaction.update(stopPrompt(game, mod, uid));   // the answer changed while the question was open: ask again
    let forfeit = null;
    if (concede) {
        const winner = game.userIds.find(id => id !== uid);
        forfeit = { winner, loser: uid };
        game.eloResult = await elo.settle(game, winner, uid);
    }
    try { mod.onStop?.(game, { by: uid, forfeit }); mod.onExpire?.(game); } catch (e) { console.error('stop game:', e.message); }
    store.remove(game);
    const lines = [`${mod.info.emoji} **${mod.info.label}**: stopped by ${mention(uid)}.`];
    if (forfeit) lines.push(`${mention(uid)} conceded, so ${mention(forfeit.winner)} wins.`);
    if (game.eloResult) lines.push(elo.resultLine(game.eloResult));
    await interaction.update(promptCard('Stop Game', 'You stopped the game.'));
    await editMessage(game, textPayload(lines.join('\n')));
}

// ---------- forfeit button ----------
// Any player of a 1v1 game can forfeit once it has started. A confirmation only they can answer comes first, so a stray tap
// on a phone costs nothing. The player who forfeits loses, the other wins; ranked games record Elo (and respect the cooldown),
// friendly games record nothing.
async function askForfeit(interaction, game) {
    if (game.phase === 'invite') return reject(interaction, 'Use Cancel on an invitation.');
    if (!game.userIds.includes(interaction.user.id)) return reject(interaction, "You're not in this game.");
    return interaction.reply({ ...promptCard('Forfeit', game.friendly ? 'Forfeit this game? Your opponent wins.' : 'Forfeit this game? Your opponent wins and you lose Elo.',
        new ButtonBuilder().setCustomId(`g:${game.id}:forfeitok:${interaction.user.id}`).setLabel('Yes, forfeit').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`g:${game.id}:forfeitno:${interaction.user.id}`).setLabel('Keep playing').setStyle(ButtonStyle.Secondary)), ...EPH });
}
async function answerForfeit(interaction, game, mod, action, args) {
    const who = args[0];
    if (interaction.user.id !== who) return reject(interaction, 'That question was for someone else.');
    if (action === 'forfeitno') return interaction.update(promptCard('Forfeit', 'Okay, the game goes on.'));
    if (!game.userIds.includes(who)) return reject(interaction, "You're not in this game.");
    const winner = game.userIds.find(id => id !== who);
    if (!winner) return reject(interaction, 'There is nobody to forfeit to yet.');
    game.eloResult = await elo.settle(game, winner, who);
    try { mod.onStop?.(game, { by: who, forfeit: { winner, loser: who } }); mod.onExpire?.(game); } catch (e) { console.error('forfeit game:', e.message); }
    store.remove(game);
    await interaction.update(promptCard('Forfeit', 'You forfeited.'));
    await editMessage(game, textPayload(`${mod.info.emoji} **${mod.info.label}**: \u{1F3F3}\uFE0F ${mention(who)} forfeited, so ${mention(winner)} wins.${game.eloResult ? `\n${elo.resultLine(game.eloResult)}` : ''}`));
}

// ---------- expiry ----------
// How long a game may sit with no move. Every move saves the game, which restarts this clock (re-posting the message does not).
// Invitations and the word setup of party games get the short invitation time. A rated game keeps the full time while players
// are still voting or placing ships, because someone who loses on time loses Elo.
const ttlMs = g => (g.phase === 'invite' || (g.phase === 'setup' && !elo.RATED.has(g.type)) ? INVITE_TTL_MIN : GAME_TTL_MIN) * 60_000;

// When a rated 1v1 game expires, the player it was waiting on forfeits: they lose, the other player wins, and Elo is recorded.
// If it was waiting on both (neither had voted, picked or placed yet) or on neither, nobody wins and no rating changes.
async function expire(game) {
    return withLock(game.id, async () => {
        // checked again inside the lock: a move that landed while this was queued means the game is still alive
        if (!store.get(game.id) || Date.now() - game.updatedAt <= ttlMs(game)) return;
        const mod = MODULES[game.type];
        let forfeit = null;
        if (game.phase !== 'invite' && elo.RATED.has(game.type) && game.userIds.length === 2) {
            const waiting = mod.waitingOn?.(game) ?? [];
            if (waiting.length === 1 && game.userIds.includes(waiting[0])) {
                forfeit = { loser: waiting[0], winner: game.userIds.find(id => id !== waiting[0]) };
                game.eloResult = await elo.settle(game, forfeit.winner, forfeit.loser);
            }
        }
        try { mod.onExpire?.(game); } catch {}
        store.remove(game);
        const head = `${mod.info.emoji} **${mod.info.label}**:`;
        const text = game.phase === 'invite' ? `${head} the invitation expired.`
            : forfeit ? `${head} \u231B ${mention(forfeit.loser)} ran out of time, so ${mention(forfeit.winner)} wins.${game.eloResult ? `\n${elo.resultLine(game.eloResult)}` : ''}`
                : `${head} this game expired after a period with no activity.`;
        await editMessage(game, textPayload(text));
    });
}
function sweep() {
    const now = Date.now();
    for (const id of bumps.keys()) if (!store.get(id)) bumps.delete(id);
    for (const g of store.all()) {
        if (now - g.updatedAt > ttlMs(g)) expire(g).catch(e => console.error('expire game:', e.message));
    }
}

async function init() {
    await elo.init();
    const restored = await store.init();
    // Time the bot was down is nobody's fault: every restored game gets a fresh idle timer, so nobody forfeits because of a restart.
    for (const g of restored) { store.save(g); try { MODULES[g.type]?.onRestore?.(g); } catch (e) { console.error('restore game:', e.message); } }
    setInterval(() => elo.cleanup(), 60 * 60_000).unref();
    setInterval(sweep, 30_000).unref();
    // Messages from before the V2 update cannot be edited into V2, so every restored game is re-posted as a fresh message. The idle
    // timer is not touched by it. A message that is already V2 is posted again too, which is harmless and keeps this simple.
    for (const g of restored) { try { await repost(g); } catch (e) { console.error('repost restored game:', e.message); } }
    if (restored.length) console.log(`Restored ${restored.length} saved game(s)`);
}

module.exports = { command, handleInteraction, handleMessage, init, MODULES, ORDER, pickerPayload, invitePayload, sweep, repost, expire, ttlMs, leaderboard: lbPayload };

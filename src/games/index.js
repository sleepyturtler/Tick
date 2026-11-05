// /game: a picker for the party games, plus routing for every button, dropdown and popup the games use.
// Custom ids look like  g:<gameId>:<action>[:arg...]   (g:pick = the picker dropdown, g:cont:<gameId> = a Continue button).
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { GAME_TTL_MIN, INVITE_TTL_MIN } = require('../config');
const { chanCache, countingIdFor } = require('../state');
const { E } = require('../ui');
const store = require('./store');
const { EPH, newId, mention, displayName, reject, sendTo, editMessage, deleteMessage, withLock } = require('./common');

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
    return { embeds: [embed], components: rows };
}

// ---------- invitations (tic tac toe, connect 4, guess who, sink the ship) ----------
const INVITE_TEXT = { tictactoe: 'Tic tac toe', connect4: 'Connect 4', guesswho: 'Guess Who', sinkship: 'Sink the Ship' };
function invitePayload(game) {
    const info = MODULES[game.type].info;
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`g:${game.id}:accept`).setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`g:${game.id}:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
    return { embeds: [E('#5865F2', `${info.emoji} ${info.label}: invitation`).setDescription(`${mention(game.hostId)} wants to play **${info.label}**.\nPress **Accept** to join. ${info.how}`).setFooter({ text: `The invitation expires in ${INVITE_TTL_MIN} minutes.` })], components: [row] };
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
    await mod.start(interaction, { postInvite });
}

async function onContinue(interaction, gameId) {
    const game = store.get(gameId);
    if (!game) return interaction.update({ embeds: [E('#ff4444', 'That game is over').setDescription('It ended or expired.')], components: [] });
    if (!game.userIds.includes(interaction.user.id)) return reject(interaction, "You're not in that game.");
    const mod = MODULES[game.type];
    if (mod.resume) return mod.resume(interaction, game);
    // default: put the game's message back at the bottom of the channel
    await withLock(game.id, async () => {
        const old = game.messageId;
        const msg = await sendTo(game.channelId, await mod.payload(game));
        game.messageId = msg.id; store.save(game);
        await deleteMessage(game.channelId, old);
    });
    return interaction.update({ embeds: [E('#57f287', 'Back on screen').setDescription('The game was re-posted at the bottom of the channel.')], components: [] });
}

// ---------- the one entry point used by the bot ----------
async function handleInteraction(interaction) {
    if (interaction.isChatInputCommand?.() && interaction.commandName === 'game') {
        if (!interaction.guild) { await interaction.reply({ content: 'Server only.', ...EPH }); return true; }
        if (chanCache.has(countingIdFor(interaction.channelId))) { await interaction.reply({ content: "Games can't be started in a counting channel. Use another channel.", ...EPH }); return true; }
        await interaction.reply({ ...pickerPayload(interaction.user.id, interaction.channelId), ...EPH });
        return true;
    }
    const cid = interaction.customId;
    if (typeof cid !== 'string' || !cid.startsWith('g:')) return false;
    const [, gid, action, ...args] = cid.split(':');
    try {
        if (gid === 'pick') return (await onPick(interaction), true);
        if (gid === 'cont') return (await onContinue(interaction, action), true);
        const game = store.get(gid);
        if (!game) { await reject(interaction, 'This game is over or has expired. Start a new one with `/game`.'); return true; }
        const mod = MODULES[game.type];
        if ((action === 'accept' || action === 'cancel') && game.phase !== 'invite') { await reject(interaction, 'Someone already took this invitation.'); return true; }
        if (game.phase === 'invite' && (action === 'accept' || action === 'cancel')) {
            await withLock(game.id, async () => {
                if (game.phase !== 'invite') return reject(interaction, 'Someone already took this invitation.');
                if (action === 'cancel') {
                    if (interaction.user.id !== game.hostId) return reject(interaction, 'Only the person who started it can cancel.');
                    store.remove(game);
                    return interaction.update({ embeds: [E('#80848e', `${mod.info.emoji} ${mod.info.label}`).setDescription('The invitation was cancelled.')], components: [] });
                }
                if (interaction.user.id === game.hostId) return reject(interaction, "You can't accept your own invitation.");
                if (interaction.user.bot) return;
                game.userIds.push(interaction.user.id); game.guestId = interaction.user.id; game.guestName = displayName(interaction); game.phase = 'play';
                return mod.onAccept(interaction, game);
            });
            return true;
        }
        await withLock(game.id, () => mod.handle(interaction, game, action, args));
    } catch (e) {
        console.error('game interaction:', e);
        try { if (interaction.deferred || interaction.replied) await interaction.followUp({ content: 'Something went wrong with that game.', ...EPH }); else await interaction.reply({ content: 'Something went wrong with that game.', ...EPH }); } catch {}
    }
    return true;
}

// Typed letters for hangman (and nothing else). Returns true when the message was a guess.
async function handleMessage(message) {
    try { return await MODULES.hangman.onMessage(message); }
    catch (e) { console.error('hangman message:', e.message); return false; }
}

// ---------- expiry ----------
async function expire(game) {
    const mod = MODULES[game.type];
    try { mod.onExpire?.(game); } catch {}
    store.remove(game);
    const text = game.phase === 'invite' ? 'The invitation expired.' : 'This game expired after a period with no activity.';
    await editMessage(game, { embeds: [E('#80848e', `${mod.info.emoji} ${mod.info.label}`).setDescription(text)], components: [], attachments: [] });
}
function sweep() {
    const now = Date.now();
    for (const g of store.all()) {
        const ttl = (g.phase === 'invite' || g.phase === 'setup' ? INVITE_TTL_MIN : GAME_TTL_MIN) * 60_000;
        if (now - g.updatedAt > ttl) expire(g).catch(e => console.error('expire game:', e.message));
    }
}

async function init() {
    const restored = await store.init();
    for (const g of restored) { try { MODULES[g.type]?.onRestore?.(g); } catch (e) { console.error('restore game:', e.message); } }
    setInterval(sweep, 30_000).unref();
    if (restored.length) console.log(`Restored ${restored.length} saved game(s)`);
}

module.exports = { command, handleInteraction, handleMessage, init, MODULES, ORDER, pickerPayload, sweep };

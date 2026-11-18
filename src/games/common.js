// Small helpers shared by every game.
const { AttachmentBuilder, MessageFlags, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const client = require('../client');
const v2 = require('../v2');

const EPH = { flags: [MessageFlags.Ephemeral] };
const newId = () => Math.random().toString(36).slice(2, 10);
const png = (buffer, name) => new AttachmentBuilder(buffer, { name });
const mention = id => `<@${id}>`;
const displayName = i => i.member?.displayName ?? i.user.globalName ?? i.user.username;
const reject = (i, content) => i.reply({ content, ...EPH });
// Replaces every attachment on a message with the given files (used when a board image changes).
const withFiles = (payload, files) => ({ ...payload, files, attachments: [] });
// What a finished game's message turns into: one small card, no board, no buttons. Mentions in it never ping.
// text is "emoji **Label**: body" and becomes a title (the label) and a body.
const textPayload = text => v2.endCard(text);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const shuffle = arr => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

async function getChannel(id) { return client.channels.cache.get(id) ?? await client.channels.fetch(id).catch(() => null); }
async function sendTo(channelId, payload) {
    const ch = await getChannel(channelId);
    if (!ch) throw new Error('channel not found');
    return ch.send(v2.convert(payload));
}
// Edit the game's public message with the bot's own token, so it works even when no interaction is at hand (timers, the other player's move).
async function editMessage(game, payload) {
    const ch = await getChannel(game.channelId);
    if (!ch || !game.messageId) return null;
    return ch.messages.edit(game.messageId, v2.convert(payload)).catch(e => { console.error('game edit:', e.message); return null; });
}
async function deleteMessage(channelId, messageId) {
    const ch = await getChannel(channelId);
    if (ch && messageId) await ch.messages.delete(messageId).catch(() => {});
}

// Runs fn one at a time per key, so two quick moves in the same game can't interleave.
const locks = new Map();
function withLock(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    locks.set(key, next);
    next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
    return next;
}

// The Stop button every game carries. Who may press it is decided in index.js.
const stopButton = game => new ButtonBuilder().setCustomId(`g:${game.id}:stop`).setLabel('Stop Game').setStyle(ButtonStyle.Danger);

// The Forfeit button of the four 1v1 games. Pressing it asks for confirmation first (see index.js).
const ONE_V_ONE = new Set(['tictactoe', 'connect4', 'guesswho', 'sinkship']);
const forfeitButton = game => new ButtonBuilder().setCustomId(`g:${game.id}:forfeit`).setLabel('Forfeit').setStyle(ButtonStyle.Danger);
// Stop for every game, plus Forfeit in the 1v1 games. Spread it into a row: addComponents(...endButtons(game)).
const endButtons = game => (ONE_V_ONE.has(game.type) ? [stopButton(game), forfeitButton(game)] : [stopButton(game)]);

// Every game posts its board as a message with an image, so these are needed in the channel. Returns the names of the ones Tick lacks.
// (appPermissions is what Discord says Tick may do in this channel; when neither it nor the channel can tell, nothing is blocked.)
function missingPerms(interaction) {
    const p = interaction.appPermissions ?? interaction.channel?.permissionsFor?.(interaction.guild?.members?.me);
    if (!p || typeof p.has !== 'function') return [];
    const thread = !!interaction.channel?.isThread?.();
    const need = [['ViewChannel', 'View Channel'], [thread ? 'SendMessagesInThreads' : 'SendMessages', thread ? 'Send Messages in Threads' : 'Send Messages'], ['AttachFiles', 'Attach Files']];
    return need.filter(([flag]) => !p.has(PermissionFlagsBits[flag])).map(([, label]) => label);
}
// The reply for a channel where games cannot run, or null when everything needed is there.
function permsBlock(interaction) {
    const missing = missingPerms(interaction);
    return missing.length ? { content: `I can't run games here: I'm missing **${missing.join(', ')}** in this channel. Give me ${missing.length > 1 ? 'those permissions' : 'that permission'} and try again.`, ...EPH } : null;
}

module.exports = { missingPerms, permsBlock, textPayload, stopButton, forfeitButton, endButtons, EPH, newId, png, mention, displayName, reject, withFiles, pick, shuffle, getChannel, sendTo, editMessage, deleteMessage, withLock };

// Small helpers shared by every game.
const { AttachmentBuilder, MessageFlags } = require('discord.js');
const client = require('../client');

const EPH = { flags: [MessageFlags.Ephemeral] };
const newId = () => Math.random().toString(36).slice(2, 10);
const png = (buffer, name) => new AttachmentBuilder(buffer, { name });
const mention = id => `<@${id}>`;
const displayName = i => i.member?.displayName ?? i.user.globalName ?? i.user.username;
const reject = (i, content) => i.reply({ content, ...EPH });
// Replaces every attachment on a message with the given files (used when a board image changes).
const withFiles = (payload, files) => ({ ...payload, files, attachments: [] });
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const shuffle = arr => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

async function getChannel(id) { return client.channels.cache.get(id) ?? await client.channels.fetch(id).catch(() => null); }
async function sendTo(channelId, payload) {
    const ch = await getChannel(channelId);
    if (!ch) throw new Error('channel not found');
    return ch.send(payload);
}
// Edit the game's public message with the bot's own token, so it works even when no interaction is at hand (timers, the other player's move).
async function editMessage(game, payload) {
    const ch = await getChannel(game.channelId);
    if (!ch || !game.messageId) return null;
    return ch.messages.edit(game.messageId, payload).catch(e => { console.error('game edit:', e.message); return null; });
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

module.exports = { EPH, newId, png, mention, displayName, reject, withFiles, pick, shuffle, getChannel, sendTo, editMessage, deleteMessage, withLock };

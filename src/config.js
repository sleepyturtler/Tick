const { PermissionFlagsBits, PermissionsBitField, ChannelType } = require('discord.js');

const envInt = (name, def) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n > 0 ? n : def; };

const PS = 25, SLB_MAX = 100;
const COUNTDOWN_START = 100, FLOOR_SIZE = 100;
const MAX_COUNTING_CHANNELS = envInt('MAX_COUNTING_CHANNELS', 10);
const MAX_SAVES = envInt('MAX_SAVES', 5);
const MODES = ['interactive', 'simple', 'countdown', 'modifiers', 'floors'];
const safeMode = m => MODES.includes(m) ? m : null;
const usesSaves = t => t === 'interactive' || t === 'modifiers' || t === 'floors';

const LEGACY_GUILD_KEYS = ['channelId', 'current', 'lastUserId', 'consecutiveCount', 'highScore', 'countType', 'countdownCycles', 'countdownStart', 'randomModifier', 'randomModifierLabel', 'pendingSave'];

const MODE_EMOJI = { interactive:'🎮', simple:'🟢', countdown:'⏳', modifiers:'🎲', floors:'🏢' };
const MODE_LABEL = { interactive:'Interactive', simple:'Simple', countdown:'Countdown', modifiers:'Modifiers', floors:'Floors' };
const MODE_CHOICES = MODES.map(m => ({ name: MODE_LABEL[m], value: m }));
const COUNTING_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum];
const NE = ['0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];

const SUPPORT_URL = 'https://discord.gg/Qrp82cRhUW';

const INVITE_PERMS = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageRoles,
]).bitfield.toString();

// ---------- football player counting (EA FC ratings) ----------
// Hardcoded on purpose: bump this one number when a new FC game comes out. Env var LATEST_FC overrides it.
const LATEST_FC = envInt('LATEST_FC', 27);
// Community EA FC ratings API. Override the base URL with FC_API_BASE if it ever moves.
const FC_API_BASE = (process.env.FC_API_BASE || 'https://api.msmc.cc/api/eafc').replace(/\/+$/, '');
// Max outgoing lookups per minute (cached answers don't count). Protects the API and the free-tier box.
const FC_RATE_PER_MIN = envInt('FC_RATE_PER_MIN', 30);

module.exports = {
    envInt, PS, SLB_MAX, COUNTDOWN_START, FLOOR_SIZE, MAX_COUNTING_CHANNELS, MAX_SAVES, MODES, safeMode, usesSaves,
    LEGACY_GUILD_KEYS, MODE_EMOJI, MODE_LABEL, MODE_CHOICES, COUNTING_CHANNEL_TYPES, NE, SUPPORT_URL, INVITE_PERMS,
    LATEST_FC, FC_API_BASE, FC_RATE_PER_MIN,
};

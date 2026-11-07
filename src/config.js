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
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageRoles,
]).bitfield.toString();

// ---------- football player counting (EA FC ratings) ----------
// Newest game whose ratings are loaded in the fc_players table; a bare player name uses this game.
// Hardcoded on purpose: bump this one number after importing a new FC game. Env var LATEST_FC overrides it.
const LATEST_FC = envInt('LATEST_FC', 27);
// Load any ratings game from the sql/ folder that is missing from the database when the bot starts. FC_AUTOLOAD=0 turns it off.
const FC_AUTOLOAD = process.env.FC_AUTOLOAD !== '0';

// ---------- party games (/game) ----------
// Hardcoded on purpose, each can be overridden by an env var of the same name.
const GAME_TTL_MIN = envInt('GAME_TTL_MIN', 30);          // a game with no activity for this long expires; saved games older than this are dropped on restart
const INVITE_TTL_MIN = envInt('INVITE_TTL_MIN', 5);       // an unanswered invitation expires after this long
const DISCUSS_SECONDS = envInt('DISCUSS_SECONDS', 120);   // Impostor discussion round
const VOTE_SECONDS = envInt('VOTE_SECONDS', 60);          // Impostor voting round
const WYR_MIN_SECONDS = envInt('WYR_MIN_SECONDS', 15);    // Would you rather: a question stays up at least this long before Next works
const BUMP_AFTER_MESSAGES = envInt('BUMP_AFTER_MESSAGES', 5);   // a game message is re-posted at the bottom once this many other messages have appeared after it
const BUMP_MIN_SECONDS = envInt('BUMP_MIN_SECONDS', 20);        // ...but never more often than this per game

module.exports = {
    GAME_TTL_MIN, INVITE_TTL_MIN, DISCUSS_SECONDS, VOTE_SECONDS, WYR_MIN_SECONDS, BUMP_AFTER_MESSAGES, BUMP_MIN_SECONDS,
    envInt, PS, SLB_MAX, COUNTDOWN_START, FLOOR_SIZE, MAX_COUNTING_CHANNELS, MAX_SAVES, MODES, safeMode, usesSaves,
    LEGACY_GUILD_KEYS, MODE_EMOJI, MODE_LABEL, MODE_CHOICES, COUNTING_CHANNEL_TYPES, NE, SUPPORT_URL, INVITE_PERMS,
    LATEST_FC, FC_AUTOLOAD,
};

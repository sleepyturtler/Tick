// Minimal stand-in for discord.js, only for the offline test suite. Builders record what they are given so tests can read it back.
const { EventEmitter } = require('events');
function builder(name) {
    return class {
        constructor(d) {
            this.data = { ...(d || {}) }; this.kind = name;
            const self = new Proxy(this, { get: (t, p) => {
                if (p in t || typeof p === 'symbol') return t[p];
                if (/^set[A-Z]/.test(p)) return v => { t.data[p[3].toLowerCase() + p.slice(4)] = v; return self; };
                if (/^add[A-Z]/.test(p)) return (...v) => { const k = p[3].toLowerCase() + p.slice(4); (t.data[k] ??= []).push(...v.flat().map(x => (typeof x === 'function' ? x(new (builder('Sub'))()) : x))); return self; };
                return undefined;
            } });
            return self;
        }
        toJSON() { return this.data; }
    };
}
const names = ['EmbedBuilder', 'ActionRowBuilder', 'ButtonBuilder', 'StringSelectMenuBuilder', 'ModalBuilder', 'TextInputBuilder', 'AttachmentBuilder', 'SlashCommandBuilder', 'SlashCommandSubcommandBuilder', 'ContextMenuCommandBuilder'];
const out = Object.fromEntries(names.map(n => [n, builder(n)]));
const enumProxy = () => new Proxy({}, { get: (_, p) => (typeof p === 'string' ? 1 : undefined) });
class Client extends EventEmitter {
    constructor() { super(); this.channels = { cache: new Map(), fetch: async id => this.channels.cache.get(id) ?? null }; this.guilds = { cache: new Map(), fetch: async () => null }; this.user = { id: 'botid' }; }
}
class PermissionsBitField { constructor() { this.bitfield = 0n; } }
module.exports = {
    ...out, Client, PermissionsBitField,
    PermissionFlagsBits: new Proxy({}, { get: (_, p) => (typeof p === 'string' ? 1n : undefined) }),
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 }, TextInputStyle: { Short: 1, Paragraph: 2 },
    MessageFlags: { Ephemeral: 64 }, ChannelType: { GuildText: 0, GuildAnnouncement: 5, GuildForum: 15 },
    GatewayIntentBits: enumProxy(), Partials: enumProxy(), ActivityType: enumProxy(), REST: class {}, Routes: {}, Events: enumProxy(),
};

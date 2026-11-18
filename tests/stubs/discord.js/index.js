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
// The component builders produce the same JSON as the real ones, so tests can inspect exactly what would be sent.
const SNAKE = { customId: 'custom_id', minValues: 'min_values', maxValues: 'max_values', channelTypes: 'channel_types' };
const apiData = d => Object.fromEntries(Object.entries(d).map(([k, v]) => [SNAKE[k] ?? k, v]));
const TYPES = { ButtonBuilder: 2, StringSelectMenuBuilder: 3, RoleSelectMenuBuilder: 6, ChannelSelectMenuBuilder: 8 };
function component(name) {
    const Base = builder(name);
    return class extends Base {
        toJSON() {
            const d = apiData(this.data);
            if (name === 'ActionRowBuilder') return { type: 1, components: (d.components ?? []).map(c => (c && c.toJSON ? c.toJSON() : c)) };
            if (name === 'StringSelectMenuBuilder' && d.options) d.options = d.options.map(o => (o && o.toJSON ? o.toJSON() : o));
            return { type: TYPES[name], ...d };
        }
    };
}
const names = ['EmbedBuilder', 'ModalBuilder', 'TextInputBuilder', 'AttachmentBuilder', 'SlashCommandBuilder', 'SlashCommandSubcommandBuilder', 'ContextMenuCommandBuilder'];
const out = Object.fromEntries(names.map(n => [n, builder(n)]));
for (const n of ['ActionRowBuilder', 'ButtonBuilder', 'StringSelectMenuBuilder', 'RoleSelectMenuBuilder', 'ChannelSelectMenuBuilder']) out[n] = component(n);
const enumProxy = () => new Proxy({}, { get: (_, p) => (typeof p === 'string' ? 1 : undefined) });
class Client extends EventEmitter {
    constructor() { super(); this.channels = { cache: new Map(), fetch: async id => this.channels.cache.get(id) ?? null }; this.guilds = { cache: new Map(), fetch: async () => null }; this.users = { fetch: async id => ({ id, username: `user${id}` }) }; this.user = { id: 'botid' }; this._ready = false; }
    isReady() { return this._ready; }
}
class PermissionsBitField { constructor() { this.bitfield = 0n; } }
module.exports = {
    ...out, Client, PermissionsBitField,
    PermissionFlagsBits: (() => { const bits = {}; return new Proxy(bits, { get: (t, p) => (typeof p === 'string' ? (t[p] ??= 1n << BigInt(Object.keys(t).length)) : undefined) }); })(),   // one distinct bit per name, like the real enum
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 }, TextInputStyle: { Short: 1, Paragraph: 2 },
    MessageFlags: { Ephemeral: 64, IsComponentsV2: 32768 }, ChannelType: { GuildText: 0, GuildAnnouncement: 5, GuildForum: 15 },
    GatewayIntentBits: enumProxy(), Partials: enumProxy(), ActivityType: enumProxy(), REST: class {}, Routes: {}, Events: enumProxy(),
};

// Components V2 layer. Every message the bot sends is a V2 message: containers with an accent colour, a "### Title", dividers
// between blocks, optional picture and "-#" footer, and the button rows underneath, in the style of the Discohook designs.
//
// The rest of the code still builds messages as { embeds: [E(...)...], components: [rows], files }. convert() turns such a payload
// into a V2 payload at the moment it is sent, so every screen follows one style. Screens with an exact layout (stats, leaderboards,
// tic tac toe, Battleship, Save Earned) build their container by hand with card() and hand it over as embeds: [raw].
//
// V2 rules this file respects: a V2 message cannot carry content or embeds, at most 40 components in total (everything nested
// counts) and about 4000 characters of text. Mentions inside V2 text do ping, so every payload says to ping nobody.
const { MessageFlags } = require('discord.js');

const V2_FLAG = MessageFlags.IsComponentsV2 ?? 32768;
const EPHEMERAL_FLAG = MessageFlags.Ephemeral ?? 64;
const COLORS = {
    DEFAULT: 0x22CE60,   // the Save Earned green: everything that has no colour of its own
    STATS: 0x24E066,     // stats and leaderboards
    ENEMY: 0xA71E10,     // Battleship: Enemy Waters
    FLEET: 0x3498DB,     // Battleship: Your fleet
};
const MAX_COMPONENTS = 40, MAX_TEXT = 4000;

// ---------- raw components ----------
const clip = (s, n = MAX_TEXT) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n - 1)}\u2026` : s; };
const text = content => ({ type: 10, content: clip(content) });
const sep = () => ({ type: 14, divider: true, spacing: 1 });
const section = (content, url) => ({ type: 9, components: [text(content)], accessory: { type: 11, media: { url } } });
const gallery = (...urls) => ({ type: 12, items: urls.map(url => ({ media: { url } })) });
const container = (accent, children) => ({ type: 17, ...(accent == null ? {} : { accent_color: accent }), components: children });

// ---------- measuring ----------
function count(node) {
    if (!node || typeof node !== 'object') return 0;
    let n = 1;
    if (Array.isArray(node.components)) for (const c of node.components) n += count(c);
    if (node.accessory) n += count(node.accessory);
    if (Array.isArray(node.items)) n += node.items.length;
    return n;
}
function textLength(node) {
    if (!node || typeof node !== 'object') return 0;
    let n = typeof node.content === 'string' ? node.content.length : 0;
    if (Array.isArray(node.components)) for (const c of node.components) n += textLength(c);
    return n;
}
// Shrinks the longest text blocks until the whole message fits the character limit.
function limitText(nodes, max = MAX_TEXT) {
    const texts = [];
    const walk = n => { if (n?.type === 10) texts.push(n); if (Array.isArray(n?.components)) n.components.forEach(walk); };
    nodes.forEach(walk);
    let over = texts.reduce((s, t) => s + t.content.length, 0) - max;
    while (over > 0) {
        const longest = texts.reduce((a, b) => (b.content.length > a.content.length ? b : a));
        const cut = Math.min(over, Math.max(1, longest.content.length - 1));
        longest.content = `${longest.content.slice(0, longest.content.length - cut - 1)}\u2026`; over -= cut;
    }
    return nodes;
}

// ---------- the card ----------
const EMOJI_START = /^([\p{Extended_Pictographic}\uFE0F\u200d\s]+)/u;
// Titles are plain text with a hyphen: the emoji and the long dash of the old embed titles are dropped.
const cleanTitle = t => String(t ?? '').replace(EMOJI_START, '').replace(/\s\u2014\s/g, ' - ').trim();
const unbold = v => { const m = /^\*\*([^*]+)\*\*$/.exec(v); return m ? m[1] : v; };

// blocks: array of strings, each its own text display with a divider in between.
// -> a container node. footer becomes "-# footer" under its own divider. image goes in a gallery under the text.
function build({ accent = COLORS.DEFAULT, title, thumb, blocks = [], image, footer, budget = MAX_COMPONENTS } = {}) {
    const header = title ? (thumb ? section(`### ${title}`, thumb) : text(`### ${title}`)) : null;
    const make = gaps => {
        const out = [];
        const push = (node, gap = true) => { if (out.length && gap) out.push(sep()); out.push(node); };
        if (header) push(header, false);
        blocks.forEach((b, i) => push(text(b), i === 0 ? !!header : gaps));   // the first block always sits under the title's divider, the others only while there is room
        if (image) out.push(...(Array.isArray(image) ? image : [image]).map(u => gallery(u)));
        if (footer) push(text(`-# ${footer}`));
        return out;
    };
    let children = make(true);
    if (1 + children.reduce((n, c) => n + count(c), 0) > budget) children = make(false);
    if (1 + children.reduce((n, c) => n + count(c), 0) > budget && blocks.length > 2) {
        // still too big: the blocks after the first become one text
        const merged = { accent, title, thumb, blocks: [blocks[0], blocks.slice(1).join('\n')], image, footer, budget };
        return build(merged);
    }
    return container(accent, limitText(children));
}

// A pre-built container that convert() passes through untouched.
class Raw { constructor(node) { this.container = node; } }
const card = opts => new Raw(build(opts));

// An embed look-alike: every E(color, title) in the code base is one of these. The colour passed in is ignored on purpose,
// every card uses the default accent unless the screen sets its own with card().
class Card {
    constructor(color, title) { this.title = title; this.description = ''; this.fields = []; this.footerText = ''; this.thumb = null; this.imageUrl = null; }
    setColor() { return this; }
    setTitle(t) { this.title = t; return this; }
    setDescription(d) { this.description = d ?? ''; return this; }
    addFields(...f) { this.fields.push(...f.flat()); return this; }
    setFooter(o) { this.footerText = typeof o === 'string' ? o : (o?.text ?? ''); return this; }
    setThumbnail(u) { this.thumb = u; return this; }
    setImage(u) { this.imageUrl = u; return this; }
    setTimestamp() { return this; }
    setAuthor() { return this; }
    toContainer(budget = MAX_COMPONENTS) {
        const blocks = [];
        if (this.description) blocks.push(String(this.description));
        for (const f of this.fields) {
            const value = String(f.value ?? ''), m = /^([\p{Extended_Pictographic}\uFE0F\u200d]+)\s*(.*)$/su.exec(String(f.name ?? ''));
            const emoji = m ? `${m[1]} ` : '', label = m ? m[2] : String(f.name ?? '');
            blocks.push(!value.includes('\n') && value.length <= 90 ? `${emoji}**${label}:** ${unbold(value)}` : `${emoji}**${label}**\n${value}`);
        }
        return build({ title: cleanTitle(this.title), thumb: this.thumb, blocks, image: this.imageUrl, footer: this.footerText, budget });
    }
}
const E = (color, title) => new Card(color, title);

// One text card for the end of a game and similar one-liners. "🎮 **Tic tac toe**: body" is split into a title and a body.
function endCard(textLine) {
    const m = /^\S+ \*\*(.+?)\*\*(?: \((.+?)\))?: ([\s\S]*)$/u.exec(String(textLine));
    const raw = m ? card({ title: m[2] ? `${m[1]} (${m[2]})` : m[1], blocks: [m[3]] }) : card({ blocks: [String(textLine)] });
    return { embeds: [raw], components: [], files: [], attachments: [], allowedMentions: { parse: [] } };
}

// ---------- converting a payload ----------
const flagsNum = f => (Array.isArray(f) ? f.reduce((a, b) => a | Number(b), 0) : Number(f ?? 0) || 0);
const toJSON = c => (c && typeof c.toJSON === 'function' ? c.toJSON() : c);
const isV2Payload = p => (flagsNum(p.flags) & V2_FLAG) !== 0;

function convert(p, { force = false } = {}) {
    if (!p || typeof p !== 'object') return p;
    if (isV2Payload(p)) return { ...p, allowedMentions: p.allowedMentions ?? { parse: [] } };
    const embeds = Array.isArray(p.embeds) ? p.embeds.filter(Boolean) : [];
    const hasContent = typeof p.content === 'string' && p.content.length > 0;
    if (!embeds.length && !(force && hasContent)) return p;   // an ordinary message stays ordinary
    const rows = (p.components ?? []).map(toJSON);
    const used = rows.reduce((n, r) => n + count(r), 0) + (hasContent ? 1 : 0);
    const top = [];
    if (hasContent) top.push(text(p.content));
    const share = Math.max(8, Math.floor((MAX_COMPONENTS - used) / Math.max(1, embeds.length)));
    for (const e of embeds) top.push(e instanceof Raw ? e.container : typeof e.toContainer === 'function' ? e.toContainer(share) : build({ title: cleanTitle(e.data?.title), blocks: [e.data?.description ?? ''] }));
    top.push(...rows);
    limitText(top);
    const { embeds: _e, content: _c, components: _k, flags, ...rest } = p;
    return { ...rest, components: top, flags: flagsNum(flags) | V2_FLAG, allowedMentions: p.allowedMentions ?? { parse: [] } };
}

// Makes an interaction send V2 whatever the rest of the code hands it.
function wrapInteraction(interaction) {
    if (!interaction || interaction.__v2) return interaction;
    interaction.__v2 = true;
    const force = isV2Message(interaction.message);   // editing a V2 message: plain text has to become a V2 text too
    for (const m of ['reply', 'editReply', 'update', 'followUp']) {
        const f = interaction[m];
        if (typeof f === 'function') interaction[m] = (p, ...rest) => f.call(interaction, convert(typeof p === 'string' ? { content: p } : p, { force: force && m !== 'reply' && m !== 'followUp' }), ...rest);
    }
    return interaction;
}
const isV2Message = m => !!m && (flagsNum(m.flags?.bitfield ?? m.flags) & V2_FLAG) !== 0;
// A button or menu on a message from before the V2 update cannot be edited into V2, so it is answered with a pointer instead.
const isOutdated = i => !!(i?.message && typeof i.isMessageComponent === 'function' && i.isMessageComponent() && (i.message.embeds?.length ?? 0) > 0 && !isV2Message(i.message));

module.exports = {
    V2_FLAG, EPHEMERAL_FLAG, COLORS, MAX_COMPONENTS, MAX_TEXT,
    text, sep, section, gallery, container, build, card, Raw, Card, E, endCard, cleanTitle,
    count, textLength, convert, wrapInteraction, isV2Message, isOutdated, flagsNum,
};

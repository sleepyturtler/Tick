const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const store = require('./store');
const { WYR } = require('./data');
const { WYR_MIN_SECONDS } = require('../config');
const { newId, pick, reject, sendTo, editMessage, withLock } = require('./common');
const { E } = require('../ui');

const info = {
    id: 'wyr', label: 'Would you rather', emoji: '\u{1F914}', short: 'Vote A or B and see how the group splits',
    how: `For the whole channel. A question with two choices. Everyone votes A or B (you can change your vote). Each question stays up at least ${WYR_MIN_SECONDS} seconds before anyone can press Next.`,
};
const timers = new Map();
const unix = ms => Math.floor(ms / 1000);

function nextQuestion(s) {
    let pool = WYR.map((_, i) => i).filter(i => !s.used.includes(i));
    if (!pool.length) { s.used = []; pool = WYR.map((_, i) => i); }
    s.q = pick(pool); s.used.push(s.q); s.votes = {};
    s.readyAt = Date.now() + WYR_MIN_SECONDS * 1000;
}
const bar = (n, total) => { const f = total ? Math.round(10 * n / total) : 0; return '\u{1F7E6}'.repeat(f) + '\u2B1C'.repeat(10 - f); };

// When the waiting time is over, the bot itself edits the message so Next lights up.
function armTimer(game) {
    clearTimeout(timers.get(game.id));
    const ms = game.state.readyAt - Date.now();
    if (ms <= 0) return;
    timers.set(game.id, setTimeout(() => { timers.delete(game.id); withLock(game.id, async () => { if (store.get(game.id)) await editMessage(game, payload(game)); }).catch(() => {}); }, ms + 100));
}

function payload(game) {
    const s = game.state, [a, b] = WYR[s.q], va = Object.values(s.votes).filter(v => v === 'a').length, vb = Object.values(s.votes).filter(v => v === 'b').length, tot = va + vb;
    const pct = n => (tot ? Math.round(100 * n / tot) : 0), waiting = Date.now() < s.readyAt;
    const embed = E('#5865F2', '\u{1F914} Would you rather...').setDescription(`**A.** ${a[0].toUpperCase() + a.slice(1)}\n**B.** ${b[0].toUpperCase() + b.slice(1)}`)
        .addFields({ name: `A: ${va} vote${va === 1 ? '' : 's'} (${pct(va)}%)`, value: bar(va, tot) }, { name: `B: ${vb} vote${vb === 1 ? '' : 's'} (${pct(vb)}%)`, value: bar(vb, tot) });
    if (waiting) embed.setFooter({ text: `Take your time: Next unlocks in ${Math.max(1, Math.ceil((s.readyAt - Date.now()) / 1000))}s` });
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`g:${game.id}:v:a`).setLabel('A').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`g:${game.id}:v:b`).setLabel('B').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`g:${game.id}:next`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(waiting));
    return { embeds: [embed], components: [row] };
}

async function start(interaction) {
    const game = { id: newId(), type: 'wyr', guildId: interaction.guild.id, channelId: interaction.channelId, messageId: null, hostId: interaction.user.id, userIds: [interaction.user.id], phase: 'play', state: { q: 0, votes: {}, used: [], readyAt: 0 }, createdAt: Date.now() };
    nextQuestion(game.state);
    const msg = await sendTo(game.channelId, payload(game));
    game.messageId = msg.id; store.add(game); armTimer(game);
    return interaction.update({ embeds: [E('#57f287', 'Started').setDescription('The question is in the channel.')], components: [] });
}

async function handle(interaction, game, action, args) {
    const s = game.state;
    if (action === 'v') s.votes[interaction.user.id] = args[0] === 'b' ? 'b' : 'a';
    else if (action === 'next') {
        if (Date.now() < s.readyAt) return reject(interaction, `Let people vote first. Next is available <t:${unix(s.readyAt)}:R>.`);
        nextQuestion(s); armTimer(game);
    } else return;
    if (!game.userIds.includes(interaction.user.id)) game.userIds.push(interaction.user.id);
    store.save(game);
    return interaction.update(payload(game));
}

const onRestore = game => armTimer(game);
const onExpire = game => { clearTimeout(timers.get(game.id)); timers.delete(game.id); };

module.exports = { info, start, handle, payload, onRestore, onExpire };

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const store = require('./store');
const { WYR } = require('./data');
const { newId, pick, reject, sendTo } = require('./common');
const { E } = require('../ui');

const info = {
    id: 'wyr', label: 'Would you rather', emoji: '\u{1F914}', short: 'Vote A or B and see how the group splits',
    how: 'For the whole channel. A question with two choices. Everyone votes A or B (you can change your vote), and anyone can press Next for another question.',
};

function nextQuestion(s) {
    let pool = WYR.map((_, i) => i).filter(i => !s.used.includes(i));
    if (!pool.length) { s.used = []; pool = WYR.map((_, i) => i); }
    s.q = pick(pool); s.used.push(s.q); s.votes = {};
}
const bar = (n, total) => { const f = total ? Math.round(10 * n / total) : 0; return '\u{1F7E6}'.repeat(f) + '\u2B1C'.repeat(10 - f); };

function payload(game) {
    const s = game.state, [a, b] = WYR[s.q], va = Object.values(s.votes).filter(v => v === 'a').length, vb = Object.values(s.votes).filter(v => v === 'b').length, tot = va + vb;
    const pct = n => (tot ? Math.round(100 * n / tot) : 0);
    const embed = E('#5865F2', '\u{1F914} Would you rather...').setDescription(`**A.** ${a[0].toUpperCase() + a.slice(1)}\n**B.** ${b[0].toUpperCase() + b.slice(1)}`)
        .addFields({ name: `A: ${va} vote${va === 1 ? '' : 's'} (${pct(va)}%)`, value: bar(va, tot) }, { name: `B: ${vb} vote${vb === 1 ? '' : 's'} (${pct(vb)}%)`, value: bar(vb, tot) });
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`g:${game.id}:v:a`).setLabel('A').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`g:${game.id}:v:b`).setLabel('B').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`g:${game.id}:next`).setLabel('Next').setStyle(ButtonStyle.Secondary));
    return { embeds: [embed], components: [row] };
}

async function start(interaction) {
    const game = { id: newId(), type: 'wyr', guildId: interaction.guild.id, channelId: interaction.channelId, messageId: null, hostId: interaction.user.id, userIds: [interaction.user.id], phase: 'play', state: { q: 0, votes: {}, used: [] }, createdAt: Date.now() };
    nextQuestion(game.state);
    const msg = await sendTo(game.channelId, payload(game));
    game.messageId = msg.id; store.add(game);
    return interaction.update({ embeds: [E('#57f287', 'Started').setDescription('The question is in the channel.')], components: [] });
}

async function handle(interaction, game, action, args) {
    const s = game.state;
    if (action === 'v') s.votes[interaction.user.id] = args[0] === 'b' ? 'b' : 'a';
    else if (action === 'next') nextQuestion(s);
    else return;
    if (!game.userIds.includes(interaction.user.id)) game.userIds.push(interaction.user.id);
    store.save(game);
    return interaction.update(payload(game));
}

module.exports = { info, start, handle, payload };

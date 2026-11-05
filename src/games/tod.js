const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const store = require('./store');
const { TRUTHS, DARES } = require('./data');
const { newId, pick, mention, sendTo } = require('./common');
const { E } = require('../ui');

const info = {
    id: 'tod', label: 'Truth or dare', emoji: '\u{1F3AD}', short: 'Random truths and dares for the group',
    how: 'For the whole channel. Press Truth or Dare for a random prompt aimed at you, then press Next for another of the same kind. Prompts do not repeat until they run out.',
};
const BANK = { truth: TRUTHS, dare: DARES };

function draw(s, type) {
    let pool = BANK[type].map((_, i) => i).filter(i => !s.used[type].includes(i));
    if (!pool.length) { s.used[type] = []; pool = BANK[type].map((_, i) => i); }
    const i = pick(pool); s.used[type].push(i);
    return BANK[type][i];
}

function payload(game) {
    const s = game.state, last = s.last;
    const embed = last
        ? E(last.type === 'truth' ? '#3498db' : '#e74c3c', last.type === 'truth' ? '\u{1F4AC} Truth' : '\u{1F525} Dare').setDescription(`For ${mention(last.by)}:\n\n**${last.text}**`)
        : E('#5865F2', '\u{1F3AD} Truth or dare').setDescription('Press **Truth** or **Dare** to get a prompt.');
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`g:${game.id}:t:truth`).setLabel('Truth').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`g:${game.id}:t:dare`).setLabel('Dare').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`g:${game.id}:next`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(!last));
    return { embeds: [embed], components: [row] };
}

async function start(interaction) {
    const game = { id: newId(), type: 'tod', guildId: interaction.guild.id, channelId: interaction.channelId, messageId: null, hostId: interaction.user.id, userIds: [interaction.user.id], phase: 'play', state: { used: { truth: [], dare: [] }, last: null }, createdAt: Date.now() };
    const msg = await sendTo(game.channelId, payload(game));
    game.messageId = msg.id; store.add(game);
    return interaction.update({ embeds: [E('#57f287', 'Started').setDescription('Truth or dare is in the channel.')], components: [] });
}

async function handle(interaction, game, action, args) {
    const s = game.state;
    let type = action === 't' ? (args[0] === 'dare' ? 'dare' : 'truth') : s.last?.type;
    if (!type) return;
    s.last = { type, text: draw(s, type), by: interaction.user.id };
    if (!game.userIds.includes(interaction.user.id)) game.userIds.push(interaction.user.id);
    store.save(game);
    return interaction.update(payload(game));
}

module.exports = { info, start, handle, payload };

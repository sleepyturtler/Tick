// /players <name or number>
//   a name   -> one embed with the player's full name and launch overall (add ":fc25" / ":fifa19" to pick a game, default is the latest)
//   a number -> 3 players with that overall, each from a different game, with a Reroll button for a fresh set
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fc = require('./fc');
const { E, ep } = require('./ui');

// FUT card colours: gold 75+, silver 65 to 74, bronze below
const tierColor = o => (o >= 75 ? '#f5c542' : o >= 65 ? '#c0c0c0' : '#cd7f32');

function playerEmbed(p) {
    return E(tierColor(p.ovr), `\u26bd ${fc.fullName(p)}`)
        .addFields({ name: 'Overall', value: `**${p.ovr}**`, inline: true }, { name: 'Game', value: fc.gameLabel(p.game), inline: true })
        .setFooter({ text: 'Launch rating' });
}

function numberReply(ovr, userId, res) {
    if (!res.picks.length) {
        return { embeds: [E('#ff4444', `No player rated ${ovr}`).setDescription(`Nobody in the loaded ratings has an overall of **${ovr}**.`)], components: [] };
    }
    const lines = res.picks.map(p => `**${fc.gameLabel(p.game)}**  ${fc.fullName(p)}`);
    const footer = res.picks.length < 3 ? `Only ${res.games} game${res.games === 1 ? '' : 's'} ${res.games === 1 ? 'has' : 'have'} a player rated ${ovr}.` : 'Launch ratings';
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`players_reroll_${ovr}_${userId}`).setLabel('Reroll').setEmoji('\u{1F504}').setStyle(ButtonStyle.Secondary));
    return { embeds: [E(tierColor(ovr), `\u{1F3B2} Players rated ${ovr}`).setDescription(lines.join('\n')).setFooter({ text: footer })], components: [row] };
}

async function handlePlayers(interaction) {
    await interaction.deferReply();
    const raw = interaction.options.getString('query').trim();
    if (/^\d{1,3}$/.test(raw)) {
        const ovr = parseInt(raw, 10);
        return interaction.editReply(numberReply(ovr, interaction.user.id, await fc.randomByOvr(ovr)));
    }
    const q = fc.parseQuery(raw);
    if (!q) {
        return interaction.editReply({ embeds: [E('#ff4444', 'Not sure what that is').setDescription('Type a player name (letters only, up to 4 words), optionally with a game like `lamine yamal:fc25`, or a number such as `85` to see players with that rating.')] });
    }
    const p = await fc.lookup(q);
    if (!p) {
        return interaction.editReply({ embeds: [E('#ff4444', 'No player found').setDescription(`Couldn't find **${q.name}** in ${fc.gameLabel(q.game)}. Check the spelling, or try another game like \`:fc25\`.`)] });
    }
    return interaction.editReply({ embeds: [playerEmbed(p)] });
}

// Button id: players_reroll_<overall>_<userId>. Only the person who ran the command can reroll it.
async function handleReroll(interaction) {
    try {
        const [, , ovrStr, ownerId] = interaction.customId.split('_');
        if (interaction.user.id !== ownerId) return interaction.reply({ content: 'Only the person who ran this command can reroll it. Run `/players` yourself to get your own.', ...ep() });
        const ovr = parseInt(ovrStr, 10);
        return await interaction.update(numberReply(ovr, ownerId, await fc.randomByOvr(ovr)));
    } catch (e) {
        console.error('players reroll:', e.message);
        if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Something went wrong.', ...ep() }).catch(() => {});
    }
}

module.exports = { handlePlayers, handleReroll, playerEmbed, numberReply };

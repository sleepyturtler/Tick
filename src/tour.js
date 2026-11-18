// The "Get a tour" experience: the welcome card sent when Tick joins a server, and a short paged tour behind its button.
// Pages are plain data so they are easy to keep in step with the commands.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { SUPPORT_URL } = require('./config');
const { cmd } = require('./mentions');
const v2 = require('./v2');

// Built on demand so the command mentions are current. Commands are clickable (see mentions.js).
const pages = () => [
    { title: 'Welcome to Tick', blocks: [
        'Tick is a counting bot with extras. Everyone in a channel counts up together, one number at a time, and a wrong number ruins the count.',
        '**Saves** are earned at milestones and can undo a ruin. **Stats and leaderboards** track who counts best, and there are **party games** for when counting gets quiet.',
    ] },
    { title: 'Get started', blocks: [
        `${cmd('counting channel')} adds or removes counting channels. A server can have several, each with its own mode and count.`,
        `${cmd('counting settings')} is the control panel for everything else about counting.`,
        `${cmd('transfer')} moves an existing count over: pick the channel and Tick reads the latest count from its history, asks you to confirm, then carries on from there.`,
    ] },
    { title: 'Counting modes', blocks: [
        '**Interactive:** the classic. A wrong number resets the count.',
        '**Simple:** wrong messages are deleted and the count never resets.',
        '**Countdown:** count down from 100 to 1, then go again.',
        '**Modifiers:** a rule (primes, squares, every 3rd number...) decides which numbers are valid.',
        '**Floors:** every 100 is a checkpoint, so a ruin only drops you back to the last one.',
    ] },
    { title: 'Counting settings', blocks: [
        `${cmd('counting settings')} is one panel for the rest: the **mode** of a channel, the **max streak** (how many counts in a row one person may make), **expressions** like \`2+3*4\`, **equations** like \`2x+3=13\`, **players** (on by default: type \`pedri:fc24\` to count with a footballer's rating) and the **fail role** (a temporary role for whoever ruins the count).`,
        `${cmd('counting view')} shows where everything stands. If someone edits or deletes the latest number, the bot calls it out.`,
    ] },
    { title: 'Party games', blocks: [
        `${cmd('game')} lists the games: tic tac toe, Connect 4, hangman, would you rather, truth or dare, impostor, Guess Who and Battleship.`,
        `Tic tac toe, Connect 4, Guess Who and Battleship can be **ranked** (Elo, shared across every server) or **friendly** (nothing recorded). The host picks with the Mode button on the invitation. Every 1v1 game has Forfeit and Stop buttons.`,
        `${cmd('leaderboard elo')} shows the ratings.`,
    ] },
    { title: 'Stats and tools', blocks: [
        `${cmd('stats')} shows a counting profile. ${cmd('leaderboard server')}, ${cmd('leaderboard global')} and ${cmd('leaderboard highscores')} show the boards.`,
        `${cmd('calculate')} evaluates an expression, or hands you three ways to write a number. ${cmd('players')} looks up a footballer by name or finds players with a given rating.`,
        `${cmd('help')} has every command. Questions or bugs? [Join the support server](${SUPPORT_URL}).`,
    ] },
];
const TOTAL = pages().length;

function page(n) {
    n = Math.min(TOTAL, Math.max(1, Math.trunc(Number(n)) || 1));
    const p = pages()[n - 1];
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`tour_${n - 1}`).setLabel('Back').setStyle(ButtonStyle.Secondary).setDisabled(n <= 1),
        new ButtonBuilder().setCustomId('tour_info').setLabel(`${n}/${TOTAL}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId(`tour_${n + 1}`).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(n >= TOTAL),
    );
    return { embeds: [v2.card({ title: p.title, blocks: p.blocks, footer: `Tour ${n}/${TOTAL}` })], components: [row] };
}

// The message sent when the bot joins a server.
function welcome() {
    return {
        embeds: [v2.card({ title: 'Thanks for adding Tick!', blocks: [
            'Tick is a counting bot with five modes, math expressions, football player ratings and party games. Press **Get a tour** for a quick walk through the commands.',
            `Need help, want to report a bug, or have a feature request? Join the support server: ${SUPPORT_URL}`,
        ] })],
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('tour_start').setLabel('Get a tour').setStyle(ButtonStyle.Primary))],
    };
}

// Buttons: tour_start opens the tour (a private reply); tour_<n> turns its pages. Returns true when the interaction was one of ours.
async function handle(interaction, ep) {
    const id = interaction.customId;
    if (typeof id !== 'string' || !id.startsWith('tour_') || id === 'tour_info') return false;
    if (id === 'tour_start') { await interaction.reply({ ...page(1), ...ep() }); return true; }
    const n = Number(id.slice(5));
    if (!Number.isInteger(n)) return false;
    await interaction.update(page(n));
    return true;
}

module.exports = { page, welcome, handle, TOTAL };

// /help: one card per topic, a dropdown to browse them, and a Home button.
// Every command in the text is a clickable mention (see mentions.js); button labels and menu options cannot show them.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const client = require('./client');
const { SUPPORT_URL, GITHUB_URL, TOPGG_URL, WEBSITE_URL, inviteUrl } = require('./config');
const { cmd } = require('./mentions');
const v2 = require('./v2');

const TOPICS = [
    { id: 'home', label: 'Home', blurb: 'Start here' },
    { id: 'counting', label: 'Counting', blurb: 'How to play, saves and anti-cheat' },
    { id: 'modes', label: 'Modes', blurb: 'Interactive, Simple, Countdown, Modifiers, Floors' },
    { id: 'expressions', label: 'Expressions', blurb: 'Math, equations and player ratings' },
    { id: 'games', label: 'Games', blurb: 'Eight party games with Elo' },
    { id: 'admin', label: 'Admin', blurb: 'Channels, settings and transfer' },
    { id: 'commands', label: 'All commands', blurb: 'Every command in one list' },
    { id: 'links', label: 'Links', blurb: 'Invite, support server and website' },
];
const IDS = TOPICS.map(t => t.id);
// The help_1 to help_6 buttons on messages sent before the dropdown existed.
const LEGACY = { 1: 'counting', 2: 'commands', 3: 'admin', 4: 'modes', 5: 'expressions', 6: 'links' };

const line = (name, text) => `${name}\n${text}`;

function links() {
    const link = (label, text, url) => ({ text, link: { label, url } });
    const blocks = [link('Add', '**Add Tick:** invite the bot to a server', inviteUrl(client.user?.id)), link('Join', '**Support server:** help, bugs and updates', SUPPORT_URL), link('Open', '**GitHub:** source code', GITHUB_URL), link('Open', '**top.gg:** vote and review', TOPGG_URL)];
    if (WEBSITE_URL) blocks.push(link('Open', '**Website:** status and news', WEBSITE_URL), link('Open', '**Terms of Service**', `${WEBSITE_URL}/terms`), link('Open', '**Privacy Policy**', `${WEBSITE_URL}/privacy`));
    return { title: 'Links', blocks };
}

// Each page is { title, blocks, footer? }, built on demand so the command mentions are current.
const PAGES = {
    home: () => ({
        title: 'Tick Help',
        blocks: [
            'Tick is a counting bot with five modes, math expressions, football player ratings and party games. Pick a topic from the menu below.',
            ['**Counting** how to play, saves and anti-cheat', '**Modes** five ways to count', '**Expressions** math, equations and player ratings', '**Games** eight party games with Elo', '**Admin** channels, settings and transfer', '**All commands** the full list', '**Links** invite, support and website'].join('\n'),
        ]
    }),
    counting: () => ({
        title: 'Counting',
        blocks: [
            line('**How to play**', 'Type the next number in a counting channel. A wrong number ruins the count and it starts over. Math works too, like `2+3*4`.'),
            line('**Taking turns**', `By default you can't count twice in a row. Admins can change that in ${cmd('counting settings')}.`),
            line('**Milestones and saves**', 'The bot celebrates every 100. Saves are earned at 50, 100, 250, 500, 1000, 2000, then every 2000. Anyone can use one within 1 minute to undo a ruin.'),
            line('**Anti-cheat**', 'Edit or delete your latest number and the bot calls it out and says where the count stands.'),
            line('**Channels**', 'A server can have several counting channels, each with its own mode and count. Threads share the count of the channel they live in.'),
        ],
    }),
    modes: () => ({
        title: 'Modes',
        blocks: [
            line('**Interactive**', 'The classic. A wrong number resets the count.'),
            line('**Simple**', 'No resets. Wrong messages are silently deleted.'),
            line('**Countdown**', 'Count down from 100 to 1. At 1 the cycle completes and starts over, and cycles count on the global leaderboard. A wrong number resets to 100.'),
            line('**Modifiers**', 'A hidden rule decides which numbers are valid, and the bot only names the category, so work out the next number yourself. The rule changes every time the count resets. Categories: every 2nd or 3rd number, primes, Fibonacci, perfect squares, palindromes, multiples of 7 and triangular numbers.'),
            line('**Floors**', 'Every 100 is a checkpoint. Ruin the count and you drop back to your highest checkpoint instead of 0.'),
            `Admins change a channel's mode in ${cmd('counting settings')}.`,
        ],
    }),
    expressions: () => ({
        title: 'Expressions',
        blocks: [
            line('**Math**', 'Expressions are rounded to the nearest whole number. Operators: `+` `-` `*` `/` `^` and `|x|` for absolute value.'),
            line('**Constants and functions**', '`pi` `phi` `e` `tau` `sqrt2`\n`ln` `log` `log2` `sqrt(x,n)` `cbrt` `pow(x,n)` `sin` `cos` `tan` `asin` `acos` `atan` `floor` `ceil` `abs` `exp` `round`'),
            line('**Examples**', '`ln(e)` is **1**, `sin(pi)` is **0**, `pi^2` is **10**, `2^8` is **256**, `|3-10|` is **7**'),
            line('**Equations**', 'Type an equation with `x` and the count is the number that solves it. `2x+3=13` counts as **5**, `x^2=25` counts as **5**, and `|x-10|=3` counts as **7** or **13**. An equation that is true for every number, like `x=x`, does not count. Admins can switch equations off.'),
            line('**Players**', `Player counting is on by default, and admins can switch it off in ${cmd('counting settings')}. A football player's name plus a game tag is their EA FC overall rating: \`lamine yamal:fc25\` or \`pedri:fifa19\` (FIFA 15 to FC 27). Tagged players also work inside expressions and equations, like \`lamine yamal:fc25+25\`. A name without a tag is just chat. Look players up with ${cmd('players')}.`),
            line('**Calculator**', `${cmd('calculate')} turns a number into 3 expressions, or evaluates an expression you type.`),
        ],
    }),
    games: () => {
        const { MODULES, ORDER } = require('./games');   // loaded when needed: the games modules load this file's neighbours
        return {
            title: 'Games',
            blocks: [
                `${cmd('game')} starts a party game in the channel. It posts an invitation, and everyone who accepts plays.`,
                ORDER.map(t => `${MODULES[t].info.emoji} **${MODULES[t].info.label}** ${MODULES[t].info.short}`).join('\n'),
                line('**Ranked or friendly**', `Tic tac toe, Connect 4, Guess Who and Battleship can be ranked. Ranked games use Elo ratings that follow you to every server, and the host chooses with the Mode button before anyone accepts. Friendly games record nothing. ${cmd('leaderboard elo')} shows the ratings.`),
                line('**Good to know**', 'Every 1v1 game has Forfeit and Stop buttons, and each asks you to confirm. A game nobody touches for a while expires, and whoever it was waiting on forfeits. Two players who just finished a ranked game get no Elo from another one straight away.'),
            ],
        };
    },
    admin: () => ({
        title: 'Admin',
        blocks: [
            `These need Administrator or the access role you set with ${cmd('config access')}.`,
            line(cmd('counting channel'), 'See your counting channels, and add or remove them.'),
            line(`${cmd('counting settings')} \`[channel]\``, 'Mode, max streak (1 to 100), expressions, equations, player counting and the fail role, a temporary role for whoever ruins the count.'),
            line(`${cmd('transfer')} \`<channel>\``, 'Read the latest count in a channel, say from another counting bot, and carry on from it.'),
            line(`${cmd('counting reset')} \`[channel]\``, 'Reset a counting channel by hand.'),
            line(cmd('counting view'), 'See the counting channels and their settings.'),
            line(cmd('config access'), 'Choose which role can use these commands.'),
        ],
    }),
    commands: () => ({
        title: 'All commands',
        blocks: [
            line('**Play**', [`${cmd('stats')} \`[user]\` a counting profile`, `${cmd('leaderboard server')} top counters here`, `${cmd('leaderboard global')} top counters everywhere`, `${cmd('leaderboard highscores')} best channels per mode`, `${cmd('leaderboard elo')} \`<game>\` game ratings`, `${cmd('game')} party games`].join('\n')),
            line('**Tools**', [`${cmd('calculate')} \`<input>\` evaluate or find expressions`, `${cmd('players')} \`<name or number>\` football player ratings`, `${cmd('invite')} add Tick to a server`, `${cmd('help')} \`[topic]\` this guide`].join('\n')),
            line('**Admin**', [`${cmd('counting channel')} add or remove counting channels`, `${cmd('counting settings')} \`[channel]\` mode, streak, expressions, fail role`, `${cmd('counting view')} channels and settings`, `${cmd('counting reset')} \`[channel]\` reset a count`, `${cmd('transfer')} \`<channel>\` carry on an existing count`, `${cmd('config access')} who can use admin commands`].join('\n')),
        ],
    }),
    links,
};

const normalize = topic => (IDS.includes(topic) ? topic : LEGACY[topic] ?? 'home');

function buildHelpPage(topic = 'home') {
    const t = normalize(topic);
    const menu = new StringSelectMenuBuilder().setCustomId('help_select').setPlaceholder('Browse help')
        .addOptions(TOPICS.map(x => ({ label: x.label, description: x.blurb, value: x.id, default: x.id === t })));
    const components = [new ActionRowBuilder().addComponents(menu)];
    if (t !== 'home') components.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('help_home').setLabel('Home').setStyle(ButtonStyle.Secondary)));
    return { embeds: [v2.card(PAGES[t]())], components };
}

// The select menu, the Home button and the old numbered buttons. Returns true when the interaction was one of ours.
async function handle(interaction) {
    const id = interaction.customId;
    if (typeof id !== 'string' || !id.startsWith('help_')) return false;
    const topic = id === 'help_select' ? interaction.values?.[0] : id === 'help_home' ? 'home' : LEGACY[Number(id.slice(5))];
    if (!IDS.includes(topic)) return false;
    await interaction.update(buildHelpPage(topic));
    return true;
}

async function run(interaction, ep) {
    return interaction.reply({ ...buildHelpPage(interaction.options?.getString?.('topic') ?? 'home'), ...ep() });
}

module.exports = { buildHelpPage, handle, run, TOPICS };

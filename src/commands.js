const { SlashCommandBuilder } = require('discord.js');
const { COUNTING_CHANNEL_TYPES } = require('./config');

// Drop-in owner tool: present only if src/killbot.js exists (delete the file and restart to remove /killbot).
let killbot = null;
try { killbot = require('./killbot'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND' || !e.message.includes("'./killbot'")) throw e; }
const games = require('./gameshook');

function buildCommands() {
    const chanOpt=(o,desc,req=false)=>o.setName('channel').setDescription(desc).addChannelTypes(...COUNTING_CHANNEL_TYPES).setRequired(req);
    const commands = [
        new SlashCommandBuilder().setName('counting').setDescription('Configure or view the counting game').addSubcommand(s=>s.setName('reset').setDescription('Manually reset the count').addChannelOption(o=>chanOpt(o,'Counting channel to reset')))
            .addSubcommand(s=>s.setName('setcount').setDescription('Set the current count').addIntegerOption(o=>o.setName('number').setDescription('Number').setRequired(true).setMinValue(0).setMaxValue(1000)).addChannelOption(o=>chanOpt(o,'Counting channel (if you have several)')))
            .addSubcommand(s=>s.setName('channel').setDescription('View, add or remove counting channels'))
            .addSubcommand(s=>s.setName('view').setDescription('View counting channels and settings'))
            .addSubcommand(s=>s.setName('maxstreak').setDescription('Max consecutive counts per user').addIntegerOption(o=>o.setName('amount').setDescription('1\u2013100').setRequired(true).setMinValue(1).setMaxValue(100)))
            .addSubcommand(s=>s.setName('expressions').setDescription('Allow math expressions').addBooleanOption(o=>o.setName('enabled').setDescription('Enable/disable').setRequired(true)))
            .addSubcommand(s=>s.setName('mode').setDescription('Switch counting mode').addChannelOption(o=>chanOpt(o,'Counting channel (if you have several)')))
            .addSubcommand(s=>s.setName('failrole').setDescription('Give players who ruin the count a temporary role')
                .addRoleOption(o=>o.setName('role').setDescription('Role to hand out (leave empty to create "Ruined the Count")'))
                .addIntegerOption(o=>o.setName('minutes').setDescription('How long the role lasts, 1\u20131440 (default 10)').setMinValue(1).setMaxValue(1440))
                .addBooleanOption(o=>o.setName('disable').setDescription('Turn fail roles off')))
            .addSubcommand(s=>s.setName('anticheat').setDescription('Call out edited or deleted counts').addBooleanOption(o=>o.setName('enabled').setDescription('Enable/disable').setRequired(true)))
            .addSubcommand(s=>s.setName('players').setDescription('Count with football player names (EA FC overall rating)').addBooleanOption(o=>o.setName('enabled').setDescription('Enable/disable').setRequired(true))),
        new SlashCommandBuilder().setName('config').setDescription('Configure bot settings')
            .addSubcommand(s=>s.setName('access').setDescription('Set which role can use config')),
        new SlashCommandBuilder().setName('leaderboard').setDescription('View leaderboards')
            .addSubcommand(s=>s.setName('server').setDescription('Top counters in this server'))
            .addSubcommand(s=>s.setName('global').setDescription('Global leaderboard'))
            .addSubcommand(s=>s.setName('highscores').setDescription('Channels by mode high score / cycles')),
        new SlashCommandBuilder().setName('stats').setDescription('View counting stats').addUserOption(o=>o.setName('user').setDescription('User to check')),
        new SlashCommandBuilder().setName('calculate').setDescription('Calculate an expression, or get 3 expressions for a number').addStringOption(o=>o.setName('input').setDescription('A number or expression').setRequired(true)),
        new SlashCommandBuilder().setName('players').setDescription('Look up a football player, or find players with a given overall')
            .addStringOption(o=>o.setName('query').setDescription('A player name (add :fc25 for a game) or a number like 85').setRequired(true).setMaxLength(60)),
        new SlashCommandBuilder().setName('setup').setDescription('Open the bot setup panel (admin only)'),
        new SlashCommandBuilder().setName('invite').setDescription('Invite this bot'),
        new SlashCommandBuilder().setName('help').setDescription('View all commands'),
    ];
    if (killbot) commands.push(killbot.command);
    if (games) commands.push(games.command);
    return commands.map(c=>c.toJSON());
}

module.exports = { buildCommands };

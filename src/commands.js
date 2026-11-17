const { SlashCommandBuilder } = require('discord.js');
const { COUNTING_CHANNEL_TYPES, MODE_CHOICES } = require('./config');

// Drop-in owner tool: present only if src/killbot.js exists (delete the file and restart to remove /killbot).
let killbot = null;
try { killbot = require('./killbot'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND' || !e.message.includes("'./killbot'")) throw e; }
const games = require('./gameshook');

function buildCommands() {
    const chanOpt=(o,desc,req=false)=>o.setName('channel').setDescription(desc).addChannelTypes(...COUNTING_CHANNEL_TYPES).setRequired(req);
    const commands = [
        new SlashCommandBuilder().setName('counting').setDescription('Configure or view the counting game').addSubcommand(s=>s.setName('reset').setDescription('Manually reset the count').addChannelOption(o=>chanOpt(o,'Counting channel to reset')))
            .addSubcommand(s=>s.setName('channel').setDescription('View, add or remove counting channels'))
            .addSubcommand(s=>s.setName('view').setDescription('View counting channels and settings'))
            .addSubcommand(s=>s.setName('settings').setDescription('Mode, max streak, expressions, equations, players and fail role').addChannelOption(o=>chanOpt(o,'Counting channel whose mode to show (if you have several)'))),
        new SlashCommandBuilder().setName('transfer').setDescription('Move counting here: read the latest count in a channel and carry on from it')
            .addChannelOption(o=>chanOpt(o,'The channel to count in',true))
            .addStringOption(o=>o.setName('mode').setDescription('Counting mode (default: the channel\'s current mode, else Interactive)').addChoices(...MODE_CHOICES)),
        new SlashCommandBuilder().setName('config').setDescription('Configure bot settings')
            .addSubcommand(s=>s.setName('access').setDescription('Set which role can use config')),
        new SlashCommandBuilder().setName('leaderboard').setDescription('View leaderboards')
            .addSubcommand(s=>s.setName('server').setDescription('Top counters in this server'))
            .addSubcommand(s=>s.setName('global').setDescription('Global leaderboard'))
            .addSubcommand(s=>s.setName('highscores').setDescription('Channels by mode high score / cycles'))
            .addSubcommand(s=>s.setName('elo').setDescription('Elo ratings for a 1v1 game (shared across every server)').addStringOption(o=>o.setName('game').setDescription('Which game').setRequired(true).addChoices({name:'Tic tac toe',value:'tictactoe'},{name:'Connect 4',value:'connect4'},{name:'Guess Who',value:'guesswho'},{name:'Battleship',value:'sinkship'}))),
        new SlashCommandBuilder().setName('stats').setDescription('View counting stats').addUserOption(o=>o.setName('user').setDescription('User to check')),
        new SlashCommandBuilder().setName('calculate').setDescription('Calculate an expression, or get 3 expressions for a number').addStringOption(o=>o.setName('input').setDescription('A number or expression').setRequired(true)),
        new SlashCommandBuilder().setName('players').setDescription('Look up a football player, or find players with a given overall')
            .addStringOption(o=>o.setName('query').setDescription('A player name (add :fc25 for a game) or a number like 85').setRequired(true).setMaxLength(60)),
        new SlashCommandBuilder().setName('invite').setDescription('Invite this bot'),
        new SlashCommandBuilder().setName('help').setDescription('Browse help, or jump straight to a topic')
            .addStringOption(o=>o.setName('topic').setDescription('Jump straight to a topic').addChoices({name:'Counting',value:'counting'},{name:'Modes',value:'modes'},{name:'Expressions',value:'expressions'},{name:'Games',value:'games'},{name:'Admin',value:'admin'},{name:'All commands',value:'commands'},{name:'Links',value:'links'})),
    ];
    if (killbot) commands.push(killbot.command);
    if (games) commands.push(games.command);
    return commands.map(c=>c.toJSON());
}

module.exports = { buildCommands };

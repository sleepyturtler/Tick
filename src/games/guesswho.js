const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const store = require('./store');
const render = require('./render');
const { CHARACTERS } = require('./guesswho/characters');
const { EPH, png, mention, reject } = require('./common');
const { E } = require('../ui');

const info = {
    id: 'guesswho', label: 'Guess Who', emoji: '\u{1F464}', short: '2 players, narrow down your opponent\'s character',
    how: 'For 2 players. Each of you secretly picks one of 30 characters, then you ask each other yes or no questions in chat and remove the characters that can\'t be your opponent\'s. The first to get down to one character wins, if it is the right one. If it is the wrong one, you lose.',
};
const NAMES = CHARACTERS.map(c => c.name).sort();
const COLORS = ['#5865F2', '#eb459e'];

const ids = game => [game.state.a, game.state.b];
const other = (game, id) => (id === game.state.a ? game.state.b : game.state.a);
const chunks = arr => (arr.length > 25 ? [arr.slice(0, Math.ceil(arr.length / 2)), arr.slice(Math.ceil(arr.length / 2))] : [arr]);

async function payload(game, final) {
    const s = game.state, files = [], embeds = [], components = [];
    for (let i = 0; i < 2; i++) {
        const id = ids(game)[i], name = s.names[id];
        files.push(png(await render.guessBoard(new Set(s.remaining[id])), `board${i}.png`));
        const status = game.phase === 'pick' ? (s.picks[id] ? '\u2705 Character picked' : '\u23F3 Choosing a character...') : `${s.remaining[id].length} character${s.remaining[id].length === 1 ? '' : 's'} left`;
        embeds.push(E(COLORS[i], `${name}'s board`).setDescription(`${mention(id)}\n${status}`).setImage(`attachment://board${i}.png`));
    }
    if (final) embeds[0].setDescription(`${embeds[0].data.description}\n\n${final}`);
    if (game.phase === 'pick') {
        for (const id of ids(game)) {
            const half = [NAMES.slice(0, 15), NAMES.slice(15)];
            half.forEach((list, h) => components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`g:${game.id}:pick:${id}:${h}`)
                .setPlaceholder(`${s.names[id]}: pick your character (${list[0]} to ${list[list.length - 1]})`.slice(0, 150)).addOptions(list.map(n => ({ label: n, value: n }))))));
        }
    } else if (game.phase === 'play') {
        for (const id of ids(game)) {
            chunks(s.remaining[id]).forEach((list, h) => components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`g:${game.id}:rm:${id}:${h}`)
                .setPlaceholder(`${s.names[id]}: remove characters`.slice(0, 150)).setMinValues(1).setMaxValues(list.length).addOptions([...list].sort().map(n => ({ label: n, value: n }))))));
        }
    }
    if (game.phase !== 'over') components.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`g:${game.id}:me`).setLabel('My character').setStyle(ButtonStyle.Secondary)));
    return { embeds, components, files, attachments: [] };
}

async function start(interaction, { postInvite }) { await postInvite(interaction, 'guesswho'); }

async function onAccept(interaction, game) {
    game.state = { a: game.hostId, b: game.guestId, names: { [game.hostId]: game.hostName, [game.guestId]: game.guestName }, picks: {}, remaining: { [game.hostId]: [...NAMES], [game.guestId]: [...NAMES] } };
    game.phase = 'pick';
    store.save(game);
    return interaction.update(await payload(game));
}

async function handle(interaction, game, action, args) {
    const s = game.state, uid = interaction.user.id;
    if (action === 'me') {
        if (!ids(game).includes(uid)) return reject(interaction, "You're not in this game.");
        if (!s.picks[uid]) return reject(interaction, "You haven't picked a character yet.");
        return interaction.reply({ embeds: [E('#5865F2', 'Your character').setDescription('Only you can see this.').setImage('attachment://me.png')], files: [png(await render.characterCard(s.picks[uid]), 'me.png')], ...EPH });
    }
    if (action === 'pick' || action === 'rm') {
        const owner = args[0];
        if (!ids(game).includes(owner)) return;
        if (uid !== owner) return reject(interaction, `That's not your board. Use the menu with your name on it.`);
        if (action === 'pick') {
            if (game.phase !== 'pick') return reject(interaction, 'Picking is over.');
            const name = interaction.values[0];
            if (!NAMES.includes(name)) return;
            s.picks[uid] = name;
            if (s.picks[s.a] && s.picks[s.b]) game.phase = 'play';
            store.save(game);
            await interaction.update(await payload(game));
            return interaction.followUp({ content: game.phase === 'play' ? `You picked **${name}**. Both players are ready, the game has started! Remove characters with the menu with your name.` : `You picked **${name}**. Only you can see this. You can change it until your opponent has picked too.`, ...EPH });
        }
        if (game.phase !== 'play') return reject(interaction, 'The game has not started yet.');
        const values = interaction.values.filter(v => s.remaining[uid].includes(v));
        if (!values.length) return reject(interaction, 'Those are already removed.');
        if (values.length >= s.remaining[uid].length) return reject(interaction, "You can't remove everyone. Keep at least one character.");
        s.remaining[uid] = s.remaining[uid].filter(n => !values.includes(n));
        if (s.remaining[uid].length === 1) {
            const guess = s.remaining[uid][0], opp = other(game, uid), real = s.picks[opp], right = guess === real;
            const winner = right ? uid : opp;
            game.phase = 'over';
            const text = right ? `\u{1F3C6} ${mention(uid)} narrowed it down to **${guess}**, and that is ${mention(opp)}'s character! ${mention(uid)} wins!`
                : `\u{1F3C6} ${mention(uid)} narrowed it down to **${guess}**, but ${mention(opp)}'s character was **${real}**. ${mention(winner)} wins!`;
            const p = await payload(game, `${text}\n${mention(s.a)} was **${s.picks[s.a]}**, ${mention(s.b)} was **${s.picks[s.b]}**.`);
            store.remove(game);
            return interaction.update(p);
        }
        store.save(game);
        return interaction.update(await payload(game));
    }
}

module.exports = { info, start, onAccept, handle, payload, NAMES };

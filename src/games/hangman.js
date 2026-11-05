const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const store = require('./store');
const render = require('./render');
const { HANGMAN_WORDS } = require('./data');
const { png, mention, reject, pick, sendTo, deleteMessage, newId, displayName, EPH, withLock } = require('./common');
const { E } = require('../ui');

const info = {
    id: 'hangman', label: 'Hangman', emoji: '\u{1F524}', short: 'Guess the word by typing single letters in chat',
    how: 'For the whole channel. The host types a secret word or picks a random one, then everyone guesses by typing a single letter in the chat. Accented letters count as their own letter. Six wrong letters and the drawing is finished.',
};
const MAX_WRONG = 6;
const byChannel = new Map();   // channelId -> game id, so a typed letter finds its game without a database lookup
const isLetter = ch => /^\p{L}$/u.test(ch);
const norm = s => s.normalize('NFC').toLowerCase();

function slotsOf(s, reveal) {
    return Array.from(s.word.normalize('NFC')).map(ch => {
        if (!isLetter(ch)) return { ch, fixed: true };
        const l = norm(ch), up = ch.toUpperCase().length === 1 ? ch.toUpperCase() : ch, guessed = s.guessed.includes(l);
        return { ch: up, shown: guessed || reveal, missed: !guessed && reveal };
    });
}
const solved = s => Array.from(s.word).every(ch => !isLetter(ch) || s.guessed.includes(norm(ch)));

function payload(game, final) {
    const s = game.state, over = !!final;
    const board = png(render.hangman({ slots: slotsOf(s, over && final === 'lost'), wrong: s.wrong, stage: s.wrong.length, reveal: final }), 'board.png');
    let desc = over ? (final === 'won' ? `\u{1F3C6} Solved by ${mention(s.lastGuesser)}! The word was **${s.word}**.` : `\u{1F480} Out of guesses. The word was **${s.word}**.`)
        : `Type a **single letter** in this channel to guess. Longer messages are ignored.\n${s.hostSet ? `${mention(s.hostId)} chose the word and can't guess.` : `Random word, started by ${mention(s.hostId)}.`}`;
    return { embeds: [E(over ? (final === 'won' ? '#57f287' : '#ed4245') : '#5865F2', '\u{1F524} Hangman').setDescription(desc).setImage('attachment://board.png')], components: [], files: [board], attachments: [] };
}

async function start(interaction) {
    if (byChannel.has(interaction.channelId)) return interaction.update({ embeds: [E('#ff4444', 'Already running').setDescription('There is already a hangman game in this channel. Finish it first.')], components: [] });
    const game = { id: newId(), type: 'hangman', guildId: interaction.guild.id, channelId: interaction.channelId, messageId: null, hostId: interaction.user.id, userIds: [interaction.user.id], phase: 'setup', state: {}, createdAt: Date.now() };
    store.add(game);
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`g:${game.id}:random`).setLabel('Random word').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`g:${game.id}:custom`).setLabel('Type my own word').setStyle(ButtonStyle.Secondary));
    return interaction.update({ embeds: [E('#5865F2', '\u{1F524} Hangman').setDescription('Pick a random word, or type your own. If you type it, you are the host and can\'t guess.')], components: [row] });
}

async function begin(interaction, game, word, hostSet) {
    game.state = { word, guessed: [], wrong: [], hostId: game.hostId, hostSet, lastGuesser: null };
    game.phase = 'play'; game.userIds = [game.hostId];
    byChannel.set(game.channelId, game.id);
    const msg = await sendTo(game.channelId, payload(game));
    game.messageId = msg.id; game.userIds = [game.hostId]; store.save(game);
    const done = { embeds: [E('#57f287', 'Hangman started').setDescription('The board is in the channel. Guess by typing single letters there.')], components: [] };
    return interaction.isFromMessage?.() ? interaction.update(done) : interaction.reply({ ...done, ...EPH });
}

async function handle(interaction, game, action) {
    if (game.phase !== 'setup') return reject(interaction, 'This game has already started.');
    if (interaction.user.id !== game.hostId) return reject(interaction, 'Only the host can set up this game.');
    if (action === 'random') return begin(interaction, game, pick(HANGMAN_WORDS), false);
    if (action === 'custom') {
        const input = new TextInputBuilder().setCustomId('word').setLabel('Secret word (letters, spaces, hyphens)').setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(30).setRequired(true);
        return interaction.showModal(new ModalBuilder().setCustomId(`g:${game.id}:word`).setTitle('Choose your secret word').addComponents(new ActionRowBuilder().addComponents(input)));
    }
    if (action === 'word') {
        const word = interaction.fields.getTextInputValue('word').normalize('NFC').trim().replace(/\s+/g, ' ');
        if (!/^\p{L}[\p{L} '\-]{1,28}\p{L}$/u.test(word)) return reject(interaction, 'Use only letters, spaces, apostrophes and hyphens (3 to 30 characters).');
        return begin(interaction, game, word, true);
    }
}

// A typed message in a hangman channel. Only a message that is exactly one letter counts.
async function onMessage(message) {
    if (!message.guild || message.author.bot) return false;
    const id = byChannel.get(message.channelId);
    if (!id) return false;
    const letter = norm(message.content.trim());
    if (!isLetter(letter)) return false;
    const game = store.get(id);
    if (!game || game.phase !== 'play') return false;
    await withLock(game.id, async () => {
        const s = game.state;
        if (s.hostSet && message.author.id === s.hostId) return message.react('\u{1F6AB}').catch(() => {});
        if (s.guessed.includes(letter) || s.wrong.includes(letter)) return message.react('\u{1F501}').catch(() => {});
        const hit = norm(s.word).includes(letter);
        (hit ? s.guessed : s.wrong).push(letter);
        s.lastGuesser = message.author.id;
        message.react(hit ? '\u2705' : '\u274C').catch(() => {});
        const final = solved(s) ? 'won' : s.wrong.length >= MAX_WRONG ? 'lost' : null;
        const old = game.messageId;
        const msg = await sendTo(game.channelId, payload(game, final));   // new board at the bottom, old one removed
        await deleteMessage(game.channelId, old);
        if (final) { game.phase = 'over'; byChannel.delete(game.channelId); store.remove(game); }
        else { game.messageId = msg.id; store.save(game); }
    });
    return true;
}

const onRestore = g => { if (g.phase === 'play') byChannel.set(g.channelId, g.id); };
const onExpire = g => { if (byChannel.get(g.channelId) === g.id) byChannel.delete(g.channelId); };

module.exports = { info, start, handle, payload, onMessage, onRestore, onExpire, solved, slotsOf };

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const store = require('./store');
const render = require('./render');
const { HANGMAN_WORDS } = require('./data');
const { png, mention, reject, pick, sendTo, deleteMessage, newId, displayName, EPH, withLock, stopButton, textPayload } = require('./common');
const { E } = require('../ui');

const info = {
    id: 'hangman', label: 'Hangman', emoji: '\u{1F524}', short: 'Guess the word by typing single letters in chat',
    how: 'For the whole channel. The host types a secret word or picks a random one, then everyone guesses by typing a single letter in the chat, or the whole word to win straight away. Accented letters count as their own letter. Six wrong letters and the drawing is finished.',
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
    let desc = over ? (final === 'won' ? `\u{1F3C6} Solved by ${mention(s.lastGuesser)}!${s.viaFull ? ' They typed the whole word.' : ''} The word was **${s.word}**.` : `\u{1F480} Out of guesses. The word was **${s.word}**.`)
        : `Type a **single letter** in this channel to guess. Longer messages are ignored.\n${s.hostSet ? `${mention(s.hostId)} chose the word and can't guess.` : `Random word, started by ${mention(s.hostId)}.`}`;
    if (over) return textPayload(`${info.emoji} **${info.label}**: ${desc}`);   // a finished game leaves one line of text instead of the board
    return { embeds: [E(over ? (final === 'won' ? '#57f287' : '#ed4245') : '#5865F2', '\u{1F524} Hangman').setDescription(desc).setImage('attachment://board.png')], components: over ? [] : [new ActionRowBuilder().addComponents(stopButton(game))], files: [board], attachments: [] };
}

const SETUP_STALE_MS = 10 * 60 * 1000;   // a setup message nobody finished for this long no longer blocks the channel
// A game that is really in progress: it has a board, or its setup is recent. Anything else is a leftover and is cleared out of the way.
const isLive = g => (g.phase === 'play' ? !!g.messageId : g.phase === 'setup' && Date.now() - g.createdAt < SETUP_STALE_MS);
const drop = g => { if (byChannel.get(g.channelId) === g.id) byChannel.delete(g.channelId); store.remove(g); };

function setupPayload(game, note) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`g:${game.id}:random`).setLabel('Random word').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`g:${game.id}:custom`).setLabel('Type my own word').setStyle(ButtonStyle.Secondary));
    return { embeds: [E('#5865F2', '\u{1F524} Hangman').setDescription(`${note ? `${note}\n\n` : ''}Pick a random word, or type your own. If you type it, you are the host and can't guess.`)], components: [row] };
}
const permissionError = e => e?.code === 50013 || e?.status === 403;

async function start(interaction) {
    const running = byChannel.get(interaction.channelId), other = running && store.get(running);
    if (other && isLive(other)) return interaction.update({ embeds: [E('#ff4444', 'Already running').setDescription('There is already a hangman game in this channel (or someone is setting one up). Only one at a time, so finish or wait for it first.')], components: [] });
    if (other) drop(other);   // a leftover: never got a board, or the setup was abandoned
    const game = { id: newId(), type: 'hangman', guildId: interaction.guild.id, channelId: interaction.channelId, messageId: null, hostId: interaction.user.id, userIds: [interaction.user.id], phase: 'setup', state: {}, createdAt: Date.now() };
    byChannel.set(game.channelId, game.id);   // reserved right away, not only once the word is chosen
    store.add(game);
    return interaction.update(setupPayload(game));
}

// The game only counts as started once its board is in the channel. If posting fails, it goes back to the setup step and the host is told why.
async function begin(interaction, game, word, hostSet) {
    // Answer the press first: Discord allows 3 seconds, and drawing and posting the board can take longer.
    const inPlace = !!(interaction.isMessageComponent?.() || interaction.isFromMessage?.());
    try { if (inPlace) await interaction.deferUpdate(); else await interaction.deferReply(EPH); } catch (e) { console.error('hangman ack:', e.message); }
    const next = { ...game, phase: 'play', userIds: [game.hostId], state: { word, guessed: [], wrong: [], hostId: game.hostId, hostSet, lastGuesser: null } };
    let msg;
    try { msg = await sendTo(game.channelId, payload(next)); }
    catch (e) {
        console.error('hangman board:', e.message);
        const why = permissionError(e) ? "I couldn't post the board in this channel. I need **View Channel**, **Send Messages** and **Attach Files** here." : "Discord didn't accept the board. Try again in a moment.";
        return interaction.editReply(setupPayload(game, `\u26A0\uFE0F ${why}`)).catch(() => {});
    }
    game.state = next.state; game.phase = 'play'; game.userIds = [game.hostId]; game.messageId = msg.id;
    byChannel.set(game.channelId, game.id); store.save(game);
    // The board is up. If this confirmation cannot be delivered (the press took too long), nothing is lost.
    return interaction.editReply({ embeds: [E('#57f287', 'Hangman started').setDescription('The board is in the channel. Guess by typing single letters there.')], components: [] }).catch(e => console.error('hangman confirm:', e.message));
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

// A typed message in a hangman channel. A message that is exactly one letter is a guess, and a message that is exactly the secret word wins.
// Anything else is just chat and is ignored.
async function onMessage(message) {
    if (!message.guild || message.author.bot) return false;
    const id = byChannel.get(message.channelId);
    if (!id) return false;
    const game = store.get(id);
    if (!game || game.phase !== 'play') return false;
    const text = norm(message.content.trim().replace(/\s+/g, ' '));
    const single = isLetter(text), full = !single && text === norm(game.state.word.replace(/\s+/g, ' '));
    if (!single && !full) return false;
    await withLock(game.id, async () => {
        const s = game.state;
        if (s.hostSet && message.author.id === s.hostId) return message.react('\u{1F6AB}').catch(() => {});
        if (!game.userIds.includes(message.author.id)) game.userIds.push(message.author.id);   // guessers count as players, so they can press Stop
        let final = null;
        if (full) {
            s.guessed = [...new Set(Array.from(s.word).filter(isLetter).map(norm))]; s.lastGuesser = message.author.id; s.viaFull = true; final = 'won';
            message.react('\u2705').catch(() => {});
        } else {
            if (s.guessed.includes(text) || s.wrong.includes(text)) return message.react('\u{1F501}').catch(() => {});
            const hit = norm(s.word).includes(text);
            (hit ? s.guessed : s.wrong).push(text);
            s.lastGuesser = message.author.id;
            message.react(hit ? '\u2705' : '\u274C').catch(() => {});
            final = solved(s) ? 'won' : s.wrong.length >= MAX_WRONG ? 'lost' : null;
        }
        const old = game.messageId;
        let msg = null;   // new board at the bottom, old one removed. The guess is kept even when the board cannot be posted.
        for (let attempt = 0; attempt < 2 && !msg; attempt++) {
            try { msg = await sendTo(game.channelId, payload(game, final)); }
            catch (e) { console.error('hangman board:', e.message); if (permissionError(e)) break; await new Promise(r => setTimeout(r, 300)); }
        }
        if (msg) await deleteMessage(game.channelId, old);
        if (final) { game.phase = 'over'; byChannel.delete(game.channelId); store.remove(game); }
        else { if (msg) game.messageId = msg.id; store.save(game); }
    });
    return true;
}

const onRestore = g => { if (g.phase === 'play' || g.phase === 'setup') byChannel.set(g.channelId, g.id); };
const onExpire = g => { if (byChannel.get(g.channelId) === g.id) byChannel.delete(g.channelId); };

module.exports = { info, start, handle, payload, onMessage, onRestore, onExpire, solved, slotsOf };

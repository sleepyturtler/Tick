const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const store = require('./store');
const render = require('./render');
const { png, mention, reject } = require('./common');
const { E } = require('../ui');

const info = {
    id: 'tictactoe', label: 'Tic tac toe', emoji: '\u2B55', short: '2 players, first to three in a row wins',
    how: 'For 2 players. Someone accepts your invitation, then you take turns pressing a numbered square on a shared board. First to three in a row wins.',
};
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
function winner(b) { for (const l of LINES) if (b[l[0]] && b[l[0]] === b[l[1]] && b[l[1]] === b[l[2]]) return { mark: b[l[0]], line: l }; return null; }

function payload(game) {
    const s = game.state, w = winner(s.board), full = s.board.every(Boolean), over = !!w || full;
    const turnId = s.turn === 'x' ? s.x : s.o;
    const status = w ? `\u{1F3C6} ${mention(w.mark === 'x' ? s.x : s.o)} wins!` : full ? "It's a draw!" : `${s.turn === 'x' ? '\u274C' : '\u2B55'} ${mention(turnId)} to play`;
    const embed = E(w ? '#fee75c' : '#5865F2', '\u2B55 Tic tac toe').setDescription(`\u274C ${mention(s.x)}  vs  \u2B55 ${mention(s.o)}\n${status}`).setImage('attachment://board.png');
    const rows = [0, 1, 2].map(r => new ActionRowBuilder().addComponents([0, 1, 2].map(c => {
        const i = r * 3 + c, v = s.board[i];
        return new ButtonBuilder().setCustomId(`g:${game.id}:m:${i}`).setLabel(v ? v.toUpperCase() : String(i + 1)).setStyle(v === 'x' ? ButtonStyle.Danger : v === 'o' ? ButtonStyle.Primary : ButtonStyle.Secondary).setDisabled(!!v || over);
    })));
    return { embeds: [embed], components: rows, files: [png(render.tictactoe(s.board, w?.line), 'board.png')], attachments: [] };
}

async function start(interaction, { postInvite }) { await postInvite(interaction, 'tictactoe'); }

async function onAccept(interaction, game) {
    game.state = { board: Array(9).fill(''), x: game.hostId, o: game.guestId, turn: 'x' };
    store.save(game);
    return interaction.update(payload(game));
}

async function handle(interaction, game, action, args) {
    if (action !== 'm' || game.phase !== 'play') return reject(interaction, 'This game is over.');
    const s = game.state, i = Number(args[0]), uid = interaction.user.id;
    if (uid !== s.x && uid !== s.o) return reject(interaction, "You're not in this game.");
    if (uid !== (s.turn === 'x' ? s.x : s.o)) return reject(interaction, "It's not your turn.");
    if (!(i >= 0 && i < 9) || s.board[i]) return reject(interaction, 'That square is taken.');
    s.board[i] = s.turn;
    if (winner(s.board) || s.board.every(Boolean)) { game.phase = 'over'; const p = payload(game); store.remove(game); return interaction.update(p); }
    s.turn = s.turn === 'x' ? 'o' : 'x';
    store.save(game);
    return interaction.update(payload(game));
}

module.exports = { info, start, onAccept, handle, payload, winner };

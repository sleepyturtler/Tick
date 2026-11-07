const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const store = require('./store');
const render = require('./render');
const { png, mention, reject, shuffle } = require('./common');
const { E } = require('../ui');

const info = {
    id: 'connect4', label: 'Connect 4', emoji: '\u{1F534}', short: '2 players, connect four discs in a line',
    how: 'For 2 players. Someone accepts your invitation, a random player starts, and you take turns dropping a disc into a column. First to connect four in a row, column or diagonal wins.',
};

// board[row][col], row 0 is the top. Returns the four winning cells, or null.
function findWin(b) {
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) {
        const v = b[r][c]; if (!v) continue;
        for (const [dr, dc] of dirs) {
            const cells = [[r, c]];
            for (let k = 1; k < 4; k++) { const rr = r + dr * k, cc = c + dc * k; if (rr < 0 || rr > 5 || cc < 0 || cc > 6 || b[rr][cc] !== v) break; cells.push([rr, cc]); }
            if (cells.length === 4) return { player: v, cells };
        }
    }
    return null;
}
const isFull = b => b[0].every(Boolean);

function payload(game) {
    const s = game.state, w = findWin(s.board), full = isFull(s.board), over = !!w || full;
    const turnId = s.turn === 1 ? s.red : s.yellow;
    const status = w ? `\u{1F3C6} ${mention(w.player === 1 ? s.red : s.yellow)} wins!` : full ? "It's a draw!" : `${s.turn === 1 ? '\u{1F534}' : '\u{1F7E1}'} ${mention(turnId)} to play`;
    const embed = E(w ? '#fee75c' : '#5865F2', '\u{1F534} Connect 4').setDescription(`\u{1F534} ${mention(s.red)}  vs  \u{1F7E1} ${mention(s.yellow)}\n${status}`).setImage('attachment://board.png');
    const btn = c => new ButtonBuilder().setCustomId(`g:${game.id}:d:${c}`).setLabel(String(c + 1)).setStyle(ButtonStyle.Primary).setDisabled(over || s.board[0][c] !== 0);
    const rows = [new ActionRowBuilder().addComponents([0, 1, 2, 3, 4].map(btn)), new ActionRowBuilder().addComponents([5, 6].map(btn))];
    return { embeds: [embed], components: rows, files: [png(render.connect4(s.board, w?.cells), 'board.png')], attachments: [] };
}

async function start(interaction, { postInvite }) { await postInvite(interaction, 'connect4'); }

async function onAccept(interaction, game) {
    const [red, yellow] = shuffle([game.hostId, game.guestId]);   // red always moves first, and who gets red is random
    game.state = { board: Array.from({ length: 6 }, () => Array(7).fill(0)), red, yellow, turn: 1 };
    store.save(game);
    return interaction.update(payload(game));
}

async function handle(interaction, game, action, args) {
    if (action !== 'd' || game.phase !== 'play') return reject(interaction, 'This game is over.');
    const s = game.state, col = Number(args[0]), uid = interaction.user.id;
    if (uid !== s.red && uid !== s.yellow) return reject(interaction, "You're not in this game.");
    if (uid !== (s.turn === 1 ? s.red : s.yellow)) return reject(interaction, "It's not your turn.");
    if (!(col >= 0 && col < 7)) return;
    let row = -1; for (let r = 5; r >= 0; r--) if (s.board[r][col] === 0) { row = r; break; }
    if (row < 0) return reject(interaction, 'That column is full.');
    s.board[row][col] = s.turn;
    if (findWin(s.board) || isFull(s.board)) { game.phase = 'over'; const p = payload(game); store.remove(game); return interaction.update(p); }
    s.turn = s.turn === 1 ? 2 : 1;
    store.save(game);
    return interaction.update(payload(game));
}

module.exports = { info, start, onAccept, handle, payload, findWin };

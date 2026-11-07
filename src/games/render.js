// All board pictures. Every function returns a PNG Buffer (or a Promise of one).
const path = require('path');
const { createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas');
const { CHARACTERS } = require('./guesswho/characters');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
GlobalFonts.registerFromPath(path.join(ASSETS, 'fonts', 'DejaVuSans.ttf'), 'GF');
GlobalFonts.registerFromPath(path.join(ASSETS, 'fonts', 'DejaVuSans-Bold.ttf'), 'GFB');

const BG = '#2b2d31', LINE = '#4e5058', TEXT = '#f2f3f5';
const make = (w, h, bg = BG) => { const c = createCanvas(w, h), g = c.getContext('2d'); if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); } return { c, g }; };
const out = c => c.toBuffer('image/png');

// ---------- tic tac toe ----------
function tictactoe(board, winLine) {
    const S = 360, cell = S / 3, { c, g } = make(S, S);
    g.strokeStyle = LINE; g.lineWidth = 6; g.lineCap = 'round';
    for (let i = 1; i < 3; i++) { g.beginPath(); g.moveTo(i * cell, 14); g.lineTo(i * cell, S - 14); g.stroke(); g.beginPath(); g.moveTo(14, i * cell); g.lineTo(S - 14, i * cell); g.stroke(); }
    board.forEach((v, i) => {
        const cx = (i % 3) * cell + cell / 2, cy = Math.floor(i / 3) * cell + cell / 2, r = cell * 0.27;
        g.lineWidth = 14;
        if (v === 'x') { g.strokeStyle = '#ed4245'; g.beginPath(); g.moveTo(cx - r, cy - r); g.lineTo(cx + r, cy + r); g.moveTo(cx + r, cy - r); g.lineTo(cx - r, cy + r); g.stroke(); }
        else if (v === 'o') { g.strokeStyle = '#5865f2'; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke(); }
        else { g.fillStyle = '#6d6f78'; g.font = 'bold 26px GFB'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(i + 1), cx, cy); }
    });
    if (winLine) {
        const p = i => [(i % 3) * cell + cell / 2, Math.floor(i / 3) * cell + cell / 2];
        const [x1, y1] = p(winLine[0]), [x2, y2] = p(winLine[2]);
        g.strokeStyle = '#fee75c'; g.lineWidth = 10; g.globalAlpha = 0.9; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    }
    return out(c);
}

// ---------- connect 4 ----------
// board[row][col], row 0 is the top, values 0 empty, 1 red, 2 yellow
function connect4(board, winCells) {
    const cell = 64, pad = 16, top = 34, W = 7 * cell + pad * 2, H = 6 * cell + pad * 2 + top, { c, g } = make(W, H);
    g.fillStyle = '#1f4fa8'; g.beginPath(); g.roundRect(0, top, W, H - top, 18); g.fill();
    g.fillStyle = '#9aa0ad'; g.font = 'bold 20px GFB'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let col = 0; col < 7; col++) g.fillText(String(col + 1), pad + col * cell + cell / 2, top / 2 + 2);
    const win = new Set((winCells || []).map(([r, cc]) => r * 7 + cc));
    for (let r = 0; r < 6; r++) for (let col = 0; col < 7; col++) {
        const cx = pad + col * cell + cell / 2, cy = top + pad + r * cell + cell / 2, v = board[r][col];
        g.fillStyle = v === 1 ? '#e74c3c' : v === 2 ? '#f1c40f' : '#16264a';
        g.beginPath(); g.arc(cx, cy, cell * 0.4, 0, Math.PI * 2); g.fill();
        if (v) { g.fillStyle = 'rgba(255,255,255,0.18)'; g.beginPath(); g.arc(cx - 8, cy - 9, cell * 0.16, 0, Math.PI * 2); g.fill(); }
        if (win.has(r * 7 + col)) { g.strokeStyle = '#ffffff'; g.lineWidth = 5; g.beginPath(); g.arc(cx, cy, cell * 0.4, 0, Math.PI * 2); g.stroke(); }
    }
    return out(c);
}

// ---------- hangman ----------
// slots: [{ ch, shown }] (shown false draws an empty slot), wrong: letters, stage 0..6
function hangman({ slots, wrong, stage, reveal }) {
    const W = 640, H = 360, { c, g } = make(W, H);
    g.strokeStyle = '#b5bac1'; g.lineWidth = 8; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(30, 330); g.lineTo(230, 330); g.moveTo(80, 330); g.lineTo(80, 40); g.lineTo(190, 40); g.lineTo(190, 80); g.stroke();
    g.strokeStyle = '#ed4245'; g.lineWidth = 7;
    const part = [
        () => { g.beginPath(); g.arc(190, 108, 28, 0, Math.PI * 2); g.stroke(); },
        () => { g.beginPath(); g.moveTo(190, 136); g.lineTo(190, 220); g.stroke(); },
        () => { g.beginPath(); g.moveTo(190, 154); g.lineTo(150, 195); g.stroke(); },
        () => { g.beginPath(); g.moveTo(190, 154); g.lineTo(230, 195); g.stroke(); },
        () => { g.beginPath(); g.moveTo(190, 220); g.lineTo(155, 275); g.stroke(); },
        () => { g.beginPath(); g.moveTo(190, 220); g.lineTo(225, 275); g.stroke(); },
    ];
    for (let i = 0; i < Math.min(stage, 6); i++) part[i]();
    // the word, in rows of up to 12 slots
    const per = 12, rows = Math.ceil(slots.length / per), sw = Math.min(40, 330 / Math.min(per, slots.length)), area = { x: 280, w: 340 };
    g.textAlign = 'center'; g.textBaseline = 'middle';
    slots.forEach((s, i) => {
        const row = Math.floor(i / per), inRow = Math.min(per, slots.length - row * per), col = i % per;
        const x = area.x + (area.w - inRow * sw) / 2 + col * sw + sw / 2, y = 90 + row * 64 - (rows - 1) * 22;
        if (s.fixed) { g.fillStyle = '#b5bac1'; g.font = `bold ${Math.round(sw * 0.7)}px GFB`; g.fillText(s.ch, x, y); return; }
        g.strokeStyle = '#80848e'; g.lineWidth = 3; g.beginPath(); g.moveTo(x - sw * 0.4, y + 22); g.lineTo(x + sw * 0.4, y + 22); g.stroke();
        if (s.shown) { g.fillStyle = s.missed ? '#ed4245' : TEXT; g.font = `bold ${Math.round(sw * 0.9)}px GFB`; g.fillText(s.ch, x, y); }
    });
    g.fillStyle = '#9aa0ad'; g.font = 'bold 20px GFB'; g.textAlign = 'left';
    g.fillText(`Wrong (${wrong.length}/6)`, 280, 255);
    g.fillStyle = '#ed4245'; g.font = 'bold 30px GFB'; g.fillText(wrong.length ? wrong.map(l => l.toUpperCase()).join(' ') : '-', 280, 295);
    if (reveal) { g.fillStyle = reveal === 'won' ? '#57f287' : '#ed4245'; g.font = 'bold 22px GFB'; g.fillText(reveal === 'won' ? 'Solved!' : 'Out of guesses', 280, 335); }
    return out(c);
}

// ---------- sink the ship ----------
const COLS = 'abcdefghij';
const rng = seed => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
function splash(g, cx, cy, s) {
    g.strokeStyle = 'rgba(255,255,255,0.95)'; g.fillStyle = 'rgba(255,255,255,0.95)';
    for (const [r, a] of [[0.14, 1], [0.26, 0.75], [0.38, 0.45]]) { g.globalAlpha = a; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, s * r, 0, Math.PI * 2); g.stroke(); }
    g.globalAlpha = 1;
    for (let i = 0; i < 6; i++) { const ang = i / 6 * Math.PI * 2 + 0.4; g.beginPath(); g.arc(cx + Math.cos(ang) * s * 0.3, cy + Math.sin(ang) * s * 0.3 - s * 0.04, s * 0.045, 0, Math.PI * 2); g.fill(); }
}
function redX(g, cx, cy, s) {
    const r = s * 0.3;
    for (const [col, w] of [['#4a0b0b', 13], ['#ed4245', 8]]) { g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'round'; g.beginPath(); g.moveTo(cx - r, cy - r); g.lineTo(cx + r, cy + r); g.moveTo(cx + r, cy - r); g.lineTo(cx - r, cy + r); g.stroke(); }
}
// A ship tile that has been hit: scorched hull, cracks, a missing corner and rubble falling into the water.
function crumbled(g, px, py, cell, seed) {
    const r = rng(seed), cx = px + cell / 2, cy = py + cell / 2;
    g.fillStyle = '#2d3036'; g.beginPath(); g.roundRect(px + 4, py + 4, cell - 8, cell - 8, 8); g.fill();
    const glow = g.createRadialGradient(cx, cy, 2, cx, cy, cell * 0.58); glow.addColorStop(0, 'rgba(255,150,40,0.9)'); glow.addColorStop(0.6, 'rgba(255,90,30,0.35)'); glow.addColorStop(1, 'rgba(255,80,20,0)');
    g.fillStyle = glow; g.fillRect(px, py, cell, cell);
    // broken-off corner, showing water
    const corner = Math.floor(r() * 4), cs = cell * (0.28 + r() * 0.12), cxs = corner % 2 ? px + cell - 4 : px + 4, cys = corner < 2 ? py + 4 : py + cell - 4, sx = corner % 2 ? -1 : 1, sy = corner < 2 ? 1 : -1;
    g.fillStyle = '#1f5b93'; g.beginPath(); g.moveTo(cxs, cys); g.lineTo(cxs + sx * cs, cys); g.lineTo(cxs + sx * cs * 0.3, cys + sy * cs * 0.55); g.lineTo(cxs, cys + sy * cs); g.closePath(); g.fill();
    // cracks
    g.strokeStyle = '#0d0e10'; g.lineWidth = Math.max(2, cell * 0.045); g.lineCap = 'round'; g.lineJoin = 'round';
    for (let i = 0; i < 3; i++) {
        let x = px + 6 + r() * (cell - 12), y = py + 6 + r() * (cell - 12); g.beginPath(); g.moveTo(x, y);
        for (let k = 0; k < 3; k++) { x += (cx - x) * 0.35 + (r() - 0.5) * cell * 0.5; y += (cy - y) * 0.35 + (r() - 0.5) * cell * 0.5; g.lineTo(x, y); }
        g.stroke();
    }
    // loose chunks of hull
    for (let i = 0; i < 6; i++) {
        const x = px + 8 + r() * (cell - 16), y = py + 8 + r() * (cell - 16), sz = cell * (0.07 + r() * 0.08);
        g.fillStyle = r() < 0.5 ? '#868c97' : '#5a5f69'; g.beginPath(); g.moveTo(x, y - sz); g.lineTo(x + sz, y + sz * 0.6); g.lineTo(x - sz * 0.8, y + sz); g.closePath(); g.fill();
    }
    // rubble that fell into the water around the tile
    for (let i = 0; i < 5; i++) {
        const ang = r() * Math.PI * 2, d = cell * (0.5 + r() * 0.16), x = cx + Math.cos(ang) * d, y = cy + Math.sin(ang) * d, sz = cell * (0.035 + r() * 0.04);
        g.globalAlpha = 0.85; g.fillStyle = '#3d4149'; g.beginPath(); g.moveTo(x, y - sz); g.lineTo(x + sz, y + sz); g.lineTo(x - sz, y + sz * 0.7); g.closePath(); g.fill();
    }
    g.globalAlpha = 1;
}
function drawShip(g, cells, cell, m, fill, edge, inner) {
    const xs = cells.map(p => p.x), ys = cells.map(p => p.y), x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0 + 1, h = Math.max(...ys) - y0 + 1;
    g.fillStyle = fill; g.strokeStyle = edge; g.lineWidth = 3;
    g.beginPath(); g.roundRect(m + x0 * cell + 5, m + y0 * cell + 5, w * cell - 10, h * cell - 10, 14); g.fill(); g.stroke();
    if (inner) { g.fillStyle = inner; g.beginPath(); g.roundRect(m + x0 * cell + 10, m + y0 * cell + 10, w * cell - 20, h * cell - 20, 10); g.fill(); }
}
// mode 'own': ships are yours, hits crumble the tile. mode 'enemy': your shots, with sunk enemy ships revealed.
// ships / revealed: arrays of cell lists [{x,y}...]; shots: { "x,y": 'hit' | 'miss' }
function seaBoard({ size = 8, ships = [], revealed = [], shots = {}, mode = 'enemy' }) {
    const cell = size <= 6 ? 66 : size <= 8 ? 54 : 46, m = 36, W = m + size * cell + 10, H = m + size * cell + 10, { c, g } = make(W, H, '#1e2124');
    const grad = g.createLinearGradient(0, m, 0, H); grad.addColorStop(0, '#2f7fc1'); grad.addColorStop(1, '#1a4f86');
    g.fillStyle = grad; g.fillRect(m, m, size * cell, size * cell);
    g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 1.5;
    for (let i = 0; i <= size; i++) { g.beginPath(); g.moveTo(m + i * cell, m); g.lineTo(m + i * cell, m + size * cell); g.stroke(); g.beginPath(); g.moveTo(m, m + i * cell); g.lineTo(m + size * cell, m + i * cell); g.stroke(); }
    g.fillStyle = '#b5bac1'; g.font = 'bold 20px GFB'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let i = 0; i < size; i++) { g.fillText(COLS[i], m + i * cell + cell / 2, m / 2); g.fillText(String(i + 1), m / 2, m + i * cell + cell / 2); }
    for (const cells of ships) drawShip(g, cells, cell, m, '#6b7280', '#2b2f36', '#9aa1ad');
    for (const cells of revealed) drawShip(g, cells, cell, m, '#7a4a4f', '#3b1d20', '#a0646a');   // sunk enemy ships show up on your board
    for (const [key, res] of Object.entries(shots)) {
        const [x, y] = key.split(',').map(Number), px = m + x * cell, py = m + y * cell, cx = px + cell / 2, cy = py + cell / 2;
        if (res === 'hit') { if (mode === 'own') crumbled(g, px, py, cell, x * 131 + y * 17 + size); else redX(g, cx, cy, cell); }
        else splash(g, cx, cy, cell);
    }
    return out(c);
}

// ---------- guess who ----------
const sprites = new Map();
async function sprite(name) {
    if (!sprites.has(name)) sprites.set(name, loadImage(path.join(ASSETS, 'guesswho', `${name.toLowerCase()}.png`)));
    return sprites.get(name);
}
// remaining: Set of names still on the board
async function guessBoard(remaining) {
    const cw = 124, ch = 154, gap = 5, cols = 6, rows = 5, W = cols * (cw + gap) + gap, H = rows * (ch + gap) + gap, { c, g } = make(W, H);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let i = 0; i < CHARACTERS.length; i++) {
        const name = CHARACTERS[i].name, x = gap + (i % cols) * (cw + gap), y = gap + Math.floor(i / cols) * (ch + gap), alive = remaining.has(name);
        g.fillStyle = '#36393f'; g.beginPath(); g.roundRect(x, y, cw, ch, 10); g.fill();
        g.drawImage(await sprite(name), x + 2, y + 2, cw - 4, cw - 4);
        g.fillStyle = alive ? TEXT : '#80848e'; g.font = 'bold 17px GFB'; g.fillText(name, x + cw / 2, y + cw + 16);
        if (!alive) {
            g.fillStyle = 'rgba(30,31,34,0.72)'; g.beginPath(); g.roundRect(x, y, cw, ch, 10); g.fill();
            g.strokeStyle = '#ed4245'; g.lineWidth = 8; g.lineCap = 'round';
            g.beginPath(); g.moveTo(x + 28, y + 28); g.lineTo(x + cw - 28, y + cw - 28); g.moveTo(x + cw - 28, y + 28); g.lineTo(x + 28, y + cw - 28); g.stroke();
        }
    }
    return out(c);
}
async function characterCard(name) {
    const { c, g } = make(300, 340); g.textAlign = 'center';
    g.drawImage(await sprite(name), 22, 12, 256, 256);
    g.fillStyle = TEXT; g.font = 'bold 34px GFB'; g.fillText(name, 150, 316);
    return out(c);
}

module.exports = { tictactoe, connect4, hangman, seaBoard, guessBoard, characterCard };

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const store = require('./store');
const render = require('./render');
const { EPH, png, mention, reject, pick, editMessage } = require('./common');
const { E } = require('../ui');

const info = {
    id: 'sinkship', label: 'Sink the Ship', emoji: '\u{1F6A2}', short: '2 players, place ships and sink your opponent\'s fleet',
    how: 'For 2 players, with private boards. The host picks a preset (Quick, Classic or Grand), you each place your ships, then take turns firing at a square like b7. A red X is a hit and a splash is a miss. Sink every enemy ship to win. A random player starts.',
};
const PRESETS = {
    quick: { label: 'Quick', size: 6, lens: [3, 2, 1], blurb: '6x6 board, 3 ships (1x3, 2x1, 1x1)' },
    classic: { label: 'Classic', size: 8, lens: [3, 2, 2, 1, 1], blurb: '8x8 board, 5 ships (1x3, two 2x1, two 1x1)' },
    grand: { label: 'Grand', size: 10, lens: [4, 3, 3, 2, 2, 1, 1], blurb: '10x10 board, 7 ships (1x4, two 1x3, two 2x1, two 1x1)' },
};
const COLS = 'abcdefghij';
const key = (x, y) => `${x},${y}`;
const sq = (x, y) => `${COLS[x]}${y + 1}`;
const other = (s, id) => (id === s.p[0] ? s.p[1] : s.p[0]);
const cfg = s => ({ size: s.size ?? 8, lens: s.lens ?? [3, 2, 2, 1, 1] });
const ORD = ['first', 'second', 'third'];
function labelsFor(lens) {
    const base = l => (l === 1 ? '1x1' : l === 2 ? '2x1' : `1x${l}`), seen = {}, total = {};
    lens.forEach(l => { total[l] = (total[l] ?? 0) + 1; });
    return lens.map(l => { const n = seen[l] = (seen[l] ?? -1) + 1; return `${base(l)} ship${total[l] > 1 ? ` (${ORD[n]})` : ''}`; });
}

// ---------- ship geometry ----------
const cellsOf = (ship, len) => Array.from({ length: len }, (_, i) => (ship.dir === 'V' ? { x: ship.x, y: ship.y + i } : { x: ship.x + i, y: ship.y }));
function canPlace(ships, idx, x, y, dir, size, lens) {
    const cells = cellsOf({ x, y, dir }, lens[idx]);
    if (cells.some(c => c.x < 0 || c.x >= size || c.y < 0 || c.y >= size)) return false;
    const taken = new Set();
    ships.forEach((sh, i) => { if (sh && i !== idx) cellsOf(sh, lens[i]).forEach(c => taken.add(key(c.x, c.y))); });
    return !cells.some(c => taken.has(key(c.x, c.y)));
}
function randomFleet(size, lens) {
    const ships = Array(lens.length).fill(null);
    lens.forEach((len, i) => {
        for (let tries = 0; tries < 800; tries++) {
            const dir = len === 1 ? 'H' : Math.random() < 0.5 ? 'H' : 'V', x = Math.floor(Math.random() * size), y = Math.floor(Math.random() * size);
            if (canPlace(ships, i, x, y, dir, size, lens)) { ships[i] = { x, y, dir }; return; }
        }
    });
    return ships;
}
function parseSquare(text, size = 8) {
    const t = String(text).trim().toLowerCase().replace(/\s+/g, '');
    const m = /^([a-j])(\d{1,2})$/.exec(t), n = /^(\d{1,2})([a-j])$/.exec(t);
    const [col, row] = m ? [m[1], m[2]] : n ? [n[2], n[1]] : [null, null];
    if (!col) return null;
    const x = COLS.indexOf(col), y = Number(row) - 1;
    return x < size && y >= 0 && y < size ? { x, y } : null;
}
const isSunk = (ship, len, shots) => cellsOf(ship, len).every(c => shots[key(c.x, c.y)] === 'hit');
const allSunk = (board, shots, lens) => board.ships.every((sh, i) => sh && isSunk(sh, lens[i], shots));
const allPlaced = board => board.ships.every(Boolean);

// ---------- what each player sees ----------
function viewFor(game, uid) {
    const s = game.state, { size, lens } = cfg(s), names = labelsFor(lens), me = s.boards[uid], opp = s.boards[other(s, uid)], oppId = other(s, uid);
    const ownShips = me.ships.map((sh, i) => (sh ? cellsOf(sh, lens[i]) : null)).filter(Boolean);
    const sunkEnemy = opp.ships.map((sh, i) => (sh && isSunk(sh, lens[i], me.shots) ? cellsOf(sh, lens[i]) : null)).filter(Boolean);
    const files = [png(render.seaBoard({ size, mode: 'enemy', shots: me.shots, revealed: sunkEnemy }), 'enemy.png'), png(render.seaBoard({ size, mode: 'own', ships: ownShips, shots: opp.shots }), 'own.png')];
    const mineSunk = me.ships.filter((sh, i) => sh && isSunk(sh, lens[i], opp.shots)).length;
    let top, bottom = `Ships placed: ${me.ships.filter(Boolean).length}/${lens.length}`;
    const comps = [];
    if (game.phase === 'setup') {
        const sel = Math.min(s.selected[uid] ?? 0, lens.length - 1);
        top = me.ready ? 'You are ready. Waiting for your opponent to finish placing ships.'
            : `Place all ${lens.length} ships on the bottom board, then press **Ready**.\nSelected: **${names[sel]}**. Pick a ship, press **Place**, and type a start square like \`c4\`${lens[sel] > 1 ? ' and a direction (H or V)' : ''}.`;
        if (!me.ready) {
            const select = new StringSelectMenuBuilder().setCustomId(`g:${game.id}:ship`).setPlaceholder('Choose a ship to place')
                .addOptions(lens.map((l, i) => ({ label: `${names[i]}${me.ships[i] ? ` (at ${sq(me.ships[i].x, me.ships[i].y)}${l > 1 ? `, ${me.ships[i].dir}` : ''})` : ' (not placed)'}`.slice(0, 100), value: String(i), default: sel === i })));
            comps.push(new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`g:${game.id}:place`).setLabel('Place').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`g:${game.id}:random`).setLabel('Random').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`g:${game.id}:clear`).setLabel('Clear').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`g:${game.id}:ready`).setLabel('Ready').setStyle(ButtonStyle.Success).setDisabled(!allPlaced(me))));
        }
    } else if (game.phase === 'battle') {
        const myTurn = s.turn === uid;
        top = myTurn ? '\u{1F3AF} **Your turn.** Press **Fire** and type a square like `b7`.' : `\u23F3 Waiting for ${mention(oppId)} to fire...`;
        bottom += ` | Your ships sunk: ${mineSunk}/${lens.length}`;
        comps.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`g:${game.id}:fire`).setLabel('Fire').setStyle(ButtonStyle.Danger).setDisabled(!myTurn),
            new ButtonBuilder().setCustomId(`g:${game.id}:refresh`).setLabel('Refresh').setStyle(ButtonStyle.Secondary)));
    } else {
        top = s.winner === uid ? '\u{1F3C6} **You won!**' : '\u{1F480} **You lost.**';
        bottom += ` | Your ships sunk: ${mineSunk}/${lens.length}`;
    }
    const enemy = E('#2f7fc1', `\u{1F3AF} Enemy waters (${sunkEnemy.length}/${lens.length} sunk)`).setDescription(`${top}${s.last ? `\n\nLast shot: ${s.last}` : ''}`).setImage('attachment://enemy.png');
    const own = E('#6b7280', '\u{1F6A2} Your fleet').setDescription(bottom).setImage('attachment://own.png');
    return { embeds: [enemy, own], components: comps, files, attachments: [] };
}

const presetText = game => { const p = PRESETS[game.preset ?? 'classic']; return `Preset: **${p.label}**, ${p.blurb}.`; };
function payload(game) {
    const s = game.state, [a, b] = s.p, p = PRESETS[game.preset ?? 'classic'];
    let desc;
    if (game.phase === 'setup') desc = `${mention(a)}: ${s.boards[a].ready ? '\u2705 ready' : '\u23F3 placing ships'}\n${mention(b)}: ${s.boards[b].ready ? '\u2705 ready' : '\u23F3 placing ships'}\n\n${presetText(game)}\nBoards are private. Press **Show my boards** if yours is missing.`;
    else if (game.phase === 'battle') desc = `${mention(a)} vs ${mention(b)} (${p.label})\n\u{1F3AF} ${mention(s.turn)}'s turn\n${s.last ? `Last shot: ${s.last}` : ''}\n\nPress **Show my boards** if yours is missing.`;
    else desc = `${mention(a)} vs ${mention(b)} (${p.label})\n\u{1F3C6} ${mention(s.winner)} wins!\n${s.last ? `Last shot: ${s.last}` : ''}`;
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`g:${game.id}:show`).setLabel('Show my boards').setStyle(ButtonStyle.Primary).setDisabled(game.phase === 'over'));
    return { embeds: [E(game.phase === 'over' ? '#fee75c' : '#2f7fc1', '\u{1F6A2} Sink the Ship').setDescription(desc)], components: [row] };
}

// ---------- live private boards ----------
// A private (ephemeral) message can only be edited while the interaction that made it is under 15 minutes old.
// We keep the latest one per player (in memory only) and push updates to it; "Show my boards" always makes a fresh one.
const live = new Map(), hostPickers = new Map();
const remember = (game, uid, interaction, messageId) => { if (messageId) live.set(`${game.id}:${uid}`, { interaction, messageId }); };
async function pushTo(game, uid) {
    const ref = live.get(`${game.id}:${uid}`);
    if (!ref) return;
    try { await ref.interaction.webhook.editMessage(ref.messageId, viewFor(game, uid)); }
    catch { live.delete(`${game.id}:${uid}`); }
}
const answer = (interaction, view) => (interaction.isFromMessage?.() ? interaction.update(view) : interaction.reply({ ...view, ...EPH }));

// ---------- starting: the host picks a preset, then the invitation goes out ----------
async function start(interaction) {
    const row = new ActionRowBuilder().addComponents(Object.entries(PRESETS).map(([id, p]) => new ButtonBuilder().setCustomId(`g:sspreset:${id}`).setLabel(p.label).setStyle(id === 'classic' ? ButtonStyle.Primary : ButtonStyle.Secondary)));
    const lines = Object.values(PRESETS).map(p => `**${p.label}:** ${p.blurb}`).join('\n');
    return interaction.update({ embeds: [E('#2f7fc1', '\u{1F6A2} Sink the Ship: choose a preset').setDescription(`${lines}\n\nQuick is a short game, Grand is a long one.`)], components: [row] });
}
async function choose(interaction, preset, { postInvite }) {
    if (!PRESETS[preset]) return;
    const game = await postInvite(interaction, 'sinkship', { preset });
    hostPickers.set(game.id, interaction);
}

async function onAccept(interaction, game) {
    const [a, b] = [game.hostId, game.guestId], P = PRESETS[game.preset ?? 'classic'], fresh = () => ({ ships: Array(P.lens.length).fill(null), ready: false, shots: {} });
    game.state = { p: [a, b], names: { [a]: game.hostName, [b]: game.guestName }, size: P.size, lens: P.lens, phase: 'setup', turn: null, boards: { [a]: fresh(), [b]: fresh() }, selected: {}, last: '', winner: null };
    game.phase = 'setup';
    store.save(game);
    await interaction.update(payload(game));
    try { const m = await interaction.followUp({ ...viewFor(game, b), ...EPH }); remember(game, b, interaction, m?.id); } catch (e) { console.error('sinkship guest view:', e.message); }
    const hi = hostPickers.get(game.id); hostPickers.delete(game.id);
    if (hi) { try { const m = await hi.followUp({ ...viewFor(game, a), ...EPH }); remember(game, a, hi, m?.id); } catch (e) { console.error('sinkship host view:', e.message); } }
}

// "Continue" from /game: a fresh private view of your boards.
async function resume(interaction, game) {
    await interaction.reply({ ...viewFor(game, interaction.user.id), ...EPH });
    const m = await interaction.fetchReply().catch(() => null);
    remember(game, interaction.user.id, interaction, m?.id);
}

async function handle(interaction, game, action) {
    const s = game.state, uid = interaction.user.id;
    if (!s.p?.includes(uid)) return reject(interaction, "You're not in this game.");
    const { size, lens } = cfg(s), names = labelsFor(lens), me = s.boards[uid], oppId = other(s, uid);

    if (action === 'show') {
        await interaction.reply({ ...viewFor(game, uid), ...EPH });
        const m = await interaction.fetchReply().catch(() => null);
        return remember(game, uid, interaction, m?.id);
    }
    remember(game, uid, interaction, interaction.message?.id);
    if (action === 'refresh') return interaction.update(viewFor(game, uid));

    if (game.phase === 'setup' && !me.ready) {
        if (action === 'ship') { s.selected[uid] = Number(interaction.values[0]); store.save(game); return interaction.update(viewFor(game, uid)); }
        if (action === 'place') {
            const input = (id, label, ph, req) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(ph).setStyle(TextInputStyle.Short).setRequired(req).setMaxLength(3));
            const idx = Math.min(s.selected[uid] ?? 0, lens.length - 1);
            const fields = [input('square', `Start square (a-${COLS[size - 1]}, 1-${size})`, 'c4', true)];
            if (lens[idx] > 1) fields.push(input('dir', 'Direction: H (right) or V (down)', 'H', false));   // a 1x1 ship has no direction
            return interaction.showModal(new ModalBuilder().setCustomId(`g:${game.id}:placem`).setTitle(`Place the ${names[idx]}`.slice(0, 45)).addComponents(...fields));
        }
        if (action === 'placem') {
            const idx = Math.min(s.selected[uid] ?? 0, lens.length - 1), at = parseSquare(interaction.fields.getTextInputValue('square'), size);
            const dir = lens[idx] === 1 ? 'H' : /^v/i.test(interaction.fields.getTextInputValue('dir') || '') ? 'V' : 'H';
            if (!at) return reject(interaction, `Type a square like c4 (column a to ${COLS[size - 1]}, row 1 to ${size}).`);
            if (!canPlace(me.ships, idx, at.x, at.y, dir, size, lens)) return reject(interaction, 'That does not fit: the ship would leave the board or overlap another ship.');
            me.ships[idx] = { x: at.x, y: at.y, dir };
            const nextFree = me.ships.findIndex(x => !x); if (nextFree >= 0) s.selected[uid] = nextFree;
            store.save(game);
            return answer(interaction, viewFor(game, uid));
        }
        if (action === 'random') { me.ships = randomFleet(size, lens); store.save(game); return interaction.update(viewFor(game, uid)); }
        if (action === 'clear') { me.ships = Array(lens.length).fill(null); s.selected[uid] = 0; store.save(game); return interaction.update(viewFor(game, uid)); }
        if (action === 'ready') {
            if (!allPlaced(me)) return reject(interaction, `Place all ${lens.length} ships first.`);
            me.ready = true;
            const both = s.boards[oppId].ready;
            if (both) { game.phase = 'battle'; s.turn = pick(s.p); s.last = ''; }   // a random player starts
            store.save(game);
            await interaction.update(viewFor(game, uid));
            if (both) await pushTo(game, oppId);
            return editMessage(game, payload(game));
        }
    }

    if (game.phase === 'battle') {
        if (action === 'fire') {
            if (s.turn !== uid) return reject(interaction, "It's not your turn.");
            const input = new TextInputBuilder().setCustomId('square').setLabel(`Square to fire at (a-${COLS[size - 1]}, 1-${size})`).setPlaceholder('b7').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3);
            return interaction.showModal(new ModalBuilder().setCustomId(`g:${game.id}:firem`).setTitle('Fire!').addComponents(new ActionRowBuilder().addComponents(input)));
        }
        if (action === 'firem') {
            if (s.turn !== uid) return reject(interaction, "It's not your turn.");
            const at = parseSquare(interaction.fields.getTextInputValue('square'), size);
            if (!at) return reject(interaction, `Type a square like b7 (column a to ${COLS[size - 1]}, row 1 to ${size}).`);
            const k = key(at.x, at.y);
            if (me.shots[k]) return reject(interaction, `You already fired at ${sq(at.x, at.y)}. Pick another square.`);
            const target = s.boards[oppId];
            const idx = target.ships.findIndex((sh, i) => cellsOf(sh, lens[i]).some(c => c.x === at.x && c.y === at.y));
            me.shots[k] = idx >= 0 ? 'hit' : 'miss';
            const sunk = idx >= 0 && isSunk(target.ships[idx], lens[idx], me.shots);
            s.last = `${mention(uid)} fired at **${sq(at.x, at.y)}**: ${idx < 0 ? 'splash, a miss' : sunk ? `hit, and sank a ${lens[idx]}-tile ship!` : 'hit!'}`;
            if (allSunk(target, me.shots, lens)) {
                game.phase = 'over'; s.winner = uid;
                const mine = viewFor(game, uid), pub = payload(game);
                await answer(interaction, mine);
                await editMessage(game, pub);
                await pushTo(game, oppId);
                store.remove(game);
                return;
            }
            s.turn = oppId;
            store.save(game);
            await answer(interaction, viewFor(game, uid));
            await pushTo(game, oppId);
            return editMessage(game, payload(game));
        }
    }
    return reject(interaction, 'That button is not active right now.');
}

module.exports = { info, start, choose, onAccept, handle, payload, resume, viewFor, parseSquare, canPlace, randomFleet, cellsOf, isSunk, allSunk, labelsFor, presetText, PRESETS };

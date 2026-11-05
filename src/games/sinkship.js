const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const store = require('./store');
const render = require('./render');
const { EPH, png, mention, reject, pick, editMessage } = require('./common');
const { E } = require('../ui');

const info = {
    id: 'sinkship', label: 'Sink the Ship', emoji: '\u{1F6A2}', short: '2 players, place ships and sink your opponent\'s fleet',
    how: 'For 2 players, with private boards. Place your 5 ships (two 1x1, two 2x1, one 1x3) on an 8x8 grid, then take turns firing at a square like b7. A red X is a hit and a splash is a miss. Sink all 5 enemy ships to win.',
};
const SHIPS = [{ len: 3, label: '1x3 ship' }, { len: 2, label: '2x1 ship (first)' }, { len: 2, label: '2x1 ship (second)' }, { len: 1, label: '1x1 ship (first)' }, { len: 1, label: '1x1 ship (second)' }];
const COLS = 'abcdefgh';
const key = (x, y) => `${x},${y}`;
const sq = (x, y) => `${COLS[x]}${y + 1}`;
const other = (s, id) => (id === s.p[0] ? s.p[1] : s.p[0]);

// ---------- ship geometry ----------
const cellsOf = (ship, len) => Array.from({ length: len }, (_, i) => (ship.dir === 'V' ? { x: ship.x, y: ship.y + i } : { x: ship.x + i, y: ship.y }));
function canPlace(ships, idx, x, y, dir) {
    const cells = cellsOf({ x, y, dir }, SHIPS[idx].len);
    if (cells.some(c => c.x < 0 || c.x > 7 || c.y < 0 || c.y > 7)) return false;
    const taken = new Set();
    ships.forEach((sh, i) => { if (sh && i !== idx) cellsOf(sh, SHIPS[i].len).forEach(c => taken.add(key(c.x, c.y))); });
    return !cells.some(c => taken.has(key(c.x, c.y)));
}
function randomFleet() {
    const ships = Array(SHIPS.length).fill(null);
    SHIPS.forEach((sh, i) => {
        for (let tries = 0; tries < 500; tries++) {
            const dir = Math.random() < 0.5 ? 'H' : 'V', x = Math.floor(Math.random() * 8), y = Math.floor(Math.random() * 8);
            if (canPlace(ships, i, x, y, dir)) { ships[i] = { x, y, dir }; return; }
        }
    });
    return ships;
}
function parseSquare(text) {
    const t = String(text).trim().toLowerCase().replace(/\s+/g, '');
    const m = /^([a-h])([1-8])$/.exec(t), n = /^([1-8])([a-h])$/.exec(t);
    if (m) return { x: COLS.indexOf(m[1]), y: Number(m[2]) - 1 };
    if (n) return { x: COLS.indexOf(n[2]), y: Number(n[1]) - 1 };
    return null;
}
const isSunk = (ship, len, shots) => cellsOf(ship, len).every(c => shots[key(c.x, c.y)] === 'hit');
const allSunk = (board, shots) => board.ships.every((sh, i) => sh && isSunk(sh, SHIPS[i].len, shots));
const allPlaced = board => board.ships.every(Boolean);

// ---------- what each player sees ----------
function viewFor(game, uid) {
    const s = game.state, me = s.boards[uid], opp = s.boards[other(s, uid)], oppId = other(s, uid);
    const ownShips = me.ships.map((sh, i) => (sh ? cellsOf(sh, SHIPS[i].len) : null)).filter(Boolean);
    const files = [png(render.seaBoard({ shots: me.shots }), 'enemy.png'), png(render.seaBoard({ ships: ownShips, shots: opp.shots }), 'own.png')];
    const mineSunk = me.ships.filter((sh, i) => sh && isSunk(sh, SHIPS[i].len, opp.shots)).length, theirSunk = opp.ships.filter((sh, i) => sh && isSunk(sh, SHIPS[i].len, me.shots)).length;
    let top, bottom = `Ships placed: ${me.ships.filter(Boolean).length}/5`;
    const comps = [];
    if (game.phase === 'setup') {
        const sel = s.selected[uid] ?? 0;
        top = me.ready ? 'You are ready. Waiting for your opponent to finish placing ships.' : `Place all 5 ships on the bottom board, then press **Ready**.\nSelected: **${SHIPS[sel].label}**. Pick a ship, press **Place**, and type a start square like \`c4\` and a direction (H or V).`;
        if (!me.ready) {
            const select = new StringSelectMenuBuilder().setCustomId(`g:${game.id}:ship`).setPlaceholder('Choose a ship to place')
                .addOptions(SHIPS.map((sh, i) => ({ label: `${sh.label}${me.ships[i] ? ` (at ${sq(me.ships[i].x, me.ships[i].y)}, ${me.ships[i].dir})` : ' (not placed)'}`, value: String(i), default: sel === i })));
            comps.push(new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`g:${game.id}:place`).setLabel('Place').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`g:${game.id}:random`).setLabel('Random').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`g:${game.id}:clear`).setLabel('Clear').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`g:${game.id}:ready`).setLabel('Ready').setStyle(ButtonStyle.Success).setDisabled(!allPlaced(me))));
        }
    } else if (game.phase === 'battle') {
        const myTurn = s.turn === uid;
        top = myTurn ? '\u{1F3AF} **Your turn.** Press **Fire** and type a square like `b7`.' : `\u23F3 Waiting for ${mention(oppId)} to fire...`;
        bottom += ` | Your ships sunk: ${mineSunk}/5`;
        comps.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`g:${game.id}:fire`).setLabel('Fire').setStyle(ButtonStyle.Danger).setDisabled(!myTurn),
            new ButtonBuilder().setCustomId(`g:${game.id}:refresh`).setLabel('Refresh').setStyle(ButtonStyle.Secondary)));
    } else {
        top = s.winner === uid ? '\u{1F3C6} **You won!**' : '\u{1F480} **You lost.**';
        bottom += ` | Your ships sunk: ${mineSunk}/5`;
    }
    const enemy = E('#2f7fc1', `\u{1F3AF} Enemy waters (${theirSunk}/5 sunk)`).setDescription(`${top}${s.last ? `\n\nLast shot: ${s.last}` : ''}`).setImage('attachment://enemy.png');
    const own = E('#6b7280', '\u{1F6A2} Your fleet').setDescription(bottom).setImage('attachment://own.png');
    return { embeds: [enemy, own], components: comps, files, attachments: [] };
}

function payload(game) {
    const s = game.state, [a, b] = s.p;
    let desc;
    if (game.phase === 'setup') desc = `${mention(a)}: ${s.boards[a].ready ? '\u2705 ready' : '\u23F3 placing ships'}\n${mention(b)}: ${s.boards[b].ready ? '\u2705 ready' : '\u23F3 placing ships'}\n\nBoards are private. Press **Show my boards** if yours is missing.`;
    else if (game.phase === 'battle') desc = `${mention(a)} vs ${mention(b)}\n\u{1F3AF} ${mention(s.turn)}'s turn\n${s.last ? `Last shot: ${s.last}` : ''}\n\nPress **Show my boards** if yours is missing.`;
    else desc = `${mention(a)} vs ${mention(b)}\n\u{1F3C6} ${mention(s.winner)} wins!\n${s.last ? `Last shot: ${s.last}` : ''}`;
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

// ---------- game flow ----------
async function start(interaction, { postInvite }) {
    const game = await postInvite(interaction, 'sinkship');
    hostPickers.set(game.id, interaction);
}

async function onAccept(interaction, game) {
    const [a, b] = [game.hostId, game.guestId], fresh = () => ({ ships: Array(SHIPS.length).fill(null), ready: false, shots: {} });
    game.state = { p: [a, b], names: { [a]: game.hostName, [b]: game.guestName }, phase: 'setup', turn: null, boards: { [a]: fresh(), [b]: fresh() }, selected: {}, last: '', winner: null };
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

async function finish(game, winner) {
    const s = game.state;
    game.phase = 'over'; s.winner = winner;
    await editMessage(game, payload(game));
    for (const id of s.p) await pushTo(game, id);
    store.remove(game);
}

async function handle(interaction, game, action) {
    const s = game.state, uid = interaction.user.id;
    if (!s.p?.includes(uid)) return reject(interaction, "You're not in this game.");
    const me = s.boards[uid], oppId = other(s, uid);
    const reply = async () => { remember(game, uid, interaction, interaction.message?.id); };

    if (action === 'show') {
        await interaction.reply({ ...viewFor(game, uid), ...EPH });
        const m = await interaction.fetchReply().catch(() => null);
        return remember(game, uid, interaction, m?.id);
    }
    await reply();
    if (action === 'refresh') return interaction.update(viewFor(game, uid));

    if (game.phase === 'setup' && !me.ready) {
        if (action === 'ship') { s.selected[uid] = Number(interaction.values[0]); store.save(game); return interaction.update(viewFor(game, uid)); }
        if (action === 'place') {
            const input = (id, label, ph, req) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(ph).setStyle(TextInputStyle.Short).setRequired(req).setMaxLength(3));
            const idx = s.selected[uid] ?? 0;
            return interaction.showModal(new ModalBuilder().setCustomId(`g:${game.id}:placem`).setTitle(`Place the ${SHIPS[idx].label}`.slice(0, 45))
                .addComponents(input('square', 'Start square (column a-h, row 1-8)', 'c4', true), input('dir', 'Direction: H (right) or V (down)', 'H', false)));
        }
        if (action === 'placem') {
            const idx = s.selected[uid] ?? 0, at = parseSquare(interaction.fields.getTextInputValue('square')), dir = /^v/i.test(interaction.fields.getTextInputValue('dir') || '') ? 'V' : 'H';
            if (!at) return reject(interaction, 'Type a square like c4 (column a to h, row 1 to 8).');
            if (!canPlace(me.ships, idx, at.x, at.y, dir)) return reject(interaction, 'That does not fit: the ship would leave the board or overlap another ship.');
            me.ships[idx] = { x: at.x, y: at.y, dir };
            const nextFree = me.ships.findIndex(x => !x); if (nextFree >= 0) s.selected[uid] = nextFree;
            store.save(game);
            return answer(interaction, viewFor(game, uid));
        }
        if (action === 'random') { me.ships = randomFleet(); store.save(game); return interaction.update(viewFor(game, uid)); }
        if (action === 'clear') { me.ships = Array(SHIPS.length).fill(null); s.selected[uid] = 0; store.save(game); return interaction.update(viewFor(game, uid)); }
        if (action === 'ready') {
            if (!allPlaced(me)) return reject(interaction, 'Place all 5 ships first.');
            me.ready = true;
            const both = s.boards[oppId].ready;
            if (both) { game.phase = 'battle'; s.turn = pick(s.p); s.last = ''; }
            store.save(game);
            await interaction.update(viewFor(game, uid));
            if (both) await pushTo(game, oppId);
            return editMessage(game, payload(game));
        }
    }

    if (game.phase === 'battle') {
        if (action === 'fire') {
            if (s.turn !== uid) return reject(interaction, "It's not your turn.");
            const input = new TextInputBuilder().setCustomId('square').setLabel('Square to fire at (column a-h, row 1-8)').setPlaceholder('b7').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3);
            return interaction.showModal(new ModalBuilder().setCustomId(`g:${game.id}:firem`).setTitle('Fire!').addComponents(new ActionRowBuilder().addComponents(input)));
        }
        if (action === 'firem') {
            if (s.turn !== uid) return reject(interaction, "It's not your turn.");
            const at = parseSquare(interaction.fields.getTextInputValue('square'));
            if (!at) return reject(interaction, 'Type a square like b7 (column a to h, row 1 to 8).');
            const k = key(at.x, at.y);
            if (me.shots[k]) return reject(interaction, `You already fired at ${sq(at.x, at.y)}. Pick another square.`);
            const target = s.boards[oppId];
            const idx = target.ships.findIndex((sh, i) => cellsOf(sh, SHIPS[i].len).some(c => c.x === at.x && c.y === at.y));
            me.shots[k] = idx >= 0 ? 'hit' : 'miss';
            const sunk = idx >= 0 && isSunk(target.ships[idx], SHIPS[idx].len, me.shots);
            s.last = `${mention(uid)} fired at **${sq(at.x, at.y)}**: ${idx < 0 ? 'splash, a miss' : sunk ? `hit, and sank a ${SHIPS[idx].len}-tile ship!` : 'hit!'}`;
            if (allSunk(target, me.shots)) {
                game.phase = 'over'; s.winner = uid;
                const mine = viewFor(game, uid); const pub = payload(game);
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

module.exports = { info, start, onAccept, handle, payload, resume, viewFor, parseSquare, canPlace, randomFleet, cellsOf, isSunk, allSunk, SHIPS };

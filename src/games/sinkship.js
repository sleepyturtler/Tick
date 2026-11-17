// Battleship. (The internal id stays "sinkship" so saved games and button ids from before the rename keep working.)
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const store = require('./store');
const render = require('./render');
const elo = require('./elo');
const { EPH, png, mention, reject, pick, editMessage, stopButton, endButtons, forfeitButton, textPayload } = require('./common');
const { E } = require('../ui');
const v2 = require('../v2');

const info = {
    id: 'sinkship', label: 'Battleship', emoji: '\u{1F6A2}', short: '2 players, place ships and sink your opponent\'s fleet',
    how: 'For 2 players, with private boards. Both of you vote for a preset (Quick, Classic, Fleet or Grand), place your ships, then take turns firing at a square like b7. A hit lets you shoot again, and while you wait you can line up your next shot. Sink every enemy ship to win. A random player starts.',
};
const PRESETS = {
    quick: { label: 'Quick', size: 6, lens: [3, 2, 1], blurb: '6x6 board, 3 ships (1x3, 2x1, 1x1)' },
    classic: { label: 'Classic', size: 8, lens: [3, 2, 2, 1, 1], blurb: '8x8 board, 5 ships (1x3, two 2x1, two 1x1)' },
    fleet: { label: 'Fleet', size: 9, lens: [3, 3, 2, 2, 2], blurb: '9x9 board, 5 ships (two 1x3, three 2x1)' },
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

// ---------- shooting ----------
// Fires uid's shot at `at`. A hit keeps the turn (shoot again), a miss passes it. Returns { hit, sunk, over }.
function applyShot(game, uid, at) {
    const s = game.state, { lens } = cfg(s), oppId = other(s, uid), me = s.boards[uid], target = s.boards[oppId];
    const idx = target.ships.findIndex((sh, i) => cellsOf(sh, lens[i]).some(c => c.x === at.x && c.y === at.y));
    me.shots[key(at.x, at.y)] = idx >= 0 ? 'hit' : 'miss';
    const hit = idx >= 0, sunk = hit && isSunk(target.ships[idx], lens[idx], me.shots);
    const line = `${mention(uid)} fired at **${sq(at.x, at.y)}**: ${!hit ? 'splash, a miss' : sunk ? `hit, and sank a ${lens[idx]}-tile ship! Shoots again.` : 'hit! Shoots again.'}`;
    s.log = [...(s.log ?? []), line].slice(-4); s.last = line;
    if (allSunk(target, me.shots, lens)) { game.phase = 'over'; s.winner = uid; return { hit, sunk, over: true }; }
    if (!hit) s.turn = oppId;
    return { hit, sunk, over: false };
}
// When a turn starts for a player who lined up a shot while waiting, that shot is fired for them straight away.
function runPrefires(game) {
    const s = game.state;
    for (let i = 0; i < 80 && game.phase === 'battle'; i++) {
        const b = s.boards[s.turn], at = b.prefire;
        if (!at) break;
        b.prefire = null;
        if (b.shots[key(at.x, at.y)]) continue;
        const r = applyShot(game, s.turn, at);
        if (r.over || r.hit) break;   // after a hit the same player shoots again by hand
    }
}

// ---------- what each player sees ----------
function viewFor(game, uid) {
    const s = game.state, { size, lens } = cfg(s), names = labelsFor(lens), me = s.boards[uid], opp = s.boards[other(s, uid)], oppId = other(s, uid);
    const ownShips = me.ships.map((sh, i) => (sh ? cellsOf(sh, lens[i]) : null)).filter(Boolean);
    const sunkEnemy = opp.ships.map((sh, i) => (sh && isSunk(sh, lens[i], me.shots) ? cellsOf(sh, lens[i]) : null)).filter(Boolean);
    // While ships are being placed only your own board is shown; the enemy waters appear when the battle starts.
    const placing = game.phase === 'setup';
    const files = [...(placing ? [] : [png(render.seaBoard({ size, mode: 'enemy', shots: me.shots, revealed: sunkEnemy, target: game.phase === 'battle' ? me.prefire : null }), 'enemy.png')]), png(render.seaBoard({ size, mode: 'own', ships: ownShips, shots: opp.shots }), 'own.png')];
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
                new ButtonBuilder().setCustomId(`g:${game.id}:ready`).setLabel('Ready').setStyle(ButtonStyle.Success).setDisabled(!allPlaced(me)),
                forfeitButton(game)));
        } else comps.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`g:${game.id}:refresh`).setLabel('Refresh').setStyle(ButtonStyle.Secondary), forfeitButton(game)));
    } else if (game.phase === 'battle') {
        const myTurn = s.turn === uid;
        bottom += ` | Your ships sunk: ${mineSunk}/${lens.length}`;
        if (myTurn) {
            top = '\u{1F3AF} **Your turn.** Press **Fire** and type a square like `b7`. A hit lets you shoot again.';
            comps.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`g:${game.id}:fire`).setLabel('Fire').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`g:${game.id}:refresh`).setLabel('Refresh').setStyle(ButtonStyle.Secondary), forfeitButton(game)));
        } else {
            top = `\u23F3 Waiting for ${mention(oppId)} to fire...\n${me.prefire ? `\u{1F3AF} Lined up: **${sq(me.prefire.x, me.prefire.y)}**. It fires by itself the moment your turn starts.` : 'You can line up your next shot with **Line up shot**.'}`;
            const row = [new ButtonBuilder().setCustomId(`g:${game.id}:prefire`).setLabel(me.prefire ? 'Change shot' : 'Line up shot').setStyle(ButtonStyle.Primary)];
            if (me.prefire) row.push(new ButtonBuilder().setCustomId(`g:${game.id}:unprefire`).setLabel('Cancel shot').setStyle(ButtonStyle.Secondary));
            row.push(new ButtonBuilder().setCustomId(`g:${game.id}:refresh`).setLabel('Refresh').setStyle(ButtonStyle.Secondary), forfeitButton(game));
            comps.push(new ActionRowBuilder().addComponents(row));
        }
    } else {
        top = s.stopped && !s.winner ? '\u23F9\uFE0F **The game was stopped.**' : s.winner === uid ? `\u{1F3C6} **You won!**${s.stopped ? ' Your opponent conceded.' : ''}` : `\u{1F480} **You lost.**${s.stopped ? ' You conceded.' : ''}`;
        if (game.eloResult) top += `\n${elo.resultLine(game.eloResult)}`;
        bottom += ` | Your ships sunk: ${mineSunk}/${lens.length}`;
    }
    const log = (s.log ?? []).slice(-3);
    const own = v2.card({ accent: v2.COLORS.FLEET, title: 'Your fleet', blocks: placing ? [top, bottom] : [bottom], image: 'attachment://own.png' });
    if (placing) return { embeds: [own], components: comps, files, attachments: [] };
    const enemy = v2.card({ accent: v2.COLORS.ENEMY, title: `Enemy Waters (${sunkEnemy.length}/${lens.length} Sunk)`, blocks: [`${top}${log.length ? `\n\n**Last shots**\n${log.map(l => `\u2022 ${l}`).join('\n')}` : ''}`], image: 'attachment://enemy.png' });
    return { embeds: [enemy, own], components: comps, files, attachments: [] };
}

function payload(game) {
    const s = game.state, [a, b] = s.p, who = `${elo.withRating(game, a)} vs ${elo.withRating(game, b)}`;
    if (game.phase === 'presetvote') {
        const lines = Object.values(PRESETS).map(p => `**${p.label}:** ${p.blurb}`).join('\n');
        const row = new ActionRowBuilder().addComponents(...Object.entries(PRESETS).map(([id, p]) => new ButtonBuilder().setCustomId(`g:${game.id}:vote:${id}`).setLabel(p.label).setStyle(ButtonStyle.Primary)), stopButton(game));
        return { embeds: [E('#2f7fc1', '\u{1F6A2} Battleship: vote for a preset').setDescription(`${who}\n\n${lines}\n\nBoth players vote. If you pick different presets, one of the two is chosen at random.\n${mention(a)}: ${s.votes[a] ? '\u2705 voted' : '\u23F3 not yet'}\n${mention(b)}: ${s.votes[b] ? '\u2705 voted' : '\u23F3 not yet'}`)], components: [row, new ActionRowBuilder().addComponents(forfeitButton(game))] };
    }
    const p = PRESETS[s.preset ?? 'classic'], log = (s.log ?? []).slice(-2);
    if (game.phase === 'over') {   // a finished game leaves one line of text instead of the embed
        return textPayload(`${info.emoji} **${info.label}** (${p.label}): ${s.winner ? `\u{1F3C6} ${mention(s.winner)} beat ${mention(s.winner === a ? b : a)}!${s.stopped ? ' (the other player conceded)' : ''}` : '\u23F9\uFE0F The game was stopped.'}${game.eloResult ? `\n${elo.resultLine(game.eloResult)}` : ''}`);
    }
    let desc;
    if (game.phase === 'setup') desc = `${who}\nPreset: **${p.label}**, ${p.blurb}. ${s.voteNote ?? ''}\n\n${mention(a)}: ${s.boards[a].ready ? '\u2705 ready' : '\u23F3 placing ships'}\n${mention(b)}: ${s.boards[b].ready ? '\u2705 ready' : '\u23F3 placing ships'}\n\nBoards are private. Press **Show my boards** if yours is missing.`;
    else if (game.phase === 'battle') desc = `${who} (${p.label})\n\u{1F3AF} ${mention(s.turn)}'s turn\n${log.length ? `\n**Last shots**\n${log.map(l => `\u2022 ${l}`).join('\n')}\n` : ''}\nPress **Show my boards** if yours is missing.`;
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`g:${game.id}:show`).setLabel('Show my boards').setStyle(ButtonStyle.Primary).setDisabled(game.phase === 'over'), ...(game.phase === 'over' ? [] : endButtons(game)));
    return { embeds: [E(game.phase === 'over' ? '#fee75c' : '#2f7fc1', '\u{1F6A2} Battleship').setDescription(desc)], components: [row] };
}

// ---------- live private boards ----------
// A private (ephemeral) message can only be edited while the interaction that made it is under 15 minutes old.
// We keep the latest one per player (in memory only) and push updates to it; "Show my boards" always makes a fresh one.
const live = new Map(), hostPickers = new Map(), voteRefs = new Map();
const remember = (game, uid, interaction, messageId) => { if (messageId) live.set(`${game.id}:${uid}`, { interaction, messageId }); };
async function pushTo(game, uid) {
    const ref = live.get(`${game.id}:${uid}`);
    if (!ref) return;
    try { await ref.interaction.webhook.editMessage(ref.messageId, v2.convert(viewFor(game, uid))); }
    catch { live.delete(`${game.id}:${uid}`); }
}
const answer = (interaction, view) => (interaction.isFromMessage?.() ? interaction.update(view) : interaction.reply({ ...view, ...EPH }));

// ---------- starting ----------
async function start(interaction, { postInvite }) {
    const game = await postInvite(interaction, 'sinkship');
    hostPickers.set(game.id, interaction);
}

async function onAccept(interaction, game) {
    const [a, b] = [game.hostId, game.guestId];
    game.state = { p: [a, b], names: { [a]: game.hostName, [b]: game.guestName }, votes: {}, preset: null, size: 8, lens: [3, 2, 2, 1, 1], boards: {}, selected: {}, turn: null, log: [], last: '', winner: null };
    game.phase = 'presetvote';
    store.save(game);
    return interaction.update(payload(game));
}

// Both players have voted: pick the preset (random between the two votes if they differ) and open the private boards.
async function startSetup(game, interaction) {
    const s = game.state, [v1, v2] = s.p.map(id => s.votes[id]), preset = v1 === v2 ? v1 : pick([v1, v2]), P = PRESETS[preset];
    const fresh = () => ({ ships: Array(P.lens.length).fill(null), ready: false, shots: {}, prefire: null });
    s.preset = preset; s.size = P.size; s.lens = P.lens; s.boards = { [s.p[0]]: fresh(), [s.p[1]]: fresh() }; s.selected = {};
    s.voteNote = v1 === v2 ? `Both voted ${P.label}.` : `Votes split (${PRESETS[v1].label} and ${PRESETS[v2].label}), so ${P.label} was picked at random.`;
    game.phase = 'setup';
    store.save(game);
    await interaction.update(payload(game));
    for (const uid of s.p) {
        const ref = uid === interaction.user.id ? interaction : (voteRefs.get(`${game.id}:${uid}`) ?? (uid === game.hostId ? hostPickers.get(game.id) : null));
        if (!ref) continue;
        try { const m = await ref.followUp({ ...viewFor(game, uid), ...EPH }); remember(game, uid, ref, m?.id); } catch (e) { console.error('battleship view:', e.message); }
    }
    hostPickers.delete(game.id);
}

// "Continue" from /game: a fresh private view of your boards.
async function resume(interaction, game) {
    if (game.phase === 'presetvote') return reject(interaction, 'Vote for a preset on the game message first.');
    await interaction.reply({ ...viewFor(game, interaction.user.id), ...EPH });
    const m = await interaction.fetchReply().catch(() => null);
    remember(game, interaction.user.id, interaction, m?.id);
}

// Stop was pressed (see index.js): the game is over, show both players the result.
function onStop(game, { forfeit } = {}) {
    const s = game.state;
    if (!s.boards || !Object.keys(s.boards).length) return;
    game.phase = 'over'; s.stopped = true; s.winner = forfeit ? forfeit.winner : null;
    for (const id of s.p) pushTo(game, id).catch(() => {});
}
// who the game is waiting on: players who have not voted or are not ready yet, or whoever's turn it is
const waitingOn = game => {
    const s = game.state ?? {}, p = s.p ?? [];
    return game.phase === 'presetvote' ? p.filter(id => !s.votes?.[id]) : game.phase === 'setup' ? p.filter(id => !s.boards?.[id]?.ready) : game.phase === 'battle' ? [s.turn] : [];
};
const moved = game => Object.fromEntries((game.state?.p ?? []).map(id => [id, Object.keys(game.state.boards?.[id]?.shots ?? {}).length]));

async function handle(interaction, game, action, args) {
    const s = game.state, uid = interaction.user.id;
    if (!s.p?.includes(uid)) return reject(interaction, "You're not in this game.");

    if (game.phase === 'presetvote') {
        if (action !== 'vote' || !PRESETS[args[0]]) return reject(interaction, 'Vote for a preset first.');
        s.votes[uid] = args[0]; voteRefs.set(`${game.id}:${uid}`, interaction);
        if (s.p.every(id => s.votes[id])) return startSetup(game, interaction);
        store.save(game);
        return interaction.update(payload(game));
    }

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
            if (both) { game.phase = 'battle'; s.turn = pick(s.p); s.log = []; s.last = ''; }   // a random player starts
            store.save(game);
            await interaction.update(viewFor(game, uid));
            if (both) await pushTo(game, oppId);
            return editMessage(game, payload(game));
        }
    }

    if (game.phase === 'battle') {
        if (action === 'fire') {
            if (s.turn !== uid) return reject(interaction, "It's not your turn. You can line up your next shot with Line up shot.");
            const input = new TextInputBuilder().setCustomId('square').setLabel(`Square to fire at (a-${COLS[size - 1]}, 1-${size})`).setPlaceholder('b7').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3);
            return interaction.showModal(new ModalBuilder().setCustomId(`g:${game.id}:firem`).setTitle('Fire!').addComponents(new ActionRowBuilder().addComponents(input)));
        }
        if (action === 'prefire') {
            if (s.turn === uid) return reject(interaction, "It's your turn now, press Fire.");
            const input = new TextInputBuilder().setCustomId('square').setLabel(`Square for your next shot (a-${COLS[size - 1]}, 1-${size})`.slice(0, 45)).setPlaceholder('b7').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3);
            return interaction.showModal(new ModalBuilder().setCustomId(`g:${game.id}:prefirem`).setTitle('Line up your next shot').addComponents(new ActionRowBuilder().addComponents(input)));
        }
        if (action === 'prefirem') {
            if (s.turn === uid) return reject(interaction, "It's your turn now, press Fire.");
            const at = parseSquare(interaction.fields.getTextInputValue('square'), size);
            if (!at) return reject(interaction, `Type a square like b7 (column a to ${COLS[size - 1]}, row 1 to ${size}).`);
            if (me.shots[key(at.x, at.y)]) return reject(interaction, `You already fired at ${sq(at.x, at.y)}. Pick another square.`);
            me.prefire = at; store.save(game);
            return answer(interaction, viewFor(game, uid));
        }
        if (action === 'unprefire') { me.prefire = null; store.save(game); return interaction.update(viewFor(game, uid)); }
        if (action === 'firem') {
            if (s.turn !== uid) return reject(interaction, "It's not your turn.");
            const at = parseSquare(interaction.fields.getTextInputValue('square'), size);
            if (!at) return reject(interaction, `Type a square like b7 (column a to ${COLS[size - 1]}, row 1 to ${size}).`);
            if (me.shots[key(at.x, at.y)]) return reject(interaction, `You already fired at ${sq(at.x, at.y)}. Pick another square.`);
            applyShot(game, uid, at);
            runPrefires(game);   // the opponent may have lined up their reply
            if (game.phase === 'over') {
                game.eloResult = await elo.finish(game, s.winner);
                const mine = viewFor(game, uid), pub = payload(game);
                await answer(interaction, mine);
                await editMessage(game, pub);
                await pushTo(game, oppId);
                store.remove(game);
                return;
            }
            store.save(game);
            await answer(interaction, viewFor(game, uid));
            await pushTo(game, oppId);
            return editMessage(game, payload(game));
        }
    }
    return reject(interaction, 'That button is not active right now.');
}

const onExpire = game => { hostPickers.delete(game.id); for (const k of [...voteRefs.keys(), ...live.keys()]) if (k.startsWith(`${game.id}:`)) { voteRefs.delete(k); live.delete(k); } };

module.exports = { info, start, onAccept, handle, payload, resume, onStop, onExpire, moved, waitingOn, viewFor, parseSquare, canPlace, randomFleet, cellsOf, isSunk, allSunk, labelsFor, applyShot, runPrefires, PRESETS };

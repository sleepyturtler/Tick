const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const store = require('./store');
const { IMPOSTOR_WORDS } = require('./data');
const { DISCUSS_SECONDS, VOTE_SECONDS } = require('../config');
const { EPH, newId, mention, displayName, pick, shuffle, reject, sendTo, editMessage, withLock } = require('./common');
const { E } = require('../ui');

const info = {
    id: 'impostor', label: 'Impostor', emoji: '\u{1F575}\uFE0F', short: '3 to 25 players, find the impostor',
    how: 'For 3 to 25 players. Everyone gets a secret word except the impostor, who gets a clue or nothing. Discuss for 2 minutes, then vote someone out. Crew win when every impostor is out, impostors win when they equal or outnumber the crew.',
};
const MIN_PLAYERS = 3, MAX_PLAYERS = 25, MAX_IMPOSTORS = 8;
const CLUES = { none: 'No clue', category: 'Category', hint: 'Hint', both: 'Category and hint' };
const timers = new Map();

const alive = s => s.players.filter(p => p.alive);
const maxImpostors = n => Math.max(1, Math.floor((n - 1) / 2));
function schedule(id, ms, fn) {
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => { timers.delete(id); withLock(id, fn).catch(e => console.error('impostor timer:', e.message)); }, Math.max(0, ms)));
}
const clearTimer = id => { clearTimeout(timers.get(id)); timers.delete(id); };
const unix = ms => Math.floor(ms / 1000);

function checkWin(s) {
    const imp = alive(s).filter(p => p.role === 'impostor').length, crew = alive(s).length - imp;
    return imp === 0 ? 'crew' : imp >= crew ? 'impostors' : null;
}

// ---------- messages ----------
function payload(game) {
    const s = game.state;
    if (game.phase === 'lobby') {
        const list = game.userIds.map(id => `\u2022 ${mention(id)}`).join('\n');
        const n = game.userIds.length, cap = maxImpostors(n);
        const embed = E('#5865F2', '\u{1F575}\uFE0F Impostor lobby').setDescription(`Host: ${mention(game.hostId)}\n\n**Players (${n}/${MAX_PLAYERS})**\n${list}\n\n**Impostors:** ${s.settings.impostors}${s.settings.impostors > cap ? ` (too many for ${n} players, max ${cap})` : ''}\n**Impostor gets:** ${CLUES[s.settings.clue]}\n\nPress **Join** to play. The host picks the settings and presses **Start**.`);
        const nSel = new StringSelectMenuBuilder().setCustomId(`g:${game.id}:n`).setPlaceholder('Number of impostors')
            .addOptions(Array.from({ length: MAX_IMPOSTORS }, (_, i) => ({ label: `${i + 1} impostor${i ? 's' : ''}`, value: String(i + 1), default: s.settings.impostors === i + 1 })));
        const cSel = new StringSelectMenuBuilder().setCustomId(`g:${game.id}:clue`).setPlaceholder('What the impostor gets')
            .addOptions(Object.entries(CLUES).map(([v, label]) => ({ label: `Impostor gets: ${label}`, value: v, default: s.settings.clue === v })));
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`g:${game.id}:join`).setLabel('Join').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`g:${game.id}:leave`).setLabel('Leave').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`g:${game.id}:start`).setLabel(`Start (${n} joined)`).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`g:${game.id}:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Danger));
        return { embeds: [embed], components: [new ActionRowBuilder().addComponents(nSel), new ActionRowBuilder().addComponents(cSel), row] };
    }
    const wordBtn = label => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`g:${game.id}:word`).setLabel(label).setStyle(ButtonStyle.Primary));
    const names = alive(s).map(p => mention(p.id)).join(', ');
    if (game.phase === 'reveal') {
        const k = s.players.filter(p => p.role === 'impostor').length;
        return { embeds: [E('#5865F2', '\u{1F575}\uFE0F Impostor: get your word').setDescription(`${s.players.length} players, ${k} impostor${k > 1 ? 's' : ''}.\nPress the button to see your word. Only you can see it.\n\n\u2705 **${s.got.length}/${s.players.length}** have their word`)], components: [wordBtn('Get your word')] };
    }
    if (game.phase === 'discuss') {
        return { embeds: [E('#f1c40f', `\u{1F4AC} Discussion, round ${s.round}`).setDescription(`${s.log ? s.log + '\n\n' : ''}Time is up <t:${unix(s.endsAt)}:R>. Talk it out in chat or voice and work out who the impostor is.\n\n**Still in:** ${names}`)], components: [wordBtn('Show my word')] };
    }
    if (game.phase === 'vote') {
        const voted = Object.keys(s.votes);
        const rows = []; const al = alive(s);
        for (let i = 0; i < al.length; i += 5) rows.push(new ActionRowBuilder().addComponents(al.slice(i, i + 5).map(p => new ButtonBuilder().setCustomId(`g:${game.id}:v:${p.id}`).setLabel(p.name.slice(0, 80)).setStyle(ButtonStyle.Secondary))));
        return { embeds: [E('#e67e22', `\u{1F5F3}\uFE0F Vote, round ${s.round}`).setDescription(`Who is the impostor? Press a name to vote. You can change your vote until everyone has voted or <t:${unix(s.endsAt)}:R>.\n\n**Voted:** ${voted.length}/${al.length}${voted.length ? `\n${voted.map(mention).join(', ')}` : ''}`)], components: rows };
    }
    return { embeds: [E('#80848e', 'Impostor').setDescription('The game is over.')], components: [] };
}

function finalPayload(game, winner) {
    const s = game.state, imps = s.players.filter(p => p.role === 'impostor').map(p => mention(p.id)).join(', ');
    return { embeds: [E(winner === 'crew' ? '#57f287' : '#ed4245', winner === 'crew' ? '\u{1F3C6} The crew wins!' : '\u{1F608} The impostors win!')
        .setDescription(`${s.log}\n\nThe word was **${s.word}** (${s.category}).\n**Impostor${imps.includes(',') ? 's' : ''}:** ${imps}`)], components: [] };
}

// ---------- lobby ----------
async function start(interaction) {
    const game = { id: newId(), type: 'impostor', guildId: interaction.guild.id, channelId: interaction.channelId, messageId: null, hostId: interaction.user.id, userIds: [interaction.user.id], phase: 'lobby', createdAt: Date.now(),
        state: { settings: { impostors: 1, clue: 'category' }, names: { [interaction.user.id]: displayName(interaction) }, players: [], got: [], round: 1, votes: {}, log: '' } };
    const msg = await sendTo(game.channelId, payload(game));
    game.messageId = msg.id; store.add(game);
    return interaction.update({ embeds: [E('#57f287', 'Lobby created').setDescription('The lobby is in the channel. Tell people to press Join, then start it from there.')], components: [] });
}

function beginGame(game) {
    const s = game.state, ids = shuffle(game.userIds), k = s.settings.impostors, entry = pick(IMPOSTOR_WORDS), [word, hint] = pick(entry.items);
    s.players = game.userIds.map(id => ({ id, name: s.names[id], role: ids.indexOf(id) < k ? 'impostor' : 'crew', alive: true }));
    s.word = word; s.category = entry.category; s.hint = hint; s.got = []; s.round = 1; s.votes = {}; s.log = '';
    game.phase = 'reveal';
}
function startDiscuss(game) {
    const s = game.state;
    game.phase = 'discuss'; s.votes = {}; s.endsAt = Date.now() + DISCUSS_SECONDS * 1000;
    store.save(game);
    schedule(game.id, DISCUSS_SECONDS * 1000, () => startVote(game.id));
}
async function startVote(id) {
    const game = store.get(id);
    if (!game || game.phase !== 'discuss') return;
    game.phase = 'vote'; game.state.votes = {}; game.state.endsAt = Date.now() + VOTE_SECONDS * 1000;
    store.save(game);
    schedule(id, VOTE_SECONDS * 1000, () => finishVote(id));
    await editMessage(game, payload(game));
}
async function finishVote(id) {
    const game = store.get(id);
    if (!game || game.phase !== 'vote') return;
    clearTimer(id);
    const s = game.state, tally = {};
    for (const t of Object.values(s.votes)) tally[t] = (tally[t] ?? 0) + 1;
    const top = Math.max(0, ...Object.values(tally)), leaders = Object.keys(tally).filter(t => tally[t] === top);
    if (top === 0 || leaders.length > 1) {
        s.log = `\u{1F91D} Round ${s.round}: ${top === 0 ? 'nobody voted' : "it's a tie"}, so nobody is voted out.`;
    } else {
        const out = s.players.find(p => p.id === leaders[0]); out.alive = false;
        s.log = `\u{1F5F3}\uFE0F Round ${s.round}: ${mention(out.id)} was voted out with ${top} vote${top > 1 ? 's' : ''}. They were ${out.role === 'impostor' ? 'an **impostor**' : 'a **crewmate**'}.`;
    }
    const winner = checkWin(s);
    if (winner) {
        game.phase = 'over'; const p = finalPayload(game, winner); store.remove(game);
        return editMessage(game, p);
    }
    s.round += 1;
    startDiscuss(game);
    await editMessage(game, payload(game));
}

// ---------- actions ----------
async function handle(interaction, game, action, args) {
    const s = game.state, uid = interaction.user.id, host = uid === game.hostId;
    if (game.phase === 'lobby') {
        if (action === 'join') {
            if (game.userIds.includes(uid)) return reject(interaction, "You're already in.");
            if (game.userIds.length >= MAX_PLAYERS) return reject(interaction, 'The lobby is full.');
            game.userIds.push(uid); s.names[uid] = displayName(interaction); store.save(game);
            return interaction.update(payload(game));
        }
        if (action === 'leave') {
            if (host) return reject(interaction, 'The host can\'t leave. Press Cancel to close the lobby.');
            if (!game.userIds.includes(uid)) return reject(interaction, "You're not in this lobby.");
            game.userIds = game.userIds.filter(i => i !== uid); store.save(game);
            return interaction.update(payload(game));
        }
        if (['n', 'clue', 'start', 'cancel'].includes(action) && !host) return reject(interaction, 'Only the host can do that.');
        if (action === 'n') { s.settings.impostors = Number(interaction.values[0]); store.save(game); return interaction.update(payload(game)); }
        if (action === 'clue') { s.settings.clue = interaction.values[0]; store.save(game); return interaction.update(payload(game)); }
        if (action === 'cancel') { store.remove(game); return interaction.update({ embeds: [E('#80848e', 'Impostor').setDescription('The lobby was cancelled.')], components: [] }); }
        if (action === 'start') {
            const n = game.userIds.length;
            if (n < MIN_PLAYERS) return reject(interaction, `You need at least ${MIN_PLAYERS} players to start (${n} joined).`);
            if (s.settings.impostors > maxImpostors(n)) return reject(interaction, `With ${n} players you can have at most ${maxImpostors(n)} impostor${maxImpostors(n) > 1 ? 's' : ''}. Change the setting and press Start again.`);
            beginGame(game); store.save(game);
            return interaction.update(payload(game));
        }
        return;
    }
    if (action === 'word') {
        const p = s.players.find(x => x.id === uid);
        if (!p) return reject(interaction, "You're not in this game.");
        let text;
        if (p.role === 'crew') text = `You are **crew**. \u{1F9D1}\u200D\u{1F680}\nYour word: **${s.word}**`;
        else {
            const c = s.settings.clue, lines = ['You are the **IMPOSTOR**. \u{1F608}'];
            if (c === 'category' || c === 'both') lines.push(`Category: **${s.category}**`);
            if (c === 'hint' || c === 'both') lines.push(`Hint: **${s.hint}**`);
            if (c === 'none') lines.push('You get no clue. Blend in!');
            text = lines.join('\n');
        }
        await interaction.reply({ content: `${text}\n*Don't show anyone.*`, ...EPH });
        if (game.phase === 'reveal' && !s.got.includes(uid)) {
            s.got.push(uid);
            if (s.got.length >= s.players.length) { startDiscuss(game); } else store.save(game);
            await editMessage(game, payload(game));
        }
        return;
    }
    if (action === 'v' && game.phase === 'vote') {
        const voter = s.players.find(p => p.id === uid), target = s.players.find(p => p.id === args[0]);
        if (!voter || !voter.alive) return reject(interaction, "Only players still in the game can vote.");
        if (!target || !target.alive) return reject(interaction, "That player isn't in the game any more.");
        if (target.id === uid) return reject(interaction, "You can't vote for yourself.");
        s.votes[uid] = target.id;
        if (Object.keys(s.votes).length >= alive(s).length) {
            store.save(game);
            await interaction.deferUpdate();
            return finishVote(game.id);
        }
        store.save(game);
        return interaction.update(payload(game));
    }
    return reject(interaction, 'That button is not active right now.');
}

function onRestore(game) {
    if (game.phase === 'discuss') schedule(game.id, game.state.endsAt - Date.now(), () => startVote(game.id));
    else if (game.phase === 'vote') schedule(game.id, game.state.endsAt - Date.now(), () => finishVote(game.id));
}
const onExpire = game => clearTimer(game.id);

module.exports = { info, start, handle, payload, onRestore, onExpire, checkWin, maxImpostors, finishVote, startVote };

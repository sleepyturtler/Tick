const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const store = require('./store');
const { TRUTHS, DARES } = require('./data');
const { newId, pick, shuffle, mention, displayName, reject, sendTo } = require('./common');
const { E } = require('../ui');

const info = {
    id: 'tod', label: 'Truth or dare', emoji: '\u{1F3AD}', short: 'A circle of players, truths and dares in turn',
    how: 'For 2 to 25 players. Everyone joins the circle and the host starts. A random player begins: they choose Truth or Dare, do it, press Done, and pick who goes next. Prompts do not repeat until they run out.',
};
const MIN_PLAYERS = 2, MAX_PLAYERS = 25;
const BANK = { truth: TRUTHS, dare: DARES };

function draw(s, type) {
    let pool = BANK[type].map((_, i) => i).filter(i => !s.used[type].includes(i));
    if (!pool.length) { s.used[type] = []; pool = BANK[type].map((_, i) => i); }
    const i = pick(pool); s.used[type].push(i);
    return BANK[type][i];
}
// "The circle": everyone in the game, with a pointer at whoever is up.
const circle = (game) => game.state.order.map(id => (id === game.state.current ? `\u25B6\uFE0F **${mention(id)}**` : `\u25CB ${mention(id)}`)).join('\n');

function payload(game) {
    const s = game.state;
    if (game.phase === 'lobby') {
        const n = game.userIds.length;
        const embed = E('#5865F2', '\u{1F3AD} Truth or dare: lobby').setDescription(`Host: ${mention(game.hostId)}\n\n**In the circle (${n}/${MAX_PLAYERS})**\n${game.userIds.map(id => `\u25CB ${mention(id)}`).join('\n')}\n\nPress **Join** to sit in the circle. The host presses **Start** (at least ${MIN_PLAYERS} players).`);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`g:${game.id}:join`).setLabel('Join').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`g:${game.id}:leave`).setLabel('Leave').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`g:${game.id}:start`).setLabel(`Start (${n} joined)`).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`g:${game.id}:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Danger));
        return { embeds: [embed], components: [row] };
    }
    const last = s.last, who = mention(s.current);
    let title, color, body, components = [];
    if (s.stage === 'choose') {
        title = '\u{1F3AD} Truth or dare'; color = '#5865F2';
        body = `${last ? `${last.type === 'truth' ? '\u{1F4AC}' : '\u{1F525}'} Last prompt: *${last.text}*\n\n` : ''}${who}, it's your turn. Choose **Truth** or **Dare**.`;
        components = [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`g:${game.id}:t:truth`).setLabel('Truth').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`g:${game.id}:t:dare`).setLabel('Dare').setStyle(ButtonStyle.Danger))];
    } else if (s.stage === 'prompt') {
        title = last.type === 'truth' ? '\u{1F4AC} Truth' : '\u{1F525} Dare'; color = last.type === 'truth' ? '#3498db' : '#e74c3c';
        body = `For ${who}:\n\n**${last.text}**\n\nWhen you're done, press **Done**.`;
        components = [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`g:${game.id}:done`).setLabel('Done').setStyle(ButtonStyle.Success))];
    } else {
        title = '\u{1F3AF} Pick who goes next'; color = '#f1c40f';
        body = `${who}, choose who is next in the circle.`;
        const others = s.order.filter(id => id !== s.current);
        components = [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`g:${game.id}:next`).setPlaceholder('Pick the next player')
            .addOptions(others.map(id => ({ label: (s.names[id] || id).slice(0, 100), value: id }))))];
    }
    return { embeds: [E(color, title).setDescription(`${body}\n\n**The circle**\n${circle(game)}`)], components };
}

async function start(interaction) {
    const game = { id: newId(), type: 'tod', guildId: interaction.guild.id, channelId: interaction.channelId, messageId: null, hostId: interaction.user.id, userIds: [interaction.user.id], phase: 'lobby', createdAt: Date.now(),
        state: { names: { [interaction.user.id]: displayName(interaction) }, order: [], current: null, stage: 'choose', last: null, used: { truth: [], dare: [] } } };
    const msg = await sendTo(game.channelId, payload(game));
    game.messageId = msg.id; store.add(game);
    return interaction.update({ embeds: [E('#57f287', 'Lobby created').setDescription('The lobby is in the channel. Tell people to press Join, then start it from there.')], components: [] });
}

async function handle(interaction, game, action, args) {
    const s = game.state, uid = interaction.user.id, host = uid === game.hostId;
    if (game.phase === 'lobby') {
        if (action === 'join') {
            if (game.userIds.includes(uid)) return reject(interaction, "You're already in the circle.");
            if (game.userIds.length >= MAX_PLAYERS) return reject(interaction, 'The circle is full.');
            game.userIds.push(uid); s.names[uid] = displayName(interaction); store.save(game);
            return interaction.update(payload(game));
        }
        if (action === 'leave') {
            if (host) return reject(interaction, "The host can't leave. Press Cancel to close the lobby.");
            if (!game.userIds.includes(uid)) return reject(interaction, "You're not in this lobby.");
            game.userIds = game.userIds.filter(i => i !== uid); delete s.names[uid]; store.save(game);
            return interaction.update(payload(game));
        }
        if (!host) return reject(interaction, 'Only the host can do that.');
        if (action === 'cancel') { store.remove(game); return interaction.update({ embeds: [E('#80848e', 'Truth or dare').setDescription('The lobby was cancelled.')], components: [] }); }
        if (action === 'start') {
            if (game.userIds.length < MIN_PLAYERS) return reject(interaction, `You need at least ${MIN_PLAYERS} players (${game.userIds.length} joined).`);
            s.order = shuffle(game.userIds); s.current = s.order[0]; s.stage = 'choose'; game.phase = 'play';
            store.save(game);
            return interaction.update(payload(game));
        }
        return;
    }
    // during the game only the player whose turn it is acts (the host can step in if someone is stuck)
    const mayAct = uid === s.current || host;
    if (action === 't') {
        if (s.stage !== 'choose') return reject(interaction, "It's not time to choose.");
        if (uid !== s.current) return reject(interaction, `It's ${mention(s.current)}'s turn to choose.`);
        const type = args[0] === 'dare' ? 'dare' : 'truth';
        s.last = { type, text: draw(s, type) }; s.stage = 'prompt'; store.save(game);
        return interaction.update(payload(game));
    }
    if (action === 'done') {
        if (s.stage !== 'prompt') return reject(interaction, 'Nothing to finish right now.');
        if (!mayAct) return reject(interaction, `Only ${mention(s.current)} (or the host) can press Done.`);
        s.stage = 'next'; store.save(game);
        return interaction.update(payload(game));
    }
    if (action === 'next') {
        if (s.stage !== 'next') return reject(interaction, 'Not time to pick the next player.');
        if (!mayAct) return reject(interaction, `Only ${mention(s.current)} (or the host) can pick who is next.`);
        const chosen = interaction.values[0];
        if (!s.order.includes(chosen) || chosen === s.current) return reject(interaction, 'Pick someone else in the circle.');
        s.current = chosen; s.stage = 'choose'; store.save(game);
        return interaction.update(payload(game));
    }
}

module.exports = { info, start, handle, payload };

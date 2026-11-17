// /counting settings: one panel for everything a server can tune about counting.
// Mode (per channel), max streak, expressions, equations, players and the fail role. Every control saves at once and the panel redraws in place.
// Custom ids are "cs_<action>_<channelId or x>": the channel id keeps the mode row pointing at the same channel after each press.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, RoleSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } = require('discord.js');
const { MODES, MODE_EMOJI, MODE_LABEL, safeMode } = require('./config');
const { chanCache, channelsOf, getGuild, saveGuild, hasPerm, resolveCounting } = require('./state');
const { switchMode } = require('./ruin');
const { validateFailRole, failRoleWarning } = require('./failroles');
const { E, ep, pickerRow } = require('./ui');
const v2 = require('./v2');
const { cmd } = require('./mentions');

const MODE_HINT = { interactive: 'Wrong numbers reset the count', simple: 'Wrong messages are deleted, no resets', countdown: 'Count down from 100 to 1', modifiers: 'A rule decides which numbers are valid', floors: 'Every 100 is a checkpoint' };
const NONE = 'x';
const isAdmin = i => i.member.permissions.has(PermissionFlagsBits.Administrator);
const cidOf = (gid, cid) => { const c = cid && cid !== NONE ? chanCache.get(cid) : null; return c && c.guildId === gid ? c.channelId : null; };
const onOff = v => (v ? 'On' : 'Off');

// The panel as a payload (an embed look-alike plus component rows, which v2.convert turns into a V2 message).
function panel(gid, g, cid, note) {
    const c = cid ? chanCache.get(cid) : null;
    const chans = channelsOf(gid);
    const counting = [
        c ? `**Mode:** ${MODE_EMOJI[c.countType]} ${MODE_LABEL[c.countType]} in <#${c.channelId}>`
            : chans.length ? '**Mode:** pick a counting channel below to change its mode' : `**Mode:** no counting channel yet, use ${cmd('counting channel')} or ${cmd('transfer')}`,
        `**Max streak:** ${g.maxStreak} in a row`,
        `**Expressions:** ${onOff(g.allowExpressions)}`,
        `**Equations:** ${g.allowExpressions ? onOff(g.allowEquations !== false) : 'Off (needs expressions)'}`,
        `**Players:** ${onOff(g.playerCount)}`,
    ].join('\n');
    const fail = g.failRoleId ? `**Fail role:** <@&${g.failRoleId}> for ${g.failRoleMinutes ?? 10} min` : '**Fail role:** Off';
    const blocks = [counting, fail];
    if (note) blocks.push(note);
    const tag = cid ?? NONE;
    const rows = [];
    if (c) {
        rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`cs_mode_${tag}`).setPlaceholder('Counting mode (changing it resets the count)')
            .addOptions(MODES.map(m => ({ label: `${MODE_EMOJI[m]} ${MODE_LABEL[m]}`, description: MODE_HINT[m], value: m, default: c.countType === m })))));
    } else if (chans.length > 1) rows.push(pickerRow(gid, 'mode'));
    const tog = (id, label, on, disabled = false) => new ButtonBuilder().setCustomId(`${id}_${tag}`).setLabel(`${label}: ${onOff(on)}`).setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(disabled);
    rows.push(new ActionRowBuilder().addComponents(
        tog('cs_expr', 'Expressions', g.allowExpressions),
        tog('cs_eq', 'Equations', g.allowExpressions && g.allowEquations !== false, !g.allowExpressions),
        tog('cs_players', 'Players', g.playerCount),
        new ButtonBuilder().setCustomId(`cs_streak_${tag}`).setLabel(`Max streak: ${g.maxStreak}`).setStyle(ButtonStyle.Secondary),
    ));
    rows.push(new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`cs_failrole_${tag}`).setPlaceholder('Fail role (Administrator)').setMinValues(1).setMaxValues(1)));
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`cs_frmake_${tag}`).setLabel('Create fail role').setStyle(ButtonStyle.Secondary).setDisabled(!!g.failRoleId),
        new ButtonBuilder().setCustomId(`cs_frmins_${tag}`).setLabel('Fail role time').setStyle(ButtonStyle.Secondary).setDisabled(!g.failRoleId),
        new ButtonBuilder().setCustomId(`cs_froff_${tag}`).setLabel('Turn off fail role').setStyle(ButtonStyle.Danger).setDisabled(!g.failRoleId),
    ));
    return { embeds: [v2.card({ title: 'Counting Settings', blocks, footer: 'Changes save instantly' })], components: rows };
}

// Opens the panel as a private reply. `channel` is the optional channel option of /counting settings.
async function open(interaction, channel = null) {
    const gid = interaction.guild.id;
    if (!await hasPerm(interaction, gid)) return interaction.reply({ content: 'No permission.', ...ep() });
    let cid = null;
    const r = resolveCounting(interaction, channel);
    if (r.c) cid = r.c.channelId;
    else if (channel) return interaction.reply({ content: r.error, ...ep() });
    return interaction.reply({ ...panel(gid, await getGuild(gid), cid), ...ep() });
}

const modal = (id, title, inputId, label, placeholder) => new ModalBuilder().setCustomId(id).setTitle(title).addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(inputId).setLabel(label).setStyle(TextInputStyle.Short).setPlaceholder(placeholder).setMinLength(1).setMaxLength(4).setRequired(true)));
// Buttons and menus edit the panel they sit on; so does a modal that was opened from it. (Only modal submits have isFromMessage, buttons and menus have isMessageComponent.)
const onPanel = i => (typeof i.isMessageComponent === 'function' && i.isMessageComponent()) || (typeof i.isFromMessage === 'function' && i.isFromMessage());
const redraw = (interaction, gid, g, cid, note) => (onPanel(interaction) ? interaction.update(panel(gid, g, cid, note)) : interaction.reply({ ...panel(gid, g, cid, note), ...ep() }));
const refuse = (interaction, text) => interaction.reply({ content: text, ...ep() });

// Returns true when the interaction was one of ours.
async function handle(interaction) {
    const id = interaction.customId;
    if (typeof id !== 'string' || !id.startsWith('cs_') || !interaction.guild) return false;
    const [, action, tag] = id.split('_');
    const gid = interaction.guild.id, cid = cidOf(gid, tag);
    if (!await hasPerm(interaction, gid)) { await refuse(interaction, 'No permission.'); return true; }
    const g = await getGuild(gid);
    const adminOnly = ['failrole', 'frmake', 'frmins', 'frm', 'froff'].includes(action);
    if (adminOnly && !isAdmin(interaction)) { await refuse(interaction, 'Only administrators can change the fail role.'); return true; }

    if (action === 'expr') { g.allowExpressions = !g.allowExpressions; saveGuild(gid, g); await redraw(interaction, gid, g, cid); return true; }
    if (action === 'eq') {
        if (!g.allowExpressions) { await refuse(interaction, 'Turn expressions on first, equations are a kind of expression.'); return true; }
        g.allowEquations = g.allowEquations === false; saveGuild(gid, g); await redraw(interaction, gid, g, cid); return true;
    }
    if (action === 'players') { g.playerCount = !g.playerCount; saveGuild(gid, g); await redraw(interaction, gid, g, cid); return true; }
    if (action === 'mode') {
        const c = cid ? chanCache.get(cid) : null, m = safeMode(interaction.values?.[0]);
        if (!c || !m) { await refuse(interaction, 'That counting channel no longer exists.'); return true; }
        if (m !== c.countType) switchMode(interaction.guild, c, m);
        await redraw(interaction, gid, g, cid); return true;
    }
    if (action === 'streak') { await interaction.showModal(modal(`cs_streakm_${tag}`, 'Max streak', 'amount', 'Counts in a row per person (1 to 100)', '1')); return true; }
    if (action === 'streakm') {
        const n = Number(String(interaction.fields.getTextInputValue('amount')).trim());
        if (!Number.isInteger(n) || n < 1 || n > 100) { await refuse(interaction, 'Enter a whole number from 1 to 100.'); return true; }
        g.maxStreak = n; saveGuild(gid, g); await redraw(interaction, gid, g, cid); return true;
    }

    // ----- fail role (administrators only, checked above) -----
    if (action === 'failrole') {
        const role = interaction.guild.roles.cache.get(interaction.values?.[0]), err = validateFailRole(interaction.guild, role);
        if (err) { await interaction.reply({ embeds: [E('#ff4444', 'Fail role not set').setDescription(err)], ...ep() }); return true; }
        g.failRoleId = role.id; saveGuild(gid, g);
        await redraw(interaction, gid, g, cid, failRoleWarning(role).trim() || null); return true;
    }
    if (action === 'frmake') {
        if (g.failRoleId) { await refuse(interaction, 'A fail role is already set.'); return true; }
        let role;
        try { role = await interaction.guild.roles.create({ name: 'Ruined the Count', color: 0xff4444, permissions: [], reason: 'Tick fail role' }); }
        catch { await interaction.reply({ embeds: [E('#ff4444', 'Could not create the role').setDescription('I need the **Manage Roles** permission. You can also pick an existing role in the menu.')], ...ep() }); return true; }
        const err = validateFailRole(interaction.guild, role);
        if (err) { await interaction.reply({ embeds: [E('#ff4444', 'Fail role not set').setDescription(err)], ...ep() }); return true; }
        g.failRoleId = role.id; saveGuild(gid, g);
        await redraw(interaction, gid, g, cid, failRoleWarning(role).trim() || null); return true;
    }
    if (action === 'frmins') { await interaction.showModal(modal(`cs_frm_${tag}`, 'Fail role time', 'minutes', 'Minutes the role lasts (1 to 1440)', '10')); return true; }
    if (action === 'frm') {
        const n = Number(String(interaction.fields.getTextInputValue('minutes')).trim());
        if (!Number.isInteger(n) || n < 1 || n > 1440) { await refuse(interaction, 'Enter a whole number of minutes from 1 to 1440.'); return true; }
        g.failRoleMinutes = n; saveGuild(gid, g); await redraw(interaction, gid, g, cid); return true;
    }
    if (action === 'froff') { g.failRoleId = null; saveGuild(gid, g); await redraw(interaction, gid, g, cid); return true; }
    return false;
}

module.exports = { open, handle, panel };

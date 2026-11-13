const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { FLOOR_SIZE, MAX_COUNTING_CHANNELS, MODE_EMOJI, MODE_LABEL, safeMode, usesSaves } = require('./config');
const { expectedNext, modeIntro, resetChannel } = require('./modes');
const { chanCache, channelsOf, defaultChannel, getGuild, indexChan, saveChan } = require('./state');
const { updateUserStat } = require('./db');
const { giveFailRole, failRoleNote } = require('./failroles');
const { E } = require('./ui');

function earnsSave(v){const ms=[50,100,250,500,1000,2000];return ms.includes(v)||(v>2000&&v%2000===0);}
function nextSaveAt(v){const ms=[50,100,250,500,1000,2000];for(const m of ms)if(v<m)return m;return Math.ceil((v+1)/2000)*2000;}

// ---------- reset / ruin ----------
function doReset(g, c, userId) {
    resetChannel(c);
    saveChan(c);
    updateUserStat(c.guildId, userId, { ruined: 1 });
    giveFailRole(c.guildId, g, userId).catch(e => console.error('giveFailRole:', e.message));
}
function switchMode(guild, c, newType) {
    c.countType = newType;
    resetChannel(c, true);
    saveChan(c);
    announce(guild, c, E('#ff9900', `${MODE_EMOJI[newType]} Switched to ${MODE_LABEL[newType]} mode`).setDescription(`Count reset.\n${modeIntro(c)}`));
}
function announce(guild, c, embed) {
    const ch = guild?.channels.cache.get(c.channelId);
    if (ch && ch.isTextBased?.() && !ch.isThread?.()) ch.send({ embeds: [embed] }).catch(() => {});
}
async function addCountingChannel(guild, cid, mode) {
    const gid = guild.id;
    await getGuild(gid);
    if (chanCache.has(cid)) return { error: 'That channel is already a counting channel.' };
    if (channelsOf(gid).length >= MAX_COUNTING_CHANNELS) return { error: `A server can have up to **${MAX_COUNTING_CHANNELS}** counting channels.` };
    const c = defaultChannel(gid, cid, safeMode(mode) ?? 'interactive');
    indexChan(c); saveChan(c);
    announce(guild, c, E('#5865F2', `${MODE_EMOJI[c.countType]} Counting started \u2014 ${MODE_LABEL[c.countType]} mode`).setDescription(modeIntro(c)));
    return { c };
}

function resetFields(c) {
    switch (c.countType) {
        case 'countdown': return [{ name: 'Reset to', value: `**${c.countdownStart}**`, inline: true }];
        case 'modifiers': return [{ name: 'New modifier', value: c.modifierLabel ?? '\u2014', inline: true }];
        case 'floors': return [{ name: 'Back to checkpoint', value: c.checkpoint > 0 ? `**${c.checkpoint}** (Floor ${Math.floor(c.checkpoint / FLOOR_SIZE)})` : '**0** (no checkpoint yet)', inline: true }, { name: 'Next number', value: `**${expectedNext(c)}**`, inline: true }];
        default: return [{ name: 'Reset to', value: '**1**', inline: true }];
    }
}
const startFooter = c => c.countType === 'modifiers' ? 'Start again \u2014 check the new modifier!' : `Start again from ${expectedNext(c)}!`;
// Embed shown after the channel state has already been reset.
function ruinEmbed(c, g, title, description, userId) {
    return E('#ff4444', title).setDescription(description + failRoleNote(c.guildId, g, userId)).addFields(...resetFields(c), { name: 'High Score', value: `**${c.highScore}**`, inline: true }).setFooter({ text: startFooter(c) });
}

async function triggerRuin(channel, g, c, userId, reason) {
    const gid = c.guildId, prev = c.current, expiresAt = Date.now() + 60_000;
    const prevLastUserId = c.lastUserId, prevConsecutive = c.consecutiveCount, prevLastMessageId = c.lastMessageId;
    c.pendingSave = { placeholder: true, userId, prevCount: prev, expiresAt, prevLastUserId, prevConsecutive, prevLastMessageId }; saveChan(c);
    if ((g.saves ?? 0) > 0 && usesSaves(c.countType)) {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`saveuse_${userId}_${prev}_${c.channelId}_${expiresAt}`).setLabel(`Use Save (${g.saves} left)`).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`savedecline_${userId}_${prev}_${c.channelId}_${expiresAt}`).setLabel('Let it reset').setStyle(ButtonStyle.Danger),
        );
        const prompt = await channel.send({ embeds: [E('#ff9900', '\u26a0\ufe0f Count almost ruined!').setDescription(`<@${userId}> made a mistake! (${reason})\nYou have a **Save** \u2014 use it within **1 minute** to keep the count at **${prev}**!`).addFields({ name: 'Server saves', value: `**${g.saves}**`, inline: true }, { name: 'At risk', value: `**${prev}**`, inline: true })], components: [row] }).catch(e => { console.error('triggerRuin save prompt failed:', e.message); return null; });
        if (!prompt) { doReset(g, c, userId); return; }
        c.pendingSave = { msgId: prompt.id, userId, prevCount: prev, expiresAt, prevLastUserId, prevConsecutive, prevLastMessageId }; saveChan(c);
        setTimeout(async () => {
            const fresh = chanCache.get(c.channelId);
            if (!fresh?.pendingSave || fresh.pendingSave.expiresAt !== expiresAt) return;
            const gg = await getGuild(gid);
            doReset(gg, fresh, userId);
            await prompt.edit({ embeds: [ruinEmbed(fresh, gg, '\u{1F4A5} Save expired!', `<@${userId}> didn't use their save in time. Count resets!`, userId)], components: [] }).catch(() => {});
        }, 60_000);
    } else {
        doReset(g, c, userId);
        await channel.send({ embeds: [ruinEmbed(c, g, '\u{1F4A5} Count ruined!', `<@${userId}> ruined the count! (${reason})\nCount was at **${prev}**.`, userId)] }).catch(e => console.error('ruin msg failed:', e.message));
    }
}

module.exports = { earnsSave, nextSaveAt, doReset, switchMode, announce, addCountingChannel, ruinEmbed, triggerRuin };

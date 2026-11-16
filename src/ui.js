const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const client = require('./client');
const { PS, MAX_COUNTING_CHANNELS, MODE_EMOJI, MODE_LABEL, MODES, safeMode, SUPPORT_URL, GITHUB_URL, TOPGG_URL, WEBSITE_URL, inviteUrl } = require('./config');
const { getUserStats, getUserRank, getServerStats, getServerLbPage, getGlobalUsersPage, getGlobalServersPage, getHighscoresPage } = require('./db');
const { getGuild, channelsOf, channelLine, chanName, showCur } = require('./state');

const M = ['🥇','🥈','🥉'];
const v2 = require('./v2');
const { E } = v2;
const ep = () => ({ flags: [MessageFlags.Ephemeral] });

// Guild name cache: bounded (LRU) and entries expire, so it can't grow forever.
const GUILD_NAME_MAX = 500, GUILD_NAME_TTL = 60 * 60 * 1000;
const guildNameCache = new Map();
function cacheGuildName(id, name) {
    guildNameCache.delete(id);
    guildNameCache.set(id, { name, at: Date.now() });
    while (guildNameCache.size > GUILD_NAME_MAX) guildNameCache.delete(guildNameCache.keys().next().value);
}
async function guildName(id) {
    const hit = guildNameCache.get(id);
    if (hit && Date.now() - hit.at < GUILD_NAME_TTL) { guildNameCache.delete(id); guildNameCache.set(id, hit); return hit.name; }
    try { const g = client.guilds.cache.get(id) ?? await client.guilds.fetch(id).catch(() => null); const name = g?.name ?? null; if (name) { cacheGuildName(id, name); return name; } } catch {}
    return hit?.name ?? null;
}

async function buildUserStatsEmbed(gid, user) {
    const [st, rank] = await Promise.all([getUserStats(gid,user.id), getUserRank(gid,user.id)]);
    const tot=(st.correct||0)+(st.ruined||0), acc=tot>0?Math.round((st.correct/tot)*100):100;
    return v2.card({accent:v2.COLORS.STATS,title:`Stats - ${user.username}`,thumb:user.displayAvatarURL(),blocks:[
        `\u2705 **Correct:** ${st.correct??0}`,`\u{1F4A5} **Ruined:** ${st.ruined??0}`,`\u{1F3AF} **Accuracy:** ${acc}%`,`\u{1F947} **Rank:** #${rank}`,`\u{1F6E1}\uFE0F **Saves used:** ${st.savesUsed??0}`]});
}
async function buildServerStatsEmbed(guild) {
    const [ss, g] = await Promise.all([getServerStats(guild.id), getGuild(guild.id)]);
    const tc=parseInt(ss.tc)||0,tr=parseInt(ss.tr)||0,tu=parseInt(ss.tu)||0,gt=tc+tr,ac=gt>0?Math.round((tc/gt)*100):100;
    const chans=channelsOf(guild.id);
    return v2.card({accent:v2.COLORS.STATS,title:`Server Stats - ${guild.name}`,thumb:guild.iconURL()||undefined,blocks:[
        `\u{1F465} **Counters:** ${tu}`,`\u2705 **Correct:** ${tc}`,`\u{1F4A5} **Ruined:** ${tr}`,`\u{1F3AF} **Accuracy:** ${ac}%`,`\u{1F6E1}\uFE0F **Saves:** ${g.saves??0}`,
        `\u{1F4CD} **Counting channels (${chans.length})**\n${chans.length?chans.map(channelLine).join('\n').slice(0,1500):'None set up yet'}`]});
}

async function buildServerLbEmbed(gid, page) {
    const {rows,total}=await getServerLbPage(gid,page);
    const tp=Math.max(1,Math.ceil(total/PS)),off=(page-1)*PS;
    if(!rows.length)return{embed:E('#5865F2','\u{1F3C6} Server Leaderboard').setDescription('No stats yet!'),totalPages:1};
    return{totalPages:tp,embed:v2.card({accent:v2.COLORS.STATS,title:'Server Leaderboard',
        blocks:[rows.map((r,i)=>`${M[off+i]??`${off+i+1}.`} <@${r.user_id}> \u2014 ${r.data.correct??0} counts${r.data.ruined?` *(${r.data.ruined} ruined)*`:''}`).join('\n')],
        footer:`**Page ${page}/${tp} \u00b7 ${off+1}\u2013${off+rows.length} of ${total}**`})};
}
async function buildGlobalUsersEmbed(page) {
    const {rows,total}=await getGlobalUsersPage(page);
    const tp=Math.max(1,Math.ceil(total/PS)),off=(page-1)*PS;
    if(!rows.length)return{embed:E('#5865F2','\u{1F30D} Global \u2014 Users').setDescription('No stats yet!'),totalPages:1};
    const lines=await Promise.all(rows.map(async(r,i)=>{
        let display;try{const u=await client.users.fetch(r.user_id);display=`<@${u.id}> (@${u.username})`;}catch{display=`<@${r.user_id}>`;}
        return`${M[off+i]??`${off+i+1}.`} ${display} \u2014 ${parseInt(r.correct)} counts`;
    }));
    return{totalPages:tp,embed:v2.card({accent:v2.COLORS.STATS,title:'Global Leaderboard - Users',blocks:[lines.join('\n')],footer:`**Page ${page}/${tp} \u00b7 ${off+1}\u2013${off+rows.length} of ${total} users**`})};
}

async function buildGlobalServersEmbed(page, filter) {
    const mode=safeMode(filter)??'interactive';
    const {rows,total}=await getGlobalServersPage(page,mode);
    const tp=Math.max(1,Math.ceil(total/PS)),off=(page-1)*PS;
    const titles={interactive:'\u{1F3AE} Global \u2014 Interactive Servers',simple:'\u{1F7E2} Global \u2014 Simple Servers',countdown:'\u23f3 Global \u2014 Countdown Servers',modifiers:'\u{1F3B2} Global \u2014 Modifiers Servers',floors:'\u{1F3E2} Global \u2014 Floors Servers'};
    if(!rows.length)return{embed:E('#5865F2',titles[mode]).setDescription('No servers found!'),totalPages:1,filter:mode};
    const resolved=(await Promise.all(rows.map(async r=>{const name=await guildName(r.guild_id);if(!name)return null;const cn=chanName(r.channel_id);return{name:cn?`${name} \u00b7 #${cn}`:name,emoji:MODE_EMOJI[r.mode]??'\u{1F3AE}',stat:mode==='countdown'?`\u{1F504} **${r.cycles}** cycles`:`\u{1F522} **${r.cur}**`};}))).filter(Boolean)
        .map((r,i)=>`${M[off+i]??`**${off+i+1}.**`} **${r.name}** ${r.emoji} \u2014 ${r.stat}`);
    if(!resolved.length)return{embed:E('#5865F2',titles[mode]).setDescription('No active servers found!'),totalPages:1,filter:mode};
    return{totalPages:tp,filter:mode,embed:v2.card({accent:v2.COLORS.STATS,title:v2.cleanTitle(titles[mode]),blocks:[resolved.join('\n')],footer:`**Page ${page}/${tp}**`})};
}
async function buildHighscoresEmbed(page, filter='interactive') {
    const mode=safeMode(filter)??'interactive';
    const {rows,total}=await getHighscoresPage(page,mode);
    const tp=Math.max(1,Math.ceil(total/PS)),off=(page-1)*PS;
    const titles={interactive:'\u{1F3C5} High Scores \u2014 Interactive',simple:'\u{1F3C5} High Scores \u2014 Simple',modifiers:'\u{1F3C5} High Scores \u2014 Modifiers',floors:'\u{1F3C5} High Scores \u2014 Floors',countdown:'\u{1F3C5} High Scores \u2014 Countdown Cycles'};
    const scoreLabel=mode==='countdown'?'cycles':'high score';
    if(!rows.length)return{embed:E('#5865F2',titles[mode]).setDescription('No data yet!'),totalPages:1};
    const resolved=(await Promise.all(rows.map(async r=>{const name=await guildName(r.guild_id);if(!name)return null;const cn=chanName(r.channel_id);return{name:cn?`${name} \u00b7 #${cn}`:name,score:r.score};}))).filter(Boolean)
        .map((r,i)=>`${M[off+i]??`**${off+i+1}.**`} **${r.name}** \u2014 ${mode==='countdown'?'\u{1F504}':'\u{1F3C6}'} **${r.score}** ${scoreLabel}`);
    if(!resolved.length)return{embed:E('#5865F2',titles[mode]).setDescription('No active servers found!'),totalPages:1};
    return{totalPages:tp,embed:v2.card({accent:v2.COLORS.STATS,title:v2.cleanTitle(titles[mode]),blocks:[resolved.join('\n')],footer:`**Page ${page}/${tp}**`})};
}

const B=(id,label,active)=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(active?ButtonStyle.Primary:ButtonStyle.Secondary);
const statsRow=(uid,gid,active)=>new ActionRowBuilder().addComponents(B(`stats_user_${uid}_${gid}`,'User Stats',active==='user'),B(`stats_server_${uid}_${gid}`,'Server Stats',active==='server'));
function paginationRow(type,ctx,page,tp){const base=ctx?`lb_${type}_${ctx}`:`lb_${type}`;return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${base}_p${page-1}`).setLabel('\u25c0').setStyle(ButtonStyle.Secondary).setDisabled(page<=1),new ButtonBuilder().setCustomId(`${base}_info`).setLabel(`${page}/${tp}`).setStyle(ButtonStyle.Secondary).setDisabled(true),new ButtonBuilder().setCustomId(`${base}_p${page+1}`).setLabel('\u25b6').setStyle(ButtonStyle.Secondary).setDisabled(page>=tp),new ButtonBuilder().setCustomId(`${base}_p${page}`).setLabel('\u21ba').setStyle(ButtonStyle.Secondary));}
// Two tabs, Users and Modes. While Modes is open a second row picks the mode.
function globalTabRows(active){
    const onModes=String(active).startsWith('gs_'),cur=onModes?active.slice(3):'interactive';
    const rows=[new ActionRowBuilder().addComponents(B('lbt_gu','Users',active==='gu'),B(`lbt_modes_${cur}`,'Modes',onModes))];   // its own id: Discord rejects a message where two buttons share one
    if(onModes)rows.push(new ActionRowBuilder().addComponents(B('lbt_gs_interactive','\u{1F3AE} Interactive',cur==='interactive'),B('lbt_gs_simple','\u{1F7E2} Simple',cur==='simple'),B('lbt_gs_countdown','\u23f3 Countdown',cur==='countdown'),B('lbt_gs_modifiers','\u{1F3B2} Modifiers',cur==='modifiers'),B('lbt_gs_floors','\u{1F3E2} Floors',cur==='floors')));
    return rows;
}
function highscoreTabRow(active){return new ActionRowBuilder().addComponents(B('hst_interactive','\u{1F3AE} Interactive',active==='interactive'),B('hst_simple','\u{1F7E2} Simple',active==='simple'),B('hst_countdown','\u23f3 Countdown',active==='countdown'),B('hst_modifiers','\u{1F3B2} Modifiers',active==='modifiers'),B('hst_floors','\u{1F3E2} Floors',active==='floors'));}
function countTypeRow(current,cid){return new ActionRowBuilder().addComponents(...MODES.map(m=>B(`ct_${m}_${cid}`,`${MODE_EMOJI[m]} ${MODE_LABEL[m]}`,current===m)));}
function buildChannelsPanel(gid){
    const chans=channelsOf(gid);
    return {
        embeds:[E('#5865F2','\u{1F4CD} Counting Channels').setDescription(chans.length?chans.map(channelLine).join('\n').slice(0,4000):'No counting channels yet \u2014 press **Add Channel** to set one up.').setFooter({text:`${chans.length}/${MAX_COUNTING_CHANNELS} channels`})],
        components:[new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('cc_add').setLabel('Add Channel').setStyle(ButtonStyle.Primary).setDisabled(chans.length>=MAX_COUNTING_CHANNELS),
            new ButtonBuilder().setCustomId('cc_remove').setLabel('Remove Channel').setStyle(ButtonStyle.Danger).setDisabled(!chans.length),
        )],
    };
}
function pickerRow(gid,purpose){
    const opts=channelsOf(gid).slice(0,25).map(c=>({label:`#${chanName(c.channelId)??c.channelId}`.slice(0,100),description:`${MODE_LABEL[c.countType]} \u00b7 ${showCur(c)}`.slice(0,100),value:c.channelId}));
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`pick_${purpose}`).setPlaceholder('Select a counting channel').addOptions(opts));
}

// The Links page: each link is a line of text with a link button beside it.
const lbRows=(embedRes,activeTab,pRow)=>({embeds:[embedRes.embed],components:[...globalTabRows(activeTab),pRow]});
function gsPagination(filter,page,totalPages){
    const base=`lb_gs_f${filter}`;
    return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${base}_p${page-1}`).setLabel('\u25c0').setStyle(ButtonStyle.Secondary).setDisabled(page<=1),new ButtonBuilder().setCustomId(`${base}_info`).setLabel(`${page}/${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),new ButtonBuilder().setCustomId(`${base}_p${page+1}`).setLabel('\u25b6').setStyle(ButtonStyle.Secondary).setDisabled(page>=totalPages),new ButtonBuilder().setCustomId(`${base}_p${page}`).setLabel('\u21ba').setStyle(ButtonStyle.Secondary));
}
const noChannels=()=>({content:'No counting channels yet \u2014 add one first.',...ep()});

module.exports = {
    M, E, ep, guildName, buildUserStatsEmbed, buildServerStatsEmbed, buildServerLbEmbed, buildGlobalUsersEmbed,
    buildGlobalServersEmbed, buildHighscoresEmbed, B, statsRow, paginationRow, globalTabRows,
    highscoreTabRow, countTypeRow, buildChannelsPanel, pickerRow, lbRows, gsPagination, noChannels,
};

const { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const client = require('./client');
const { PS, MAX_COUNTING_CHANNELS, MODE_EMOJI, MODE_LABEL, MODES, safeMode, SUPPORT_URL } = require('./config');
const { getUserStats, getUserRank, getServerStats, getServerLbPage, getGlobalUsersPage, getGlobalServersPage, getHighscoresPage } = require('./db');
const { getGuild, channelsOf, channelLine, chanName, showCur } = require('./state');

const M = ['🥇','🥈','🥉'];
const E = (color, title) => new EmbedBuilder().setColor(color).setTitle(title);
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
    return E('#5865F2',`\u{1F4CA} Stats \u2014 ${user.username}`).setThumbnail(user.displayAvatarURL()).addFields(
        {name:'\u2705 Correct',value:`**${st.correct??0}**`,inline:true},
        {name:'\u{1F4A5} Ruined',value:`**${st.ruined??0}**`,inline:true},
        {name:'\u{1F3AF} Accuracy',value:`**${acc}%**`,inline:true},
        {name:'\u{1F3C5} Rank',value:`**#${rank}**`,inline:true},
        {name:'\u{1F516} Saves used',value:`**${st.savesUsed??0}**`,inline:true},
    );
}
async function buildServerStatsEmbed(guild) {
    const [ss, g] = await Promise.all([getServerStats(guild.id), getGuild(guild.id)]);
    const tc=parseInt(ss.tc)||0,tr=parseInt(ss.tr)||0,tu=parseInt(ss.tu)||0,gt=tc+tr,ac=gt>0?Math.round((tc/gt)*100):100;
    const chans=channelsOf(guild.id);
    return E('#5865F2',`\u{1F4CA} Server Stats \u2014 ${guild.name}`).setThumbnail(guild.iconURL()).addFields(
        {name:'\u{1F465} Counters',value:`**${tu}**`,inline:true},{name:'\u2705 Correct',value:`**${tc}**`,inline:true},{name:'\u{1F4A5} Ruined',value:`**${tr}**`,inline:true},
        {name:'\u{1F3AF} Accuracy',value:`**${ac}%**`,inline:true},{name:'\u{1F6E1}\ufe0f Saves',value:`**${g.saves??0}**`,inline:true},
        {name:`\u{1F4CD} Counting channels (${chans.length})`,value:chans.length?chans.map(channelLine).join('\n').slice(0,1020):'None set up yet'},
    );
}

async function buildServerLbEmbed(gid, page) {
    const {rows,total}=await getServerLbPage(gid,page);
    const tp=Math.max(1,Math.ceil(total/PS)),off=(page-1)*PS;
    if(!rows.length)return{embed:E('#5865F2','\u{1F3C6} Server Leaderboard').setDescription('No stats yet!'),totalPages:1};
    return{totalPages:tp,embed:E('#5865F2','\u{1F3C6} Server Leaderboard')
        .setDescription(rows.map((r,i)=>`${M[off+i]??`**${off+i+1}.**`} <@${r.user_id}> \u2014 **${r.data.correct??0}** counts${r.data.ruined?` *(${r.data.ruined} ruined)*`:''}`).join('\n'))
        .setFooter({text:`Page ${page}/${tp} \u00b7 ${off+1}\u2013${off+rows.length} of ${total}`})};
}
async function buildGlobalUsersEmbed(page) {
    const {rows,total}=await getGlobalUsersPage(page);
    const tp=Math.max(1,Math.ceil(total/PS)),off=(page-1)*PS;
    if(!rows.length)return{embed:E('#5865F2','\u{1F30D} Global \u2014 Users').setDescription('No stats yet!'),totalPages:1};
    const lines=await Promise.all(rows.map(async(r,i)=>{
        let display;try{const u=await client.users.fetch(r.user_id);display=`<@${u.id}> (@${u.username})`;}catch{display=`<@${r.user_id}>`;}
        return`${M[off+i]??`**${off+i+1}.**`} ${display} \u2014 **${parseInt(r.correct)}** counts`;
    }));
    return{totalPages:tp,embed:E('#5865F2','\u{1F30D} Global Leaderboard \u2014 Users').setDescription(lines.join('\n')).setFooter({text:`Page ${page}/${tp} \u00b7 ${off+1}\u2013${off+rows.length} of ${total} users`})};
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
    return{totalPages:tp,filter:mode,embed:E('#5865F2',titles[mode]).setDescription(resolved.join('\n')).setFooter({text:`Page ${page}/${tp}`})};
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
    return{totalPages:tp,embed:E('#5865F2',titles[mode]).setDescription(resolved.join('\n')).setFooter({text:`Page ${page}/${tp}`})};
}

function buildSetupEmbed(gid, g) {
    const chans=channelsOf(gid);
    const list=chans.length?chans.map(channelLine).join('\n').slice(0,1000):'None yet \u2014 press **Add Channel**';
    return {
        embeds:[E('#5865F2','\u2699\ufe0f Counting Bot \u2014 Setup').setDescription('Use the buttons below to configure the bot. All settings are saved instantly.').addFields(
            {name:`\u{1F4CD} Counting Channels (${chans.length}/${MAX_COUNTING_CHANNELS})`,value:list},
            {name:'\u{1F501} Max Streak',value:`**${g.maxStreak}** in a row`,inline:true},
            {name:'\u{1F9EE} Expressions',value:g.allowExpressions?'Allowed':'Disabled',inline:true},
            {name:'\u{1F512} Access Role',value:g.accessRoleId?`<@&${g.accessRoleId}>`:'Admins only',inline:true},
            {name:'\u{1F6E1}\ufe0f Server Saves',value:`**${g.saves??0}**`,inline:true},
            {name:'\u{1F6AB} Fail Role',value:g.failRoleId?`<@&${g.failRoleId}> for **${g.failRoleMinutes??10}** min`:'Off',inline:true},
            {name:'\u{1F575}\ufe0f Anti-Cheat',value:g.antiCheat?'On':'Off',inline:true},
            {name:'\u26bd Player Counting',value:g.playerCount?'On':'Off',inline:true},
        )],
        components:[
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('setup_addchannel').setLabel('Add Channel').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('setup_removechannel').setLabel('Remove Channel').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('setup_counttype').setLabel('Change Mode').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('setup_reset').setLabel('Reset Count').setStyle(ButtonStyle.Danger),
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('setup_expressions').setLabel(g.allowExpressions?'Disable Expressions':'Enable Expressions').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('setup_anticheat').setLabel(g.antiCheat?'Disable Anti-Cheat':'Enable Anti-Cheat').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('setup_access').setLabel('Set Access Role').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('setup_failrole').setLabel('Set Fail Role').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('setup_refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
            ),
        ],
    };
}

const B=(id,label,active)=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(active?ButtonStyle.Primary:ButtonStyle.Secondary);
const statsRow=(uid,gid,active)=>new ActionRowBuilder().addComponents(B(`stats_user_${uid}_${gid}`,'User Stats',active==='user'),B(`stats_server_${uid}_${gid}`,'Server Stats',active==='server'));
function paginationRow(type,ctx,page,tp){const base=ctx?`lb_${type}_${ctx}`:`lb_${type}`;return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${base}_p${page-1}`).setLabel('\u25c4').setStyle(ButtonStyle.Secondary).setDisabled(page<=1),new ButtonBuilder().setCustomId(`${base}_info`).setLabel(`${page}/${tp}`).setStyle(ButtonStyle.Secondary).setDisabled(true),new ButtonBuilder().setCustomId(`${base}_p${page+1}`).setLabel('\u25ba').setStyle(ButtonStyle.Secondary).setDisabled(page>=tp),new ButtonBuilder().setCustomId(`${base}_p${page}`).setLabel('\u21ba').setStyle(ButtonStyle.Secondary));}
// Six tabs don't fit in one action row, so the global tabs are two rows.
function globalTabRows(active){return[new ActionRowBuilder().addComponents(B('lbt_gu','\u{1F465} Users',active==='gu'),B('lbt_gs_interactive','\u{1F3AE} Interactive',active==='gs_interactive'),B('lbt_gs_simple','\u{1F7E2} Simple',active==='gs_simple')),new ActionRowBuilder().addComponents(B('lbt_gs_countdown','\u23f3 Countdown',active==='gs_countdown'),B('lbt_gs_modifiers','\u{1F3B2} Modifiers',active==='gs_modifiers'),B('lbt_gs_floors','\u{1F3E2} Floors',active==='gs_floors'))];}
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

function buildHelpPage(page){
    const pages=[
        E('#5865F2','\u{1F3AE} How to Play').setDescription('Count up (or down!) together in the counting channels.').addFields(
            {name:'Rules',value:"\u2022 Type the next number\n\u2022 Can't count twice in a row (default)\n\u2022 Wrong number resets the count!\n\u2022 Math expressions supported"},
            {name:'Correct',value:'React added, count goes up'},{name:'Wrong / too fast',value:'Count resets!'},
            {name:'Milestones',value:'Bot celebrates every 100 counts'},
            {name:'Saves',value:'Earned at 50, 100, 250, 500, 1000, 2000, then every 2000. Anyone can use one within 1 minute to undo a ruin!'},
            {name:'Simple mode',value:'No resets \u2014 wrong messages are silently deleted.'},
            {name:'Multiple channels',value:'A server can have several counting channels, each with its own mode and count. Threads share the count of the channel they live in.'},
            {name:'\u26bd Player counting',value:'Type a football player\'s name and their EA FC overall rating is your number! Add a game like `lamine yamal:fc25`, or leave it off for the latest game. An admin turns this on with `/counting players`.'},
        ).setFooter({text:'Page 1/5'}),
        E('#5865F2','Commands').setDescription('All commands:').addFields(
            {name:'Counting',value:'`/counting reset`'},
            {name:'Config',value:'`/counting channel` `/counting setcount` `/counting view` `/counting maxstreak` `/counting expressions` `/counting counttype` `/counting failrole` `/counting anticheat` `/counting players` `/config access`'},
            {name:'Stats',value:'`/stats [user]` `/leaderboard server` `/leaderboard global` `/leaderboard highscores`'},
            {name:'Utilities',value:'`/calculate [expression]` `/invite` `/help` `/setup`'},
            {name:'\u{1F6E0}\ufe0f Support Server',value:`Need help or want to report a bug? [Join the support server](${SUPPORT_URL})`},
        ).setFooter({text:'Page 2/5'}),
        E('#5865F2','Config').setDescription('Requires Administrator or configured access role.').addFields(
            {name:'/counting channel',value:'Shows your counting channels with Add Channel and Remove Channel buttons'},
            {name:'/counting counttype [channel]',value:'Switch a channel between Interactive, Simple, Countdown, Modifiers and Floors'},
            {name:'/counting maxstreak <n>',value:'Max consecutive counts per user (1\u2013100)'},
            {name:'/counting expressions <bool>',value:'Allow/block math expressions'},
            {name:'/config access',value:'Set which role can use the counting commands'},
            {name:'/counting failrole [role] [minutes]',value:'Give players who ruin the count a temporary role (Administrator only)'},
            {name:'/counting anticheat <bool>',value:'Call out edited or deleted counts'},
            {name:'/counting players <bool>',value:'Allow counting with football player names (EA FC ratings)'},
            {name:'/setup',value:'All-in-one setup panel for admins'},
        ).setFooter({text:'Page 3/5'}),
        E('#5865F2','\u23f3 Countdown, \u{1F3B2} Modifiers & \u{1F3E2} Floors').addFields(
            {name:'\u23f3 Countdown',value:'Count DOWN from 100 to 1! When you hit 1, the cycle completes and resets. Wrong number resets to 100. Cycles are tracked on the global leaderboard.'},
            {name:'\u{1F3B2} Modifiers',value:'Like Interactive, but a modifier decides which numbers are valid. The bot only tells you the category \u2014 work out the next number yourself! The modifier changes every time the count resets.'},
            {name:'Modifier categories',value:'\u2022 Every 2nd / 3rd number\n\u2022 Primes only\n\u2022 Fibonacci sequence\n\u2022 Perfect squares\n\u2022 Palindromes\n\u2022 Multiples of 7\n\u2022 Triangular numbers'},
            {name:'\u{1F3E2} Floors',value:'Like Interactive, but every 100 is a floor checkpoint. Ruin the count and you drop back to your highest checkpoint instead of 0.'},
        ).setFooter({text:'Page 4/5'}),
        E('#5865F2','Expressions').setDescription('Math expressions, rounded to nearest whole number.').addFields(
            {name:'Operators',value:'`+` `-` `*` `/` `^`'},
            {name:'Constants',value:'`pi` `phi` `e` `tau` `sqrt2`'},
            {name:'Functions',value:'`ln` `log` `log2` `sqrt(x,n)` `cbrt` `pow(x,n)` `sin` `cos` `tan` `asin`/`arcsin` `acos`/`arccos` `atan`/`arctan` `floor` `ceil` `abs` `exp` `round`'},
            {name:'Examples',value:'`ln(e)`\u2192**1** `log(10)`\u2192**1** `sin(pi)`\u2192**0** `pi^2`\u2192**10** `2^8`\u2192**256**'},
            {name:'/calculate',value:'Type a number to get 3 expressions, or type your own expression to evaluate it!'},
        ).setFooter({text:'Page 5/5'}),
    ];
    return{embeds:[pages[page-1]],components:[new ActionRowBuilder().addComponents(B('help_1','How to Play',page===1),B('help_2','Commands',page===2),B('help_3','Config',page===3),B('help_4','New Modes',page===4),B('help_5','Expressions',page===5))]};
}

const lbRows=(embedRes,activeTab,pRow)=>({embeds:[embedRes.embed],components:[...globalTabRows(activeTab),pRow]});
function gsPagination(filter,page,totalPages){
    const base=`lb_gs_f${filter}`;
    return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${base}_p${page-1}`).setLabel('\u25c4').setStyle(ButtonStyle.Secondary).setDisabled(page<=1),new ButtonBuilder().setCustomId(`${base}_info`).setLabel(`${page}/${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),new ButtonBuilder().setCustomId(`${base}_p${page+1}`).setLabel('\u25ba').setStyle(ButtonStyle.Secondary).setDisabled(page>=totalPages),new ButtonBuilder().setCustomId(`${base}_p${page}`).setLabel('\u21ba').setStyle(ButtonStyle.Secondary));
}
const noChannels=()=>({content:'No counting channels yet \u2014 add one first.',...ep()});

module.exports = {
    M, E, ep, guildName, buildUserStatsEmbed, buildServerStatsEmbed, buildServerLbEmbed, buildGlobalUsersEmbed,
    buildGlobalServersEmbed, buildHighscoresEmbed, buildSetupEmbed, B, statsRow, paginationRow, globalTabRows,
    highscoreTabRow, countTypeRow, buildChannelsPanel, pickerRow, buildHelpPage, lbRows, gsPagination, noChannels,
};

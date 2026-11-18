const { PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder } = require('discord.js');
const client = require('../client');
const { MAX_COUNTING_CHANNELS, MODE_EMOJI, MODE_LABEL, FLOOR_SIZE, COUNTING_CHANNEL_TYPES, INVITE_PERMS, inviteUrl, safeMode } = require('../config');
const { updateUserStat } = require('../db');
const { chanCache, channelsOf, getGuild, saveGuild, saveChan, removeCountingChannel, hasPerm, showCur, channelLine, resolveCounting } = require('../state');
const { expectedNext, nextText, modeIntro, resetChannel } = require('../modes');
const { safeMath, generateExpressions } = require('../math');
const fc = require('../fc');
const { switchMode, announce, addCountingChannel, doReset, ruinEmbed } = require('../ruin');
const {
    E, ep, buildUserStatsEmbed, buildServerStatsEmbed, buildServerLbEmbed, buildGlobalUsersEmbed, buildGlobalServersEmbed,
    buildHighscoresEmbed, statsRow, paginationRow, globalTabRows, highscoreTabRow, countTypeRow,
    buildChannelsPanel, pickerRow, lbRows, gsPagination, noChannels,
} = require('../ui');

const v2 = require('../v2');
const players = require('../players');
const settings = require('../settings');
const help = require('../help');
const { cmd: mention } = require('../mentions');   // not `cmd`: that name holds the slash command in this file
const tour = require('../tour');
const transfer = require('../transfer');
const games = require('../gameshook');

// Drop-in owner tool: present only if src/killbot.js exists (delete the file and restart to remove /killbot).
let killbot = null;
try { killbot = require('../killbot'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND' || !e.message.includes("'../killbot'")) throw e; }

const isAdmin=i=>i.member.permissions.has(PermissionFlagsBits.Administrator);

async function onInteraction(interaction){
    if(games&&await games.handleInteraction(interaction))return;
    const gid=interaction.guild?.id;
    if(await settings.handle(interaction))return;
    if(await help.handle(interaction))return;
    if(await transfer.handle(interaction))return;
    if(interaction.isButton()){
        const id=interaction.customId;
        if(id.startsWith('tour_')&&await tour.handle(interaction,ep))return;
        if(id.startsWith('players_reroll_'))return players.handleReroll(interaction);
        if(id.startsWith('calc_copy_')){const parts=id.split('_');const expr=parts.slice(3).join('_');return interaction.reply({content:`\`${expr}\`\nTap and hold to copy \u2014 then paste it in the counting channel!`,...ep()});}
        if(id==='cc_add'||id==='cc_remove'){
            if(!await hasPerm(interaction,gid))return interaction.reply({content:'No permission.',...ep()});
            if(id==='cc_add')return interaction.reply({embeds:[E('#5865F2','Add Counting Channel').setDescription(`Select a channel to count in (${channelsOf(gid).length}/${MAX_COUNTING_CHANNELS} used). You can pick its mode right after.`)],components:[new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('setup_channel_select').setPlaceholder('Select a channel').addChannelTypes(...COUNTING_CHANNEL_TYPES).setMinValues(1).setMaxValues(1))],...ep()});
            if(!channelsOf(gid).length)return interaction.reply(noChannels());
            return interaction.reply({embeds:[E('#5865F2','Remove Counting Channel').setDescription('Which channel should stop counting?')],components:[pickerRow(gid,'remove')],...ep()});
        }
        // buttons on /setup panels that were posted before the command was removed
        if(id.startsWith('setup_'))return interaction.reply({content:`\`/setup\` was removed. Use ${mention('counting settings')} for settings, ${mention('counting channel')} for channels, ${mention('counting reset')} to reset a count and ${mention('config access')} for the access role.`,...ep()});
        if(id.startsWith('ct_')){
            const[,newType,cid]=id.split('_');
            if(!safeMode(newType)||!cid)return;
            if(!await hasPerm(interaction,gid))return interaction.reply({content:'No permission.',...ep()});
            const c=chanCache.get(cid);
            if(!c||c.guildId!==gid)return interaction.reply({content:'That counting channel no longer exists.',...ep()});
            switchMode(interaction.guild,c,newType);
            return interaction.update({embeds:[E('#5865F2',`<#${cid}> \u2192 ${MODE_EMOJI[newType]} ${MODE_LABEL[newType]}`).setDescription(`Mode changed and the count was reset.\n${modeIntro(c)}`)],components:[countTypeRow(newType,cid)]});
        }
        if(id.startsWith('saveuse_')||id.startsWith('savedecline_')){
            const parts=id.split('_'),action=parts[0],ownerId=parts[1],prevCount=parseInt(parts[2]),cid=parts[3],expiresAt=parseInt(parts[4]);
            if(interaction.user.id!==ownerId)return interaction.reply({content:'Only the person who ruined the count can do this!',...ep()});
            if(Date.now()>expiresAt)return interaction.reply({content:'Save prompt has expired.',...ep()});
            const c=chanCache.get(cid);
            if(!c||c.guildId!==gid||!c.pendingSave||c.pendingSave.expiresAt!==expiresAt)return interaction.reply({content:'Save prompt has expired.',...ep()});
            const g=await getGuild(gid),pending=c.pendingSave;
            if(action==='saveuse'){
                if((g.saves??0)<1)return interaction.reply({content:'The server has no saves left.',...ep()});
                delete c.pendingSave;
                c.current=prevCount;c.lastUserId=pending.prevLastUserId??null;c.consecutiveCount=pending.prevConsecutive??0;c.lastMessageId=pending.prevLastMessageId??null;
                g.saves=g.saves-1;g.savesUsed=(g.savesUsed??0)+1;
                saveGuild(gid,g);saveChan(c);await updateUserStat(gid,ownerId,{savesUsed:1});
                return interaction.update({embeds:[E('#00cc88','\u{1F6E1}\ufe0f Save used!').setDescription(`<@${ownerId}> used a **Save** \u2014 count stays at **${prevCount}**!`).addFields({name:'Remaining',value:`**${g.saves}**`,inline:true},c.countType==='modifiers'?{name:'Modifier',value:c.modifierLabel??'\u2014',inline:true}:{name:'Next number',value:`**${expectedNext(c)}**`,inline:true})],components:[]});
            }else{
                delete c.pendingSave;
                doReset(g,c,ownerId);
                return interaction.update({embeds:[ruinEmbed(c,g,'\u{1F4A5} Count ruined!',`<@${ownerId}> declined the save. Count was at **${prevCount}**.`,ownerId)],components:[]});
            }
        }
        if(id.startsWith('stats_')){
            await interaction.deferUpdate();const[,view,tuid,bgid]=id.split('_');
            try{if(view==='user'){const u=await client.users.fetch(tuid).catch(()=>interaction.user);return interaction.editReply({embeds:[await buildUserStatsEmbed(bgid,u)],components:[statsRow(tuid,bgid,'user')]});}
            if(view==='server'){const g=client.guilds.cache.get(bgid)??await client.guilds.fetch(bgid).catch(()=>interaction.guild);return interaction.editReply({embeds:[await buildServerStatsEmbed(g)],components:[statsRow(tuid,bgid,'server')]});}}
            catch{return interaction.editReply({content:'Failed to load stats.'});}
        }
        if(id.startsWith('lbt_')){
            await interaction.deferUpdate();
            try{
                if(id==='lbt_gu'){const{embed,totalPages}=await buildGlobalUsersEmbed(1);return interaction.editReply({embeds:[embed],components:[...globalTabRows('gu'),paginationRow('gu','',1,totalPages)]});}
                const sf=safeMode(id.startsWith('lbt_modes_')?id.slice('lbt_modes_'.length):id.replace('lbt_gs_',''));   // the Modes tab keeps the mode that is open
                if(sf){const r=await buildGlobalServersEmbed(1,sf);return interaction.editReply(lbRows(r,`gs_${sf}`,gsPagination(sf,1,r.totalPages)));}
            }catch(e){console.error('tab btn:',e);await interaction.editReply({content:'Failed to load.'}).catch(()=>{});}
        }
        if(id.startsWith('hst_')){
            await interaction.deferUpdate();const filter=safeMode(id.slice(4))??'interactive';
            try{const{embed,totalPages}=await buildHighscoresEmbed(1,filter);return interaction.editReply({embeds:[embed],components:[highscoreTabRow(filter),paginationRow(`hs_${filter}`,'',1,totalPages)]});}
            catch(e){console.error('hst btn:',e);await interaction.editReply({content:'\u274c Failed.'}).catch(()=>{});}
        }
        if(id.startsWith('lb_')){
            const last=id.split('_').pop();if(last==='info')return interaction.deferUpdate();
            const page=parseInt(last.replace('p',''));if(isNaN(page)||page<1)return interaction.deferUpdate();
            await interaction.deferUpdate();
            try{
                const type=id.split('_')[1];
                if(type==='gu'){const{embed,totalPages}=await buildGlobalUsersEmbed(page);return interaction.editReply({embeds:[embed],components:[...globalTabRows('gu'),paginationRow('gu','',page,totalPages)]});}
                if(type==='gs'){const fs=id.split('_').find(s=>s.startsWith('f')),filter=safeMode(fs?fs.slice(1):'')??'interactive';const r=await buildGlobalServersEmbed(page,filter);return interaction.editReply(lbRows(r,`gs_${filter}`,gsPagination(filter,page,r.totalPages)));}
                if(type==='hs'){const parts=id.split('_'),filter=parts.map(safeMode).find(Boolean)??'interactive';const{embed,totalPages}=await buildHighscoresEmbed(page,filter);return interaction.editReply({embeds:[embed],components:[highscoreTabRow(filter),paginationRow(`hs_${filter}`,'',page,totalPages)]});}
                if(type==='sv'){const svgid=id.split('_')[2];const{embed,totalPages}=await buildServerLbEmbed(svgid,page);return interaction.editReply({embeds:[embed],components:[paginationRow('sv',svgid,page,totalPages)]});}
            }catch(e){console.error('lb btn:',e);await interaction.editReply({content:'Failed to load. Try again.'}).catch(()=>{});}
        }
        return;
    }
    if(interaction.isRoleSelectMenu()){
        const cid=interaction.customId;
        if(cid.startsWith('access_role_')){
            if(!isAdmin(interaction))return interaction.reply({content:'Admins only.',...ep()});
            const g=await getGuild(gid);g.accessRoleId=interaction.values[0];saveGuild(gid,g);
            return interaction.update({embeds:[E('#5865F2','Access role set').setDescription(`<@&${g.accessRoleId}> can now use the counting commands.`)],components:[]});
        }
    }
    if(interaction.isChannelSelectMenu()&&interaction.customId==='setup_channel_select'){
        if(!await hasPerm(interaction,gid))return interaction.reply({content:'No permission.',...ep()});
        const cid=interaction.values[0],res=await addCountingChannel(interaction.guild,cid,'interactive');
        if(res.error)return interaction.update({embeds:[E('#ff4444','Could not add channel').setDescription(res.error)],components:[]});
        return interaction.update({embeds:[E('#5865F2','Counting channel added').setDescription(`<#${cid}> is now a counting channel in **${MODE_LABEL[res.c.countType]}** mode. Pick a different mode below if you like.`)],components:[countTypeRow(res.c.countType,cid)]});
    }
    if(interaction.isStringSelectMenu()&&interaction.customId.startsWith('pick_')){
        if(!await hasPerm(interaction,gid))return interaction.reply({content:'No permission.',...ep()});
        const purpose=interaction.customId.slice(5),cid=interaction.values[0],c=chanCache.get(cid);
        if(!c||c.guildId!==gid)return interaction.update({embeds:[E('#ff4444','Not found').setDescription('That counting channel no longer exists.')],components:[]});
        if(purpose==='mode')return interaction.update({embeds:[E('#5865F2',`Mode for <#${cid}>`).setDescription(`Currently **${MODE_EMOJI[c.countType]} ${MODE_LABEL[c.countType]}**. Changing the mode resets that channel's count.`)],components:[countTypeRow(c.countType,cid)]});
        if(purpose==='reset'){const prev=showCur(c);resetChannel(c,true);saveChan(c);announce(interaction.guild,c,E('#ff9900','\u{1F504} Count reset').setDescription(`Admin reset from **${prev}**.\n${modeIntro(c)}`));return interaction.update({embeds:[E('#5865F2','Count reset').setDescription(`<#${cid}> was reset.`)],components:[]});}
        if(purpose==='remove'){await removeCountingChannel(gid,cid);return interaction.update({embeds:[E('#5865F2','Counting channel removed').setDescription(`<#${cid}> is no longer a counting channel.`)],components:[]});}
        return;
    }
    if(!interaction.isChatInputCommand())return;
    if(killbot&&await killbot.handle(interaction))return;
    if(!interaction.guild)return interaction.reply({content:'Server only.',...ep()});
    const{commandName:cmd,options}=interaction;
    try{
        if(cmd==='help')return help.run(interaction,ep);
        if(cmd==='players')return players.handlePlayers(interaction);
        if(cmd==='transfer')return transfer.run(interaction);
        if(cmd==='counting'&&options.getSubcommand()==='settings')return settings.open(interaction,options.getChannel('channel'));
        if(cmd==='invite')return interaction.reply({embeds:[E('#5865F2','Invite Counting Bot').setDescription(`[**Invite me!**](${inviteUrl(client.user.id)})`).addFields({name:'Permissions',value:'View Channels \u00b7 Send Messages (+ in Threads) \u00b7 Add Reactions \u00b7 Read History \u00b7 Embed Links \u00b7 Manage Messages \u00b7 Manage Roles (only needed for fail roles)'})],...ep()});
        if(cmd==='calculate'){
            await interaction.deferReply(ep());
            const input=options.getString('input').trim();
            // Player tags work here too ("lamine yamal:fc27+10"), whatever the server's player counting setting says: this is only a calculator.
            let rated=null,evaluated;
            if(fc.hasTag(input)){
                let sub;try{sub=await fc.substitute(input);}catch(e){console.error('calculate players:',e.message);return interaction.editReply({embeds:[E('#ff4444','Player lookup failed').setDescription('Player ratings are not available right now. Try again in a moment.')]});}
                if(sub.unknown){const m=sub.missing;return interaction.editReply({embeds:[E('#ff4444','Player not found').setDescription(m?`I couldn't find **${m.name}** in ${fc.gameLabel(m.game)}. Check the spelling, and write it with its game tag, like \`${m.name}:fc25\`.`:`I couldn't find one of the players in \`${input}\`.`)]});}
                if(sub.players.length)rated=sub.players;
                evaluated=safeMath(sub.text);
            }else evaluated=safeMath(input);
            const looksLikeNumber=/^[\d]+$/.test(input.replace(/\s/g,''));
            if(looksLikeNumber&&evaluated!==null){const exprs=generateExpressions(evaluated);const copyRow=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`calc_copy_0_${exprs[0]}`).setLabel(`Copy: ${exprs[0]}`).setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(`calc_copy_1_${exprs[1]}`).setLabel(`Copy: ${exprs[1]}`).setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(`calc_copy_2_${exprs[2]}`).setLabel(`Copy: ${exprs[2]}`).setStyle(ButtonStyle.Secondary),);return interaction.editReply({embeds:[E('#5865F2',`Ways to write ${evaluated}`).setDescription(`3 expressions for **${evaluated}**:`).addFields(...exprs.map((x,i)=>({name:`${['\u0031\ufe0f\u20e3','\u0032\ufe0f\u20e3','\u0033\ufe0f\u20e3'][i]} \`${x}\``,value:`= **${safeMath(x)??evaluated}**`,inline:true}))).setFooter({text:'Supports: + - * / ^ pi phi e tau sqrt2 \u00b7 ln log sin cos tan sqrt cbrt'})],components:[copyRow]});}
            if(evaluated!==null){
                const resultEmbed=E('#5865F2','Result').addFields({name:'Expression',value:`\`${input}\``,inline:true},{name:'Result',value:`**${evaluated}**`,inline:true}).setFooter({text:'Rounded to nearest whole number'});
                if(rated)resultEmbed.addFields({name:'Players',value:rated.map(p=>`${p.name} (${fc.gameLabel(p.game)}): **${p.ovr}**`).join('\n')});
                const canCopy=Buffer.byteLength(`calc_copy_0_${input}`,'utf8')<=100;
                const reply={embeds:[resultEmbed]};
                if(canCopy)reply.components=[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`calc_copy_0_${input}`).setLabel('Copy expression').setStyle(ButtonStyle.Secondary))];
                return interaction.editReply(reply);
            }
            return interaction.editReply({embeds:[E('#ff4444','Invalid expression').setDescription(`\`${input}\` couldn't be evaluated.\n\nConstants: \`pi\` \`phi\` \`e\` \`tau\` \`sqrt2\``)]});
        }
        if(cmd==='stats'){await interaction.deferReply(ep());const u=options.getUser('user')??interaction.user;return interaction.editReply({embeds:[await buildUserStatsEmbed(gid,u)],components:[statsRow(u.id,gid,'user')]});}
        if(cmd==='leaderboard'){
            await interaction.deferReply(ep());const sub=options.getSubcommand();
            if(sub==='server'){const{embed,totalPages}=await buildServerLbEmbed(gid,1);return interaction.editReply({embeds:[embed],components:[paginationRow('sv',gid,1,totalPages)]});}
            if(sub==='global'){const{embed,totalPages}=await buildGlobalUsersEmbed(1);return interaction.editReply({embeds:[embed],components:[...globalTabRows('gu'),paginationRow('gu','',1,totalPages)]});}
            if(sub==='elo'){
                if(!games)return interaction.editReply({embeds:[E('#ff4444','Games are disabled').setDescription('Run `npm install` so the games can load.')]});
                return interaction.editReply(await games.leaderboard(options.getString('game'),interaction.user.id));
            }
            if(sub==='highscores'){const{embed,totalPages}=await buildHighscoresEmbed(1,'interactive');return interaction.editReply({embeds:[embed],components:[highscoreTabRow('interactive'),paginationRow('hs_interactive','',1,totalPages)]});}
        }
        if(cmd==='config'||(cmd==='counting'&&options.getSubcommand()!=='reset')){
            const sub=options.getSubcommand();
            if(sub==='view'){
                await interaction.deferReply(ep());const g=await getGuild(gid),chans=channelsOf(gid);
                return interaction.editReply({embeds:[E('#5865F2','Counting Status').addFields(
                    {name:`Counting channels (${chans.length}/${MAX_COUNTING_CHANNELS})`,value:chans.length?chans.map(c=>`${channelLine(c)}${c.lastUserId?` \u00b7 last <@${c.lastUserId}>`:''}`).join('\n').slice(0,1020):`None set up yet \u2014 use ${mention('counting channel')}`},
                    {name:'Streak',value:`**${g.maxStreak}** in a row`,inline:true},{name:'Expressions',value:g.allowExpressions?'Allowed':'Disabled',inline:true},{name:'Equations',value:g.allowExpressions&&g.allowEquations!==false?'Allowed':'Disabled',inline:true},{name:'Saves',value:`**${g.saves??0}**`,inline:true},
                    {name:'Access',value:g.accessRoleId?`<@&${g.accessRoleId}>`:'Admins only',inline:true},{name:'Fail role',value:g.failRoleId?`<@&${g.failRoleId}> (${g.failRoleMinutes??10} min)`:'Off',inline:true},{name:'Anti-cheat',value:'Always on',inline:true},
                    {name:'Players',value:g.playerCount?'On':'Off',inline:true},
                )]});
            }
            if(sub==='access'){if(!isAdmin(interaction))return interaction.reply({content:'Admins only.',...ep()});const g=await getGuild(gid);return interaction.reply({embeds:[E('#5865F2','Access Config').setDescription('Select a role that can use the counting commands.').addFields({name:'Current role',value:g.accessRoleId?`<@&${g.accessRoleId}>`:'None (admins only)'})],components:[new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`access_role_${gid}`).setPlaceholder('Select role').setMinValues(1).setMaxValues(1))],...ep()});}
            if(!await hasPerm(interaction,gid))return interaction.reply({content:'No permission.',...ep()});
            if(sub==='channel')return interaction.reply({...buildChannelsPanel(gid),...ep()});
        }
        if(cmd==='counting'){
            const sub=options.getSubcommand();if(!await hasPerm(interaction,gid))return interaction.reply({content:'No permission.',...ep()});
            await interaction.deferReply(ep());
            if(sub==='reset'){
                const{c,error}=resolveCounting(interaction,options.getChannel('channel'));
                if(error)return interaction.editReply({content:error});
                const prev=showCur(c);
                resetChannel(c,true);saveChan(c);
                announce(interaction.guild,c,E('#ff9900','\u{1F504} Count reset').setDescription(`Admin reset from **${prev}**.\n${modeIntro(c)}`));
                return interaction.editReply({content:`<#${c.channelId}> reset from **${prev}**.`});
            }
        }
    }catch(error){
        if(error?.code===40060)return;
        console.error('Interaction error:',error);
        try{const m={content:'Something went wrong.',...ep()};if(interaction.deferred)await interaction.editReply(m).catch(()=>{});else if(!interaction.replied)await interaction.reply(m).catch(()=>{});}catch{}
    }
}

// Every reply goes out as a V2 message (see v2.js). Buttons on messages from before the V2 update cannot be edited into V2.
async function entry(interaction){
    v2.wrapInteraction(interaction);
    if(v2.isOutdated(interaction)){await interaction.reply({content:'This message is from an older version of the bot. Run the command again to get a fresh one.',...ep()}).catch(()=>{});return;}
    return onInteraction(interaction);
}
function register(){ client.on('interactionCreate',entry); }

module.exports = { register };

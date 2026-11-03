const { PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder } = require('discord.js');
const client = require('../client');
const { MAX_COUNTING_CHANNELS, MODE_EMOJI, MODE_LABEL, FLOOR_SIZE, COUNTING_CHANNEL_TYPES, INVITE_PERMS, safeMode } = require('../config');
const { updateUserStat } = require('../db');
const { chanCache, channelsOf, getGuild, saveGuild, saveChan, removeCountingChannel, hasPerm, showCur, channelLine, resolveCounting } = require('../state');
const { expectedNext, nextText, modeIntro, resetChannel } = require('../modes');
const { safeMath, generateExpressions } = require('../math');
const { validateFailRole, failRoleWarning } = require('../failroles');
const { switchMode, announce, addCountingChannel, doReset, ruinEmbed } = require('../ruin');
const {
    E, ep, buildUserStatsEmbed, buildServerStatsEmbed, buildServerLbEmbed, buildGlobalUsersEmbed, buildGlobalServersEmbed,
    buildHighscoresEmbed, buildSetupEmbed, statsRow, paginationRow, globalTabRows, highscoreTabRow, countTypeRow,
    buildChannelsPanel, pickerRow, buildHelpPage, lbRows, gsPagination, noChannels,
} = require('../ui');

const { optional } = require('../optional');

// Drop-in owner tool: present only if src/killbot.js exists.
const killbot = optional('./killbot');

const isAdmin=i=>i.member.permissions.has(PermissionFlagsBits.Administrator);

async function onInteraction(interaction){
    const gid=interaction.guild?.id;
    if(interaction.isButton()){
        const id=interaction.customId;
        if(id.startsWith('help_')){const p=parseInt(id.split('_')[1]);if(!isNaN(p)&&p>=1&&p<=5)return interaction.update(buildHelpPage(p));}
        if(id.startsWith('calc_copy_')){const parts=id.split('_');const expr=parts.slice(3).join('_');return interaction.reply({content:`\`${expr}\`\nTap and hold to copy \u2014 then paste it in the counting channel!`,...ep()});}
        if(id==='cc_add'||id==='cc_remove'){
            if(!await hasPerm(interaction,gid))return interaction.reply({content:'No permission.',...ep()});
            if(id==='cc_add')return interaction.reply({embeds:[E('#5865F2','Add Counting Channel').setDescription(`Select a channel to count in (${channelsOf(gid).length}/${MAX_COUNTING_CHANNELS} used). You can pick its mode right after.`)],components:[new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('setup_channel_select').setPlaceholder('Select a channel').addChannelTypes(...COUNTING_CHANNEL_TYPES).setMinValues(1).setMaxValues(1))],...ep()});
            if(!channelsOf(gid).length)return interaction.reply(noChannels());
            return interaction.reply({embeds:[E('#5865F2','Remove Counting Channel').setDescription('Which channel should stop counting?')],components:[pickerRow(gid,'remove')],...ep()});
        }
        if(id.startsWith('setup_')){
            if(!interaction.guild)return;
            if(!isAdmin(interaction))return interaction.reply({content:'Admins only.',...ep()});
            const g=await getGuild(gid);
            if(id==='setup_refresh')return interaction.update(buildSetupEmbed(gid,g));
            if(id==='setup_expressions'){g.allowExpressions=!g.allowExpressions;saveGuild(gid,g);return interaction.update(buildSetupEmbed(gid,g));}
            if(id==='setup_anticheat'){g.antiCheat=!g.antiCheat;saveGuild(gid,g);return interaction.update(buildSetupEmbed(gid,g));}
            if(id==='setup_addchannel')return interaction.reply({embeds:[E('#5865F2','Add Counting Channel').setDescription(`Select a channel to count in (${channelsOf(gid).length}/${MAX_COUNTING_CHANNELS} used). You can pick its mode right after.`)],components:[new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('setup_channel_select').setPlaceholder('Select a channel').addChannelTypes(...COUNTING_CHANNEL_TYPES).setMinValues(1).setMaxValues(1))],...ep()});
            const purposes={setup_removechannel:['remove','Remove Counting Channel','Which channel should stop counting?'],setup_counttype:['mode','Change Mode','Which channel do you want to change the mode of?'],setup_reset:['reset','Reset Count','Which channel do you want to reset?']};
            if(purposes[id]){
                if(!channelsOf(gid).length)return interaction.reply(noChannels());
                const[purpose,title,desc]=purposes[id];
                return interaction.reply({embeds:[E('#5865F2',title).setDescription(desc)],components:[pickerRow(gid,purpose)],...ep()});
            }
            if(id==='setup_access')return interaction.reply({embeds:[E('#5865F2','Set Access Role').setDescription('Select which role can use the `/counting` commands:')],components:[new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup_role_select').setPlaceholder('Select a role').setMinValues(1).setMaxValues(1))],...ep()});
            if(id==='setup_failrole')return interaction.reply({embeds:[E('#5865F2','Set Fail Role').setDescription(`Select the role players get for **${g.failRoleMinutes??10}** minutes after ruining the count. Use \`/counting failrole\` to change the duration or turn it off.`)],components:[new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup_failrole_select').setPlaceholder('Select a role').setMinValues(1).setMaxValues(1))],...ep()});
            return;
        }
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
                const sf=safeMode(id.replace('lbt_gs_',''));
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
        if(cid==='setup_role_select'||cid.startsWith('access_role_')){
            if(!isAdmin(interaction))return interaction.reply({content:'Admins only.',...ep()});
            const g=await getGuild(gid);g.accessRoleId=interaction.values[0];saveGuild(gid,g);
            return interaction.update({embeds:[E('#5865F2','Access role set').setDescription(`<@&${g.accessRoleId}> can now use the counting commands.`)],components:[]});
        }
        if(cid==='setup_failrole_select'){
            if(!isAdmin(interaction))return interaction.reply({content:'Admins only.',...ep()});
            const role=interaction.guild.roles.cache.get(interaction.values[0]),err=validateFailRole(interaction.guild,role);
            if(err)return interaction.update({embeds:[E('#ff4444','Fail role not set').setDescription(err)],components:[]});
            const g=await getGuild(gid);g.failRoleId=role.id;saveGuild(gid,g);
            return interaction.update({embeds:[E('#5865F2','Fail role set').setDescription(`Players who ruin the count get <@&${role.id}> for **${g.failRoleMinutes??10}** minutes.${failRoleWarning(role)}`)],components:[]});
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
        if(cmd==='help')return interaction.reply({...buildHelpPage(1),...ep()});
        if(cmd==='invite')return interaction.reply({embeds:[E('#5865F2','Invite Counting Bot').setDescription(`[**Invite me!**](https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=${INVITE_PERMS}&scope=bot%20applications.commands)`).addFields({name:'Permissions',value:'View Channels \u00b7 Send Messages (+ in Threads) \u00b7 Add Reactions \u00b7 Read History \u00b7 Embed Links \u00b7 Manage Messages \u00b7 Manage Roles (only needed for fail roles)'})],...ep()});
        if(cmd==='setup'){if(!isAdmin(interaction))return interaction.reply({content:'Admins only.',...ep()});return interaction.reply({...buildSetupEmbed(gid,await getGuild(gid)),...ep()});}
        if(cmd==='calculate'){
            await interaction.deferReply(ep());
            const input=options.getString('input').trim(),evaluated=safeMath(input),looksLikeNumber=/^[\d]+$/.test(input.replace(/\s/g,''));
            if(looksLikeNumber&&evaluated!==null){const exprs=generateExpressions(evaluated);const copyRow=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`calc_copy_0_${exprs[0]}`).setLabel(`Copy: ${exprs[0]}`).setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(`calc_copy_1_${exprs[1]}`).setLabel(`Copy: ${exprs[1]}`).setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(`calc_copy_2_${exprs[2]}`).setLabel(`Copy: ${exprs[2]}`).setStyle(ButtonStyle.Secondary),);return interaction.editReply({embeds:[E('#5865F2',`Ways to write ${evaluated}`).setDescription(`3 expressions for **${evaluated}**:`).addFields(...exprs.map((x,i)=>({name:`${['\u0031\ufe0f\u20e3','\u0032\ufe0f\u20e3','\u0033\ufe0f\u20e3'][i]} \`${x}\``,value:`= **${safeMath(x)??evaluated}**`,inline:true}))).setFooter({text:'Supports: + - * / ^ pi phi e tau sqrt2 \u00b7 ln log sin cos tan sqrt cbrt'})],components:[copyRow]});}
            if(evaluated!==null){
                const resultEmbed=E('#5865F2','Result').addFields({name:'Expression',value:`\`${input}\``,inline:true},{name:'Result',value:`**${evaluated}**`,inline:true}).setFooter({text:'Rounded to nearest whole number'});
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
            if(sub==='highscores'){const{embed,totalPages}=await buildHighscoresEmbed(1,'interactive');return interaction.editReply({embeds:[embed],components:[highscoreTabRow('interactive'),paginationRow('hs_interactive','',1,totalPages)]});}
        }
        if(cmd==='config'||(cmd==='counting'&&options.getSubcommand()!=='reset')){
            const sub=options.getSubcommand();
            if(sub==='view'){
                await interaction.deferReply(ep());const g=await getGuild(gid),chans=channelsOf(gid);
                return interaction.editReply({embeds:[E('#5865F2','Counting Status').addFields(
                    {name:`Counting channels (${chans.length}/${MAX_COUNTING_CHANNELS})`,value:chans.length?chans.map(c=>`${channelLine(c)}${c.lastUserId?` \u00b7 last <@${c.lastUserId}>`:''}`).join('\n').slice(0,1020):'None set up yet \u2014 use `/counting channel`'},
                    {name:'Streak',value:`**${g.maxStreak}** in a row`,inline:true},{name:'Expr',value:g.allowExpressions?'Allowed':'Disabled',inline:true},{name:'Saves',value:`**${g.saves??0}**`,inline:true},
                    {name:'Access',value:g.accessRoleId?`<@&${g.accessRoleId}>`:'Admins only',inline:true},{name:'Fail role',value:g.failRoleId?`<@&${g.failRoleId}> (${g.failRoleMinutes??10} min)`:'Off',inline:true},{name:'Anti-cheat',value:g.antiCheat?'On':'Off',inline:true},
                    {name:'Players',value:g.playerCount?'On':'Off',inline:true},
                )]});
            }
            if(sub==='access'){if(!isAdmin(interaction))return interaction.reply({content:'Admins only.',...ep()});const g=await getGuild(gid);return interaction.reply({embeds:[E('#5865F2','Access Config').setDescription('Select a role that can use the `/counting` commands.').addFields({name:'Current role',value:g.accessRoleId?`<@&${g.accessRoleId}>`:'None (admins only)'})],components:[new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`access_role_${gid}`).setPlaceholder('Select role').setMinValues(1).setMaxValues(1))],...ep()});}
            if(sub==='failrole'){
                if(!isAdmin(interaction))return interaction.reply({content:'Admins only.',...ep()});
                await interaction.deferReply(ep());
                const g=await getGuild(gid),guild=interaction.guild,minutes=options.getInteger('minutes'),picked=options.getRole('role');
                if(options.getBoolean('disable')){g.failRoleId=null;saveGuild(gid,g);return interaction.editReply({embeds:[E('#5865F2','Fail role disabled').setDescription('Players who ruin the count no longer get a role.')]});}
                let role=picked?guild.roles.cache.get(picked.id):null;
                if(!role){
                    const current=g.failRoleId?guild.roles.cache.get(g.failRoleId):null;
                    if(current){
                        if(!minutes)return interaction.editReply({embeds:[E('#5865F2','Fail role').setDescription(`Currently <@&${current.id}> for **${g.failRoleMinutes??10}** min.\nPass \`role\`, \`minutes\` or \`disable\` to change it.${failRoleWarning(current)}`)]});
                        g.failRoleMinutes=minutes;saveGuild(gid,g);
                        return interaction.editReply({embeds:[E('#5865F2','Fail role updated').setDescription(`<@&${current.id}> now lasts **${minutes}** min.`)]});
                    }
                    try{role=await guild.roles.create({name:'Ruined the Count',color:0xff4444,permissions:[],reason:'Tick fail role'});}
                    catch(e){return interaction.editReply({embeds:[E('#ff4444','Could not create the role').setDescription('I need the **Manage Roles** permission. You can also pick an existing role with the `role` option.')]});}
                }
                const err=validateFailRole(guild,role);
                if(err)return interaction.editReply({embeds:[E('#ff4444','Fail role not set').setDescription(err)]});
                g.failRoleId=role.id;if(minutes)g.failRoleMinutes=minutes;saveGuild(gid,g);
                return interaction.editReply({embeds:[E('#5865F2','Fail role set').setDescription(`Players who ruin the count get <@&${role.id}> for **${g.failRoleMinutes??10}** minutes.${failRoleWarning(role)}`)]});
            }
            if(!await hasPerm(interaction,gid))return interaction.reply({content:'No permission.',...ep()});
            if(sub==='channel')return interaction.reply({...buildChannelsPanel(gid),...ep()});
            if(sub==='counttype'){
                const{c,error}=resolveCounting(interaction,options.getChannel('channel'));
                if(error)return interaction.reply({content:error,...ep()});
                return interaction.reply({embeds:[E('#5865F2',`Count Type \u2014 <#${c.channelId}>`).setDescription('Choose a counting mode. Changing it resets this channel\'s count.').addFields({name:'\u{1F3AE} Interactive',value:'Wrong numbers reset the count. Streaks, saves, and reactions apply.',inline:true},{name:'\u{1F7E2} Simple',value:'Wrong messages are silently deleted. Count never resets.',inline:true},{name:'\u23f3 Countdown',value:'Count DOWN from 100 to 1. Complete cycles for glory!',inline:true},{name:'\u{1F3B2} Modifiers',value:'Interactive with a modifier (primes, Fibonacci, etc.). The bot only names the category, never the next number!',inline:true},{name:'\u{1F3E2} Floors',value:`Interactive with a checkpoint every ${FLOOR_SIZE}. Ruin the count and you drop back to your highest checkpoint.`,inline:true},{name:'Current mode',value:`**${MODE_EMOJI[c.countType]} ${MODE_LABEL[c.countType]}**`})],components:[countTypeRow(c.countType,c.channelId)],...ep()});
            }
            await interaction.deferReply(ep());const g=await getGuild(gid);
            if(sub==='setcount'){
                const{c,error}=resolveCounting(interaction,options.getChannel('channel'));
                if(error)return interaction.editReply({content:error});
                const num=options.getInteger('number'),prev=showCur(c);
                if(c.countType==='countdown')c.current=(num<1||num>=c.countdownStart)?c.countdownStart+1:num;
                else{c.current=num;if(num>c.highScore)c.highScore=num;if(c.countType==='floors')c.checkpoint=Math.floor(num/FLOOR_SIZE)*FLOOR_SIZE;}
                c.lastUserId=null;c.consecutiveCount=0;c.lastMessageId=null;saveChan(c);
                announce(interaction.guild,c,E('#5865F2','Count set').setDescription(`Count set from **${prev}** to **${showCur(c)}**.\n${nextText(c)}.`));
                return interaction.editReply({content:`<#${c.channelId}> count set to **${showCur(c)}**.`});
            }
            if(sub==='maxstreak'){g.maxStreak=options.getInteger('amount');saveGuild(gid,g);return interaction.editReply({embeds:[E('#5865F2','Max streak updated').setDescription(g.maxStreak===1?"Users can't count twice in a row.":`Users can count **${g.maxStreak}** times in a row.`)]});}
            if(sub==='expressions'){g.allowExpressions=options.getBoolean('enabled');saveGuild(gid,g);return interaction.editReply({embeds:[E('#5865F2',`Expressions ${g.allowExpressions?'enabled':'disabled'}`).setDescription(g.allowExpressions?'Expressions like `1+1`, `pi^2` are now allowed.':'Only plain numbers accepted.')]});}
            if(sub==='anticheat'){g.antiCheat=options.getBoolean('enabled');saveGuild(gid,g);return interaction.editReply({embeds:[E('#5865F2',`Anti-cheat ${g.antiCheat?'enabled':'disabled'}`).setDescription(g.antiCheat?'If someone edits or deletes the latest count, the bot calls it out and says where the count stands.':'Edited and deleted counts are ignored.')]});}
            if(sub==='players'){g.playerCount=options.getBoolean('enabled');saveGuild(gid,g);return interaction.editReply({embeds:[E('#5865F2',`Player counting ${g.playerCount?'enabled':'disabled'}`).setDescription(g.playerCount?'Typing a football player\'s name counts as their EA FC overall rating. Add a game with `:fc25`, or leave it off for the latest one.':'Player names are ignored again.')]});}
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

function register(){ client.on('interactionCreate',onInteraction); }

module.exports = { register };

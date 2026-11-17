const { PermissionFlagsBits } = require('discord.js');
const client = require('../client');
const { MAX_SAVES, FLOOR_SIZE, NE, usesSaves } = require('../config');
const { claimMessage, updateUserStat } = require('../db');
const { chanCache, loadedGuilds, flags, loadGuild, getGuild, saveGuild, saveChan, countingIdFor, showCur } = require('../state');
const { pickModifier, getModifier, expectedNext, nextText } = require('../modes');
const { CONSTS } = require('../math');
const { read, valueFor } = require('../input');
const { E } = require('../ui');
const { triggerRuin, earnsSave, nextSaveAt } = require('../ruin');
const fc = require('../fc');
const games = require('../gameshook');
const v2 = require('../v2');
const v2c = v2.convert;

async function handleCount(message){
    if(message.author.bot||!message.guild)return;
    const gid=message.guild.id,chan=message.channel;
    const cid=chan.isThread()?chan.parentId:chan.id;   // threads count towards their parent channel
    if(!cid)return;
    if(!flags.fullyLoaded&&!loadedGuilds.has(gid))await loadGuild(gid);
    const c=chanCache.get(cid);
    if(!c)return;
    const g=await getGuild(gid);
    if(c.pendingSave){if(Date.now()<c.pendingSave.expiresAt)return;delete c.pendingSave;saveChan(c);}
    const raw=message.content.trim();

    // What the message is: a number, an expression, a player name, players inside an expression, or an equation to solve for x (see input.js).
    const r=await read(raw,g);
    if(r.skip){if(r.skip==='react')message.react('\u2753').catch(()=>{});return;}   // unknown player: never ruins the count
    const player=r.player;
    const via=player?` (${player.name}, ${fc.gameLabel(player.game)})`:r.inline?` (${r.inline.players.map(p=>`${p.name} ${p.ovr}`).join(', ')})`:r.isEq?' (solved from an equation)':'';
    const playerNote=async()=>{
        if(!player&&!r.inline)return;
        await message.react('\u26bd').catch(()=>{});
        const lines=(player?[player]:r.inline.players).map(p=>`\u26bd **${p.name}** (${fc.gameLabel(p.game)}) \u2192 **${p.ovr}**`);
        message.reply({content:lines.join('\n'),allowedMentions:{repliedUser:false}}).catch(()=>{});
    };

    // Looks-like-an-expression checks run on the text with players shown as plain numbers, so the brackets added around them don't count.
    const probe=r.inline?r.inline.plain:raw;
    const hasConst=Object.keys(CONSTS).some(k=>new RegExp(`(?<![a-z])${k}(?![a-z])`,'i').test(probe));
    const hasFancyOp=/[\u00d7\u00b7\u00f7\u00b2\u00b3\u00b9\u2070\u2074\u2075\u2076\u2077\u2078\u2079\u207a\u207b\u221a\u221b\u221c]/.test(probe)||/\d[xX]\d/.test(probe);
    let value=r.value;
    const isExpr=!player&&(r.isEq||(/[+\-*/^()!|]/.test(probe)&&!/^\-?\d+$/.test(probe))||hasConst||hasFancyOp||(r.inline&&value!==null));
    const type=c.countType;

    if(type==='simple'){
        const expected=c.current+1,sameUser=message.author.id===c.lastUserId;
        if(r.isEq&&g.allowEquations!==false)value=valueFor(r,expected);   // the number the equation solves to, when it is a usable one (equations switched off: it stays unusable and is deleted)
        const newStreak=sameUser?c.consecutiveCount+1:1,streakViolation=g.maxStreak>0&&sameUser&&newStreak>g.maxStreak;
        if(!(value!==null||isExpr))return;
        if(value===null||value!==expected||streakViolation){const me=message.guild.members.me;if(!me?.permissionsIn(message.channel).has(PermissionFlagsBits.ManageMessages))return;await message.delete().catch(()=>{});return;}
        c.current=value;c.lastUserId=message.author.id;c.consecutiveCount=newStreak;c.lastMessageId=message.id;
        if(value>c.highScore)c.highScore=value;saveChan(c);updateUserStat(gid,message.author.id,{correct:1});
        await message.react(value<=9?NE[value]:'\u2705').catch(()=>{});
        await playerNote();
        if(value%100===0)await message.channel.send(v2c({embeds:[E('#00cc88',`\u{1F389} ${value} reached!`).setDescription(`The count hit **${value}** thanks to <@${message.author.id}>!`)]})).catch(()=>{});
        return;
    }

    // interactive / countdown / modifiers / floors
    if(isExpr&&!g.allowExpressions){await message.react('\u274c').catch(()=>{});const s=await message.channel.send(v2c({embeds:[E('#ff4444','Expressions disabled').setDescription(`\`${raw}\` \u2014 expressions not allowed here!`)]})).catch(()=>null);if(s)setTimeout(()=>s.delete().catch(()=>{}),5000);return;}
    if(r.isEq&&r.eq&&g.allowEquations===false){await message.react('\u274c').catch(()=>{});const s=await message.channel.send(v2c({embeds:[E('#ff4444','Equations disabled').setDescription(`\`${raw}\` \u2014 equations not allowed here!`)]})).catch(()=>null);if(s)setTimeout(()=>s.delete().catch(()=>{}),5000);return;}
    if(r.isEq?!r.eq:value===null)return;   // not a number, or an equation with no x: just chatter
    if(type==='countdown'&&(c.current<=0||c.current>c.countdownStart+1))c.current=c.countdownStart+1;
    if(type==='modifiers'&&!c.modifier){const mod=pickModifier();c.modifier=mod.id;c.modifierLabel=mod.label;saveChan(c);await message.channel.send(v2c({embeds:[E('#9b59b6','\u{1F3B2} New Modifier!').setDescription(`The modifier for this round is:\n**${mod.label}**\n${mod.desc}`)]})).catch(()=>{});}
    const expected=expectedNext(c);
    if(r.isEq){
        const s=r.eq.solve(expected);
        if(s.status!=='ok'&&s.status!=='wrong'){message.react('\u2753').catch(()=>{});return;}   // an identity like x=x, or no whole-number solution: not a count, not a fail
        value=s.value;
    }
    if(value!==expected){
        if(!await claimMessage(message.id))return;
        message.react('\u274c').catch(()=>{});
        const reason=type==='modifiers'?`sent \`${value}\`${via} \u2014 not the next valid number for **${c.modifierLabel}**`:`sent \`${value}\`${via} but expected \`${expected}\``;
        await triggerRuin(message.channel,g,c,message.author.id,reason);
        return;
    }
    if(g.maxStreak>0&&message.author.id===c.lastUserId&&c.consecutiveCount>=g.maxStreak){
        if(!await claimMessage(message.id))return;
        message.react('\u274c').catch(()=>{});
        await triggerRuin(message.channel,g,c,message.author.id,`counted more than **${g.maxStreak}** time(s) in a row`);
        return;
    }
    const same=message.author.id===c.lastUserId;
    c.current=value;c.lastUserId=message.author.id;c.consecutiveCount=same?c.consecutiveCount+1:1;c.lastMessageId=message.id;
    if(type!=='countdown'&&value>c.highScore)c.highScore=value;
    if(type==='floors'&&value%FLOOR_SIZE===0&&value>c.checkpoint)c.checkpoint=value;
    saveChan(c);updateUserStat(gid,message.author.id,{correct:1});
    // Saves are earned at every milestone hit; the server can hold at most MAX_SAVES.
    if(usesSaves(type)&&earnsSave(value)){
        if((g.saves??0)>=MAX_SAVES){await message.channel.send(v2c({embeds:[v2.card({title:'Saves Full',blocks:[`Milestone ${value} reached, but the server is already holding the maximum of ${MAX_SAVES} saves.`,'Use one to make room for the next.']})]})).catch(()=>{});}
        else{g.saves=(g.saves??0)+1;saveGuild(gid,g);await message.channel.send(v2c({embeds:[v2.card({title:'Save Earned!',blocks:[`The server earned a Save for reaching ${value}!\nThe server now has ${g.saves}/${MAX_SAVES} save(s).`,`Next save at ${nextSaveAt(value)}.`]})]})).catch(()=>{});}
    }
    await message.react(type==='modifiers'?'\u2705':(value<=9&&value>=0?NE[value]:'\u2705')).catch(()=>{});
    await playerNote();

    if(type==='countdown'){
        const start=c.countdownStart;
        if(value===1){
            c.countdownCycles=(c.countdownCycles??0)+1;c.current=start+1;c.lastUserId=null;c.consecutiveCount=0;c.lastMessageId=null;saveChan(c);
            await message.channel.send(v2c({embeds:[E('#ffd700',`\u{1F389} Countdown Complete! Cycle #${c.countdownCycles}`).setDescription(`The count reached **1**! \u{1F38A} Incredible work, <@${message.author.id}> finished it off!\nThe countdown resets to **${start}**. Let's go again!`).addFields({name:'\u{1F504} Cycles completed',value:`**${c.countdownCycles}**`,inline:true},{name:'\u{1F522} Restarting from',value:`**${start}**`,inline:true}).setFooter({text:'Can you do it again?'})]})).catch(()=>{});
        }else if(value%25===0){
            await message.channel.send(v2c({embeds:[E('#00cc88',`\u23f3 ${value} to go!`).setDescription(`Getting closer! **${value}** left to count down.`)]})).catch(()=>{});
        }
    }else if(type==='modifiers'){
        const mod=getModifier(c.modifier);
        if(value%10===0||value<=5)await message.channel.send(v2c({embeds:[E('#9b59b6',`\u{1F3B2} ${value}!`).setDescription(`Category: **${mod.label}**`)]})).catch(()=>{});
        if(value%100===0)await message.channel.send(v2c({embeds:[E('#00cc88',`\u{1F389} ${value} reached!`).setDescription(`The count hit **${value}** thanks to <@${message.author.id}>! \u{1F3B2} Modifier: ${mod.label}`).setFooter({text:`High score: ${c.highScore}`})]})).catch(()=>{});
    }else if(type==='floors'){
        if(value%FLOOR_SIZE===0)await message.channel.send(v2c({embeds:[E('#00cc88',`\u{1F3E2} Floor ${value/FLOOR_SIZE} cleared!`).setDescription(`The count hit **${value}** thanks to <@${message.author.id}>!\nCheckpoint saved \u2014 if the count is ruined it drops back to **${c.checkpoint}** instead of 0.`).setFooter({text:`High score: ${c.highScore}`})]})).catch(()=>{});
    }else{
        if(value%100===0)await message.channel.send(v2c({embeds:[E('#00cc88',`\u{1F389} ${value} reached!`).setDescription(`The count hit **${value}** thanks to <@${message.author.id}>!`).setFooter({text:`High score: ${c.highScore}`})]})).catch(()=>{});
    }
}

// ---------- anti-cheat (always on): call out edited / deleted counts ----------
function cheatEmbed(kind,c){
    const edited=kind==='edit';
    return E('#ff9900',edited?'\u270f\ufe0f Number edited!':'\u{1F5D1}\ufe0f Number deleted!').setDescription(`<@${c.lastUserId}> ${edited?'edited':'deleted'} their number!\nThe last number was **${showCur(c)}**.\n${nextText(c)}`);
}
async function cheatCheck(channelId,messageId,kind,newMessage){
    const cid=countingIdFor(channelId),c=chanCache.get(cid);
    if(!c||!c.lastMessageId||c.lastMessageId!==messageId)return;
    const g=await getGuild(c.guildId);
    if(kind==='edit'){
        let m=newMessage;
        if(m.partial)m=await m.fetch().catch(()=>null);
        if(!m||m.content==null)return;
        const txt=m.content.trim();
        // same reading as a live count: numbers, expressions, player names (a rating, not text), equations solved against the current count
        const rd=await read(txt,g);
        const v=rd.skip?null:valueFor(rd,c.current);
        if(v===c.current)return;   // same value (embed update, reformatting) - not a real edit
    }
    c.lastMessageId=null;saveChan(c);
    const ch=client.channels.cache.get(channelId);
    if(ch?.isTextBased?.())ch.send(v2c({embeds:[cheatEmbed(kind,c)]})).catch(()=>{});
}

function register(){
    client.on('messageCreate',async message=>{
        try{if(games&&await games.handleMessage(message))return;await handleCount(message);}catch(e){console.error('messageCreate:',e.message);}
    });
    client.on('messageUpdate',(oldM,newM)=>{
        if(!newM.guildId||newM.author?.bot)return;
        cheatCheck(newM.channelId,newM.id,'edit',newM).catch(e=>console.error('cheat edit:',e.message));
    });
    client.on('messageDelete',msg=>{
        if(!msg.guildId)return;
        cheatCheck(msg.channelId,msg.id,'delete').catch(e=>console.error('cheat delete:',e.message));
    });
}

module.exports = { register, handleCount };

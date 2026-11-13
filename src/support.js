const { PermissionFlagsBits } = require('discord.js');
const { pool } = require('./db');
const { SUPPORT_URL } = require('./config');
const { E } = require('./ui');

async function hasAnnouncedSupport(gid){try{const r=await pool.query('SELECT 1 FROM support_announced WHERE guild_id=$1',[gid]);return r.rowCount>0;}catch{return true;}}
function markSupportAnnounced(gid){pool.query('INSERT INTO support_announced (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING',[gid]).catch(()=>{});}
function pickAdminChannel(guild){
    const text=guild.channels.cache.filter(c=>c.isTextBased&&c.isTextBased()&&c.viewable);
    const botMember=guild.members.me;
    const canSend=ch=>botMember&&ch.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages);
    const adminOnly=text.filter(ch=>{
        if(!canSend(ch))return false;
        const everyone=guild.roles.everyone;
        const everyonePerms=ch.permissionsFor(everyone);
        return everyonePerms&&!everyonePerms.has(PermissionFlagsBits.ViewChannel);
    });
    const nameMatch=ch=>/admin|staff|mod|owner|management/i.test(ch.name);
    return adminOnly.find(nameMatch)??adminOnly.first()??text.filter(canSend).find(nameMatch)??guild.systemChannel??text.filter(canSend).first()??null;
}
async function announceSupportServer(guild){
    if(await hasAnnouncedSupport(guild.id))return;
    const ch=pickAdminChannel(guild);
    if(ch){await ch.send({embeds:[E('#5865F2','\u{1F44B} Thanks for adding Counting Bot!').setDescription(`Need help, want to report a bug, or have a feature request?\nJoin the support server: ${SUPPORT_URL}`)]}).catch(()=>{});}
    markSupportAnnounced(guild.id);
}

module.exports = { announceSupportServer };

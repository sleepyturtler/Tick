require('dns').setDefaultResultOrder('ipv4first');
const http = require('http');
const { ActivityType } = require('discord.js');
const client = require('./client');
const { pool, initDB } = require('./db');
const { guildCache, chanCache, flags, normGuild, normChan, indexChan, removeCountingChannel } = require('./state');
const { restoreFailRoles } = require('./failroles');
const { loadMissingRatings } = require('./fcload');
const { announceSupportServer } = require('./support');
const { buildCommands } = require('./commands');
const messages = require('./handlers/messages');
const interactions = require('./handlers/interactions');

function keepAlive(){const ping=()=>{const u=process.env.RENDER_EXTERNAL_URL||`http://localhost:${process.env.PORT||3000}`;(u.startsWith('https')?require('https'):http).get(u,()=>{}).on('error',()=>{});};setTimeout(ping,5000);setInterval(ping,14*60*1000);}

client.once('ready',async()=>{
    console.log(`Online as ${client.user.tag}`);
    client.user.setPresence({activities:[{name:'Counting things',type:ActivityType.Watching}],status:'online'});
    await client.application.commands.set(buildCommands());console.log('Commands registered');
    try{
        await initDB();
        const [gr,cr]=await Promise.all([pool.query('SELECT guild_id,data FROM counting'),pool.query('SELECT guild_id,channel_id,data FROM counting_channels')]);
        for(const r of gr.rows)guildCache.set(r.guild_id,normGuild(r.data));
        for(const r of cr.rows)indexChan(normChan({...r.data,guildId:r.guild_id,channelId:r.channel_id}));
        flags.fullyLoaded=true;
        console.log(`Loaded ${cr.rows.length} counting channel(s) across ${gr.rows.length} guild(s)`);
        await restoreFailRoles();
        // Background: loads any ratings game from sql/ that the database doesn't have yet. Lookups for it find nothing until it finishes.
        loadMissingRatings().then(n=>{if(n)console.log(`Ratings import done (${n} game(s))`);}).catch(e=>console.error('ratings import:',e.message));
    }catch(e){console.error('DB init failed:',e.message);}
    keepAlive();
    for(const guild of client.guilds.cache.values()){await announceSupportServer(guild).catch(()=>{});}
});

client.on('guildCreate',guild=>{announceSupportServer(guild).catch(()=>{});});
// Make sure the bot is in new threads created inside counting channels so it receives their messages.
client.on('threadCreate',thread=>{if(chanCache.has(thread.parentId)&&thread.joinable)thread.join().catch(()=>{});});
client.on('channelDelete',ch=>{if(ch.guildId&&chanCache.has(ch.id))removeCountingChannel(ch.guildId,ch.id).catch(()=>{});});

messages.register();
interactions.register();

process.on('unhandledRejection',e=>console.error(e));
client.on('error',e=>console.error('Discord error:',e));
client.login(process.env.DISCORD_TOKEN);

const PORT=process.env.PORT||3000;
http.createServer((req,res)=>{const ok=req.url==='/'||req.url==='/health';res.writeHead(ok?200:404,{'Content-Type':'text/plain'});res.end(ok?'Tick is running!':'Not found');}).listen(PORT,()=>console.log(`HTTP on port ${PORT}`));

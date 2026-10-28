const { Client, GatewayIntentBits, Partials, SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, EmbedBuilder, ActivityType, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, StringSelectMenuBuilder, ChannelType } = require('discord.js');
const { Pool } = require('pg');
require('dns').setDefaultResultOrder('ipv4first');
const http = require('http');

// Partials.Message lets the anti-cheat see edits/deletes of messages that are no longer cached.
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Message] });

const envInt = (name, def) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n > 0 ? n : def; };
// DB limits are configurable so slow/spiky databases can be tuned without a code change.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    statement_timeout: envInt('DB_STATEMENT_TIMEOUT_MS', 8000),
    connectionTimeoutMillis: envInt('DB_CONNECTION_TIMEOUT_MS', 5000),
    idleTimeoutMillis: envInt('DB_IDLE_TIMEOUT_MS', 600000),
    max: envInt('DB_POOL_MAX', 3),
});
// An unhandled 'error' on the pool (e.g. an idle connection dropping) would otherwise crash the process.
pool.on('error', e => console.error('pg pool error:', e.message));

const PS = 25, SLB_MAX = 100;
const COUNTDOWN_START = 100, FLOOR_SIZE = 100;
const MAX_COUNTING_CHANNELS = envInt('MAX_COUNTING_CHANNELS', 10);
const MAX_SAVES = envInt('MAX_SAVES', 5);
const MODES = ['interactive', 'simple', 'countdown', 'modifiers', 'floors'];
const safeMode = m => MODES.includes(m) ? m : null;
const usesSaves = t => t === 'interactive' || t === 'modifiers' || t === 'floors';

const LEGACY_GUILD_KEYS = ['channelId', 'current', 'lastUserId', 'consecutiveCount', 'highScore', 'countType', 'countdownCycles', 'countdownStart', 'randomModifier', 'randomModifierLabel', 'pendingSave'];

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS counting   (guild_id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS counting_channels (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, data JSONB NOT NULL DEFAULT '{}', PRIMARY KEY (guild_id, channel_id));
        CREATE INDEX IF NOT EXISTS counting_channels_channel ON counting_channels(channel_id);
        CREATE TABLE IF NOT EXISTS user_stats (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, data JSONB NOT NULL DEFAULT '{}', PRIMARY KEY (guild_id, user_id));
        CREATE INDEX IF NOT EXISTS user_stats_user ON user_stats(user_id);
        CREATE TABLE IF NOT EXISTS dedup (message_id TEXT PRIMARY KEY, claimed_at TIMESTAMPTZ DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS support_announced (guild_id TEXT PRIMARY KEY, announced_at TIMESTAMPTZ DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS fail_roles (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, role_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (guild_id, user_id));
    `);
    await migrateLegacyChannels();
    cleanupDedup();
    setInterval(cleanupDedup, 10 * 60 * 1000).unref();
}
const cleanupDedup = () => pool.query(`DELETE FROM dedup WHERE claimed_at < NOW() - INTERVAL '5 minutes'`).catch(() => {});
async function claimMessage(mid) {
    try { const r = await pool.query('INSERT INTO dedup (message_id) VALUES ($1) ON CONFLICT (message_id) DO NOTHING RETURNING message_id', [mid]); return r.rowCount > 0; }
    catch { return true; }
}

// One-time move of the old single-channel-per-server layout into the counting_channels table.
async function migrateLegacyChannels() {
    const r = await pool.query('SELECT guild_id, data FROM counting');
    for (const { guild_id: gid, data: d } of r.rows) {
        if (d.migratedToChannels) continue;
        const cl = await pool.connect();
        try {
            await cl.query('BEGIN');
            if (d.channelId) {
                const type = d.countType === 'random' ? 'modifiers' : (safeMode(d.countType) ?? 'interactive');
                const start = d.countdownStart ?? COUNTDOWN_START;
                const c = { guildId: gid, channelId: d.channelId, countType: type, current: d.current ?? 0, lastUserId: d.lastUserId ?? null, consecutiveCount: d.consecutiveCount ?? 0, lastMessageId: null, highScore: d.highScore ?? 0, countdownCycles: d.countdownCycles ?? 0, countdownStart: start, modifier: d.randomModifier ?? null, modifierLabel: d.randomModifierLabel ?? null, checkpoint: 0 };
                // Old countdowns parked at 100 after a reset and then demanded 99. "Nothing counted yet" is now start+1.
                if (type === 'countdown' && (!c.current || c.current >= start)) c.current = start + 1;
                await cl.query('INSERT INTO counting_channels (guild_id, channel_id, data) VALUES ($1,$2,$3) ON CONFLICT (guild_id, channel_id) DO NOTHING', [gid, d.channelId, c]);
            }
            const g = { ...d };
            for (const k of LEGACY_GUILD_KEYS) delete g[k];
            g.migratedToChannels = true;
            await cl.query('UPDATE counting SET data=$2 WHERE guild_id=$1', [gid, g]);
            await cl.query('COMMIT');
        } catch (e) {
            await cl.query('ROLLBACK').catch(() => {});
            console.error(`migrate ${gid}:`, e.message);
        } finally { cl.release(); }
    }
}

// ---------- state ----------
// Guild settings (shared by every counting channel in the server) live in `counting`.
// Each counting channel has its own row in `counting_channels` with its own mode and count.
const guildCache = new Map(), chanCache = new Map(), guildChans = new Map(), loadedGuilds = new Set();
let fullyLoaded = false;

function defaultGuild() {
    return { maxStreak: 1, allowExpressions: true, accessRoleId: null, saves: 0, savesUsed: 0, failRoleId: null, failRoleMinutes: 10, antiCheat: true, migratedToChannels: true };
}
function defaultChannel(gid, cid, type = 'interactive') {
    const c = { guildId: gid, channelId: cid, countType: type, current: 0, lastUserId: null, consecutiveCount: 0, lastMessageId: null, highScore: 0, countdownCycles: 0, countdownStart: COUNTDOWN_START, modifier: null, modifierLabel: null, checkpoint: 0 };
    resetChannel(c, true);
    return c;
}
const normGuild = d => ({ ...defaultGuild(), ...(d || {}) });
function normChan(d) {
    const c = { ...defaultChannel(d.guildId, d.channelId), ...d };
    if (c.countType === 'random') c.countType = 'modifiers';
    if (!safeMode(c.countType)) c.countType = 'interactive';
    // Channels from before milestone tracking: treat everything up to the high score as already paid out.
    if (c.savesAwardedUpTo == null) c.savesAwardedUpTo = c.highScore || 0;
    return c;
}
function indexChan(c) {
    chanCache.set(c.channelId, c);
    if (!guildChans.has(c.guildId)) guildChans.set(c.guildId, new Set());
    guildChans.get(c.guildId).add(c.channelId);
}
function unindexChan(c) { chanCache.delete(c.channelId); guildChans.get(c.guildId)?.delete(c.channelId); }
const channelsOf = gid => [...(guildChans.get(gid) ?? [])].map(id => chanCache.get(id)).filter(Boolean);

async function loadGuild(gid) {
    if (fullyLoaded || loadedGuilds.has(gid)) return;
    const [g, ch] = await Promise.all([
        pool.query('SELECT data FROM counting WHERE guild_id=$1', [gid]),
        pool.query('SELECT channel_id, data FROM counting_channels WHERE guild_id=$1', [gid]),
    ]);
    if (!guildCache.has(gid)) guildCache.set(gid, normGuild(g.rows[0]?.data));
    for (const r of ch.rows) if (!chanCache.has(r.channel_id)) indexChan(normChan({ ...r.data, guildId: gid, channelId: r.channel_id }));
    loadedGuilds.add(gid);
}
async function getGuild(gid) {
    if (!guildCache.has(gid)) {
        await loadGuild(gid);
        if (!guildCache.has(gid)) guildCache.set(gid, defaultGuild());
    }
    return guildCache.get(gid);
}
function saveGuild(gid, data) {
    guildCache.set(gid, data);
    pool.query('INSERT INTO counting (guild_id,data) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET data=$2', [gid, data]).catch(e => console.error('saveGuild:', e.message));
}
function saveChan(c) {
    pool.query('INSERT INTO counting_channels (guild_id,channel_id,data) VALUES ($1,$2,$3) ON CONFLICT (guild_id,channel_id) DO UPDATE SET data=$3', [c.guildId, c.channelId, c]).catch(e => console.error('saveChan:', e.message));
}
async function removeCountingChannel(gid, cid) {
    const c = chanCache.get(cid);
    if (!c || c.guildId !== gid) return false;
    unindexChan(c);
    await pool.query('DELETE FROM counting_channels WHERE guild_id=$1 AND channel_id=$2', [gid, cid]).catch(e => console.error('removeCountingChannel:', e.message));
    return true;
}

async function updateUserStat(gid, uid, delta) {
    try {
        const r = await pool.query('SELECT data FROM user_stats WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
        const cur = r.rows[0]?.data ?? { correct: 0, ruined: 0, saves: 0, savesUsed: 0 };
        for (const [k, v] of Object.entries(delta)) cur[k] = (cur[k] || 0) + v;
        await pool.query('INSERT INTO user_stats (guild_id,user_id,data) VALUES ($1,$2,$3) ON CONFLICT (guild_id,user_id) DO UPDATE SET data=$3', [gid, uid, cur]);
        return cur;
    } catch (e) { console.error('updateUserStat:', e.message); return null; }
}
async function getUserStats(gid, uid) {
    const r = await pool.query('SELECT data FROM user_stats WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
    return r.rows[0]?.data ?? { correct: 0, ruined: 0, saves: 0, savesUsed: 0 };
}
async function getUserRank(gid, uid) {
    const r = await pool.query(`SELECT COUNT(*)+1 AS rank FROM user_stats WHERE guild_id=$1 AND COALESCE((data->>'correct')::int,0) > COALESCE((SELECT (data->>'correct')::int FROM user_stats WHERE guild_id=$1 AND user_id=$2),0)`, [gid, uid]);
    return parseInt(r.rows[0]?.rank ?? 1);
}
async function getServerStats(gid) {
    const r = await pool.query(`SELECT COUNT(*) AS tu, SUM(COALESCE((data->>'correct')::int,0)) AS tc, SUM(COALESCE((data->>'ruined')::int,0)) AS tr FROM user_stats WHERE guild_id=$1`, [gid]);
    return r.rows[0] ?? {};
}
async function getServerLbPage(gid, page) {
    const off = Math.min((page-1)*PS, SLB_MAX-PS);
    const [rows, tot] = await Promise.all([
        pool.query(`SELECT user_id,data FROM user_stats WHERE guild_id=$1 ORDER BY COALESCE((data->>'correct')::int,0) DESC LIMIT $2 OFFSET $3`, [gid, PS, off]),
        pool.query(`SELECT LEAST(COUNT(*), $2) AS cnt FROM user_stats WHERE guild_id=$1`, [gid, SLB_MAX]),
    ]);
    return { rows: rows.rows, total: parseInt(tot.rows[0].cnt) };
}
async function getGlobalUsersPage(page) {
    const off = (page-1)*PS;
    const [rows, tot] = await Promise.all([
        pool.query(`SELECT user_id, SUM(COALESCE((data->>'correct')::int,0)) AS correct, SUM(COALESCE((data->>'ruined')::int,0)) AS ruined FROM user_stats GROUP BY user_id ORDER BY correct DESC LIMIT $1 OFFSET $2`, [PS, off]),
        pool.query(`SELECT COUNT(DISTINCT user_id) AS cnt FROM user_stats`),
    ]);
    return { rows: rows.rows, total: parseInt(tot.rows[0].cnt) };
}

const whereMode = i => `WHERE COALESCE(data->>'countType','interactive')=$${i}`;
async function getGlobalServersPage(page, filter) {
    const off = (page - 1) * PS, mode = safeMode(filter);
    const orderExpr = mode === 'countdown' ? `COALESCE((data->>'countdownCycles')::int,0)` : `COALESCE((data->>'current')::int,0)`;
    const [rows, tot] = await Promise.all([
        pool.query(`SELECT guild_id, channel_id, COALESCE((data->>'current')::int,0) AS cur, COALESCE((data->>'highScore')::int,0) AS hs, COALESCE((data->>'countdownCycles')::int,0) AS cycles, COALESCE(data->>'countType','interactive') AS mode FROM counting_channels ${mode ? whereMode(3) : ''} ORDER BY ${orderExpr} DESC LIMIT $1 OFFSET $2`, mode ? [PS, off, mode] : [PS, off]),
        pool.query(`SELECT COUNT(*) AS cnt FROM counting_channels ${mode ? whereMode(1) : ''}`, mode ? [mode] : []),
    ]);
    return { rows: rows.rows, total: parseInt(tot.rows[0].cnt) };
}
async function getHighscoresPage(page, filter) {
    const off = (page - 1) * PS, mode = safeMode(filter) ?? 'interactive';
    const scoreExpr = mode === 'countdown' ? `COALESCE((data->>'countdownCycles')::int,0)` : `COALESCE((data->>'highScore')::int,0)`;
    const [rows, tot] = await Promise.all([
        pool.query(`SELECT guild_id, channel_id, ${scoreExpr} AS score, COALESCE((data->>'current')::int,0) AS cur FROM counting_channels ${whereMode(3)} ORDER BY score DESC LIMIT $1 OFFSET $2`, [PS, off, mode]),
        pool.query(`SELECT COUNT(*) AS cnt FROM counting_channels ${whereMode(1)}`, [mode]),
    ]);
    return { rows: rows.rows, total: parseInt(tot.rows[0].cnt) };
}

const M = ['🥇','🥈','🥉'];
const E = (color, title) => new EmbedBuilder().setColor(color).setTitle(title);
const ep = () => ({ flags: [MessageFlags.Ephemeral] });
const MODE_EMOJI = { interactive:'🎮', simple:'🟢', countdown:'⏳', modifiers:'🎲', floors:'🏢' };
const MODE_LABEL = { interactive:'Interactive', simple:'Simple', countdown:'Countdown', modifiers:'Modifiers', floors:'Floors' };
const MODE_CHOICES = MODES.map(m => ({ name: MODE_LABEL[m], value: m }));
const COUNTING_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum];
const NE = ['0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];

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
async function hasPerm(interaction, gid) {
    if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const g = await getGuild(gid);
    return g.accessRoleId ? interaction.member.roles.cache.has(g.accessRoleId) : false;
}

// ---------- channel helpers ----------
const chanName = cid => client.channels.cache.get(cid)?.name;
const countingIdFor = channelId => { const ch = client.channels.cache.get(channelId); return ch?.isThread?.() ? ch.parentId : channelId; };
const isFresh = c => c.countType === 'countdown' && c.current > c.countdownStart;
const showCur = c => isFresh(c) ? `starts at ${c.countdownStart}` : `${c.current}`;
function channelLine(c) {
    const parts = [`${MODE_EMOJI[c.countType]} <#${c.channelId}> — **${showCur(c)}**`];
    parts.push(c.countType === 'countdown' ? `${c.countdownCycles ?? 0} cycles` : `high ${c.highScore}`);
    if (c.countType === 'modifiers' && c.modifierLabel) parts.push(c.modifierLabel);
    if (c.countType === 'floors') parts.push(`checkpoint ${c.checkpoint}`);
    return parts.join(' · ');
}
// Pick which counting channel a command is about: the option, else the channel it was run in, else the only one.
function resolveCounting(interaction, opt) {
    const gid = interaction.guild.id, list = channelsOf(gid);
    let cid = opt ? (opt.isThread?.() ? opt.parentId : opt.id) : null;
    if (!cid) {
        const here = interaction.channel?.isThread?.() ? interaction.channel.parentId : interaction.channelId;
        if (chanCache.has(here)) cid = here; else if (list.length === 1) cid = list[0].channelId;
    }
    const c = cid ? chanCache.get(cid) : null;
    if (c && c.guildId === gid) return { c };
    if (opt) return { error: `${opt} isn't a counting channel. Add it with \`/config channel\` first.` };
    if (!list.length) return { error: 'No counting channel set up yet. Use `/config channel` or `/setup`.' };
    return { error: 'You have more than one counting channel. Pick one with the `channel` option, or run this command inside it.' };
}

// ---------- modifiers ----------
const MODIFIERS = [
    { id:'every2',      label:'\u23e9 Count every 2nd number', desc:'Skip every other number! Only even numbers count.',            check:n=>n%2===0, next:n=>n+2 },
    { id:'every3',      label:'\u23e9 Count every 3rd number', desc:'Only multiples of 3!',                                         check:n=>n%3===0, next:n=>n+3 },
    { id:'primes',      label:'\u{1F522} Primes only',         desc:'Only prime numbers are valid!',                                check:isPrime,    next:nextPrime },
    { id:'fibonacci',   label:'\u{1F300} Fibonacci sequence',  desc:'Follow the Fibonacci sequence: 1, 1, 2, 3, 5, 8, 13\u2026',   check:isFibonacci,next:nextFibonacci },
    { id:'squares',     label:'\u{1F7E5} Perfect squares',     desc:'Only perfect squares! 1, 4, 9, 16, 25\u2026',                  check:n=>{const s=Math.round(Math.sqrt(n));return s*s===n;}, next:n=>{const s=Math.round(Math.sqrt(n));return(s+1)*(s+1);} },
    { id:'palindromes', label:'\u{1F504} Palindrome numbers',  desc:'Only numbers that read the same forwards and backwards!',     check:isPalindrome, next:nextPalindrome },
    { id:'lucky7',      label:'\u{1F340} Multiples of 7',      desc:'Lucky sevens! Only multiples of 7.',                           check:n=>n%7===0, next:n=>n+7 },
    { id:'triangular',  label:'\u{1F53A} Triangular numbers',  desc:'Only triangular numbers! 1, 3, 6, 10, 15, 21\u2026',          check:isTriangular, next:nextTriangular },
];
function isPrime(n) { if(n<2)return false;if(n===2)return true;if(n%2===0)return false;for(let i=3;i<=Math.sqrt(n);i+=2)if(n%i===0)return false;return true; }
function nextPrime(n) { let m=n+1;while(!isPrime(m))m++;return m; }
function isFibonacci(n) { const sq=x=>{const s=Math.round(Math.sqrt(x));return s*s===x;};return sq(5*n*n+4)||sq(5*n*n-4); }
function nextFibonacci(n) { let a=1,b=1;while(b<=n){const c=a+b;a=b;b=c;}return b; }
function isTriangular(n) { const x=(Math.sqrt(8*n+1)-1)/2;return Math.abs(x-Math.round(x))<1e-9; }
function nextTriangular(n) { let t=1,k=1;while(t<=n){k++;t=k*(k+1)/2;}return t; }
function isPalindrome(n) { const s=String(n);return s===s.split('').reverse().join(''); }
function nextPalindrome(n) { let m=n+1;while(!isPalindrome(m))m++;return m; }
function pickModifier() { return MODIFIERS[Math.floor(Math.random()*MODIFIERS.length)]; }
function getModifier(id) { return MODIFIERS.find(m=>m.id===id)??MODIFIERS[0]; }
function firstValidForModifier(modId) { const mod=getModifier(modId);let n=1;while(!mod.check(n))n++;return n; }

// The number the channel wants next. Countdown uses start+1 as "nothing counted yet", so the first number is 100, not 99.
function expectedNext(c) {
    if (c.countType === 'countdown') return c.current - 1;
    if (c.countType === 'modifiers') return c.current === 0 ? firstValidForModifier(c.modifier) : getModifier(c.modifier).next(c.current);
    return c.current + 1;
}
// What we tell players about "what's next". Modifiers only ever name the category, never the number.
const nextText = c => c.countType === 'modifiers' ? `Modifier: **${c.modifierLabel ?? 'none'}**` : `Next number: **${expectedNext(c)}**`;

function modeIntro(c) {
    switch (c.countType) {
        case 'simple': return 'Wrong messages are silently deleted and the count never resets. Start from **1**!';
        case 'countdown': return `Count **down** from **${c.countdownStart}** to **1**. Start with **${c.countdownStart}**!`;
        case 'modifiers': return `A modifier decides which numbers are valid \u2014 work out the pattern!\nModifier: **${c.modifierLabel}**\n${getModifier(c.modifier).desc}`;
        case 'floors': return `Count up! Every **${FLOOR_SIZE}** is a floor checkpoint \u2014 if the count is ruined you drop back to your highest checkpoint instead of 0. Start from **1**!`;
        default: return 'Wrong numbers and streaks reset the count to 0. Start from **1**!';
    }
}
function resetChannel(c, full = false) {
    if (full) c.checkpoint = 0;
    if (c.countType === 'countdown') c.current = c.countdownStart + 1;
    else if (c.countType === 'modifiers') { const m = pickModifier(); c.modifier = m.id; c.modifierLabel = m.label; c.current = 0; }
    else if (c.countType === 'floors') c.current = c.checkpoint || 0;
    else c.current = 0;
    c.lastUserId = null; c.consecutiveCount = 0; c.lastMessageId = null; delete c.pendingSave;
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
function pickerRow(gid,purpose){
    const opts=channelsOf(gid).slice(0,25).map(c=>({label:`#${chanName(c.channelId)??c.channelId}`.slice(0,100),description:`${MODE_LABEL[c.countType]} \u00b7 ${showCur(c)}`.slice(0,100),value:c.channelId}));
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`pick_${purpose}`).setPlaceholder('Select a counting channel').addOptions(opts));
}

const SUP={'\u2070':'0','\u00b9':'1','\u00b2':'2','\u00b3':'3','\u2074':'4','\u2075':'5','\u2076':'6','\u2077':'7','\u2078':'8','\u2079':'9','\u207a':'+','\u207b':'-'};
class C{constructor(r=0,i=0){this.r=r;this.i=i;}static of(x){return x instanceof C?x:new C(+x,0);}add(b){b=C.of(b);return new C(this.r+b.r,this.i+b.i);}sub(b){b=C.of(b);return new C(this.r-b.r,this.i-b.i);}mul(b){b=C.of(b);return new C(this.r*b.r-this.i*b.i,this.r*b.i+this.i*b.r);}div(b){b=C.of(b);const d=b.r*b.r+b.i*b.i;if(!d)return new C(NaN,NaN);return new C((this.r*b.r+this.i*b.i)/d,(this.i*b.r-this.r*b.i)/d);}pow(b){b=C.of(b);if(this.r===0&&this.i===0)return(b.r===0&&b.i===0)?new C(1):new C(0);return this.ln().mul(b).exp();}ln(){return new C(Math.log(Math.hypot(this.r,this.i)),Math.atan2(this.i,this.r));}exp(){const e=Math.exp(this.r);return new C(e*Math.cos(this.i),e*Math.sin(this.i));}neg(){return new C(-this.r,-this.i);}sqrt(){const m=Math.hypot(this.r,this.i)**0.5,a=Math.atan2(this.i,this.r)/2;return new C(m*Math.cos(a),m*Math.sin(a));}cbrt(){const m=Math.hypot(this.r,this.i)**(1/3),a=Math.atan2(this.i,this.r)/3;return new C(m*Math.cos(a),m*Math.sin(a));}nthRoot(n){const m=Math.hypot(this.r,this.i)**(1/n),a=Math.atan2(this.i,this.r)/n;return new C(m*Math.cos(a),m*Math.sin(a));}isReal(tol=1e-6){return Math.abs(this.i)<=tol;}}
const CCONSTS={pi:new C(Math.PI),e:new C(Math.E),phi:new C((1+Math.sqrt(5))/2),tau:new C(Math.PI*2),sqrt2:new C(Math.SQRT2),i:new C(0,1)};
function lambertW(x){if(x<-1/Math.E)return NaN;let w=x<1?x:Math.log(x);for(let i=0;i<100;i++){const ew=Math.exp(w),f=w*ew-x,df=ew*(w+1);const dw=f/(df-(w+2)*f/(2*(w+1)));w-=dw;if(Math.abs(dw)<1e-12)break;}return w;}
const CFUNCS={floor:v=>new C(Math.floor(v.r)),ceil:v=>new C(Math.ceil(v.r)),round:v=>new C(Math.round(v.r)),abs:v=>new C(Math.hypot(v.r,v.i)),ln:v=>new C(Math.log(v.r)),log:v=>new C(Math.log10(v.r)),log2:v=>new C(Math.log2(v.r)),log10:v=>new C(Math.log10(v.r)),exp:v=>new C(Math.exp(v.r)),sin:v=>new C(Math.sin(v.r)),cos:v=>new C(Math.cos(v.r)),tan:v=>new C(Math.tan(v.r)),asin:v=>new C(Math.asin(v.r)),acos:v=>new C(Math.acos(v.r)),atan:v=>new C(Math.atan(v.r)),sinh:v=>new C(Math.sinh(v.r)),cosh:v=>new C(Math.cosh(v.r)),tanh:v=>new C(Math.tanh(v.r)),arcsin:v=>new C(Math.asin(v.r)),arccos:v=>new C(Math.acos(v.r)),arctan:v=>new C(Math.atan(v.r)),lambertw:v=>new C(lambertW(v.r)),lw:v=>new C(lambertW(v.r)),w:v=>new C(lambertW(v.r))};
const CONSTS={phi:(1+Math.sqrt(5))/2,pi:Math.PI,e:Math.E,tau:Math.PI*2,sqrt2:Math.SQRT2};
function factorial(v){if(!v.isReal())return new C(NaN,NaN);const n=v.r;if(n<0||Math.abs(n-Math.round(n))>1e-9)return new C(NaN,NaN);const r=Math.round(n);if(r>170)return new C(Infinity,0);let result=1;for(let i=2;i<=r;i++)result*=i;return new C(result,0);}
function safeMath(expr){
    let s=expr.trim(),norm='';
    for(let k=0;k<s.length;k++){if(SUP[s[k]]!==undefined){let sup='';while(k<s.length&&SUP[s[k]]!==undefined)sup+=SUP[s[k++]];norm+='^'+sup;k--;}else norm+=s[k];}
    s=norm.replace(/[\u00d7\u00b7\u2022]/g,'*').replace(/\u00f7/g,'/').replace(/\u2212/g,'-').replace(/\s+/g,'').toLowerCase();
    s=s.replace(/(?<=[\d)])x(?=[\d(])/g,'*').replace(/\*\*/g,'^').replace(/(\d+)\u221a/g,(_,n)=>`nrt${n}(`).replace(/\u221c/g,'nrt4(').replace(/\u221b/g,'cbrt(').replace(/\u221a/g,'sqrt(');
    if(/[+\-]{2,}/.test(s))return null;
    let tokens=[],k=0;
    while(k<s.length){if(/\d/.test(s[k])||s[k]==='.'){let n='';while(k<s.length&&(/\d/.test(s[k])||s[k]==='.')){ n+=s[k++];}tokens.push({t:'n',v:parseFloat(n)});}else if(/[a-z]/.test(s[k])){let id='';while(k<s.length&&/[a-z0-9]/.test(s[k]))id+=s[k++];tokens.push({t:'id',v:id});}else if('+-*/^(),!'.includes(s[k])){tokens.push({t:'op',v:s[k++]});}else k++;}
    const FUNCS=new Set(['sqrt','cbrt','floor','ceil','round','abs','ln','log','log2','log10','exp','sin','cos','tan','asin','acos','atan','arcsin','arccos','arctan','sinh','cosh','tanh','lambertw','lw','w','pow']);
    const isFunc=v=>FUNCS.has(v)||/^nrt\d+$/.test(v);
    const out=[];
    for(let j=0;j<tokens.length;j++){out.push(tokens[j]);const cur=tokens[j],nxt=tokens[j+1];if(!nxt)continue;const lOk=cur.t==='n'||(cur.t==='id'&&!isFunc(cur.v))||(cur.t==='op'&&(cur.v===')'||cur.v==='!'));const rOk=nxt.t==='n'||nxt.t==='id'||(nxt.t==='op'&&nxt.v==='(');const fc=nxt.t==='op'&&nxt.v==='('&&cur.t==='id'&&isFunc(cur.v);if(lOk&&rOk&&!fc)out.push({t:'op',v:'*'});}
    tokens=out;let pos=0;const peek=()=>tokens[pos],consume=()=>tokens[pos++];
    function parseExpr(){let l=parseTerm();while(peek()&&(peek().v==='+'||peek().v==='-')){const op=consume().v;const r=parseTerm();l=op==='+'?l.add(r):l.sub(r);}return l;}
    function parseTerm(){let l=parsePow();while(peek()&&(peek().v==='*'||peek().v==='/')){const op=consume().v;const r=parsePow();l=op==='*'?l.mul(r):l.div(r);}return l;}
    function parsePow(){const b=parseUnary();if(peek()&&peek().v==='^'){consume();return b.pow(parsePow());}return b;}
    function parseUnary(){if(peek()&&peek().v==='-'){consume();return parseUnary().neg();}if(peek()&&peek().v==='+'){consume();return parseUnary();}return parsePostfix();}
    function parsePostfix(){let v=parseAtom();while(peek()&&peek().v==='!'){consume();v=factorial(v);}return v;}
    function parseAtom(){const tok=peek();if(!tok)throw new Error('unexpected end');if(tok.t==='n'){consume();return new C(tok.v,0);}if(tok.t==='id'){consume();if(peek()&&peek().v==='('){consume();const arg=parseExpr();const arg2=peek()&&peek().v===','?(consume(),parseExpr()):null;if(peek()&&peek().v===')')consume();if(tok.v==='pow'){if(arg2===null)throw new Error('pow requires 2 args');return arg.pow(arg2);}if(tok.v==='sqrt')return arg2===null?arg.sqrt():arg.nthRoot(arg2.r);if(tok.v==='cbrt')return arg.cbrt();if(CFUNCS[tok.v])return CFUNCS[tok.v](arg);if(/^nrt(\d+)$/.test(tok.v))return arg.nthRoot(parseInt(tok.v.slice(3)));throw new Error('unknown fn: '+tok.v);}if(CCONSTS[tok.v])return CCONSTS[tok.v];throw new Error('unknown id: '+tok.v);}if(tok.t==='op'&&tok.v==='('){consume();const val=parseExpr();if(peek()&&peek().v===')')consume();return val;}throw new Error('unexpected: '+JSON.stringify(tok));}
    try{const res=parseExpr();if(!res.isReal()||!isFinite(res.r)||isNaN(res.r))return null;const r=Math.round(res.r);return Math.abs(r)>10_000_000?null:r;}catch{return null;}
}

function generateExpressions(n){
    const cands=[],phi=(1+Math.sqrt(5))/2;
    const cs=[['phi',phi],['pi',Math.PI],['e',Math.E],['sqrt2',Math.SQRT2],['tau',Math.PI*2]];
    for(let b=2;b<=50;b++)for(let x=2;x<=8;x++)if(Math.pow(b,x)===n)cands.push(`${b}^${x}`);
    for(const[nm,v]of cs){for(let x=1;x<=20;x++)if(Math.round(Math.pow(v,x))===n){cands.push(`${nm}^${x}`);break;}for(let x=1;x<=10;x++){const b=Math.round(Math.pow(v,x)),d=n-b;if(d!==0&&Math.abs(d)<=20)cands.push(`${nm}^${x}${d>0?'+'+d:d}`);}}
    if(n>4)for(let a=2;a<=Math.sqrt(n);a++)if(n%a===0){cands.push(`${a}*${n/a}`);break;}
    if(n>8){outer:for(let a=2;a<=Math.cbrt(n);a++)if(n%a===0){const r=n/a;for(let b=a;b<=Math.sqrt(r);b++)if(r%b===0){cands.push(`${a}*${b}*${r/b}`);break outer;}}}
    if(n>2){const a=Math.max(1,Math.floor(n*0.35));cands.push(`${a}+${n-a}`);}
    cands.push(`${n+Math.round(n*0.6)+1}-${Math.round(n*0.6)+1}`,`${n*(n<=10?2:3)}/${n<=10?2:3}`);
    if(n>5)for(let a=2;a<=10;a++){const base=Math.floor(n/a)*a,d=n-base;if(base>0&&d>0&&d<a){cands.push(`${a}*${Math.floor(n/a)}+${d}`);break;}}
    const seen=new Set(),res=[];
    for(const c of cands.sort((a,b)=>(/[a-z]/.test(b)?1:0)-(/[a-z]/.test(a)?1:0)||a.length-b.length))if(!seen.has(c)&&res.length<3){seen.add(c);res.push(c);}
    if(res.length<3)res.push(`${n-1}+1`);if(res.length<3)res.push(`${n*2}/2`);if(res.length<3)res.push(`${n+3}-3`);
    return res.slice(0,3);
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
        ).setFooter({text:'Page 1/5'}),
        E('#5865F2','Commands').setDescription('All commands:').addFields(
            {name:'Counting',value:'`/counting reset`'},
            {name:'Config',value:'`/config channel` `/config removechannel` `/config setcount` `/config view` `/config maxstreak` `/config expressions` `/config access` `/config counttype` `/config failrole` `/config anticheat`'},
            {name:'Stats',value:'`/stats [user]` `/leaderboard server` `/leaderboard global` `/leaderboard highscores`'},
            {name:'Utilities',value:'`/calculate [expression]` `/invite` `/help` `/setup`'},
            {name:'\u{1F6E0}\ufe0f Support Server',value:`Need help or want to report a bug? [Join the support server](${SUPPORT_URL})`},
        ).setFooter({text:'Page 2/5'}),
        E('#5865F2','Config').setDescription('Requires Administrator or configured access role.').addFields(
            {name:'/config channel <channel> [mode]',value:'Add a counting channel (text, announcement or forum)'},
            {name:'/config removechannel <channel>',value:'Stop counting in a channel'},
            {name:'/config counttype [channel]',value:'Switch a channel between Interactive, Simple, Countdown, Modifiers and Floors'},
            {name:'/config maxstreak <n>',value:'Max consecutive counts per user (1\u2013100)'},
            {name:'/config expressions <bool>',value:'Allow/block math expressions'},
            {name:'/config access',value:'Set which role can use config commands'},
            {name:'/config failrole [role] [minutes]',value:'Give players who ruin the count a temporary role (Administrator only)'},
            {name:'/config anticheat <bool>',value:'Call out edited or deleted counts'},
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

function earnsSave(v){const ms=[50,100,250,500,1000,2000];return ms.includes(v)||(v>2000&&v%2000===0);}
function nextSaveAt(v){const ms=[50,100,250,500,1000,2000];for(const m of ms)if(v<m)return m;return Math.ceil((v+1)/2000)*2000;}

// ---------- fail roles ----------
const failTimers = new Map();
const frKey = (gid, uid) => `${gid}:${uid}`;
async function removeFailRole(gid, uid, roleId) {
    failTimers.delete(frKey(gid, uid));
    try {
        const guild = client.guilds.cache.get(gid);
        const m = guild ? await guild.members.fetch(uid).catch(() => null) : null;
        if (m && m.roles.cache.has(roleId)) await m.roles.remove(roleId, 'Tick: fail role expired');
    } catch (e) { console.error('removeFailRole:', e.message); }
    pool.query('DELETE FROM fail_roles WHERE guild_id=$1 AND user_id=$2 AND role_id=$3', [gid, uid, roleId]).catch(() => {});
}
function scheduleFailRole(gid, uid, roleId, ms) {
    const k = frKey(gid, uid);
    clearTimeout(failTimers.get(k));
    failTimers.set(k, setTimeout(() => removeFailRole(gid, uid, roleId), Math.max(0, ms)));
}
function failRoleFor(gid, g) {
    if (!g.failRoleId) return null;
    const role = client.guilds.cache.get(gid)?.roles.cache.get(g.failRoleId);
    return role && role.editable ? role : null;
}
function failRoleNote(gid, g, userId) {
    const role = failRoleFor(gid, g);
    return role ? `\n\u{1F6AB} <@${userId}> got <@&${role.id}> for **${g.failRoleMinutes ?? 10}** min.` : '';
}
async function giveFailRole(gid, g, uid) {
    const role = failRoleFor(gid, g);
    if (!role) return;
    const m = await client.guilds.cache.get(gid).members.fetch(uid).catch(() => null);
    if (!m) return;
    const k = frKey(gid, uid), mins = g.failRoleMinutes ?? 10;
    // If they already hold the role and we aren't managing it, it isn't ours to take away later.
    if (m.roles.cache.has(role.id) && !failTimers.has(k)) return;
    try { if (!m.roles.cache.has(role.id)) await m.roles.add(role, 'Tick: ruined the count'); }
    catch (e) { console.error('giveFailRole:', e.message); return; }
    pool.query('INSERT INTO fail_roles (guild_id,user_id,role_id,expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (guild_id,user_id) DO UPDATE SET role_id=$3, expires_at=$4', [gid, uid, role.id, new Date(Date.now() + mins * 60000)]).catch(e => console.error('fail_roles:', e.message));
    scheduleFailRole(gid, uid, role.id, mins * 60000);
}
async function restoreFailRoles() {
    const r = await pool.query('SELECT guild_id, user_id, role_id, expires_at FROM fail_roles');
    for (const row of r.rows) scheduleFailRole(row.guild_id, row.user_id, row.role_id, new Date(row.expires_at).getTime() - Date.now());
}
function validateFailRole(guild, role) {
    if (!role) return 'Role not found.';
    if (role.id === guild.id) return "@everyone can't be used as a fail role.";
    if (role.managed) return "Bot and integration roles can't be assigned to members.";
    return null;
}
const failRoleWarning = role => role.editable ? '' : "\n\u26a0\ufe0f I can't assign that role yet \u2014 give me **Manage Roles** and move my role above it.";

// ---------- reset / ruin ----------
function doReset(g, c, userId) {
    resetChannel(c);
    saveChan(c);
    updateUserStat(c.guildId, userId, { ruined: 1 });
    giveFailRole(c.guildId, g, userId).catch(e => console.error('giveFailRole:', e.message));
}
function switchMode(guild, c, newType) {
    c.countType = newType;
    c.savesAwardedUpTo = 0;
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

const SUPPORT_URL='https://discord.gg/Qrp82cRhUW';
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
function keepAlive(){const ping=()=>{const u=process.env.RENDER_EXTERNAL_URL||`http://localhost:${process.env.PORT||3000}`;(u.startsWith('https')?require('https'):http).get(u,()=>{}).on('error',()=>{});};setTimeout(ping,5000);setInterval(ping,14*60*1000);}


const INVITE_PERMS = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageRoles,
]).bitfield.toString();

client.once('ready',async()=>{
    console.log(`Online as ${client.user.tag}`);
    client.user.setPresence({activities:[{name:'Counting things',type:ActivityType.Watching}],status:'online'});
    const chanOpt=(o,desc,req=false)=>o.setName('channel').setDescription(desc).addChannelTypes(...COUNTING_CHANNEL_TYPES).setRequired(req);
    const cmds=[
        new SlashCommandBuilder().setName('counting').setDescription('Configure or view the counting game').addSubcommand(s=>s.setName('reset').setDescription('Manually reset the count').addChannelOption(o=>chanOpt(o,'Counting channel to reset'))),
        new SlashCommandBuilder().setName('config').setDescription('Configure bot settings')
            .addSubcommand(s=>s.setName('channel').setDescription('Add a counting channel').addChannelOption(o=>chanOpt(o,'Channel to count in',true)).addStringOption(o=>o.setName('mode').setDescription('Counting mode (default: Interactive)').addChoices(...MODE_CHOICES)))
            .addSubcommand(s=>s.setName('removechannel').setDescription('Stop counting in a channel').addChannelOption(o=>chanOpt(o,'Counting channel to remove',true)))
            .addSubcommand(s=>s.setName('setcount').setDescription('Set the current count').addIntegerOption(o=>o.setName('number').setDescription('Number').setRequired(true).setMinValue(0).setMaxValue(1000)).addChannelOption(o=>chanOpt(o,'Counting channel (if you have several)')))
            .addSubcommand(s=>s.setName('view').setDescription('View counting channels and settings'))
            .addSubcommand(s=>s.setName('maxstreak').setDescription('Max consecutive counts per user').addIntegerOption(o=>o.setName('amount').setDescription('1\u2013100').setRequired(true).setMinValue(1).setMaxValue(100)))
            .addSubcommand(s=>s.setName('expressions').setDescription('Allow math expressions').addBooleanOption(o=>o.setName('enabled').setDescription('Enable/disable').setRequired(true)))
            .addSubcommand(s=>s.setName('access').setDescription('Set which role can use config'))
            .addSubcommand(s=>s.setName('counttype').setDescription('Switch counting mode').addChannelOption(o=>chanOpt(o,'Counting channel (if you have several)')))
            .addSubcommand(s=>s.setName('failrole').setDescription('Give players who ruin the count a temporary role')
                .addRoleOption(o=>o.setName('role').setDescription('Role to hand out (leave empty to create "Ruined the Count")'))
                .addIntegerOption(o=>o.setName('minutes').setDescription('How long the role lasts, 1\u20131440 (default 10)').setMinValue(1).setMaxValue(1440))
                .addBooleanOption(o=>o.setName('disable').setDescription('Turn fail roles off')))
            .addSubcommand(s=>s.setName('anticheat').setDescription('Call out edited or deleted counts').addBooleanOption(o=>o.setName('enabled').setDescription('Enable/disable').setRequired(true))),
        new SlashCommandBuilder().setName('leaderboard').setDescription('View leaderboards')
            .addSubcommand(s=>s.setName('server').setDescription('Top counters in this server'))
            .addSubcommand(s=>s.setName('global').setDescription('Global leaderboard'))
            .addSubcommand(s=>s.setName('highscores').setDescription('Channels by mode high score / cycles')),
        new SlashCommandBuilder().setName('stats').setDescription('View counting stats').addUserOption(o=>o.setName('user').setDescription('User to check')),
        new SlashCommandBuilder().setName('calculate').setDescription('Calculate an expression, or get 3 expressions for a number').addStringOption(o=>o.setName('input').setDescription('A number or expression').setRequired(true)),
        new SlashCommandBuilder().setName('setup').setDescription('Open the bot setup panel (admin only)'),
        new SlashCommandBuilder().setName('invite').setDescription('Invite this bot'),
        new SlashCommandBuilder().setName('help').setDescription('View all commands'),
    ].map(c=>c.toJSON());
    await client.application.commands.set(cmds);console.log('Commands registered');
    try{
        await initDB();
        const [gr,cr]=await Promise.all([pool.query('SELECT guild_id,data FROM counting'),pool.query('SELECT guild_id,channel_id,data FROM counting_channels')]);
        for(const r of gr.rows)guildCache.set(r.guild_id,normGuild(r.data));
        for(const r of cr.rows)indexChan(normChan({...r.data,guildId:r.guild_id,channelId:r.channel_id}));
        fullyLoaded=true;
        console.log(`Loaded ${cr.rows.length} counting channel(s) across ${gr.rows.length} guild(s)`);
        await restoreFailRoles();
    }catch(e){console.error('DB init failed:',e.message);}
    keepAlive();
    for(const guild of client.guilds.cache.values()){await announceSupportServer(guild).catch(()=>{});}
});

client.on('guildCreate',guild=>{announceSupportServer(guild).catch(()=>{});});
// Make sure the bot is in new threads created inside counting channels so it receives their messages.
client.on('threadCreate',thread=>{if(chanCache.has(thread.parentId)&&thread.joinable)thread.join().catch(()=>{});});
client.on('channelDelete',ch=>{if(ch.guildId&&chanCache.has(ch.id))removeCountingChannel(ch.guildId,ch.id).catch(()=>{});});

client.on('messageCreate',async message=>{
    try{await handleCount(message);}catch(e){console.error('messageCreate:',e.message);}
});

async function handleCount(message){
    if(message.author.bot||!message.guild)return;
    const gid=message.guild.id,chan=message.channel;
    const cid=chan.isThread()?chan.parentId:chan.id;   // threads count towards their parent channel
    if(!cid)return;
    if(!fullyLoaded&&!loadedGuilds.has(gid))await loadGuild(gid);
    const c=chanCache.get(cid);
    if(!c)return;
    const g=await getGuild(gid);
    if(c.pendingSave){if(Date.now()<c.pendingSave.expiresAt)return;delete c.pendingSave;saveChan(c);}
    const raw=message.content.trim();
    const hasConst=Object.keys(CONSTS).some(k=>new RegExp(`(?<![a-z])${k}(?![a-z])`,'i').test(raw));
    const hasFancyOp=/[\u00d7\u00b7\u00f7\u00b2\u00b3\u00b9\u2070\u2074\u2075\u2076\u2077\u2078\u2079\u207a\u207b\u221a\u221b\u221c]/.test(raw)||/\d[xX]\d/.test(raw);
    const isExpr=(/[+\-*/^()!]/.test(raw)&&!/^\-?\d+$/.test(raw))||hasConst||hasFancyOp;
    const value=safeMath(raw);
    const type=c.countType;

    if(type==='simple'){
        const expected=c.current+1,sameUser=message.author.id===c.lastUserId;
        const newStreak=sameUser?c.consecutiveCount+1:1,streakViolation=g.maxStreak>0&&sameUser&&newStreak>g.maxStreak;
        if(!(value!==null||isExpr))return;
        if(value===null||value!==expected||streakViolation){const me=message.guild.members.me;if(!me?.permissionsIn(message.channel).has(PermissionFlagsBits.ManageMessages))return;await message.delete().catch(()=>{});return;}
        c.current=value;c.lastUserId=message.author.id;c.consecutiveCount=newStreak;c.lastMessageId=message.id;
        if(value>c.highScore)c.highScore=value;saveChan(c);updateUserStat(gid,message.author.id,{correct:1});
        await message.react(value<=9?NE[value]:'\u2705').catch(()=>{});
        if(value%100===0)await message.channel.send({embeds:[E('#00cc88',`\u{1F389} ${value} reached!`).setDescription(`The count hit **${value}** thanks to <@${message.author.id}>!`)]}).catch(()=>{});
        return;
    }

    // interactive / countdown / modifiers / floors
    if(isExpr&&!g.allowExpressions){await message.react('\u274c').catch(()=>{});const s=await message.channel.send({embeds:[E('#ff4444','Expressions disabled').setDescription(`\`${raw}\` \u2014 expressions not allowed here!`)]}).catch(()=>null);if(s)setTimeout(()=>s.delete().catch(()=>{}),5000);return;}
    if(value===null)return;
    if(type==='countdown'&&(c.current<=0||c.current>c.countdownStart+1))c.current=c.countdownStart+1;
    if(type==='modifiers'&&!c.modifier){const mod=pickModifier();c.modifier=mod.id;c.modifierLabel=mod.label;saveChan(c);await message.channel.send({embeds:[E('#9b59b6','\u{1F3B2} New Modifier!').setDescription(`The modifier for this round is:\n**${mod.label}**\n${mod.desc}`)]}).catch(()=>{});}
    const expected=expectedNext(c);
    if(value!==expected){
        if(!await claimMessage(message.id))return;
        message.react('\u274c').catch(()=>{});
        const reason=type==='modifiers'?`sent \`${value}\` \u2014 not the next valid number for **${c.modifierLabel}**`:`sent \`${value}\` but expected \`${expected}\``;
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
    // Each milestone pays out once per channel (tracked in savesAwardedUpTo), and the server can hold at most MAX_SAVES.
    if(usesSaves(type)&&earnsSave(value)&&value>(c.savesAwardedUpTo??0)){
        if((g.saves??0)>=MAX_SAVES){await message.channel.send({embeds:[E('#888888','\u{1F6E1}\ufe0f Saves are full').setDescription(`Milestone **${value}** reached, but the server is already holding the maximum of **${MAX_SAVES}** saves. Use one and you can still earn it.`)]}).catch(()=>{});}
        else{c.savesAwardedUpTo=value;saveChan(c);g.saves=(g.saves??0)+1;saveGuild(gid,g);await message.channel.send({embeds:[E('#ffd700','\u{1F6E1}\ufe0f Save earned!').setDescription(`The server earned a **Save** for reaching **${value}**!\nThe server now has **${g.saves}**/${MAX_SAVES} save(s). Next save at **${nextSaveAt(value)}**.`)]}).catch(()=>{});}
    }
    await message.react(type==='modifiers'?'\u2705':(value<=9&&value>=0?NE[value]:'\u2705')).catch(()=>{});

    if(type==='countdown'){
        const start=c.countdownStart;
        if(value===1){
            c.countdownCycles=(c.countdownCycles??0)+1;c.current=start+1;c.lastUserId=null;c.consecutiveCount=0;c.lastMessageId=null;saveChan(c);
            await message.channel.send({embeds:[E('#ffd700',`\u{1F389} Countdown Complete! Cycle #${c.countdownCycles}`).setDescription(`The count reached **1**! \u{1F38A} Incredible work, <@${message.author.id}> finished it off!\nThe countdown resets to **${start}**. Let's go again!`).addFields({name:'\u{1F504} Cycles completed',value:`**${c.countdownCycles}**`,inline:true},{name:'\u{1F522} Restarting from',value:`**${start}**`,inline:true}).setFooter({text:'Can you do it again?'})]}).catch(()=>{});
        }else if(value%25===0){
            await message.channel.send({embeds:[E('#00cc88',`\u23f3 ${value} to go!`).setDescription(`Getting closer! **${value}** left to count down.`)]}).catch(()=>{});
        }
    }else if(type==='modifiers'){
        const mod=getModifier(c.modifier);
        if(value%10===0||value<=5)await message.channel.send({embeds:[E('#9b59b6',`\u{1F3B2} ${value}!`).setDescription(`Category: **${mod.label}**`)]}).catch(()=>{});
        if(value%100===0)await message.channel.send({embeds:[E('#00cc88',`\u{1F389} ${value} reached!`).setDescription(`The count hit **${value}** thanks to <@${message.author.id}>! \u{1F3B2} Modifier: ${mod.label}`).setFooter({text:`High score: ${c.highScore}`})]}).catch(()=>{});
    }else if(type==='floors'){
        if(value%FLOOR_SIZE===0)await message.channel.send({embeds:[E('#00cc88',`\u{1F3E2} Floor ${value/FLOOR_SIZE} cleared!`).setDescription(`The count hit **${value}** thanks to <@${message.author.id}>!\nCheckpoint saved \u2014 if the count is ruined it drops back to **${c.checkpoint}** instead of 0.`).setFooter({text:`High score: ${c.highScore}`})]}).catch(()=>{});
    }else{
        if(value%100===0)await message.channel.send({embeds:[E('#00cc88',`\u{1F389} ${value} reached!`).setDescription(`The count hit **${value}** thanks to <@${message.author.id}>!`).setFooter({text:`High score: ${c.highScore}`})]}).catch(()=>{});
    }
}

// ---------- anti-cheat: call out edited / deleted counts ----------
function cheatEmbed(kind,c){
    const edited=kind==='edit';
    return E('#ff9900',edited?'\u270f\ufe0f Number edited!':'\u{1F5D1}\ufe0f Number deleted!').setDescription(`<@${c.lastUserId}> ${edited?'edited':'deleted'} their number!\nThe last number was **${showCur(c)}**.\n${nextText(c)}`);
}
async function cheatCheck(channelId,messageId,kind,newMessage){
    const cid=countingIdFor(channelId),c=chanCache.get(cid);
    if(!c||!c.lastMessageId||c.lastMessageId!==messageId)return;
    const g=await getGuild(c.guildId);
    if(g.antiCheat===false)return;
    if(kind==='edit'){
        let m=newMessage;
        if(m.partial)m=await m.fetch().catch(()=>null);
        if(!m||m.content==null)return;
        if(safeMath(m.content.trim())===c.current)return;   // same value (embed update, reformatting) - not a real edit
    }
    c.lastMessageId=null;saveChan(c);
    const ch=client.channels.cache.get(channelId);
    if(ch?.isTextBased?.())ch.send({embeds:[cheatEmbed(kind,c)]}).catch(()=>{});
}
client.on('messageUpdate',(oldM,newM)=>{
    if(!newM.guildId||newM.author?.bot)return;
    cheatCheck(newM.channelId,newM.id,'edit',newM).catch(e=>console.error('cheat edit:',e.message));
});
client.on('messageDelete',msg=>{
    if(!msg.guildId)return;
    cheatCheck(msg.channelId,msg.id,'delete').catch(e=>console.error('cheat delete:',e.message));
});

const isAdmin=i=>i.member.permissions.has(PermissionFlagsBits.Administrator);
const lbRows=(embedRes,activeTab,pRow)=>({embeds:[embedRes.embed],components:[...globalTabRows(activeTab),pRow]});
function gsPagination(filter,page,totalPages){
    const base=`lb_gs_f${filter}`;
    return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${base}_p${page-1}`).setLabel('\u25c4').setStyle(ButtonStyle.Secondary).setDisabled(page<=1),new ButtonBuilder().setCustomId(`${base}_info`).setLabel(`${page}/${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),new ButtonBuilder().setCustomId(`${base}_p${page+1}`).setLabel('\u25ba').setStyle(ButtonStyle.Secondary).setDisabled(page>=totalPages),new ButtonBuilder().setCustomId(`${base}_p${page}`).setLabel('\u21ba').setStyle(ButtonStyle.Secondary));
}
const noChannels=()=>({content:'No counting channels yet \u2014 add one first.',...ep()});

client.on('interactionCreate',async interaction=>{
    const gid=interaction.guild?.id;
    if(interaction.isButton()){
        const id=interaction.customId;
        if(id.startsWith('help_')){const p=parseInt(id.split('_')[1]);if(!isNaN(p)&&p>=1&&p<=5)return interaction.update(buildHelpPage(p));}
        if(id.startsWith('calc_copy_')){const parts=id.split('_');const expr=parts.slice(3).join('_');return interaction.reply({content:`\`${expr}\`\nTap and hold to copy \u2014 then paste it in the counting channel!`,...ep()});}
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
            if(id==='setup_access')return interaction.reply({embeds:[E('#5865F2','Set Access Role').setDescription('Select which role can use `/config` commands:')],components:[new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup_role_select').setPlaceholder('Select a role').setMinValues(1).setMaxValues(1))],...ep()});
            if(id==='setup_failrole')return interaction.reply({embeds:[E('#5865F2','Set Fail Role').setDescription(`Select the role players get for **${g.failRoleMinutes??10}** minutes after ruining the count. Use \`/config failrole\` to change the duration or turn it off.`)],components:[new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup_failrole_select').setPlaceholder('Select a role').setMinValues(1).setMaxValues(1))],...ep()});
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
            return interaction.update({embeds:[E('#5865F2','Access role set').setDescription(`<@&${g.accessRoleId}> can now use config commands.`)],components:[]});
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
        if(!isAdmin(interaction))return interaction.reply({content:'Admins only.',...ep()});
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
        if(cmd==='config'){
            const sub=options.getSubcommand();
            if(sub==='view'){
                await interaction.deferReply(ep());const g=await getGuild(gid),chans=channelsOf(gid);
                return interaction.editReply({embeds:[E('#5865F2','Counting Status').addFields(
                    {name:`Counting channels (${chans.length}/${MAX_COUNTING_CHANNELS})`,value:chans.length?chans.map(c=>`${channelLine(c)}${c.lastUserId?` \u00b7 last <@${c.lastUserId}>`:''}`).join('\n').slice(0,1020):'None set up yet \u2014 use `/config channel`'},
                    {name:'Streak',value:`**${g.maxStreak}** in a row`,inline:true},{name:'Expr',value:g.allowExpressions?'Allowed':'Disabled',inline:true},{name:'Saves',value:`**${g.saves??0}**`,inline:true},
                    {name:'Access',value:g.accessRoleId?`<@&${g.accessRoleId}>`:'Admins only',inline:true},{name:'Fail role',value:g.failRoleId?`<@&${g.failRoleId}> (${g.failRoleMinutes??10} min)`:'Off',inline:true},{name:'Anti-cheat',value:g.antiCheat?'On':'Off',inline:true},
                )]});
            }
            if(sub==='access'){if(!isAdmin(interaction))return interaction.reply({content:'Admins only.',...ep()});const g=await getGuild(gid);return interaction.reply({embeds:[E('#5865F2','Access Config').setDescription('Select a role that can use `/config` commands.').addFields({name:'Current role',value:g.accessRoleId?`<@&${g.accessRoleId}>`:'None (admins only)'})],components:[new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`access_role_${gid}`).setPlaceholder('Select role').setMinValues(1).setMaxValues(1))],...ep()});}
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
            if(sub==='counttype'){
                const{c,error}=resolveCounting(interaction,options.getChannel('channel'));
                if(error)return interaction.reply({content:error,...ep()});
                return interaction.reply({embeds:[E('#5865F2',`Count Type \u2014 <#${c.channelId}>`).setDescription('Choose a counting mode. Changing it resets this channel\'s count.').addFields({name:'\u{1F3AE} Interactive',value:'Wrong numbers reset the count. Streaks, saves, and reactions apply.',inline:true},{name:'\u{1F7E2} Simple',value:'Wrong messages are silently deleted. Count never resets.',inline:true},{name:'\u23f3 Countdown',value:'Count DOWN from 100 to 1. Complete cycles for glory!',inline:true},{name:'\u{1F3B2} Modifiers',value:'Interactive with a modifier (primes, Fibonacci, etc.). The bot only names the category, never the next number!',inline:true},{name:'\u{1F3E2} Floors',value:`Interactive with a checkpoint every ${FLOOR_SIZE}. Ruin the count and you drop back to your highest checkpoint.`,inline:true},{name:'Current mode',value:`**${MODE_EMOJI[c.countType]} ${MODE_LABEL[c.countType]}**`})],components:[countTypeRow(c.countType,c.channelId)],...ep()});
            }
            await interaction.deferReply(ep());const g=await getGuild(gid);
            if(sub==='channel'){
                const ch=options.getChannel('channel');
                if(!COUNTING_CHANNEL_TYPES.includes(ch.type))return interaction.editReply({content:'Pick a text, announcement or forum channel.'});
                const res=await addCountingChannel(interaction.guild,ch.id,options.getString('mode'));
                if(res.error)return interaction.editReply({content:res.error});
                const forum=ch.type===ChannelType.GuildForum;
                return interaction.editReply({embeds:[E('#5865F2','Counting channel added').setDescription(`${ch} is now a counting channel in **${MODE_LABEL[res.c.countType]}** mode (${channelsOf(gid).length}/${MAX_COUNTING_CHANNELS}).\n${modeIntro(res.c)}${forum?'\n\nAll posts in this forum share one count.':'\n\nThreads in this channel share its count.'}`)]});
            }
            if(sub==='removechannel'){
                const ch=options.getChannel('channel');
                if(!await removeCountingChannel(gid,ch.id))return interaction.editReply({content:`${ch} isn't a counting channel.`});
                return interaction.editReply({embeds:[E('#5865F2','Counting channel removed').setDescription(`${ch} is no longer a counting channel.`)]});
            }
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
});

process.on('unhandledRejection',e=>console.error(e));
client.on('error',e=>console.error('Discord error:',e));
client.login(process.env.DISCORD_TOKEN);

const PORT=process.env.PORT||3000;
http.createServer((req,res)=>{const ok=req.url==='/'||req.url==='/health';res.writeHead(ok?200:404,{'Content-Type':'text/plain'});res.end(ok?'Tick is running!':'Not found');}).listen(PORT,()=>console.log(`HTTP on port ${PORT}`));

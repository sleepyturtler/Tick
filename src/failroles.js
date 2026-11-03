const client = require('./client');
const { pool } = require('./db');

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

module.exports = { failRoleNote, giveFailRole, restoreFailRoles, validateFailRole, failRoleWarning };

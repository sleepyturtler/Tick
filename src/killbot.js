// Owner-only /killbot: suspends this bot's Render service so it stops using hours.
// Ported from the Notifyer beta debug tools.
//
// Optional on purpose: commands.js and handlers/interactions.js load this file only if it exists.
// Delete the file and restart, and the command disappears with no other code changes.
//
// Env vars:
//   BOT_OWNER_ID      Discord user ID allowed to run it. If unset, nobody can.
//   RENDER_API_KEY    Render API key (Account Settings > API Keys). Needed to really suspend.
//   RENDER_SERVICE_ID Render normally sets this itself on its services. Set it by hand only if it is missing.
// Without a key it falls back to crashing the process, which Render usually just restarts.
const { SlashCommandBuilder, MessageFlags } = require('discord.js');

// Hidden from regular members in the slash menu; the owner check below is the real gate.
const command = new SlashCommandBuilder()
    .setName('killbot')
    .setDescription('Owner only: suspend the Render service to stop usage')
    .setDefaultMemberPermissions(0);

const EPH = { flags: [MessageFlags.Ephemeral] };

async function suspendService(serviceId, key) {
    const res = await fetch(`https://api.render.com/v1/services/${serviceId}/suspend`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
    });
    return res.status;
}

// Returns true if the interaction was /killbot (handled), false so the caller carries on.
async function handle(interaction) {
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'killbot') return false;

    const ownerId = process.env.BOT_OWNER_ID;
    if (!ownerId || interaction.user.id !== ownerId) {
        await interaction.reply({ content: '\u274c This command is owner-only.', ...EPH });
        return true;
    }
    await interaction.reply({ content: '\u{1F6D1} Suspending the Render service...', ...EPH });
    const key = process.env.RENDER_API_KEY, serviceId = process.env.RENDER_SERVICE_ID;
    const say = content => interaction.followUp({ content, ...EPH }).catch(() => {});
    if (key && serviceId) {
        try {
            const status = await suspendService(serviceId, key);
            if (status >= 200 && status < 300) {
                await say('\u2705 Render service suspended. It stays off and stops using hours until you resume it from the Render dashboard.');
            } else {
                await say(`\u26a0\ufe0f The Render API returned status ${status}. Falling back to crashing the process.`);
                process.exit(1);
            }
        } catch (e) {
            await say(`\u26a0\ufe0f The Render suspend call failed (${e.message}). Falling back to crashing the process.`);
            process.exit(1);
        }
    } else {
        await say("\u26a0\ufe0f RENDER_API_KEY or RENDER_SERVICE_ID is not set, so I can't properly suspend the service. Crashing the process instead. On most Render plans that just gets restarted automatically and keeps using hours, so set both env vars for a real stop.");
        process.exit(1);
    }
    return true;
}

module.exports = { command, handle };

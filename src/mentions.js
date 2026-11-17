// Clickable slash command mentions, like <#channel> and <@user> but for commands: </counting settings:123456789>.
// Discord only needs the ID of the top-level command, so subcommands share their parent's ID.
// The IDs come from the registration at startup (index.js). Until then, and in tests, a mention falls back to plain `/name` in backticks.
// Mentions only render in message text. Button labels, menu options and placeholders cannot show them.
const ids = new Map();

// `commands` is what client.application.commands.set(...) resolves to (a collection of ApplicationCommand).
function setCommands(commands) {
    ids.clear();
    for (const c of commands?.values?.() ?? []) if (c?.name && c?.id) ids.set(c.name, c.id);
}
const clear = () => ids.clear();

// cmd('counting settings') -> "</counting settings:ID>", cmd('help') -> "</help:ID>"
function cmd(path) {
    const id = ids.get(String(path).split(' ')[0]);
    return id ? `</${path}:${id}>` : `\`/${path}\``;
}

module.exports = { cmd, setCommands, clear };

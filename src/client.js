const { Client, GatewayIntentBits, Partials } = require('discord.js');

// Partials.Message lets the anti-cheat see edits/deletes of messages that are no longer cached.
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Message] });

module.exports = client;

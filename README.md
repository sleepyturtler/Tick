# Description
The best counting bot out there, featuring multiple modes, multiple counting channels per server, endless customization and fun modifiers.

# Commands

## Config
- **/config channel:** Adds a counting channel (text, announcement or forum), optionally with a mode. Servers can have several (default max 10), each with its own mode and count. Threads share the count of their parent channel.
- **/config removechannel:** Stops counting in a channel.
- **/config counttype:** Switch a channel between the interactive, simple, countdown, modifiers and floors mode.
- **/config failrole:** Gives players who ruin the count a temporary role (leave `role` empty to create "Ruined the Count"). Needs Manage Roles.
- **/config anticheat:** Calls out edited or deleted counts.
- **/config maxstreak:** Sets the maximum consecutive counts per user.
- **/config access:** Sets which role can use the config commands.
- **/config setcount:** Sets the count to any number below 1000 to make it easy to transfer from another bot.
- **/config expressions:** Allows or disallows the use of expressions.
- **/setup:** All in one panel for setting up the bot.

# Modes
- **Interactive:** Wrong number resets to 0. Saves, streaks, milestones.
- **Simple:** Wrong messages are deleted, the count never resets.
- **Countdown:** Count down from 100 to 1, then it starts over.
- **Modifiers:** A modifier (primes, Fibonacci, every 3rd number...) decides the valid numbers. The bot only names the category, never the next number.
- **Floors:** Every 100 is a checkpoint. Ruin the count and you drop back to your highest checkpoint instead of 0.

# Environment
`DATABASE_URL`, `DISCORD_TOKEN`; optional: `DB_STATEMENT_TIMEOUT_MS` (8000), `DB_CONNECTION_TIMEOUT_MS` (5000), `DB_IDLE_TIMEOUT_MS`, `DB_POOL_MAX` (3), `MAX_COUNTING_CHANNELS` (10).

## Stats
- **/stats:** Shows your or another user's stats.
- **/leaderboard server:** Shows the top counters in the server.
- **/leaderboard global:** Shows the current top servers and top counters.
- **/leaderboard highscores:** Shows the top highscores.

## Other
- **/calculate:** Enter a number to get 3 ways to calculate it or enter an expression to evaluate it.
- **/invite:** Generates an invite link with all the needed permissions.
- **/help:** Lists all the commands and provides other useful info.

# AI Use:
- The bot is mostly vibecoded with Claude, however
- A lot of effort, manual bugtesting and time has went into making this bot super polished.
- The bot is something I am passionate about, and me using AI does not change the fact that I worked very hard to make it.

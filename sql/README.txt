Launch ratings for FIFA 15 to FC 27, one SQL file per game (fc15.sql ... fc27.sql).

You normally don't have to do anything with these. Deploy this folder together with the bot: on startup the bot
loads every game that is not in the database yet (newest first) and logs a line per game, for example
"Imported ratings for game 26: 17868 players (1.4s)". Games already loaded are skipped, so restarts are cheap.
Until a game finishes loading, lookups for it find nothing (a name is ignored, a ":fcNN" attempt gets a question mark).

Reload one game:    DELETE FROM fc_players WHERE game = 26;   then restart the bot.
Turn the import off: set the env var FC_AUTOLOAD=0.
Add a new game (FC 28): node scripts/make-ratings-sql.js file.csv --game 28   (see the top of that script),
                        put the new sql/fc28.sql here, deploy, and raise LATEST_FC.

Check what is loaded:  DATABASE_URL=... node scripts/fc-check.js --stats
Try a lookup:          DATABASE_URL=... node scripts/fc-check.js "lamine yamal:fc25"

Loading by hand (optional)
- Each file creates the table if it is missing, replaces that game's rows, and runs as one transaction, so re-running is safe.
- psql:  psql "YOUR_EXTERNAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/fc26.sql
- The Supabase SQL Editor rejects these files as too large, so use the automatic import or psql.
- All 13 files together are about 240,000 players, roughly 32 MB in the database.

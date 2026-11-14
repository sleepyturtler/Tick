// Loads the party games if their dependency (@napi-rs/canvas) is installed.
// If it is missing the bot still starts: it logs a warning and /game is simply not offered.
let games = null;
try { games = require('./games'); }
catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && /@napi-rs\/canvas/.test(e.message)) console.warn('Party games are disabled: run "npm install" so @napi-rs/canvas is installed.');
    else throw e;
}
module.exports = games;

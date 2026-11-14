// npm test: runs every *.test.js in this folder against stand-ins for Discord and the database. See the note in package.json.
const fs = require('fs'), path = require('path');
const lib = require('./lib');
for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort()) { console.log(f); require(path.join(__dirname, f)); }
lib.runAll().then(fail => process.exit(fail ? 1 : 0));

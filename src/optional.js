// Load a drop-in module that may not exist (path is relative to the src folder, e.g. './killbot').
// Returns null if that file is missing. Any other error, including a missing dependency inside
// the module or a bug in it, still throws so real problems are never hidden.
function optional(name) {
    try { return require(name); }
    catch (e) {
        if (e.code === 'MODULE_NOT_FOUND' && e.message.includes(`'${name}'`)) return null;
        throw e;
    }
}

module.exports = { optional };

// Offline stand-in: the games only need an object that can be drawn on and turned into a PNG buffer.
const ctx = new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => ctx), set: (t, p, v) => { t[p] = v; return true; } });
module.exports = { createCanvas: () => ({ getContext: () => ctx, toBuffer: () => Buffer.alloc(8), width: 1, height: 1 }), loadImage: async () => ({ width: 1, height: 1 }), GlobalFonts: { registerFromPath: () => true } };

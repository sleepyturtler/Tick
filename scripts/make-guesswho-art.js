// Renders the 30 Guess Who portraits into assets/guesswho/ and a contact sheet to look them over.
//   node scripts/make-guesswho-art.js
const fs = require('fs'), path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const { renderCharacter, CHARACTERS } = require('../src/games/guesswho/art3d');

GlobalFonts.registerFromPath(path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf'), 'GFB');
const out = path.join(__dirname, '..', 'assets', 'guesswho');
fs.mkdirSync(out, { recursive: true });

(async () => {
    const t0 = Date.now(), imgs = [];
    for (const ch of CHARACTERS) {
        const buf = renderCharacter(ch, 256, 2);
        fs.writeFileSync(path.join(out, `${ch.name.toLowerCase()}.png`), buf);
        imgs.push(await loadImage(buf));
    }
    const cols = 6, rows = Math.ceil(CHARACTERS.length / cols), cell = 200, pad = 12, label = 30;
    const sheet = createCanvas(cols * (cell + pad) + pad, rows * (cell + label + pad) + pad), g = sheet.getContext('2d');
    g.fillStyle = '#2b2d31'; g.fillRect(0, 0, sheet.width, sheet.height);
    g.textAlign = 'center'; g.font = 'bold 20px GFB';
    CHARACTERS.forEach((ch, i) => {
        const x = pad + (i % cols) * (cell + pad), y = pad + Math.floor(i / cols) * (cell + label + pad);
        g.drawImage(imgs[i], x, y, cell, cell);
        g.fillStyle = '#ffffff'; g.fillText(ch.name, x + cell / 2, y + cell + 22);
    });
    fs.writeFileSync(path.join(out, 'contact-sheet.png'), sheet.toBuffer('image/png'));
    console.log(`rendered ${CHARACTERS.length} portraits in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})();

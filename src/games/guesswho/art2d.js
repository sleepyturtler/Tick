// Flat portraits for the Guess Who characters: plain shapes in solid colours, no shading.
// Used only by scripts/make-guesswho-art.js; the bot just loads the PNGs from assets/guesswho/.
const { createCanvas } = require('@napi-rs/canvas');
const { CHARACTERS, SKIN, HAIR, EYES } = require('./characters');

const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgb = a => '#' + a.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const shade = (h, k) => rgb(hex(h).map(v => v * k));

// Draws one character on a 256x256 design grid, scaled to `size`.
function renderCharacter(ch, size = 256) {
    const cv = createCanvas(size, size), g = cv.getContext('2d');
    g.scale(size / 256, size / 256);
    const skin = SKIN[ch.skin], skinD = shade(skin, 0.86), hair = HAIR[ch.color] ?? '#3b2a20', hairD = shade(hair, 0.8), eye = EYES[ch.eyes];
    const ell = (x, y, rx, ry, color, rot = 0) => { g.fillStyle = color; g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); g.fill(); };
    const circ = (x, y, r, color) => ell(x, y, r, r, color);
    const stroke = (color, w) => { g.strokeStyle = color; g.lineWidth = w; g.lineCap = 'round'; g.lineJoin = 'round'; };

    // background tile
    g.fillStyle = ch.bg; g.beginPath(); g.roundRect(0, 0, 256, 256, 26); g.fill();
    g.save(); g.beginPath(); g.roundRect(0, 0, 256, 256, 26); g.clip();

    // shoulders and collar
    ell(128, 292, 112, 92, ch.shirt);
    g.fillStyle = shade(ch.shirt, 0.82); g.beginPath(); g.moveTo(104, 204); g.lineTo(128, 236); g.lineTo(152, 204); g.closePath(); g.fill();
    // back hair
    if (ch.style === 'long') { g.fillStyle = hair; g.beginPath(); g.moveTo(58, 110); g.bezierCurveTo(48, 190, 52, 236, 70, 256); g.lineTo(186, 256); g.bezierCurveTo(204, 236, 208, 190, 198, 110); g.bezierCurveTo(196, 40, 60, 40, 58, 110); g.fill(); }
    if (ch.style === 'ponytail') { g.save(); g.translate(190, 140); g.rotate(-0.3); ell(0, 0, 17, 44, hair); g.restore(); circ(176, 108, 8, ch.shirt); }
    // neck, ears, head
    g.fillStyle = skinD; g.fillRect(110, 160, 36, 52);
    ell(71, 122, 10, 16, skinD); ell(185, 122, 10, 16, skinD);
    ell(128, 114, 58, 68, skin);
    if (ch.earrings) { circ(71, 142, 5, '#f1c40f'); circ(185, 142, 5, '#f1c40f'); }

    // beard goes behind the mouth, moustache over it
    if (ch.facial === 'beard') { g.fillStyle = hair; g.beginPath(); g.moveTo(70, 120); g.bezierCurveTo(70, 176, 98, 196, 128, 196); g.bezierCurveTo(158, 196, 186, 176, 186, 120); g.bezierCurveTo(176, 144, 156, 148, 128, 148); g.bezierCurveTo(100, 148, 80, 144, 70, 120); g.fill(); }
    // eyes and brows
    for (const x of [104, 152]) { ell(x, 114, 13, 10, '#ffffff'); circ(x, 114, 6.5, eye); circ(x, 114, 3, '#111111'); circ(x + 2, 112, 1.6, '#ffffff'); }
    stroke(ch.style === 'bald' || ch.color === 'none' ? '#3b2a20' : hair, 6);
    g.beginPath(); g.moveTo(90, 96); g.lineTo(118, 94); g.moveTo(138, 94); g.lineTo(166, 96); g.stroke();
    // nose
    stroke(shade(skin, 0.78), 4); g.beginPath(); g.moveTo(130, 120); g.quadraticCurveTo(138, 138, 126, 140); g.stroke();
    // mouth (a lighter colour when there is a beard, so it stays visible)
    const mouthY = ch.facial === 'beard' ? 160 : 156, mouthC = ch.facial === 'beard' ? '#f0b8ad' : '#8a2f2f';
    stroke(mouthC, 5); g.beginPath();
    if (ch.mouth === 'smile') { g.moveTo(108, mouthY - 4); g.quadraticCurveTo(128, mouthY + 16, 148, mouthY - 4); } else { g.moveTo(112, mouthY); g.lineTo(144, mouthY); }
    g.stroke();
    if (ch.facial === 'moustache') { g.fillStyle = hair; g.beginPath(); g.moveTo(128, 144); g.bezierCurveTo(116, 134, 96, 140, 92, 150); g.bezierCurveTo(106, 150, 118, 152, 128, 148); g.bezierCurveTo(138, 152, 150, 150, 164, 150); g.bezierCurveTo(160, 140, 140, 134, 128, 144); g.fill(); }
    // glasses
    if (ch.glasses !== 'none') {
        stroke('#222428', 5);
        for (const x of [104, 152]) { g.beginPath(); if (ch.glasses === 'round') g.arc(x, 114, 20, 0, Math.PI * 2); else g.roundRect(x - 20, 96, 40, 36, 7); g.stroke(); }
        g.beginPath(); g.moveTo(124, 112); g.lineTo(132, 112); g.moveTo(84, 112); g.lineTo(72, 108); g.moveTo(172, 112); g.lineTo(184, 108); g.stroke();
    }

    // hair on top of the head
    const fringe = () => { g.beginPath(); g.moveTo(40, 0); g.lineTo(216, 0); g.lineTo(216, 96); g.bezierCurveTo(186, 74, 160, 90, 128, 72); g.bezierCurveTo(96, 90, 70, 74, 40, 96); g.closePath(); };
    if (ch.style === 'short' || ch.style === 'ponytail' || ch.style === 'bun' || ch.style === 'long') {
        g.save(); fringe(); g.clip(); ell(128, 108, 62, 72, hair); g.restore();
        if (ch.style === 'bun') circ(128, 42, 24, hair);
    }
    if (ch.style === 'curly') {
        for (let a = 165; a <= 375; a += 17) { const r = a * Math.PI / 180; circ(128 + 66 * Math.cos(r), 100 + 74 * Math.sin(r), 21, hair); }
        g.save(); fringe(); g.clip(); ell(128, 104, 60, 70, hair); g.restore();
        for (const x of [66, 190]) circ(x, 116, 15, hair);
    }
    if (ch.style === 'mohawk') { g.fillStyle = hair; g.beginPath(); g.moveTo(106, 70); g.lineTo(108, 26); g.lineTo(118, 40); g.lineTo(124, 14); g.lineTo(132, 40); g.lineTo(140, 20); g.lineTo(148, 70); g.closePath(); g.fill(); }
    // hats
    if (ch.hat === 'cap') {
        const c = ch.shirt; g.fillStyle = c; g.beginPath(); g.moveTo(62, 92); g.bezierCurveTo(60, 30, 196, 30, 194, 92); g.closePath(); g.fill();
        g.fillStyle = shade(c, 0.78); g.beginPath(); g.ellipse(160, 94, 50, 10, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = c; g.fillRect(62, 82, 132, 10);
    }
    if (ch.hat === 'beanie') {
        const c = ch.shirt; g.fillStyle = c; g.beginPath(); g.moveTo(62, 88); g.bezierCurveTo(60, 18, 196, 18, 194, 88); g.closePath(); g.fill();
        g.fillStyle = shade(c, 0.78); g.beginPath(); g.roundRect(58, 74, 140, 24, 10); g.fill();
        circ(128, 22, 13, '#f4f4f4');
    }
    g.restore();
    return cv.toBuffer('image/png');
}

module.exports = { renderCharacter, CHARACTERS };

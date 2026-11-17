// A tiny software 3D renderer: lit, smooth-shaded ellipsoid meshes with a depth buffer, drawn into a canvas.
// Used only by scripts/make-guesswho-art.js to produce the character portraits; the bot just loads the PNGs.
const { createCanvas } = require('@napi-rs/canvas');
const { CHARACTERS, SKIN, HAIR, EYES } = require('./characters');

const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const shade = (rgb, k) => rgb.map(v => Math.max(0, Math.min(255, Math.round(v * k))));
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const PI = Math.PI;

// An ellipsoid (or a patch of one). lat runs bottom -pi/2 to top pi/2, lon runs around the vertical axis with 0 facing the viewer.
function ellipsoid({ c = [0, 0, 0], r = [1, 1, 1], color, lat = [-PI / 2, PI / 2], lon = [-PI, PI], su = 18, sv = 12, tilt = 0, spec = 0.12 }) {
    const rgb = hex(color), tris = [];
    const pts = [];
    for (let i = 0; i <= sv; i++) {
        const th = lat[0] + (lat[1] - lat[0]) * i / sv, row = [];
        for (let j = 0; j <= su; j++) {
            const ph = lon[0] + (lon[1] - lon[0]) * j / su;
            let p = [r[0] * Math.cos(th) * Math.sin(ph), r[1] * Math.sin(th), r[2] * Math.cos(th) * Math.cos(ph)];
            let n = norm([p[0] / (r[0] * r[0]), p[1] / (r[1] * r[1]), p[2] / (r[2] * r[2])]);
            if (tilt) { const ct = Math.cos(tilt), st = Math.sin(tilt); p = [p[0] * ct - p[1] * st, p[0] * st + p[1] * ct, p[2]]; n = [n[0] * ct - n[1] * st, n[0] * st + n[1] * ct, n[2]]; }
            row.push({ p: [p[0] + c[0], p[1] + c[1], p[2] + c[2]], n });
        }
        pts.push(row);
    }
    for (let i = 0; i < sv; i++) for (let j = 0; j < su; j++) {
        const a = pts[i][j], b = pts[i][j + 1], d = pts[i + 1][j], e = pts[i + 1][j + 1];
        tris.push({ v: [a, b, d], rgb, spec }, { v: [b, e, d], rgb, spec });
    }
    return tris;
}
const ball = (c, rad, color, extra = {}) => ellipsoid({ c, r: [rad, rad, rad], color, su: 10, sv: 8, ...extra });

// Rotate a model point/normal for the camera: a little turn to the side and a slight nod, so it reads as 3D.
function camera(yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    return p => { const x = p[0] * cy + p[2] * sy, z = -p[0] * sy + p[2] * cy; return [x, p[1] * cp - z * sp, p[1] * sp + z * cp]; };
}

function rasterize(meshes, size, bg) {
    const W = size, H = size, zbuf = new Float32Array(W * H).fill(-1e9), px = new Uint8ClampedArray(W * H * 4);
    const rot = camera(0.42, -0.1), scale = W * 0.215, cx = W / 2, cy = H * 0.47;
    const L = norm([-0.5, 0.65, 0.75]);
    for (const tri of meshes) {
        const sv = tri.v.map(vt => { const q = rot(vt.p); return { x: cx + q[0] * scale, y: cy - q[1] * scale, z: q[2], n: rot(vt.n) }; });
        const minX = Math.max(0, Math.floor(Math.min(sv[0].x, sv[1].x, sv[2].x))), maxX = Math.min(W - 1, Math.ceil(Math.max(sv[0].x, sv[1].x, sv[2].x)));
        const minY = Math.max(0, Math.floor(Math.min(sv[0].y, sv[1].y, sv[2].y))), maxY = Math.min(H - 1, Math.ceil(Math.max(sv[0].y, sv[1].y, sv[2].y)));
        const [A, B, C] = sv, den = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y);
        if (Math.abs(den) < 1e-9) continue;
        for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
            const w0 = ((B.y - C.y) * (x + 0.5 - C.x) + (C.x - B.x) * (y + 0.5 - C.y)) / den;
            const w1 = ((C.y - A.y) * (x + 0.5 - C.x) + (A.x - C.x) * (y + 0.5 - C.y)) / den, w2 = 1 - w0 - w1;
            if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;
            const z = w0 * A.z + w1 * B.z + w2 * C.z, i = y * W + x;
            if (z <= zbuf[i]) continue;
            zbuf[i] = z;
            const n = norm([w0 * A.n[0] + w1 * B.n[0] + w2 * C.n[0], w0 * A.n[1] + w1 * B.n[1] + w2 * C.n[1], w0 * A.n[2] + w1 * B.n[2] + w2 * C.n[2]]);
            const d = Math.max(0, n[0] * L[0] + n[1] * L[1] + n[2] * L[2]);
            const h = norm([L[0], L[1], L[2] + 1]), s = Math.pow(Math.max(0, n[0] * h[0] + n[1] * h[1] + n[2] * h[2]), 24) * tri.spec * 255;
            const k = 0.52 + 0.62 * d, o = i * 4;
            px[o] = Math.min(255, tri.rgb[0] * k + s); px[o + 1] = Math.min(255, tri.rgb[1] * k + s); px[o + 2] = Math.min(255, tri.rgb[2] * k + s); px[o + 3] = 255;
        }
    }
    return px;
}

// ---- the character model ----
const HEAD = { r: [0.85, 1.0, 0.9] };
const headZ = (x, y) => HEAD.r[2] * Math.sqrt(Math.max(0, 1 - (x / HEAD.r[0]) ** 2 - (y / HEAD.r[1]) ** 2));
function seeded(name) { let s = 0; for (const ch of name) s = (s * 31 + ch.charCodeAt(0)) >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function buildCharacter(ch) {
    const skin = SKIN[ch.skin], skinDark = shade(hex(skin), 0.9), sd = '#' + skinDark.map(v => v.toString(16).padStart(2, '0')).join('');
    const hairC = HAIR[ch.color] ?? '#3b2a20', eyeC = EYES[ch.eyes], t = [];
    const beard = ch.facial === 'beard';
    // body, neck, head, ears
    t.push(...ellipsoid({ c: [0, -2.15, -0.1], r: [1.4, 0.95, 0.75], color: ch.shirt, su: 20, sv: 12 }));
    t.push(...ellipsoid({ c: [0, -1.2, -0.05], r: [0.4, 0.5, 0.4], color: sd, su: 12, sv: 8 }));
    t.push(...ellipsoid({ c: [0, 0, 0], r: HEAD.r, color: skin, su: 28, sv: 20, spec: 0.2 }));
    for (const s of [-1, 1]) {
        t.push(...ellipsoid({ c: [s * 0.86, -0.05, -0.05], r: [0.12, 0.22, 0.13], color: sd, su: 10, sv: 8 }));
        if (ch.earrings) t.push(...ball([s * 0.9, -0.34, -0.04], 0.075, '#f1c40f', { spec: 0.6 }));
    }
    // beard shell and the surface height of the face where features sit
    const beardZ = (x, y) => { const k = 1 - (x / 0.82) ** 2 - ((y + 0.45) / 0.72) ** 2; return k > 0 && y < -0.3 ? 0.12 + 0.82 * Math.sqrt(k) : -9; };
    const faceZ = (x, y) => Math.max(headZ(x, y), beard ? beardZ(x, y) : -9);
    if (beard) t.push(...ellipsoid({ c: [0, -0.45, 0.12], r: [0.82, 0.72, 0.82], color: hairC, lat: [-PI / 2, 0.15], lon: [-1.95, 1.95], su: 22, sv: 12 }));
    // eyes, brows, nose
    for (const s of [-1, 1]) {
        const ex = s * 0.32, ey = 0.2, ez = headZ(ex, ey);
        t.push(...ellipsoid({ c: [ex, ey, ez - 0.03], r: [0.15, 0.12, 0.09], color: '#fbfbfb', su: 10, sv: 8, spec: 0.5 }));
        t.push(...ellipsoid({ c: [ex, ey, ez + 0.03], r: [0.075, 0.075, 0.05], color: eyeC, su: 10, sv: 8, spec: 0.6 }));
        t.push(...ball([ex, ey, ez + 0.075], 0.032, '#0c0c0c', { spec: 0.9 }));
        t.push(...ellipsoid({ c: [ex, 0.43, headZ(ex, 0.43) + 0.01], r: [0.2, 0.04, 0.05], color: hairC, tilt: -s * 0.12, su: 10, sv: 6 }));
    }
    t.push(...ellipsoid({ c: [0, -0.06, headZ(0, -0.06) + 0.04], r: [0.11, 0.15, 0.13], color: skin, su: 10, sv: 8 }));
    // mouth
    for (let k = -8; k <= 8; k++) {
        const x = k * 0.04, y = (ch.mouth === 'smile' ? -0.53 + 0.17 * (k / 8) ** 2 : -0.5), z = faceZ(x, y) + 0.015;
        t.push(...ball([x, y, z], 0.036, '#6e2323', { spec: 0.3, su: 8, sv: 6 }));
    }
    if (ch.facial === 'moustache') for (const s of [-1, 1]) t.push(...ellipsoid({ c: [s * 0.14, -0.28, headZ(s * 0.14, -0.28) + 0.04], r: [0.19, 0.06, 0.1], color: hairC, tilt: -s * 0.28, su: 10, sv: 8 }));
    // glasses drawn as rings of small beads
    if (ch.glasses !== 'none') {
        for (const s of [-1, 1]) {
            const cx = s * 0.32, cy = 0.2;
            const n = ch.glasses === 'square' ? 24 : 18;
            for (let a = 0; a < n; a++) {
                let dx, dy;
                if (ch.glasses === 'square') {   // walk the perimeter of a rectangle at equal steps
                    const w = 0.2, h = 0.16, per = 2 * (2 * w + 2 * h), d = a / n * per;
                    if (d < 2 * w) { dx = -w + d; dy = h; } else if (d < 2 * w + 2 * h) { dx = w; dy = h - (d - 2 * w); }
                    else if (d < 4 * w + 2 * h) { dx = w - (d - 2 * w - 2 * h); dy = -h; } else { dx = -w; dy = -h + (d - 4 * w - 2 * h); }
                } else { const ang = a / n * PI * 2; dx = Math.cos(ang) * 0.21; dy = Math.sin(ang) * 0.21; }
                const x = cx + dx, y = cy + dy;
                t.push(...ball([x, y, headZ(x, y) + 0.07], 0.036, '#202124', { spec: 0.5, su: 8, sv: 6 }));
            }
        }
        t.push(...ball([0, 0.2, headZ(0, 0.2) + 0.08], 0.034, '#202124'));
    }
    // hair and hats
    const hatC = ch.shirt, rnd = seeded(ch.name);
    const top = lat0 => ellipsoid({ c: [0, 0.04, -0.02], r: [0.93, 1.08, 0.99], color: hairC, lat: [lat0, PI / 2], su: 26, sv: 12 });
    const back = (r0, r1) => ellipsoid({ c: [0, 0.04, -0.02], r: [0.93, 1.08, 0.99], color: hairC, lat: [-0.55, 0.6], lon: [r0, r1], su: 16, sv: 10 });
    const style = ch.style;
    if (style !== 'bald' && ch.hat !== 'beanie') {
        if (style === 'short' || style === 'ponytail' || style === 'bun') { t.push(...top(0.52)); t.push(...back(1.55, 4.73)); }
        if (style === 'long') { t.push(...top(0.5)); t.push(...ellipsoid({ c: [0, -0.7, -0.3], r: [1.0, 1.4, 0.78], color: hairC, lon: [1.0, 5.28], su: 22, sv: 14 })); }
        if (style === 'ponytail') { t.push(...ellipsoid({ c: [0, -0.35, -1.05], r: [0.24, 0.75, 0.24], color: hairC, tilt: 0.1, su: 10, sv: 8 })); t.push(...ball([0, 0.2, -0.98], 0.17, ch.shirt)); }
        if (style === 'bun') t.push(...ball([0, 1.2, -0.15], 0.36, hairC, { su: 12 }));
        if (style === 'curly') {
            for (let i = 0; i < 34; i++) {
                const th = 0.05 + rnd() * 1.4, ph = (rnd() - 0.5) * 2 * 2.9 + (rnd() < 0.3 ? PI : 0);
                const x = 1.02 * Math.cos(th) * Math.sin(ph), y = 0.04 + 1.15 * Math.sin(th), z = -0.02 + 1.04 * Math.cos(th) * Math.cos(ph);
                if (z > 0.55 && y < 0.6) continue;
                t.push(...ball([x, y, z], 0.29 + rnd() * 0.08, hairC, { su: 10, sv: 8 }));
            }
        }
        if (style === 'mohawk') for (let i = 0; i < 9; i++) { const a = -0.5 + i / 8 * 2.9; t.push(...ellipsoid({ c: [0, 0.04 + 1.1 * Math.cos(a - 1.1) + 0.05, -0.02 + 1.0 * Math.sin(1.1 - a) * 0.95], r: [0.11, 0.34, 0.2], color: hairC, su: 8, sv: 6 })); }
    }
    if (ch.hat === 'cap') {
        t.push(...ellipsoid({ c: [0, 0.1, -0.02], r: [0.97, 1.08, 1.02], color: hatC, lat: [0.12, PI / 2], su: 26, sv: 12 }));
        t.push(...ellipsoid({ c: [0, 0.5, 1.0], r: [0.66, 0.06, 0.55], color: shade(hex(hatC), 0.85).reduce((a, v) => a + v.toString(16).padStart(2, '0'), '#'), su: 16, sv: 6 }));
    }
    if (ch.hat === 'beanie') {
        t.push(...ellipsoid({ c: [0, 0.06, -0.02], r: [0.99, 1.18, 1.04], color: hatC, lat: [0.5, PI / 2], su: 26, sv: 12 }));
        t.push(...ellipsoid({ c: [0, 0.06, -0.02], r: [1.0, 1.19, 1.05], color: shade(hex(hatC), 0.8).reduce((a, v) => a + v.toString(16).padStart(2, '0'), '#'), lat: [0.42, 0.62], su: 26, sv: 4 }));
        t.push(...ball([0, 1.3, -0.05], 0.22, '#f2f2f2'));
    }
    return t;
}

// Renders one character to a size x size PNG buffer (transparent corners, soft background tile).
function renderCharacter(ch, size = 256, ss = 2) {
    const big = size * ss, pix = rasterize(buildCharacter(ch), big, null);
    const model = createCanvas(big, big), mctx = model.getContext('2d'), img = mctx.createImageData(big, big);
    img.data.set(pix); mctx.putImageData(img, 0, 0);
    const out = createCanvas(size, size), g = out.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    const r = size * 0.1, bgc = ch.bg;
    g.fillStyle = bgc; g.beginPath(); g.roundRect(0, 0, size, size, r); g.fill();
    const grad = g.createRadialGradient(size * 0.4, size * 0.3, size * 0.05, size * 0.5, size * 0.5, size * 0.75);
    grad.addColorStop(0, 'rgba(255,255,255,0.55)'); grad.addColorStop(1, 'rgba(0,0,0,0.12)');
    g.fillStyle = grad; g.beginPath(); g.roundRect(0, 0, size, size, r); g.fill();
    g.save(); g.beginPath(); g.roundRect(0, 0, size, size, r); g.clip();
    g.drawImage(model, 0, 0, big, big, 0, 0, size, size);
    g.restore();
    return out.toBuffer('image/png');
}

module.exports = { renderCharacter, CHARACTERS };

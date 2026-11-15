// The website: landing and status, terms, privacy, the logos, /health and /stats.
const { assert, test } = require('./lib');
const http = require('http');
const client = require('../src/client');
const cfg = require('../src/config');
const web = require('../src/web/server');

let server, base;
async function start() {
    if (server) return;
    server = web.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
    server.unref();
}
const get = async (path, opts) => { await start(); const r = await fetch(base + path, opts); return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), body: Buffer.from(await r.arrayBuffer()) }; };
const page = async path => { const r = await get(path); return { ...r, html: r.body.toString('utf8') }; };
// discord.js has no client.user until the bot is ready
const online = on => { client._ready = on; client.user = on ? { id: '4242' } : null; };

test('the landing page: logo, invite button, links, features, online status', async () => {
    online(true);
    const { status, type, html } = await page('/');
    assert.equal(status, 200); assert.match(type, /text\/html/);
    assert.match(html, /<title>Tick \| Discord counting bot<\/title>/);
    assert.ok(html.includes('src="/banner.png"') && html.includes('href="/icon.png"'));
    assert.ok(html.includes(`href="${cfg.inviteUrl('4242').replace(/&/g, '&amp;')}"`), 'the invite button uses the live bot id');
    assert.ok((html.match(/Add to server|Add Tick to your server/g) ?? []).length >= 2, 'a button in the header and a big one on the page');
    for (const link of ['https://top.gg/bot/1507450543419822242', 'https://github.com/sleepyturtler/Tick', 'https://discord.gg/Qrp82cRhUW', 'href="/terms"', 'href="/privacy"']) assert.ok(html.includes(link), link);
    for (const word of ['Interactive', 'Countdown', 'Modifiers', 'Floors', '2x+3=13', 'lamine yamal:fc25', 'Battleship', 'Ranked or friendly', '/setup']) assert.ok(html.includes(word), word);
    assert.match(html, /Online/);
});
test('the landing page says so when the Discord connection is down, and still serves', async () => {
    online(false); const { status, html } = await page('/');
    assert.equal(status, 200); assert.match(html, /currently offline/); assert.doesNotMatch(html, /&#9679; Online/);
    assert.ok(html.includes(cfg.inviteUrl(cfg.DEFAULT_CLIENT_ID).replace(/&/g, '&amp;')), 'the invite button falls back to the configured id');
});
test('the invite link is the same one /invite gives', () => {
    const u = cfg.inviteUrl('123');
    assert.match(u, /^https:\/\/discord\.com\/oauth2\/authorize\?client_id=123&permissions=\d+&scope=bot%20applications\.commands$/);
});
test('terms: the sections, the open source link, the footer links', async () => {
    const { status, html } = await page('/terms'); assert.equal(status, 200);
    for (const s of ['Terms of Service', 'What the Bot does', 'Open source', 'Acceptable use', 'Leaderboards and ratings', 'Player ratings', 'No warranty', 'Limitation of liability', 'Termination', 'Changes', 'Contact', 'Last updated: November 15, 2026', 'Electronic Arts']) assert.ok(html.includes(s), s);
    assert.ok(html.includes('https://github.com/sleepyturtler/Tick') && html.includes('https://top.gg/bot/1507450543419822242') && html.includes('https://discord.gg/Qrp82cRhUW'));
    assert.match(html, /win trading|trading wins/);
});
test('privacy: what is stored, what is read, what is public, retention and deletion', async () => {
    const { status, html } = await page('/privacy'); assert.equal(status, 200);
    for (const s of ['Privacy Policy', 'Data we store', 'Member stats', 'Fail roles', 'Games', 'Ratings and results', 'What the Bot reads', 'Message Content intent', 'What is public', 'Retention and deletion', 'Render', 'PostgreSQL', "Children's privacy"]) assert.ok(html.includes(s), s);
    assert.match(html, /deleted automatically 7 days later/);
    assert.match(html, /If the Bot is added back within that time, nothing is deleted/);
    assert.match(html, /belong to the player and are not tied to a server/);
    assert.match(html, /not stored|is not stored/);
});
test('the pages hold nothing left over from the other bot, and no scripts', async () => {
    for (const p of ['/', '/terms', '/privacy']) {
        const { html } = await page(p);
        assert.doesNotMatch(html, /notifyer|youtube|tiktok|instagram|twitch|kick\.com|oauth callback|websub/i, p);
        assert.doesNotMatch(html, /<script/i, p); assert.doesNotMatch(html, /\u2014/, `${p}: no long dashes`);
    }
});
test('every page has the shared header, footer and link preview', async () => {
    for (const p of ['/', '/terms', '/privacy']) {
        const { html } = await page(p);
        assert.ok(html.includes('class="brand"') && html.includes('<footer>') && html.includes('og:image') && html.includes('rel="icon"'), p);
        assert.match(html, /viewport/);
    }
});
test('the logos are served as PNG files with caching, and /favicon.ico works', async () => {
    for (const p of ['/icon.png', '/banner.png', '/favicon.ico']) {
        const r = await get(p); assert.equal(r.status, 200, p); assert.equal(r.type, 'image/png'); assert.match(r.cache, /max-age=86400/);
        assert.deepEqual([...r.body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${p} is a PNG`);
    }
    assert.ok((await get('/banner.png')).body.length < 300_000, 'the banner is small enough for a landing page');
});
test('/health is OK while connected, and only turns 503 after the connection has been down a while', () => {
    online(true); assert.deepEqual(web.healthStatus(), { code: 200, text: 'OK' });
    online(false);
    const t0 = Date.now();
    assert.equal(web.healthStatus(t0).code, 200, 'just disconnected');
    assert.equal(web.healthStatus(t0 + web.HEALTH_UNREADY_MS - 1000).code, 200, 'still inside the window');
    assert.equal(web.healthStatus(t0 + web.HEALTH_UNREADY_MS + 1000).code, 503, 'down too long');
    online(true); assert.equal(web.healthStatus().code, 200, 'back up, the clock resets');
    online(false); assert.equal(web.healthStatus(Date.now() + 1000).code, 200);
    online(true);
});
test('/health over HTTP is plain text', async () => {
    online(true); const r = await get('/health'); assert.equal(r.status, 200); assert.equal(r.body.toString(), 'OK'); assert.match(r.type, /text\/plain/);
});
test('/stats gives only the server count, and 503 until the bot is ready', async () => {
    online(false); assert.equal((await get('/stats')).status, 503);
    online(true); client.guilds.cache.clear(); client.guilds.cache.set('a', {}); client.guilds.cache.set('b', {});
    const r = await get('/stats'); assert.equal(r.status, 200); assert.match(r.type, /application\/json/); assert.deepEqual(JSON.parse(r.body.toString()), { servers: 2 });
    client.guilds.cache.clear();
});
test('unknown paths are 404, other methods 405, query strings are ignored, HEAD has no body', async () => {
    assert.equal((await get('/nope')).status, 404); assert.equal((await get('/admin')).status, 404); assert.equal((await get('/.env')).status, 404);
    assert.equal((await get('/terms?utm=x')).status, 200);
    assert.equal((await get('/', { method: 'POST' })).status, 405);
    const head = await get('/privacy', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.body.length, 0);
});
test('a hostile Host header cannot inject anything into the page', () => {
    online(true);
    const out = {}; const res = { headersSent: false, writeHead(c, h) { out.code = c; }, end(b) { out.body = String(b); } };
    web.handle({ method: 'GET', url: '/', headers: { host: '"><img src=x onerror=alert(1)>' } }, res);
    assert.equal(out.code, 200); assert.doesNotMatch(out.body, /onerror|<img src=x/); assert.match(out.body, /og:image" content="\/banner\.png"/);
});
test('a configured public address is used for the preview image', () => {
    process.env.PUBLIC_URL = 'https://tick.example/'; const out = {};
    try { web.handle({ method: 'GET', url: '/terms', headers: {} }, { headersSent: false, writeHead() {}, end(b) { out.body = String(b); } }); } finally { delete process.env.PUBLIC_URL; }
    assert.ok(out.body.includes('og:image" content="https://tick.example/banner.png"'));
});
test('a failure while building a page is a 500, never a crash', () => {
    const was = client.isReady; client.isReady = () => { throw new Error('boom'); };
    const out = {}; const err = console.error; console.error = () => {};
    try { web.handle({ method: 'GET', url: '/', headers: {} }, { headersSent: false, writeHead(c) { out.code = c; }, end() {} }); } finally { client.isReady = was; console.error = err; }
    assert.equal(out.code, 500);
});

test('leave the shared client as other suites expect it', () => { client._ready = false; client.user = { id: 'botid' }; });

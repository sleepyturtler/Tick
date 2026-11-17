// The HTTP server: the website (landing and status, terms, privacy), the logos, /health for the host, and /stats for a server-count badge.
const http = require('http');
const fs = require('fs');
const path = require('path');
const client = require('../client');
const { DEFAULT_CLIENT_ID } = require('../config');
const { buildLandingHTML, buildTermsHTML, buildPrivacyHTML } = require('./pages');

// The logos are read once. A missing file only means that image is a 404.
const ASSETS = path.join(__dirname, '..', '..', 'assets', 'web');
const readAsset = name => { try { return fs.readFileSync(path.join(ASSETS, name)); } catch { return null; } };
const FILES = { '/icon.png': readAsset('icon.png'), '/favicon.ico': readAsset('icon.png'), '/banner.png': readAsset('banner.png') };

// /health says 503 once the Discord connection has been down for HEALTH_UNREADY_MS (default 5 minutes, which also covers a slow
// start), so a host with a health check restarts a bot whose gateway died while this server stayed up.
const HEALTH_UNREADY_MS = parseInt(process.env.HEALTH_UNREADY_MS, 10) > 0 ? parseInt(process.env.HEALTH_UNREADY_MS, 10) : 5 * 60 * 1000;
let unreadySince = Date.now();
function healthStatus(now = Date.now()) {
    if (client.isReady()) { unreadySince = null; return { code: 200, text: 'OK' }; }
    if (!unreadySince) unreadySince = now;
    return now - unreadySince > HEALTH_UNREADY_MS ? { code: 503, text: 'Discord connection down' } : { code: 200, text: 'OK' };
}

// Where this site lives, for the link preview image: the configured address, or the one the request came to.
function baseUrlOf(req) {
    const configured = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
    if (configured) return configured.replace(/\/$/, '');
    const host = String(req.headers?.host || '');
    return /^[a-z0-9.\-:]+$/i.test(host) ? `https://${host}` : '';
}
const ctxOf = req => ({ baseUrl: baseUrlOf(req), clientId: client.user?.id || DEFAULT_CLIENT_ID });

const html = (res, body) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(body); };
const text = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(body); };

function handle(req, res) {
    // A bad request gets a 500 instead of taking the whole bot down.
    try {
        const method = req.method || 'GET';
        const route = String(req.url || '/').split('?')[0];
        if (method !== 'GET' && method !== 'HEAD') return text(res, 405, 'Method not allowed');
        if (route === '/health') { const h = healthStatus(); return text(res, h.code, h.text); }
        // Only the server count is public. 503 while the gateway is not ready, so a badge keeps its last good value instead of a wrong 0.
        if (route === '/stats') {
            if (!client.isReady()) return text(res, 503, 'Not ready');
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
            return res.end(JSON.stringify({ servers: client.guilds.cache.size }));
        }
        if (route === '/') return html(res, buildLandingHTML(ctxOf(req), { online: client.isReady() }));
        if (route === '/terms') return html(res, buildTermsHTML(ctxOf(req)));
        if (route === '/privacy') return html(res, buildPrivacyHTML(ctxOf(req)));
        if (FILES[route]) {
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
            return res.end(FILES[route]);
        }
        return text(res, 404, 'Not found');
    } catch (e) {
        console.error('HTTP request handling:', e.message);
        if (!res.headersSent) text(res, 500, 'Internal error');
    }
}

const createServer = () => http.createServer(handle);
function listen(port = process.env.PORT || 3000) {
    return createServer().listen(port, () => console.log(`HTTP on port ${port}`));
}

module.exports = { handle, createServer, listen, healthStatus, HEALTH_UNREADY_MS };

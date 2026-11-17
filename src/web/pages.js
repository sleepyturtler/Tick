// The public website: landing and status page, Terms of Service and Privacy Policy. Plain server-rendered HTML, no scripts.
// Every page shares one layout: a header with the logo and the invite button, the content, and a footer with the links.
const { SUPPORT_URL, GITHUB_URL, TOPGG_URL, inviteUrl, GUILD_PURGE_GRACE_MS } = require('../config');

const LEGAL_LAST_UPDATED = 'November 15, 2026';
const LEGAL_EMAIL = process.env.LEGAL_CONTACT_EMAIL || '';
const GRACE_DAYS = Math.max(1, Math.round(GUILD_PURGE_GRACE_MS / 86_400_000));

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
:root{--accent:#22CE60;--accent-dark:#17a64c;--bg:#ffffff;--card:#f4f7f5;--text:#16201a;--muted:#5b6b61;--line:#dbe4de;--danger-bg:#f8d7da;--danger:#842029}
@media (prefers-color-scheme:dark){:root{--bg:#0f1512;--card:#17201b;--text:#e8f0ea;--muted:#9bb0a2;--line:#26332b;--danger-bg:#3a1a1e;--danger:#f1aeb5}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.65}
a{color:var(--accent-dark)}@media (prefers-color-scheme:dark){a{color:var(--accent)}}
header{border-bottom:1px solid var(--line)}
.bar{max-width:880px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:1.2em;color:var(--text);text-decoration:none;margin-right:auto}
.brand img{width:34px;height:34px;border-radius:8px}
nav{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
nav a{text-decoration:none;color:var(--muted);font-weight:500}nav a:hover{color:var(--text)}
.btn{display:inline-block;background:var(--accent);color:#fff!important;font-weight:700;text-decoration:none;padding:10px 20px;border-radius:10px}
.btn:hover{background:var(--accent-dark)}
.btn.big{font-size:1.15em;padding:14px 30px}
nav a.btn{color:#fff;padding:7px 14px;font-size:.95em}
main{max-width:880px;margin:0 auto;padding:10px 20px 50px}
.hero{text-align:center;padding:26px 0 8px}
.hero img.banner{width:100%;max-width:620px;height:auto;border-radius:16px}
.hero p.lead{font-size:1.15em;max-width:640px;margin:18px auto}
.links{display:flex;gap:18px;justify-content:center;flex-wrap:wrap;margin-top:16px}
.status{display:inline-block;margin:6px 0 0;font-size:.95em;color:var(--muted)}
.status.down{background:var(--danger-bg);color:var(--danger);padding:10px 14px;border-radius:8px}
.ok{color:var(--accent-dark);font-weight:700}@media (prefers-color-scheme:dark){.ok{color:var(--accent)}}
h1{font-size:2em;margin:28px 0 6px}h2{margin-top:32px;font-size:1.35em}
.updated{color:var(--muted);font-size:.9em;margin-top:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px;margin-top:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.card h3{margin:0 0 6px;font-size:1.05em}.card p{margin:0;color:var(--muted)}
code{background:var(--card);border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:.92em}
li{margin:5px 0}
footer{border-top:1px solid var(--line);color:var(--muted);font-size:.92em}
footer .bar{justify-content:space-between}
footer a{color:var(--muted)}
.fine{max-width:880px;margin:0 auto;padding:0 20px 28px;color:var(--muted);font-size:.85em}
`;

// ctx: { baseUrl, clientId } where baseUrl (no trailing slash) is only used for the link preview image
function layout(ctx, { title, description, body }) {
    const base = esc(ctx.baseUrl || '');
    const invite = esc(inviteUrl(ctx.clientId));
    const desc = esc(description || 'Tick is a Discord counting bot with five counting modes, math expressions, football player ratings and ranked games.');
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${desc}"><meta name="theme-color" content="#22CE60">
<link rel="icon" type="image/png" href="/icon.png">
<meta property="og:site_name" content="Tick"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${desc}">
<meta property="og:image" content="${base}/banner.png"><meta name="twitter:card" content="summary_large_image">
<style>${CSS}</style></head><body>
<header><div class="bar"><a class="brand" href="/"><img src="/icon.png" alt="Tick logo" width="34" height="34"><span>Tick</span></a>
<nav><a href="/">Home</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a class="btn" href="${invite}">Add to server</a></nav></div></header>
<main>${body}</main>
<footer><div class="bar"><span>Tick</span><span><a href="/terms">Terms of Service</a> &nbsp;&middot;&nbsp; <a href="/privacy">Privacy Policy</a> &nbsp;&middot;&nbsp; <a href="${esc(TOPGG_URL)}">top.gg</a> &nbsp;&middot;&nbsp; <a href="${esc(GITHUB_URL)}">GitHub</a> &nbsp;&middot;&nbsp; <a href="${esc(SUPPORT_URL)}">Support server</a></span></div></footer>
<p class="fine">Tick is not affiliated with, endorsed by or sponsored by Discord Inc. or Electronic Arts Inc.</p>
</body></html>`;
}

const contactHtml = () => (LEGAL_EMAIL ? `<a href="mailto:${esc(LEGAL_EMAIL)}">${esc(LEGAL_EMAIL)}</a> or the <a href="${esc(SUPPORT_URL)}">support server</a>` : `the <a href="${esc(SUPPORT_URL)}">support server</a>`);

// ---------- landing and status ----------
function buildLandingHTML(ctx, { online }) {
    const status = online
        ? '<p class="status">Status: <span class="ok">&#9679; Online</span></p>'
        : '<p class="status down">&#128308; <strong>Tick is currently offline</strong>. This page is still up, but the Discord connection is not. Check back shortly.</p>';
    return layout(ctx, {
        title: 'Tick | Discord counting bot',
        body: `
<section class="hero">
<img class="banner" src="/banner.png" alt="Tick" width="1000" height="422">
<p class="lead">Tick is a Discord counting bot with five counting modes, math expressions and equations, football player ratings, and ranked games with Elo.</p>
<p><a class="btn big" href="${esc(inviteUrl(ctx.clientId))}">Add Tick to your server</a></p>
<div class="links"><a href="${esc(TOPGG_URL)}">View on top.gg</a><a href="${esc(GITHUB_URL)}">Source on GitHub</a><a href="${esc(SUPPORT_URL)}">Support server</a></div>
${status}
</section>

<h2>What it does</h2>
<div class="grid">
<div class="card"><h3>Five counting modes</h3><p>Interactive (with shared saves and a fail role), Simple, Countdown, Modifiers and Floors. A server can run several counting channels, each with its own mode.</p></div>
<div class="card"><h3>Math in the count</h3><p>Count with expressions like <code>2+3*4</code> or <code>pi^2</code>, or with an equation: <code>2x+3=13</code> counts as 5.</p></div>
<div class="card"><h3>Football player ratings</h3><p>Type a player with a game tag, like <code>lamine yamal:fc25</code>, and their EA FC overall is your number. It works from FIFA 15 to FC 27, and inside expressions too.</p></div>
<div class="card"><h3>Stats and leaderboards</h3><p>Per-member stats, a server leaderboard, a global leaderboard and high scores for every mode.</p></div>
<div class="card"><h3>Games</h3><p>Tic-Tac-Toe, Connect 4, Hangman, Would you rather, Truth or dare, Impostor, Guess Who and Battleship, right in the channel.</p></div>
<div class="card"><h3>Ranked or friendly</h3><p>The two-player games can be ranked, with a bot-wide Elo rating and leaderboards, or friendly with nothing at stake.</p></div>
</div>

<h2>Get started</h2>
<ol>
<li>Add Tick to your server with the button above.</li>
<li>An admin runs <code>/counting channel</code> to choose the counting channel, and <code>/counting settings</code> to set the mode and the rest.</li>
<li>Start counting. <code>/help</code> explains the modes, the commands and the expressions.</li>
</ol>

<h2>Legal</h2>
<p><a href="/terms">Terms of Service</a> &nbsp;&middot;&nbsp; <a href="/privacy">Privacy Policy</a></p>`,
    });
}

// ---------- terms ----------
function buildTermsHTML(ctx) {
    return layout(ctx, {
        title: 'Terms of Service | Tick',
        description: 'The terms for using the Tick Discord bot.',
        body: `
<h1>Terms of Service</h1>
<p class="updated">Last updated: ${LEGAL_LAST_UPDATED}</p>
<p>These Terms govern your use of the Tick Discord bot ("the Bot"). By adding the Bot to a server or using its commands, buttons or counting channels, you agree to these Terms.</p>

<h2>What the Bot does</h2>
<p>The Bot runs counting channels in several modes, checks the numbers, expressions, equations and football player names that members type, keeps stats and leaderboards, and hosts games such as Tic-Tac-Toe, Connect 4, Hangman, Would you rather, Truth or dare, Impostor, Guess Who and Battleship. The two-player games can be ranked, with an Elo rating that is shared across every server the Bot is in, or friendly.</p>

<h2>Open source</h2>
<p>The Bot is open source. The code is at <a href="${esc(GITHUB_URL)}">${esc(GITHUB_URL)}</a>, and you are welcome to read it, fork it or run your own copy. These Terms apply to the hosted Bot, not to copies you run yourself.</p>

<h2>Acceptable use</h2>
<ul>
<li>You must follow Discord's <a href="https://discord.com/terms">Terms of Service</a> and <a href="https://discord.com/guidelines">Community Guidelines</a> while using the Bot.</li>
<li>Don't cheat or manipulate the Bot: no scripts or self-bots that count for you, no exploiting bugs, and no trading wins between accounts or otherwise rigging games, Elo ratings, stats or leaderboards.</li>
<li>Don't use the Bot to spam or harass anyone, or to disrupt a server.</li>
<li>Don't attempt to overload, attack or reverse-engineer the Bot's hosted infrastructure.</li>
<li>Server administrators are responsible for how the Bot is configured in their server, including counting channels, access roles and the fail role it can give, and for letting their members know how it works.</li>
</ul>

<h2>Leaderboards and ratings</h2>
<p>Stats, leaderboards and Elo ratings are public features. Your Discord user and your counts or rating can be shown to other users, including in the global leaderboard. We may correct, reset or remove stats, ratings and leaderboard entries that result from cheating, bugs or abuse.</p>

<h2>Player ratings</h2>
<p>The Bot's football player ratings are reference data. They may be incomplete or inaccurate, and are not official. The Bot is not affiliated with, endorsed by or sponsored by Electronic Arts Inc. EA SPORTS FC, FIFA and the names of players and clubs belong to their respective owners.</p>

<h2>No warranty</h2>
<p>The Bot is provided "as is", without warranty of any kind. It may be offline, slow or wrong at times, counts and stats may be lost or reset, and we don't guarantee uninterrupted availability or that it is free of errors.</p>

<h2>Limitation of liability</h2>
<p>To the maximum extent permitted by law, the Bot's operator is not liable for any indirect, incidental or consequential damages arising from your use of, or inability to use, the Bot.</p>

<h2>Termination</h2>
<p>We may suspend or terminate the Bot's access to a server or a user, or discontinue the Bot entirely, at any time. You can remove the Bot from your server at any time in Discord's server settings. What happens to a server's data then is described in the <a href="/privacy">Privacy Policy</a>.</p>

<h2>Changes</h2>
<p>We may update these Terms from time to time. Continued use of the Bot after changes are posted means you accept the revised Terms.</p>

<h2>Contact</h2>
<p>Questions about these Terms can be sent via ${contactHtml()}.</p>`,
    });
}

// ---------- privacy ----------
function buildPrivacyHTML(ctx) {
    return layout(ctx, {
        title: 'Privacy Policy | Tick',
        description: 'What data the Tick Discord bot stores and how it is used.',
        body: `
<h1>Privacy Policy</h1>
<p class="updated">Last updated: ${LEGAL_LAST_UPDATED}</p>
<p>This Privacy Policy explains what data the Tick Discord bot ("the Bot") stores and how it is used.</p>

<h2>Data we store</h2>
<ul>
<li><b>Server settings:</b> the Discord server (guild) ID, the IDs of the counting channels and of the access and fail roles you set, the counting settings you choose, and the server's shared saves.</li>
<li><b>Counting channel state:</b> for each counting channel, its mode, the current count, high scores and the ID of the last member and last message that counted.</li>
<li><b>Member stats:</b> for each member in each server, their Discord user ID with how many counts were correct, how many ruined the count and how many saves they used. Discord names are fetched from Discord when they are shown, they are not stored with the stats.</li>
<li><b>Fail roles:</b> the member ID, the role ID and the time a temporary fail role ends.</li>
<li><b>Games:</b> while a game is running, its state is saved so it can survive a restart: the players' Discord user IDs and display names, the moves made, and the channel and message IDs. A saved game is removed when it ends or after about 30 minutes without activity.</li>
<li><b>Ratings and results:</b> for the ranked two-player games, a player's Discord user ID with their Elo rating and their wins, losses and draws for each game. This is shared across all servers. To enforce a short cooldown against win trading, the Bot also keeps which two players last had a ranked game against each other, and when, only until that cooldown is over.</li>
<li><b>Short-lived technical data:</b> message IDs, kept for a few minutes so a message is never counted twice, and a flag recording that a server has already received the welcome message.</li>
</ul>

<h2>What the Bot reads</h2>
<p>The Bot needs Discord's Message Content intent to work. It reads message text in the channels you set up for counting, to check numbers, expressions, equations and player names, and in channels where a game waits for a typed answer, such as a Hangman guess. It also notices edits and deletions of counted messages to enforce the counting rules. Message text is used in that moment and is not stored. The Bot does not read or store direct messages.</p>

<h2>How we use data</h2>
<p>Data is used only to run the Bot's features: counting, stats, leaderboards, fail roles and games. We don't sell data, use it for advertising or share it with third parties. The Bot's hosting provider (currently Render) and its managed PostgreSQL database process the data on our behalf.</p>

<h2>What is public</h2>
<p>Leaderboards show Discord users together with their counts. The server leaderboard is visible in that server, and the global leaderboard and the Elo leaderboards show members across every server the Bot is in.</p>

<h2>Retention and deletion</h2>
<ul>
<li><b>Removing the Bot from a server:</b> that server's data (its settings, counting channels, member stats, fail roles and saved games) is queued for deletion and deleted automatically ${GRACE_DAYS} days later. If the Bot is added back within that time, nothing is deleted.</li>
<li><b>Removing a counting channel</b> deletes that channel's stored state straight away.</li>
<li><b>Elo ratings and results</b> belong to the player and are not tied to a server, so they are kept after a server's data is deleted. They are deleted when you ask us to.</li>
<li><b>To ask for your data to be deleted</b> or to ask what is stored about you or your server, contact us via ${contactHtml()}.</li>
</ul>

<h2>Third-party services</h2>
<p>The Bot communicates with Discord's API. Discord's own <a href="https://discord.com/privacy">Privacy Policy</a> governs what you share with Discord.</p>

<h2>Security</h2>
<p>Data is stored in a private database that is not exposed through any public endpoint. No storage method is completely secure, but we take reasonable steps to protect what is stored.</p>

<h2>Children's privacy</h2>
<p>The Bot is not directed at children under 13, in line with Discord's own age requirements.</p>

<h2>Changes</h2>
<p>We may update this Privacy Policy from time to time. Material changes will be reflected by updating the "Last updated" date above.</p>

<h2>Contact</h2>
<p>Questions about this policy, or requests to access or delete your data, can be sent via ${contactHtml()}.</p>`,
    });
}

module.exports = { buildLandingHTML, buildTermsHTML, buildPrivacyHTML, esc, layout };

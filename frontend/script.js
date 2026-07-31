'use strict';

const API = '/api';
const $ = (sel) => document.querySelector(sel);

let matchup = null;      // current global matchup
let voting = false;
let dailyMatchup = null; // current daily matchup
let dailyVoting = false;
let countdownTimer = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function outcomeLabel(diff) {
    if (diff < 50) return 'Toss-up';
    if (diff < 150) return 'Slight edge';
    if (diff < 300) return 'Favorite';
    return 'Heavy favorite';
}

function signed(n) { return n >= 0 ? `+${n}` : `${n}`; }

function creditHTML(fish) {
    const c = fish.imageCredit;
    if (!c) return '';
    const who = c.photographer || 'source';
    const label = `📷 ${who}${c.license ? ' · ' + c.license : ''}`;
    return c.sourceUrl
        ? `<a href="${c.sourceUrl}" target="_blank" rel="noopener">${label}</a>`
        : `<span>${label}</span>`;
}

function tagsHTML(tags) {
    return (tags || []).slice(0, 4).map((t) => `<span>${t}</span>`).join('');
}

async function getJSON(path) {
    const res = await fetch(`${API}${path}`);
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return res.json();
}

// ---------------------------------------------------------------------------
// Global vote
// ---------------------------------------------------------------------------
async function loadMatchup() {
    try {
        matchup = await getJSON('/matchup');
        renderCard('a', matchup.fish_a);
        renderCard('b', matchup.fish_b);
        $('#outcome-label').textContent = outcomeLabel(matchup.elo_diff);
        $('#card-a').classList.remove('winner', 'loser');
        $('#card-b').classList.remove('winner', 'loser');
        $('#change-a').textContent = '';
        $('#change-b').textContent = '';
        voting = false;
    } catch (e) { console.error(e); }
}

function renderCard(side, fish) {
    $(`#img-${side}`).src = fish.image || '';
    $(`#name-${side}`).textContent = fish.name;
    $(`#sci-${side}`).textContent = fish.scientific_name || '';
    $(`#tags-${side}`).innerHTML = tagsHTML(fish.tags);
    $(`#credit-${side}`).innerHTML = creditHTML(fish);
    $(`#elo-${side}`).textContent = Math.round(fish.elo);
    $(`#new-${side}`).classList.toggle('show', !!fish.placing);
}

async function vote(winnerId, loserId, retries = 0) {
    if (voting || !matchup) return;
    voting = true;
    try {
        const res = await fetch(`${API}/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ winner_id: winnerId, loser_id: loserId, token: matchup.token }),
        });

        if (res.status === 503 && retries < 4) {
            voting = false;
            setTimeout(() => vote(winnerId, loserId, retries + 1), 300 * (retries + 1));
            return;
        }
        if (!res.ok) {
            // Stale/expired token or rate limit — fetch a fresh matchup.
            matchup = null;
            setTimeout(loadMatchup, 300);
            return;
        }

        const result = await res.json();
        const winSide = result.winner.id === matchup.fish_a.id ? 'a' : 'b';
        const loseSide = winSide === 'a' ? 'b' : 'a';
        showChange(winSide, result.winner.change, 'positive');
        showChange(loseSide, result.loser.change, 'negative');
        $(`#card-${winSide}`).classList.add('winner');
        $(`#card-${loseSide}`).classList.add('loser');
        $(`#elo-${winSide}`).textContent = Math.round(result.winner.rating);
        $(`#elo-${loseSide}`).textContent = Math.round(result.loser.rating);

        refreshStats();                 // refresh ticker after a vote (not on a timer)
        setTimeout(loadMatchup, 1100);
    } catch (e) { console.error(e); voting = false; }
}

function showChange(side, change, cls) {
    const el = $(`#change-${side}`);
    el.textContent = signed(change);
    el.className = `fish-elo-change ${cls}`;
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------
async function loadRankings() {
    try {
        const data = await getJSON('/rankings');
        const tbody = $('#rankings-table tbody');
        tbody.innerHTML = '';
        data.fish.forEach((f, i) => {
            const tr = document.createElement('tr');
            if (i < 3) tr.classList.add(`top-${i + 1}`);
            tr.innerHTML = `
                <td class="rank">${i + 1}</td>
                <td class="rank-delta ${rankClass(f.rank_delta)}">${rankArrow(f.rank_delta)}</td>
                <td class="rank-img">${f.image ? `<img src="${f.image}" alt="" loading="lazy">` : ''}</td>
                <td class="rank-name"><div class="name">${f.name}</div><div class="sci">${f.scientific_name || ''}</div></td>
                <td class="num">${Math.round(f.elo)}</td>
                <td class="num trend ${trendClass(f.elo_delta_24h)}">${trendText(f.elo_delta_24h)}</td>
                <td class="num">${f.wins}</td>
                <td class="num">${f.losses}</td>`;
            tbody.appendChild(tr);
        });
        $('#rankings-count').textContent = `${data.fish.length} fish · ${data.total_votes} votes`;
    } catch (e) { console.error(e); }
}

function rankArrow(d) {
    if (d === null || d === undefined) return '·';
    if (d > 0) return `▲${d}`;
    if (d < 0) return `▼${Math.abs(d)}`;
    return '–';
}
function rankClass(d) { if (d === null || d === undefined || d === 0) return 'flat'; return d > 0 ? 'up' : 'down'; }
function trendText(d) { if (!d) return '–'; return signed(Math.round(d)); }
function trendClass(d) { if (!d) return 'flat'; return d > 0 ? 'up' : 'down'; }

// ---------------------------------------------------------------------------
// Stats ticker (refreshed on load + after a vote, never on a timer)
// ---------------------------------------------------------------------------
async function refreshStats() {
    try {
        const s = await getJSON('/stats');
        $('#stat-votes').textContent = s.total_votes;
        $('#stat-online').textContent = s.visitors_online;
        $('#stat-best').textContent = s.best_mover ? `${s.best_mover.name} ${signed(s.best_mover.change)}` : '—';
        $('#stat-worst').textContent = s.worst_mover ? `${s.worst_mover.name} ${signed(s.worst_mover.change)}` : '—';
    } catch (e) { console.error(e); }
}

// ---------------------------------------------------------------------------
// Daily Battle
// ---------------------------------------------------------------------------
async function loadDaily() {
    try {
        const d = await getJSON('/daily');
        $('#daily-theme').textContent = d.theme;
        startCountdown(d.seconds_left);

        const champ = $('#daily-champion');
        if (d.yesterday_champion) {
            champ.hidden = false;
            champ.innerHTML = `${d.yesterday_champion.image ? `<img src="${d.yesterday_champion.image}" alt="">` : ''}
                <span><span class="crown">👑 Yesterday's champion:</span> ${d.yesterday_champion.name}
                (${d.yesterday_champion.wins}W / ${d.yesterday_champion.losses}L)</span>`;
        } else {
            champ.hidden = true;
        }

        const tbody = $('#daily-table tbody');
        tbody.innerHTML = '';
        d.contenders.forEach((f, i) => {
            const tr = document.createElement('tr');
            if (i < 3) tr.classList.add(`top-${i + 1}`);
            tr.innerHTML = `
                <td class="rank">${i + 1}</td>
                <td class="rank-img">${f.image ? `<img src="${f.image}" alt="" loading="lazy">` : ''}</td>
                <td class="rank-name"><div class="name">${f.name}</div></td>
                <td class="num">${f.wins}</td>
                <td class="num">${f.losses}</td>
                <td class="num">${f.score.toFixed(3)}</td>`;
            tbody.appendChild(tr);
        });

        await loadDailyMatchup();
    } catch (e) { console.error(e); }
}

async function loadDailyMatchup() {
    try {
        dailyMatchup = await getJSON('/daily/matchup');
        renderDailyCard('a', dailyMatchup.fish_a);
        renderDailyCard('b', dailyMatchup.fish_b);
        dailyVoting = false;
    } catch (e) { console.error(e); }
}

function renderDailyCard(side, fish) {
    $(`#dimg-${side}`).src = fish.image || '';
    $(`#dname-${side}`).textContent = fish.name;
    $(`#dtags-${side}`).innerHTML = tagsHTML(fish.tags);
}

async function dailyVote(winnerId, loserId) {
    if (dailyVoting || !dailyMatchup) return;
    dailyVoting = true;
    try {
        const res = await fetch(`${API}/daily/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ winner_id: winnerId, loser_id: loserId, token: dailyMatchup.token }),
        });
        if (res.ok) { await loadDaily(); return; }  // refresh standings + next pair
        dailyMatchup = null;
        setTimeout(loadDailyMatchup, 300);
    } catch (e) { console.error(e); dailyVoting = false; }
}

// Countdown is purely client-side — it must never trigger a fetch per tick.
function startCountdown(seconds) {
    if (countdownTimer) clearInterval(countdownTimer);
    let left = seconds;
    const el = $('#daily-countdown');
    const render = () => {
        if (left < 0) left = 0;
        const h = String(Math.floor(left / 3600)).padStart(2, '0');
        const m = String(Math.floor((left % 3600) / 60)).padStart(2, '0');
        const s = String(Math.floor(left % 60)).padStart(2, '0');
        el.textContent = `${h}:${m}:${s}`;
    };
    render();
    countdownTimer = setInterval(() => { left -= 1; render(); }, 1000);
}

// ---------------------------------------------------------------------------
// Visitor tracking (throttled: <=1 / 30 min, override on a new UTC day)
// ---------------------------------------------------------------------------
function visitorId() {
    let id = localStorage.getItem('aqua_visitor_id');
    if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
        localStorage.setItem('aqua_visitor_id', id);
    }
    return id;
}

function trackVisitor() {
    const THIRTY_MIN = 30 * 60 * 1000;
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);  // UTC day
    const last = Number(localStorage.getItem('aqua_track_ts') || 0);
    const lastDay = localStorage.getItem('aqua_track_day');

    if (lastDay === today && now - last < THIRTY_MIN) return;  // throttled

    // Set the timestamp before firing so rapid reloads dedupe.
    localStorage.setItem('aqua_track_ts', String(now));
    localStorage.setItem('aqua_track_day', today);
    fetch(`${API}/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitor_id: visitorId() }),
    }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Elo info
// ---------------------------------------------------------------------------
async function loadEloInfo() {
    try {
        const info = await getJSON('/elo-info');
        $('#elo-info-content').innerHTML = `
            <p class="elo-simple">${info.simple}</p>
            <div class="elo-example"><strong>Example:</strong> ${info.example}</div>
            <details class="elo-details">
                <summary>The math</summary>
                <div class="elo-formulas">
                    <div class="elo-formula"><strong>Expected score</strong><code>${info.expected_formula}</code></div>
                    <div class="elo-formula"><strong>Rating update</strong><code>${info.update_formula}</code></div>
                </div>
                <div class="elo-params">
                    <div><span class="param-label">K-factor</span><span class="param-value">${info.k_factor}</span></div>
                    <div><span class="param-label">Placement K</span><span class="param-value">${info.k_provisional} (first ${info.placement_games})</span></div>
                    <div><span class="param-label">Seed range</span><span class="param-value">${info.seed_range[0]}–${info.seed_range[1]}</span></div>
                </div>
                <p class="elo-technical">${info.technical}</p>
            </details>`;
    } catch (e) { console.error(e); }
}

// ---------------------------------------------------------------------------
// Tabs + events
// ---------------------------------------------------------------------------
function showTab(name) {
    ['vote', 'rankings', 'daily'].forEach((t) => {
        $(`#tab-${t}`).classList.toggle('active', t === name);
        $(`#${t}-section`).hidden = t !== name;
    });
    if (name === 'rankings') loadRankings();
    if (name === 'daily') loadDaily();
    else if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

$('#tab-vote').addEventListener('click', () => showTab('vote'));
$('#tab-rankings').addEventListener('click', () => showTab('rankings'));
$('#tab-daily').addEventListener('click', () => showTab('daily'));

$('#card-a').addEventListener('click', () => matchup && vote(matchup.fish_a.id, matchup.fish_b.id));
$('#card-b').addEventListener('click', () => matchup && vote(matchup.fish_b.id, matchup.fish_a.id));
$('#btn-skip').addEventListener('click', (e) => { e.stopPropagation(); if (!voting) loadMatchup(); });

$('#dcard-a').addEventListener('click', () => dailyMatchup && dailyVote(dailyMatchup.fish_a.id, dailyMatchup.fish_b.id));
$('#dcard-b').addEventListener('click', () => dailyMatchup && dailyVote(dailyMatchup.fish_b.id, dailyMatchup.fish_a.id));
$('#dbtn-skip').addEventListener('click', (e) => { e.stopPropagation(); if (!dailyVoting) loadDailyMatchup(); });

document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if ($('#vote-section').hidden || !matchup || voting) return;
    if (e.key === 'ArrowLeft') vote(matchup.fish_a.id, matchup.fish_b.id);
    else if (e.key === 'ArrowRight') vote(matchup.fish_b.id, matchup.fish_a.id);
    else if (e.key === ' ') { e.preventDefault(); loadMatchup(); }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
trackVisitor();
loadMatchup();
refreshStats();
loadEloInfo();

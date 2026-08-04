'use strict';

/* Aqua Elo frontend. No build step, no dependencies.
 *
 * Cost rules that shape this file:
 *   - /stats is refreshed on load and after a vote. Never on a timer.
 *   - The daily countdown ticks client-side and never fetches.
 *   - One matchup is prefetched while you look at the result, so the next pair is
 *     instant. That is the same number of /matchup calls, just earlier.
 *   - Everything personal (your picks, badges, settings) lives in localStorage. */

const API = '/api';
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const TABS = ['vote', 'rankings', 'daily', 'you'];
const RESULT_PAUSE = 1400;

const state = {
    matchup: null,
    queue: [],
    voting: false,
    daily: null,
    dailyVoting: false,
    countdown: null,
    rankings: [],
    nameToId: {},
    online: navigator.onLine,
    stats: null,
    totalVotes: 0,   // monotonic: never shows a lower count than we've already seen
    session: { votes: 0, upsets: 0, streak: 0 },
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);
const num = (n) => Number(n).toLocaleString('en-US');
const pct = (n) => `${Math.round(n * 100)}%`;
const titleCase = (s) => String(s || '').replace(/(^|[\s-])\w/g, (m) => m.toUpperCase());
const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

// Small square thumbnails (rendered by tools/thumbs.mjs) for tables and the favourites
// list — a fraction of the full photo's weight, and there are 106 of them per rankings view.
const thumb = (fish) => (fish && fish.id ? `/images/thumbs/${fish.id}.jpg` : '');

// Loads a photo with a paper-toned skeleton until it decodes, then fades it in.
function setPhoto(img, src) {
    const wrap = img.closest('.plate-photo');
    if (wrap) wrap.classList.add('loading');
    const done = () => { if (wrap) wrap.classList.remove('loading'); };
    img.onload = done;
    img.onerror = done;
    img.src = src || '';
    if (img.complete && img.naturalWidth) done();
}

function readStore(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
}

function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

async function getJSON(path, options) {
    const res = await fetch(`${API}${path}`, options);
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return res.json();
}

/* The service worker answers /api/rankings and friends from cache, so a successful
   fetch is not proof of a connection — the browser's own flag has the last word. */
function setOnline(isOnline) {
    state.online = isOnline && navigator.onLine;
    $('#offline-bar').hidden = state.online;
}

let toastTimer = null;
function toast(message, actionLabel, onAction) {
    const el = $('#toast');
    el.textContent = message;
    if (actionLabel) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = actionLabel;
        btn.addEventListener('click', onAction);
        el.appendChild(btn);
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    if (!actionLabel) toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

// ---------------------------------------------------------------------------
// Settings: theme
// ---------------------------------------------------------------------------
const settings = readStore('aqua_settings', { theme: 'auto' });

function applyTheme() {
    const root = document.documentElement;
    if (settings.theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.theme);

    const dark = settings.theme === 'dark'
        || (settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    $('#btn-theme').firstElementChild.firstElementChild.setAttribute('href', dark ? '#i-sun' : '#i-moon');
    $('#btn-theme').title = dark ? 'Switch to light' : 'Switch to dark';
}

function buzz(ms) {
    if (navigator.vibrate) navigator.vibrate(ms);
}

// ---------------------------------------------------------------------------
// Your picks (device-local)
// ---------------------------------------------------------------------------
const YOU_KEY = 'aqua_you_v1';
const you = readStore(YOU_KEY, {
    votes: 0, upsets: 0, withCrowd: 0, againstCrowd: 0, crowdVotes: 0,
    picks: {}, species: {}, days: [], badges: [],
});

const BADGES = [
    { id: 'first', label: 'First vote', test: (y) => y.votes >= 1 },
    { id: 'ten', label: 'Ten votes', test: (y) => y.votes >= 10 },
    { id: 'fifty', label: 'Fifty votes', test: (y) => y.votes >= 50 },
    { id: 'hundred', label: 'Hundred votes', test: (y) => y.votes >= 100 },
    { id: 'marathon', label: 'Two hundred votes', test: (y) => y.votes >= 200 },
    { id: 'underdog', label: 'Underdog backer', test: (y) => y.upsets >= 10 },
    { id: 'upsetter', label: 'Upset specialist', test: (y) => y.upsets >= 25 },
    { id: 'contrarian', label: 'Against the grain', test: (y) => y.againstCrowd >= 10 },
    { id: 'regular', label: 'Three days in', test: (y) => y.days.length >= 3 },
    { id: 'streak7', label: 'Seven-day streak', test: () => currentStreak() >= 7 },
    { id: 'explorer', label: 'Forty species seen', test: (y) => Object.keys(y.species).length >= 40 },
    { id: 'wholetank', label: 'Every species seen', test: (y) => Object.keys(y.species).length >= 106 },
];

/** Consecutive UTC days visited, counting back from today (or yesterday if not yet today). */
function currentStreak() {
    if (!you.days.length) return 0;
    const seen = new Set(you.days);
    const d = new Date();
    if (!seen.has(utcDay(d))) d.setUTCDate(d.getUTCDate() - 1);
    let streak = 0;
    while (seen.has(utcDay(d))) { streak += 1; d.setUTCDate(d.getUTCDate() - 1); }
    return streak;
}

function recordPick(winner, loser, wasUpset, crowdShare) {
    you.votes += 1;
    if (wasUpset) you.upsets += 1;
    if (crowdShare !== null) {
        you.crowdVotes += 1;
        if (crowdShare >= 0.5) you.withCrowd += 1; else you.againstCrowd += 1;
    }

    const entry = you.picks[winner.id] || { n: 0, name: winner.name, image: winner.image };
    entry.n += 1;
    entry.name = winner.name;
    entry.image = winner.image;
    you.picks[winner.id] = entry;

    you.species[winner.id] = 1;
    you.species[loser.id] = 1;

    const today = utcDay();
    if (!you.days.includes(today)) you.days.push(today);

    const fresh = BADGES.filter((b) => !you.badges.includes(b.id) && b.test(you));
    fresh.forEach((b) => you.badges.push(b.id));
    writeStore(YOU_KEY, you);
    if (fresh.length) toast(`Badge unlocked: ${fresh[fresh.length - 1].label}`);
}

// ---------------------------------------------------------------------------
// Vote: matchup queue
// ---------------------------------------------------------------------------
function preload(fish) {
    if (fish && fish.image) { const img = new Image(); img.src = fish.image; }
}

async function fetchMatchup() {
    const m = await getJSON('/matchup');
    preload(m.fish_a);
    preload(m.fish_b);
    return m;
}

/** Keep one spare pair warm so the next matchup appears without a network wait. */
async function topUpQueue() {
    if (state.queue.length >= 1 || !state.online) return;
    try { state.queue.push(await fetchMatchup()); } catch { /* retried on next vote */ }
}

async function nextMatchup() {
    try {
        state.matchup = state.queue.shift() || await fetchMatchup();
        renderMatchup();
        topUpQueue();
    } catch {
        setOnline(false);
        $('#verdict').textContent = 'Could not reach the server. Voting resumes when you are back online.';
    }
}

// Skipping breaks a run — a streak only counts pairs you actually judged.
function skipMatchup() {
    if (state.session.streak) { state.session.streak = 0; renderSessionLine(); }
    nextMatchup();
}

function renderPlate(side, fish) {
    const img = $(`#img-${side}`);
    img.alt = fish.name;
    setPhoto(img, fish.image);
    $(`#name-${side}`).textContent = fish.name;
    $(`#sci-${side}`).textContent = fish.scientific_name || '';
    $(`#tags-${side}`).innerHTML = (fish.tags || []).slice(0, 3).map((t) => `<span>${esc(t)}</span>`).join('');
    // The rating stays hidden until you pick, so the vote is about the fish, not the number.
    $(`#elo-${side}`).textContent = '···';
    $(`#new-${side}`).classList.toggle('show', !!fish.placing);
    $(`#credit-${side}`).innerHTML = creditHTML(fish);
    const plate = $(`#plate-${side}`);
    plate.classList.remove('picked', 'dropped');
    plate.classList.add('sealed');
    plate.setAttribute('aria-label', `Vote for ${fish.name}`);
    $(`#change-${side}`).textContent = '';
}

function creditHTML(fish) {
    const c = fish.imageCredit;
    if (!c) return '';
    const who = esc(c.photographer || 'Unknown');
    const label = `Photo: ${who}${c.license ? ` · ${esc(c.license)}` : ''}`;
    return c.sourceUrl
        ? `<a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : label;
}

function renderMatchup() {
    const m = state.matchup;
    renderPlate('a', m.fish_a);
    renderPlate('b', m.fish_b);
    // The odds would give away the favourite, so they're revealed with the ratings.
    $('#odds').textContent = '';
    $('#verdict').textContent = '';
    state.voting = false;
}

function oddsLabel(diff) {
    if (diff < 50) return 'Too close to call';
    if (diff < 150) return 'Slight edge';
    if (diff < 300) return 'Clear favourite';
    return 'Heavy favourite';
}

function expectedScore(a, b) { return 1 / (1 + 10 ** ((b - a) / 400)); }

async function vote(winnerId, retries = 0) {
    if (state.voting || !state.matchup) return;
    const m = state.matchup;
    const [winner, loser] = m.fish_a.id === winnerId ? [m.fish_a, m.fish_b] : [m.fish_b, m.fish_a];
    const winSide = m.fish_a.id === winnerId ? 'a' : 'b';
    const loseSide = winSide === 'a' ? 'b' : 'a';

    state.voting = true;
    $(`#plate-${winSide}`).classList.add('picked');
    $(`#plate-${loseSide}`).classList.add('dropped');
    buzz(12);

    try {
        const res = await fetch(`${API}/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ winner_id: winner.id, loser_id: loser.id, token: m.token }),
        });

        if (res.status === 503 && retries < 4) {
            state.voting = false;
            setTimeout(() => vote(winnerId, retries + 1), 300 * (retries + 1));
            return;
        }
        if (!res.ok) {
            state.matchup = null;
            setTimeout(nextMatchup, 300);
            return;
        }

        const result = await res.json();
        revealRating(winSide, result.winner.rating);
        revealRating(loseSide, result.loser.rating);
        showDelta(winSide, result.winner.change);
        showDelta(loseSide, result.loser.change);
        $('#odds').textContent = oddsLabel(m.elo_diff);

        // Bump the live count from the write itself, then reconcile movers via /stats.
        if (typeof result.total_votes === 'number') {
            state.totalVotes = Math.max(state.totalVotes, result.total_votes);
            renderDateline();
        }
        finishVote(winner, loser, m);
        refreshStats();
        setTimeout(nextMatchup, RESULT_PAUSE);
    } catch {
        queueOfflineVote({ winner_id: winner.id, loser_id: loser.id, token: m.token, ts: Date.now() });
        setOnline(false);
        $('#verdict').textContent = 'Saved. This vote is sent as soon as you are back online.';
        state.matchup = null;
        setTimeout(nextMatchup, RESULT_PAUSE);
    }
}

function revealRating(side, rating) {
    $(`#elo-${side}`).textContent = Math.round(rating);
    $(`#plate-${side}`).classList.remove('sealed');
}

function showDelta(side, change) {
    const el = $(`#change-${side}`);
    const rounded = Math.round(change);
    el.textContent = signed(rounded);
    el.className = `delta ${rounded >= 0 ? 'up' : 'down'}`;
}

/** The bit that makes voting feel like a game: was it an upset, and did the crowd agree? */
function finishVote(winner, loser, matchup) {
    const expected = expectedScore(winner.elo, loser.elo);
    const upset = expected < 0.45;

    const h2h = matchup.head_to_head || {};
    const total = (h2h[winner.id] || 0) + (h2h[loser.id] || 0) + 1;
    const share = total >= 5 ? ((h2h[winner.id] || 0) + 1) / total : null;

    let lead;
    if (expected < 0.36) lead = `Upset — ${winner.name} was the underdog at ${pct(expected)}.`;
    else if (expected < 0.45) lead = `${winner.name} was the slight underdog at ${pct(expected)}.`;
    else if (expected > 0.64) lead = `${winner.name} was the favourite at ${pct(expected)}.`;
    else if (expected > 0.55) lead = `${winner.name} had a slight edge at ${pct(expected)}.`;
    else lead = 'Coin flip — the ratings had those two level.';

    const crowd = share === null
        ? 'First few votes on this pair.'
        : `${pct(share)} of the ${total} votes on this pair went the same way.`;

    $('#verdict').innerHTML = `<span class="lead">${esc(lead)}</span> ${esc(crowd)}`;

    state.session.votes += 1;
    state.session.streak += 1;
    if (upset) state.session.upsets += 1;
    recordPick(winner, loser, upset, share);
    renderSessionLine();
}

function renderSessionLine() {
    const s = state.session;
    if (!s.votes) { $('#session-line').textContent = ''; return; }
    const parts = [`${s.votes} this session`];
    if (s.streak >= 3) parts.push(`${s.streak} in a row`);
    if (s.upsets) parts.push(s.upsets === 1 ? '1 upset' : `${s.upsets} upsets`);
    parts.push(`${num(you.votes)} all time on this device`);
    $('#session-line').textContent = parts.join(' · ');
}

// Offline outbox: matchup tokens live 10 minutes, so anything older is dropped.
const OUTBOX_KEY = 'aqua_outbox';
const OUTBOX_TTL = 9 * 60 * 1000;

function queueOfflineVote(entry) {
    const box = readStore(OUTBOX_KEY, []);
    box.push(entry);
    writeStore(OUTBOX_KEY, box);
}

async function flushOutbox() {
    const box = readStore(OUTBOX_KEY, []).filter((v) => Date.now() - v.ts < OUTBOX_TTL);
    if (!box.length) { writeStore(OUTBOX_KEY, []); return; }
    const left = [];
    for (const v of box) {
        try {
            const res = await fetch(`${API}/vote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ winner_id: v.winner_id, loser_id: v.loser_id, token: v.token }),
            });
            if (!res.ok && res.status >= 500) left.push(v);
        } catch { left.push(v); }
    }
    writeStore(OUTBOX_KEY, left);
    if (box.length > left.length) refreshStats();
}

// ---------------------------------------------------------------------------
// Dateline (stats)
// ---------------------------------------------------------------------------
async function refreshStats() {
    try {
        const s = await getJSON('/stats');
        state.stats = s;
        state.totalVotes = Math.max(state.totalVotes, s.total_votes || 0);
        renderDateline();
        setOnline(true);
    } catch {
        setOnline(navigator.onLine);
    }
}

// The count comes from state.totalVotes, not the raw /stats field, so a just-cast vote
// (which returns the fresh total) is reflected immediately and never regresses.
function renderDateline() {
    const s = state.stats;
    if (!s) return;
    const parts = [
        `<span class="dateline-item"><b>${num(state.totalVotes)}</b> votes</span>`,
        `<span class="dateline-item"><b>${num(s.visitors_online)}</b> here today</span>`,
    ];
    if (s.best_mover) {
        parts.push(`<span class="dateline-item">Riser <b class="up">${esc(s.best_mover.name)} ${signed(Math.round(s.best_mover.change))}</b></span>`);
    }
    if (s.worst_mover) {
        parts.push(`<span class="dateline-item">Faller <b class="down">${esc(s.worst_mover.name)} ${signed(Math.round(s.worst_mover.change))}</b></span>`);
    }
    $('#dateline').innerHTML = parts.join('');
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------
async function loadRankings() {
    try {
        const data = await getJSON('/rankings');
        state.rankings = data.fish;
        $('#rankings-count').textContent = `${data.fish.length} species · ${num(data.total_votes)} votes counted`;
        fillTagFilter(data.fish);
        fillCompareList(data.fish);
        renderRankings();
        setOnline(true);
    } catch {
        setOnline(navigator.onLine);
    }
}

function fillTagFilter(fish) {
    const select = $('#rank-tag');
    if (select.options.length > 1) return;
    const tags = [...new Set(fish.flatMap((f) => f.tags || []))].sort();
    select.insertAdjacentHTML('beforeend', tags.map((t) => `<option value="${esc(t)}">${esc(titleCase(t))}</option>`).join(''));
}

const winRate = (f) => { const g = f.wins + f.losses; return g ? f.wins / g : -1; };
const SORTERS = {
    // '#' always stays the Elo rank; sorting only reorders the rows on screen.
    elo: (a, b) => b.elo - a.elo,
    move: (a, b) => Math.abs(b.elo_delta_24h || 0) - Math.abs(a.elo_delta_24h || 0),
    games: (a, b) => (b.wins + b.losses) - (a.wins + a.losses),
    winrate: (a, b) => winRate(b) - winRate(a),
};

function renderRankings() {
    const query = $('#rank-search').value.trim().toLowerCase();
    const tag = $('#rank-tag').value;
    const sort = $('#rank-sort').value;

    const rows = state.rankings
        .map((f, i) => ({ ...f, position: i + 1 }))   // position = Elo rank, fixed
        .filter((f) => (!tag || (f.tags || []).includes(tag))
            && (!query
                || f.name.toLowerCase().includes(query)
                || (f.scientific_name || '').toLowerCase().includes(query)))
        .sort(SORTERS[sort] || SORTERS.elo);

    $('#rankings-empty').hidden = rows.length > 0;
    $('#rankings-table').tBodies[0].innerHTML = rows.map((f) => {
        const cls = [f.position <= 3 ? `medal-${f.position}` : '', you.picks[f.id] ? 'is-fav' : ''].join(' ').trim();
        return `
        <tr data-id="${esc(f.id)}" class="${cls}" tabindex="0">
            <td class="col-rank">${f.position}</td>
            <td class="move ${moveClass(f.rank_delta)}">${moveText(f.rank_delta)}</td>
            <td class="col-thumb"><img class="thumb" src="${esc(thumb(f))}" alt="" loading="lazy" decoding="async"></td>
            <td>
                <div class="species-name">${esc(f.name)}</div>
                <div class="species-sci">${esc(f.scientific_name || '')}</div>
            </td>
            <td class="num">${Math.round(f.elo)}</td>
            <td class="num trend ${trendClass(f.elo_delta_24h)}">${trendText(f.elo_delta_24h)}</td>
            <td class="num">${f.wins}</td>
            <td class="num">${f.losses}</td>
        </tr>`;
    }).join('');
}

// ---------------------------------------------------------------------------
// Compare two fish (read-only head-to-head, no vote)
// ---------------------------------------------------------------------------
function fillCompareList(fish) {
    state.nameToId = {};
    $('#cmp-list').innerHTML = fish.map((f) => {
        state.nameToId[f.name.toLowerCase()] = f.id;
        return `<option value="${esc(f.name)}"></option>`;
    }).join('');
}

async function runCompare() {
    const box = $('#cmp-result');
    const aId = state.nameToId[$('#cmp-a').value.trim().toLowerCase()];
    const bId = state.nameToId[$('#cmp-b').value.trim().toLowerCase()];
    if (!aId || !bId || aId === bId) { box.hidden = true; return; }
    try {
        renderCompare(await getJSON(`/compare?a=${encodeURIComponent(aId)}&b=${encodeURIComponent(bId)}`));
    } catch { box.hidden = true; }
}

function renderCompare(d) {
    const a = d.fish_a;
    const b = d.fish_b;
    const h2h = d.head_to_head || {};
    const aw = h2h[a.id] || 0;
    const bw = h2h[b.id] || 0;

    let line;
    if (aw + bw === 0) line = 'These two have never been paired yet.';
    else if (aw === bw) line = `Dead even, ${aw}–${bw}.`;
    else if (aw > bw) line = `${a.name} leads their head-to-head, ${aw}–${bw}.`;
    else line = `${b.name} leads their head-to-head, ${bw}–${aw}.`;

    const card = (f) => `
        <div class="cmp-fish" data-id="${esc(f.id)}" tabindex="0" role="button" aria-label="Details for ${esc(f.name)}">
            <img src="${esc(thumb(f))}" alt="" loading="lazy" decoding="async">
            <div>
                <div class="species-name">${esc(f.name)}</div>
                <div class="cmp-elo">${Math.round(f.elo)} Elo${f.placing ? ' · placing' : ''}</div>
            </div>
        </div>`;

    $('#cmp-result').innerHTML = `
        <div class="cmp-cards">${card(a)}<span class="cmp-mid">vs</span>${card(b)}</div>
        <p class="cmp-line">${esc(line)}</p>`;
    $('#cmp-result').hidden = false;
}

const moveText = (d) => (d === null || d === undefined ? '·' : d > 0 ? `▲ ${d}` : d < 0 ? `▼ ${Math.abs(d)}` : '–');
const moveClass = (d) => (!d ? 'flat' : d > 0 ? 'up' : 'down');
const trendText = (d) => (!d ? '–' : signed(Math.round(d)));
const trendClass = (d) => (!d ? 'flat' : d > 0 ? 'up' : 'down');

// ---------------------------------------------------------------------------
// Species dossier
// ---------------------------------------------------------------------------
let lastFocused = null;

function openDossier(fish) {
    if (!fish) return;
    lastFocused = document.activeElement;
    $('#dossier-img').src = fish.image || '';
    $('#dossier-img').alt = fish.name;
    $('#dossier-name').textContent = fish.name;
    $('#dossier-sci').textContent = fish.scientific_name || '';
    $('#dossier-tags').innerHTML = (fish.tags || []).map((t) => `<span>${esc(t)}</span>`).join('');
    $('#dossier-specs').innerHTML = specsHTML(fish);
    $('#dossier-credit').innerHTML = creditHTML(fish);
    $('#dossier').hidden = false;
    $('#dossier-close').focus();
    document.body.style.overflow = 'hidden';
}

function closeDossier() {
    $('#dossier').hidden = true;
    document.body.style.overflow = '';
    if (lastFocused) lastFocused.focus();
}

function specsHTML(f) {
    const spec = (label, value) => (value ? `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>` : '');
    const liters = f.min_tank_liters;
    const ph = f.ph_range;
    const temp = f.temp_range_c;
    const size = f.adult_size_cm;

    return [
        spec('Min. tank', liters ? `${liters} l · ${Math.round(liters / 3.785)} gal` : ''),
        spec('Adult size', size ? `${size} cm · ${(size / 2.54).toFixed(1)} in` : ''),
        spec('pH', ph ? `${ph[0]} – ${ph[1]}` : ''),
        spec('Temperature', temp ? `${temp[0]}–${temp[1]} °C · ${Math.round(temp[0] * 9 / 5 + 32)}–${Math.round(temp[1] * 9 / 5 + 32)} °F` : ''),
        spec('Temperament', titleCase(f.temperament)),
        spec('Care level', titleCase(f.difficulty)),
        spec('Record', f.wins !== undefined ? `${f.wins} W · ${f.losses} L` : ''),
        spec('Elo', f.elo ? `${Math.round(f.elo)}${f.placing ? ' (still placing)' : ''}` : ''),
    ].join('');
}

// ---------------------------------------------------------------------------
// Daily battle
// ---------------------------------------------------------------------------
async function loadDaily() {
    try {
        const d = await getJSON('/daily');
        state.daily = d;
        $('#daily-theme').textContent = d.theme;
        startCountdown(d.seconds_left);

        const champ = $('#daily-champion');
        if (d.yesterday_champion) {
            const c = d.yesterday_champion;
            champ.hidden = false;
            champ.innerHTML = `<img src="${esc(thumb(c))}" alt="">
                <span><b>Yesterday:</b> ${esc(c.name)} took it, ${c.wins}–${c.losses}.</span>`;
        } else {
            champ.hidden = true;
        }

        renderDailyProgress(d);

        $('#daily-table').tBodies[0].innerHTML = d.contenders.map((f, i) => `
            <tr data-id="${esc(f.id)}" class="${i < 3 ? `medal-${i + 1}` : ''}" tabindex="0">
                <td class="col-rank">${i + 1}</td>
                <td class="col-thumb"><img class="thumb" src="${esc(thumb(f))}" alt="" loading="lazy" decoding="async"></td>
                <td><div class="species-name">${esc(f.name)}</div></td>
                <td class="num">${f.wins}</td>
                <td class="num">${f.losses}</td>
                <td class="num">${f.score.toFixed(3)}</td>
            </tr>`).join('');

        await loadDailyMatchup();
        setOnline(true);
    } catch {
        setOnline(navigator.onLine);
    }
}

async function loadDailyMatchup() {
    try {
        const m = await getJSON('/daily/matchup');
        state.dailyMatchup = m;
        renderDailyPlate('a', m.fish_a);
        renderDailyPlate('b', m.fish_b);
        state.dailyVoting = false;
    } catch { /* the standings still render */ }
}

function renderDailyPlate(side, fish) {
    const img = $(`#dimg-${side}`);
    img.alt = fish.name;
    setPhoto(img, fish.image);
    $(`#dname-${side}`).textContent = fish.name;
    $(`#dtags-${side}`).innerHTML = (fish.tags || []).slice(0, 3).map((t) => `<span>${esc(t)}</span>`).join('');
    $(`#dcredit-${side}`).innerHTML = creditHTML(fish);
    const plate = $(`#dplate-${side}`);
    plate.classList.remove('picked', 'dropped');
    plate.setAttribute('aria-label', `Vote for ${fish.name}`);
}

async function dailyVote(winnerId) {
    const m = state.dailyMatchup;
    if (state.dailyVoting || !m) return;
    state.dailyVoting = true;

    const winSide = m.fish_a.id === winnerId ? 'a' : 'b';
    const loserId = winSide === 'a' ? m.fish_b.id : m.fish_a.id;
    $(`#dplate-${winSide}`).classList.add('picked');
    $(`#dplate-${winSide === 'a' ? 'b' : 'a'}`).classList.add('dropped');
    buzz(12);
    recordDailyVote(m.date, winnerId, loserId);

    try {
        const res = await fetch(`${API}/daily/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ winner_id: winnerId, loser_id: loserId, token: m.token }),
        });
        if (res.ok) { setTimeout(loadDaily, RESULT_PAUSE - 500); return; }
        state.dailyMatchup = null;
        setTimeout(loadDailyMatchup, 300);
    } catch {
        state.dailyVoting = false;
    }
}

// How much of today's lineup you've weighed in on — device-local, resets with the day.
const DAILY_KEY = 'aqua_daily_v1';

function dailyState(date) {
    const p = readStore(DAILY_KEY, { date: '', voted: [] });
    return p.date === date ? p : { date, voted: [] };
}

function recordDailyVote(date, a, b) {
    const p = dailyState(date);
    for (const id of [a, b]) if (!p.voted.includes(id)) p.voted.push(id);
    p.date = date;
    writeStore(DAILY_KEY, p);
    if (state.daily && state.daily.date === date) renderDailyProgress(state.daily);
}

function renderDailyProgress(d) {
    const lineup = new Set(d.contenders.map((f) => f.id));
    const voted = dailyState(d.date).voted.filter((id) => lineup.has(id)).length;
    const el = $('#daily-progress');
    if (!lineup.size) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = voted >= lineup.size
        ? `You've weighed in on all ${lineup.size} of today's fish.`
        : `You've seen ${voted} of today's ${lineup.size} fish.`;
}

function startCountdown(seconds) {
    stopCountdown();
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
    state.countdown = setInterval(() => { left -= 1; render(); }, 1000);
}

function stopCountdown() {
    if (state.countdown) { clearInterval(state.countdown); state.countdown = null; }
}

// ---------------------------------------------------------------------------
// Your picks tab
// ---------------------------------------------------------------------------
function renderYou() {
    const agreement = you.crowdVotes ? pct(you.withCrowd / you.crowdVotes) : '—';
    const upsetRate = you.votes ? pct(you.upsets / you.votes) : '—';

    const streak = currentStreak();
    $('#you-stats').innerHTML = [
        ['Votes cast', num(you.votes)],
        ['Species seen', `${num(Object.keys(you.species).length)}/106`],
        ['Underdog picks', upsetRate],
        ['With the crowd', agreement],
        ['Day streak', streak ? `${streak}` : '—'],
    ].map(([label, value]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');

    const favourites = Object.entries(you.picks)
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, 6);

    $('#you-favourites').innerHTML = favourites.length
        ? favourites.map(([id, p]) => `
            <li data-id="${esc(id)}" tabindex="0" role="button">
                <img src="${esc(thumb({ id }))}" alt="" loading="lazy">
                <span>${esc(p.name)}</span>
                <span class="count">${p.n}×</span>
            </li>`).join('')
        : '<li>Vote a few times and your favourites show up here.</li>';

    $('#you-badges').innerHTML = BADGES.map((b) => {
        const earned = you.badges.includes(b.id);
        return `<li class="${earned ? 'earned' : ''}">${esc(b.label)}</li>`;
    }).join('');
}

// A self-contained SVG card of your local stats — no photos (keeps the canvas clean),
// field-guide palette baked in so it reads the same wherever it's shared.
function shareCardSVG() {
    const top = (Object.values(you.picks).sort((a, b) => b.n - a.n)[0] || {}).name || '—';
    const cells = [
        ['Votes cast', num(you.votes)],
        ['Species seen', `${Object.keys(you.species).length}/106`],
        ['Underdog picks', you.votes ? pct(you.upsets / you.votes) : '—'],
        ['Day streak', String(currentStreak())],
    ];
    const cell = (c, i) => {
        const x = 90 + (i % 2) * 465;
        const y = 470 + Math.floor(i / 2) * 200;
        return `<g transform="translate(${x} ${y})">
            <text x="0" y="0" font-family="Georgia, 'Times New Roman', serif" font-size="86" fill="#182830">${esc(c[1])}</text>
            <text x="4" y="44" font-family="Helvetica, Arial, sans-serif" font-size="24" letter-spacing="3" fill="#5a6a71">${esc(c[0].toUpperCase())}</text>
        </g>`;
    };
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="1080" height="1080">
        <rect width="1080" height="1080" fill="#f4efe4"/>
        <g transform="translate(90 130)">
            <g transform="scale(1.7)"><path d="M22 30 Q52 6 84 30 Q52 54 22 30 Z" fill="#c04d26"/><path d="M23 30 L2 14 Q8 30 2 46 Z" fill="#c04d26"/><circle cx="72" cy="26.5" r="3.2" fill="#f4efe4"/></g>
        </g>
        <text x="285" y="150" font-family="Helvetica, Arial, sans-serif" font-size="26" letter-spacing="8" fill="#0b6b72">AQUA ELO</text>
        <text x="285" y="205" font-family="Georgia, 'Times New Roman', serif" font-size="58" fill="#182830">My tank record</text>
        <line x1="90" y1="300" x2="990" y2="300" stroke="#ddd3bf" stroke-width="2"/>
        ${cells.map(cell).join('')}
        <line x1="90" y1="900" x2="990" y2="900" stroke="#ddd3bf" stroke-width="2"/>
        <text x="90" y="955" font-family="Georgia, 'Times New Roman', serif" font-size="34" fill="#182830">Most picked: <tspan fill="#c04d26">${esc(top)}</tspan></text>
        <text x="90" y="1010" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="#8b978f">Pick the fish you like better · a just-for-fun aquarium poll</text>
    </svg>`;
}

async function shareCardImage() {
    const svg = shareCardSVG();
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1080;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

async function share() {
    const top = Object.values(you.picks).sort((a, b) => b.n - a.n)[0];
    const text = top
        ? `My Aqua Elo card: ${you.votes} votes, most picked ${top.name}.`
        : 'Ranking freshwater fish on Aqua Elo.';

    // Best case: share the generated card as an image file.
    try {
        const blob = await shareCardImage();
        const file = new File([blob], 'aqua-elo.png', { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: 'Aqua Elo', text });
            return;
        }
        // No file share (desktop): offer the card as a download.
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'aqua-elo.png';
        a.click();
        URL.revokeObjectURL(url);
        toast('Saved your card as an image.');
        return;
    } catch { /* fall through to text/URL share */ }

    try {
        if (navigator.share) await navigator.share({ title: 'Aqua Elo', text, url: location.origin });
        else { await navigator.clipboard.writeText(`${text} ${location.origin}`); toast('Copied to clipboard.'); }
    } catch { /* dismissed */ }
}

function resetYou() {
    if (!confirm('Delete your local stats, favourites and badges?')) return;
    Object.assign(you, {
        votes: 0, upsets: 0, withCrowd: 0, againstCrowd: 0, crowdVotes: 0,
        picks: {}, species: {}, days: [], badges: [],
    });
    writeStore(YOU_KEY, you);
    try { localStorage.removeItem(DAILY_KEY); } catch { /* private mode */ }
    renderYou();
    renderSessionLine();
    toast('Cleared.');
}

// ---------------------------------------------------------------------------
// Elo explainer
// ---------------------------------------------------------------------------
async function loadEloInfo() {
    try {
        const info = await getJSON('/elo-info');
        $('#elo-info-content').innerHTML = `
            <p>${esc(info.simple)}</p>
            <p class="example">${esc(info.example)}</p>
            <details>
                <summary>The maths</summary>
                <div class="formulas">
                    <div class="formula"><b>Expected score</b><code>${esc(info.expected_formula)}</code></div>
                    <div class="formula"><b>Rating update</b><code>${esc(info.update_formula)}</code></div>
                </div>
                <div class="params">
                    <div><span>K-factor</span> <b>${info.k_factor}</b></div>
                    <div><span>Placement K</span> <b>${info.k_provisional}</b> <span>(first ${info.placement_games})</span></div>
                    <div><span>Seed range</span> <b>${info.seed_range[0]}–${info.seed_range[1]}</b></div>
                </div>
                <p>${esc(info.technical)}</p>
            </details>`;
    } catch { /* explainer is optional */ }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function showTab(name, { focus = false } = {}) {
    if (!TABS.includes(name)) name = 'vote';
    TABS.forEach((t) => {
        const isCurrent = t === name;
        $(`#tab-${t}`).setAttribute('aria-selected', String(isCurrent));
        $(`#panel-${t}`).hidden = !isCurrent;
    });
    if (focus) $(`#panel-${name}`).focus();
    if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);

    if (name !== 'daily') stopCountdown();
    if (name === 'rankings' && !state.rankings.length) loadRankings();
    if (name === 'daily') loadDaily();
    if (name === 'you') renderYou();
}

// ---------------------------------------------------------------------------
// Visitor tracking (<=1 per 30 min, always once per new UTC day)
// ---------------------------------------------------------------------------
function visitorId() {
    let id = localStorage.getItem('aqua_visitor_id');
    if (!id) {
        id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        localStorage.setItem('aqua_visitor_id', id);
    }
    return id;
}

function trackVisitor() {
    const THIRTY_MIN = 30 * 60 * 1000;
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const last = Number(localStorage.getItem('aqua_track_ts') || 0);
    const lastDay = localStorage.getItem('aqua_track_day');
    if (lastDay === today && now - last < THIRTY_MIN) return;

    // Written before the request so a reload storm cannot fan out into extra writes.
    localStorage.setItem('aqua_track_ts', String(now));
    localStorage.setItem('aqua_track_day', today);
    fetch(`${API}/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitor_id: visitorId() }),
    }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$('#btn-theme').addEventListener('click', () => {
    const dark = settings.theme === 'dark'
        || (settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    settings.theme = dark ? 'light' : 'dark';
    writeStore('aqua_settings', settings);
    applyTheme();
});

$('#plate-a').addEventListener('click', () => state.matchup && vote(state.matchup.fish_a.id));
$('#plate-b').addEventListener('click', () => state.matchup && vote(state.matchup.fish_b.id));
$('#info-a').addEventListener('click', () => openDossier(state.matchup && state.matchup.fish_a));
$('#info-b').addEventListener('click', () => openDossier(state.matchup && state.matchup.fish_b));
$('#btn-skip').addEventListener('click', () => { if (!state.voting) skipMatchup(); });

$('#intro-dismiss').addEventListener('click', () => {
    $('#intro').hidden = true;
    writeStore('aqua_seen_intro', true);
});

$('#dplate-a').addEventListener('click', () => state.dailyMatchup && dailyVote(state.dailyMatchup.fish_a.id));
$('#dplate-b').addEventListener('click', () => state.dailyMatchup && dailyVote(state.dailyMatchup.fish_b.id));
$('#dbtn-skip').addEventListener('click', () => { if (!state.dailyVoting) loadDailyMatchup(); });

$('#rank-search').addEventListener('input', renderRankings);
$('#rank-tag').addEventListener('change', renderRankings);
$('#rank-sort').addEventListener('change', renderRankings);

$('#cmp-a').addEventListener('change', runCompare);
$('#cmp-b').addEventListener('change', runCompare);
$('#cmp-a').addEventListener('input', runCompare);
$('#cmp-b').addEventListener('input', runCompare);
$('#cmp-result').addEventListener('click', (e) => {
    const el = e.target.closest('.cmp-fish[data-id]');
    if (el) openDossier(state.rankings.find((f) => f.id === el.dataset.id));
});
$('#cmp-result').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest('.cmp-fish[data-id]');
    if (el) { e.preventDefault(); openDossier(state.rankings.find((f) => f.id === el.dataset.id)); }
});

function rowHandler(tableId, lookup) {
    const table = $(tableId);
    const open = (row) => { if (row) openDossier(lookup(row.dataset.id)); };
    table.addEventListener('click', (e) => open(e.target.closest('tr[data-id]')));
    table.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e.target.closest('tr[data-id]')); }
    });
}
rowHandler('#rankings-table', (id) => state.rankings.find((f) => f.id === id));
rowHandler('#daily-table', (id) => state.rankings.find((f) => f.id === id)
    || (state.daily && state.daily.contenders.find((f) => f.id === id)));

function openFavourite(li) {
    if (li) openDossier(state.rankings.find((f) => f.id === li.dataset.id));
}
$('#you-favourites').addEventListener('click', (e) => openFavourite(e.target.closest('li[data-id]')));
$('#you-favourites').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFavourite(e.target.closest('li[data-id]')); }
});
$('#btn-share').addEventListener('click', share);
$('#btn-reset').addEventListener('click', resetYou);

$('#dossier-close').addEventListener('click', closeDossier);
$('#dossier-backdrop').addEventListener('click', closeDossier);

$$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => showTab(tab.id.replace('tab-', '')));
});
$('.tabs').addEventListener('keydown', (e) => {
    const idx = TABS.indexOf(document.activeElement.id.replace('tab-', ''));
    if (idx < 0) return;
    let next = null;
    if (e.key === 'ArrowRight') next = (idx + 1) % TABS.length;
    if (e.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length;
    if (next === null) return;
    e.preventDefault();
    $(`#tab-${TABS[next]}`).focus();
    showTab(TABS[next]);
});

document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (!$('#dossier').hidden) {
        if (e.key === 'Escape') closeDossier();
        return;
    }
    if ($('#panel-vote').hidden || !state.matchup || state.voting) return;
    if (e.key === 'ArrowLeft') vote(state.matchup.fish_a.id);
    else if (e.key === 'ArrowRight') vote(state.matchup.fish_b.id);
    else if (e.key === ' ') { e.preventDefault(); skipMatchup(); }
});

window.addEventListener('hashchange', () => showTab(location.hash.slice(1), { focus: true }));
window.addEventListener('online', () => { setOnline(true); flushOutbox(); topUpQueue(); });
window.addEventListener('offline', () => setOnline(false));

// Install prompt: Chromium fires this when the PWA criteria are met.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    if (!readStore('aqua_install_dismissed', false)) $('#btn-install').hidden = false;
});
$('#btn-install').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'dismissed') writeStore('aqua_install_dismissed', true);
    installPrompt = null;
    $('#btn-install').hidden = true;
});
window.addEventListener('appinstalled', () => { $('#btn-install').hidden = true; });

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

setOnline(navigator.onLine);
showTab(location.hash.slice(1) || 'vote');
if (!readStore('aqua_seen_intro', false) && !you.votes) $('#intro').hidden = false;
trackVisitor();
nextMatchup();
refreshStats();
loadEloInfo();
flushOutbox();
renderSessionLine();

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').then((reg) => {
            reg.addEventListener('updatefound', () => {
                const worker = reg.installing;
                if (!worker) return;
                worker.addEventListener('statechange', () => {
                    if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                        toast('A new version is ready.', 'Reload', () => {
                            worker.postMessage('skip-waiting');
                            location.reload();
                        });
                    }
                });
            });
        }).catch(() => {});
    });
}

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
    online: navigator.onLine,
    session: { votes: 0, upsets: 0 },
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
// Settings: theme + sound
// ---------------------------------------------------------------------------
const settings = readStore('aqua_settings', { theme: 'auto', sound: true });

function applyTheme() {
    const root = document.documentElement;
    if (settings.theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.theme);

    const dark = settings.theme === 'dark'
        || (settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    $('#btn-theme').firstElementChild.firstElementChild.setAttribute('href', dark ? '#i-sun' : '#i-moon');
    $('#btn-theme').title = dark ? 'Switch to light' : 'Switch to dark';
}

function applySound() {
    const btn = $('#btn-sound');
    btn.setAttribute('aria-pressed', String(settings.sound));
    btn.firstElementChild.firstElementChild.setAttribute('href', settings.sound ? '#i-sound-on' : '#i-sound-off');
}

let audio = null;
function plop(up) {
    if (!settings.sound) return;
    try {
        audio = audio || new (window.AudioContext || window.webkitAudioContext)();
        if (audio.state === 'suspended') audio.resume();
        const now = audio.currentTime;
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(up ? 520 : 300, now);
        osc.frequency.exponentialRampToValueAtTime(up ? 190 : 120, now + 0.13);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.09, now + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
        osc.connect(gain).connect(audio.destination);
        osc.start(now);
        osc.stop(now + 0.24);
    } catch { /* audio is optional */ }
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
    { id: 'underdog', label: 'Underdog backer', test: (y) => y.upsets >= 10 },
    { id: 'contrarian', label: 'Against the grain', test: (y) => y.againstCrowd >= 10 },
    { id: 'regular', label: 'Three days in', test: (y) => y.days.length >= 3 },
    { id: 'explorer', label: 'Forty species seen', test: (y) => Object.keys(y.species).length >= 40 },
];

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

    const today = new Date().toISOString().slice(0, 10);
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

function renderPlate(side, fish) {
    const img = $(`#img-${side}`);
    img.src = fish.image || '';
    img.alt = fish.name;
    $(`#name-${side}`).textContent = fish.name;
    $(`#sci-${side}`).textContent = fish.scientific_name || '';
    $(`#tags-${side}`).innerHTML = (fish.tags || []).slice(0, 3).map((t) => `<span>${esc(t)}</span>`).join('');
    $(`#elo-${side}`).textContent = Math.round(fish.elo);
    $(`#new-${side}`).classList.toggle('show', !!fish.placing);
    $(`#credit-${side}`).innerHTML = creditHTML(fish);
    const plate = $(`#plate-${side}`);
    plate.classList.remove('picked', 'dropped');
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
    $('#odds').textContent = oddsLabel(m.elo_diff);
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
    plop(true);
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
        $(`#elo-${winSide}`).textContent = Math.round(result.winner.rating);
        $(`#elo-${loseSide}`).textContent = Math.round(result.loser.rating);
        showDelta(winSide, result.winner.change);
        showDelta(loseSide, result.loser.change);

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
    if (upset) state.session.upsets += 1;
    recordPick(winner, loser, upset, share);
    renderSessionLine();
}

function renderSessionLine() {
    const s = state.session;
    if (!s.votes) { $('#session-line').textContent = ''; return; }
    const upsets = s.upsets === 1 ? '1 upset' : `${s.upsets} upsets`;
    $('#session-line').textContent = `${s.votes} this session · ${upsets} · ${num(you.votes)} all time on this device`;
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
        const parts = [
            `<span class="dateline-item"><b>${num(s.total_votes)}</b> votes</span>`,
            `<span class="dateline-item"><b>${num(s.visitors_online)}</b> here today</span>`,
        ];
        if (s.best_mover) {
            parts.push(`<span class="dateline-item">Riser <b class="up">${esc(s.best_mover.name)} ${signed(Math.round(s.best_mover.change))}</b></span>`);
        }
        if (s.worst_mover) {
            parts.push(`<span class="dateline-item">Faller <b class="down">${esc(s.worst_mover.name)} ${signed(Math.round(s.worst_mover.change))}</b></span>`);
        }
        $('#dateline').innerHTML = parts.join('');
        setOnline(true);
    } catch {
        setOnline(navigator.onLine);
    }
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

function renderRankings() {
    const query = $('#rank-search').value.trim().toLowerCase();
    const tag = $('#rank-tag').value;

    const rows = state.rankings
        .map((f, i) => ({ ...f, position: i + 1 }))
        .filter((f) => (!tag || (f.tags || []).includes(tag))
            && (!query
                || f.name.toLowerCase().includes(query)
                || (f.scientific_name || '').toLowerCase().includes(query)));

    $('#rankings-empty').hidden = rows.length > 0;
    $('#rankings-table').tBodies[0].innerHTML = rows.map((f) => `
        <tr data-id="${esc(f.id)}" class="${f.position <= 3 ? `medal-${f.position}` : ''}" tabindex="0">
            <td class="col-rank">${f.position}</td>
            <td class="move ${moveClass(f.rank_delta)}">${moveText(f.rank_delta)}</td>
            <td class="col-thumb">${f.image ? `<img class="thumb" src="${esc(f.image)}" alt="" loading="lazy" decoding="async">` : ''}</td>
            <td>
                <div class="species-name">${esc(f.name)}</div>
                <div class="species-sci">${esc(f.scientific_name || '')}</div>
            </td>
            <td class="num">${Math.round(f.elo)}</td>
            <td class="num trend ${trendClass(f.elo_delta_24h)}">${trendText(f.elo_delta_24h)}</td>
            <td class="num">${f.wins}</td>
            <td class="num">${f.losses}</td>
        </tr>`).join('');
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
            champ.innerHTML = `${c.image ? `<img src="${esc(c.image)}" alt="">` : ''}
                <span><b>Yesterday:</b> ${esc(c.name)} took it, ${c.wins}–${c.losses}.</span>`;
        } else {
            champ.hidden = true;
        }

        $('#daily-table').tBodies[0].innerHTML = d.contenders.map((f, i) => `
            <tr data-id="${esc(f.id)}" class="${i < 3 ? `medal-${i + 1}` : ''}" tabindex="0">
                <td class="col-rank">${i + 1}</td>
                <td class="col-thumb">${f.image ? `<img class="thumb" src="${esc(f.image)}" alt="" loading="lazy" decoding="async">` : ''}</td>
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
    img.src = fish.image || '';
    img.alt = fish.name;
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
    plop(true);
    buzz(12);

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

    $('#you-stats').innerHTML = [
        ['Votes cast', num(you.votes)],
        ['Species seen', num(Object.keys(you.species).length)],
        ['Underdog picks', upsetRate],
        ['With the crowd', agreement],
        ['Days visited', num(you.days.length)],
    ].map(([label, value]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');

    const favourites = Object.entries(you.picks)
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, 6);

    $('#you-favourites').innerHTML = favourites.length
        ? favourites.map(([id, p]) => `
            <li data-id="${esc(id)}">
                ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : ''}
                <span>${esc(p.name)}</span>
                <span class="count">${p.n}×</span>
            </li>`).join('')
        : '<li>Vote a few times and your favourites show up here.</li>';

    $('#you-badges').innerHTML = BADGES.map((b) => {
        const earned = you.badges.includes(b.id);
        return `<li class="${earned ? 'earned' : ''}">${esc(b.label)}</li>`;
    }).join('');
}

async function share() {
    const top = Object.values(you.picks).sort((a, b) => b.n - a.n)[0];
    const text = top
        ? `${you.votes} fish matchups voted on Aqua Elo. Most picked: ${top.name}.`
        : `Ranking freshwater fish on Aqua Elo.`;
    const data = { title: 'Aqua Elo', text, url: location.origin };
    try {
        if (navigator.share) await navigator.share(data);
        else {
            await navigator.clipboard.writeText(`${text} ${location.origin}`);
            toast('Copied to clipboard.');
        }
    } catch { /* dismissed */ }
}

function resetYou() {
    if (!confirm('Delete your local stats, favourites and badges?')) return;
    Object.assign(you, {
        votes: 0, upsets: 0, withCrowd: 0, againstCrowd: 0, crowdVotes: 0,
        picks: {}, species: {}, days: [], badges: [],
    });
    writeStore(YOU_KEY, you);
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

$('#btn-sound').addEventListener('click', () => {
    settings.sound = !settings.sound;
    writeStore('aqua_settings', settings);
    applySound();
    if (settings.sound) plop(true);
});

$('#plate-a').addEventListener('click', () => state.matchup && vote(state.matchup.fish_a.id));
$('#plate-b').addEventListener('click', () => state.matchup && vote(state.matchup.fish_b.id));
$('#info-a').addEventListener('click', () => openDossier(state.matchup && state.matchup.fish_a));
$('#info-b').addEventListener('click', () => openDossier(state.matchup && state.matchup.fish_b));
$('#btn-skip').addEventListener('click', () => { if (!state.voting) nextMatchup(); });

$('#dplate-a').addEventListener('click', () => state.dailyMatchup && dailyVote(state.dailyMatchup.fish_a.id));
$('#dplate-b').addEventListener('click', () => state.dailyMatchup && dailyVote(state.dailyMatchup.fish_b.id));
$('#dbtn-skip').addEventListener('click', () => { if (!state.dailyVoting) loadDailyMatchup(); });

$('#rank-search').addEventListener('input', renderRankings);
$('#rank-tag').addEventListener('change', renderRankings);

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

$('#you-favourites').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (li) openDossier(state.rankings.find((f) => f.id === li.dataset.id));
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
    else if (e.key === ' ') { e.preventDefault(); nextMatchup(); }
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
applySound();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

setOnline(navigator.onLine);
showTab(location.hash.slice(1) || 'vote');
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

const API = '/api';

let currentMatchup = null;
let voting = false;

const $ = (sel) => document.querySelector(sel);

function outcomeLabel(diff) {
    if (diff < 50) return 'Toss-up';
    if (diff < 150) return 'Slight edge';
    if (diff < 300) return 'Favorite';
    return 'Heavy favorite';
}

async function loadMatchup() {
    try {
        const res = await fetch(`${API}/matchup`);
        if (!res.ok) throw new Error('API error');
        currentMatchup = await res.json();

        const a = currentMatchup.fish_a;
        const b = currentMatchup.fish_b;

        $('#img-a').src = a.image || '';
        $('#name-a').textContent = a.name;
        $('#tags-a').textContent = (a.tags || []).slice(0, 3).join(' · ');
        $('#credit-a').innerHTML = a.imageCredit
            ? `<span title="Photo: ${a.imageCredit.photographer} — ${a.imageCredit.license}"><i class="fa-solid fa-camera"></i> ${a.imageCredit.photographer}</span>`
            : '';
        $('#elo-a').textContent = a.elo;
        $('#change-a').textContent = '';

        $('#img-b').src = b.image || '';
        $('#name-b').textContent = b.name;
        $('#tags-b').textContent = (b.tags || []).slice(0, 3).join(' · ');
        $('#credit-b').innerHTML = b.imageCredit
            ? `<span title="Photo: ${b.imageCredit.photographer} — ${b.imageCredit.license}"><i class="fa-solid fa-camera"></i> ${b.imageCredit.photographer}</span>`
            : '';
        $('#elo-b').textContent = b.elo;
        $('#change-b').textContent = '';

        $('#outcome-label').textContent = outcomeLabel(currentMatchup.elo_diff);

        $('#card-a').classList.remove('winner', 'loser');
        $('#card-b').classList.remove('winner', 'loser');
        voting = false;
    } catch (e) {
        console.error(e);
    }
}

async function vote(winnerId, loserId, retries = 0) {
    if (voting) return;
    voting = true;

    try {
        const res = await fetch(`${API}/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ winner_id: winnerId, loser_id: loserId, matchup_token: currentMatchup.matchup_token }),
        });

        if (res.status === 503 && retries < 3) {
            setTimeout(() => vote(winnerId, loserId, retries + 1), 400);
            return;
        }

        if (!res.ok) {
            if (res.status === 400) {
                $('#change-a').textContent = '';
                $('#change-b').textContent = '';
                currentMatchup = null;
                setTimeout(() => loadMatchup(), 300);
            }
            voting = false;
            return;
        }
        const result = await res.json();

        if (result.winner.id === currentMatchup.fish_a.id) {
            $('#change-a').textContent = result.winner.change >= 0
                ? `+${result.winner.change}`
                : result.winner.change;
            $('#change-a').className = 'fish-elo-change positive';
            $('#change-b').textContent = result.loser.change >= 0
                ? `+${result.loser.change}`
                : result.loser.change;
            $('#change-b').className = 'fish-elo-change negative';
            $('#card-a').classList.add('winner');
            $('#card-b').classList.add('loser');
        } else {
            $('#change-b').textContent = result.winner.change >= 0
                ? `+${result.winner.change}`
                : result.winner.change;
            $('#change-b').className = 'fish-elo-change positive';
            $('#change-a').textContent = result.loser.change >= 0
                ? `+${result.loser.change}`
                : result.loser.change;
            $('#change-a').className = 'fish-elo-change negative';
            $('#card-b').classList.add('winner');
            $('#card-a').classList.add('loser');
        }

        updateStats();
        setTimeout(() => loadMatchup(), 1200);
    } catch (e) {
        console.error(e);
        voting = false;
    }
}

async function loadRankings() {
    try {
        const res = await fetch(`${API}/rankings`);
        if (!res.ok) throw new Error('API error');
        const data = await res.json();

        const tbody = $('#rankings-table tbody');
        tbody.innerHTML = '';

        data.fish.forEach((fish, i) => {
            const tr = document.createElement('tr');
            if (i < 3) tr.classList.add(`top-${i + 1}`);

            const creditHtml = fish.imageCredit
                ? ` <span class="photo-credit" title="Photo: ${fish.imageCredit.photographer} &mdash; ${fish.imageCredit.license}"><i class="fa-solid fa-camera"></i></span>`
                : '';

            tr.innerHTML = `
                <td class="rank">${i + 1}</td>
                <td class="rank-img">
                    ${fish.image ? `<img src="${fish.image}" alt="" width="40" height="40">${creditHtml}` : ''}
                </td>
                <td class="rank-name">
                    <span class="name">${fish.name}</span>
                    <span class="tags">${(fish.tags || []).slice(0, 2).join(' · ')}</span>
                </td>
                <td class="rank-elo">${fish.elo}</td>
                <td class="rank-wins">${fish.wins}</td>
                <td class="rank-losses">${fish.losses}</td>
            `;
            tbody.appendChild(tr);
        });

        $('#rankings-count').textContent = `${data.fish.length} fish`;
    } catch (e) {
        console.error(e);
    }
}

async function loadEloInfo() {
    try {
        const res = await fetch(`${API}/elo-info`);
        if (!res.ok) return;
        const info = await res.json();

        $('#elo-info-content').innerHTML = `
            <p class="elo-simple">${info.simple}</p>
            <div class="elo-example">
                <strong>Example:</strong>
                <span>${info.example}</span>
            </div>
            <details class="elo-details">
                <summary><i class="fa-solid fa-square-root-variable"></i> The math (for nerds)</summary>
                <div class="elo-formulas">
                    <div class="elo-formula">
                        <strong>Expected Score</strong>
                        <code>${info.expected_formula}</code>
                    </div>
                    <div class="elo-formula">
                        <strong>Rating Update</strong>
                        <code>${info.update_formula}</code>
                    </div>
                </div>
                <div class="elo-params">
                    <div><span class="param-label">K-Factor</span> <span class="param-value">${info.k_factor}</span></div>
                    <div><span class="param-label">Initial Rating</span> <span class="param-value">${info.initial_rating}</span></div>
                </div>
                <p class="elo-technical">${info.technical}</p>
            </details>
        `;
    } catch (e) {
        console.error(e);
    }
}

async function updateStats() {
    try {
        const res = await fetch(`${API}/rankings`);
        if (!res.ok) return;
        const data = await res.json();
        const totalMatches = data.fish.reduce((sum, f) => sum + f.wins, 0);
        $('#stats-matches').textContent = `${totalMatches} votes`;
    } catch (e) {
        console.error(e);
    }
}

$('#tab-vote').addEventListener('click', () => {
    $('#tab-vote').classList.add('active');
    $('#tab-rankings').classList.remove('active');
    $('#vote-section').style.display = 'block';
    $('#rankings-section').style.display = 'none';
    $('#elo-info-section').style.display = 'block';
});

$('#tab-rankings').addEventListener('click', () => {
    $('#tab-rankings').classList.add('active');
    $('#tab-vote').classList.remove('active');
    $('#vote-section').style.display = 'none';
    $('#rankings-section').style.display = 'block';
    $('#elo-info-section').style.display = 'block';
    loadRankings();
});

$('#card-a').addEventListener('click', () => {
    if (!currentMatchup || voting) return;
    vote(currentMatchup.fish_a.id, currentMatchup.fish_b.id);
});

$('#card-b').addEventListener('click', () => {
    if (!currentMatchup || voting) return;
    vote(currentMatchup.fish_b.id, currentMatchup.fish_a.id);
});

$('#btn-skip').addEventListener('click', (e) => {
    e.stopPropagation();
    if (voting) return;
    loadMatchup();
});

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (!currentMatchup || voting) return;
    if (e.key === 'ArrowLeft') {
        vote(currentMatchup.fish_a.id, currentMatchup.fish_b.id);
    } else if (e.key === 'ArrowRight') {
        vote(currentMatchup.fish_b.id, currentMatchup.fish_a.id);
    } else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (!voting) loadMatchup();
    }
});

updateStats();
loadMatchup();
loadEloInfo();

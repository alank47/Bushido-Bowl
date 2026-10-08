// Cloudflare Worker for Mike's AI write-ups on bushidobowl.org (mikestrade.alank-42a.workers.dev):
// trade analysis, and the weekly recap (requests with type: 'recap').
//
// The site sends only the data; this Worker builds the prompt, picks the model,
// and calls Claude. Requests from anywhere other than the site are rejected, so the
// endpoint can't be used as a general-purpose Claude proxy on our API key.
//
// Requires a secret named ANTHROPIC_API_KEY (Workers > Settings > Variables and Secrets).

const ALLOWED_ORIGINS = ['https://bushidobowl.org', 'https://www.bushidobowl.org'];
const MODEL = 'claude-opus-5-5';
const MAX_ASSETS_PER_TEAM = 20;
const MAX_TEXT_LENGTH = 100;
const DYNASTY_FIRST_SEASON = 2025;
const DYNASTY_FINAL_SEASON = 2029;

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin');
        if (!ALLOWED_ORIGINS.includes(origin)) {
            return new Response('Forbidden', { status: 403 });
        }

        const cors = {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Vary': 'Origin',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors });
        }
        if (request.method !== 'POST') {
            return new Response('Method not allowed', { status: 405, headers: cors });
        }

        let prompt;
        try {
            const body = await request.json();
            prompt = body?.type === 'recap' ? buildRecapPrompt(parseRecap(body)) : buildPrompt(parseTrade(body));
        } catch (error) {
            return json({ error: `Invalid request: ${error.message}` }, 400, cors);
        }

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'server-side-fallback-2026-07-01',
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 4000,
                output_config: { effort: 'low' },
                fallbacks: 'default',
                messages: [{ role: 'user', content: prompt }],
            }),
        });

        if (!response.ok) {
            console.error('Claude API error:', response.status, await response.text());
            return json({ error: 'Analysis failed' }, 502, cors);
        }

        const data = await response.json();
        if (data.stop_reason === 'refusal') {
            return json({ error: 'Analysis declined' }, 502, cors);
        }

        const text = data.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('\n\n');

        return json({ text }, 200, cors);
    },
};

function json(body, status, headers) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...headers, 'Content-Type': 'application/json' },
    });
}

function cleanText(value) {
    if (typeof value !== 'string' || value.length === 0) throw new Error('missing text field');
    return value.slice(0, MAX_TEXT_LENGTH);
}

function cleanNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error('bad number');
    return Math.round(number);
}

// Optional fields: dropped rather than rejected if missing or malformed
function optionalNumber(value) {
    const number = Number(value);
    return value != null && Number.isFinite(number) && number >= 0 ? number : null;
}

function optionalText(value) {
    return typeof value === 'string' && value.length > 0 ? value.slice(0, 10) : null;
}

function parseAsset(asset) {
    const age = optionalNumber(asset.age);
    return {
        desc: cleanText(asset.desc),
        age: age && age < 50 ? Math.round(age) : null,
        position: optionalText(asset.position),
    };
}

function parseTeam(team) {
    if (!team || !Array.isArray(team.assets)) throw new Error('missing team');
    if (team.assets.length > MAX_ASSETS_PER_TEAM) throw new Error('too many assets');
    const rank = optionalNumber(team.standing?.rank);
    const points = optionalNumber(team.standing?.points);
    return {
        name: cleanText(team.name),
        total: cleanNumber(team.total),
        assets: team.assets.map(parseAsset),
        standing: rank && points != null ? { rank: Math.round(rank), points: Math.round(points * 10) / 10 } : null,
    };
}

function parseTrade(body) {
    const season = optionalNumber(body.season);
    const totalTeams = optionalNumber(body.totalTeams);
    return {
        tradeDate: cleanText(body.tradeDate),
        season: season >= DYNASTY_FIRST_SEASON && season <= DYNASTY_FINAL_SEASON ? Math.round(season) : null,
        totalTeams: totalTeams ? Math.round(totalTeams) : null,
        team1: parseTeam(body.team1),
        team2: parseTeam(body.team2),
    };
}

// The NFL season still in play - January/February belong to the previous year's season
function currentSeason() {
    const now = new Date();
    return now.getUTCMonth() < 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}

// "Bijan Robinson (RB, 24 now, 27 in 2029)" - ages are today's ages from Sleeper
function describeAsset(asset) {
    const details = [];
    if (asset.position) details.push(asset.position);
    if (asset.age) {
        const yearsLeft = Math.max(0, DYNASTY_FINAL_SEASON - currentSeason());
        details.push(yearsLeft > 0 ? `${asset.age} now, ${asset.age + yearsLeft} in ${DYNASTY_FINAL_SEASON}` : `age ${asset.age}`);
    }
    return details.length ? `${asset.desc} (${details.join(', ')})` : asset.desc;
}

function describeStanding(team, totalTeams) {
    if (!team.standing) return null;
    const outOf = totalTeams ? ` of ${totalTeams}` : '';
    return `${team.name} is currently #${team.standing.rank}${outOf} in the dynasty standings with ${team.standing.points} points`;
}

function buildPrompt({ tradeDate, season, totalTeams, team1, team2 }) {
    const diff = Math.abs(team1.total - team2.total);
    const larger = Math.max(team1.total, team2.total);
    const diffPercent = larger > 0 ? (diff / larger * 100).toFixed(1) : 0;
    const winner = team1.total > team2.total ? team1.name : team2.name;
    const fairnessDetail = diffPercent > 5 ? `${winner} got ${diffPercent}% more value` : 'Even value';

    const seasonsLeft = season ? DYNASTY_FINAL_SEASON - season + 1 : null;
    const timing = season
        ? `This trade happened during the ${season} season - season ${season - DYNASTY_FIRST_SEASON + 1} of 5, with ${seasonsLeft} season${seasonsLeft === 1 ? '' : 's'} (including this one) left until the dynasty ends after ${DYNASTY_FINAL_SEASON}.`
        : `The dynasty runs from ${DYNASTY_FIRST_SEASON} through the end of the ${DYNASTY_FINAL_SEASON} season.`;
    const standings = [describeStanding(team1, totalTeams), describeStanding(team2, totalTeams)].filter(Boolean);

    return `You are Mike Wilcoxon - a 30-something father and AMC Theaters GM analyzing a dynasty fantasy football trade. You're educated and pragmatic, the voice of reason in the group. You're also a huge Kanye fan, Survivor superfan, A24 film enthusiast, and long-suffering Chargers supporter.

TRADE DETAILS:
Date: ${tradeDate}
${team1.name} receives: ${team1.assets.map(a => describeAsset(a)).join(', ')} (Total Value: ${team1.total})
${team2.name} receives: ${team2.assets.map(a => describeAsset(a)).join(', ')} (Total Value: ${team2.total})
Trade Value: ${fairnessDetail} (values are current dynasty trade values, not values at the time of the trade)

CONTEXT:
- 5-year dynasty league, ${DYNASTY_FIRST_SEASON}-${DYNASTY_FINAL_SEASON}. ${timing}
- Separate from each season's championship, there's a 5-year prize pot. When the ${DYNASTY_FINAL_SEASON} season ends, the team with the most dynasty points takes it.
- Dynasty points pile up every season from regular season wins, weekly high scores, playoff berths, championship appearances, and titles. So being good every year matters as much as one big peak, and a team that is bad for two seasons digs a hole it has to climb out of.
${standings.length ? standings.map(s => `- ${s}`).join('\n') + '\n' : ''}- Draft picks only help the pot race once the drafted player starts producing, so picks in the final years of the dynasty are worth less for the pot than their trade value suggests.
- League history: There's a legendary "Mahomes Curse" - you got fleeced trading Mahomes to Garret years ago, and the curse says Garret can't win a championship until he trades Mahomes away

YOUR TASK:
Write a concise trade analysis in 2-3 short paragraphs:
1. Who won and why (be honest about value AND fit), plus win-now vs rebuild implications.
2. A long-run outlook for the 5-year pot. Think through how each team's side of the deal looks year by year through ${DYNASTY_FINAL_SEASON}: who is still in their prime by then, who hits an age cliff (especially RBs around 27-28), and when any picks would turn into real production. Say plainly which team this trade helps more in the race for the pot, even if that's a different team than the one who won on value today.
3. Optional, only if it's worth saying: any big risk or upside.

STYLE:
- Pragmatic and insightful, not wordy
- Drop natural references to Kanye, Survivor strategy, A24 films, or Chargers pain when they fit
- Call out fleeces when you see them
- Occasionally reference the Mahomes Curse if relevant
- Sound like a smart guy texting the group chat, not writing an essay
- Keep it fun but don't force every reference into every analysis

Be real, be concise, be Mike.`;
}

// ---------- Weekly recap ----------

const MAX_GAMES = 10;
const MAX_TEAMS = 16;

function cleanScore(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 500) throw new Error('bad score');
    return Math.round(number * 100) / 100;
}

function optionalSigned(value, limit) {
    const number = Number(value);
    return value != null && Number.isFinite(number) && Math.abs(number) <= limit ? Math.round(number * 10) / 10 : null;
}

function parseRecap(body) {
    const season = optionalNumber(body.season);
    const week = optionalNumber(body.week);
    if (!season || season < DYNASTY_FIRST_SEASON || season > DYNASTY_FINAL_SEASON) throw new Error('bad season');
    if (!week || week > 18) throw new Error('bad week');
    if (!Array.isArray(body.games) || !body.games.length || body.games.length > MAX_GAMES) throw new Error('bad games');
    if (!Array.isArray(body.standings) || body.standings.length > MAX_TEAMS) throw new Error('bad standings');
    return {
        season: Math.round(season),
        week: Math.round(week),
        isPlayoffs: body.isPlayoffs === true,
        games: body.games.map(g => ({
            team1: cleanText(g.team1), score1: cleanScore(g.score1),
            team2: cleanText(g.team2), score2: cleanScore(g.score2),
        })),
        highScore: body.highScore ? { team: cleanText(body.highScore.team), score: cleanScore(body.highScore.score) } : null,
        standings: body.standings.map(t => ({
            team: cleanText(t.team),
            record: optionalText(t.record),
            points: optionalNumber(t.points),
            odds: optionalSigned(t.odds, 100),
            oddsChange: optionalSigned(t.oddsChange, 100),
        })),
    };
}

function buildRecapPrompt({ season, week, isPlayoffs, games, highScore, standings }) {
    const results = games.map(g => {
        const [w, l] = g.score1 >= g.score2 ? [[g.team1, g.score1], [g.team2, g.score2]] : [[g.team2, g.score2], [g.team1, g.score1]];
        return `- ${w[0]} ${w[1]} def. ${l[0]} ${l[1]} (margin ${(w[1] - l[1]).toFixed(2)})`;
    }).join('\n');
    const race = standings.map((t, i) => {
        const parts = [`${i + 1}. ${t.team}`];
        if (t.record) parts.push(`${season} record ${t.record}`);
        if (t.points != null) parts.push(`${t.points} dynasty points`);
        if (t.odds != null) parts.push(`${t.odds}% to win the pot${t.oddsChange != null ? ` (${t.oddsChange >= 0 ? '+' : ''}${t.oddsChange} this week)` : ''}`);
        return parts.join(', ');
    }).join('\n');

    return `You are Mike Wilcoxon - a 30-something father and AMC Theaters GM who writes the weekly recap for the Bushido Bowl, a 12-team dynasty fantasy football league. You're educated and pragmatic, the voice of reason in the group. You're also a huge Kanye fan, Survivor superfan, A24 film enthusiast, and long-suffering Chargers supporter.

WEEK ${week} RESULTS (${season}${isPlayoffs ? ', fantasy playoffs' : ''}):
${results}
${highScore ? `\nHigh score of the week: ${highScore.team} with ${highScore.score} (earns the weekly high-score bonus)\n` : ''}
THE 5-YEAR POT RACE (dynasty points so far, chance to win the pot from a simulation, change since last week):
${race}

CONTEXT:
- The dynasty runs ${DYNASTY_FIRST_SEASON}-${DYNASTY_FINAL_SEASON}. After the ${DYNASTY_FINAL_SEASON} season, the team with the most dynasty points takes the pot.
- Dynasty points come from regular-season wins, weekly high scores, playoff berths, title-game appearances and titles.
- League lore: the "Mahomes Curse" - you got fleeced trading Mahomes to Garret years ago, and the curse says Garret can't win a championship until he trades Mahomes away.

YOUR TASK:
Write this week's recap in 3 short paragraphs (about 180 words total):
1. The week's headlines: the high score, the biggest blowout, the closest game, any statement wins.
2. The pot race: who gained or lost the most ground in their pot odds and what it means for the road to ${DYNASTY_FINAL_SEASON}.
3. One line looking ahead or calling someone out.

STYLE:
- Sound like a smart guy texting the group chat, not writing an essay
- Use team names exactly as given; don't invent stats that aren't listed above
- Drop natural references to Kanye, Survivor, A24 films, or Chargers pain when they fit, without forcing them
- Plain text only: no markdown, no headings, no bullet points

Be real, be concise, be Mike.`;
}

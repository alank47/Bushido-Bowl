// Cloudflare Worker for Mike's Trade Tracker™ AI analysis (mikestrade.alank-42a.workers.dev)
//
// The site sends only the trade details; this Worker builds the prompt, picks the model,
// and calls Claude. Requests from anywhere other than the site are rejected, so the
// endpoint can't be used as a general-purpose Claude proxy on our API key.
//
// Requires a secret named ANTHROPIC_API_KEY (Workers > Settings > Variables and Secrets).

const ALLOWED_ORIGINS = ['https://bushidobowl.org', 'https://www.bushidobowl.org'];
const MODEL = 'claude-opus-5-5';
const MAX_ASSETS_PER_TEAM = 20;
const MAX_TEXT_LENGTH = 100;

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

        let trade;
        try {
            trade = parseTrade(await request.json());
        } catch (error) {
            return json({ error: `Invalid trade: ${error.message}` }, 400, cors);
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
                messages: [{ role: 'user', content: buildPrompt(trade) }],
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

function parseTeam(team) {
    if (!team || !Array.isArray(team.assets)) throw new Error('missing team');
    if (team.assets.length > MAX_ASSETS_PER_TEAM) throw new Error('too many assets');
    return {
        name: cleanText(team.name),
        total: cleanNumber(team.total),
        assets: team.assets.map(asset => ({ desc: cleanText(asset.desc) })),
    };
}

function parseTrade(body) {
    return {
        tradeDate: cleanText(body.tradeDate),
        team1: parseTeam(body.team1),
        team2: parseTeam(body.team2),
    };
}

function buildPrompt({ tradeDate, team1, team2 }) {
    const diff = Math.abs(team1.total - team2.total);
    const larger = Math.max(team1.total, team2.total);
    const diffPercent = larger > 0 ? (diff / larger * 100).toFixed(1) : 0;
    const winner = team1.total > team2.total ? team1.name : team2.name;
    const fairnessDetail = diffPercent > 5 ? `${winner} got ${diffPercent}% more value` : 'Even value';

    return `You are Mike Wilcoxon - a 30-something father and AMC Theaters GM analyzing a dynasty fantasy football trade. You're educated and pragmatic, the voice of reason in the group. You're also a huge Kanye fan, Survivor superfan, A24 film enthusiast, and long-suffering Chargers supporter.

TRADE DETAILS:
Date: ${tradeDate}
${team1.name} receives: ${team1.assets.map(a => a.desc).join(', ')} (Total Value: ${team1.total})
${team2.name} receives: ${team2.assets.map(a => a.desc).join(', ')} (Total Value: ${team2.total})
Trade Value: ${fairnessDetail}

CONTEXT:
- 5-year dynasty league with a growing prize pot
- Winner after 5 years takes the whole pot
- League history: There's a legendary "Mahomes Curse" - you got fleeced trading Mahomes to Garret years ago, and the curse says Garret can't win a championship until he trades Mahomes away

YOUR TASK:
Write a concise trade analysis (1-2 short paragraphs max) covering:
- Who won and why (be honest about value AND fit)
- How this impacts the 5-year pot race (dynasty is about sustained excellence)
- Win-now vs rebuild implications
- Any risks or upside worth noting

STYLE:
- Pragmatic and insightful, not wordy
- Drop natural references to Kanye, Survivor strategy, A24 films, or Chargers pain when they fit
- Call out fleeces when you see them
- Occasionally reference the Mahomes Curse if relevant
- Sound like a smart guy texting the group chat, not writing an essay
- Keep it fun but don't force every reference into every analysis

Be real, be concise, be Mike.`;
}

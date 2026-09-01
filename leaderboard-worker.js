// ===================================================================
// The Discount Table, leaderboard.
//
// A Cloudflare Worker with one KV namespace bound as BOARD.
// It keeps the best banked figure per player, per period.
//
// Deploy:
//   1. Cloudflare dashboard, Workers and Pages, Create Worker.
//   2. Paste this file in and deploy it.
//   3. Settings, Variables, KV Namespace Bindings: add a binding named
//      BOARD pointing at a KV namespace. The odoo-mrr-goal namespace
//      you already have is fine to reuse.
//   4. Copy the worker URL and put it in learn.html at LB_URL.
//
// No secrets and no accounts. Names are capped and scores are sanity
// checked, which is enough for an internal scoreboard.
// ===================================================================

const ALLOWED = [
  'https://odooquotecalc.com',
  'https://www.odooquotecalc.com',
  'https://rileyrudolph.github.io'
];

const MAX_SCORE = 100000000;   // a sane ceiling, in dollars per month
const TOP_N = 12;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0],
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json'
  };
}

function clean(name) {
  return String(name || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 18);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers });

    if (url.pathname === '/top' && request.method === 'GET') {
      const period = url.searchParams.get('period') || 'day';
      const key = url.searchParams.get('key') || '';
      const stored = await env.BOARD.get('board:' + period + ':' + key);
      const map = stored ? JSON.parse(stored) : {};
      const rows = Object.keys(map)
        .map(n => ({ name: n, amount: map[n] }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, TOP_N);
      return new Response(JSON.stringify({ rows }), { headers });
    }

    if (url.pathname === '/score' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch (e) { return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers }); }

      const name = clean(body.name);
      const amount = Math.round(Number(body.amount) || 0);
      if (!name || amount <= 0 || amount > MAX_SCORE) {
        return new Response(JSON.stringify({ error: 'rejected' }), { status: 400, headers });
      }

      const now = new Date();
      const pad = n => (n < 10 ? '0' : '') + n;
      const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
      const monday = new Date(Date.UTC(y, m, d));
      monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));

      const keys = {
        day:   y + '-' + pad(m + 1) + '-' + pad(d),
        week:  'w' + monday.getUTCFullYear() + '-' + pad(monday.getUTCMonth() + 1) + '-' + pad(monday.getUTCDate()),
        month: y + '-' + pad(m + 1),
        all:   'all'
      };

      for (const period of Object.keys(keys)) {
        const k = 'board:' + period + ':' + keys[period];
        const stored = await env.BOARD.get(k);
        const map = stored ? JSON.parse(stored) : {};
        if (!map[name] || amount > map[name]) {
          map[name] = amount;
          // Daily and weekly boards expire on their own so KV stays tidy.
          const ttl = period === 'day' ? 60 * 60 * 24 * 3
                    : period === 'week' ? 60 * 60 * 24 * 14
                    : period === 'month' ? 60 * 60 * 24 * 70
                    : undefined;
          await env.BOARD.put(k, JSON.stringify(map), ttl ? { expirationTtl: ttl } : {});
        }
      }
      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers });
  }
};

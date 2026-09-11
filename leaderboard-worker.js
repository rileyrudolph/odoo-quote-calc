// ===================================================================
// The Deal Table, leaderboard.
//
// A Cloudflare Worker with one KV namespace bound as BOARD.
//
// It ranks players on their AVERAGE month, not their best one, and it
// keeps the record server side. Both of those are deliberate:
//
//   - Best-of ranking rewards whoever replays most, not whoever plays
//     best. Averaging every month a player logs means a bad run drags
//     them down, so farming actively hurts.
//   - Because the record lives here and not in the browser, clearing
//     local storage does not erase it. There is no reset.
//
// Each book is its own board. The 1-5 and 6+ desks carry different
// quotas against different sized deals, so they are different games and
// are never listed against each other.
//
// Every difficulty is welcome, because the score is levelled before it
// arrives: Tough genuinely pays less at the table (a $2,040 median month
// against $3,182 on Mixed and $5,714 on Easy), so the client multiplies
// it up and sends the levelled figure. The setting is stored and shown on
// the row, with its multiplier, so nobody has to wonder why.
//
// Deploy:
//   1. Cloudflare dashboard, Workers and Pages, open the existing
//      deal-table-board worker.
//   2. Replace the code with this file and deploy.
//   3. The BOARD KV binding it already has is unchanged.
//
// No secrets and no accounts. Names are capped and scores are sanity
// checked, which is enough for a board among colleagues.
// ===================================================================

const ALLOWED = [
  'https://odooquotecalc.com',
  'https://www.odooquotecalc.com',
  'https://rileyrudolph.github.io'
];

const MAX_SCORE  = 100000000;  // a sane ceiling for one month, in dollars
const TOP_N      = 12;
const MIN_MONTHS = 3;          // months logged before a player is ranked
const SEGMENTS   = ['6to50', '1to5'];
const KEEP_RUNS  = 40;         // dedupe memory per player, in month keys
const DIFFS      = ['easy', 'normal', 'hard'];

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

function segOf(v) {
  return SEGMENTS.indexOf(String(v || '')) >= 0 ? String(v) : '6to50';
}

function diffOf(v) {
  return DIFFS.indexOf(String(v || '')) >= 0 ? String(v) : 'normal';
}

// The difficulty a player mostly played, not whichever one they logged last.
// Overwriting it every post meant five Tough months and one Easy showed as EASY.
function topDiff(tally) {
  let best = 'normal', n = -1;
  for (const d of DIFFS) {
    if ((tally && tally[d] || 0) > n) { n = tally[d] || 0; best = d; }
  }
  return best;
}

// Rows are built the same way for every board, so the monthly and the
// all-time list always agree on what a player's average is.
function build(map, me) {
  const rows = Object.keys(map).map(function (n) {
    const r = map[n];
    const months = r.count || 0;
    return {
      name: n,
      avg: months ? Math.round(r.sum / months) : 0,
      months: months,
      best: Math.round(r.best || 0),
      /* Banked is what ranks you, but MRR and NRR are what the plan measures, so
         the row carries all three. Averaged over the same months as the payout
         so the three numbers on a row always describe one typical month. */
      mrr: months ? Math.round((r.mrrSum || 0) / months) : 0,
      nrr: months ? Math.round((r.nrrSum || 0) / months) : 0,
      /* What those two lines actually paid. A rep does not take home the NRR, they
         take home the commission on it, so this is what the row shows. The pair
         adds up to avg. */
      mrrPay: months ? Math.round((r.mrrPaySum || 0) / months) : 0,
      nrrPay: months ? Math.round((r.nrrPaySum || 0) / months) : 0,
      chip: r.chip || 250,
      difficulty: r.diffs ? topDiff(r.diffs) : (r.difficulty || 'normal'),
      ranked: months >= MIN_MONTHS
    };
  });
  // Ranked players first, by average. Everyone else below, so a new
  // player can see how close they are to appearing.
  rows.sort(function (a, b) {
    if (a.ranked !== b.ranked) { return a.ranked ? -1 : 1; }
    return b.avg - a.avg;
  });
  const top = rows.slice(0, TOP_N);
  // Always keep the asking player in the list, even if they are below the cut,
  // so a newcomer can see how close they are to appearing.
  if (me && !top.some(r => r.name === me)) {
    const mine = rows.find(r => r.name === me);
    if (mine) { top.push(mine); }
  }
  return top;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers });

    // ---- read a board -------------------------------------------------
    if (url.pathname === '/top' && request.method === 'GET') {
      const segment = segOf(url.searchParams.get('segment'));
      const period  = url.searchParams.get('period') === 'all' ? 'all' : 'month';
      const key     = url.searchParams.get('key') || 'all';
      const stored  = await env.BOARD.get('b2:' + segment + ':' + period + ':' + key);
      const map     = stored ? JSON.parse(stored) : {};
      return new Response(JSON.stringify({
        rows: build(map, clean(url.searchParams.get('me'))),
        minMonths: MIN_MONTHS, segment: segment
      }), { headers });
    }

    // ---- log one finished month ---------------------------------------
    if (url.pathname === '/score' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch (e) {
        return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers });
      }

      const name    = clean(body.name);
      const amount  = Math.round(Number(body.amount) || 0);
      const segment = segOf(body.segment);
      const chip    = Math.round(Number(body.chip) || 250);
      const diff    = diffOf(body.difficulty);
      const mrr     = Math.max(0, Math.min(MAX_SCORE, Math.round(Number(body.mrr) || 0)));
      const nrr     = Math.max(0, Math.min(MAX_SCORE, Math.round(Number(body.nrr) || 0)));
      const mrrPay  = Math.max(0, Math.min(MAX_SCORE, Math.round(Number(body.mrrPay) || 0)));
      const nrrPay  = Math.max(0, Math.min(MAX_SCORE, Math.round(Number(body.nrrPay) || 0)));
      // A month is identified by the run it came from plus its number, so a
      // retry or a double click cannot log the same month twice.
      const runKey  = String(body.monthKey || '').replace(/[^\w:-]/g, '').slice(0, 48);

      if (!name || !runKey || amount < 0 || amount > MAX_SCORE) {
        return new Response(JSON.stringify({ error: 'rejected' }), { status: 400, headers });
      }
      const now = new Date();
      const pad = function (n) { return (n < 10 ? '0' : '') + n; };
      const periods = {
        month: now.getUTCFullYear() + '-' + pad(now.getUTCMonth() + 1),
        all:   'all'
      };

      for (const period of Object.keys(periods)) {
        const k = 'b2:' + segment + ':' + period + ':' + periods[period];
        const stored = await env.BOARD.get(k);
        const map = stored ? JSON.parse(stored) : {};
        const rec = map[name] || { sum: 0, count: 0, best: 0, mrrSum: 0, nrrSum: 0,
                                   mrrPaySum: 0, nrrPaySum: 0,
                                   chip: chip, diffs: {}, runs: [] };

        // Already logged this exact month for this player. Ignore it.
        if (rec.runs && rec.runs.indexOf(runKey) >= 0) { continue; }

        rec.sum   = (rec.sum || 0) + amount;
        rec.count = (rec.count || 0) + 1;
        rec.best  = Math.max(rec.best || 0, amount);
        rec.mrrSum = (rec.mrrSum || 0) + mrr;
        rec.nrrSum = (rec.nrrSum || 0) + nrr;
        rec.mrrPaySum = (rec.mrrPaySum || 0) + mrrPay;
        rec.nrrPaySum = (rec.nrrPaySum || 0) + nrrPay;
        rec.chip  = chip;
        rec.diffs = rec.diffs || {};
        rec.diffs[diff] = (rec.diffs[diff] || 0) + 1;
        rec.runs  = (rec.runs || []).concat(runKey).slice(-KEEP_RUNS);
        map[name] = rec;

        // The monthly board ages out; all-time does not.
        const ttl = period === 'month' ? 60 * 60 * 24 * 70 : undefined;
        await env.BOARD.put(k, JSON.stringify(map), ttl ? { expirationTtl: ttl } : {});
      }

      return new Response(JSON.stringify({ ok: true, ranked: true }), { headers });
    }

    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers });
  }
};

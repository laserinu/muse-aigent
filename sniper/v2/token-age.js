// token-age.js — first-pool age check for the token-age gate (Part 51).
//
// User decision 2026-11-08 ~07:42 WIB: only buy a token whose FIRST pool
// (any quote, any DEX) was created < 24h before evaluation. The sniper
// triggers on new POOLS, not new tokens — FOBO's token is ~13 days old
// (first pool 2026-10-26) but the USDG pool bought was 2 min old, and
// scoring rewards established tokens (website/socials 25 pts), so old
// tokens buy while genuinely newborn tokens score under the line.
//
// Sources (both FREE, no key — the earliest creation time either reports wins):
//   Dexscreener: GET https://api.dexscreener.com/latest/dex/tokens/{address}
//     — min pairCreatedAt across ALL pairs (all chains, one call, no
//     pagination). Does NOT index Arc (verified: our own $MUSE returns
//     {"pairs":null}).
//   GeckoTerminal: GET https://api.geckoterminal.com/api/v2/networks/{slug}/tokens/{address}/pools
//     — min pool_created_at. Per-network; the ONLY indexer source for Arc.
//     Free tier 30 calls/min, no key. Verified live 2026-11-08:
//     FOBO earliest pool 2026-10-26T17:02:37Z (matches Dexscreener exactly);
//     $MUSE on Arc: 1 pool, created 2026-11-06T17:10:27Z, reserve $0.9988.
//     Network slugs: robinhood, arc, base, polygon_pos — `polygon` 404s
//     (verified live); the correct Polygon PoS slug is polygon_pos.
//     Page size is 20 and pages are NOT sorted by creation date, so we page
//     up to 3 pages (60 pools), stopping early once an old pool is found —
//     the gate only needs to know whether ANY pool is older than 24h.
//
// Certainty: finding ANY pool older than 24h is conclusive (the true first
// pool can only be older). Passing needs a COMPLETE source: Dexscreener
// returning >= 1 pair is complete (it lists every pair); GeckoTerminal is
// complete only when its last fetched page has < 20 pools (pages exhausted).
// Otherwise the age is UNKNOWN and the gate FAILS OPEN (allow the buy, log
// "age unknown") — the watcher must never stall on an indexer gap.
//
// Cache: per-process Map keyed chainId:token (one watcher run = one
// process, so a token evaluated twice in a cycle costs one lookup).
//
// Env overrides (no config.json change — keep the diff minimal):
//   TOKEN_AGE_ENABLED=0    disables the check (returns unknown -> fail-open)
//   TOKEN_AGE_TIMEOUT_MS   default 4000 per request
//   TOKEN_AGE_MAX_HOURS    default 24
//   TOKEN_AGE_GT_BASE_URL  overrides the GeckoTerminal base URL (tests)
//
// Fail-open contract: checkTokenAge NEVER throws. Every failure path
// returns { known: false, ... }.

const DEXSCREENER_URL =
  process.env.TOKEN_AGE_DEXSCREENER_URL ||
  "https://api.dexscreener.com/latest/dex/tokens";
const GT_BASE_URL =
  process.env.TOKEN_AGE_GT_BASE_URL ||
  "https://api.geckoterminal.com/api/v2";
const TIMEOUT_MS = Number(process.env.TOKEN_AGE_TIMEOUT_MS || 4000);
const MAX_AGE_MS = Number(process.env.TOKEN_AGE_MAX_HOURS || 24) * 3600 * 1000;
const GT_MAX_PAGES = 3;
const GT_PAGE_SIZE = 20;
const GT_NETWORK_SLUGS = {
  4663: "robinhood",
  5042: "arc",
  8453: "base",
  137: "polygon_pos",
};

const cache = new Map();
function cacheKey(chainId, token) {
  return String(chainId) + ":" + String(token).toLowerCase();
}

// fetchJson with ONE retry on network-level failure (2026-11-08, Part 52).
// Found while re-running gates-test.js: checkTokenAge failed ~50% of calls
// with "fetch failed" on BOTH sources in an alternating ok/fail pattern —
// the classic keep-alive race (a pooled socket closed by the server/proxy
// between calls; the retry opens a fresh connection and succeeds). Without
// the retry the age gate fail-opens (allows the buy) on half of all
// evaluations, including recheck evaluations. HTTP responses (even 429/5xx)
// are real answers and are NOT retried — only thrown network/timeout errors.
async function fetchJson(url, timeoutMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    } catch (e) {
      const isHttp = /^HTTP \d+/.test(e.message || "");
      if (attempt === 1 || isHttp) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

// Dexscreener: min pairCreatedAt across all pairs (all chains, one call).
// Returns { firstPoolAtMs, pairs } or { firstPoolAtMs: null, pairs: 0 } when
// the token is not indexed; throws on HTTP/timeout (caller treats as unknown).
async function dexscreenerFirstPool(token, timeoutMs) {
  const d = await fetchJson(
    DEXSCREENER_URL + "/" + token,
    timeoutMs
  );
  const pairs = Array.isArray(d.pairs) ? d.pairs : [];
  let min = null;
  for (const p of pairs) {
    const ts = Number(p.pairCreatedAt);
    if (Number.isFinite(ts) && ts > 0 && (min === null || ts < min)) min = ts;
  }
  return { firstPoolAtMs: min, pairs: pairs.length };
}

// GeckoTerminal: min pool_created_at over up to GT_MAX_PAGES pages.
// Stops early once a pool older than cutoffMs is found (decision made).
// Returns { firstPoolAtMs, pagesFetched, complete } — complete means the
// last fetched page had < GT_PAGE_SIZE pools, i.e. no more pages exist.
// Throws on HTTP/timeout (caller treats as unknown).
async function geckoterminalFirstPool(networkSlug, token, timeoutMs, cutoffMs) {
  let min = null;
  let pagesFetched = 0;
  let complete = false;
  for (let page = 1; page <= GT_MAX_PAGES; page++) {
    const d = await fetchJson(
      `${GT_BASE_URL}/networks/${networkSlug}/tokens/${token}/pools?page=${page}`,
      timeoutMs
    );
    const pools = Array.isArray(d.data) ? d.data : [];
    pagesFetched = page;
    for (const p of pools) {
      const ts = Date.parse(p.attributes && p.attributes.pool_created_at);
      if (Number.isFinite(ts) && (min === null || ts < min)) min = ts;
    }
    if (min !== null && min < cutoffMs) break; // old pool found — decision made
    if (pools.length < GT_PAGE_SIZE) { complete = true; break; }
  }
  return { firstPoolAtMs: min, pagesFetched, complete };
}

// Pure gate decision over a known first-pool timestamp.
// Returns { decision: 'pass'|'reject'|'unknown', ageHours, reason }.
function evaluateAge(firstPoolAtMs, nowMs) {
  const now = Number(nowMs) || Date.now();
  if (firstPoolAtMs === null || firstPoolAtMs === undefined) {
    return { decision: "unknown", ageHours: null, reason: "first-pool age unknown" };
  }
  const ageHours = (now - Number(firstPoolAtMs)) / 3600000;
  if (ageHours < 0) {
    // Creation timestamp in the future (clock skew / bad data) — treat as newborn.
    return { decision: "pass", ageHours, reason: "first pool created in the future (clock skew) — treated as newborn" };
  }
  if (Number(firstPoolAtMs) <= now - MAX_AGE_MS) {
    return {
      decision: "reject",
      ageHours,
      reason: `first pool is ${ageHours.toFixed(1)}h old (>= ${MAX_AGE_MS / 3600000}h) — token too old`,
    };
  }
  return {
    decision: "pass",
    ageHours,
    reason: `first pool is ${ageHours.toFixed(1)}h old (< ${MAX_AGE_MS / 3600000}h) — newborn token`,
  };
}

// Main entry: earliest first-pool time across Dexscreener + GeckoTerminal.
// chain: { chainId, dexscreenerSlug } (dexscreenerSlug unused here —
// Dexscreener answers across all chains; kept for interface symmetry).
// Never throws; unknown age fails open (the evaluator allows the buy).
async function checkTokenAge(chain, token, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : TIMEOUT_MS;
  const nowMs = Number(opts.nowMs) || Date.now();
  const key = cacheKey(chain.chainId, token);
  if (cache.has(key)) return cache.get(key);

  const out = {
    firstPoolAtMs: null,
    ageHours: null,
    known: false,
    sources: [],
    detail: "",
  };
  if (process.env.TOKEN_AGE_ENABLED === "0") {
    out.detail = "token-age: disabled (TOKEN_AGE_ENABLED=0, fail-open)";
    cache.set(key, out);
    return out;
  }

  const cutoffMs = nowMs - MAX_AGE_MS;
  const gtSlug = GT_NETWORK_SLUGS[chain.chainId] || null;

  const [dex, gt] = await Promise.all([
    dexscreenerFirstPool(token, timeoutMs).catch((e) => ({ error: e.message.slice(0, 60) })),
    gtSlug
      ? geckoterminalFirstPool(gtSlug, token, timeoutMs, cutoffMs).catch((e) => ({ error: e.message.slice(0, 60) }))
      : Promise.resolve({ error: "no GeckoTerminal slug for chain " + chain.chainId }),
  ]);

  const candidates = [];
  const used = [];
  if (dex.firstPoolAtMs !== null && dex.firstPoolAtMs !== undefined) {
    candidates.push(dex.firstPoolAtMs);
    used.push("dexscreener");
  }
  if (gt.firstPoolAtMs !== null && gt.firstPoolAtMs !== undefined) {
    candidates.push(gt.firstPoolAtMs);
    used.push("geckoterminal");
  }
  out.sources = used;

  if (candidates.length > 0) {
    out.firstPoolAtMs = Math.min(...candidates);
    const dec = evaluateAge(out.firstPoolAtMs, nowMs);
    out.ageHours = dec.ageHours;
    if (dec.decision === "reject") {
      // An old pool anywhere is conclusive — the true first pool is older still.
      out.known = true;
      out.detail = `token-age: ${dec.reason} [${used.join("+")}]`;
    } else {
      // Passing needs a COMPLETE source: Dexscreener listing >= 1 pair is
      // complete; GeckoTerminal is complete only when its pages ran out.
      const dexComplete = dex.pairs !== undefined && dex.pairs > 0;
      const gtComplete = gt.complete === true;
      out.known = dexComplete || gtComplete;
      out.detail = out.known
        ? `token-age: ${dec.reason} [${used.join("+")}]`
        : `token-age: first pool ${dec.ageHours !== null ? dec.ageHours.toFixed(1) + "h" : "?"} old in the ${used.join("+")} window, but no source is complete — age unknown (fail-open)`;
    }
  } else {
    const errs = [dex.error, gt.error].filter(Boolean).join("; ");
    out.detail = "token-age: first pool unknown on both sources (fail-open)" + (errs ? " [" + errs + "]" : "");
  }

  cache.set(key, out);
  return out;
}

function clearCache() {
  cache.clear();
}

module.exports = {
  checkTokenAge,
  evaluateAge,
  dexscreenerFirstPool,
  geckoterminalFirstPool,
  clearCache,
  GT_NETWORK_SLUGS,
  GT_MAX_PAGES,
};

// social.js — Sniper v2 social/website scoring.
//
// Source: Dexscreener /tokens/v1/{chainSlug}/{tokenAddress}.
// The pair response carries `info.websites[]` and `info.socials[]`.
//   - info is often NULL at detection time (Alon, $MUSE: both info:null on
//     2026-11-07) — so this is SCORED, never a hard gate (design §5).
//   - Dexscreener links are SELF-DECLARED by the token creator, NOT verified
//     by Dexscreener. A listed website/social proves existence, not
//     legitimacy. A website must still LOAD (HTTP 200) to count.
//   - GeckoTerminal has NO social fields — not a source for this.
// Two-tier: instant check at detection, +10 min re-check (config.social
//   .recheckMinutes) for tokens that had info:null at detection.

const DEFAULT_TIMEOUT_MS = 3000;
const UA = { "User-Agent": "Mozilla/5.0 (compatible; MuseSniperV2/2.0)" };

async function fetchJson(url, timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Fetch the Dexscreener token page for one token on one chain.
// Returns { websites: string[], socials: {type,url}[], pairAddress, infoPresent, rawInfo }
// or { websites: [], socials: [], infoPresent: false } when info is null/absent.
async function fetchDexscreenerInfo(chainSlug, tokenAddress) {
  const url = `https://api.dexscreener.com/tokens/v1/${chainSlug}/${tokenAddress}`;
  const json = await fetchJson(url);
  if (!json || !Array.isArray(json) || json.length === 0) {
    return { websites: [], socials: [], infoPresent: false, error: "no-pairs" };
  }
  // Prefer the pair with the most liquidity (first is usually the main one).
  const pairs = [...json].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const pair = pairs[0];
  const info = pair.info || null;
  if (!info) {
    return { websites: [], socials: [], infoPresent: false, pairAddress: pair.pairAddress };
  }
  return {
    websites: (info.websites || []).map((w) => w.url).filter(Boolean),
    socials: (info.socials || []).map((s) => ({ type: s.type, url: s.url })).filter((s) => s.url),
    infoPresent: true,
    pairAddress: pair.pairAddress,
    imageUrl: info.imageUrl || null,
  };
}

// A website counts only if it loads HTTP 200 (HEAD first, GET fallback).
// Any network error, redirect loop, 4xx/5xx, or timeout = does NOT count.
async function websiteLoads(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { method: "HEAD", headers: UA, signal: ctl.signal, redirect: "follow" });
    clearTimeout(t);
    if (res.ok) return true;
    // Some sites reject HEAD — try a short GET before giving up.
    const ctl2 = new AbortController();
    const t2 = setTimeout(() => ctl2.abort(), timeoutMs);
    const res2 = await fetch(url, { method: "GET", headers: UA, signal: ctl2.signal, redirect: "follow" });
    clearTimeout(t2);
    return res2.ok;
  } catch {
    return false;
  }
}

// Score the social/website component (max 25, per design §6):
//   website loads + >=2 socials  -> 25
//   website loads + 1 social     -> 20
//   website loads only           -> 10
//   socials only (no website)    -> 10
//   nothing                      -> 0
// Returns { points, detail } where detail lists which links were counted.
async function scoreSocial(chainSlug, tokenAddress, cfg) {
  const timeoutMs = cfg?.social?.websiteTimeoutMs || DEFAULT_TIMEOUT_MS;
  const info = await fetchDexscreenerInfo(chainSlug, tokenAddress);
  if (!info.infoPresent) {
    return { points: 0, detail: "info:null on Dexscreener — re-check at +10 min", websites: [], socials: [], infoPresent: false };
  }
  let websiteOk = false;
  let websiteChecked = null;
  for (const w of info.websites.slice(0, 2)) {
    websiteChecked = w;
    if (await websiteLoads(w, timeoutMs)) { websiteOk = true; break; }
  }
  const nSocials = info.socials.length;
  let points = 0;
  if (websiteOk && nSocials >= 2) points = 25;
  else if (websiteOk && nSocials === 1) points = 20;
  else if (websiteOk) points = 10;
  else if (nSocials > 0) points = 10;
  const detail = [
    websiteChecked ? `website ${websiteChecked} ${websiteOk ? "loads (200)" : "does NOT load"}` : "no website listed",
    `${nSocials} social(s) listed: ${info.socials.map((s) => `${s.type}:${s.url}`).join(", ") || "none"}`,
  ].join("; ");
  return { points, detail, websites: info.websites, socials: info.socials, infoPresent: true, websiteOk };
}

module.exports = { fetchDexscreenerInfo, websiteLoads, scoreSocial };

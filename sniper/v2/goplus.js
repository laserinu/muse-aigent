// goplus.js — GoPlus token_security second-opinion check for the snipers.
//
// Built 2026-11-08 (tools-and-sites Part 48). Endpoint:
//   GET https://api.gopluslabs.io/api/v1/token_security/<chainId>?contract_addresses=<token>
// Free, NO API key. Live-verified 2026-11-08: GoPlus `supported_chains`
// lists BOTH Robinhood Chain (4663) and Arc (5042), and token_security
// returns code 1 + a full result for $RMUSE on 4663 and $MUSE on 5042.
//
// Role: SECOND OPINION ONLY. The onchain honeypot buy+sell simulation stays
// primary: if GoPlus says is_honeypot=1 and the sim passed, we log the
// disagreement, apply a small penalty (-5), and trust the sim — never a veto,
// never a SKIP. The value of GoPlus is NOT its honeypot flag (our sim is
// stronger) but:
//   - honeypot_with_same_creator — a deployer-history signal we cannot
//     compute cheaply ourselves (GoPlus's creator is the deployer EOA, not
//     the factory — verified live on DELTA: creator 0x1eaf... is an EOA
//     holding 0.37%, while the Pons factory is a different address);
//   - buy/sell tax fields — for hooked pools where our quoter is
//     inconclusive, a token-level tax is real signal (hook taxes show as
//     "" = unknown, not 0 — our own $MUSE returns buy_tax "" because the
//     3% lives in the hook, not the token);
//   - hidden_owner / is_proxy / can_take_back_ownership;
//   - top-10 holder share (non-contract holders only — see below).
//
// Score component "goplus-second-opinion", clamped to [-10, +5]:
//   clean (+5): is_honeypot explicitly "0", buy AND sell tax both known
//     and 0, honeypot_with_same_creator "0", no hidden owner / proxy /
//     take-back-ownership, top-10 non-contract share <= 40%. Null/unknown
//     fields BLOCK the bonus — at T+0 GoPlus often returns nulls for fresh
//     tokens (e.g. `bottom` has is_honeypot null), so most new launches
//     score 0 here, not +5. Conservative by design.
//   honeypot_with_same_creator == "1":
//     creator is the deployer EOA        -> -10
//     creator is the creation-tx factory -> -3  (weak: a factory that
//       deployed thousands of tokens having one honeypot in its history
//       says little about this token)
//     creator is neither / unknown       -> -5
//   is_honeypot == "1": -5 (disagreement with the sim is logged; sim wins)
//   buy_tax or sell_tax > 5%: -5; > 0%: -2 ("" = unknown, never counted)
//   hidden_owner / is_proxy / can_take_back_ownership == "1": -5
//     (any one; not stacked)
//   top-10 NON-CONTRACT holder share (GoPlus holders[], is_contract=0
//     only — pool/burn/locker contracts are excluded, per the Part 47
//     checklist: a pool holding 90% is not concentration. Our own $RMUSE
//     is 90.19% PoolManager + 8.81% agent wallet -> non-contract 8.8%):
//     > 50%: -5; > 40%: -2
//   token not indexed / call fails / timeout / disabled: 0, fail-open.
//
// Env overrides (no config.json change — keep the diff minimal):
//   GOPLUS_ENABLED=0     disables the check (0 points, "disabled" detail)
//   GOPLUS_BASE_URL      overrides the endpoint (tests simulate outage with it)
//   GOPLUS_TIMEOUT_MS    default 4000
//
// Fail-open contract: scoreGoPlus NEVER throws. Every failure path returns
// { points: 0, detail: "goplus: ... (fail-open)", raw: null }.

const BASE_URL =
  process.env.GOPLUS_BASE_URL ||
  "https://api.gopluslabs.io/api/v1/token_security";
const TIMEOUT_MS = Number(process.env.GOPLUS_TIMEOUT_MS || 4000);
const ENABLED = process.env.GOPLUS_ENABLED !== "0";

// Weights — the only tuning knobs; everything below reads these.
const W = {
  cleanBonus: 5,
  creatorHoneypotDeployer: -10,
  creatorHoneypotFactory: -3,
  creatorHoneypotUnknown: -5,
  honeypotFlag: -5,
  taxHigh: -5, // max(buy,sell) tax > 5%
  taxLow: -2, // max(buy,sell) tax > 0%
  hiddenOrProxy: -5,
  top10High: -5, // non-contract top-10 share > 50%
  top10Mid: -2, // non-contract top-10 share > 40%
  minPoints: -10,
  maxPoints: 5,
};
const TAX_HIGH = 0.05; // 5% — GoPlus taxes are fractions ("0.05" = 5%)
const TOP10_HIGH = 0.5;
const TOP10_MID = 0.4;

const isOne = (v) => v === "1" || v === 1 || v === true;

// GoPlus taxes are fraction strings ("0" / "0.05"); "" or null = unknown.
function parseTax(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Sum of the top-10 holders' shares EXCLUDING contracts (is_contract=1).
// GoPlus `percent` is a fraction string ("0.088103" = 8.81%). Returns null
// when no usable holder data is present.
function top10NonContractShare(holders) {
  if (!Array.isArray(holders) || holders.length === 0) return null;
  let sum = 0;
  let counted = 0;
  for (const h of holders.slice(0, 10)) {
    if (h.is_contract === 1 || h.is_contract === true) continue;
    const p = parseFloat(h.percent);
    if (!Number.isFinite(p)) continue;
    sum += p;
    counted++;
  }
  return counted > 0 ? sum : null;
}

async function fetchTokenSecurity(chainId, token) {
  const url =
    BASE_URL.replace(/\/$/, "") +
    "/" +
    encodeURIComponent(String(chainId)) +
    "?contract_addresses=" +
    encodeURIComponent(token);
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; MuseSniperV2/2.0)" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("GoPlus HTTP " + res.status);
  const json = await res.json();
  if (json.code !== 1) throw new Error("GoPlus code " + json.code + ": " + (json.message || ""));
  const entry = (json.result || {})[token.toLowerCase()];
  if (!entry) return { indexed: false, raw: null };
  return { indexed: true, raw: entry };
}

// Pure scoring of one GoPlus token_security result object.
// Exported so the mapping can be tested without the network.
function scoreFromRaw(r, opts = {}) {
  const deployer = (opts.deployer || "").toLowerCase() || null;
  const creatorContract = (opts.creatorContract || "").toLowerCase() || null;
  const creator = (r.creator_address || "").toLowerCase() || null;

  const honeypotFlag = isOne(r.is_honeypot);
  const creatorHoneypot = isOne(r.honeypot_with_same_creator);
  const buyTax = parseTax(r.buy_tax);
  const sellTax = parseTax(r.sell_tax);
  const maxTax =
    buyTax === null && sellTax === null
      ? null
      : Math.max(buyTax === null ? 0 : buyTax, sellTax === null ? 0 : sellTax);
  const hiddenOrProxy =
    isOne(r.hidden_owner) || isOne(r.is_proxy) || isOne(r.can_take_back_ownership);
  const top10 = top10NonContractShare(r.holders);

  const raw = {
    isHoneypot: r.is_honeypot ?? null,
    honeypotWithSameCreator: r.honeypot_with_same_creator ?? null,
    buyTax: r.buy_tax ?? null,
    sellTax: r.sell_tax ?? null,
    hiddenOwner: r.hidden_owner ?? null,
    isProxy: r.is_proxy ?? null,
    canTakeBackOwnership: r.can_take_back_ownership ?? null,
    creator: r.creator_address ?? null,
    creatorPercent: r.creator_percent ?? null,
    holderCount: r.holder_count ?? null,
    top10NonContractShare: top10,
    isOpenSource: r.is_open_source ?? null,
  };

  // Score: start at 0, apply negatives, clean bonus only if NO negative
  // signal fired AND the key fields are explicitly known-clean.
  let points = 0;
  const notes = [];

  if (creatorHoneypot) {
    let pen = W.creatorHoneypotUnknown;
    let who = "creator has honeypot history (creator is neither the deployer nor the creation factory — ambiguous)";
    if (creator && deployer && creator === deployer) {
      pen = W.creatorHoneypotDeployer;
      who = "this deployer created honeypots before";
    } else if (creator && creatorContract && creator === creatorContract) {
      pen = W.creatorHoneypotFactory;
      who = "deploying factory has honeypot history (weak — factory deployed many tokens)";
    }
    points += pen;
    notes.push(`honeypot_with_same_creator=1 (${who}) ${pen}`);
  }

  if (honeypotFlag) {
    points += W.honeypotFlag;
    notes.push(
      `is_honeypot=1 — DISAGREEMENT with onchain sim (sim passed, sim wins, no veto) ${W.honeypotFlag}`,
    );
  }

  if (maxTax !== null && maxTax > TAX_HIGH) {
    points += W.taxHigh;
    notes.push(`tax ${((maxTax || 0) * 100).toFixed(1)}% > 5% ${W.taxHigh}`);
  } else if (maxTax !== null && maxTax > 0) {
    points += W.taxLow;
    notes.push(`tax ${((maxTax || 0) * 100).toFixed(1)}% ${W.taxLow}`);
  }

  if (hiddenOrProxy) {
    points += W.hiddenOrProxy;
    const what = [
      isOne(r.hidden_owner) ? "hidden_owner" : null,
      isOne(r.is_proxy) ? "is_proxy" : null,
      isOne(r.can_take_back_ownership) ? "can_take_back_ownership" : null,
    ]
      .filter(Boolean)
      .join("+");
    notes.push(`${what}=1 ${W.hiddenOrProxy}`);
  }

  if (top10 !== null && top10 > TOP10_HIGH) {
    points += W.top10High;
    notes.push(`top-10 non-contract holders ${(top10 * 100).toFixed(1)}% > 50% ${W.top10High}`);
  } else if (top10 !== null && top10 > TOP10_MID) {
    points += W.top10Mid;
    notes.push(`top-10 non-contract holders ${(top10 * 100).toFixed(1)}% > 40% ${W.top10Mid}`);
  }

  if (points === 0) {
    const explicitlyClean =
      r.is_honeypot === "0" &&
      r.honeypot_with_same_creator === "0" &&
      buyTax === 0 &&
      sellTax === 0 &&
      !hiddenOrProxy &&
      (top10 === null || top10 <= TOP10_MID);
    if (explicitlyClean) {
      points = W.cleanBonus;
      notes.push(
        `clean — honeypot 0, creator-history 0, taxes 0/0, no hidden owner/proxy${top10 !== null ? `, top-10 non-contract ${(top10 * 100).toFixed(1)}%` : ", holder data absent"} +${W.cleanBonus}`,
      );
    } else {
      notes.push("no red flags, but key fields unknown (nulls) — no clean bonus at T+0");
    }
  }

  points = Math.max(W.minPoints, Math.min(W.maxPoints, points));
  return {
    points,
    detail: "goplus: " + notes.join("; "),
    raw,
  };
}

// Main entry: score one token on one chain.
// opts: { deployer, creatorContract } — lowercased addresses from the
// evaluator's creation-receipt lookup; both optional (unknown -> middle
// penalty tier for the creator-history signal).
async function scoreGoPlus(chainId, token, opts = {}) {
  const failOpen = (detail) => ({ points: 0, detail, raw: null });
  if (!ENABLED) return failOpen("goplus: disabled (GOPLUS_ENABLED=0)");
  if (!chainId || !token) return failOpen("goplus: no chain/token given");

  let fetched;
  try {
    fetched = await fetchTokenSecurity(chainId, token);
  } catch (e) {
    return failOpen("goPlus: request failed (fail-open): " + e.message.slice(0, 80));
  }
  if (!fetched.indexed) {
    return failOpen("goplus: token not indexed yet — no signal");
  }
  return scoreFromRaw(fetched.raw, opts);
}

module.exports = { scoreGoPlus, scoreFromRaw, fetchTokenSecurity, W };

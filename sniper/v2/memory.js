// memory.js — Deployer/wallet/token memory for the snipers (built 2026-11-08).
//
// Modeled on aegis's "Second Brain" (MIT, see research report
// ~/workspace/research_notes/best-sniper-bots-20261108-0622/report.md):
// every deployer/wallet/token ever evaluated is remembered in a local
// SQLite database, and deployer reputation adjusts the score by up to
// ±25 (aegis-style). A follow-up job (memory-followup.js) re-checks each
// token at 24h / 72h / 7d and marks it alive / rugged / abandoned —
// without it, deployer reputation never updates.
//
// Store: SQLite via node:sqlite (built into Node 24 — no native dep).
// Default file: ~/workspace/tokens/sniper/v2/memory.sqlite (shared by
// v2, v3, and — when wired — v1). Override with MEMORY_DB_PATH (tests).
//
// FAIL-OPEN CONTRACT (hard rule): every public function catches its own
// errors and returns a neutral value. A missing/corrupt/locked database
// must NEVER break a watcher cycle — scoring falls back to exactly
// today's behavior (no memory adjustment, deployer-history as before).
// Callers ALSO lazy-require this module inside try/catch, so even a
// syntax error here degrades to no-memory instead of breaking the
// evaluator.
//
// Schema:
//   deployers(address, first_seen_at, last_seen_at)
//   tokens(chain_id, token, pool_id, pool_address, pool_type, deployer,
//          creator_contract, symbol, quote_symbol, quote_address, source,
//          first_seen_at, first_price, first_price_quote, peak_price,
//          score, score_breakdown, decision, buy_tx, buy_amount_in,
//          outcome_24h, outcome_72h, outcome_7d, final_outcome,
//          last_checked_at)   -- PK (chain_id, token)
//   evaluations(id, chain_id, token, pool_id, deployer, score,
//               score_breakdown, decision, evaluated_at)
//     (append-only log of every scored evaluation — feeds the buy-line
//      calibration work in research idea #2.)
//
// Reputation ladder (deterministic, documented — calibrate from outcome
// data later, do not tune by feel):
//   counts = tokens by this deployer with a resolved outcome, where
//   outcome = final_outcome ?? latest non-null checkpoint status
//     (a 24h rug is signal now, not in 7 days)
//   r = rugged, a = abandoned, l = alive
//   r >= 3 and r/(r+l) >= 0.75  -> -15  (serial rugger; aegis: 3/3 -> -15)
//   r >= 2 and r/(r+l) >= 0.50  -> -10
//   (r+a) >= 3 and l == 0       -> -5   (everything they launch dies)
//   l >= 5 and r == 0           -> +10  (trusted deployer; aegis: 5/6 -> +10)
//   l >= 3 and r == 0           -> +5
//   else 0 (unknown / too little data — NEVER penalize the unknown)
//   Result clamped to [-25, +25] (ladder maxes at ±15; cap enforced anyway).
//
// Outcome classification (follow-up job; aegis-adapted for micro-caps):
//   rugged    = price <= 10% of peak AND (liquidityUsd < $100 OR 0 trades/24h)
//               (aegis uses liquidity < $2,000 — our pools are BORN at
//               ~$1,300 liquidity, so that bar would rug-flag everything)
//   abandoned = not rugged AND 0 trades in the last 24h
//               (dead: nobody trades it — like our five original v1
//               positions: 0 trades in 6h, price flat, not rugged)
//   alive     = trades in the last 24h and not rugged
//   unknown   = no trade data available (Dexscreener unindexed and no
//               onchain fallback) — outcome NOT resolved, retry next check.

const fs = require("fs");
const path = require("path");

const DEFAULT_DB = "/home/hatch/workspace/tokens/sniper/v2/memory.sqlite";

let _db = null;      // DatabaseSync instance or null when disabled
let _disabled = false;
let _warned = false;

function dbPath() {
  return process.env.MEMORY_DB_PATH || DEFAULT_DB;
}

function warnOnce(msg) {
  if (_warned) return;
  _warned = true;
  console.warn("[memory] " + msg + " — running WITHOUT memory (fail-open).");
}

function open() {
  if (_db) return _db;
  if (_disabled) return null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const p = dbPath();
    // Create the parent dir only if missing — NON-recursive on purpose:
    // recursive mkdir can hang on exotic filesystems (proven: /proc).
    // The default parent always exists; tests use a temp dir that exists.
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const db = new DatabaseSync(p);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS deployers (
        address TEXT PRIMARY KEY,
        first_seen_at TEXT, last_seen_at TEXT
      );
      CREATE TABLE IF NOT EXISTS tokens (
        chain_id INTEGER NOT NULL, token TEXT NOT NULL,
        pool_id TEXT, pool_address TEXT, pool_type TEXT,
        deployer TEXT, creator_contract TEXT,
        symbol TEXT, quote_symbol TEXT, quote_address TEXT,
        source TEXT,
        first_seen_at TEXT NOT NULL,
        first_price REAL, first_price_quote TEXT, peak_price REAL,
        score INTEGER, score_breakdown TEXT,
        decision TEXT, buy_tx TEXT, buy_amount_in TEXT,
        outcome_24h TEXT, outcome_72h TEXT, outcome_7d TEXT,
        final_outcome TEXT, last_checked_at TEXT,
        PRIMARY KEY (chain_id, token)
      );
      CREATE TABLE IF NOT EXISTS evaluations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain_id INTEGER, token TEXT, pool_id TEXT, deployer TEXT,
        score INTEGER, score_breakdown TEXT, decision TEXT, evaluated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tokens_deployer ON tokens(deployer);
      CREATE INDEX IF NOT EXISTS idx_tokens_first_seen ON tokens(first_seen_at);
      CREATE INDEX IF NOT EXISTS idx_eval_deployer ON evaluations(deployer);
      CREATE INDEX IF NOT EXISTS idx_eval_token ON evaluations(chain_id, token);
    `);
    _db = db;
    // Migration: evaluations.source (which evaluator scored it — v2/v3
    // score differently, so calibration must separate them). Added
    // 2026-11-08, hours after the table was created; harmless if present.
    try {
      const cols = db.prepare("PRAGMA table_info(evaluations)").all().map((c) => c.name);
      if (!cols.includes("source")) db.exec("ALTER TABLE evaluations ADD COLUMN source TEXT;");
    } catch { /* migration is best-effort */ }
    return db;
  } catch (e) {
    _disabled = true;
    warnOnce("cannot open database at " + dbPath() + ": " + e.message);
    return null;
  }
}

// For tests: close + reset the singleton (and optionally delete the file).
function _resetForTest() {
  try { if (_db) _db.close(); } catch { /* ignore */ }
  _db = null; _disabled = false; _warned = false;
}

function nowIso() { return new Date().toISOString(); }

// Record one scored evaluation. First evaluation wins for first_seen_at /
// first_price / T+0 score (the calibration data); later evaluations are
// appended to the evaluations log only. Never throws.
function recordEvaluation(ev) {
  try {
    const db = open();
    if (!db || !ev || !ev.token || !ev.chainId) return false;
    const token = String(ev.token).toLowerCase();
    const deployer = ev.deployer ? String(ev.deployer).toLowerCase() : null;
    const seenAt = ev.firstSeenAt || nowIso();
    const breakdown = ev.scoreBreakdown ? JSON.stringify(ev.scoreBreakdown) : null;
    db.prepare(`
      INSERT INTO tokens
        (chain_id, token, pool_id, pool_address, pool_type, deployer,
         creator_contract, symbol, quote_symbol, quote_address, source,
         first_seen_at, first_price, first_price_quote, peak_price,
         score, score_breakdown, decision, buy_tx, buy_amount_in)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain_id, token) DO NOTHING
    `).run(
      ev.chainId, token, ev.poolId || null, ev.poolAddress || null,
      ev.poolType || null, deployer, ev.creatorContract || null,
      ev.symbol || null, ev.quoteSymbol || null, ev.quoteAddress || null,
      ev.source || null, seenAt,
      ev.firstPrice ?? null, ev.firstPriceQuote || null,
      ev.firstPrice ?? null, // peak starts at the first price
      ev.score ?? null, breakdown, ev.decision || null,
      ev.buyTx || null, ev.buyAmountIn || null,
    );
    db.prepare(`
      INSERT INTO evaluations
        (chain_id, token, pool_id, deployer, score, score_breakdown, decision, evaluated_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ev.chainId, token, ev.poolId || null, deployer, ev.score ?? null, breakdown, ev.decision || null, seenAt, ev.source || null);
    if (deployer) {
      db.prepare(`
        INSERT INTO deployers (address, first_seen_at, last_seen_at)
        VALUES (?, ?, ?)
        ON CONFLICT(address) DO UPDATE SET last_seen_at = excluded.last_seen_at
      `).run(deployer, seenAt, seenAt);
    }
    return true;
  } catch (e) {
    warnOnce("recordEvaluation failed: " + e.message);
    return false;
  }
}

// Update a token's final disposition once the runner knows it
// (buy / cap-skip / balance-skip / sold). Never throws.
function updateDecision(chainId, token, decision, extra) {
  try {
    const db = open();
    if (!db || !token || !chainId) return false;
    const x = extra || {};
    const row = db.prepare("SELECT chain_id FROM tokens WHERE chain_id = ? AND token = ?")
      .get(chainId, String(token).toLowerCase());
    if (!row) return false; // not recorded yet (e.g. hard-gate skip) — nothing to update
    db.prepare(`
      UPDATE tokens SET decision = ?,
        buy_tx = COALESCE(?, buy_tx),
        buy_amount_in = COALESCE(?, buy_amount_in)
      WHERE chain_id = ? AND token = ?
    `).run(decision, x.buyTx || null, x.buyAmountIn || null, chainId, String(token).toLowerCase());
    return true;
  } catch (e) {
    warnOnce("updateDecision failed: " + e.message);
    return false;
  }
}

// Resolved outcome counts for one deployer.
// outcome = final_outcome ?? latest non-null checkpoint status.
function outcomeCounts(deployer) {
  const empty = { launched: 0, alive: 0, rugged: 0, abandoned: 0, unknown: 0 };
  try {
    const db = open();
    if (!db || !deployer) return empty;
    const rows = db.prepare(`
      SELECT final_outcome, outcome_24h, outcome_72h, outcome_7d
      FROM tokens WHERE deployer = ?
    `).all(String(deployer).toLowerCase());
    for (const r of rows) {
      empty.launched++;
      let status = r.final_outcome || null;
      if (!status) {
        for (const col of ["outcome_7d", "outcome_72h", "outcome_24h"]) {
          if (r[col]) {
            try { status = JSON.parse(r[col]).status || null; } catch { status = null; }
            if (status) break;
          }
        }
      }
      if (status === "alive") empty.alive++;
      else if (status === "rugged") empty.rugged++;
      else if (status === "abandoned") empty.abandoned++;
      else empty.unknown++;
    }
    return empty;
  } catch (e) {
    warnOnce("outcomeCounts failed: " + e.message);
    return empty;
  }
}

// Reputation adjustment for a deployer. Never throws; unknown -> 0.
function adjustmentForDeployer(deployer) {
  try {
    if (!deployer) return { points: 0, detail: "memory: no deployer known for this pool" };
    if (!open()) return { points: 0, detail: "memory: database unavailable (fail-open) — no adjustment" };
    const c = outcomeCounts(deployer);
    const resolved = c.alive + c.rugged + c.abandoned;
    const base = `memory: deployer ${String(deployer).slice(0, 10)}… — ${c.launched} launch(es) on record (${c.alive} alive, ${c.rugged} rugged, ${c.abandoned} abandoned, ${c.unknown} unresolved)`;
    let points = 0;
    let why = "too little resolved history — no adjustment";
    if (c.rugged >= 3 && c.rugged / Math.max(1, c.rugged + c.alive) >= 0.75) {
      points = -15; why = "serial rugger (≥3 rugged, ≥75% of resolved)";
    } else if (c.rugged >= 2 && c.rugged / Math.max(1, c.rugged + c.alive) >= 0.5) {
      points = -10; why = "repeat rugger (≥2 rugged, ≥50% of resolved)";
    } else if (c.rugged + c.abandoned >= 3 && c.alive === 0) {
      points = -5; why = "everything launched so far died (≥3 rugged/abandoned, 0 alive)";
    } else if (c.alive >= 5 && c.rugged === 0) {
      points = 10; why = "trusted deployer (≥5 alive, 0 rugged)";
    } else if (c.alive >= 3 && c.rugged === 0) {
      points = 5; why = "repeat healthy deployer (≥3 alive, 0 rugged)";
    }
    points = Math.max(-25, Math.min(25, points));
    return { points, detail: base + " — " + why, counts: c, resolved };
  } catch (e) {
    warnOnce("adjustmentForDeployer failed: " + e.message);
    return { points: 0, detail: "memory: lookup failed (fail-open)" };
  }
}

// Tokens due for an outcome check. A token is due for checkpoint X when
// it is older than X and that outcome column is still NULL (or, with
// opts.force, whenever it is older than X — re-check filled columns).
// Never throws.
function tokensDueForCheck(nowMs, opts) {
  try {
    const db = open();
    if (!db) return [];
    const now = nowMs || Date.now();
    const force = !!(opts && opts.force);
    const rows = db.prepare(`
      SELECT chain_id, token, pool_id, pool_address, pool_type, deployer,
             symbol, quote_symbol, quote_address, source,
             first_seen_at, first_price, first_price_quote, peak_price,
             score, decision, buy_tx, final_outcome,
             outcome_24h, outcome_72h, outcome_7d
      FROM tokens WHERE final_outcome IS NULL
    `).all();
    const due = [];
    for (const r of rows) {
      const ageMs = now - Date.parse(r.first_seen_at);
      const checkpoints = [];
      if (ageMs >= 24 * 3600 * 1000 && (force || !r.outcome_24h)) checkpoints.push("24h");
      if (ageMs >= 72 * 3600 * 1000 && (force || !r.outcome_72h)) checkpoints.push("72h");
      if (ageMs >= 7 * 24 * 3600 * 1000 && (force || !r.outcome_7d)) checkpoints.push("7d");
      if (checkpoints.length) due.push({ ...r, checkpoints, ageMs });
    }
    return due;
  } catch (e) {
    warnOnce("tokensDueForCheck failed: " + e.message);
    return [];
  }
}

// Record one checkpoint outcome. At 7d the final_outcome is set.
// outcome = { price, peak, liquidityUsd, trades24h, status, checkedAt,
//             source }. Never throws.
function recordOutcome(chainId, token, checkpoint, outcome) {
  try {
    const db = open();
    if (!db || !token || !chainId) return false;
    const col = checkpoint === "24h" ? "outcome_24h" : checkpoint === "72h" ? "outcome_72h" : "outcome_7d";
    const o = { ...outcome, checkedAt: outcome.checkedAt || nowIso() };
    const row = db.prepare("SELECT peak_price, first_price FROM tokens WHERE chain_id = ? AND token = ?")
      .get(chainId, String(token).toLowerCase());
    if (!row) return false;
    const newPeak = (o.price != null)
      ? Math.max(row.peak_price ?? row.first_price ?? o.price, o.price)
      : (row.peak_price ?? row.first_price ?? null);
    if (checkpoint === "7d") {
      db.prepare(`UPDATE tokens SET ${col} = ?, peak_price = ?, final_outcome = ?, last_checked_at = ? WHERE chain_id = ? AND token = ?`)
        .run(JSON.stringify(o), newPeak, o.status || null, o.checkedAt, chainId, String(token).toLowerCase());
    } else {
      db.prepare(`UPDATE tokens SET ${col} = ?, peak_price = ?, last_checked_at = ? WHERE chain_id = ? AND token = ?`)
        .run(JSON.stringify(o), newPeak, o.checkedAt, chainId, String(token).toLowerCase());
    }
    return true;
  } catch (e) {
    warnOnce("recordOutcome failed: " + e.message);
    return false;
  }
}

// Decision priority — a later, weaker record must never downgrade a
// stronger one. (Caught in backfill: v2 WATCH upserts overwrote the
// v1 'buy' decision of the 5 live positions, because v2 had evaluated
// the same pools and logged WATCH.) buy > would-buy > cap/balance-skip
// > watch > skip. updateDecision() is separate and always wins — the
// runner knows the final disposition.
const DECISION_PRIORITY = { buy: 5, "would-buy": 4, "cap-skip": 3, "balance-skip": 3, watch: 2, skip: 1 };

// Upsert a token row without a scored evaluation (backfill / follow-up
// discovery from STATE.json positions). First insert wins for first_seen /
// first_price. Never throws.
function upsertToken(t) {
  try {
    const db = open();
    if (!db || !t || !t.token || !t.chainId) return false;
    const token = String(t.token).toLowerCase();
    const deployer = t.deployer ? String(t.deployer).toLowerCase() : null;
    let decision = t.decision || null;
    if (decision) {
      const existing = db.prepare("SELECT decision FROM tokens WHERE chain_id = ? AND token = ?")
        .get(t.chainId, token);
      if (existing && existing.decision
        && (DECISION_PRIORITY[existing.decision] || 0) >= (DECISION_PRIORITY[decision] || 0)) {
        decision = null; // keep the stronger existing decision
      }
    }
    db.prepare(`
      INSERT INTO tokens
        (chain_id, token, pool_id, pool_address, pool_type, deployer,
         creator_contract, symbol, quote_symbol, quote_address, source,
         first_seen_at, first_price, first_price_quote, peak_price,
         score, score_breakdown, decision, buy_tx, buy_amount_in)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain_id, token) DO UPDATE SET
        deployer = COALESCE(excluded.deployer, tokens.deployer),
        creator_contract = COALESCE(excluded.creator_contract, tokens.creator_contract),
        pool_id = COALESCE(excluded.pool_id, tokens.pool_id),
        pool_address = COALESCE(excluded.pool_address, tokens.pool_address),
        symbol = COALESCE(excluded.symbol, tokens.symbol),
        decision = COALESCE(excluded.decision, tokens.decision),
        buy_tx = COALESCE(excluded.buy_tx, tokens.buy_tx)
    `).run(
      t.chainId, token, t.poolId || null, t.poolAddress || null,
      t.poolType || null, deployer, t.creatorContract || null,
      t.symbol || null, t.quoteSymbol || null, t.quoteAddress || null,
      t.source || null, t.firstSeenAt || nowIso(),
      t.firstPrice ?? null, t.firstPriceQuote || null,
      t.firstPrice ?? null, t.score ?? null,
      t.scoreBreakdown ? JSON.stringify(t.scoreBreakdown) : null,
      decision, t.buyTx || null, t.buyAmountIn || null,
    );
    if (deployer) {
      db.prepare(`
        INSERT INTO deployers (address, first_seen_at, last_seen_at)
        VALUES (?, ?, ?) ON CONFLICT(address) DO UPDATE SET last_seen_at = excluded.last_seen_at
      `).run(deployer, t.firstSeenAt || nowIso(), t.firstSeenAt || nowIso());
    }
    return true;
  } catch (e) {
    warnOnce("upsertToken failed: " + e.message);
    return false;
  }
}

function stats() {
  try {
    const db = open();
    if (!db) return { disabled: true };
    const one = (sql) => { try { return db.prepare(sql).get()["c"]; } catch { return 0; } };
    return {
      disabled: false,
      dbPath: dbPath(),
      tokens: one("SELECT COUNT(*) c FROM tokens"),
      deployers: one("SELECT COUNT(*) c FROM deployers"),
      evaluations: one("SELECT COUNT(*) c FROM evaluations"),
      withDeployer: one("SELECT COUNT(*) c FROM tokens WHERE deployer IS NOT NULL"),
      withFinalOutcome: one("SELECT COUNT(*) c FROM tokens WHERE final_outcome IS NOT NULL"),
      finalAlive: one("SELECT COUNT(*) c FROM tokens WHERE final_outcome = 'alive'"),
      finalRugged: one("SELECT COUNT(*) c FROM tokens WHERE final_outcome = 'rugged'"),
      finalAbandoned: one("SELECT COUNT(*) c FROM tokens WHERE final_outcome = 'abandoned'"),
      bought: one("SELECT COUNT(*) c FROM tokens WHERE decision = 'buy'"),
    };
  } catch (e) {
    return { disabled: true, error: e.message };
  }
}

module.exports = {
  open, recordEvaluation, updateDecision, outcomeCounts,
  adjustmentForDeployer, tokensDueForCheck, recordOutcome, upsertToken,
  stats, dbPath, _resetForTest,
};

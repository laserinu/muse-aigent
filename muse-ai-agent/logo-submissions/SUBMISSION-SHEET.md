# $MUSE Logo Submission Sheet

Prepared 2026-11-07. Token: **Muse Ai Agent ($MUSE)** — `0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198`, Arc (chain 5042), 9 decimals, 100T fixed supply, OpenZeppelin ERC20 v5.7.0, Sourcify exact_match (creation + runtime). Agent/deployer wallet: `0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4`. Pool: Uniswap V4 MUSE/USDC, fee 3000 (0.3% LP) + 3% hook fee to the agent wallet, PoolId `0x5a14e63c9943a180d24b31f45964bc11e24639e9f055f88f33a3ac58b6b27ff1`, seeded 10B MUSE + 0.5 USDC ($5k FDV), position NFT 322143. Launch tx `0x1040a88a88c9ee2954356ba840f37e6d334d8fc7072bc890aa35322af16bd095` (block 29870713, 2026-11-07).

Current state (verified 2026-11-07): ArcScan shows the generic `empty-token.svg` placeholder — no logo submitted anywhere yet. ERC-20 has no onchain logo field; all of this is off-chain metadata. The token IS already indexed on GeckoTerminal (token + pool, no price/volume/logo yet) and is NOT on CoinGecko main site ("coin not found").

## Gaps that block submission (need the user / parent first)

1. **Public website URL — RESOLVED 2026-11-07.** The $MUSE website is now shared publicly: `https://muse.ai/s/muse-ai-agent-muse-rxc6lpxosyaxkl/BCtat270WbxMhjuhiupV3VcA6-Pmc7WM6Kd-9baM6cI`. Use this URL in all forms. TrustWallet `info.json` `website` field updated to this URL.
2. **Official social accounts — NONE YET.** Muse has no X / Telegram / Discord and the user has not chosen handles. CoinGecko requires a Public Verification Post from an official social account linked on the website; CoinMarketCap requires an X account + a community chat link; TrustWallet `links` is empty until these exist.
3. **Project contact email — RESOLVED 2026-11-07.** Use `linulaserinu@gmail.com` (provided by the user for the logo submissions). Note: this is a Gmail address, not a project-domain email — Etherscan prefers a project-domain email or the primary email shown on the website, so use this Gmail and note it in the form.
4. **GitHub auth — NOT LOGGED IN.** `gh` is installed but `gh auth status` reports "not logged into any GitHub hosts". The TrustWallet PR cannot be opened from this VM without a login. The parent/user must run `gh auth login` or open the PR in the browser.
5. **Ownership verification is non-standard.** The token was deployed by the MuseDeployer factory contract (CREATE2), not directly by the agent wallet EOA. Both Etherscan and Blockscout normally verify ownership by a signed message from the wallet that deployed the contract. A contract cannot sign. Expect to use the manual / contract-created-by-contract / support route on both explorers (the factory's owner is the agent wallet — that is the ownership chain to present).

## Logo URLs (hosted, for the explorer forms)

Uploaded 2026-11-07 to Muse built-in storage. **These links expire 2026-11-08 ~18:17 UTC (48 hours)** — use them for the immediate submission; for a permanent logo URL, host the file on GitHub raw / Drive / IPFS later.

- `logo-64.png` (ArcScan): `https://muse.ai/files/1383666548165573/28653554234318507/0hq0g3qdocs04z7ql0jtm796/logo-64.png`
- `logo-48.png` (Blockscout): `https://muse.ai/files/1383666548165573/3569514513222993/ow231nwm2msocbmru0lo7mlp/logo-48.png`

## Logo files prepared (in this folder)

Source: `~/workspace/erc8004/assets/muse-fluffy-logo.png` (480x480, fluffy beige character with headphones on a laptop, white background). All resized with Lanczos from that source; look identical.

| File | Size | Use |
|---|---|---|
| `logo-256.png` | 256x256, 54,507 bytes | TrustWallet `logo.png` (recommended 256x256, max 512x512, max 100kB — fits); also CoinGecko attachment |
| `logo-200.png` | 200x200, 35,625 bytes | CoinMarketCap (asks for 200x200 PNG; prefers transparent background — source is a photo on white, so this is white-background, not transparent) |
| `logo-64.png` | 64x64, 5,100 bytes | Etherscan/ArcScan (PNG 64x64 option) |
| `logo-48.png` | 48x48, 3,186 bytes | Blockscout (48x48 PNG option) |
| `trustwallet/blockchains/arc/assets/0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198/logo.png` | 256x256 | TrustWallet PR copy |
| `trustwallet/blockchains/arc/assets/0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198/info.json` | — | TrustWallet PR copy (see below) |

Notes: Etherscan also accepts SVG 32x32, but a traced SVG of this photo logo would look poor — use the PNG 64x64 route. Etherscan and Blockscout both want the logo as a **public download URL**, not a file upload, so the chosen logo file must be hosted somewhere public first (GitHub raw, the shared artifact's assets, or IPFS) and the URL pasted into the form. TrustWallet wants the file itself in the PR.

## TrustWallet info.json (prepared)

File: `trustwallet/blockchains/arc/assets/0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198/info.json`

```json
{"decimals":9,"description":"MUSE is the token of Muse, an AI agent that finds and verifies crypto airdrops. It trades on Uniswap v4 on Arc, with a 3% fee on buys and sells going to the agent wallet.","explorer":"https://explorer.arc.io/token/0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198","id":"0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198","links":[],"name":"Muse Ai Agent","status":"active","symbol":"MUSE","type":"ARC","website":""}
```

`website` is empty and `links` is empty — fill them in once gaps 1–2 above are resolved. Schema matches the existing Arc token in the repo (EURC, `blockchains/arc/assets/0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1/info.json`). `type` is `"ARC"` and the folder name is the EIP-55 checksum address (verified with viem `getAddress`).

---

## 1. ArcScan (arc.etherscan.io) — SUBMITTABLE ONCE GAPS 1, 3, 5 ARE RESOLVED

- **Form URL:** `https://arc.etherscan.io/tokenupdate/0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198` (verified: this URL exists and routes to the ArcScan login page — the form is behind an account login).
- **Guidelines:** `https://info.etherscan.com/how-to-update-token-info/`
- **Prerequisites (in order):** (a) an Etherscan/ArcScan account, (b) contract source verified — DONE (Sourcify exact_match; the ArcScan page shows the verified source), (c) verify contract-address ownership (signed message). See gap 5: the token was deployed by the factory contract, so the standard deployer-signature flow may fail; use Etherscan's contract-created-by-contract / support route and present the factory (deployer `0xD5941aedf552ab2B9Ff1bB20C1C4bd7813B561e0`) owned by the agent wallet.
- **Status 2026-11-07 ~01:28 GMT+7 — SUBMITTED, pending ArcScan review.** Signed in as existing account 0xlinu (linulaserinu@gmail.com). Ownership VERIFIED via the Privy CLI: the agent wallet signed the ArcScan message `[arc.etherscan.io 06/11/2026 18:26:14] I, hereby verify that I am the owner/creator of the address [0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198]` (personal_sign, signature 0x361a04a9…22ce11c, verified to recover to 0x0A1D…). ArcScan accepted it: "Congratulations, the address ownership for [0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198] is verified." Token update form then SUBMITTED (New / First Time Token Update; requester 0xlinu, email linulaserinu@gmail.com, website, description, logo PNG 64x64 link). Confirmation: "Thank you for your submission. You will receive an email containing further instructions shortly. Please do not submit duplicate submissions…" No ticket/reference number shown. ArcScan review pending; an email with further instructions is expected at linulaserinu@gmail.com. The earlier "General Inquiry" support ticket is now redundant (no further action). Key learning: the Privy CLI personal_sign works for Etherscan ownership verification (params = {"message": ...} only — no "address" key; the CLI rejects an "address" key). The message timestamp is generated on page load, so sign the CURRENT message and do not reload the page before pasting the signature.
- **Request type:** `New/First Time Token Update`.
- **Fields / values:**
  - Token Contract Address: `0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198`
  - Requester Name: [user's name — NOT KNOWN, leave for the user]
  - Requester / project email: `linulaserinu@gmail.com` (provided by the user 2026-11-07; Gmail, not a project-domain email)
  - Official website: `https://muse.ai/s/muse-ai-agent-muse-rxc6lpxosyaxkl/BCtat270WbxMhjuhiupV3VcA6-Pmc7WM6Kd-9baM6cI` (public, shared 2026-11-07)
  - Description: neutral, ~300 chars. Suggested: "MUSE is the token of Muse, an AI agent that finds and verifies crypto airdrops. It trades on Uniswap v4 on Arc, with a 3% fee on buys and sells going to the agent wallet."
  - Logo: PNG 64x64 (`logo-64.png`) or SVG 32x32, supplied as a **public download link** (not private). Hosted URL (48h, expires 2026-11-08 ~18:17 UTC): `https://muse.ai/files/1383666548165573/28653554234318507/0hq0g3qdocs04z7ql0jtm796/logo-64.png`
  - Socials / links: [gap 2 — none yet]
- **Cost:** free. Optional premium plan for 24-hour turnaround (price shown after submission).
- **Turnaround:** free route is uncommitted (days); submissions are final once sent.
- **What it needs from the user:** an ArcScan account login, the ownership-verification signature (or the manual route — gap 5), a public website URL, a project email, and a public logo URL.

## 2. Blockscout (explorer.arc.io) — SUBMITTABLE ONCE GAPS 1, 5 ARE RESOLVED (logo via URL)

- **Token page:** `https://explorer.arc.io/token/0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198`
- **Route:** open the token page → three-dot menu → **Add Token Info** (or My Account → Verified addresses → Add details). Docs: `https://docs.blockscout.com/using-blockscout/overviews/token-info`
- **Prerequisites:** (a) a Blockscout account, (b) contract source verified — Blockscout picks up Sourcify verification automatically (could not confirm from this VM: explorer.arc.io is Cloudflare-gated here, the API call returned no JSON; verify in the browser), (c) verify ownership of the token contract (sign a message from the wallet that deployed it). See gap 5: the deployer is the factory contract, so the standard route may fail; Blockscout's docs allow manual evidence when the deployment relationship cannot be confirmed through the interface.
- **Fields / values:**
  - Token name / contract address: read-only in the form (name "Muse Ai Agent", address `0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198`).
  - Icon URL: a **direct URL** to a downloadable SVG or a direct 48x48 PNG (`logo-48.png` hosted publicly). Not a file upload, not a share page, not a signed/temporary URL.
  - Website, description, social links: same values as ArcScan above; website [gap 1], socials [gap 2].
- **Cost:** free. Moderator review takes several days (no guaranteed SLA).
- **Note:** Blockscout also pulls token info automatically from CoinGecko and CoinMarketCap. If $MUSE is later listed on CoinGecko, Blockscout will reflect it automatically — the manual submission is the faster route for the logo specifically.
- **What it needs from the user:** a Blockscout account + email, the ownership-verification signature (or manual-evidence route — gap 5), and a public 48x48 logo URL.
- **Status 2026-11-07 ~01:49 GMT+7 — SUBMITTED, status "In progress", pending Blockscout manual review.** Signed in as linulaserinu@gmail.com (email code entered via the login service). Ownership VERIFIED via the Privy CLI: the agent wallet signed the Blockscout message `[explorer.arc.io] [2026-11-06 18:32:24] I, hereby verify that I am the owner/creator of the address [0xd1242aeca57cb80f9067800f2f43d78cc3f8d198]` (personal_sign, signature 0xc7cd6fcf…ad4311c, verified to recover to 0x0A1D…). Note the Blockscout message uses the LOWERCASE address, unlike ArcScan's checksum address — sign the exact message shown. Blockscout confirmed "Congrats! Address is verified." Token info form SUBMITTED (requester 0xlinu / linulaserinu@gmail.com, project "Muse Ai Agent", industry DeFi — no "AI" option was listed, official email linulaserinu@gmail.com, website, description, socials blank, $99 expedited section blank, no payment). **Icon URL change:** the muse.ai logo URL could not load in the browser (muse.ai is blocked by the browser's organization policy), so the logo was uploaded to Postimages and the direct URL https://i.postimg.cc/hPMD9djp/logo-48.png was submitted (it loaded in Blockscout's preview; Postimages page https://postimg.cc/KRkhb4tM). An Imgur upload also happened (album https://imgur.com/a/9z8GfqO) but its direct URL could not be retrieved from Imgur's UI. Confirmation: "My verified addresses" lists the request — Address 0xd1242aeca…, Token info "Muse Ai Agent" with the logo loading, Request status "In progress", Date Nov 07, 2026. The logo/website/description are NOT yet live on the token page — they appear only once Blockscout approves. No confirmation number shown.

## 3. TrustWallet assets (github.com/trustwallet/assets) — NOT SUBMITTABLE YET (holder count + GitHub auth)

- **Repo:** `https://github.com/trustwallet/assets` — PR process. The "arc" chain folder already exists in the repo (verified via the GitHub API: `blockchains/arc/` is present, 189 chains total).
- **Target paths in the PR:**
  - `blockchains/arc/assets/0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198/logo.png` (prepared, 256x256, 54,507 bytes — under the 100kB limit)
  - `blockchains/arc/assets/0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198/info.json` (prepared; `website` and `links` empty pending gaps 1–2)
- **Requirements:** `logo.png` (lowercase name, PNG, recommended 256x256, max 512x512, 1:1, max 100kB; displayed cropped to a circular mask — the character is centred and fills the frame, so the crop is safe) + `info.json` (schema matches the EURC Arc example above). Folder name must be the EIP-55 checksum address (verified).
- **BLOCKER — holder count:** TrustWallet states brand-new tokens are not accepted and requires **>2,500 holders** (one checklist says >5,000). $MUSE currently has **2 holders** (ArcScan). The PR would be rejected now. This is the main reason to wait: submit only after the holder count grows well past 2,500. (The repo also mentions a "merge fee" step in its contribution guidelines — the amount is not stated in the docs I read; confirm it in the repo at PR time.)
- **BLOCKER — GitHub auth:** `gh` is installed but not logged in (`gh auth status`: not logged into any GitHub hosts). A GitHub account is needed to fork the repo and open the PR (or use the assets.trustwallet.com web app, which also needs a GitHub account).
- **What it needs from the user:** >2,500 holders (growth first), a GitHub login, and the website/socials for `info.json` (gaps 1–2).

## 4. CoinGecko — NOT SUBMITTABLE YET (needs a tracked market, website, socials)

- **Form:** CoinGecko account → homepage footer **Request Form** → Request & Listing → **New Coin/Token Listing** → Active Listing. (No stable direct URL verified — the old `/en/request-form` URL returns 404; the form now lives in the Partners Platform.) Guide: `https://support.coingecko.com/articles/9489827481-how-to-list-a-new-cryptocurrency-on-coingecko`
- **Hard requirement:** the token must be actively tradable on an exchange CoinGecko already tracks. $MUSE trades on Uniswap V4 on Arc. Uniswap V4 is a tracked DEX, but CoinGecko's evaluation also weighs liquidity, team presence, and project maturity — and it flags unlocked liquidity as rug-pull risk. The position NFT is owned by the agent wallet (not locked), which is a likely objection; consider locking it before applying. There is no published minimum volume/holder threshold.
- **Already true:** the token IS on GeckoTerminal (verified via the GeckoTerminal API: token `arc_0xd1242aeca57cb80f9067800f2f43d78cc3f8d198`, pool `MUSE / USDC 0.3%`, PoolId `0x5a14e63c…b27ff1`), but with `image_url: null`, no price and no volume yet (no swaps have happened). The GeckoTerminal link is useful evidence for the form.
- **Fields / values:** name "Muse Ai Agent", ticker MUSE, chain Arc (5042), contract `0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198`, decimals 9, total supply 100T, max supply 100T, circulating supply (10B in the pool + 0 locked in the deployer is NOT circulating — state it carefully: 10B seeded in the pool, ~99.99T locked in the deployer), website [gap 1], block explorer link, GeckoTerminal link, logo upload (`logo-256.png`), trading-pair/market links.
- **Verification:** publish a **Public Verification Post** from an official social account linked on the website, stating the CoinGecko listing request is being submitted, then paste its URL into the form and later reply to it with the Request ID CoinGecko emails (IDs start with `CL`). This needs gap 2 (official socials) resolved first.
- **Cost:** free (Regular Pass, review up to 5 days). Optional Fast Pass $1,000 per request (review within 24h, non-refundable, does NOT guarantee approval).
- **What it needs from the user:** a CoinGecko account, a public website URL, official social accounts + a verification post, real trading activity on the pool first, and ideally locked liquidity.

## 5. CoinMarketCap — NOT ELIGIBLE YET (needs material volume)

- **Form:** `https://coinmarketcap.com/request/` → redirects to the support portal `https://support.coinmarketcap.com/hc/en-us/requests/new`. Choose form **1 — "[New Listing] Add cryptoasset"**. No CoinMarketCap account needed, just an email. (Do not email or DM them — the form is the only route.)
- **Eligibility (their four rules):** (1) uses crypto/blockchain tech — yes; (2) functional website + block explorer — website [gap 1], explorer yes (ArcScan + Blockscout); (3) trades on at least one exchange CMC tracks **"with material volume"** — NOT MET: the pool is $0.50 deep with ~$0 volume. Guidance cited by third parties is ~$50,000/day honest volume and $400k–$500k DEX liquidity for tracked status (CMC publishes no minimum, but the gap is orders of magnitude); (4) a project representative available to answer questions.
- **Fields / values:** name, ticker MUSE, category tags, one-line tagline, a 450–600 word factual third-person description, chain Arc, contract `0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198`, decimals 9, logo **200x200 PNG** (`logo-200.png`; CMC prefers a transparent background — the source is a photo on white, so this file is white-background, flag it), website [gap 1], X account [gap 2], community chat link (Telegram) [gap 2], circulating + max supply, trading-pair links and screenshots, role/launch date/country/team/traction. New coins should also prepare supplementary Annex M and Annex C material.
- **Post-submit:** post from an official account linked on the website, quoting the CMC ticket number and the DexScan link; do not tag CoinMarketCap.
- **Cost:** free (no committed clock — "can run to months"). Optional CMC Priority $5,000 per coin listing (estimated answer ~24 business hours after payment clears; does not guarantee approval).
- **What it needs from the user:** material trading volume and liquidity first (the big gap), a public website, an X account + community chat, and the 450–600 word description.

---

## Recommended order

1. **Now (no blockers except gaps 1, 3, 5):** ArcScan + Blockscout — these are the two that make the logo show on the explorers, and they need no trading volume or holder count. Resolve the public website URL, the project email, and the ownership-verification route first.
2. **After the holder count grows (>2,500) and GitHub auth is set up:** TrustWallet assets PR.
3. **After real trading activity + locked liquidity + socials exist:** CoinGecko (free Regular Pass).
4. **Last, after material volume (~$50k/day) and liquidity:** CoinMarketCap.

## Files in this folder

- `logo-256.png`, `logo-200.png`, `logo-64.png`, `logo-48.png` — resized logos (see table above).
- `trustwallet/blockchains/arc/assets/0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198/logo.png` — TrustWallet PR copy.
- `trustwallet/blockchains/arc/assets/0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198/info.json` — TrustWallet PR copy (website + links empty pending gaps 1–2).
- `SUBMISSION-SHEET.md` — this file.

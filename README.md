# Robomoustachio (Remy) - Agent Reputation Oracle

Robomoustachio is a production ERC-8004 reputation oracle on Base mainnet.
It scores autonomous agents from feedback history and exposes trust data through:

1. An on-chain `TrustScore` contract.
2. An HTTPS API (`/score`, `/report`, `/discover`, `/health`) for agent-to-agent and app-to-agent access.

## Live Status (As Of February 14, 2026)

| Item | Value |
|---|---|
| Production API | `https://robomoustach.io` |
| Discover document | `https://robomoustach.io/discover` |
| Network | Base mainnet (`chainId=8453`) |
| TrustScore contract | `0xa770C9232811bc551C19Dc41B36c7FFccE856e84` |
| Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Reputation Registry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Updater wallet | `0x05EEBF02305BF34C446C298105174e099C716bb9` |
| Query fee (contract) | `100000000000000` wei |
| Mainnet registration URI | `https://robomoustach.io/discover` |
| Mainnet registration agent ID | `17201` |

Verification links:
- TrustScore verified source: `https://basescan.org/address/0xa770C9232811bc551C19Dc41B36c7FFccE856e84#code`
- Service registration URI update tx: `https://basescan.org/tx/0x3ec2ab605fccb202a2bcbad3489ecb73e526add02885cb937d4b47c6f0eef4ff`

Brand assets:
- Mascot image: `assets/mascot/robomoustachio-mascot.png`

## Architecture

```mermaid
flowchart TD
    A["Client App / Human Operator"] -->|HTTPS| B["robomoustach.io API"]
    C["AI Agent\nAgentKit / ACP"] -->|discover + score/report| B
    C -->|optional direct read| D["TrustScore.sol\nBase Mainnet"]

    B -->|read score/report| D
    B -->|serves metadata| E["/discover"]

    F["Indexer cron\n15 min"] -->|read FeedbackPosted events| G["ERC-8004 Reputation Registry"]
    F -->|scoreFeedback logic| H["scoring.js"]
    H -->|batchUpdateScores (max 100)| D
```

## Quickstart For People (Use The Live Service)

No deploy required. You can call the production API directly.

### 1) Health and discovery

```bash
curl "https://robomoustach.io/health"
curl "https://robomoustach.io/discover"
```

### 2) Query score and report

```bash
curl "https://robomoustach.io/score/2"
curl "https://robomoustach.io/report/2"
```

Example (`/score/2`):

```json
{
  "agentId": "2",
  "score": 950,
  "confidence": 1,
  "lastUpdated": 1771085895
}
```

Example (`/report/2`):

```json
{
  "agentId": "2",
  "score": 950,
  "confidence": 1,
  "totalFeedback": 100,
  "positiveFeedback": 98,
  "recentTrend": "stale",
  "flagged": false,
  "riskFactors": [],
  "negativeRateBps": 200,
  "lastUpdated": 1771085895
}
```

## Quickstart For AI Agents

### Discovery-first integration flow

1. `GET /discover` to fetch capabilities and pricing metadata.
2. Query `GET /score/:agentId` before executing sensitive actions.
3. If needed, query `GET /report/:agentId` for deeper risk factors.
4. Apply local policy gates before proceeding.

Minimal policy example:

```js
const base = "https://robomoustach.io";
const id = "3";

const score = await fetch(`${base}/score/${id}`).then((r) => r.json());
const report = await fetch(`${base}/report/${id}`).then((r) => r.json());

if (score.score <= 500 || report.flagged) {
  throw new Error(`Abort: risky agent ${id}`);
}
```

### AgentKit test bot in this repo

The repo includes a minimal AgentKit bot under `test-agent/`.

```bash
cd test-agent
npm install
cp .env.example .env
```

Set required values in `test-agent/.env`:
- `CDP_API_KEY_ID`
- `CDP_API_KEY_SECRET`
- `CDP_WALLET_SECRET`
- `AGENTKIT_NETWORK_ID=base-mainnet`
- `TRUST_ORACLE_BASE_URL=https://robomoustach.io`
- `TRUST_AGENT_IDS=2,3,5,6`

Run:

```bash
npm start
```

Output format:

```text
Checking Agent 2... Score: 950, Confidence: high -> TRUSTED, proceeding
Checking Agent 3... Score: 400, Confidence: low -> RISKY, aborting
Checking Agent 5... Score: 100, Confidence: low -> DANGEROUS, blacklisted
Checking Agent 6... Score: 0, Confidence: none -> UNKNOWN, requesting verification
```

## Run Your Own Instance (Operator Setup)

### 1) Install

```bash
npm install
cp .env.example .env
```

### 2) Configure core env

Required for production-like operation:
- `BASE_MAINNET_RPC_URL`
- `TRUST_SCORE_ADDRESS`
- `IDENTITY_REGISTRY_ADDRESS`
- `REPUTATION_REGISTRY_ADDRESS`
- `UPDATER_PRIVATE_KEY` (for indexer writes)
- `PUBLIC_BASE_URL` and `AGENT_REGISTRATION_URI`

### 3) Start API and indexer

```bash
npm run start:api
npm run indexer
```

### 4) Smoke test API locally

```bash
npm run test:client
```

## On-Chain Seeding Utilities

Seed one score (older script):

```bash
npm run seed:score:base-sepolia
```

Seed test cohort on Base mainnet (`agentId` 2-6):

```bash
npm run seed:test-agents:base-mainnet
```

## API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | `GET` | Service status, payment mode, contract wiring |
| `/discover` | `GET` | ERC-8004 registration/capability document |
| `/score/:agentId` | `GET` | Trust score + confidence |
| `/report/:agentId` | `GET` | Full risk report |

## Current Payment Mode

Production is configured for real x402 middleware on Base mainnet.

Quick check:

```bash
curl "https://robomoustach.io/health"
curl -i -H "Accept: application/json" "https://robomoustach.io/score/1"
```

Expected:
- `/health` includes `payment.mode: "real"` and `payment.usingRealMiddleware: true`
- `/score/:agentId` returns `402` without `X-PAYMENT`, with `accepts` payment requirements

## Real Paid x402 Test

Use the included script to execute one real paid request end-to-end.

1. Add to `.env`:
   - `X402_TEST_PRIVATE_KEY` (funded Base wallet with ETH + USDC)
   - optional `X402_TEST_URL` (default `https://robomoustach.io/score/1`)
   - optional `X402_TEST_RPC_URL` (defaults to `BASE_MAINNET_RPC_URL`)
   - optional `X402_MAX_PAYMENT_ATOMIC` (default `20000`, i.e. `0.02 USDC`)
2. Run:

```bash
npm run test:x402-paid
```

The script will:
- preflight unauthenticated request (expects `402`)
- pay via x402 and retry automatically
- require `X-PAYMENT-RESPONSE` on success
- print decoded settlement metadata and response body

## Security Notes

- Never commit `.env` files with private keys or API secrets.
- Use separate keys for production services vs test agents.
- Rotate any credential that has ever appeared in screenshots, logs, or chat.
- Keep updater wallet minimally funded and separate from owner/deployer wallet.

## Test And Build Commands

```bash
npm run build
npm test

npm run test:contract
npm run test:scoring
npm run test:integration
```

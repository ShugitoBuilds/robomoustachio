# AgentKit Integration TASKS

## Scope

Integrate Robomoustachio with Coinbase AgentKit in a production-first layout (`src/agentkit/`) and ship a stable developer path for:

1. Direct HTTP demo reads (`?demo=true`)
2. x402 paid reads (headless signer/private key)
3. Direct on-chain fallback reads from `TrustScore`

## Locked Decisions (Do Not Re-Interpret)

- [x] Place all new integration code under `src/agentkit/` (not `test-agent/`).
- [x] Keep integration as a module loaded by the existing API runtime.
- [x] Do not add a new PM2 worker unless we intentionally add proactive/scheduled behavior later.
- [x] Use curated fixture agent IDs for demo stability; do not depend on random live registry quality for demo success.
- [x] Graceful degradation is required: every failure path must return structured output, not throw.

## Canonical Response Contract (AgentKit-Facing)

- [x] Define shared output schema in `src/agentkit/types.js` (or plain JS schema constants):
  - [x] `status`: `ok | degraded | error`
  - [x] `agentId`
  - [x] `score` (number or `null`)
  - [x] `confidence` (number or `null`)
  - [x] `verdict` (`TRUSTED | CAUTION | DANGEROUS | UNKNOWN`)
  - [x] `recommendation` (`proceed | manual_review | abort`)
  - [x] `source` (`api_demo | api_paid | trustscore_contract`)
  - [x] `fallback` (nullable code)
  - [x] `error` (nullable object)
  - [x] `timingMs`

## Fallback Semantics (Critical Clarification)

- [x] **On-chain fallback means reading `TrustScore` contract only**, not recomputing from raw ERC-8004 feedback events.
- [x] Do not parse raw registry feedback for fallback scoring.
- [x] For `/score` fallback:
  - [x] call `TrustScore.getScore(agentId)` (or equivalent direct score read via `getDetailedReport`)
- [x] For `/report` fallback:
  - [x] call `TrustScore.getDetailedReport(agentId)`
  - [x] derive minimal analytics client-side if needed, with explicit `source: trustscore_contract`
- [x] If API and contract are both unavailable, return:
  - [x] `{ score: null, fallback: "oracle_unavailable", recommendation: "manual_review" }`

## Phase 1: Project Scaffolding

- [x] Create `src/agentkit/` with:
  - [x] `src/agentkit/config.js`
  - [x] `src/agentkit/client.js`
  - [x] `src/agentkit/actions.js`
  - [x] `src/agentkit/fallbacks.js`
  - [x] `src/agentkit/fixtures/agents.json`
  - [x] `src/agentkit/demo-runner.js`
- [x] Add root scripts in `package.json`:
  - [x] `agentkit:demo`
  - [x] `agentkit:test`
- [x] Add env docs for AgentKit-specific vars in `.env.example`.

## Phase 2: Core AgentKit Client

- [x] Implement `queryTrustScore(agentId, options)` in `src/agentkit/client.js`.
- [x] Implement `queryTrustReport(agentId, options)` in `src/agentkit/client.js`.
- [x] Implement `evaluateAgentRisk(agentId, options)` in `src/agentkit/actions.js`.
- [x] Add input guards (uint256 validation) before making network calls.
- [x] Normalize all successful and degraded responses to the canonical schema.

## Phase 3: Query Modes

- [x] Mode A (`api_demo`): `GET /score/:agentId?demo=true` and `GET /report/:agentId?demo=true`.
- [x] Mode B (`api_paid`): x402 fetch flow using private key signer and Base RPC.
- [x] Mode C (`trustscore_contract`): direct read from contract address `0xa770C9232811bc551C19Dc41B36c7FFccE856e84`.
- [x] Mode selection order:
  - [x] default: `api_paid`
  - [x] fallback 1: `api_demo` (if explicitly enabled)
  - [x] fallback 2: `trustscore_contract`
  - [x] final fallback: `oracle_unavailable`

## Phase 4: Failure-First Behavior

- [x] Implement fallback mapper in `src/agentkit/fallbacks.js` with explicit codes:
  - [x] `oracle_unavailable`
  - [x] `api_timeout`
  - [x] `payment_unavailable`
  - [x] `rpc_unavailable`
  - [x] `agent_not_found`
  - [x] `invalid_agent_id`
- [x] Ensure every caught failure returns structured output and never uncaught throws from public actions.
- [x] Add correlation ID + timestamp to all degraded/error responses.

## Phase 5: Fixtures and Reproducible Demo

- [x] Populate `src/agentkit/fixtures/agents.json` with 3-5 curated real agent IDs and expected score bands.
- [x] Implement `src/agentkit/demo-runner.js` to iterate fixtures and print concise trust decisions.
- [x] Ensure demo is deterministic and independent from random registry discovery.
- [x] Keep optional live registry scan as separate script (non-blocking for core demo).

## Phase 6: Tests

- [x] Unit tests:
  - [x] decision thresholds and verdict mapping
  - [x] response normalization
  - [x] fallback code mapping
- [x] Integration tests:
  - [x] demo path success
  - [x] paid x402 path success
  - [x] trustscore direct read success
  - [x] API 5xx -> graceful degradation
  - [x] timeout -> graceful degradation
  - [x] malformed agent ID -> structured validation error
- [x] Add test command to CI/local scripts (`agentkit:test`).

## Phase 7: Docs-First Delivery

- [x] Create `docs/agentkit-integration.md` before final rollout.
- [x] Include copy/paste examples for:
  - [x] direct HTTP demo query
  - [x] x402 paid query with private key
  - [x] direct on-chain read fallback
- [x] Document full response schema, fallback codes, and recommended retry policy.
- [x] Update root `README.md` with AgentKit integration section linking to docs.

## Phase 8: Rollout and 48h Validation

- [ ] Deploy integration in passive/read mode first.
- [ ] Run 48h observation with curated fixtures + small live sample.
- [ ] Pass criteria (must be defined now, not after):
  - [ ] `>= 99.0%` requests return a structured response (`ok`, `degraded`, or `error`)
  - [ ] `p95 latency < 2000ms` for `queryTrustScore`
  - [ ] `p95 latency < 2500ms` for `queryTrustReport`
  - [ ] `0` unhandled throws in logs
  - [ ] fallback responses include valid `fallback` code `100%` of the time
- [ ] If any criterion fails, do not promote as recommended path; open remediation tasks.

## Optional Phase 9: Proactive Worker (Only If Needed)

- [ ] Decide if we need scheduled proactive scanning/alerts.
- [ ] Only then introduce separate PM2 worker process for AgentKit automation.

## Definition Of Done

- [x] `src/agentkit/` exists and is production-ready.
- [x] AgentKit actions return deterministic schema across success/failure.
- [x] On-chain fallback behavior is scoped to `TrustScore` contract reads (no raw registry recomputation).
- [x] Docs are published and accurate before external PR/pitch.
- [ ] 48h validation meets all reliability thresholds.

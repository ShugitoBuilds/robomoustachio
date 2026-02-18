# AgentKit Integration TASKS

## Scope

Integrate Robomoustachio with Coinbase AgentKit in a production-first layout (`src/agentkit/`) and ship a stable developer path for:

1. Direct HTTP demo reads (`?demo=true`)
2. x402 paid reads (headless signer/private key)
3. Direct on-chain fallback reads from `TrustScore`

## Locked Decisions (Do Not Re-Interpret)

- [ ] Place all new integration code under `src/agentkit/` (not `test-agent/`).
- [ ] Keep integration as a module loaded by the existing API runtime.
- [ ] Do not add a new PM2 worker unless we intentionally add proactive/scheduled behavior later.
- [ ] Use curated fixture agent IDs for demo stability; do not depend on random live registry quality for demo success.
- [ ] Graceful degradation is required: every failure path must return structured output, not throw.

## Canonical Response Contract (AgentKit-Facing)

- [ ] Define shared output schema in `src/agentkit/types.js` (or plain JS schema constants):
  - [ ] `status`: `ok | degraded | error`
  - [ ] `agentId`
  - [ ] `score` (number or `null`)
  - [ ] `confidence` (number or `null`)
  - [ ] `verdict` (`TRUSTED | CAUTION | DANGEROUS | UNKNOWN`)
  - [ ] `recommendation` (`proceed | manual_review | abort`)
  - [ ] `source` (`api_demo | api_paid | trustscore_contract`)
  - [ ] `fallback` (nullable code)
  - [ ] `error` (nullable object)
  - [ ] `timingMs`

## Fallback Semantics (Critical Clarification)

- [ ] **On-chain fallback means reading `TrustScore` contract only**, not recomputing from raw ERC-8004 feedback events.
- [ ] Do not parse raw registry feedback for fallback scoring.
- [ ] For `/score` fallback:
  - [ ] call `TrustScore.getScore(agentId)`
- [ ] For `/report` fallback:
  - [ ] call `TrustScore.getDetailedReport(agentId)`
  - [ ] derive minimal analytics client-side if needed, with explicit `source: trustscore_contract`
- [ ] If API and contract are both unavailable, return:
  - [ ] `{ score: null, fallback: "oracle_unavailable", recommendation: "manual_review" }`

## Phase 1: Project Scaffolding

- [ ] Create `src/agentkit/` with:
  - [ ] `src/agentkit/config.js`
  - [ ] `src/agentkit/client.js`
  - [ ] `src/agentkit/actions.js`
  - [ ] `src/agentkit/fallbacks.js`
  - [ ] `src/agentkit/fixtures/agents.json`
  - [ ] `src/agentkit/demo-runner.js`
- [ ] Add root scripts in `package.json`:
  - [ ] `agentkit:demo`
  - [ ] `agentkit:test`
- [ ] Add env docs for AgentKit-specific vars in `.env.example`.

## Phase 2: Core AgentKit Client

- [ ] Implement `queryTrustScore(agentId, options)` in `src/agentkit/client.js`.
- [ ] Implement `queryTrustReport(agentId, options)` in `src/agentkit/client.js`.
- [ ] Implement `evaluateAgentRisk(agentId, options)` in `src/agentkit/actions.js`.
- [ ] Add input guards (uint256 validation) before making network calls.
- [ ] Normalize all successful and degraded responses to the canonical schema.

## Phase 3: Query Modes

- [ ] Mode A (`api_demo`): `GET /score/:agentId?demo=true` and `GET /report/:agentId?demo=true`.
- [ ] Mode B (`api_paid`): x402 fetch flow using private key signer and Base RPC.
- [ ] Mode C (`trustscore_contract`): direct read from contract address `0xa770C9232811bc551C19Dc41B36c7FFccE856e84`.
- [ ] Mode selection order:
  - [ ] default: `api_paid`
  - [ ] fallback 1: `api_demo` (if explicitly enabled)
  - [ ] fallback 2: `trustscore_contract`
  - [ ] final fallback: `oracle_unavailable`

## Phase 4: Failure-First Behavior

- [ ] Implement fallback mapper in `src/agentkit/fallbacks.js` with explicit codes:
  - [ ] `oracle_unavailable`
  - [ ] `api_timeout`
  - [ ] `payment_unavailable`
  - [ ] `rpc_unavailable`
  - [ ] `agent_not_found`
  - [ ] `invalid_agent_id`
- [ ] Ensure every caught failure returns structured output and never uncaught throws from public actions.
- [ ] Add correlation ID + timestamp to all degraded/error responses.

## Phase 5: Fixtures and Reproducible Demo

- [ ] Populate `src/agentkit/fixtures/agents.json` with 3-5 curated real agent IDs and expected score bands.
- [ ] Implement `src/agentkit/demo-runner.js` to iterate fixtures and print concise trust decisions.
- [ ] Ensure demo is deterministic and independent from random registry discovery.
- [ ] Keep optional live registry scan as separate script (non-blocking for core demo).

## Phase 6: Tests

- [ ] Unit tests:
  - [ ] decision thresholds and verdict mapping
  - [ ] response normalization
  - [ ] fallback code mapping
- [ ] Integration tests:
  - [ ] demo path success
  - [ ] paid x402 path success
  - [ ] trustscore direct read success
  - [ ] API 5xx -> graceful degradation
  - [ ] timeout -> graceful degradation
  - [ ] malformed agent ID -> structured validation error
- [ ] Add test command to CI/local scripts (`agentkit:test`).

## Phase 7: Docs-First Delivery

- [ ] Create `docs/agentkit-integration.md` before final rollout.
- [ ] Include copy/paste examples for:
  - [ ] direct HTTP demo query
  - [ ] x402 paid query with private key
  - [ ] direct on-chain read fallback
- [ ] Document full response schema, fallback codes, and recommended retry policy.
- [ ] Update root `README.md` with AgentKit integration section linking to docs.

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

- [ ] `src/agentkit/` exists and is production-ready.
- [ ] AgentKit actions return deterministic schema across success/failure.
- [ ] On-chain fallback behavior is scoped to `TrustScore` contract reads (no raw registry recomputation).
- [ ] Docs are published and accurate before external PR/pitch.
- [ ] 48h validation meets all reliability thresholds.

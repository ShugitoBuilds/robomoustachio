# Test Agent (AgentKit)

Minimal AgentKit bot that:
- Initializes its own wallet on Base mainnet via AgentKit.
- Calls live oracle endpoints (`/score` and `/report`) for one or more agent IDs.
- Prints normalized decision lines, for example:
  - `Checking Agent 2... Score: 950, Confidence: high -> TRUSTED, proceeding`
  - `Checking Agent 3... Score: 400, Confidence: low -> RISKY, aborting`
  - `Checking Agent 5... Score: 100, Confidence: low -> DANGEROUS, blacklisted`
  - `Checking Agent 6... Score: 0, Confidence: none -> UNKNOWN, requesting verification`
- Logs full request/response traces with timestamps.

## Setup

1. From this folder, install dependencies:
   ```bash
   npm install
   ```
2. Create `.env` from `.env.example` and fill:
   - `CDP_API_KEY_ID`
   - `CDP_API_KEY_SECRET`
   - `CDP_WALLET_SECRET` (recommended for AgentKit v2 wallet provider)
   - `TRUST_ORACLE_BASE_URL=https://robomoustach.io`
   - `TRUST_AGENT_IDS=2,3,5,6`
   - `OUTPUT_MODE=demo` (clean, recording-friendly output)
   - Optional: `AGENTKIT_ALLOW_LEGACY_FALLBACK=true`
3. Run:
   ```bash
   npm start
   ```

The script stores/reuses wallet metadata in `wallet-state.json`.

## Output Modes

- `OUTPUT_MODE=demo`:
  - concise human-readable output
  - color-coded trust decisions
  - no large JSON dump at the end
  - optional compact HTTP lines (`OUTPUT_SHOW_HTTP=true`)
- `OUTPUT_MODE=debug`:
  - full HTTP/body trace logs
  - prints full JSON summary

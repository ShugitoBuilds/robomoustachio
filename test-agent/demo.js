"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const dotenv = require("dotenv");
const chalk = require("chalk");

const originalConsoleWarn = console.warn;
console.warn = (...args) => {
  const first = String(args[0] || "");
  if (first.includes("bigint: Failed to load bindings, pure JS will be used")) {
    return;
  }
  originalConsoleWarn(...args);
};

const { CdpEvmWalletProvider, LegacyCdpWalletProvider } = require("@coinbase/agentkit");

console.warn = originalConsoleWarn;

const THIS_DIR = __dirname;
const ROOT_ENV_PATH = path.resolve(THIS_DIR, "..", ".env");
const LOCAL_ENV_PATH = path.join(THIS_DIR, ".env");
const WALLET_STATE_PATH = path.join(THIS_DIR, "wallet-state.json");

dotenv.config({ path: ROOT_ENV_PATH });
dotenv.config({ path: LOCAL_ENV_PATH, override: true });

const THINK_DELAY_MS = Number(process.env.DEMO_DELAY_MS || 1500);
const MAX_SCORE = 1000;
const BAR_WIDTH = 24;

function timestamp() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripTrailingSlash(url) {
  return `${url || ""}`.replace(/\/+$/, "");
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function visibleLength(value) {
  return stripAnsi(value).length;
}

function padAnsi(value, width) {
  const raw = String(value || "");
  const diff = width - visibleLength(raw);
  return diff > 0 ? raw + " ".repeat(diff) : raw;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isUuidV4(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim()
  );
}

function confidenceLabel(confidence) {
  if (confidence === null || confidence <= 0) {
    return "none";
  }
  if (confidence >= 0.8) {
    return "high";
  }
  if (confidence >= 0.5) {
    return "medium";
  }
  return "low";
}

function confidencePaint(label) {
  if (label === "high") return chalk.green(label.toUpperCase());
  if (label === "medium") return chalk.yellow(label.toUpperCase());
  if (label === "low") return chalk.yellow(label.toUpperCase());
  return chalk.gray(label.toUpperCase());
}

function parseAgentIds(env = process.env) {
  const rawList = env.TRUST_AGENT_IDS || env.TRUST_AGENT_ID || "1";
  const seen = new Set();
  const ids = [];

  for (const part of String(rawList).split(",")) {
    const candidate = part.trim();
    if (!/^\d+$/.test(candidate)) {
      continue;
    }
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    ids.push(candidate);
  }

  return ids.length > 0 ? ids : ["1"];
}

async function loadWalletState() {
  try {
    const content = await fs.readFile(WALLET_STATE_PATH, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function saveWalletState(data) {
  await fs.writeFile(WALLET_STATE_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function resolveCdpConfig() {
  const apiKeyId = process.env.CDP_API_KEY_ID || process.env.CDP_API_KEY_NAME;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET || process.env.CDP_API_KEY_PRIVATE;
  const walletSecret = process.env.CDP_WALLET_SECRET || "";

  const missing = [];
  if (!apiKeyId) missing.push("CDP_API_KEY_ID (or CDP_API_KEY_NAME)");
  if (!apiKeySecret) missing.push("CDP_API_KEY_SECRET (or CDP_API_KEY_PRIVATE)");

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  return { apiKeyId, apiKeySecret, walletSecret };
}

async function initAgentKitWallet() {
  const cdpConfig = resolveCdpConfig();
  const networkId = process.env.AGENTKIT_NETWORK_ID || "base-mainnet";
  const defaultIdempotencyKey = "8e03978e-40d5-43e8-bc93-6894a57f9324";
  const requestedIdempotencyKey = process.env.TEST_AGENT_IDEMPOTENCY_KEY || defaultIdempotencyKey;
  const idempotencyKey = isUuidV4(requestedIdempotencyKey) ? requestedIdempotencyKey : defaultIdempotencyKey;
  const allowLegacyFallback = String(process.env.AGENTKIT_ALLOW_LEGACY_FALLBACK || "true").toLowerCase() !== "false";
  const walletState = await loadWalletState();

  let walletProviderType = "cdp-evm-v2";
  let walletProvider;

  try {
    if (!cdpConfig.walletSecret) {
      throw new Error("CDP_WALLET_SECRET is not set");
    }

    const options = {
      ...cdpConfig,
      networkId,
    };

    if (walletState && walletState.address) {
      options.address = walletState.address;
    } else {
      options.idempotencyKey = idempotencyKey;
    }

    walletProvider = await CdpEvmWalletProvider.configureWithWallet(options);
  } catch (error) {
    if (!allowLegacyFallback) {
      throw error;
    }
    walletProviderType = "legacy-cdp-v1";
    walletProvider = await LegacyCdpWalletProvider.configureWithWallet({
      apiKeyId: cdpConfig.apiKeyId,
      apiKeySecret: cdpConfig.apiKeySecret,
      networkId,
    });
  }

  const address = walletProvider.getAddress();

  const nextState = {
    address,
    providerType: walletProviderType,
    networkId,
    lastUpdatedAt: timestamp(),
  };
  await saveWalletState(nextState);

  return nextState;
}

async function request(pathname) {
  const startedAt = timestamp();
  const startedMs = Date.now();

  const response = await fetch(pathname, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": "robomoustachio-demo-agent/1.0",
    },
  });

  const endedAt = timestamp();
  const durationMs = Date.now() - startedMs;
  const rawBody = await response.text();
  let body = rawBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // Leave as text if not JSON.
  }

  return {
    request: {
      method: "GET",
      url: pathname,
      startedAt,
    },
    response: {
      status: response.status,
      ok: response.ok,
      endedAt,
      durationMs,
      body,
    },
  };
}

function classifyBand(score, totalFeedback, confidence) {
  const noData = score === null || (score === 0 && (totalFeedback === 0 || confidence === 0));
  if (noData) {
    return {
      key: "UNKNOWN",
      color: chalk.gray,
      verdict: "UNKNOWN - requesting verification",
    };
  }

  if (score > 700) {
    return {
      key: "TRUSTED",
      color: chalk.green,
      verdict: "TRUSTED - proceeding",
    };
  }

  if (score >= 400) {
    return {
      key: "CAUTION",
      color: chalk.yellow,
      verdict: "CAUTION - manual review",
    };
  }

  return {
    key: "DANGEROUS",
    color: chalk.red,
    verdict: "DANGEROUS - aborting",
  };
}

function scoreProgressBar(score, paint) {
  if (score === null) {
    return chalk.gray("[" + "?".repeat(BAR_WIDTH) + "]");
  }

  const normalized = Math.max(0, Math.min(MAX_SCORE, score));
  const filled = Math.round((normalized / MAX_SCORE) * BAR_WIDTH);
  const empty = Math.max(0, BAR_WIDTH - filled);
  return `[${paint("█".repeat(filled))}${chalk.gray("░".repeat(empty))}]`;
}

function renderBox(lines) {
  const width = lines.reduce((max, line) => Math.max(max, visibleLength(line)), 0);
  const top = `┌${"─".repeat(width + 2)}┐`;
  const bottom = `└${"─".repeat(width + 2)}┘`;

  console.log(top);
  for (const line of lines) {
    console.log(`│ ${padAnsi(line, width)} │`);
  }
  console.log(bottom);
}

function summaryTable(rows) {
  const headers = ["Agent", "Score", "Confidence", "Verdict", "Flagged", "Trend"];
  const matrix = rows.map((row) => [
    row.agentId,
    row.scoreDisplay,
    row.confidence,
    row.verdict,
    row.flagged,
    row.trend,
  ]);

  const widths = headers.map((header, idx) => {
    const dataWidth = matrix.reduce((max, row) => Math.max(max, visibleLength(row[idx])), 0);
    return Math.max(visibleLength(header), dataWidth);
  });

  const makeBorder = (left, join, right) =>
    `${left}${widths.map((w) => "─".repeat(w + 2)).join(join)}${right}`;

  const makeRow = (cells) =>
    `│ ${cells.map((cell, idx) => padAnsi(cell, widths[idx])).join(" │ ")} │`;

  console.log(makeBorder("┌", "┬", "┐"));
  console.log(makeRow(headers.map((header) => chalk.bold(header))));
  console.log(makeBorder("├", "┼", "┤"));
  for (const row of matrix) {
    console.log(makeRow(row));
  }
  console.log(makeBorder("└", "┴", "┘"));
}

function safeFeedbackLine(positive, total) {
  if (positive === null || total === null) {
    return chalk.gray("Feedback: no report data");
  }
  return `Feedback: ${positive}/${total} positive`;
}

function safeRiskLine(riskFactors) {
  if (!Array.isArray(riskFactors) || riskFactors.length === 0) {
    return "Risk Factors: none";
  }
  return `Risk Factors: ${riskFactors.join(", ")}`;
}

function safeTrend(trend) {
  return trend || "unknown";
}

function safeFlagged(flagged) {
  if (typeof flagged !== "boolean") {
    return "Unknown";
  }
  return flagged ? "Yes" : "No";
}

async function evaluateAgent(baseUrl, agentId) {
  console.log(chalk.cyan(`\nQuerying oracle for Agent #${agentId}...`));
  await sleep(THINK_DELAY_MS);

  const scoreTrace = await request(`${baseUrl}/score/${agentId}`);
  const reportTrace = await request(`${baseUrl}/report/${agentId}`);

  const scoreBody = scoreTrace.response.body && typeof scoreTrace.response.body === "object" ? scoreTrace.response.body : {};
  const reportBody = reportTrace.response.body && typeof reportTrace.response.body === "object" ? reportTrace.response.body : {};

  const scoreFromScore = scoreTrace.response.ok ? toNumber(scoreBody.score) : null;
  const scoreFromReport = reportTrace.response.ok ? toNumber(reportBody.score) : null;
  const score = scoreFromScore !== null ? scoreFromScore : scoreFromReport;

  const confidenceFromScore = scoreTrace.response.ok ? toNumber(scoreBody.confidence) : null;
  const confidenceFromReport = reportTrace.response.ok ? toNumber(reportBody.confidence) : null;
  const confidenceValue = confidenceFromReport !== null ? confidenceFromReport : confidenceFromScore;

  const totalFeedback = reportTrace.response.ok ? toNumber(reportBody.totalFeedback) : null;
  const positiveFeedback = reportTrace.response.ok ? toNumber(reportBody.positiveFeedback) : null;
  const trend = reportTrace.response.ok ? safeTrend(reportBody.recentTrend) : "unknown";
  const flagged = reportTrace.response.ok && typeof reportBody.flagged === "boolean" ? reportBody.flagged : null;
  const riskFactors = reportTrace.response.ok ? reportBody.riskFactors : [];

  const confidence = confidenceLabel(confidenceValue);
  const band = classifyBand(score, totalFeedback, confidenceValue);
  const paint = band.color;

  const scoreDisplay = score === null ? "N/A" : String(score);
  const flaggedDisplay = safeFlagged(flagged);
  const lines = [
    `Agent #${agentId}`,
    `Score: ${scoreDisplay} / ${MAX_SCORE} ${scoreProgressBar(score, paint)}`,
    `Confidence: ${confidencePaint(confidence)}`,
    safeFeedbackLine(positiveFeedback, totalFeedback),
    safeRiskLine(riskFactors),
    `Trend: ${trend}`,
    `Flagged: ${flaggedDisplay}`,
    "",
    `${paint("Verdict:")} ${paint(band.verdict)}`,
    chalk.gray(`HTTP: /score ${scoreTrace.response.status} (${scoreTrace.response.durationMs}ms) | /report ${reportTrace.response.status} (${reportTrace.response.durationMs}ms)`),
  ];

  renderBox(lines);

  return {
    agentId: `#${agentId}`,
    score: score,
    scoreDisplay,
    confidence: confidence.toUpperCase(),
    verdict: paint(band.key),
    flagged: flaggedDisplay,
    trend,
  };
}

async function main() {
  const baseUrl = stripTrailingSlash(process.env.TRUST_ORACLE_BASE_URL || "https://robomoustach.io");
  const agentIds = parseAgentIds();

  console.log(chalk.gray("=".repeat(58)));
  console.log(chalk.bold("ROBOMOUSTACHIO - Agent Trust Verification"));
  console.log(chalk.gray("=".repeat(58)));

  const wallet = await initAgentKitWallet();
  console.log(chalk.gray(`Wallet: ${wallet.address} (${wallet.providerType}, ${wallet.networkId})`));

  const rows = [];
  for (const agentId of agentIds) {
    const row = await evaluateAgent(baseUrl, agentId);
    rows.push(row);
  }

  console.log(chalk.cyan("\nSummary"));
  summaryTable(rows);
}

main().catch((error) => {
  console.error(chalk.red(`[${timestamp()}] demo failed: ${error.message}`));
  process.exit(1);
});

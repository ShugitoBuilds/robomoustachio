"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const dotenv = require("dotenv");
const { CdpEvmWalletProvider, LegacyCdpWalletProvider } = require("@coinbase/agentkit");

const THIS_DIR = __dirname;
const ROOT_ENV_PATH = path.resolve(THIS_DIR, "..", ".env");
const LOCAL_ENV_PATH = path.join(THIS_DIR, ".env");
const WALLET_STATE_PATH = path.join(THIS_DIR, "wallet-state.json");

dotenv.config({ path: ROOT_ENV_PATH });
dotenv.config({ path: LOCAL_ENV_PATH, override: true });

function isTrue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function buildOutputConfig(env = process.env) {
  const mode = String(env.OUTPUT_MODE || "demo").trim().toLowerCase();
  const useColor = !isTrue(env.NO_COLOR) && env.OUTPUT_COLOR !== "false" && process.stdout.isTTY;
  const showHttpSummary = mode === "debug" || !String(env.OUTPUT_SHOW_HTTP || "true").trim().toLowerCase().startsWith("f");
  return {
    mode: mode === "debug" ? "debug" : "demo",
    useColor,
    verboseHttp: mode === "debug" || isTrue(env.OUTPUT_VERBOSE_HTTP),
    printJsonSummary: mode === "debug" || isTrue(env.OUTPUT_PRINT_JSON_SUMMARY),
    showHttpSummary,
  };
}

const OUTPUT = buildOutputConfig(process.env);

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  gray: "\u001b[90m",
};

function paint(text, color, output = OUTPUT) {
  if (!output.useColor || !color || !ANSI[color]) {
    return text;
  }
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

function paintBold(text, output = OUTPUT) {
  if (!output.useColor) {
    return text;
  }
  return `${ANSI.bold}${text}${ANSI.reset}`;
}

function timestamp() {
  return new Date().toISOString();
}

function stripTrailingSlash(url) {
  return `${url || ""}`.replace(/\/+$/, "");
}

function toScore(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toConfidence(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function decisionTier(decision) {
  return String(decision || "").split(",")[0].trim();
}

function decisionTag(decision) {
  const tier = decisionTier(decision);
  if (tier === "TRUSTED") return "[OK]";
  if (tier === "RISKY") return "[WARN]";
  if (tier === "DANGEROUS") return "[BLOCK]";
  return "[INFO]";
}

function decisionColor(decision) {
  const tier = decisionTier(decision);
  if (tier === "TRUSTED") return "green";
  if (tier === "RISKY") return "yellow";
  if (tier === "DANGEROUS") return "red";
  return "cyan";
}

function classifyDecision({ score, totalFeedback, confidence }) {
  const hasNoHistory = totalFeedback === 0 || (totalFeedback === null && confidence === 0);
  if (score === 0 && hasNoHistory) {
    return "UNKNOWN, requesting verification";
  }
  if (score <= 150) {
    return "DANGEROUS, blacklisted";
  }
  if (score <= 500) {
    return "RISKY, aborting";
  }
  return "TRUSTED, proceeding";
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

function isUuidV4(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim()
  );
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

async function initAgentKitWallet(output = OUTPUT) {
  const cdpConfig = resolveCdpConfig();
  const networkId = process.env.AGENTKIT_NETWORK_ID || "base-mainnet";
  const defaultIdempotencyKey = "8e03978e-40d5-43e8-bc93-6894a57f9324";
  const requestedIdempotencyKey = process.env.TEST_AGENT_IDEMPOTENCY_KEY || defaultIdempotencyKey;
  const idempotencyKey = isUuidV4(requestedIdempotencyKey) ? requestedIdempotencyKey : defaultIdempotencyKey;
  const allowLegacyFallback = String(process.env.AGENTKIT_ALLOW_LEGACY_FALLBACK || "true").toLowerCase() !== "false";
  const walletState = await loadWalletState();

  if (!isUuidV4(requestedIdempotencyKey)) {
    console.warn(
      `[${timestamp()}] TEST_AGENT_IDEMPOTENCY_KEY is not UUID v4; using default ${defaultIdempotencyKey}.`
    );
  }
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
    console.warn(
      `[${timestamp()}] Falling back to LegacyCdpWalletProvider (${error.message}). ` +
        "Set CDP_WALLET_SECRET to use CdpEvmWalletProvider."
    );
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

  if (output.verboseHttp) {
    console.log(`[${timestamp()}] AgentKit wallet ready (${walletProviderType}) on ${networkId}: ${address}`);
  } else {
    console.log(`${paint("[wallet]", "cyan", output)} ${walletProviderType} ${paint(address, "gray", output)}`);
  }
  return nextState;
}

async function requestWithTrace(url, context = {}, output = OUTPUT) {
  const startedAt = timestamp();
  const startedMs = Date.now();
  if (output.verboseHttp) {
    console.log(`[${startedAt}] -> GET ${url}`);
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": "robomoustachio-test-agent/1.0",
    },
  });

  const endedAt = timestamp();
  const durationMs = Date.now() - startedMs;
  const rawBody = await response.text();
  let parsedBody = rawBody;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    // Keep raw text when not JSON.
  }

  const trace = {
    request: {
      method: "GET",
      url,
      startedAt,
    },
    response: {
      status: response.status,
      ok: response.ok,
      endedAt,
      durationMs,
      headers: Object.fromEntries(response.headers.entries()),
      body: parsedBody,
    },
  };

  if (output.verboseHttp) {
    console.log(`[${endedAt}] <- ${response.status} ${url} (${durationMs}ms)`);
    console.log(`[${endedAt}] body: ${typeof parsedBody === "string" ? parsedBody : JSON.stringify(parsedBody)}`);
  } else if (output.showHttpSummary && context.agentId && context.routeName) {
    console.log(
      `  ${paint("[http]", "gray", output)} agent ${context.agentId} ${context.routeName} -> ${response.status} (${durationMs}ms)`
    );
  }

  return trace;
}

function printDemoHeader(baseUrl, agentIds, output = OUTPUT) {
  if (output.verboseHttp) {
    return;
  }
  console.log(paintBold("RoboMoustachio Trust Demo", output));
  console.log(`${paint("[target]", "cyan", output)} ${baseUrl}`);
  console.log(`${paint("[agents]", "cyan", output)} ${agentIds.join(", ")}`);
  console.log("");
}

function countByTier(evaluations) {
  const counts = { TRUSTED: 0, RISKY: 0, DANGEROUS: 0, UNKNOWN: 0 };
  for (const item of evaluations) {
    const tier = decisionTier(item.decision);
    if (counts[tier] !== undefined) {
      counts[tier] += 1;
    }
  }
  return counts;
}

async function main() {
  const runStartedMs = Date.now();
  const wallet = await initAgentKitWallet(OUTPUT);

  const baseUrl = stripTrailingSlash(process.env.TRUST_ORACLE_BASE_URL || "https://robomoustach.io");
  const agentIds = parseAgentIds();
  const evaluations = [];
  const traces = {};

  printDemoHeader(baseUrl, agentIds, OUTPUT);

  for (const agentId of agentIds) {
    const scoreTrace = await requestWithTrace(`${baseUrl}/score/${agentId}`, { agentId, routeName: "/score" }, OUTPUT);
    const reportTrace = await requestWithTrace(
      `${baseUrl}/report/${agentId}`,
      { agentId, routeName: "/report" },
      OUTPUT
    );
    traces[agentId] = { score: scoreTrace, report: reportTrace };

    let scoreValue = toScore(scoreTrace.response.body && scoreTrace.response.body.score);
    let scoreConfidence = toConfidence(scoreTrace.response.body && scoreTrace.response.body.confidence);

    if (!scoreTrace.response.ok) {
      if (scoreTrace.response.status === 404) {
        scoreValue = 0;
        scoreConfidence = 0;
      } else {
        throw new Error(`Score request failed for agent ${agentId} with status ${scoreTrace.response.status}`);
      }
    }

    if (scoreValue === null || scoreConfidence === null) {
      throw new Error(`Could not parse score payload for agent ${agentId}`);
    }

    let totalFeedback = toScore(reportTrace.response.body && reportTrace.response.body.totalFeedback);
    let confidenceValue = toConfidence(reportTrace.response.body && reportTrace.response.body.confidence);
    if (!reportTrace.response.ok || totalFeedback === null || confidenceValue === null) {
      totalFeedback = null;
      confidenceValue = scoreConfidence;
    }

    const confidence = confidenceLabel(confidenceValue);
    const decision = classifyDecision({
      score: scoreValue,
      totalFeedback,
      confidence: confidenceValue,
    });

    const line = `Checking Agent ${agentId}... Score: ${scoreValue}, Confidence: ${confidence} -> ${decision}`;
    const tag = decisionTag(decision);
    const color = decisionColor(decision);
    console.log(`${paint(tag, color, OUTPUT)} ${line}`);
    evaluations.push({
      agentId,
      score: scoreValue,
      confidence: confidenceValue,
      confidenceLabel: confidence,
      totalFeedback,
      decision,
      line,
    });
  }

  const summary = {
    timestamp: timestamp(),
    wallet,
    evaluations,
    traces,
  };

  const counts = countByTier(evaluations);
  const totalDurationMs = Date.now() - runStartedMs;
  console.log("");
  console.log(
    `${paint("[summary]", "cyan", OUTPUT)} TRUSTED=${counts.TRUSTED} RISKY=${counts.RISKY} DANGEROUS=${counts.DANGEROUS} UNKNOWN=${counts.UNKNOWN} (${totalDurationMs}ms)`
  );

  if (OUTPUT.printJsonSummary) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`${paint("[tip]", "gray", OUTPUT)} set OUTPUT_MODE=debug for full JSON trace`);
  }
}

main().catch((error) => {
  console.error(`[${timestamp()}] Test bot failed: ${error.message}`);
  process.exit(1);
});

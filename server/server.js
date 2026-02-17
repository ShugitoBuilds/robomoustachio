"use strict";

require("dotenv").config();

const express = require("express");
const { ethers } = require("ethers");

const { loadScoringConfigFromEnv } = require("./scoring");
const { createRequestLoggerMiddleware } = require("./requestLogger");
const { buildRegistrationDocument, formatUsdPrice } = require("./registration");
const { createPaymentMiddleware, extractPaymentHeaders, hasPaymentProof } = require("./paymentMiddleware");
const { validateAgentIdParam } = require("./validation");

const TRUST_SCORE_ABI = [
  "function getScore(uint256 agentId) view returns (uint256)",
  "function getDetailedReport(uint256 agentId) view returns (tuple(uint256 score,uint256 totalFeedback,uint256 positiveFeedback,uint256 lastUpdated,bool exists))",
];

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function toBigInt(value) {
  if (typeof value === "bigint") {
    return value;
  }
  return BigInt(value);
}

function asSafeNumber(bigintValue) {
  const value = toBigInt(bigintValue);
  if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  return value.toString();
}

function parseRecord(record) {
  const score = toBigInt(record.score ?? record[0]);
  const totalFeedback = toBigInt(record.totalFeedback ?? record[1]);
  const positiveFeedback = toBigInt(record.positiveFeedback ?? record[2]);
  const lastUpdated = toBigInt(record.lastUpdated ?? record[3]);
  const exists = Boolean(record.exists ?? record[4]);

  return {
    score,
    totalFeedback,
    positiveFeedback,
    lastUpdated,
    exists,
  };
}

function isCallException(error) {
  return (
    error &&
    (error.code === "CALL_EXCEPTION" ||
      String(error.message || "").toLowerCase().includes("execution reverted") ||
      String(error.shortMessage || "").toLowerCase().includes("execution reverted"))
  );
}

function createTrustScoreReader(env = process.env) {
  const contractAddress = env.TRUST_SCORE_ADDRESS || "";
  const rpcUrl = env.API_RPC_URL || env.BASE_SEPOLIA_RPC_URL || env.BASE_MAINNET_RPC_URL || "http://127.0.0.1:8545";

  if (!contractAddress) {
    return {
      enabled: false,
      reason: "TRUST_SCORE_ADDRESS is not configured",
    };
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(contractAddress, TRUST_SCORE_ABI, provider);
  return {
    enabled: true,
    contractAddress,
    rpcUrl,
    provider,
    contract,
  };
}

function buildRoutePricing(env = process.env) {
  return {
    "GET /score/:agentId": {
      price: formatUsdPrice(env.X402_SCORE_PRICE_USDC || "0.001"),
      network: env.X402_NETWORK || "base",
      description: "Agent trust score query",
    },
    "GET /report/:agentId": {
      price: formatUsdPrice(env.X402_REPORT_PRICE_USDC || "0.005"),
      network: env.X402_NETWORK || "base",
      description: "Detailed agent trust report",
    },
  };
}

function buildRiskReport({ parsedRecord, scoringConfig, pollIntervalMs }) {
  const total = parsedRecord.totalFeedback;
  const positive = parsedRecord.positiveFeedback;
  const negative = total - positive;

  const confidenceThreshold = BigInt(scoringConfig.confidenceThresholdFeedbackCount);
  const confidence =
    confidenceThreshold === 0n ? 1 : Math.min(1, Number(total) / Number(scoringConfig.confidenceThresholdFeedbackCount));

  const negativeRateBps = total === 0n ? 0 : Math.round((Number(negative) / Number(total)) * 10_000);
  const flagged = total > 0n && negativeRateBps > scoringConfig.negativeFlagThresholdBps;

  const riskFactors = [];
  if (total < confidenceThreshold) {
    riskFactors.push("low_feedback_volume");
  }
  if (flagged) {
    riskFactors.push("high_negative_feedback_ratio");
  }
  if (parsedRecord.score < 500n) {
    riskFactors.push("low_trust_score");
  }

  let recentTrend = "insufficient_data";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ageSeconds = Math.max(0, nowSeconds - Number(parsedRecord.lastUpdated));
  if (ageSeconds > pollIntervalMs / 1000 * 2) {
    recentTrend = "stale";
  } else if (riskFactors.length === 0) {
    recentTrend = "stable";
  } else {
    recentTrend = "caution";
  }

  return {
    confidence: Number(confidence.toFixed(4)),
    negativeRateBps,
    flagged,
    riskFactors,
    recentTrend,
  };
}

function isDemoRequest(req) {
  const value = String(req.query?.demo || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function resolveVerdict(score) {
  if (typeof score !== "number" || Number.isNaN(score)) {
    return "UNKNOWN";
  }
  if (score > 700) {
    return "TRUSTED";
  }
  if (score >= 400) {
    return "CAUTION";
  }
  return "DANGEROUS";
}

function resolveConfidenceBand(totalFeedback) {
  if (totalFeedback >= 50) {
    return "high";
  }
  if (totalFeedback > 0) {
    return "low";
  }
  return "none";
}

function resolvePaidRouteAccess({ req, res, env, payment }) {
  if (payment.usingRealMiddleware) {
    return {
      allowFullResponse: true,
      allowDemoResponse: false,
    };
  }

  const allowDemoQuery = toBoolean(env.X402_ALLOW_DEMO_QUERY, true);
  const shouldRequireHeader = Boolean(payment.fallbackFromReal) || toBoolean(env.X402_STUB_ENFORCE, false);
  const paid = hasPaymentProof(extractPaymentHeaders(req));

  if (paid) {
    res.locals.paymentStatus = "paid_stub";
    return {
      allowFullResponse: true,
      allowDemoResponse: false,
    };
  }

  if (allowDemoQuery && isDemoRequest(req)) {
    res.locals.paymentStatus = "demo_free";
    return {
      allowFullResponse: false,
      allowDemoResponse: true,
    };
  }

  if (shouldRequireHeader) {
    return {
      allowFullResponse: false,
      allowDemoResponse: false,
      paymentRequired: true,
      paymentReason:
        "x402 middleware is running in stub fallback mode. Include an x402 payment header for full data, or add ?demo=true for a limited free response.",
    };
  }

  return {
    allowFullResponse: true,
    allowDemoResponse: false,
  };
}

function buildResponseMeta() {
  return {
    provider: "Robomoustachio",
    service: "ERC-8004 Trust Oracle",
    discover: "https://robomoustach.io/discover",
    note: "Verify any agent's trust score before transacting. Free on-chain queries, premium API via x402.",
  };
}

function createApp(env = process.env) {
  const app = express();
  app.set("trust proxy", 1);
  const port = toPositiveInt(env.PORT, 3000);
  const pollIntervalMs = toPositiveInt(env.INDEXER_POLL_INTERVAL_MS, 900_000);
  const scoringConfig = loadScoringConfigFromEnv(env);
  const trustScoreReader = createTrustScoreReader(env);
  const routePricing = buildRoutePricing(env);

  const payment = createPaymentMiddleware({
    mode: env.X402_MODE || "auto",
    routeConfig: routePricing,
    enforceStubPayment: env.X402_STUB_ENFORCE || "false",
    env,
  });

  app.disable("x-powered-by");
  app.use(express.json());
  app.use(createRequestLoggerMiddleware({ logFilePath: env.REQUEST_LOG_FILE }));
  app.use(payment.middleware);

  app.get("/health", (req, res) => {
    return res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      payment: {
        mode: payment.mode,
        usingRealMiddleware: payment.usingRealMiddleware,
        fallbackFromReal: Boolean(payment.fallbackFromReal),
        reason: payment.reason,
      },
      trustScore: {
        configured: trustScoreReader.enabled,
        contractAddress: trustScoreReader.enabled ? trustScoreReader.contractAddress : null,
      },
    });
  });

  app.get("/discover", (req, res) => {
    return res.json(buildRegistrationDocument(env));
  });

  app.get("/score/:agentId", validateAgentIdParam, async (req, res, next) => {
    try {
      const access = resolvePaidRouteAccess({ req, res, env, payment });
      if (access.paymentRequired) {
        return res.status(402).json({
          error: "Payment required",
          route: "GET /score/:agentId",
          price: routePricing["GET /score/:agentId"].price,
          network: routePricing["GET /score/:agentId"].network,
          details: access.paymentReason,
        });
      }

      if (!trustScoreReader.enabled) {
        return res.status(503).json({
          error: "TrustScore contract is not configured",
          details: "Set TRUST_SCORE_ADDRESS and API_RPC_URL (or Base RPC env vars) before querying scores.",
        });
      }

      const report = await trustScoreReader.contract.getDetailedReport(req.agentId);
      const parsedRecord = parseRecord(report);

      const confidenceThreshold = Number(scoringConfig.confidenceThresholdFeedbackCount) || 1;
      const confidence = Math.min(1, Number(parsedRecord.totalFeedback) / confidenceThreshold);

      if (access.allowDemoResponse) {
        return res.json({
          demo: true,
          agentId: req.agentId.toString(),
          score: Number(parsedRecord.score),
          verdict: resolveVerdict(Number(parsedRecord.score)),
          confidenceBand: resolveConfidenceBand(Number(parsedRecord.totalFeedback)),
          note: "Demo response only. Provide an x402 payment header for the full paid payload.",
          meta: buildResponseMeta(),
        });
      }

      res.locals.paymentStatus = payment.usingRealMiddleware ? "paid_real" : "paid_stub";
      return res.json({
        agentId: req.agentId.toString(),
        score: Number(parsedRecord.score),
        confidence: Number(confidence.toFixed(4)),
        lastUpdated: asSafeNumber(parsedRecord.lastUpdated),
        meta: buildResponseMeta(),
      });
    } catch (error) {
      if (isCallException(error)) {
        const access = resolvePaidRouteAccess({ req, res, env, payment });
        if (access.allowDemoResponse) {
          return res.json({
            demo: true,
            agentId: req.agentId.toString(),
            score: null,
            verdict: "UNKNOWN",
            confidenceBand: "none",
            note: "No on-chain history yet. Demo response returned without payment.",
            meta: buildResponseMeta(),
          });
        }

        return res.status(404).json({
          error: "Score not found for agent",
          agentId: req.agentId.toString(),
        });
      }
      return next(error);
    }
  });

  app.get("/report/:agentId", validateAgentIdParam, async (req, res, next) => {
    try {
      const access = resolvePaidRouteAccess({ req, res, env, payment });
      if (access.paymentRequired) {
        return res.status(402).json({
          error: "Payment required",
          route: "GET /report/:agentId",
          price: routePricing["GET /report/:agentId"].price,
          network: routePricing["GET /report/:agentId"].network,
          details: access.paymentReason,
        });
      }

      if (!trustScoreReader.enabled) {
        return res.status(503).json({
          error: "TrustScore contract is not configured",
          details: "Set TRUST_SCORE_ADDRESS and API_RPC_URL (or Base RPC env vars) before querying reports.",
        });
      }

      const report = await trustScoreReader.contract.getDetailedReport(req.agentId);
      const parsedRecord = parseRecord(report);
      const analytics = buildRiskReport({ parsedRecord, scoringConfig, pollIntervalMs });

      if (access.allowDemoResponse) {
        return res.json({
          demo: true,
          agentId: req.agentId.toString(),
          score: Number(parsedRecord.score),
          verdict: resolveVerdict(Number(parsedRecord.score)),
          confidenceBand: resolveConfidenceBand(Number(parsedRecord.totalFeedback)),
          flagged: analytics.flagged,
          note: "Demo response only. Provide an x402 payment header for the full paid payload.",
          meta: buildResponseMeta(),
        });
      }

      res.locals.paymentStatus = payment.usingRealMiddleware ? "paid_real" : "paid_stub";
      return res.json({
        agentId: req.agentId.toString(),
        score: Number(parsedRecord.score),
        confidence: analytics.confidence,
        totalFeedback: asSafeNumber(parsedRecord.totalFeedback),
        positiveFeedback: asSafeNumber(parsedRecord.positiveFeedback),
        recentTrend: analytics.recentTrend,
        flagged: analytics.flagged,
        riskFactors: analytics.riskFactors,
        negativeRateBps: analytics.negativeRateBps,
        lastUpdated: asSafeNumber(parsedRecord.lastUpdated),
        meta: buildResponseMeta(),
      });
    } catch (error) {
      if (isCallException(error)) {
        const access = resolvePaidRouteAccess({ req, res, env, payment });
        if (access.allowDemoResponse) {
          return res.json({
            demo: true,
            agentId: req.agentId.toString(),
            score: null,
            verdict: "UNKNOWN",
            confidenceBand: "none",
            flagged: false,
            note: "No on-chain history yet. Demo response returned without payment.",
            meta: buildResponseMeta(),
          });
        }

        return res.status(404).json({
          error: "Report not found for agent",
          agentId: req.agentId.toString(),
        });
      }
      return next(error);
    }
  });

  app.use((error, req, res, _next) => {
    const statusCode = Number(error.statusCode) || 500;
    console.error(`[server] ${req.method} ${req.originalUrl} -> ${statusCode}: ${error.stack || error.message}`);
    res.status(statusCode).json({
      error: "Internal server error",
      details: error.message || "Unknown error",
    });
  });

  return {
    app,
    port,
    payment,
    trustScoreReader,
  };
}

function startServer(env = process.env) {
  const { app, port, payment, trustScoreReader } = createApp(env);
  app.listen(port, () => {
    console.log(
      `[server] listening on :${port} | x402=${payment.mode} | trustScoreConfigured=${trustScoreReader.enabled}`
    );
  });
}

module.exports = {
  TRUST_SCORE_ABI,
  createApp,
  startServer,
};

if (require.main === module) {
  startServer(process.env);
}

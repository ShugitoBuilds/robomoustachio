"use strict";

const { formatUsdPrice } = require("./registration");

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

function routeToRegex(routePath) {
  return new RegExp(
    `^${routePath
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/:([A-Za-z0-9_]+)/g, "[^/]+")}$`
  );
}

function buildPaidRoutes(routeConfig) {
  return Object.entries(routeConfig || {}).map(([key, config]) => {
    const [method, ...pathParts] = key.trim().split(" ");
    const routePath = pathParts.join(" ").trim();
    return {
      key,
      method: method.toUpperCase(),
      routePath,
      regex: routeToRegex(routePath),
      config: {
        ...config,
        price: formatUsdPrice(config.price),
      },
    };
  });
}

function matchPaidRoute(req, paidRoutes) {
  const method = req.method.toUpperCase();
  const pathname = req.path;
  return paidRoutes.find((route) => route.method === method && route.regex.test(pathname));
}

function extractPaymentHeaders(req) {
  const relevant = {};
  for (const [key, value] of Object.entries(req.headers || {})) {
    const lower = key.toLowerCase();
    if (
      lower.startsWith("x-payment") ||
      lower.startsWith("x402") ||
      lower === "payment" ||
      lower === "authorization"
    ) {
      relevant[lower] = Array.isArray(value) ? value.join(",") : String(value);
    }
  }
  return relevant;
}

function hasPaymentProof(headers) {
  if (!headers || typeof headers !== "object") {
    return false;
  }

  const status = `${headers["x-payment-status"] || ""}`.toLowerCase();
  return Boolean(
    headers["x-payment"] ||
      headers["x-payment-proof"] ||
      headers["x402-payment"] ||
      headers["x402-proof"] ||
      headers.authorization ||
      status === "paid"
  );
}

function parseRouteKey(key) {
  const trimmed = String(key || "").trim();
  const [method = "", ...pathParts] = trimmed.split(" ");
  const routePath = pathParts.join(" ").trim();
  return {
    key: trimmed,
    method: method.toUpperCase(),
    routePath,
  };
}

function toX402RoutePath(routePath) {
  return String(routePath || "").replace(/:([A-Za-z0-9_]+)/g, "[$1]");
}

function buildX402RouteConfig(routeConfig) {
  const mapped = {};
  for (const [key, config] of Object.entries(routeConfig || {})) {
    const parsed = parseRouteKey(key);
    if (!parsed.method || !parsed.routePath) {
      continue;
    }

    const routeLevelConfig = { ...(config || {}) };
    const nestedConfig = { ...(routeLevelConfig.config || {}) };

    if (routeLevelConfig.description && !nestedConfig.description) {
      nestedConfig.description = routeLevelConfig.description;
    }
    if (routeLevelConfig.mimeType && !nestedConfig.mimeType) {
      nestedConfig.mimeType = routeLevelConfig.mimeType;
    }
    if (routeLevelConfig.resource && !nestedConfig.resource) {
      nestedConfig.resource = routeLevelConfig.resource;
    }
    if (routeLevelConfig.maxTimeoutSeconds && !nestedConfig.maxTimeoutSeconds) {
      nestedConfig.maxTimeoutSeconds = routeLevelConfig.maxTimeoutSeconds;
    }

    mapped[`${parsed.method} ${toX402RoutePath(parsed.routePath)}`] = {
      price: formatUsdPrice(routeLevelConfig.price),
      network: routeLevelConfig.network || "base",
      config: nestedConfig,
    };
  }
  return mapped;
}

function isValidEvmAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(address || ""));
}

function normalizePrivateKeyValue(value) {
  if (typeof value !== "string") {
    return value;
  }
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

function resolvePayToAddress(options = {}, env = process.env) {
  const candidates = [
    options.payTo,
    env.X402_PAY_TO,
    env.X402_RECEIVER_ADDRESS,
    env.DEPLOYER_ADDRESS,
    env.UPDATER_ADDRESS,
  ];
  for (const candidate of candidates) {
    if (isValidEvmAddress(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "Missing pay-to address for x402 middleware. Set X402_PAY_TO (or X402_RECEIVER_ADDRESS / DEPLOYER_ADDRESS)."
  );
}

function resolveFacilitatorConfig(env = process.env) {
  const { createFacilitatorConfig, facilitator } = require("@coinbase/x402");
  const apiKeyId = env.CDP_API_KEY_ID || env.CDP_API_KEY_NAME || "";
  const apiKeySecret = normalizePrivateKeyValue(env.CDP_API_KEY_SECRET || env.CDP_API_KEY_PRIVATE || "");

  if (apiKeyId && apiKeySecret) {
    return createFacilitatorConfig(apiKeyId, apiKeySecret);
  }

  return facilitator;
}

function resolvePaywallConfig(env = process.env) {
  const paywallConfig = {};
  if (env.CDP_CLIENT_API_KEY) {
    paywallConfig.cdpClientKey = env.CDP_CLIENT_API_KEY;
  }
  if (env.X402_PAYWALL_APP_NAME) {
    paywallConfig.appName = env.X402_PAYWALL_APP_NAME;
  }
  if (env.X402_PAYWALL_APP_LOGO) {
    paywallConfig.appLogo = env.X402_PAYWALL_APP_LOGO;
  }
  if (env.X402_PAYWALL_SESSION_TOKEN_ENDPOINT) {
    paywallConfig.sessionTokenEndpoint = env.X402_PAYWALL_SESSION_TOKEN_ENDPOINT;
  }
  return Object.keys(paywallConfig).length > 0 ? paywallConfig : undefined;
}

function createStubPaymentMiddleware(options = {}) {
  const paidRoutes = buildPaidRoutes(options.routeConfig);
  const enforceStubPayment = toBoolean(options.enforceStubPayment, false);

  const middleware = function stubPaymentMiddleware(req, res, next) {
    const matchedRoute = matchPaidRoute(req, paidRoutes);
    if (!matchedRoute) {
      if (!res.locals.paymentStatus) {
        res.locals.paymentStatus = "free";
      }
      return next();
    }

    const paymentHeaders = extractPaymentHeaders(req);
    const paid = hasPaymentProof(paymentHeaders);
    res.locals.paymentStatus = paid ? "paid_stub" : "unpaid_stub";

    console.log(
      `[x402-stub] ${req.method} ${req.path} route=${matchedRoute.key} paid=${paid} headers=${JSON.stringify(
        paymentHeaders
      )}`
    );

    if (!paid && enforceStubPayment) {
      return res.status(402).json({
        error: "Payment required (stub middleware)",
        route: matchedRoute.key,
        price: matchedRoute.config.price,
        network: matchedRoute.config.network || "base",
        description: matchedRoute.config.description || "",
      });
    }

    return next();
  };

  return {
    mode: "stub",
    usingRealMiddleware: false,
    fallbackFromReal: false,
    reason: "Using local x402 stub middleware",
    middleware,
  };
}

function createRealPaymentMiddleware(options = {}, env = process.env) {
  const { paymentMiddleware } = require("x402-express");
  if (typeof paymentMiddleware !== "function") {
    throw new Error("x402-express.paymentMiddleware export was not found");
  }

  const x402RouteConfig = buildX402RouteConfig(options.routeConfig || {});
  const payToAddress = resolvePayToAddress(options, env);
  const facilitatorConfig = resolveFacilitatorConfig(env);
  const paywallConfig = resolvePaywallConfig(env);

  const middleware = paymentMiddleware(payToAddress, x402RouteConfig, facilitatorConfig, paywallConfig);
  if (typeof middleware !== "function") {
    throw new Error("x402-express did not return a middleware function");
  }

  return {
    mode: "real",
    usingRealMiddleware: true,
    fallbackFromReal: false,
    reason: "Using x402-express middleware with Coinbase facilitator",
    middleware,
    payToAddress,
  };
}

function createPaymentMiddleware(options = {}) {
  const env = options.env || process.env;
  const routeConfig = options.routeConfig || {};
  const mode = String(options.mode || env.X402_MODE || "auto").toLowerCase();
  const shouldTryReal = mode === "real" || mode === "auto";

  if (shouldTryReal) {
    try {
      return createRealPaymentMiddleware({ ...options, routeConfig }, env);
    } catch (error) {
      if (mode === "real") {
        throw error;
      }
      return {
        ...createStubPaymentMiddleware(options),
        fallbackFromReal: true,
        reason: `Fell back to stub middleware: ${error.message}`,
      };
    }
  }

  return createStubPaymentMiddleware(options);
}

module.exports = {
  buildX402RouteConfig,
  createPaymentMiddleware,
  createRealPaymentMiddleware,
  createStubPaymentMiddleware,
  extractPaymentHeaders,
  hasPaymentProof,
  resolvePayToAddress,
};

"use strict";

const path = require("node:path");

const dotenv = require("dotenv");
const { createWalletClient, http } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { base } = require("viem/chains");
const { wrapFetchWithPayment, decodeXPaymentResponse } = require("x402-fetch");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

function toUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizePrivateKey(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function parseMaxAtomic(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid X402_MAX_PAYMENT_ATOMIC value: ${raw}`);
  }
  return BigInt(raw);
}

function parseBody(text) {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main() {
  const targetUrl = process.env.X402_TEST_URL || "https://robomoustach.io/score/1";
  const rpcUrl = process.env.X402_TEST_RPC_URL || process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org";
  const privateKey = normalizePrivateKey(process.env.X402_TEST_PRIVATE_KEY);
  const maxAtomic = parseMaxAtomic(process.env.X402_MAX_PAYMENT_ATOMIC, 20_000n);

  if (!privateKey || privateKey === "0x") {
    throw new Error("Missing X402_TEST_PRIVATE_KEY (funded Base wallet private key required)");
  }

  const parsedTarget = toUrl(targetUrl);
  if (!parsedTarget) {
    throw new Error(`Invalid X402_TEST_URL: ${targetUrl}`);
  }

  console.log(`[paid-test] target=${targetUrl}`);
  console.log(`[paid-test] rpc=${rpcUrl}`);
  console.log(`[paid-test] maxAtomic=${maxAtomic.toString()} (USDC 6 decimals)`);

  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl),
  });

  console.log(`[paid-test] payer=${account.address}`);

  const plainResponse = await fetch(targetUrl, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": "robomoustachio-x402-paid-test/1.0",
    },
  });
  const plainBodyText = await plainResponse.text();
  const plainBody = parseBody(plainBodyText);
  console.log(`[paid-test] preflight status=${plainResponse.status}`);

  if (plainResponse.status !== 402) {
    throw new Error(
      `Expected unauthenticated preflight status 402, got ${plainResponse.status}. Body: ${plainBodyText}`
    );
  }

  const fetchWithPayment = wrapFetchWithPayment(fetch, walletClient, maxAtomic);
  const paidResponse = await fetchWithPayment(targetUrl, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": "robomoustachio-x402-paid-test/1.0",
    },
  });

  const paidBodyText = await paidResponse.text();
  const paidBody = parseBody(paidBodyText);
  const paymentResponseHeader = paidResponse.headers.get("x-payment-response");

  if (!paidResponse.ok) {
    throw new Error(`Paid request failed (${paidResponse.status}): ${paidBodyText}`);
  }
  if (!paymentResponseHeader) {
    throw new Error("Paid request returned 200 but missing X-PAYMENT-RESPONSE header");
  }

  const settle = decodeXPaymentResponse(paymentResponseHeader);
  console.log(
    JSON.stringify(
      {
        preflight: {
          status: plainResponse.status,
          error: plainBody && typeof plainBody === "object" ? plainBody.error || null : null,
        },
        paid: {
          status: paidResponse.status,
          hasPaymentResponseHeader: Boolean(paymentResponseHeader),
          settle,
          body: paidBody,
        },
      },
      null,
      2
    )
  );

  console.log("[paid-test] PASS: paid x402 flow completed successfully.");
}

main().catch((error) => {
  console.error(`[paid-test] FAIL: ${error.message}`);
  process.exit(1);
});

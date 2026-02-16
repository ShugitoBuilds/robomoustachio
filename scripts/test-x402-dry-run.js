"use strict";

function getBaseUrl() {
  const fromEnv = String(process.env.BASE_URL || process.env.PUBLIC_BASE_URL || "").trim();
  if (fromEnv) {
    return fromEnv.replace(/\/+$/, "");
  }
  const port = Number(process.env.PORT) || 3000;
  return `http://127.0.0.1:${port}`;
}

async function getJson(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  };
}

async function main() {
  const baseUrl = getBaseUrl();
  const agentId = String(process.env.TEST_AGENT_ID || "1");

  console.log(`[dry-run] baseUrl=${baseUrl} agentId=${agentId}`);

  const health = await getJson(`${baseUrl}/health`);
  const score = await getJson(`${baseUrl}/score/${encodeURIComponent(agentId)}`);
  const report = await getJson(`${baseUrl}/report/${encodeURIComponent(agentId)}`);

  const usingReal = Boolean(health.body?.payment?.usingRealMiddleware);
  const scoreIsChallenge = score.status === 402 && Array.isArray(score.body?.accepts);
  const reportIsChallenge = report.status === 402 && Array.isArray(report.body?.accepts);

  console.log(
    JSON.stringify(
      {
        health: {
          status: health.status,
          payment: health.body?.payment || null,
        },
        score: {
          status: score.status,
          error: score.body?.error || null,
          hasAccepts: Array.isArray(score.body?.accepts),
        },
        report: {
          status: report.status,
          error: report.body?.error || null,
          hasAccepts: Array.isArray(report.body?.accepts),
        },
      },
      null,
      2
    )
  );

  if (health.status !== 200) {
    console.error("[dry-run] FAIL: /health did not return 200");
    process.exit(1);
  }

  if (!usingReal) {
    console.error("[dry-run] FAIL: API is not running with real x402 middleware");
    process.exit(1);
  }

  if (!scoreIsChallenge || !reportIsChallenge) {
    console.error("[dry-run] FAIL: expected 402 payment challenges on /score and /report without X-PAYMENT header");
    process.exit(1);
  }

  console.log("[dry-run] PASS: x402 real-mode challenge flow is active.");
}

main().catch((error) => {
  console.error(`[dry-run] FAIL: ${error.message}`);
  process.exit(1);
});

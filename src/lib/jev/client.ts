import { TypeSafeClient } from "@typesafe-ai/sdk";

/**
 * The Jev client.
 *
 * Two constructor fields differ from calling TypeSafe directly, and both have cost a debugging hour
 * before:
 *
 *   - **No `/v1` on the base URL.** The SDK appends `/v1/systemone` itself, so adding it produces
 *     `/api/v1/v1/systemone` and a 404 that reads as a missing endpoint rather than a typo.
 *   - **The model is pinned.** The SDK's own default is `jev-latest`, which floats. Every threshold
 *     in this project is hand-tuned, so a silent model bump would re-tune the whole app at 3am.
 */

export const JEV_MODEL = "typesafe/jev-1.13";
export const JEV_BASE_URL = "https://openrouter.ai/api";

/** Rejects a base URL that already carries the version segment the SDK is about to append. */
export function assertUsableBaseUrl(baseURL: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new Error(`JEV_BASE_URL is not a URL: ${baseURL}`);
  }
  if (/\/v1(\/|$)/i.test(parsed.pathname)) {
    throw new Error(
      `JEV_BASE_URL must not include /v1 — the SDK appends /v1/systemone itself, so "${baseURL}" ` +
        `would request ${parsed.pathname.replace(/\/$/, "")}/v1/systemone. Use ${parsed.origin}/api`,
    );
  }
}

export function createJevClient(env: NodeJS.ProcessEnv = process.env): TypeSafeClient {
  const apiKey = env["OPENROUTER_API_KEY"];
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new Error("OPENROUTER_API_KEY is not set. Copy .env.example to .env and fill it in.");
  }
  const baseURL = env["JEV_BASE_URL"] ?? JEV_BASE_URL;
  assertUsableBaseUrl(baseURL);

  return new TypeSafeClient({
    apiKey,
    baseURL,
    defaultModel: env["JEV_MODEL"] ?? JEV_MODEL,
  });
}

/**
 * OpenRouter adds fields the SDK does not declare: `usage.cost` is the real billed figure.
 *
 * Read rather than computed from a published rate, deliberately. A rate through a reseller is
 * exactly the number we do not know, and a made-up cost is worse than no cost.
 */
export function billedCostUsd(result: unknown): number | null {
  const cost = (result as { usage?: { cost?: unknown } } | null)?.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : null;
}

import type { ProviderQuotaResult } from "@paperclipai/shared";
import { listServerAdapters } from "../adapters/registry.js";

const QUOTA_PROVIDER_TIMEOUT_MS = 20_000;

function providerSlugForAdapterType(type: string): string {
  switch (type) {
    case "claude_local":
      return "anthropic";
    case "codex_local":
      return "openai";
    default:
      return type;
  }
}

/**
 * Asks each registered adapter for its provider quota windows and aggregates the results.
 * Adapters that don't implement getQuotaWindows() are silently skipped.
 * Individual adapter failures are caught and returned as error results rather than
 * letting one provider's outage block the entire response.
 */
export async function fetchAllQuotaWindows(): Promise<ProviderQuotaResult[]> {
  // Every open UI tab polls this; the Anthropic usage API answers 429 when hit too often.
  // Share one upstream call per QUOTA_CACHE_MS and keep showing the last good windows on errors.
  if (cached && Date.now() - cached.at < QUOTA_CACHE_MS) return cached.results;
  inFlight ??= fetchFresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

const QUOTA_CACHE_MS = 120_000;
const LAST_GOOD_MAX_AGE_MS = 6 * 60 * 60_000;
let cached: { at: number; results: ProviderQuotaResult[] } | null = null;
let inFlight: Promise<ProviderQuotaResult[]> | null = null;
const lastGood = new Map<string, { at: number; result: ProviderQuotaResult }>();

async function fetchFresh(): Promise<ProviderQuotaResult[]> {
  const now = Date.now();
  const results = (await fetchAllQuotaWindowsUncached()).map((result) => {
    if (result.ok && result.windows.length > 0) {
      lastGood.set(result.provider, { at: now, result });
      return result;
    }
    const good = lastGood.get(result.provider);
    return good && now - good.at < LAST_GOOD_MAX_AGE_MS ? good.result : result;
  });
  cached = { at: now, results };
  return results;
}

async function fetchAllQuotaWindowsUncached(): Promise<ProviderQuotaResult[]> {
  const adapters = listServerAdapters().filter((a) => a.getQuotaWindows != null);

  const settled = await Promise.allSettled(
    adapters.map((adapter) => withQuotaTimeout(adapter.type, adapter.getQuotaWindows!())),
  );

  return settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    const adapterType = adapters[i]!.type;
    return {
      provider: providerSlugForAdapterType(adapterType),
      ok: false,
      error: String(result.reason),
      windows: [],
    };
  });
}

async function withQuotaTimeout(
  adapterType: string,
  task: Promise<ProviderQuotaResult>,
): Promise<ProviderQuotaResult> {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<ProviderQuotaResult>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            provider: providerSlugForAdapterType(adapterType),
            ok: false,
            error: `quota polling timed out after ${Math.round(QUOTA_PROVIDER_TIMEOUT_MS / 1000)}s`,
            windows: [],
          });
        }, QUOTA_PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

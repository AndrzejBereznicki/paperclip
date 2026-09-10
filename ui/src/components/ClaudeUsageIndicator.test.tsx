// @vitest-environment jsdom

import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeUsageIndicator } from "./ClaudeUsageIndicator";

const mockCostsApi = vi.hoisted(() => ({
  quotaWindows: vi.fn(),
}));

vi.mock("@/api/costs", () => ({
  costsApi: mockCostsApi,
}));

function anthropicResult(overrides: Partial<ProviderQuotaResult> = {}): ProviderQuotaResult {
  return {
    provider: "anthropic",
    ok: true,
    windows: [
      {
        label: "Current session",
        usedPercent: 42,
        resetsAt: "2026-09-10T21:00:00.000Z",
        valueLabel: null,
        detail: null,
      },
      {
        label: "Current week (all models)",
        usedPercent: 95,
        resetsAt: "2026-09-14T00:00:00.000Z",
        valueLabel: null,
        detail: null,
      },
    ],
    ...overrides,
  };
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("ClaudeUsageIndicator", () => {
  let container: HTMLDivElement;

  async function render(node: ReactNode) {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
    });
    await flushReact();
    return root;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders a session bar and a weekly bar from the anthropic quota result", async () => {
    mockCostsApi.quotaWindows.mockResolvedValue([anthropicResult()]);
    const root = await render(<ClaudeUsageIndicator companyId="company-1" />);

    const widget = container.querySelector('[data-testid="claude-usage-indicator"]');
    expect(widget).not.toBeNull();
    expect(widget?.textContent).toContain("Session · 5h");
    expect(widget?.textContent).toContain("42%");
    expect(widget?.textContent).toContain("Week");
    expect(widget?.textContent).toContain("95%");

    flushSync(() => root.unmount());
  });

  it("renders nothing on the collapsed rail and skips the fetch", async () => {
    const root = await render(<ClaudeUsageIndicator companyId="company-1" rail />);

    expect(container.querySelector('[data-testid="claude-usage-indicator"]')).toBeNull();
    expect(mockCostsApi.quotaWindows).not.toHaveBeenCalled();

    flushSync(() => root.unmount());
  });

  it("renders nothing when the provider result is not ok", async () => {
    mockCostsApi.quotaWindows.mockResolvedValue([
      { provider: "anthropic", ok: false, error: "no local claude auth token", windows: [] },
    ]);
    const root = await render(<ClaudeUsageIndicator companyId="company-1" />);

    expect(container.querySelector('[data-testid="claude-usage-indicator"]')).toBeNull();

    flushSync(() => root.unmount());
  });
});

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeUpdateBanner, type ClaudeCodeUpdateStatus } from "./ClaudeCodeUpdateBanner";

const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock("@/api/client", () => ({ api: mockApi }));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function status(overrides: Partial<ClaudeCodeUpdateStatus> = {}): ClaudeCodeUpdateStatus {
  return {
    installedVersion: "2.1.289",
    latestVersion: "2.1.300",
    updateAvailable: true,
    run: null,
    ...overrides,
  };
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() =>
    root?.render(
      <QueryClientProvider client={client}>
        <ClaudeCodeUpdateBanner />
      </QueryClientProvider>,
    ),
  );
  await flushReact();
  return container;
}

const updateButton = (el: HTMLElement) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Zaktualizuj"));

describe("ClaudeCodeUpdateBanner", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockApi.post.mockResolvedValue({});
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.restoreAllMocks();
    mockApi.get.mockReset();
    mockApi.post.mockReset();
  });

  it("offers the update and starts it after confirmation", async () => {
    mockApi.get.mockResolvedValue(status());
    const el = await render();
    expect(el.textContent).toContain("Dostępna aktualizacja Claude Code: 2.1.289 → 2.1.300");

    updateButton(el)!.click();
    await flushReact();
    expect(window.confirm).toHaveBeenCalled();
    expect(mockApi.post).toHaveBeenCalledWith("/instance/claude-code-update", {});
  });

  it("does nothing when the admin cancels the confirmation", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    mockApi.get.mockResolvedValue(status());
    const el = await render();
    updateButton(el)!.click();
    await flushReact();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it("renders nothing when up to date, after a successful update, or for non-admins", async () => {
    mockApi.get.mockResolvedValue(status({ updateAvailable: false, latestVersion: "2.1.289" }));
    expect((await render()).textContent).toBe("");
    flushSync(() => root?.unmount());

    mockApi.get.mockResolvedValue(
      status({
        installedVersion: "2.1.300",
        updateAvailable: false,
        run: { state: "ok", fromVersion: "2.1.289", toVersion: "2.1.300", log: "" },
      }),
    );
    expect((await render()).textContent).toBe("");
    flushSync(() => root?.unmount());

    mockApi.get.mockRejectedValue(new Error("403"));
    expect((await render()).textContent).toBe("");
  });

  it("shows progress without a button while updating", async () => {
    mockApi.get.mockResolvedValue(
      status({ run: { state: "running", fromVersion: "2.1.289", log: "Checking for updates...\n" } }),
    );
    const el = await render();
    expect(el.textContent).toContain("Aktualizuję Claude Code do 2.1.300");
    expect(el.textContent).toContain("Checking for updates...");
    expect(el.querySelector("button")).toBeNull();
  });

  it("shows the error and lets the admin retry after a failed update", async () => {
    mockApi.get.mockResolvedValue(
      status({ run: { state: "failed", fromVersion: "2.1.289", toVersion: "2.1.289", log: "EBUSY: file locked\n" } }),
    );
    const el = await render();
    expect(el.textContent).toContain("nie powiodła się: EBUSY: file locked");
    expect(el.textContent).toContain("Spróbuj ponownie");
  });
});

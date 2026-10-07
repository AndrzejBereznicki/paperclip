// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceUpdateBanner, type InstanceUpdateStatus } from "./InstanceUpdateBanner";

const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock("@/api/client", () => ({ api: mockApi }));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function status(overrides: Partial<InstanceUpdateStatus> = {}): InstanceUpdateStatus {
  return {
    currentVersion: "2026.916.1",
    latestVersion: "2026.1001.0",
    updateAvailable: true,
    configured: true,
    updater: null,
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
        <InstanceUpdateBanner />
      </QueryClientProvider>,
    ),
  );
  await flushReact();
  return container;
}

describe("InstanceUpdateBanner", () => {
  beforeEach(() => {
    localStorage.clear();
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

  it("offers the new version and starts the update only after confirmation", async () => {
    mockApi.get.mockResolvedValue(status());
    const el = await render();
    expect(el.textContent).toContain("Dostępna nowa wersja Paperclip: 2026.1001.0");
    expect(mockApi.post).not.toHaveBeenCalled();

    const button = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Zaktualizuj"))!;
    button.click();
    await flushReact();
    expect(window.confirm).toHaveBeenCalled();
    expect(mockApi.post).toHaveBeenCalledWith("/instance/update", { targetVersion: "2026.1001.0" });
  });

  it("does nothing when the admin cancels the confirmation", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    mockApi.get.mockResolvedValue(status());
    const el = await render();
    [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Zaktualizuj"))!.click();
    await flushReact();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it("renders nothing when up to date, not configured, or not an admin", async () => {
    mockApi.get.mockResolvedValue(status({ updateAvailable: false, latestVersion: "2026.916.1" }));
    expect((await render()).textContent).toBe("");
    flushSync(() => root?.unmount());

    mockApi.get.mockResolvedValue(status({ configured: false }));
    expect((await render()).textContent).toBe("");
    flushSync(() => root?.unmount());

    mockApi.get.mockRejectedValue(new Error("403"));
    expect((await render()).textContent).toBe("");
  });

  it("shows progress while the update is being prepared", async () => {
    mockApi.get.mockResolvedValue(
      status({ updater: { state: "preparing", targetVersion: "2026.1001.0", step: "Buduję interfejs" } }),
    );
    const el = await render();
    expect(el.textContent).toContain("Aktualizacja Paperclip do 2026.1001.0: Buduję interfejs");
    expect(el.textContent).not.toContain("Zaktualizuj");
  });

  it("explains that manual work is needed after a failed update", async () => {
    mockApi.get.mockResolvedValue(
      status({
        updater: {
          state: "failed",
          targetVersion: "2026.1001.0",
          message: "Konflikt przy przenoszeniu naszych zmian.",
          issue: "EKS-300",
          updatedAt: new Date().toISOString(),
        },
      }),
    );
    const el = await render();
    expect(el.textContent).toContain("wymaga ręcznej pracy");
    expect(el.textContent).toContain("EKS-300");
    expect(el.textContent).toContain("Działa dotychczasowa wersja 2026.916.1");
  });
});

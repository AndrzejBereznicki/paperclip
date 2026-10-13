// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeLoginBanner, type ClaudeLoginStatus } from "./ClaudeLoginBanner";

const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock("@/api/client", () => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body: unknown) {
      super(message);
    }
  }
  return { api: mockApi, ApiError };
});

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

const loggedOut: ClaudeLoginStatus = { loggedIn: false, email: null, subscriptionType: null, checkedAt: "2026-10-13T00:00:00Z" };
const loggedIn = { ...loggedOut, loggedIn: true, email: "a@b.c" };
const run = (state: string, url: string | null = null) => ({
  loginId: "L1",
  state,
  url,
  startedAt: "2026-10-13T00:00:00Z",
  finishedAt: null,
});

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
        <ClaudeLoginBanner />
      </QueryClientProvider>,
    ),
  );
  await flushReact();
  return container;
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ClaudeLoginBanner", () => {
  afterEach(() => {
    flushSync(() => root?.unmount());
    container?.remove();
    vi.clearAllMocks();
  });

  it("renders nothing when Claude is logged in", async () => {
    mockApi.get.mockResolvedValue(loggedIn);
    const el = await render();
    expect(el.querySelector("[data-testid=claude-login-banner]")).toBeNull();
  });

  it("logs in with the link and pasted code, then hides", async () => {
    let status = loggedOut;
    let current = run("pending_code", "https://claude.com/cai/oauth/authorize?x=1");
    mockApi.get.mockImplementation(async (path: string) =>
      path.startsWith("/instance/claude-login-status") ? status : current,
    );
    mockApi.post.mockImplementation(async (path: string) => {
      if (path.endsWith("/start")) return current;
      current = run("success");
      status = loggedIn;
      return run("running");
    });

    const el = await render();
    expect(el.textContent).toContain("Claude wylogowany");
    button(el, "Zaloguj")!.click();
    await flushReact();

    const link = el.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://claude.com/cai/oauth/authorize?x=1");
    expect(link.getAttribute("target")).toBe("_blank");

    typeInto(el.querySelector("input")!, "  abc#def  ");
    await flushReact();
    button(el, "Wyślij kod")!.click();
    await flushReact();
    expect(mockApi.post).toHaveBeenCalledWith("/instance/claude-login/L1/code", { browserCode: "abc#def" });
    expect(el.textContent).toContain("Sprawdzam kod");

    // poll picks up success → status revalidated → banner gone
    await vi.waitFor(async () => {
      await flushReact();
      expect(el.querySelector("[data-testid=claude-login-banner]")).toBeNull();
    }, { timeout: 5_000 });
  });

  it("shows a retry message when the login times out", async () => {
    mockApi.get.mockImplementation(async (path: string) =>
      path.startsWith("/instance/claude-login-status") ? loggedOut : run("timeout"),
    );
    mockApi.post.mockResolvedValue(run("timeout"));
    const el = await render();
    button(el, "Zaloguj")!.click();
    await flushReact();
    expect(el.textContent).toContain("Logowanie wygasło");
    expect(button(el, "Zaloguj")).toBeTruthy();
  });
});

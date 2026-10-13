import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const { errorHandler } = await import("../middleware/index.js");
const { claudeLoginRoutes } = await import("../routes/claude-login.js");

const admin = { type: "board", source: "session", isInstanceAdmin: true };

// Synthetic values in the shape `claude auth login --claudeai` 2.1.296 prints
// without a TTY. None of them is a real OAuth value.
const QUERY = [
  "code=true",
  "client_id=9d1c8f00-1a2b-3c4d-5e6f-708192a3b4c5",
  "response_type=code",
  `redirect_uri=${encodeURIComponent("https://platform.claude.com/oauth/code/callback")}`,
  `scope=${encodeURIComponent("org:create_api_key user:profile user:inference user:sessions:claude_code")}`,
  "code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  "code_challenge_method=S256",
  "state=Xy7Kd2Pq9Rn4Vb8Lf1Mw6Zc3Hj0Tg5Us",
].join("&");
const URL = `https://claude.com/cai/oauth/authorize?${QUERY}`;
const OUTPUT = `Opening browser to sign in…\nIf the browser didn't open, visit: ${URL}\nPaste code here if prompted > `;

function fakeLogin(opts: { output?: string; exitCodeOnCode?: number; loginSucceeds?: boolean } = {}) {
  const state = { loggedIn: false };
  const writes: string[] = [];
  let resolveExit: (code: number | null) => void = () => {};
  const kill = vi.fn(() => resolveExit(null));
  const startLogin = vi.fn((onData: (chunk: string) => void) => {
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    setTimeout(() => onData(opts.output ?? OUTPUT), 0);
    return {
      write: (input: string) => {
        writes.push(input);
        if (input === "\r") {
          if (opts.loginSucceeds !== false) state.loggedIn = true;
          setTimeout(() => resolveExit(opts.exitCodeOnCode ?? 0), 0);
        }
      },
      kill,
      exited,
    };
  });
  const readStatus = vi.fn(async () => ({
    loggedIn: state.loggedIn,
    email: state.loggedIn ? "user@example.com" : null,
    subscriptionType: state.loggedIn ? "pro" : null,
  }));
  return { state, writes, kill, startLogin, readStatus };
}

function createApp(actor: any, fake = fakeLogin(), extra: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(
    "/api",
    claudeLoginRoutes({
      readStatus: fake.readStatus,
      startLogin: fake.startLogin,
      codeSubmitSettleMs: 0,
      promptTimeoutMs: 200,
      ...extra,
    }),
  );
  app.use(errorHandler);
  return app;
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("claude login routes", () => {
  it("rejects agents and non-admin board users", async () => {
    const fake = fakeLogin();
    expect((await request(createApp({ type: "agent", agentId: "a1" }, fake)).get("/api/instance/claude-login-status")).status).toBe(403);
    const nonAdmin = createApp({ type: "board", source: "session", isInstanceAdmin: false }, fake);
    expect((await request(nonAdmin).post("/api/instance/claude-login/start")).status).toBe(403);
    expect(fake.startLogin).not.toHaveBeenCalled();
  });

  it("reports logged in and logged out", async () => {
    const fake = fakeLogin();
    const app = createApp(admin, fake);
    const out = await request(app).get("/api/instance/claude-login-status");
    expect(out.body).toMatchObject({ loggedIn: false, email: null, subscriptionType: null });
    expect(typeof out.body.checkedAt).toBe("string");

    fake.state.loggedIn = true;
    const cached = await request(app).get("/api/instance/claude-login-status");
    expect(cached.body.loggedIn).toBe(false);
    const fresh = await request(app).get("/api/instance/claude-login-status?refresh=1");
    expect(fresh.body).toMatchObject({ loggedIn: true, email: "user@example.com", subscriptionType: "pro" });
  });

  it("refuses to start when already logged in", async () => {
    const fake = fakeLogin();
    fake.state.loggedIn = true;
    const res = await request(createApp(admin, fake)).post("/api/instance/claude-login/start");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_logged_in");
    expect(fake.startLogin).not.toHaveBeenCalled();
  });

  it("runs the full login: url, code, success", async () => {
    const fake = fakeLogin();
    const app = createApp(admin, fake);
    const start = await request(app).post("/api/instance/claude-login/start");
    expect(start.status).toBe(201);
    expect(start.body).toMatchObject({ state: "pending_code", url: URL });
    const { loginId } = start.body;

    expect((await request(app).post("/api/instance/claude-login/start")).status).toBe(409);

    const code = await request(app).post(`/api/instance/claude-login/${loginId}/code`).send({ browserCode: "abc123#xyz" });
    expect(code.status).toBe(202);
    expect(code.body).toMatchObject({ state: "running", url: null });
    expect(fake.writes).toEqual(["abc123#xyz", "\r"]);
    await settle();

    const done = await request(app).get(`/api/instance/claude-login/${loginId}`);
    expect(done.body).toMatchObject({ state: "success", url: null });
    expect(JSON.stringify(done.body)).not.toContain("abc123");
    const status = await request(app).get("/api/instance/claude-login-status");
    expect(status.body.loggedIn).toBe(true);
  });

  it("fails when the CLI exits cleanly but is still logged out", async () => {
    const fake = fakeLogin({ loginSucceeds: false });
    const app = createApp(admin, fake);
    const { loginId } = (await request(app).post("/api/instance/claude-login/start")).body;
    await request(app).post(`/api/instance/claude-login/${loginId}/code`).send({ browserCode: "bad" });
    await settle();
    expect((await request(app).get(`/api/instance/claude-login/${loginId}`)).body.state).toBe("failed");
  });

  it("rejects a bad code and an unknown login", async () => {
    const app = createApp(admin);
    const { loginId } = (await request(app).post("/api/instance/claude-login/start")).body;
    expect((await request(app).post(`/api/instance/claude-login/${loginId}/code`).send({ browserCode: "a b" })).status).toBe(400);
    expect((await request(app).post(`/api/instance/claude-login/${loginId}/code`).send({})).status).toBe(400);
    expect((await request(app).get("/api/instance/claude-login/nope")).status).toBe(404);
  });

  it("fails fast when no prompt appears", async () => {
    const fake = fakeLogin({ output: "something unexpected\n" });
    const res = await request(createApp(admin, fake)).post("/api/instance/claude-login/start");
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: "login_prompt_not_found", state: "failed" });
    expect(fake.kill).toHaveBeenCalled();
  });

  it("times out and kills the CLI", async () => {
    const fake = fakeLogin();
    const app = createApp(admin, fake, { loginTimeoutMs: 50 });
    const { loginId } = (await request(app).post("/api/instance/claude-login/start")).body;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await request(app).get(`/api/instance/claude-login/${loginId}`)).body.state).toBe("timeout");
    expect(fake.kill).toHaveBeenCalled();
  });
});

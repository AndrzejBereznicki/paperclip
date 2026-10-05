import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const { errorHandler } = await import("../middleware/index.js");
const { claudeCodeUpdateRoutes } = await import("../routes/claude-code-update.js");

const admin = { type: "board", source: "session", isInstanceAdmin: true };

function createApp(
  actor: any,
  deps: { installed?: string[]; latest?: string | null; fetchLatest?: () => Promise<string | null>; exitCode?: number } = {},
) {
  const installed = [...(deps.installed ?? ["2.1.289"])];
  const runUpdate = vi.fn(async (onOutput: (chunk: string) => void) => {
    onOutput("Updating Claude Code...\n");
    if (installed.length > 1) installed.shift();
    return deps.exitCode ?? 0;
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(
    "/api",
    claudeCodeUpdateRoutes({
      readInstalled: async () => installed[0] ?? null,
      fetchLatest: deps.fetchLatest ?? (async () => (deps.latest === undefined ? "2.1.300" : deps.latest)),
      runUpdate,
    }),
  );
  app.use(errorHandler);
  return { app, runUpdate };
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("claude code update routes", () => {
  it("rejects agents and non-admin board users", async () => {
    const { app, runUpdate } = createApp({ type: "agent", agentId: "a1" });
    expect((await request(app).get("/api/instance/claude-code-update-status")).status).toBe(403);
    const nonAdmin = createApp({ type: "board", source: "session", isInstanceAdmin: false });
    expect((await request(nonAdmin.app).post("/api/instance/claude-code-update")).status).toBe(403);
    expect(runUpdate).not.toHaveBeenCalled();
    expect(nonAdmin.runUpdate).not.toHaveBeenCalled();
  });

  it("reports a newer release", async () => {
    const res = await request(createApp(admin).app).get("/api/instance/claude-code-update-status");
    expect(res.body).toMatchObject({ installedVersion: "2.1.289", latestVersion: "2.1.300", updateAvailable: true, run: null });
  });

  it("shows nothing when up to date or when npm is unreachable", async () => {
    const upToDate = await request(createApp(admin, { latest: "2.1.289" }).app).get("/api/instance/claude-code-update-status");
    expect(upToDate.body.updateAvailable).toBe(false);

    const offline = createApp(admin, { fetchLatest: () => Promise.reject(new Error("ENOTFOUND")) });
    const res = await request(offline.app).get("/api/instance/claude-code-update-status");
    expect(res.status).toBe(200);
    expect(res.body.updateAvailable).toBe(false);
    expect((await request(offline.app).post("/api/instance/claude-code-update")).status).toBe(409);
    expect(offline.runUpdate).not.toHaveBeenCalled();
  });

  it("runs claude update on click and hides the banner after success", async () => {
    const { app, runUpdate } = createApp(admin, { installed: ["2.1.289", "2.1.300"] });
    const res = await request(app).post("/api/instance/claude-code-update");
    expect(res.status).toBe(202);
    expect(res.body.run).toMatchObject({ state: "running", fromVersion: "2.1.289" });
    await settle();
    expect(runUpdate).toHaveBeenCalledTimes(1);

    const after = await request(app).get("/api/instance/claude-code-update-status");
    expect(after.body).toMatchObject({ installedVersion: "2.1.300", updateAvailable: false });
    expect(after.body.run).toMatchObject({ state: "ok", toVersion: "2.1.300" });
    expect(after.body.run.log).toContain("Updating Claude Code");
  });

  it("keeps the banner with the log when the update fails", async () => {
    const { app } = createApp(admin, { exitCode: 1 });
    await request(app).post("/api/instance/claude-code-update");
    await settle();
    const res = await request(app).get("/api/instance/claude-code-update-status");
    expect(res.body).toMatchObject({ updateAvailable: true, run: { state: "failed" } });
  });

  it("fakes a newer release with simulateLatest until the next successful update", async () => {
    const { app, runUpdate } = createApp(admin, { latest: "2.1.289" });
    const fake = await request(app).get("/api/instance/claude-code-update-status?simulateLatest=2.1.999");
    expect(fake.body).toMatchObject({ latestVersion: "2.1.999", updateAvailable: true });

    expect((await request(app).post("/api/instance/claude-code-update")).status).toBe(202);
    await settle();
    expect(runUpdate).toHaveBeenCalledTimes(1);
    const after = await request(app).get("/api/instance/claude-code-update-status");
    expect(after.body).toMatchObject({ latestVersion: "2.1.289", updateAvailable: false, run: { state: "ok" } });
  });
});

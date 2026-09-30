import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawn = vi.hoisted(() => vi.fn());
const mockRequestInstanceRestart = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));
vi.mock("../routes/instance-restart.js", () => ({
  requestInstanceRestart: mockRequestInstanceRestart,
  isInstanceRestartPending: () => false,
}));

const { errorHandler } = await import("../middleware/index.js");
const { instanceUpdateRoutes, compareVersions, readUpdaterStatus } = await import("../routes/instance-update.js");

const admin = { type: "board", source: "session", isInstanceAdmin: true };

function createApp(actor: any, latest: string | null = "2026.1001.0") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(
    "/api",
    instanceUpdateRoutes({} as any, {
      currentVersion: "2026.916.1",
      fetchLatest: async () => latest,
      watch: false,
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("instance update routes", () => {
  let stateFile: string;

  beforeEach(() => {
    stateFile = path.join(mkdtempSync(path.join(tmpdir(), "pc-update-")), "update-state.json");
    process.env.PAPERCLIP_UPDATE_STATE_FILE = stateFile;
    process.env.PAPERCLIP_UPDATE_COMMAND = "updater.cmd";
    delete process.env.PAPERCLIP_UPDATE_SIMULATE_LATEST;
    mockSpawn.mockReset().mockReturnValue({ on: vi.fn(), unref: vi.fn() });
    mockRequestInstanceRestart.mockReset();
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_UPDATE_STATE_FILE;
    delete process.env.PAPERCLIP_UPDATE_COMMAND;
  });

  it("compares calendar versions numerically", () => {
    expect(compareVersions("2026.1001.0", "2026.916.1")).toBe(1);
    expect(compareVersions("2026.916.1", "2026.916.1")).toBe(0);
    expect(compareVersions("2026.916.0", "2026.916.1")).toBe(-1);
  });

  it("rejects agents and non-admin board users", async () => {
    expect((await request(createApp({ type: "agent", agentId: "a1" })).get("/api/instance/update-status")).status).toBe(403);
    expect(
      (await request(createApp({ type: "board", source: "session", isInstanceAdmin: false })).post("/api/instance/update"))
        .status,
    ).toBe(403);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("reports a newer npm version", async () => {
    const res = await request(createApp(admin)).get("/api/instance/update-status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      currentVersion: "2026.916.1",
      latestVersion: "2026.1001.0",
      updateAvailable: true,
      configured: true,
      updater: null,
    });
  });

  it("does not offer an update when npm has nothing newer", async () => {
    const res = await request(createApp(admin, "2026.916.1")).get("/api/instance/update-status");
    expect(res.body.updateAvailable).toBe(false);
    const post = await request(createApp(admin, "2026.916.1")).post("/api/instance/update").send({ targetVersion: "2026.916.1" });
    expect(post.status).toBe(409);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("starts the updater only on an explicit request for the latest version", async () => {
    const app = createApp(admin);
    const wrong = await request(app).post("/api/instance/update").send({ targetVersion: "2026.999.0" });
    expect(wrong.status).toBe(409);
    expect(mockSpawn).not.toHaveBeenCalled();

    const res = await request(app).post("/api/instance/update").send({ targetVersion: "2026.1001.0" });
    expect(res.status).toBe(202);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0]![1].env).toMatchObject({
      PAPERCLIP_UPDATE_TARGET_VERSION: "2026.1001.0",
      PAPERCLIP_UPDATE_FROM_VERSION: "2026.916.1",
    });
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({ state: "preparing", targetVersion: "2026.1001.0" });
    expect(mockRequestInstanceRestart).not.toHaveBeenCalled();

    const again = await request(app).post("/api/instance/update").send({ targetVersion: "2026.1001.0" });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("update_in_progress");
  });

  it("refuses when the updater is not configured", async () => {
    delete process.env.PAPERCLIP_UPDATE_COMMAND;
    const res = await request(createApp(admin)).post("/api/instance/update").send({ targetVersion: "2026.1001.0" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("update_not_configured");
  });

  it("surfaces a failed update and treats a stuck one as failed", async () => {
    writeFileSync(stateFile, JSON.stringify({ state: "failed", targetVersion: "2026.1001.0", message: "konflikt" }));
    const res = await request(createApp(admin)).get("/api/instance/update-status");
    expect(res.body.updater).toMatchObject({ state: "failed", message: "konflikt" });

    writeFileSync(stateFile, JSON.stringify({ state: "preparing", updatedAt: new Date(Date.now() - 3 * 3600_000).toISOString() }));
    expect(readUpdaterStatus(stateFile)?.state).toBe("failed");
  });
});

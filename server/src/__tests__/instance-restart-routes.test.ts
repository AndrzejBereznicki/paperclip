import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockWriteHotRestartIntent = vi.hoisted(() => vi.fn());
const mockRemoveHotRestartIntent = vi.hoisted(() => vi.fn());

vi.mock("../services/hot-restart.js", () => ({
  writeHotRestartIntent: mockWriteHotRestartIntent,
  removeHotRestartIntent: mockRemoveHotRestartIntent,
}));

const { errorHandler } = await import("../middleware/index.js");
const { instanceRestartRoutes } = await import("../routes/instance-restart.js");

const mockDb = {
  select: () => ({
    from: () => ({
      where: () => Promise.resolve([{ id: "run-1" }]),
    }),
  }),
};

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", instanceRestartRoutes(mockDb as any));
  app.use(errorHandler);
  return app;
}

describe("instance restart route", () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    mockWriteHotRestartIntent.mockReset().mockResolvedValue({ version: 1 });
    mockRemoveHotRestartIntent.mockReset().mockResolvedValue(undefined);
    const originalEmit = process.emit.bind(process) as (...args: unknown[]) => boolean;
    emitSpy = vi.spyOn(process, "emit").mockImplementation(((event: unknown, ...args: unknown[]) =>
      event === "SIGTERM" ? true : originalEmit(event, ...args)) as typeof process.emit);
  });

  afterEach(() => {
    emitSpy.mockRestore();
    vi.useRealTimers();
  });

  it("rejects agents", async () => {
    const res = await request(createApp({ type: "agent", agentId: "a1" })).post("/api/instance/restart");
    expect(res.status).toBe(403);
    expect(mockWriteHotRestartIntent).not.toHaveBeenCalled();
  });

  it("rejects board users who are not instance admins", async () => {
    const res = await request(createApp({ type: "board", source: "session", isInstanceAdmin: false }))
      .post("/api/instance/restart");
    expect(res.status).toBe(403);
    expect(mockWriteHotRestartIntent).not.toHaveBeenCalled();
  });

  it("does not shut down when the intent cannot be written", async () => {
    mockWriteHotRestartIntent.mockRejectedValueOnce(new Error("disk full"));
    const res = await request(createApp({ type: "board", source: "local_implicit" })).post("/api/instance/restart");
    expect(res.status).toBe(500);
    vi.runAllTimers();
    expect(emitSpy).not.toHaveBeenCalledWith("SIGTERM", "SIGTERM");
  });
  it("writes a hot-restart intent and shuts down through SIGTERM for instance admins", async () => {
    const app = createApp({ type: "board", source: "session", isInstanceAdmin: true });
    const res = await request(app).post("/api/instance/restart");
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "restart_requested", activeRunCount: 1 });
    expect(mockWriteHotRestartIntent).toHaveBeenCalledWith(
      expect.objectContaining({ previousServerPid: process.pid, preflightActiveRunIds: ["run-1"] }),
    );
    expect(emitSpy).not.toHaveBeenCalledWith("SIGTERM", "SIGTERM");
    vi.runAllTimers();
    expect(emitSpy).toHaveBeenCalledWith("SIGTERM", "SIGTERM");

    const second = await request(app).post("/api/instance/restart");
    expect(second.status).toBe(409);
  });

});

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { getServerInfoSnapshot } from "../server-info.js";
import { removeHotRestartIntent, writeHotRestartIntent } from "../services/hot-restart.js";
import { serverVersion } from "../version.js";

const SHUTDOWN_DELAY_MS = 500;

/**
 * Production counterpart of the dev-server "Restart now" flow: writes a
 * hot-restart intent (so live agent runs are adopted or drained and retried,
 * never lost) and then shuts this process down through the regular SIGTERM
 * path. Bringing the server back up is the job of an external supervisor.
 * PAPERCLIP_RESTART_RESPAWN_COMMAND, when set, is spawned detached right
 * before shutdown with PAPERCLIP_RESTART_PREVIOUS_PID so it can wait for this
 * process to exit and start the next one without waiting for a polling tick.
 */
export function instanceRestartRoutes(db: Db) {
  const router = Router();
  let restartPending = false;

  router.post("/instance/restart", async (req, res) => {
    if (req.actor.type !== "board") throw forbidden("Board access required");
    if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
      throw forbidden("Instance admin access required");
    }
    if (restartPending) {
      res.status(409).json({ error: "restart_already_requested" });
      return;
    }
    restartPending = true;

    const requestId = randomUUID();
    const preflightActiveRunIds = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"))
      .then((rows) => rows.map((row) => row.id));
    let intent: Awaited<ReturnType<typeof writeHotRestartIntent>>;
    try {
      intent = await writeHotRestartIntent({
        previousServerPid: process.pid,
        previousServerIdentity: getServerInfoSnapshot().processStartedAt,
        previousServerVersion: serverVersion,
        preflightActiveRunIds,
        recoveryRequestId: requestId,
      });
    } catch (error) {
      restartPending = false;
      logger.error({ err: error, requestId }, "failed to write hot-restart intent for instance restart");
      res.status(500).json({ error: "hot_restart_intent_failed" });
      return;
    }

    const respawnCommand = process.env.PAPERCLIP_RESTART_RESPAWN_COMMAND?.trim();
    if (respawnCommand) {
      try {
        const child = spawn(respawnCommand, {
          shell: true,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: { ...process.env, PAPERCLIP_RESTART_PREVIOUS_PID: String(process.pid) },
        });
        child.on("error", (err) => logger.error({ err, requestId }, "restart respawn command failed"));
        child.unref();
      } catch (error) {
        logger.error({ err: error, requestId }, "failed to spawn restart respawn command");
      }
    }

    logger.warn(
      { requestId, activeRunIds: preflightActiveRunIds, respawnCommand: respawnCommand ?? null },
      "instance restart requested by board; shutting down",
    );
    res.status(202).json({ status: "restart_requested", requestId, activeRunCount: preflightActiveRunIds.length });

    // process.kill(process.pid, "SIGTERM") hard-kills on Windows without
    // running handlers, so emit the signal event to reuse the graceful path.
    setTimeout(() => {
      try {
        process.emit("SIGTERM", "SIGTERM");
      } catch (error) {
        restartPending = false;
        logger.error({ err: error, requestId }, "instance restart shutdown failed");
        void removeHotRestartIntent(undefined, intent).catch(() => undefined);
      }
    }, SHUTDOWN_DELAY_MS);
  });

  return router;
}

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { issueService } from "../services/issues.js";
import { serverVersion } from "../version.js";
import { isInstanceRestartPending, requestInstanceRestart } from "./instance-restart.js";

const DIST_TAGS_URL = "https://registry.npmjs.org/-/package/paperclipai/dist-tags";
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const CHECK_RETRY_MS = 60 * 60_000;
const CHECK_TIMEOUT_MS = 10_000;
const WATCH_INTERVAL_MS = 5_000;
const STALE_ACTIVE_STATE_MS = 90 * 60_000;

export type UpdaterState = "preparing" | "ready_to_switch" | "switching" | "updated" | "failed" | "rolled_back";

export interface UpdaterStatus {
  state: UpdaterState;
  targetVersion?: string;
  fromVersion?: string;
  step?: string;
  message?: string;
  issue?: string;
  branch?: string;
  log?: string;
  updatedAt?: string;
}

const ACTIVE_STATES: UpdaterState[] = ["preparing", "ready_to_switch", "switching"];

/** Compares CalVer strings like 2026.916.1; prerelease suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/)[0]!.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

export function readUpdaterStatus(file: string | undefined, now = Date.now()): UpdaterStatus | null {
  if (!file) return null;
  let status: UpdaterStatus;
  try {
    status = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as UpdaterStatus;
  } catch {
    return null;
  }
  if (!status || typeof status.state !== "string") return null;
  const updatedAt = status.updatedAt ? Date.parse(status.updatedAt) : Number.NaN;
  if (ACTIVE_STATES.includes(status.state) && (Number.isNaN(updatedAt) || now - updatedAt > STALE_ACTIVE_STATE_MS)) {
    return { ...status, state: "failed", message: "Aktualizacja przerwana (brak postępu przez 90 min)." };
  }
  return status;
}

function writeUpdaterStatus(file: string, status: UpdaterStatus, keepUpdatedAt = false) {
  const updatedAt = keepUpdatedAt && status.updatedAt ? status.updatedAt : new Date().toISOString();
  writeFileSync(file, JSON.stringify({ ...status, updatedAt }, null, 2), "utf8");
}

/**
 * A failed or rolled-back update needs a human; the server files the task
 * itself (PAPERCLIP_UPDATE_ISSUE_* env) so the external scripts need no API
 * credentials. The idempotency key keeps one task per failure.
 */
export async function fileUpdateFailureIssue(db: Db, status: UpdaterStatus): Promise<string | null> {
  const companyId = process.env.PAPERCLIP_UPDATE_ISSUE_COMPANY_ID?.trim();
  if (!companyId) return null;
  const rolledBack = status.state === "rolled_back";
  const lines = [
    rolledBack
      ? `Nowa wersja ${status.targetVersion} nie wystartowała po podmianie — automatycznie przywrócono ${status.fromVersion}.`
      : `Automatyczna aktualizacja do ${status.targetVersion} zatrzymała się przed podmianą. Serwer działa dalej na ${status.fromVersion}.`,
    "",
    `- Powód: ${status.message ?? "brak opisu"}`,
    status.step ? `- Ostatni krok: ${status.step}` : null,
    status.branch ? `- Gałąź w forku: \`${status.branch}\`` : null,
    status.log ? `- Log: \`${status.log}\`` : null,
    "",
    "Do zrobienia: rozwiązać problem (np. konflikt przy przenoszeniu naszych zmian), zbudować i podmienić wersję — mechanizm opisany w EKS-277: Baner „Dostępna nowa wersja” z przyciskiem „Zaktualizuj”.",
  ].filter((line): line is string => line !== null);
  const issue = await issueService(db).create(companyId, {
    title: rolledBack
      ? `Aktualizacja Paperclip do ${status.targetVersion} nie wstała — wymaga ręcznej pracy`
      : `Aktualizacja Paperclip do ${status.targetVersion} wymaga ręcznej pracy`,
    description: lines.join("\n"),
    status: "todo",
    priority: "high",
    projectId: process.env.PAPERCLIP_UPDATE_ISSUE_PROJECT_ID?.trim() || null,
    assigneeAgentId: process.env.PAPERCLIP_UPDATE_ISSUE_ASSIGNEE_AGENT_ID?.trim() || null,
    idempotencyKey: `instance-update:${status.targetVersion}:${status.state}:${status.updatedAt}`,
  });
  return issue.identifier ?? issue.id;
}

type FetchLatest = () => Promise<string | null>;

async function fetchLatestFromNpm(): Promise<string | null> {
  const res = await fetch(DIST_TAGS_URL, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  if (!res.ok) return null;
  const tags = (await res.json()) as { latest?: unknown };
  return typeof tags.latest === "string" ? tags.latest : null;
}

/**
 * "New version available" flow for a self-hosted instance. The server only
 * checks npm once a day and, on an admin's click, spawns an external updater
 * (PAPERCLIP_UPDATE_COMMAND) that prepares the new build next to the running
 * one and reports progress through PAPERCLIP_UPDATE_STATE_FILE. When the
 * updater reports ready_to_switch, the server restarts itself through the
 * regular hot-restart path so the supervisor can swap builds while it is down.
 * Nothing is ever updated without the click.
 */
export function instanceUpdateRoutes(
  db: Db,
  opts: { fetchLatest?: FetchLatest; currentVersion?: string; watch?: boolean } = {},
) {
  const router = Router();
  const currentVersion = opts.currentVersion ?? serverVersion;
  const fetchLatest = opts.fetchLatest ?? fetchLatestFromNpm;
  const stateFile = () => process.env.PAPERCLIP_UPDATE_STATE_FILE?.trim() || undefined;
  const updateCommand = () => process.env.PAPERCLIP_UPDATE_COMMAND?.trim() || undefined;

  let latestVersion: string | null = null;
  let checkedAt: string | null = null;
  let nextCheckAt = 0;
  let inflight: Promise<void> | null = null;

  function checkLatest(): Promise<void> {
    const simulated = process.env.PAPERCLIP_UPDATE_SIMULATE_LATEST?.trim();
    if (simulated) {
      latestVersion = simulated;
      checkedAt = new Date().toISOString();
      return Promise.resolve();
    }
    if (Date.now() < nextCheckAt) return Promise.resolve();
    inflight ??= fetchLatest()
      .then((version) => {
        if (version) latestVersion = version;
        checkedAt = new Date().toISOString();
        nextCheckAt = Date.now() + (version ? CHECK_INTERVAL_MS : CHECK_RETRY_MS);
      })
      .catch((err) => {
        logger.warn({ err }, "npm version check failed");
        nextCheckAt = Date.now() + CHECK_RETRY_MS;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  function assertAdmin(req: Request) {
    if (req.actor.type !== "board") throw forbidden("Board access required");
    if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
      throw forbidden("Instance admin access required");
    }
  }

  function snapshot() {
    return {
      currentVersion,
      latestVersion,
      checkedAt,
      updateAvailable: latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false,
      configured: Boolean(updateCommand() && stateFile()),
      updater: readUpdaterStatus(stateFile()),
    };
  }

  router.get("/instance/update-status", async (req, res) => {
    assertAdmin(req);
    await checkLatest();
    res.json(snapshot());
  });

  router.post("/instance/update", async (req, res) => {
    assertAdmin(req);
    const command = updateCommand();
    const file = stateFile();
    if (!command || !file) {
      res.status(409).json({ error: "update_not_configured" });
      return;
    }
    await checkLatest();
    const status = snapshot();
    const targetVersion = typeof req.body?.targetVersion === "string" ? req.body.targetVersion : null;
    if (!status.updateAvailable || !latestVersion || targetVersion !== latestVersion) {
      res.status(409).json({ error: "no_update_available", latestVersion });
      return;
    }
    if (status.updater && ACTIVE_STATES.includes(status.updater.state)) {
      res.status(409).json({ error: "update_in_progress", updater: status.updater });
      return;
    }

    writeUpdaterStatus(file, {
      state: "preparing",
      targetVersion: latestVersion,
      fromVersion: currentVersion,
      step: "Uruchamiam aktualizację",
    });
    try {
      const child = spawn(command, {
        shell: true,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          PAPERCLIP_UPDATE_TARGET_VERSION: latestVersion,
          PAPERCLIP_UPDATE_FROM_VERSION: currentVersion,
        },
      });
      child.on("error", (err) => logger.error({ err }, "update command failed to start"));
      child.unref();
    } catch (err) {
      writeUpdaterStatus(file, {
        state: "failed",
        targetVersion: latestVersion,
        fromVersion: currentVersion,
        message: "Nie udało się uruchomić skryptu aktualizacji.",
      });
      logger.error({ err }, "failed to spawn update command");
      res.status(500).json({ error: "update_spawn_failed" });
      return;
    }
    logger.warn({ targetVersion: latestVersion, currentVersion }, "instance update requested by board");
    res.status(202).json({ status: "update_requested", targetVersion: latestVersion });
  });

  // The updater prepares the new build while this server keeps running and
  // flips the state to ready_to_switch; the swap needs this process gone.
  // Failures get a task so someone picks up the manual work.
  if (opts.watch !== false) {
    let filing = false;
    const timer = setInterval(() => {
      const file = stateFile();
      const status = readUpdaterStatus(file);
      if (!file || !status) return;
      if ((status.state === "failed" || status.state === "rolled_back") && !status.issue && !filing) {
        filing = true;
        void fileUpdateFailureIssue(db, status)
          .then((issue) => {
            if (issue) writeUpdaterStatus(file, { ...status, issue }, true);
          })
          .catch((err) => logger.error({ err }, "failed to file update failure issue"))
          .finally(() => {
            filing = false;
          });
        return;
      }
      if (status.state !== "ready_to_switch" || isInstanceRestartPending()) return;
      if (status.targetVersion && compareVersions(status.targetVersion, currentVersion) <= 0) return;
      logger.warn({ targetVersion: status.targetVersion }, "update prepared; restarting into the new build");
      void requestInstanceRestart(db, "instance_update");
    }, WATCH_INTERVAL_MS);
    timer.unref();
  }

  return router;
}

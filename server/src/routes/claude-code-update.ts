import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Router } from "express";
import { logger } from "../middleware/logger.js";
import { assertInstanceAdmin, compareVersions } from "./instance-update.js";

const DIST_TAGS_URL = "https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags";
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const CHECK_RETRY_MS = 60 * 60_000;
const CHECK_TIMEOUT_MS = 10_000;
const UPDATE_TIMEOUT_MS = 10 * 60_000;
const LOG_LIMIT = 8_000;

export interface ClaudeCodeUpdateRun {
  state: "running" | "ok" | "failed";
  fromVersion: string | null;
  toVersion?: string | null;
  log: string;
  startedAt: string;
  finishedAt?: string;
}

interface Deps {
  readInstalled: () => Promise<string | null>;
  fetchLatest: () => Promise<string | null>;
  runUpdate: (onOutput: (chunk: string) => void) => Promise<number>;
}

function claudeBin() {
  return process.env.PAPERCLIP_CLAUDE_BIN?.trim() || path.join(os.homedir(), ".local", "bin", "claude.exe");
}

function readInstalledClaude(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(claudeBin(), ["--version"], { timeout: 30_000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : (/\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null));
    });
  });
}

async function fetchLatestClaude(): Promise<string | null> {
  const res = await fetch(DIST_TAGS_URL, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  if (!res.ok) return null;
  const tags = (await res.json()) as { latest?: unknown };
  return typeof tags.latest === "string" ? tags.latest : null;
}

function runClaudeUpdate(onOutput: (chunk: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(claudeBin(), ["update"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      onOutput("\nPrzekroczono 10 min - przerywam.\n");
      child.kill();
    }, UPDATE_TIMEOUT_MS);
    child.stdout.on("data", (d) => onOutput(String(d)));
    child.stderr.on("data", (d) => onOutput(String(d)));
    child.on("error", (err) => {
      onOutput(`\n${err.message}\n`);
      clearTimeout(timer);
      resolve(-1);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

/**
 * "Claude Code update available" banner for the laptop the instance runs on.
 * Agents use the same claude.exe, so the update runs only on an admin's click.
 * `?simulateLatest=x.y.z` on the status route fakes a newer release until the
 * next successful update (manual testing without waiting for a real release).
 */
export function claudeCodeUpdateRoutes(opts: Partial<Deps> = {}) {
  const router = Router();
  const deps: Deps = {
    readInstalled: opts.readInstalled ?? readInstalledClaude,
    fetchLatest: opts.fetchLatest ?? fetchLatestClaude,
    runUpdate: opts.runUpdate ?? runClaudeUpdate,
  };

  let installedVersion: string | null = null;
  let latestVersion: string | null = null;
  let simulatedLatest: string | null = null;
  let nextCheckAt = 0;
  let inflight: Promise<void> | null = null;
  let run: ClaudeCodeUpdateRun | null = null;

  function check(): Promise<void> {
    if (Date.now() < nextCheckAt) return Promise.resolve();
    inflight ??= Promise.all([deps.readInstalled(), deps.fetchLatest().catch(() => null)])
      .then(([installed, latest]) => {
        installedVersion = installed;
        latestVersion = latest;
        nextCheckAt = Date.now() + (installed && latest ? CHECK_INTERVAL_MS : CHECK_RETRY_MS);
      })
      .catch((err) => {
        logger.warn({ err }, "claude code version check failed");
        nextCheckAt = Date.now() + CHECK_RETRY_MS;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  function snapshot() {
    const latest = simulatedLatest ?? latestVersion;
    return {
      installedVersion,
      latestVersion: latest,
      updateAvailable: Boolean(installedVersion && latest && compareVersions(latest, installedVersion) > 0),
      run,
    };
  }

  router.get("/instance/claude-code-update-status", async (req, res) => {
    assertInstanceAdmin(req);
    const simulate = typeof req.query.simulateLatest === "string" ? req.query.simulateLatest.trim() : "";
    if (/^\d+\.\d+\.\d+$/.test(simulate)) simulatedLatest = simulate;
    await check();
    res.json(snapshot());
  });

  router.post("/instance/claude-code-update", async (req, res) => {
    assertInstanceAdmin(req);
    if (run?.state === "running") {
      res.status(409).json({ error: "update_in_progress", run });
      return;
    }
    await check();
    if (!snapshot().updateAvailable) {
      res.status(409).json({ error: "no_update_available" });
      return;
    }

    const current: ClaudeCodeUpdateRun = {
      state: "running",
      fromVersion: installedVersion,
      log: "",
      startedAt: new Date().toISOString(),
    };
    run = current;
    logger.warn({ fromVersion: installedVersion }, "claude code update requested by board");
    void deps
      .runUpdate((chunk) => {
        current.log = (current.log + chunk).slice(-LOG_LIMIT);
      })
      .then(async (code) => {
        const version = await deps.readInstalled();
        if (version) installedVersion = version;
        current.toVersion = version;
        current.state = code === 0 ? "ok" : "failed";
        current.finishedAt = new Date().toISOString();
        if (code === 0) {
          simulatedLatest = null;
          nextCheckAt = 0;
        }
      });
    res.status(202).json({ status: "update_requested", run });
  });

  return router;
}

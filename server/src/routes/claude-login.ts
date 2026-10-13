import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { parseSetupTokenPrompt } from "@paperclipai/adapter-claude-local/server";
import { logger } from "../middleware/logger.js";
import { claudeBin } from "./claude-code-update.js";
import { assertInstanceAdmin } from "./instance-update.js";

const STATUS_INTERVAL_MS = 5 * 60_000;
const STATUS_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const CODE_SUBMIT_SETTLE_MS = 150;
const MAX_BUFFER_CHARS = 64 * 1024;
const NO_TTY_PREAMBLE_RE = /If the browser didn.t open, visit: */;

export interface ClaudeLoginStatus {
  loggedIn: boolean;
  email: string | null;
  subscriptionType: string | null;
  checkedAt: string;
}

export type ClaudeLoginState = "starting" | "pending_code" | "running" | "success" | "failed" | "timeout";

interface LoginRun {
  loginId: string;
  state: ClaudeLoginState;
  url: string | null;
  startedAt: string;
  finishedAt?: string;
  process: LoginProcess | null;
  timer?: ReturnType<typeof setTimeout>;
}

export interface LoginProcess {
  write(input: string): void;
  kill(): void;
  /** Resolves with the exit code when the child ends. */
  exited: Promise<number | null>;
}

interface Deps {
  readStatus: () => Promise<Omit<ClaudeLoginStatus, "checkedAt"> | null>;
  startLogin: (onData: (chunk: string) => void) => LoginProcess;
  promptTimeoutMs: number;
  loginTimeoutMs: number;
  codeSubmitSettleMs: number;
}

/**
 * `claude auth status --json`. A logged-out CLI exits 1 but still prints the
 * JSON, so stdout is parsed on error too.
 */
function readClaudeLoginStatus(): Promise<Omit<ClaudeLoginStatus, "checkedAt"> | null> {
  return new Promise((resolve) => {
    execFile(claudeBin(), ["auth", "status", "--json"], { timeout: STATUS_TIMEOUT_MS, windowsHide: true }, (_err, stdout) => {
      try {
        const parsed = JSON.parse(String(stdout)) as Record<string, unknown>;
        resolve({
          loggedIn: parsed.loggedIn === true,
          email: typeof parsed.email === "string" ? parsed.email : null,
          subscriptionType: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
        });
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * `claude auth login --claudeai` writes the same credentials file every agent
 * reads (unlike `claude setup-token`, which only prints a token). Without a TTY
 * it prints the manual sign-in URL plus "Paste code here if prompted" and reads
 * the code from stdin, so plain pipes are enough - no PTY needed.
 */
function spawnClaudeLogin(onData: (chunk: string) => void): LoginProcess {
  const child = spawn(claudeBin(), ["auth", "login", "--claudeai"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => onData(String(d)));
  child.stderr.on("data", (d) => onData(String(d)));
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code));
  });
  return {
    write: (input) => child.stdin.write(input),
    kill: () => child.kill(),
    exited,
  };
}

/**
 * "Claude logged out" banner + remote login from the phone. The sign-in URL is
 * not a secret and goes to the admin; the browser code goes only to the child's
 * stdin. Raw CLI output, the code and the token never reach a log or a response.
 */
export function claudeLoginRoutes(opts: Partial<Deps> = {}) {
  const router = Router();
  const deps: Deps = {
    readStatus: opts.readStatus ?? readClaudeLoginStatus,
    startLogin: opts.startLogin ?? spawnClaudeLogin,
    promptTimeoutMs: opts.promptTimeoutMs ?? PROMPT_TIMEOUT_MS,
    loginTimeoutMs: opts.loginTimeoutMs ?? LOGIN_TIMEOUT_MS,
    codeSubmitSettleMs: opts.codeSubmitSettleMs ?? CODE_SUBMIT_SETTLE_MS,
  };

  let status: ClaudeLoginStatus | null = null;
  let nextCheckAt = 0;
  let inflight: Promise<void> | null = null;
  let run: LoginRun | null = null;

  function check(force = false): Promise<void> {
    if (force) nextCheckAt = 0;
    if (Date.now() < nextCheckAt) return Promise.resolve();
    inflight ??= deps
      .readStatus()
      .then((next) => {
        // An unreadable CLI is reported as logged out only when it was never
        // readable; otherwise keep the last good answer.
        if (next) status = { ...next, checkedAt: new Date().toISOString() };
        else status ??= { loggedIn: false, email: null, subscriptionType: null, checkedAt: new Date().toISOString() };
        nextCheckAt = Date.now() + STATUS_INTERVAL_MS;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  function isActive(r: LoginRun | null) {
    return r?.state === "starting" || r?.state === "pending_code" || r?.state === "running";
  }

  function finish(r: LoginRun, state: ClaudeLoginState) {
    if (!isActive(r)) return;
    r.state = state;
    r.url = null;
    r.finishedAt = new Date().toISOString();
    if (r.timer) clearTimeout(r.timer);
    r.process?.kill();
    r.process = null;
    logger.info({ loginId: r.loginId, state }, "claude login finished");
  }

  function view(r: LoginRun) {
    return {
      loginId: r.loginId,
      state: r.state,
      url: r.state === "pending_code" ? r.url : null,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt ?? null,
    };
  }

  router.get("/instance/claude-login-status", async (req, res) => {
    assertInstanceAdmin(req);
    await check(req.query.refresh === "1");
    res.json(status);
  });

  router.post("/instance/claude-login/start", async (req, res) => {
    assertInstanceAdmin(req);
    if (isActive(run)) {
      res.status(409).json({ error: "login_in_progress", loginId: run!.loginId });
      return;
    }
    await check(true);
    if (status?.loggedIn) {
      res.status(409).json({ error: "already_logged_in" });
      return;
    }

    const current: LoginRun = {
      loginId: randomUUID(),
      state: "starting",
      url: null,
      startedAt: new Date().toISOString(),
      process: null,
    };
    run = current;
    logger.warn({ loginId: current.loginId }, "claude login requested by board");

    let buffer = "";
    let onPrompt: (() => void) | null = null;
    const promptSeen = new Promise<void>((resolve) => {
      onPrompt = resolve;
    });

    let proc: LoginProcess;
    try {
      proc = deps.startLogin((chunk) => {
        if (current.state !== "starting") return;
        buffer = (buffer + chunk).slice(-MAX_BUFFER_CHARS);
        // Without a TTY the CLI prints "...visit: <url>" on one line; the shared
        // parser anchors on the TTY wording with the URL on its own line.
        const prompt = parseSetupTokenPrompt(buffer.replace(NO_TTY_PREAMBLE_RE, "Use the url below to sign in\n"));
        if (!prompt) return;
        buffer = "";
        current.url = prompt.url;
        current.state = "pending_code";
        onPrompt?.();
      });
    } catch {
      finish(current, "failed");
      res.status(502).json({ error: "login_start_failed", ...view(current) });
      return;
    }
    current.process = proc;
    current.timer = setTimeout(() => finish(current, "timeout"), deps.loginTimeoutMs);
    void proc.exited.then(async (code) => {
      if (!isActive(current)) return;
      current.process = null;
      if (code !== 0) {
        finish(current, "failed");
        return;
      }
      await check(true);
      finish(current, status?.loggedIn ? "success" : "failed");
    });

    const promptTimer = new Promise<void>((resolve) => setTimeout(resolve, deps.promptTimeoutMs));
    await Promise.race([promptSeen, promptTimer, proc.exited]);
    if (current.state !== "pending_code") {
      finish(current, "failed");
      res.status(502).json({ error: "login_prompt_not_found", ...view(current) });
      return;
    }
    res.status(201).json(view(current));
  });

  router.post("/instance/claude-login/:loginId/code", async (req, res) => {
    assertInstanceAdmin(req);
    const current = run?.loginId === req.params.loginId ? run : null;
    if (!current) {
      res.status(404).json({ error: "login_not_found" });
      return;
    }
    if (current.state !== "pending_code" || !current.process) {
      res.status(409).json({ error: "login_not_waiting_for_code", ...view(current) });
      return;
    }
    // `browserCode` is on the log redaction list; never rename it to `code`.
    const raw = (req.body as { browserCode?: unknown } | undefined)?.browserCode;
    const code = typeof raw === "string" ? raw.trim() : "";
    if (!code || code.length > 2048 || /[\s\x00-\x1f\x7f]/.test(code)) {
      res.status(400).json({ error: "invalid_browser_code" });
      return;
    }
    const proc = current.process;
    current.state = "running";
    try {
      proc.write(code);
      await new Promise((resolve) => setTimeout(resolve, deps.codeSubmitSettleMs));
      proc.write("\r");
    } catch {
      finish(current, "failed");
    }
    res.status(202).json(view(current));
  });

  router.get("/instance/claude-login/:loginId", (req, res) => {
    assertInstanceAdmin(req);
    if (run?.loginId !== req.params.loginId) {
      res.status(404).json({ error: "login_not_found" });
      return;
    }
    res.json(view(run));
  });

  return router;
}

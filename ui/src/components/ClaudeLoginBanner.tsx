import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, Loader2, LogIn, ShieldAlert } from "lucide-react";
import { ApiError, api } from "@/api/client";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export interface ClaudeLoginStatus {
  loggedIn: boolean;
  email: string | null;
  subscriptionType: string | null;
  checkedAt: string;
}

export interface ClaudeLoginRun {
  loginId: string;
  state: "starting" | "pending_code" | "running" | "success" | "failed" | "timeout";
  url: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const STATUS_KEY = ["instance", "claude-login-status"] as const;

const ERROR_TEXT: Record<string, string> = {
  login_prompt_not_found: "Claude nie podał linku logowania. Spróbuj ponownie za chwilę.",
  login_start_failed: "Nie udało się uruchomić logowania Claude na serwerze.",
  invalid_browser_code: "To nie wygląda na kod logowania — skopiuj go jeszcze raz w całości.",
  login_not_waiting_for_code: "To logowanie już nie czeka na kod. Zacznij od nowa.",
  login_not_found: "To logowanie wygasło. Zacznij od nowa.",
};

function errorText(err: unknown) {
  if (err instanceof ApiError && ERROR_TEXT[err.message]) return ERROR_TEXT[err.message];
  return "Coś poszło nie tak. Spróbuj ponownie.";
}

/**
 * "Claude logged out" banner + remote login (works in the phone PWA). The
 * browser code lives only in the input's state and goes straight to the API;
 * it is never logged or persisted.
 */
export function ClaudeLoginBanner() {
  const queryClient = useQueryClient();
  const [loginId, setLoginId] = useState<string | null>(null);
  const [browserCode, setBrowserCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: status } = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => api.get<ClaudeLoginStatus>("/instance/claude-login-status"),
    retry: false,
    refetchInterval: 5 * 60_000,
  });

  const { data: run } = useQuery({
    queryKey: ["instance", "claude-login", loginId],
    queryFn: () => api.get<ClaudeLoginRun>(`/instance/claude-login/${loginId}`),
    enabled: loginId !== null,
    retry: false,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      if (state === "running") return 2_000;
      if (state === "pending_code") return 10_000;
      return false;
    },
  });

  async function refreshStatus() {
    const fresh = await api.get<ClaudeLoginStatus>("/instance/claude-login-status?refresh=1");
    queryClient.setQueryData(STATUS_KEY, fresh);
  }

  async function startLogin() {
    setError(null);
    setBusy(true);
    try {
      const started = await api.post<ClaudeLoginRun>("/instance/claude-login/start", {});
      queryClient.setQueryData(["instance", "claude-login", started.loginId], started);
      setLoginId(started.loginId);
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { loginId?: string } | null) : null;
      if (err instanceof ApiError && err.message === "already_logged_in") {
        await refreshStatus().catch(() => undefined);
      } else if (err instanceof ApiError && err.message === "login_in_progress" && body?.loginId) {
        setLoginId(body.loginId);
      } else {
        setError(errorText(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    if (!loginId || !browserCode.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const next = await api.post<ClaudeLoginRun>(`/instance/claude-login/${loginId}/code`, {
        browserCode: browserCode.trim(),
      });
      setBrowserCode("");
      queryClient.setQueryData(["instance", "claude-login", loginId], next);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const state = run?.state;
  const done = state === "success";
  const ended = state === "failed" || state === "timeout";

  useEffect(() => {
    if (done) void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
  }, [done, queryClient]);

  if (!status || status.loggedIn) return null;

  let panel: ReactNode = null;
  if (state === "starting" || (busy && !run)) {
    panel = <p className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Przygotowuję link logowania…</p>;
  } else if (state === "pending_code" && run?.url) {
    panel = (
      <div className="flex flex-col gap-2">
        <p>
          1. Otwórz link i zaloguj się kontem Claude:{" "}
          <a
            href={run.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium underline"
          >
            Otwórz logowanie Claude <ExternalLink className="size-3.5" />
          </a>
        </p>
        <p>2. Skopiuj kod, który pokaże strona, i wklej go tutaj:</p>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submitCode();
          }}
        >
          <Input
            value={browserCode}
            onChange={(e) => setBrowserCode(e.target.value)}
            placeholder="Wklej kod"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-background"
            aria-label="Kod logowania Claude"
          />
          <Button type="submit" size="sm" disabled={busy || !browserCode.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Wyślij kod
          </Button>
        </form>
      </div>
    );
  } else if (state === "running") {
    panel = <p className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Sprawdzam kod i loguję Claude…</p>;
  } else if (done) {
    panel = <p className="flex items-center gap-2"><CheckCircle2 className="size-4" /> Zalogowano. Agenci wracają do pracy.</p>;
  } else if (ended) {
    panel = (
      <p>
        {state === "timeout"
          ? "Logowanie wygasło (5 min bez kodu). Kliknij „Zaloguj” jeszcze raz."
          : "Logowanie się nie udało — kod mógł być błędny albo wygasł. Kliknij „Zaloguj” jeszcze raz."}
      </p>
    );
  }

  const showLoginButton = !run || ended;

  return (
    <div
      className="border-b border-red-300/60 bg-red-50 text-red-950 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-100"
      data-testid="claude-login-banner"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm">
        <ShieldAlert className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 break-words">Claude wylogowany — agenci nie działają</span>
        {showLoginButton && (
          <Button size="sm" disabled={busy} onClick={() => void startLogin()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
            Zaloguj
          </Button>
        )}
      </div>
      {(panel || error) && (
        <div className="flex flex-col gap-2 px-3 pb-3 text-sm">
          {panel}
          {error && <p className="text-destructive">{error}</p>}
        </div>
      )}
    </div>
  );
}

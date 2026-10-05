import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpCircle, Loader2 } from "lucide-react";
import { api } from "@/api/client";
import { Button } from "./ui/button";

export interface ClaudeCodeUpdateStatus {
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  run: {
    state: "running" | "ok" | "failed";
    fromVersion: string | null;
    toVersion?: string | null;
    log: string;
  } | null;
}

const QUERY_KEY = ["instance", "claude-code-update-status"] as const;

export function ClaudeCodeUpdateBanner() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.get<ClaudeCodeUpdateStatus>("/instance/claude-code-update-status"),
    retry: false,
    refetchInterval: (query) => (query.state.data?.run?.state === "running" ? 3_000 : 10 * 60_000),
  });

  async function startUpdate() {
    if (
      !window.confirm(
        `Zaktualizować Claude Code do ${data?.latestVersion}? Trwa to zwykle 1–2 min. Agenci w trakcie pracy dokończą ją na obecnej wersji, kolejne uruchomienia wezmą nową.`,
      )
    ) {
      return;
    }
    setError(null);
    setRequesting(true);
    try {
      await api.post("/instance/claude-code-update", {});
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nie udało się uruchomić aktualizacji.");
    } finally {
      setRequesting(false);
    }
  }

  if (!data) return null;
  const running = data.run?.state === "running";
  if (!running && !data.updateAvailable) return null;
  const failed = data.run?.state === "failed";
  const lastLogLine = data.run?.log.trim().split("\n").pop();

  const toneClass = failed
    ? "border-red-300/60 bg-red-50 text-red-950 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-100"
    : running
      ? "border-sky-300/60 bg-sky-50 text-sky-950 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-100"
      : "border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100";

  let icon = <ArrowUpCircle className="h-4 w-4 shrink-0" />;
  let text = `Dostępna aktualizacja Claude Code: ${data.installedVersion} → ${data.latestVersion}`;
  if (running) {
    icon = <Loader2 className="h-4 w-4 shrink-0 animate-spin" />;
    text = `Aktualizuję Claude Code do ${data.latestVersion}…${lastLogLine ? ` ${lastLogLine}` : ""}`;
  } else if (failed) {
    icon = <AlertTriangle className="h-4 w-4 shrink-0" />;
    text = `Aktualizacja Claude Code nie powiodła się${lastLogLine ? `: ${lastLogLine}` : "."} Działa dotychczasowa wersja ${data.installedVersion}.`;
  }

  return (
    <div className={`border-b ${toneClass}`} data-testid="claude-code-update-banner">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm">
        {icon}
        <span className="min-w-0 flex-1 break-words">{text}</span>
        {error && <span className="text-destructive">{error}</span>}
        {!running && (
          <Button size="sm" disabled={requesting} onClick={() => void startUpdate()}>
            {requesting ? <Loader2 className="size-4 animate-spin" /> : <ArrowUpCircle className="size-4" />}
            {failed ? "Spróbuj ponownie" : "Zaktualizuj"}
          </Button>
        )}
      </div>
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import type { QuotaWindow } from "@paperclipai/shared";
import { costsApi } from "@/api/costs";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

interface ClaudeUsageIndicatorProps {
  companyId: string | null | undefined;
  /** Collapsed rail: the indicator is hidden so the narrow rail stays uncluttered. */
  rail?: boolean;
}

// Canonical window labels emitted by the claude-local adapter (see
// packages/adapters/claude-local/src/server/quota.ts).
const SESSION_LABEL = "currentsession";
const WEEK_LABEL = "currentweekallmodels";

function normalizeLabel(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function fillClass(usedPercent: number | null): string {
  if (usedPercent == null) return "bg-zinc-500";
  if (usedPercent >= 90) return "bg-(--status-task-blocked)";
  if (usedPercent >= 70) return "bg-(--status-task-todo)";
  return "bg-primary/70";
}

function resetText(window: QuotaWindow): string | null {
  if (!window.resetsAt) return null;
  const date = new Date(window.resetsAt);
  if (Number.isNaN(date.getTime())) return null;
  return `Resets ${date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function UsageBar({ title, window }: { title: string; window: QuotaWindow }) {
  const width = Math.min(100, Math.max(0, window.usedPercent ?? 0));
  const reset = resetText(window);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-(length:--text-nano) font-medium text-muted-foreground">{title}</span>
        <span className="text-(length:--text-nano) font-semibold tabular-nums text-foreground">
          {window.usedPercent == null ? "—" : `${window.usedPercent}%`}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden bg-muted">
        <div
          className={cn("h-full transition-(--tp-width) duration-200", fillClass(window.usedPercent))}
          style={{ width: `${width}%` }}
        />
      </div>
      {reset ? (
        <div className="mt-0.5 text-(length:--text-nano) text-muted-foreground/80">{reset}</div>
      ) : null}
    </div>
  );
}

/**
 * Compact, always-visible Claude/Anthropic usage meter for the sidebar footer:
 * one bar for the rolling 5h session window and one for the weekly window.
 * Reuses the shared quota-windows endpoint (same query key as the Costs page,
 * so the two dedupe). Renders nothing when quota data is unavailable — the
 * Costs page remains the place where fetch errors are surfaced.
 */
export function ClaudeUsageIndicator({ companyId, rail = false }: ClaudeUsageIndicatorProps) {
  const { data } = useQuery({
    queryKey: queryKeys.usageQuotaWindows(companyId ?? "__none__"),
    queryFn: () => costsApi.quotaWindows(companyId as string),
    enabled: !!companyId && !rail,
    refetchInterval: 300_000,
    staleTime: 60_000,
    retry: false,
  });

  if (rail || !companyId) return null;

  const anthropic = (data ?? []).find((result) => result.provider === "anthropic");
  if (!anthropic || !anthropic.ok || anthropic.windows.length === 0) return null;

  const session = anthropic.windows.find((w) => normalizeLabel(w.label) === SESSION_LABEL) ?? null;
  const week = anthropic.windows.find((w) => normalizeLabel(w.label) === WEEK_LABEL) ?? null;
  if (!session && !week) return null;

  return (
    <div data-testid="claude-usage-indicator" className="shrink-0 border-t border-border px-4 py-3">
      <div className="mb-2 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
        Claude limits
      </div>
      <div className="space-y-2.5">
        {session ? <UsageBar title="Session · 5h" window={session} /> : null}
        {week ? <UsageBar title="Week" window={week} /> : null}
      </div>
    </div>
  );
}

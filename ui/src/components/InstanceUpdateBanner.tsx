import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpCircle, CheckCircle2, Loader2, X } from "lucide-react";
import { api } from "@/api/client";
import { Button } from "./ui/button";

type UpdaterState = "preparing" | "ready_to_switch" | "switching" | "updated" | "failed" | "rolled_back";

export interface InstanceUpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  configured: boolean;
  updater: {
    state: UpdaterState;
    targetVersion?: string;
    step?: string;
    message?: string;
    issue?: string;
    updatedAt?: string;
  } | null;
}

const QUERY_KEY = ["instance", "update-status"] as const;
const ACTIVE: UpdaterState[] = ["preparing", "ready_to_switch", "switching"];
const DISMISS_KEY = "paperclip.instanceUpdateBanner.dismissed";
const SUCCESS_VISIBLE_MS = 24 * 60 * 60_000;

function readDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

export function InstanceUpdateBanner() {
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const loadedVersion = useRef<string | null>(null);

  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.get<InstanceUpdateStatus>("/instance/update-status"),
    retry: false,
    refetchInterval: (query) => {
      const state = query.state.data?.updater?.state;
      return state && ACTIVE.includes(state) ? 5_000 : 10 * 60_000;
    },
  });

  // The server restarts into the new build; once it reports the new version
  // the UI assets changed too, so reload to pick them up.
  useEffect(() => {
    if (!data) return;
    loadedVersion.current ??= data.currentVersion;
    if (data.currentVersion !== loadedVersion.current) window.location.reload();
  }, [data]);

  if (!data?.configured) return null;
  const updater = data.updater;
  const dismissToken = `${updater?.state}:${updater?.targetVersion}:${updater?.updatedAt}`;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, dismissToken);
    } catch {
      // private mode: dismiss for this session only
    }
    setDismissed(dismissToken);
  };

  async function startUpdate() {
    if (!data?.latestVersion) return;
    if (
      !window.confirm(
        `Zaktualizować Paperclip do ${data.latestVersion}? Nowa wersja zbuduje się w tle razem z naszymi zmianami (kilka–kilkanaście minut), potem serwer zrestartuje się na ok. 1–2 min. Jeśli coś pójdzie nie tak, zostaje obecna wersja.`,
      )
    ) {
      return;
    }
    setError(null);
    setRequesting(true);
    try {
      await api.post("/instance/update", { targetVersion: data.latestVersion });
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nie udało się uruchomić aktualizacji.");
    } finally {
      setRequesting(false);
    }
  }

  const updateButton = (label: string) => (
    <Button size="sm" disabled={requesting} onClick={() => void startUpdate()}>
      {requesting ? <Loader2 className="size-4 animate-spin" /> : <ArrowUpCircle className="size-4" />}
      {label}
    </Button>
  );

  let tone: "info" | "warn" | "error" | "ok";
  let icon = <ArrowUpCircle className="h-4 w-4 shrink-0" />;
  let text: string;
  let action: ReactNode = null;
  let dismissible = false;

  if (updater && ACTIVE.includes(updater.state)) {
    tone = "info";
    icon = <Loader2 className="h-4 w-4 shrink-0 animate-spin" />;
    text =
      updater.state === "preparing"
        ? `Aktualizacja Paperclip do ${updater.targetVersion}: ${updater.step ?? "przygotowuję"}…`
        : `Przełączam Paperclip na ${updater.targetVersion} — serwer wróci za ok. 1–2 min, strona odświeży się sama.`;
  } else if (updater && (updater.state === "failed" || updater.state === "rolled_back") && dismissed !== dismissToken) {
    tone = "error";
    icon = <AlertTriangle className="h-4 w-4 shrink-0" />;
    text = `Aktualizacja Paperclip do ${updater.targetVersion} wymaga ręcznej pracy. ${updater.message ?? ""}${
      updater.issue ? ` Zadanie: ${updater.issue}.` : ""
    } Działa dotychczasowa wersja ${data.currentVersion}.`;
    dismissible = true;
  } else if (
    updater?.state === "updated" &&
    updater.targetVersion === data.currentVersion &&
    Date.now() - Date.parse(updater.updatedAt ?? "") < SUCCESS_VISIBLE_MS &&
    dismissed !== dismissToken
  ) {
    tone = "ok";
    icon = <CheckCircle2 className="h-4 w-4 shrink-0" />;
    text = `Zaktualizowano Paperclip do ${data.currentVersion}.`;
    dismissible = true;
  } else if (data.updateAvailable && data.latestVersion) {
    tone = "warn";
    text = `Dostępna nowa wersja Paperclip: ${data.latestVersion} (masz ${data.currentVersion}).`;
    action = updateButton("Zaktualizuj");
  } else {
    return null;
  }

  const toneClass = {
    info: "border-sky-300/60 bg-sky-50 text-sky-950 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-100",
    warn: "border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100",
    error: "border-red-300/60 bg-red-50 text-red-950 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-100",
    ok: "border-emerald-300/60 bg-emerald-50 text-emerald-950 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-100",
  }[tone];

  return (
    <div className={`border-b ${toneClass}`} data-testid="instance-update-banner">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm">
        {icon}
        <span className="min-w-0 flex-1">{text}</span>
        {error && <span className="text-destructive">{error}</span>}
        {action}
        {dismissible && (
          <button type="button" aria-label="Zamknij" className="opacity-70 hover:opacity-100" onClick={dismiss}>
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

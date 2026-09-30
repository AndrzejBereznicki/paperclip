import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { api } from "@/api/client";
import { Button } from "./ui/button";
import type { InstanceUpdateStatus } from "./InstanceUpdateBanner";

const POLL_INTERVAL_MS = 2_000;
const GIVE_UP_AFTER_MS = 6 * 60_000;

type Phase = "idle" | "requesting" | "waiting_down" | "waiting_up" | "timed_out" | "error";

async function isServerUp() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function InstanceRestartSection() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  // Same query key as InstanceUpdateBanner, so both share one request.
  const { data: versionInfo } = useQuery({
    queryKey: ["instance", "update-status"],
    queryFn: () => api.get<InstanceUpdateStatus>("/instance/update-status"),
    retry: false,
  });

  async function restart() {
    if (!window.confirm("Uruchomić serwer Paperclip ponownie? Serwer wróci za ~30 s, zadania w toku zostaną przejęte albo wznowione.")) {
      return;
    }
    setError(null);
    setPhase("requesting");
    try {
      await api.post("/instance/restart", {});
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "Nie udało się zlecić restartu.");
      return;
    }

    const deadline = Date.now() + GIVE_UP_AFTER_MS;
    setPhase("waiting_down");
    while (Date.now() < deadline && (await isServerUp())) await sleep(POLL_INTERVAL_MS);
    setPhase("waiting_up");
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      if (await isServerUp()) {
        window.location.reload();
        return;
      }
    }
    setPhase("timed_out");
  }

  const busy = phase === "requesting" || phase === "waiting_down" || phase === "waiting_up";
  const status =
    phase === "waiting_down" ? "Zamykanie serwera…"
    : phase === "waiting_up" ? "Serwer uruchamia się ponownie — strona odświeży się sama."
    : phase === "timed_out" ? "Serwer nie wrócił w ciągu 6 min. Sprawdź laptopa (watchdog Paperclip)."
    : null;

  return (
    <section>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <h2 className="text-sm font-semibold">Uruchom ponownie serwer</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Bezpiecznie zamyka serwer; watchdog podnosi go z powrotem (~30 s). Zadania agentów w toku nie giną.
          </p>
          {versionInfo?.currentVersion && (
            <p className="text-sm">
              Wersja: <span className="font-mono">{versionInfo.currentVersion}</span>
            </p>
          )}
          {status &&<p className="text-sm text-muted-foreground">{status}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void restart()}>
          <RotateCw className={busy ? "size-4 animate-spin" : "size-4"} />
          {busy ? "Restart…" : "Uruchom ponownie"}
        </Button>
      </div>
    </section>
  );
}

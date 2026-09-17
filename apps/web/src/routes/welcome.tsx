/**
 * `/welcome` — what the app shows when no server resolved at boot. Reports
 * which channel `resolveConnection` found (Electron preload, the dev endpoint,
 * or `?server=&token=` params) and the live connection state, so "am I
 * connected and to what" is one glance.
 */

import { Link, createFileRoute } from "@tanstack/react-router";

import { buttonVariants } from "@OpenAde/ui/components/button";

import { Icon } from "@/lib/icon";
import { cn } from "@/lib/utils";
import { getResolvedConnection } from "@/state/app-runtime";
import { useConnectionState } from "@/state/hooks";

export const Route = createFileRoute("/welcome")({
  component: WelcomePage,
});

const maskToken = (token: string): string =>
  token.length <= 8 ? "••••" : `${token.slice(0, 4)}…${token.slice(-4)}`;

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 type-body text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-mono text-xs text-foreground">{value}</dd>
    </div>
  );
}

function WelcomePage() {
  const connection = useConnectionState();
  const resolved = getResolvedConnection();

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background px-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-xl bg-hover">
            <Icon icon="hugeicons:asterisk" className="size-5 text-foreground" />
          </span>
          <div>
            <h1 className="text-base font-semibold text-foreground">OpenAde</h1>
            <p className="type-micro text-muted-foreground">Connection details</p>
          </div>
        </div>

        <dl className="flex flex-col gap-2 rounded-xl bg-muted p-3">
          <DetailRow label="Status" value={connection.status} />
          <DetailRow label="Server" value={resolved?.url ?? "none resolved"} />
          <DetailRow label="Token" value={resolved === null ? "—" : maskToken(resolved.token)} />
          <DetailRow label="Instance" value={connection.serverInstanceId ?? "—"} />
        </dl>

        {resolved === null ? (
          <p className="mt-4 type-body leading-relaxed text-muted-foreground">
            No connection channel answered at boot. Launch through the desktop app, run the dev
            server, or open{" "}
            <code className="rounded-sm bg-hover px-1 font-mono text-xs">
              ?server=ws://host:port&amp;token=…
            </code>
            .
          </p>
        ) : null}

        <div className="mt-5 flex justify-end">
          <Link to="/" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
            <Icon icon="hugeicons:arrow-left-01" />
            Back to the app
          </Link>
        </div>
      </div>
    </div>
  );
}

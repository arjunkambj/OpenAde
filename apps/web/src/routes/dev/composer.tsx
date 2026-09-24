/**
 * `/dev/composer` — the route entry for the composer fixture page.
 *
 * The page itself is loaded through a dynamic import guarded by
 * `import.meta.env.DEV`. A production build folds the guard to `false`, the
 * branch is dead code, and the fixture module — with the scripted client in
 * `@/lib/fixture-client` behind it — is never reached from an entry, so
 * nothing of it is emitted into the packaged app.
 */

import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";

export const Route = createFileRoute("/dev/composer")({ component: DevComposerRoute });

function DevComposerRoute() {
  const [Page, setPage] = React.useState<React.ComponentType | null>(null);

  React.useEffect(() => {
    let live = true;
    if (import.meta.env.DEV) {
      void import("@/components/dev/composer-fixture").then((module) => {
        if (live) {
          setPage(() => module.ComposerFixture);
        }
      });
    }
    return () => {
      live = false;
    };
  }, []);

  if (Page !== null) {
    return <Page />;
  }
  return (
    <p className="px-8 py-6 text-sm text-muted-foreground">
      {import.meta.env.DEV
        ? "Loading the composer fixture…"
        : "Fixture pages are not part of this build."}
    </p>
  );
}

/**
 * `/dev/changes` — the route entry for the changes-pane fixture page.
 *
 * Same shape as `/dev/timeline` and `/dev/composer`: the page body is behind a
 * dynamic import guarded by `import.meta.env.DEV`, so the fixture and the
 * snapshot JSON it decodes stay out of the packaged app. This route used to
 * import that JSON at module scope, which shipped a thread of fake ids in the
 * production bundle.
 */

import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";

export const Route = createFileRoute("/dev/changes")({ component: DevChangesRoute });

function DevChangesRoute() {
  const [Page, setPage] = React.useState<React.ComponentType | null>(null);

  React.useEffect(() => {
    let live = true;
    if (import.meta.env.DEV) {
      void import("@/components/dev/changes-fixture").then((module) => {
        if (live) {
          setPage(() => module.ChangesFixture);
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
    <p className="p-8 text-sm text-muted-foreground">
      {import.meta.env.DEV
        ? "Loading the changes fixture…"
        : "Fixture pages are not part of this build."}
    </p>
  );
}

/**
 * `/dev/timeline` — the route entry for the timeline fixture page.
 *
 * Same shape as `/dev/composer`: the page body is behind a dynamic import
 * guarded by `import.meta.env.DEV`, so the fixture and the snapshot JSON it
 * decodes stay out of the packaged app.
 */

import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";

export const Route = createFileRoute("/dev/timeline")({ component: DevTimelineRoute });

function DevTimelineRoute() {
  const [Page, setPage] = React.useState<React.ComponentType | null>(null);

  React.useEffect(() => {
    let live = true;
    if (import.meta.env.DEV) {
      void import("@/components/dev/timeline-fixture").then((module) => {
        if (live) {
          setPage(() => module.TimelineFixture);
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
        ? "Loading the timeline fixture…"
        : "Fixture pages are not part of this build."}
    </p>
  );
}

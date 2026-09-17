import { useAtomValue } from "@effect/atom-react";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";

import { StartThread } from "@/components/thread/start-thread";
import { useAppAtoms } from "@/lib/app-runtime";

export const Route = createFileRoute("/_home/")({
  component: HomePage,
});

function HomePage() {
  const atoms = useAppAtoms();
  const projects = useAtomValue(atoms.projectsAtom);
  // A fresh install has nothing to chat in — the welcome flow creates one.
  // `projectsAtom` is seeded with `[]`, so it reads as a successful empty list
  // from the first frame: without the `waiting` check every cold load bounced
  // to /welcome before `projects.list` had answered, projects or not.
  if (AsyncResult.isSuccess(projects) && !projects.waiting && projects.value.length === 0) {
    return <Navigate to="/welcome" />;
  }
  return <StartThread />;
}

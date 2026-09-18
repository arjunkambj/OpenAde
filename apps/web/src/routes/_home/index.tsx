import { useAtomValue } from "@effect/atom-react";
import { createFileRoute, Navigate } from "@tanstack/react-router";

import { shouldOfferFirstRun } from "@/components/welcome/first-run";
import { StartThread } from "@/components/thread/start-thread";
import { useAppAtoms } from "@/lib/app-runtime";

export const Route = createFileRoute("/_home/")({
  component: HomePage,
});

function HomePage() {
  const atoms = useAppAtoms();
  const projects = useAtomValue(atoms.projectsAtom);
  // A fresh install has nothing to chat in — the welcome flow creates one.
  // `shouldOfferFirstRun` carries the rule and why it is not `waiting`.
  if (shouldOfferFirstRun(projects)) {
    return <Navigate to="/welcome" />;
  }
  return <StartThread />;
}

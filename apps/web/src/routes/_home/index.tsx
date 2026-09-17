import { useAtomValue } from "@effect/atom-react";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";

import { ChatWorkspace } from "@/components/Chat/chat-workspace";
import { useAppAtoms } from "@/lib/app-runtime";

export const Route = createFileRoute("/_home/")({
  component: HomePage,
});

function HomePage() {
  const atoms = useAppAtoms();
  const projects = useAtomValue(atoms.projectsAtom);
  // A fresh install has nothing to chat in — the welcome flow creates one.
  if (AsyncResult.isSuccess(projects) && projects.value.length === 0) {
    return <Navigate to="/welcome" />;
  }
  return <ChatWorkspace />;
}

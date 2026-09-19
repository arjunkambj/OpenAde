import { createFileRoute, redirect } from "@tanstack/react-router";

// Skills is the tab the sidebar's Customize entry opens on.
export const Route = createFileRoute("/_home/customize/")({
  beforeLoad: () => {
    throw redirect({ to: "/customize/skills", replace: true });
  },
});

/**
 * `/settings/$section` — one page per settings section. Unknown sections
 * redirect to `general` rather than 404ing, so hand-edited URLs still land
 * somewhere useful.
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

import { ThemeCards } from "@/components/Settings/theme-cards";

const SECTIONS = ["general", "uses"] as const;
type SettingsSection = (typeof SECTIONS)[number];

const isSection = (value: string): value is SettingsSection =>
  (SECTIONS as ReadonlyArray<string>).includes(value);

export const Route = createFileRoute("/settings/$section")({
  beforeLoad: ({ params }) => {
    if (!isSection(params.section)) {
      throw redirect({
        to: "/settings/$section",
        params: { section: "general" },
        replace: true,
      });
    }
  },
  component: SettingsSectionPage,
});

function SettingsSectionPage() {
  const { section } = Route.useParams();
  return (
    <div className="flex flex-1 flex-col px-8 py-10">
      {section === "general" ? <ThemeCards /> : null}
      {section === "uses" ? (
        <p className="type-body text-muted-foreground">
          Connector and model usage will be reported here.
        </p>
      ) : null}
    </div>
  );
}

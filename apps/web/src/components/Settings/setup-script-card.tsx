/**
 * One project's setup script on the Git & worktrees page. The textarea edits a
 * local draft, so the subscribed settings document cannot echo the saved
 * script over a half-typed one; Save hands the draft up, and the page builds
 * the record from the latest settings (`./git-settings`).
 */

import * as React from "react";

import { Button } from "@poseidon/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@poseidon/ui/components/card";
import { Label } from "@poseidon/ui/components/label";
import { Textarea } from "@poseidon/ui/components/textarea";
import type { ProjectSummary } from "@poseidon/contracts/orchestration";

export function SetupScriptCard({
  project,
  saved,
  disabled,
  onSave,
}: {
  readonly project: ProjectSummary;
  readonly saved: string;
  readonly disabled: boolean;
  /** Resolves true once the script is saved, false when it was not. */
  readonly onSave: (draft: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const id = `setup-script-${project.projectId}`;
  const changed = draft !== null && draft.trim() !== saved;

  const save = async () => {
    if (draft === null) {
      return;
    }
    setSaving(true);
    const ok = await onSave(draft);
    setSaving(false);
    if (ok) {
      setDraft(null);
    }
  };

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{project.name}</CardTitle>
        <CardDescription>{project.workspaceRoot}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2">
          <Label htmlFor={id}>Setup script</Label>
          <Textarea
            id={id}
            value={draft ?? saved}
            placeholder="pnpm install"
            spellCheck={false}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
      </CardContent>
      <CardFooter>
        <div className="ml-auto flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!changed || saving}
            onClick={() => setDraft(null)}
          >
            Discard
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={disabled || !changed || saving}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

/**
 * The start screen's project picker, in the composer's context slot: every
 * project by name, with its folder underneath in the list.
 */

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@OpenAde/ui/components/select";
import type { ProjectId } from "@OpenAde/contracts/ids";
import type { ProjectSummary } from "@OpenAde/contracts/orchestration";

import { Folder } from "@honeyicons/react";

export function ProjectPicker({
  projects,
  value,
  disabled,
  onPick,
}: {
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly value: ProjectId;
  readonly disabled?: boolean;
  readonly onPick: (projectId: ProjectId) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const project = projects.find((entry) => entry.projectId === next);
        if (project !== undefined) {
          onPick(project.projectId);
        }
      }}
      items={projects.map((project) => ({ value: project.projectId, label: project.name }))}
    >
      <SelectTrigger aria-label="Project" size="sm" variant="composer" className="min-w-0">
        <span className="flex min-w-0 items-center gap-1.5">
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className="min-w-56">
        <SelectGroup>
          {projects.map((project) => (
            <SelectItem key={project.projectId} value={project.projectId}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{project.name}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {project.workspaceRoot}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

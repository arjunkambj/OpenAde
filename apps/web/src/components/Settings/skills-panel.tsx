/**
 * The Skills page: the listing `cmdConfig.skills.list` reports for the chosen
 * project — user skills under the connector's user skills root, project skills
 * under the project's, project winning name collisions. Read-only here: a
 * skill's content lives in its file, and the path column is the way to it.
 */

import { useAtomValue } from "@effect/atom-react";
import { Card, CardContent } from "@OpenAde/ui/components/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@OpenAde/ui/components/select";
import type { ProjectId } from "@OpenAde/contracts/ids";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { useAppAtoms } from "@/lib/app-runtime";
import { Icon } from "@/lib/icon";

import { scopeLabel, USER_SCOPE } from "./select-label";

/** Same sentinel the MCP page uses — `null` means "user scope only". */

export function SkillsPanel() {
  const atoms = useAppAtoms();
  const projectsResult = useAtomValue(atoms.projectsAtom);
  const [projectId, setProjectId] = React.useState<ProjectId | null>(null);
  const skillsResult = useAtomValue(atoms.skillsAtom(projectId));

  const projects = AsyncResult.isSuccess(projectsResult) ? projectsResult.value : [];
  const skills = AsyncResult.isSuccess(skillsResult) ? skillsResult.value : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">Skills</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Skill files the connector can invoke. Project skills shadow user skills of the same
            name.
          </p>
        </div>
        <Select
          value={projectId ?? USER_SCOPE}
          onValueChange={(next) => setProjectId(next === USER_SCOPE ? null : (next as ProjectId))}
        >
          <SelectTrigger className="w-56">
            <SelectValue>{(value) => scopeLabel(value, projects)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={USER_SCOPE}>User scope</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.projectId} value={project.projectId}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card size="sm">
        <CardContent>
          <div className="flex flex-col divide-y divide-border/60">
            {skills === null ? (
              <p className="py-6 text-sm text-muted-foreground">Loading…</p>
            ) : skills.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">
                No skills found. Drop a <span className="font-mono">SKILL.md</span> into your user
                or project skills directory.
              </p>
            ) : (
              skills.map((skill) => (
                <div key={skill.path} className="flex items-center gap-3 py-3">
                  <Icon icon="hugeicons:magic-wand-01" className="text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{skill.name}</span>
                      {!skill.enabled ? (
                        <span className="text-xs text-muted-foreground">disabled</span>
                      ) : null}
                    </div>
                    {skill.description === undefined ? null : (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {skill.description}
                      </p>
                    )}
                  </div>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {skill.path}
                  </span>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

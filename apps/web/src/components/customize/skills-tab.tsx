/**
 * The Skills tab: one section per connector instance with a skills extension,
 * each listing what `connectors.skills.list` reports for the chosen scope —
 * user skills and the project's, the instance deciding which wins a name
 * collision. A skill's content lives in its file, and the path line is the
 * way to it.
 *
 * Under each instance's list, the skills in a shared folder it does not load
 * yet, when it offers one. Adding one links it into the instance's user
 * skills; nothing is copied, so the shared folder stays the source.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Button } from "@poseidon/ui/components/button";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import * as Exit from "effect/Exit";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import { toast } from "sonner";

import { describeExitError, useAppAtoms } from "@/lib/app-runtime";

import { CustomizeInstances } from "./customize-instances";
import { useCustomizeScope } from "./customize-layout";
import {
  CustomizeCard,
  CustomizeEmpty,
  CustomizeSearch,
  CustomizeSection,
  CustomizeTag,
  matchesQuery,
} from "./customize-list";
import { Add as AddIcon, Sparkles, Spinner } from "@honeyicons/react";

export function SkillsTab() {
  const [query, setQuery] = React.useState("");

  return (
    <div className="flex flex-col gap-8">
      <CustomizeSearch value={query} onChange={setQuery} placeholder="Search skills" />
      <CustomizeInstances kind="skills" empty="No enabled connector manages skills.">
        {(instance) => <InstanceSkills instanceId={instance.connectorInstanceId} query={query} />}
      </CustomizeInstances>
    </div>
  );
}

function InstanceSkills({
  instanceId,
  query,
}: {
  readonly instanceId: ConnectorInstanceId;
  readonly query: string;
}) {
  const atoms = useAppAtoms();
  const projectId = useCustomizeScope();
  const projectsResult = useAtomValue(atoms.projectsAtom);
  const skillsResult = useAtomValue(atoms.skillsAtom(instanceId)(projectId));
  const agentSkillsResult = useAtomValue(atoms.agentSkillsAtom(instanceId));
  const link = useAtomSet(atoms.skillsLinkAtom, { mode: "promiseExit" });
  const [linking, setLinking] = React.useState<string | null>(null);

  const skills = AsyncResult.isSuccess(skillsResult) ? skillsResult.value : null;
  const projectRoot = AsyncResult.isSuccess(projectsResult)
    ? projectsResult.value.find((project) => project.projectId === projectId)?.workspaceRoot
    : undefined;
  const shown =
    skills?.filter((skill) => matchesQuery(query, [skill.name, skill.description])) ?? null;
  const agentSkills = AsyncResult.isSuccess(agentSkillsResult) ? agentSkillsResult.value : [];
  const agentShown = agentSkills.filter((skill) =>
    matchesQuery(query, [skill.name, skill.description]),
  );

  const addSkill = async (entry: string) => {
    setLinking(entry);
    const exit = await link({ instanceId, entry, projectId });
    setLinking(null);
    if (!Exit.isSuccess(exit)) {
      toast.error(describeExitError(exit, "Could not add skill"));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <CustomizeSection title="Installed" count={skills?.length ?? null}>
        {shown === null ? (
          <CustomizeEmpty>Loading…</CustomizeEmpty>
        ) : skills?.length === 0 ? (
          <CustomizeEmpty>
            No skills found. Drop a <span className="font-mono">SKILL.md</span> into your user or
            project skills directory.
          </CustomizeEmpty>
        ) : shown.length === 0 ? (
          <CustomizeEmpty>No skills match “{query.trim()}”.</CustomizeEmpty>
        ) : (
          shown.map((skill) => (
            <CustomizeCard
              key={skill.path}
              icon={Sparkles}
              title={skill.name}
              muted={!skill.enabled}
              tags={
                <>
                  {skill.enabled ? null : <CustomizeTag>Disabled</CustomizeTag>}
                  <CustomizeTag>
                    {projectRoot !== undefined && skill.path.startsWith(`${projectRoot}/`)
                      ? "Project"
                      : "Global"}
                  </CustomizeTag>
                </>
              }
              description={skill.description}
              detail={skill.path}
            />
          ))
        )}
      </CustomizeSection>

      {/* Hidden when there is nothing to add: an empty shared folder is the
          common case, not a state worth a placeholder. */}
      {agentSkills.length === 0 ? null : (
        <CustomizeSection title="Available to add" count={agentSkills.length}>
          {agentShown.length === 0 ? (
            <CustomizeEmpty>No skills match “{query.trim()}”.</CustomizeEmpty>
          ) : (
            agentShown.map((skill) => (
              <CustomizeCard
                key={skill.entry}
                icon={Sparkles}
                title={skill.name}
                actions={
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={linking !== null}
                    onClick={() => void addSkill(skill.entry)}
                  >
                    {linking === skill.entry ? (
                      <Spinner variant="bold" />
                    ) : (
                      <AddIcon variant="bold" />
                    )}
                    Add
                  </Button>
                }
                description={skill.description}
                detail={skill.path}
              />
            ))
          )}
        </CustomizeSection>
      )}
    </div>
  );
}

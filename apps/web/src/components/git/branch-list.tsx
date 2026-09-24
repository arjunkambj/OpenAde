/**
 * The branch picker's popover body for a local thread: a search over the
 * workspace's branches in two groups, Local and Remote, and a
 * `Create branch "<query>"` item when the query names a branch that does not
 * exist yet. Filtering is `groupBranches` rather than cmdk's fuzzy match, so
 * what the list shows is what the tests pin.
 *
 * A branch checked out in another worktree cannot be switched to — git
 * refuses to check one branch out twice — so it is listed but disabled. A long
 * name is cut to the popover's width; the full name is in the tooltip.
 *
 * A query git would refuse as a name matches no branch and offers no create;
 * the empty line then says why (`branchNameProblem`) rather than only that
 * nothing matched.
 */

import * as React from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@OpenAde/ui/components/command";
import type { GitBranch, GitBranchList } from "@OpenAde/contracts/git";

import { Add, Cloud, GitBranch as GitBranchIcon, GitFork } from "@honeyicons/react";

import { branchNameProblem, branchToCreate, groupBranches } from "./branches";

function BranchItem({ branch, onSelect }: { branch: GitBranch; onSelect: (name: string) => void }) {
  const elsewhere = branch.worktreePath !== undefined;
  return (
    <CommandItem
      value={branch.name}
      data-checked={branch.isCurrent}
      disabled={elsewhere}
      title={
        elsewhere
          ? `${branch.name} — checked out in the worktree at ${branch.worktreePath}`
          : branch.name
      }
      onSelect={() => onSelect(branch.name)}
    >
      {branch.kind === "remote" ? (
        <Cloud variant="bold" />
      ) : elsewhere ? (
        <GitFork variant="bold" />
      ) : (
        <GitBranchIcon variant="bold" />
      )}
      <span className="min-w-0 truncate">{branch.name}</span>
    </CommandItem>
  );
}

export function BranchList({
  list,
  onSwitch,
  onCreate,
}: {
  list: GitBranchList;
  /** Called for a branch other than the current one. */
  onSwitch: (name: string) => void;
  onCreate: (name: string) => void;
}) {
  const [query, setQuery] = React.useState("");
  const groups = groupBranches(list, query);
  const toCreate = branchToCreate(list, query);
  const problem = branchNameProblem(query.trim());
  const select = (name: string) => {
    if (name !== list.current) {
      onSwitch(name);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Command shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search or create a branch…"
          aria-label="Search branches"
        />
        <CommandList>
          <CommandEmpty>
            {problem === null ? (
              "No branch matches."
            ) : (
              <span role="alert" className="text-destructive">
                “{query.trim()}” is not a valid branch name. {problem}
              </span>
            )}
          </CommandEmpty>
          {groups.local.length === 0 ? null : (
            <CommandGroup heading="Local">
              {groups.local.map((branch) => (
                <BranchItem key={branch.name} branch={branch} onSelect={select} />
              ))}
            </CommandGroup>
          )}
          {groups.remote.length === 0 ? null : (
            <CommandGroup heading="Remote">
              {groups.remote.map((branch) => (
                <BranchItem key={branch.name} branch={branch} onSelect={select} />
              ))}
            </CommandGroup>
          )}
          {toCreate === null ? null : (
            <CommandGroup>
              <CommandItem value={`create:${toCreate}`} onSelect={() => onCreate(toCreate)}>
                <Add variant="bold" />
                <span className="min-w-0 truncate">Create branch “{toCreate}”</span>
              </CommandItem>
            </CommandGroup>
          )}
        </CommandList>
      </Command>
      <p className="px-1 type-micro text-muted-foreground">
        Switching changes the branch for every local thread of this project. Uncommitted changes to
        tracked files block a switch; nothing is stashed for you.
      </p>
    </div>
  );
}

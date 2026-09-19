/**
 * The dock's Files tab — the workspace behind the thread, over `files.search`
 * and `files.read`.
 *
 * Search is the navigation. `files.search` matches on the whole path, so a
 * directory row drills in by searching its own prefix: one RPC does both
 * "find me the router" and "show me what is under apps/web/src". The listing
 * the server searches is ignore-aware for a git repository and an ignore-aware
 * filesystem walk for a plain folder, so a project that is not a repository
 * behaves the same here — there is no git state on this tab at all.
 *
 * Opening a row swaps the list for `FilePreview`; the breadcrumb goes back.
 * Everything else — loading, an empty query, no matches, a server error, an
 * offline socket — has its own honest block rather than an empty list.
 */

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { FileQuery } from "@OpenAde/client-runtime/fileAtoms";
import type { ProjectId } from "@OpenAde/contracts/ids";
import type { FileSearchResult } from "@OpenAde/contracts/rpc";
import { Button } from "@OpenAde/ui/components/button";
import { Input } from "@OpenAde/ui/components/input";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { Icon } from "@/lib/icon";
import { cn } from "@/lib/utils";

import { FilePreview } from "./file-preview";
import { useFileAtoms } from "./file-atoms";
import { PaneMessage } from "./pane-message";
import { splitPath } from "./preview";

/** The server's own ceiling (`MAX_SEARCH_LIMIT`), asked for explicitly so the
 * pane can tell "these are all the matches" from "this is the first page". */
const SEARCH_LIMIT = 200;

type Query = FileQuery<ReadonlyArray<FileSearchResult>> | "broken" | null;

function ResultRow({
  result,
  onOpen,
}: {
  readonly result: FileSearchResult;
  readonly onOpen: (result: FileSearchResult) => void;
}) {
  const { directory, name } = splitPath(result.path);
  return (
    <button
      type="button"
      onClick={() => onOpen(result)}
      title={result.path}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left outline-none",
        "hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <Icon
        icon={result.isDirectory ? "hugeicons:folder-01" : "hugeicons:file-01"}
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 truncate type-body text-foreground">{name}</span>
      {directory === "" ? null : (
        <span className="ml-auto min-w-0 shrink truncate type-micro text-muted-foreground">
          {directory}
        </span>
      )}
    </button>
  );
}

function SearchBody({
  query,
  results,
  stale,
  onOpen,
  onRetry,
  connected,
}: {
  readonly query: string;
  readonly results: Query;
  /** These matches are the previous query's, held while the next one loads. */
  readonly stale: boolean;
  readonly onOpen: (result: FileSearchResult) => void;
  readonly onRetry: () => void;
  readonly connected: boolean;
}) {
  if (!connected) {
    return <PaneMessage icon="hugeicons:wifi-off-01" text="Not connected to the server." />;
  }
  if (query === "") {
    return (
      <PaneMessage
        icon="hugeicons:search-01"
        text="Search this project's files."
        detail="Anything .gitignore excludes is left out."
      />
    );
  }
  const retry = (
    <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
      <Icon icon="hugeicons:refresh" className="size-3.5" />
      Try again
    </Button>
  );
  if (results === null) {
    return <PaneMessage icon="hugeicons:loading-03" text="Searching…" />;
  }
  if (results === "broken") {
    return (
      <PaneMessage icon="hugeicons:alert-02" text="Could not search this project." action={retry} />
    );
  }
  if (results._tag === "error") {
    return <PaneMessage icon="hugeicons:alert-02" text={results.message} action={retry} />;
  }
  if (results.value.length === 0) {
    return <PaneMessage icon="hugeicons:search-01" text="No files match this search." />;
  }
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", stale && "opacity-60")}>
      <div className="flex flex-col gap-px p-1.5">
        {results.value.map((result) => (
          <ResultRow key={result.path} result={result} onOpen={onOpen} />
        ))}
      </div>
      {results.value.length >= SEARCH_LIMIT ? (
        <p className="shrink-0 px-3 pb-2 type-micro text-muted-foreground">
          First {SEARCH_LIMIT} matches — narrow the search to see the rest.
        </p>
      ) : null}
    </div>
  );
}

export function FilesPane({
  projectId,
  connected,
}: {
  readonly projectId: ProjectId;
  readonly connected: boolean;
}) {
  const atoms = useFileAtoms();
  const [query, setQuery] = React.useState("");
  const [openPath, setOpenPath] = React.useState<string | null>(null);

  // The family key is the trimmed query, so leading and trailing spaces do not
  // each open their own atom — and it is deferred, the way the composer's
  // @-search already does it, so a burst of keystrokes opens one atom rather
  // than one per character. Without that every keystroke keys a fresh family
  // member, which starts in `Initial`: the list would blank to "Searching…"
  // and redraw on each letter instead of narrowing.
  const trimmed = React.useDeferredValue(query.trim());
  const searchAtom = atoms.fileSearchAtom({ projectId, query: trimmed, limit: SEARCH_LIMIT });
  const result = useAtomValue(searchAtom);
  const refresh = useAtomRefresh(searchAtom);

  const results: Query = AsyncResult.isSuccess(result)
    ? result.value
    : AsyncResult.isFailure(result)
      ? "broken"
      : null;

  // Hold the previous query's matches while the next atom is still `Initial`,
  // so the list narrows instead of blanking to "Searching…" between letters.
  // The project is part of what is held: another project's matches are not a
  // stale view of this one.
  const held = React.useRef<{ projectId: ProjectId; results: Query }>({ projectId, results: null });
  if (results !== null || held.current.projectId !== projectId) {
    held.current = { projectId, results };
  }
  const shown = results ?? held.current.results;

  // A directory is a navigation, not a file: search its own prefix so the list
  // becomes its contents.
  const open = (hit: FileSearchResult) => {
    if (hit.isDirectory) {
      setQuery(`${hit.path}/`);
      setOpenPath(null);
      return;
    }
    setOpenPath(hit.path);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border p-2">
        <Input
          value={query}
          placeholder="Search files…"
          aria-label="Search files"
          onChange={(event) => {
            setQuery(event.target.value);
            setOpenPath(null);
          }}
        />
      </div>
      {openPath === null ? (
        <SearchBody
          query={trimmed}
          results={shown}
          stale={results === null && shown !== null}
          onOpen={open}
          onRetry={refresh}
          connected={connected}
        />
      ) : (
        <>
          <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Back to results"
              onClick={() => setOpenPath(null)}
            >
              <Icon icon="hugeicons:arrow-left-01" className="size-3.5" />
            </Button>
            <span className="min-w-0 truncate font-mono text-xs text-foreground" title={openPath}>
              {openPath}
            </span>
          </div>
          <FilePreview key={openPath} projectId={projectId} path={openPath} connected={connected} />
        </>
      )}
    </div>
  );
}

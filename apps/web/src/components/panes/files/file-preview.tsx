/**
 * Read-only preview of one workspace file, a page at a time.
 *
 * `files.read` answers a line window plus the file's real line count, so the
 * footer pages through the whole file rather than showing one truncated head.
 * Everything the server cannot express — an empty file, a window past the end,
 * bytes that are not text — is decided in `./preview` and tested there.
 *
 * The page is a line *offset*, not a page number: the server may answer a
 * window short when its character cap bites, so Next resumes at the last line
 * it actually sent and Previous walks back over the offsets already visited.
 *
 * The parent mounts this with `key={path}`, so opening another file starts at
 * the top instead of inheriting this file's position.
 */

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { FileQuery } from "@OpenAde/client-runtime/fileAtoms";
import type { ProjectId } from "@OpenAde/contracts/ids";
import type { FileContent } from "@OpenAde/contracts/rpc";
import { Button } from "@OpenAde/ui/components/button";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { Icon } from "@/lib/icon";

import { useFileAtoms } from "./file-atoms";
import { PaneMessage } from "./pane-message";
import { looksBinary, PAGE_LINES, pagePosition, previewLines, windowFor } from "./preview";

function LineTable({ offset, content }: { offset: number; content: FileContent }) {
  const lines = previewLines(offset, content);
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse font-mono text-xs">
        <tbody>
          {lines.map((line) => (
            <tr key={line.number} className="align-top">
              <td className="w-0 select-none pr-3 pl-2 text-right tabular-nums text-muted-foreground">
                {line.number}
              </td>
              <td className="whitespace-pre pr-2 text-foreground">
                {line.text === "" ? " " : line.text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FilePreview({
  projectId,
  path,
  connected,
}: {
  readonly projectId: ProjectId;
  readonly path: string;
  readonly connected: boolean;
}) {
  const atoms = useFileAtoms();
  const [offset, setOffset] = React.useState(0);
  // The offsets Next came from, so Previous lands back on the exact windows the
  // reader saw — a page the server cut short is not PAGE_LINES wide.
  const [visited, setVisited] = React.useState<ReadonlyArray<number>>([]);
  const atom = atoms.fileContentAtom({ projectId, path, ...windowFor(offset) });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);

  const query: FileQuery<FileContent> | "broken" | null = AsyncResult.isSuccess(result)
    ? result.value
    : AsyncResult.isFailure(result)
      ? "broken"
      : null;

  const retry = (
    <Button type="button" variant="ghost" size="sm" onClick={refresh}>
      <Icon icon="hugeicons:refresh" className="size-3.5" />
      Try again
    </Button>
  );

  if (query === null) {
    return connected ? (
      <PaneMessage icon="hugeicons:loading-03" text="Loading file…" detail={path} />
    ) : (
      <PaneMessage icon="hugeicons:wifi-off-01" text="Not connected to the server." />
    );
  }
  if (query === "broken") {
    return (
      <PaneMessage
        icon="hugeicons:alert-02"
        text="Could not read this file."
        detail={path}
        action={retry}
      />
    );
  }
  if (query._tag === "error") {
    return (
      <PaneMessage icon="hugeicons:alert-02" text={query.message} detail={path} action={retry} />
    );
  }

  const content = query.value;
  if (looksBinary(content.text)) {
    return (
      <PaneMessage
        icon="hugeicons:file-01"
        text="This looks like a binary file, so there is nothing to show."
        detail={path}
      />
    );
  }

  const position = pagePosition(offset, content);
  if (position.firstLine === 0 && !position.hasPrevious) {
    return <PaneMessage icon="hugeicons:file-01" text="This file is empty." detail={path} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LineTable offset={offset} content={content} />
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-t border-border px-2 type-micro text-muted-foreground">
        <span className="min-w-0 truncate">{position.label}</span>
        {position.capped || (content.truncated && !position.hasNext) ? (
          <span className="shrink-0">· capped by the server</span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Previous page"
            disabled={!position.hasPrevious}
            onClick={() => {
              setOffset(visited.at(-1) ?? Math.max(0, offset - PAGE_LINES));
              setVisited((stack) => stack.slice(0, -1));
            }}
          >
            <Icon icon="hugeicons:arrow-up-01" className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Next page"
            disabled={!position.hasNext}
            onClick={() => {
              setVisited((stack) => [...stack, offset]);
              setOffset(position.nextOffset);
            }}
          >
            <Icon icon="hugeicons:arrow-down-01" className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Read-only preview of one workspace file, a page at a time.
 *
 * `files.read` answers a line window plus the file's real line count, so the
 * footer pages through the whole file rather than showing one truncated head.
 * Everything the server cannot express — an empty file, a window past the end,
 * bytes that are not text — is decided in `./preview` and tested there.
 *
 * The parent mounts this with `key={path}`, so opening another file starts on
 * page one instead of inheriting this file's.
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
import { looksBinary, pagePosition, previewLines, windowFor } from "./preview";

function LineTable({ page, content }: { page: number; content: FileContent }) {
  const lines = previewLines(page, content);
  return (
    <div className="min-h-0 flex-1 overflow-auto [scrollbar-width:thin]">
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
  const [page, setPage] = React.useState(0);
  const atom = atoms.fileContentAtom({ projectId, path, ...windowFor(page) });
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

  const position = pagePosition(page, content);
  if (position.firstLine === 0 && !position.hasPrevious) {
    return <PaneMessage icon="hugeicons:file-01" text="This file is empty." detail={path} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LineTable page={page} content={content} />
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-t border-border px-2 type-micro text-muted-foreground">
        <span className="min-w-0 truncate">{position.label}</span>
        {content.truncated && !position.hasNext ? (
          <span className="shrink-0">· capped by the server</span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Previous page"
            disabled={!position.hasPrevious}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
          >
            <Icon icon="hugeicons:arrow-up-01" className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Next page"
            disabled={!position.hasNext}
            onClick={() => setPage((current) => current + 1)}
          >
            <Icon icon="hugeicons:arrow-down-01" className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

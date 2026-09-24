/**
 * A fenced code block in markdown: a header with the file name or language, a
 * wrap toggle and a copy button, over the code in a height-capped scroller.
 *
 * The body renders through `File` from `@pierre/diffs` under the worker pool
 * `DiffWorkerPoolProvider` mounts at the root, the same one the inline diffs
 * use, so Shiki tokenizes off the main thread with the diff themes and follows
 * light/dark. A block the highlighter should not tokenize still renders
 * through it, as language `text`, so every block wears the same background:
 * one with no known language, one too large to be worth tokenizing
 * (`highlightable`), and one whose closing fence has not streamed in yet (its
 * text changes on every delta). Only without a pool (tests, server rendering)
 * does the block fall back to a plain `pre`, since `File` would otherwise load
 * Shiki on the main thread.
 *
 * The wrapper caps the height and owns both scroll axes: without wrapping,
 * the code is laid out at its full width inside it, so a long line scrolls
 * sideways with a scrollbar at the bottom of the visible box, not under the
 * block's last line.
 *
 * `cacheKey` names the block across renders (item id and offset), so the pool
 * reuses a highlight for a row the list recycled rather than tokenizing it
 * again. The library draws into its own element, so Copy reads the source
 * string, never the DOM.
 */

import { File, useWorkerPool } from "@pierre/diffs/react";
import * as React from "react";

import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { CopyButton } from "@/components/copy-button";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";
import { TextAlignJustifyLeft } from "@honeyicons/react";

import { type CodeFenceInfo, highlightable } from "./code-fence";
import { codeFileOptions } from "./diff-options";

function WrapToggle({
  wrap,
  onWrapChange,
}: {
  readonly wrap: boolean;
  readonly onWrapChange: (wrap: boolean) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant={wrap ? "secondary" : "ghost"}
            tone={wrap ? "default" : "muted"}
            size="icon-xs"
            aria-label="Wrap lines"
            aria-pressed={wrap}
            onClick={() => onWrapChange(!wrap)}
          />
        }
      >
        <TextAlignJustifyLeft variant="bold" />
      </TooltipTrigger>
      <TooltipContent>{wrap ? "Scroll long lines" : "Wrap long lines"}</TooltipContent>
    </Tooltip>
  );
}

function PoolCode({
  code,
  language,
  name,
  cacheKey,
  wrap,
}: {
  readonly code: string;
  readonly language: string;
  readonly name: string;
  readonly cacheKey: string | undefined;
  readonly wrap: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const themeType = resolvedTheme === "dark" ? "dark" : "light";
  const options = React.useMemo(() => codeFileOptions(themeType, wrap), [themeType, wrap]);
  const file = React.useMemo(
    () => ({ name, contents: code, lang: language, cacheKey }),
    [name, code, language, cacheKey],
  );
  // Scrolling, the file is as wide as its longest line, so the capped wrapper
  // around it scrolls both ways and its sideways scrollbar sits at the bottom
  // of what is on screen; left to scroll itself, the library's code element
  // would put that scrollbar under the last line, out of view in a tall block.
  return (
    <File
      file={file}
      options={options}
      className={cn("block text-xs", !wrap && "w-max min-w-full")}
    />
  );
}

export const CodeBlock = React.memo(function CodeBlock({
  code,
  info,
  cacheKey,
  plain = false,
}: {
  readonly code: string;
  readonly info: CodeFenceInfo;
  readonly cacheKey?: string;
  /** Render without highlighting, e.g. while the block's fence is still open. */
  readonly plain?: boolean;
}) {
  const [wrap, setWrap] = React.useState(false);
  const pool = useWorkerPool();
  const highlight = !plain && info.language !== "text" && highlightable(code);

  return (
    <div
      role="group"
      aria-label={`Code: ${info.label}`}
      className="mb-3 overflow-hidden rounded-lg border border-border last:mb-0"
    >
      <div className="flex items-center gap-1 border-b border-border bg-card py-0.5 pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {info.label}
        </span>
        <WrapToggle wrap={wrap} onWrapChange={setWrap} />
        <CopyButton text={code} label={`Copy ${info.label}`} tooltip="Copy code" tone="muted" />
      </div>
      <div className="max-h-96 overflow-auto">
        {pool !== undefined ? (
          <PoolCode
            code={code}
            language={highlight ? info.language : "text"}
            name={info.fileName ?? "snippet"}
            cacheKey={highlight ? cacheKey : undefined}
            wrap={wrap}
          />
        ) : (
          <pre
            className={cn(
              "px-3 py-2 font-mono text-xs",
              wrap ? "break-words whitespace-pre-wrap" : "w-max min-w-full whitespace-pre",
            )}
          >
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
});

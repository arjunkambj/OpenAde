/**
 * The round "jump to latest" button over the bottom of the timeline. It shows
 * only while the list sits away from its end — where it stops following new
 * rows — and scrolls back down when pressed. `timeline.jumpToLatest` does the
 * same from the keyboard; the timeline answers it, and the tooltip shows its
 * chord.
 *
 * While a just-sent message is carried to the top the list is away from its
 * end on purpose, so the button stays hidden then.
 */

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type { LegendListRef } from "@legendapp/list/react";
import * as React from "react";

import { CommandKbd } from "@/lib/shortcuts";
import { ArrowDown } from "@honeyicons/react";

export function JumpToLatest({
  listRef,
  hidden,
  onJump,
}: {
  listRef: React.RefObject<LegendListRef | null>;
  /** The list is away from its end on purpose, carrying a sent message to the top. */
  hidden: boolean;
  onJump: () => void;
}) {
  // Starts hidden: the list opens at its end, and its own flag reads false until
  // the first layout, which would flash the button on every mount.
  const [nearEnd, setNearEnd] = React.useState(true);

  React.useEffect(() => listRef.current?.getState().listen("isNearEnd", setNearEnd), [listRef]);

  if (nearEnd || hidden) {
    return null;
  }
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="secondary"
              size="icon-sm"
              shape="pill"
              aria-label="Jump to latest"
              className="pointer-events-auto"
              onClick={onJump}
            />
          }
        >
          <ArrowDown variant="bold" />
        </TooltipTrigger>
        <TooltipContent>
          Jump to latest
          <CommandKbd command="timeline.jumpToLatest" />
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

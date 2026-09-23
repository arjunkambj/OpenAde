/**
 * The round "jump to latest" button over the bottom of the timeline. It shows
 * only while the list sits away from its end — where `maintainScrollAtEnd`
 * stops following new rows — and scrolls back down when pressed.
 */

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type { LegendListRef } from "@legendapp/list/react";
import * as React from "react";

import { ArrowDown } from "@honeyicons/react";

export function JumpToLatest({ listRef }: { listRef: React.RefObject<LegendListRef | null> }) {
  // Starts hidden: the list opens at its end, and its own flag reads false until
  // the first layout, which would flash the button on every mount.
  const [nearEnd, setNearEnd] = React.useState(true);

  React.useEffect(() => listRef.current?.getState().listen("isNearEnd", setNearEnd), [listRef]);

  if (nearEnd) {
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
              onClick={() => void listRef.current?.scrollToEnd({ animated: true })}
            />
          }
        >
          <ArrowDown variant="bold" />
        </TooltipTrigger>
        <TooltipContent>Jump to latest</TooltipContent>
      </Tooltip>
    </div>
  );
}

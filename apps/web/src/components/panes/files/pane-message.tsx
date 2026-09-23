/**
 * The dock panes' one empty/loading/error block, on the stock `Empty`. Every
 * state the files and changes panes can be in renders through this, so
 * "nothing here" always looks deliberate.
 */

import type { HoneyIcon } from "@honeyicons/react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@OpenAde/ui/components/empty";
import type { ReactNode } from "react";

export function PaneMessage({
  icon: Glyph,
  text,
  detail,
  action,
}: {
  readonly icon: HoneyIcon;
  readonly text: string;
  readonly detail?: string;
  readonly action?: ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Glyph />
        </EmptyMedia>
        <EmptyTitle>{text}</EmptyTitle>
        {detail === undefined ? null : (
          <EmptyDescription className="max-w-full">
            <span className="block truncate">{detail}</span>
          </EmptyDescription>
        )}
      </EmptyHeader>
      {action === undefined ? null : <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

/**
 * `Date.now()` that re-renders its caller every `intervalMs` — for clocks on
 * screen (a running turn's elapsed time, relative times in the sidebar). It is
 * presentation state only: nothing downstream reads it but the label.
 */

import * as React from "react";

export const useNow = (intervalMs: number): number => {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
};

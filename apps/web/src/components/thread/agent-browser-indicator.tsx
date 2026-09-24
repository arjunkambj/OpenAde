/**
 * "Agent is using the browser — Show": the thread header's sign that the
 * agent is driving the thread's browser while its pane is not on screen.
 *
 * The browser pane never opens by default. The agent's first browser call
 * creates the thread's tab hidden (the browser host keeps it laid out, so the
 * agent can click and screenshot it), and this chip is how the user finds
 * out. `useAgentBrowser` also applies `browser.openPaneOnAgentUse` — off by
 * default — through the rules in `@/components/panes/browser/auto-open`.
 */
import * as React from "react";

import { useAtomValue } from "@effect/atom-react";
import type { ThreadId } from "@OpenAde/contracts/ids";
import { Button } from "@OpenAde/ui/components/button";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  agentUsingBrowser,
  noteUserDockChange,
  observeAgentUse,
  shouldAutoOpen,
  showAgentIndicator,
} from "@/components/panes/browser/auto-open";
import { getAppAtoms } from "@/state/app-runtime";
import { useThreadAgentActivity } from "@/state/browser-activity";
import { useThreadTabs } from "@/state/browser-tabs";
import { Globe } from "@honeyicons/react";

/**
 * Watches the agent's use of the thread's browser. Returns whether the
 * indicator shows, and `noteUserDock`, which every dock move the user makes
 * must go through so a pane they closed is not reopened over them.
 *
 * `autoOpen` shows the pane without remembering it as the thread's dock tab:
 * only the user's own choice is remembered.
 */
export const useAgentBrowser = (
  threadId: ThreadId,
  dockTab: string | undefined,
  autoOpen: () => void,
) => {
  const atoms = getAppAtoms();
  const stateResult = useAtomValue(atoms.browserStateAtom(threadId));
  const state = AsyncResult.isSuccess(stateResult) ? stateResult.value : null;
  const settingsResult = useAtomValue(atoms.settingsAtom);
  const setting =
    AsyncResult.isSuccess(settingsResult) &&
    settingsResult.value !== null &&
    settingsResult.value.browser.openPaneOnAgentUse;
  const using = agentUsingBrowser(state, useThreadTabs(threadId));
  const [, updateActivity] = useThreadAgentActivity(threadId);

  // Only a change in the agent's use is an observation; the dock, the setting
  // and the callback are read as they are at that moment.
  const latest = React.useRef({ dockTab, setting, autoOpen });
  latest.current = { dockTab, setting, autoOpen };

  React.useEffect(() => {
    let open = false;
    // The update runs synchronously against the stored record, so a second
    // run of this effect sees the first one's record and does not reopen.
    updateActivity((current) => {
      const observed = observeAgentUse(current, using);
      open = shouldAutoOpen({
        setting: latest.current.setting,
        dockTab: latest.current.dockTab,
        closedByUserWhileAgentActive: observed.activity.closedByUser,
        agentJustStarted: observed.agentJustStarted,
      });
      return observed.activity;
    });
    if (open) latest.current.autoOpen();
  }, [using, updateActivity]);

  const noteUserDock = React.useCallback(
    (from: string | undefined, to: string | undefined) =>
      updateActivity((current) => noteUserDockChange(current, from, to)),
    [updateActivity],
  );

  return { indicator: showAgentIndicator(using, dockTab), noteUserDock };
};

/** The chip itself: a status line and a Show button, never in the way. */
export function AgentBrowserIndicator({ onShow }: { readonly onShow: () => void }) {
  return (
    <span
      role="status"
      className="inline-flex min-w-0 shrink items-center gap-1.5 rounded-full bg-hover py-0.5 pr-1 pl-2 type-micro text-muted-foreground"
    >
      <Globe variant="bold" className="size-3 shrink-0 animate-pulse" />
      <span className="truncate">Agent is using the browser</span>
      <Button type="button" variant="ghost" size="xs" shape="pill" onClick={onShow}>
        Show
      </Button>
    </span>
  );
}

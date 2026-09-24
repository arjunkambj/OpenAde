/**
 * The pane's two ways to bring the page into the conversation, beside the
 * address bar: pick an element (its CSS path, text and HTML go into the
 * thread's draft) and screenshot the tab (a PNG attached to the draft). Both
 * land in the composer's per-thread draft (`@/state/ui`), so the person
 * reviews and sends them; neither talks to the agent on its own.
 */
import * as React from "react";

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import { toast } from "sonner";

import { rejectionMessage, triageAttachments } from "@/components/composer/attachment-rules";
import { getTabView } from "@/components/browser-host/tab-views";
import type { BrowserTab } from "@/state/browser-tabs";
import { useComposerDraft } from "@/state/ui";
import { Camera, Target } from "@honeyicons/react";

import {
  appendToDraft,
  CANCEL_PICK_SCRIPT,
  parsePicked,
  pickedElementText,
  PICK_SCRIPT,
  screenshotFile,
} from "./page-to-chat";

export interface PageActionsProps {
  readonly threadId: string;
  readonly tab: BrowserTab | null;
}

export function PageActions({ threadId, tab }: PageActionsProps) {
  const draft = useComposerDraft(threadId);
  const [picking, setPicking] = React.useState(false);
  const capture = window.openade?.browserPane?.capture;
  const ready = tab !== null && tab.wcId !== null;

  // A tab switch or close ends a pick in the old tab.
  const pickingIn = React.useRef<string | null>(null);
  React.useEffect(() => {
    const previous = pickingIn.current;
    if (previous !== null && previous !== tab?.tabId) {
      void getTabView(previous)
        ?.executeJavaScript(CANCEL_PICK_SCRIPT)
        .catch(() => undefined);
    }
  }, [tab?.tabId]);

  const pick = async () => {
    if (tab === null) return;
    const view = getTabView(tab.tabId);
    if (view === null) return;
    if (picking) {
      void view.executeJavaScript(CANCEL_PICK_SCRIPT).catch(() => undefined);
      return;
    }
    setPicking(true);
    pickingIn.current = tab.tabId;
    try {
      const picked = parsePicked(await view.executeJavaScript(PICK_SCRIPT));
      if (picked !== null) {
        draft.setText((current) => appendToDraft(current, pickedElementText(picked, tab.url)));
        toast.success("Added the element to your message");
      }
    } catch {
      toast.error("Could not pick an element on this page");
    } finally {
      pickingIn.current = null;
      setPicking(false);
    }
  };

  const screenshot = async () => {
    if (capture === undefined || tab === null || tab.wcId === null) return;
    try {
      const file = screenshotFile(await capture(tab.wcId), tab.url, new Date());
      const triage = triageAttachments([file]);
      if (triage.accepted.length === 0) {
        toast.error(rejectionMessage(triage.rejected) ?? "Could not attach the screenshot");
        return;
      }
      draft.setFiles((current) => [...current, ...triage.accepted]);
      toast.success("Attached a screenshot to your message");
    } catch {
      toast.error("Could not take a screenshot of this page");
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant={picking ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={picking ? "Stop picking" : "Pick an element"}
              aria-pressed={picking}
              disabled={!ready}
              onClick={() => void pick()}
            />
          }
        >
          <Target variant="bold" />
        </TooltipTrigger>
        <TooltipContent>
          {picking ? "Click an element on the page, or press Escape" : "Pick an element for chat"}
        </TooltipContent>
      </Tooltip>
      {capture === undefined ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Screenshot to chat"
                disabled={!ready}
                onClick={() => void screenshot()}
              />
            }
          >
            <Camera variant="bold" />
          </TooltipTrigger>
          <TooltipContent>Screenshot to chat</TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

/**
 * The one "new thread" flow. Mint the id client-side (so a retry is a no-op
 * rather than a second thread), dispatch `thread.create`, and navigate to the
 * thread on an accepted receipt. The sidebar's per-project button, the home
 * screen's start panel and the command palette all call this, so there is
 * exactly one code path that can bring a thread into existence.
 */

import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";

import { makeCommandId, makeThreadId, type ProjectId } from "@OpenAde/contracts/ids";

import { isAccepted, rejectionMessage } from "@/lib/dispatch-outcome";
import { useDispatchCommand } from "@/state/hooks";

export const useCreateThread = () => {
  const dispatch = useDispatchCommand();
  const navigate = useNavigate();
  const [pending, setPending] = React.useState(false);

  const create = React.useCallback(
    async (projectId: ProjectId) => {
      const threadId = makeThreadId();
      setPending(true);
      const exit = await dispatch({
        commandId: makeCommandId(),
        createdAt: new Date().toISOString(),
        type: "thread.create",
        threadId,
        projectId,
      });
      setPending(false);
      if (isAccepted(exit)) {
        void navigate({ to: "/t/$threadId", params: { threadId } });
        return;
      }
      toast.error(rejectionMessage(exit, "Thread was rejected"));
    },
    [dispatch, navigate],
  );

  return { create, pending };
};

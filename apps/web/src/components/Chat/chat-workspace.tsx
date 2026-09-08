import * as React from "react";

import { Composer } from "@/components/Chat/composer";
import { UserMessage } from "@/components/Chat/messages";
import { SeedThread } from "@/components/Chat/seed-thread";

type DraftMessage = {
  id: string;
  text: string;
  files: string[];
};

export function ChatWorkspace() {
  const [drafts, setDrafts] = React.useState<DraftMessage[]>([]);
  const scrollerRef = React.useRef<HTMLDivElement>(null);

  function handleSend(text: string, files: File[]) {
    setDrafts((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        text,
        files: files.map((file) => file.name),
      },
    ]);
  }

  React.useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }
    scroller.scrollTop = scroller.scrollHeight;
  }, [drafts]);

  return (
    <div className="@container flex min-h-0 w-full min-w-0 flex-1 flex-col items-center gap-6 px-4 pb-7 md:px-14">
      <div
        ref={scrollerRef}
        className="flex w-full min-h-0 max-w-[760px] flex-1 flex-col gap-4 overflow-y-auto pt-10 [scrollbar-width:thin]"
      >
        <SeedThread />
        {drafts.map((draft) => (
          <UserMessage key={draft.id} className="whitespace-pre-wrap">
            {draft.text}
            {draft.files.length > 0 ? (
              <span className="mt-3 flex flex-wrap gap-1.5">
                {draft.files.map((file) => (
                  <span key={file} className="rounded-sm bg-hover px-1 font-mono text-xs">
                    {file}
                  </span>
                ))}
              </span>
            ) : null}
          </UserMessage>
        ))}
      </div>
      <Composer onSend={handleSend} />
    </div>
  );
}

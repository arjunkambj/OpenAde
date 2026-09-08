import * as React from "react";

import { Button } from "@OpenAde/ui/components/button";

import { ComposerSelect } from "@/components/Chat/composer-select";
import { Icon } from "@/lib/icon";
import { cn } from "@/lib/utils";

const permissionItems = [
  { value: "default", label: "Default permissions" },
  { value: "read", label: "Read only" },
  { value: "full", label: "Full access" },
] as const;

const modelItems = [
  { value: "gpt-3", label: "GPT-3" },
  { value: "auto", label: "Auto" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini" },
] as const;

const reasoningItems = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "extra-high", label: "Extra high" },
] as const;

const workspaceItems = [
  { value: "checkout", label: "Checkout" },
  { value: "worktree", label: "Worktree" },
] as const;

export function Composer({
  onSend,
  className,
}: {
  onSend?: (message: string, files: File[]) => void;
  className?: string;
}) {
  const [message, setMessage] = React.useState("");
  const [files, setFiles] = React.useState<File[]>([]);
  const [permission, setPermission] = React.useState("full");
  const [model, setModel] = React.useState("gpt-3");
  const [reasoning, setReasoning] = React.useState("medium");
  const [workspace, setWorkspace] = React.useState("checkout");
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const canSend = message.trim().length > 0 || files.length > 0;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend) {
      return;
    }

    onSend?.(message.trim(), files);
    setMessage("");
    setFiles([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  return (
    <div className={cn("w-full min-w-0 max-w-[760px] shrink-0 rounded-2xl bg-hover", className)}>
      <form
        className="flex min-h-[108px] min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card px-4 py-3"
        onSubmit={handleSubmit}
        aria-label="Message composer"
      >
        <textarea
          aria-label="Message"
          placeholder="Ask anything, or / for commands…"
          rows={1}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          className="block min-h-10 w-full resize-none bg-transparent text-sm leading-normal text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="flex min-w-0 items-center gap-1.5 @min-[480px]:gap-3">
          <input
            ref={fileInputRef}
            id="composer-attachments"
            type="file"
            hidden
            multiple
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
          />
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto @min-[480px]:gap-3">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label="Attach files"
              title="Attach files"
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon icon="hugeicons:add-01" />
            </Button>
            <ComposerSelect
              label="Permissions"
              value={permission}
              onValueChange={setPermission}
              items={permissionItems}
              className="text-permission"
            />
            {files.length > 0 ? (
              <span className="max-w-12 truncate text-xs text-muted-foreground @min-[480px]:max-w-[120px]">
                {files.map((file) => file.name).join(", ")}
              </span>
            ) : null}
            <div className="ml-auto flex min-w-0 items-center gap-2 @min-[480px]:gap-3">
              <ComposerSelect
                label="Model"
                value={model}
                onValueChange={setModel}
                items={modelItems}
              />
              <ComposerSelect
                label="Reasoning effort"
                value={reasoning}
                onValueChange={setReasoning}
                items={reasoningItems}
              />
            </div>
          </div>
          <Button
            type="submit"
            size="icon-sm"
            className="shrink-0 rounded-full"
            aria-label="Send message"
            title="Send message"
            disabled={!canSend}
          >
            <Icon icon="hugeicons:arrow-up-02" />
          </Button>
        </div>
      </form>
      <div
        className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-[13px] text-sidebar-foreground"
        aria-label="Project context"
      >
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Icon icon="hugeicons:folder-01" className="size-4 shrink-0" />
          <span className="max-w-[170px] truncate">tests</span>
        </span>
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Icon icon="hugeicons:computer" className="size-4 shrink-0" />
          <ComposerSelect
            label="Workspace mode"
            value={workspace}
            onValueChange={setWorkspace}
            items={workspaceItems}
          />
        </span>
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Icon icon="hugeicons:git-branch" className="size-4 shrink-0" />
          main
        </span>
        <span
          className="ml-auto grid size-5 shrink-0 place-items-center text-muted-foreground"
          role="img"
          aria-label="Context usage unavailable in preview"
          title="Context usage unavailable in preview"
        >
          <Icon icon="hugeicons:circle" className="size-5" />
        </span>
      </div>
    </div>
  );
}

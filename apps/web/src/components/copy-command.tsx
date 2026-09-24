/**
 * A shell command the user is told to run, in a mono code span with a copy
 * button beside it. The settings card and the harness banner show the
 * connector's own login or install command through it.
 */
import { CopyButton } from "@/components/copy-button";

export function CopyCommand({ command }: { readonly command: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <code className="min-w-0 truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
        {command}
      </code>
      <CopyButton text={command} label={`Copy ${command}`} tooltip="Copy command" />
    </span>
  );
}

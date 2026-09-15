import { Button } from "@OpenAde/ui/components/button";

import { Icon } from "@/lib/icon";
import { cn } from "@/lib/utils";

function ChangeCount({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="inline-flex shrink-0 gap-2.5 text-xs font-normal tabular-nums">
      <span className="text-added">+{added}</span>
      <span className="text-removed">−{removed}</span>
    </span>
  );
}

export function ChangedFiles({
  title = "1 changed file",
  added = 2,
  removed = 2,
  folder,
  file,
  onOpenDiff,
  className,
}: {
  title?: string;
  added?: number;
  removed?: number;
  folder: string;
  file: string;
  onOpenDiff?: () => void;
  className?: string;
}) {
  return (
    <section
      aria-label="Changed files"
      className={cn(
        "overflow-hidden rounded-xl rounded-b-2xl border-2 border-hover bg-sidebar px-4 pb-1.5 type-body",
        className,
      )}
    >
      <div className="-mx-4 mb-1 flex min-h-9 flex-wrap items-center gap-2.5 bg-hover px-4 py-2 text-foreground">
        <span className="font-medium">{title}</span>
        <ChangeCount added={added} removed={removed} />
        <Button
          type="button"
          variant="bare"
          size="inline"
          tone="subtle"
          className="ml-auto"
          onClick={onOpenDiff}
        >
          <Icon icon="hugeicons:file-01" className="size-3.5" />
          Open diff
        </Button>
      </div>
      <div className="flex min-h-[30px] items-center gap-2 font-mono text-sidebar-foreground">
        <Icon icon="hugeicons:folder-01" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{folder}</span>
        <span className="ml-auto">
          <ChangeCount added={added} removed={removed} />
        </span>
      </div>
      <div className="flex min-h-[30px] items-center gap-2 pl-5.5 font-mono text-sidebar-foreground">
        <Icon icon="hugeicons:file-01" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{file}</span>
        <span className="ml-auto">
          <ChangeCount added={added} removed={removed} />
        </span>
      </div>
    </section>
  );
}

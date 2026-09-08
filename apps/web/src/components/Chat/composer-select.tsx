import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@OpenAde/ui/components/select";

import { cn } from "@/lib/utils";

export type SelectOption = {
  value: string;
  label: string;
};

const ghostTriggerClassName =
  "h-auto min-w-0 max-w-full truncate border-0 bg-transparent px-0 py-1 text-sidebar-foreground shadow-none ring-0 transition-colors duration-150 ease-out focus-visible:border-transparent focus-visible:ring-2 data-[size=sm]:h-auto [&_svg]:hidden";

export function ComposerSelect({
  label,
  value,
  onValueChange,
  items,
  className,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  items: readonly SelectOption[];
  className?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next) {
          onValueChange(next);
        }
      }}
      items={[...items]}
    >
      <SelectTrigger aria-label={label} size="sm" className={cn(ghostTriggerClassName, className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className="min-w-40">
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

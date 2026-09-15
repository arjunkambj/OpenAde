"use client";

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@OpenAde/ui/lib/utils";

const collapsibleTriggerVariants = cva("", {
  variants: {
    variant: {
      default: "",
      summary:
        "group/summary relative flex min-h-6 w-full cursor-pointer items-center gap-2 rounded-sm bg-transparent py-0.5 text-left type-body leading-compact font-normal text-muted-foreground outline-none transition-colors duration-150 ease-out hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

const collapsibleContentVariants = cva("", {
  variants: {
    variant: {
      default: "",
      indented:
        "overflow-hidden border-l border-border py-2 pr-0 pl-3.5 type-body leading-relaxed text-muted-foreground transition-reveal duration-150 ease-out data-closed:-translate-y-0.5 data-closed:py-0 data-closed:opacity-0",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({
  className,
  variant = "default",
  ...props
}: CollapsiblePrimitive.Trigger.Props & VariantProps<typeof collapsibleTriggerVariants>) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn(collapsibleTriggerVariants({ variant, className }))}
      {...props}
    />
  );
}

function CollapsibleContent({
  className,
  variant = "default",
  ...props
}: CollapsiblePrimitive.Panel.Props & VariantProps<typeof collapsibleContentVariants>) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      className={cn(collapsibleContentVariants({ variant, className }))}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };

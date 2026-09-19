"use client";

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@OpenAde/ui/lib/utils";

const collapsibleVariants = cva("", {
  variants: {
    variant: {
      default: "",
      card: "group/row overflow-hidden rounded-xl bg-card",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

const collapsibleTriggerVariants = cva("", {
  variants: {
    variant: {
      default: "",
      summary:
        "group/summary relative flex min-h-6 w-full cursor-pointer items-center gap-2 rounded-sm bg-transparent py-0.5 text-left type-body leading-compact font-normal text-muted-foreground outline-none transition-colors duration-150 ease-out hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring",
      card: "group/summary relative flex min-h-9 w-full cursor-pointer items-center gap-2 px-3 text-left type-body font-medium text-sidebar-foreground outline-none transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring",
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
      card: "px-3 pb-3",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

function Collapsible({
  className,
  variant = "default",
  ...props
}: CollapsiblePrimitive.Root.Props & VariantProps<typeof collapsibleVariants>) {
  return (
    <CollapsiblePrimitive.Root
      data-slot="collapsible"
      className={cn(collapsibleVariants({ variant, className }))}
      {...props}
    />
  );
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

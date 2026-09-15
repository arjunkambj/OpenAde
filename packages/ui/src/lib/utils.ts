import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The theme adds scale steps Tailwind does not ship. Without these, twMerge
// reads them as unknown classes and stops resolving them against the built-in
// steps they are meant to replace.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": ["type-body", "type-micro"],
      leading: ["leading-compact", "leading-prose"],
      rounded: ["rounded-nested"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

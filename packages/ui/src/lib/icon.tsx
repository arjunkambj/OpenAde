import { Icon as IconifyIcon, addCollection } from "@iconify/react/offline";
import type { IconifyJSON, IconProps } from "@iconify/react/offline";
import { icons as solar } from "@iconify-json/solar";

addCollection(solar as IconifyJSON);

export function Icon(props: IconProps) {
  return <IconifyIcon ssr {...props} />;
}

export type { IconProps };

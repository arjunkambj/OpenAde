import { icons as hugeicons } from "@iconify-json/hugeicons";
import { addCollection } from "@iconify/react/offline";
import type { IconifyJSON } from "@iconify/react/offline";

addCollection(hugeicons as IconifyJSON);

export { Icon, type IconProps } from "@OpenAde/ui/lib/icon";

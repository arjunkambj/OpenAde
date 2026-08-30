import { Icon } from "@/lib/icon";

export default function Loader() {
  return (
    <div className="flex h-full items-center justify-center pt-8">
      <Icon icon="solar:refresh-linear" className="animate-spin" />
    </div>
  );
}

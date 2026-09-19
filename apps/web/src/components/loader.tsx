import { Repeat } from "@honeyicons/react";

export default function Loader() {
  return (
    <div className="flex h-full items-center justify-center pt-8">
      <Repeat className="size-4 animate-spin" />
    </div>
  );
}

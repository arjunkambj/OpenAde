import { Spinner } from "@honeyicons/react";

export default function Loader() {
  return (
    <div className="flex h-full items-center justify-center pt-8">
      <Spinner className="size-4" />
    </div>
  );
}

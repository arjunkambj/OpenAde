/**
 * Copies a file's path to the clipboard and says whether it worked, the same
 * way everywhere a menu offers it: the Changes file menu and a timeline file
 * chip's context menu. A clipboard the page cannot reach counts as a failure.
 */

import { toast } from "sonner";

type Clipboard = Pick<globalThis.Clipboard, "writeText">;

const pageClipboard = (): Clipboard | undefined =>
  typeof navigator === "undefined" ? undefined : navigator.clipboard;

export const copyPath = (
  path: string,
  clipboard: Clipboard | undefined = pageClipboard(),
): Promise<void> =>
  (clipboard === undefined
    ? Promise.reject(new Error("No clipboard"))
    : clipboard.writeText(path)
  ).then(
    () => {
      toast.success("Copied the path");
    },
    () => {
      toast.error("Could not copy the path");
    },
  );

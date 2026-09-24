/**
 * Wipes a deleted thread's browsing data: the cookies, storage and cache of
 * its `persist:thread-<id>` partition.
 *
 * The window asks, once the thread has left its list and its pane tabs are
 * gone (`CLEAR_THREAD_CHANNEL`, in `./tabsChannel`). The id comes from the renderer, so it
 * is checked against the same pattern the bridge accepts before it names a
 * partition — anything else could point `fromPartition` at a session that is
 * not a pane's. A thread that never had a partition on disk is left alone
 * rather than created just to be cleared.
 *
 * Electron-free: `../ipc.ts` passes in how to find and open the partition.
 */
import { BRIDGE_THREAD_ID } from "@OpenAde/shared/browserBridge";

/** The parts of an Electron `Session` clearing needs. */
export interface ClearableSession {
  readonly clearStorageData: () => Promise<void>;
  readonly clearCache: () => Promise<void>;
}

export interface ClearThreadOptions {
  /** Whether `persist:thread-<id>` has a directory on disk yet. */
  readonly partitionExists: (threadId: string) => boolean;
  /** `session.fromPartition`. */
  readonly fromPartition: (partition: string) => ClearableSession;
}

/** Resolves `true` when a partition was cleared, `false` when there was none. */
export const makeClearThread =
  (options: ClearThreadOptions) =>
  async (threadId: unknown): Promise<boolean> => {
    if (typeof threadId !== "string" || !BRIDGE_THREAD_ID.test(threadId)) {
      throw new Error("not a thread id");
    }
    if (!options.partitionExists(threadId)) return false;
    const session = options.fromPartition(`persist:thread-${threadId}`);
    await session.clearStorageData();
    await session.clearCache();
    return true;
  };

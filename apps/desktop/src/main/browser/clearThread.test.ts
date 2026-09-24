import { describe, expect, it } from "vitest";

import { makeClearThread } from "./clearThread";

const fakePartitions = (onDisk: ReadonlyArray<string>) => {
  const opened: Array<string> = [];
  const cleared: Array<string> = [];
  const clear = makeClearThread({
    partitionExists: (threadId) => onDisk.includes(threadId),
    fromPartition: (partition) => {
      opened.push(partition);
      return {
        clearStorageData: async () => {
          cleared.push(`${partition} storage`);
        },
        clearCache: async () => {
          cleared.push(`${partition} cache`);
        },
      };
    },
  });
  return { clear, opened, cleared };
};

const THREAD = "019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5b";

describe("makeClearThread", () => {
  it("clears the storage and cache of the thread's own partition", async () => {
    const partitions = fakePartitions([THREAD]);
    await expect(partitions.clear(THREAD)).resolves.toBe(true);
    expect(partitions.opened).toEqual([`persist:thread-${THREAD}`]);
    expect(partitions.cleared).toEqual([
      `persist:thread-${THREAD} storage`,
      `persist:thread-${THREAD} cache`,
    ]);
  });

  it("rejects anything that is not a thread id before naming a partition", async () => {
    const partitions = fakePartitions([THREAD]);
    for (const bad of [
      undefined,
      null,
      42,
      "",
      "../../Default",
      "a/b",
      "thread id",
      `${THREAD}\n`,
      "x:y",
      "..",
      { threadId: THREAD },
    ]) {
      await expect(partitions.clear(bad)).rejects.toThrow("not a thread id");
    }
    expect(partitions.opened).toEqual([]);
  });

  it("does not create a partition that was never on disk just to clear it", async () => {
    const partitions = fakePartitions([]);
    await expect(partitions.clear(THREAD)).resolves.toBe(false);
    expect(partitions.opened).toEqual([]);
  });
});

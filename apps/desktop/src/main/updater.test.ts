import { afterEach, describe, expect, it, vi } from "vitest";

import { checkForUpdates } from "./updater";

const saved = process.env.POSEIDON_UPDATER;

afterEach(() => {
  if (saved === undefined) delete process.env.POSEIDON_UPDATER;
  else process.env.POSEIDON_UPDATER = saved;
  vi.restoreAllMocks();
});

describe("checkForUpdates", () => {
  it("does nothing without POSEIDON_UPDATER", () => {
    delete process.env.POSEIDON_UPDATER;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    checkForUpdates();
    expect(log).not.toHaveBeenCalled();
  });

  it("only logs that no feed is configured with POSEIDON_UPDATER=1", () => {
    process.env.POSEIDON_UPDATER = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    checkForUpdates();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("no feed is configured");
  });
});

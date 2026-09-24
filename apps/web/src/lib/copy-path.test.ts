import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { copyPath } from "./copy-path";

describe("copyPath", () => {
  beforeEach(() => {
    toast.success.mockClear();
    toast.error.mockClear();
  });

  it("copies the path and confirms it", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    await copyPath("src/app.ts", { writeText });
    expect(writeText).toHaveBeenCalledWith("src/app.ts");
    expect(toast.success).toHaveBeenCalledWith("Copied the path");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("says so when the clipboard refuses", async () => {
    await copyPath("src/app.ts", { writeText: () => Promise.reject(new Error("denied")) });
    expect(toast.error).toHaveBeenCalledWith("Could not copy the path");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("says so when there is no clipboard", async () => {
    await copyPath("src/app.ts", undefined);
    expect(toast.error).toHaveBeenCalledWith("Could not copy the path");
  });
});

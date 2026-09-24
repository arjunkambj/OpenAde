import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vitest";

import { fileMenuEmptyLabel, heldMenuSource, menuSource } from "@/components/composer/menu-source";

const rpcFailure = (code: PoseidonRpcError["code"]) =>
  AsyncResult.failure<ReadonlyArray<string>, PoseidonRpcError>(
    Cause.fail(new PoseidonRpcError({ code, message: `${code} happened` })),
  );

describe("menuSource", () => {
  it("reads an atom's in-flight initial value as loading, not as an empty list", () => {
    // What an atom with `initialValue: []` holds while its RPC runs.
    const inFlight = AsyncResult.success<ReadonlyArray<string>>([], { waiting: true });
    expect(menuSource(inFlight)).toEqual({ status: "loading", entries: [] });
    expect(menuSource(AsyncResult.initial<ReadonlyArray<string>>())).toEqual({
      status: "loading",
      entries: [],
    });
  });

  it("keeps what a list held while it is asked again", () => {
    const refreshing = AsyncResult.success<ReadonlyArray<string>>(["a"], { waiting: true });
    expect(menuSource(refreshing)).toEqual({ status: "loading", entries: ["a"] });
  });

  it("reads an answered list as ready", () => {
    expect(menuSource(AsyncResult.success<ReadonlyArray<string>>(["a", "b"]))).toEqual({
      status: "ready",
      entries: ["a", "b"],
    });
    expect(menuSource(AsyncResult.success<ReadonlyArray<string>>([]))).toEqual({
      status: "ready",
      entries: [],
    });
  });

  it("reads a failure as failed", () => {
    expect(menuSource(rpcFailure("internal"))).toEqual({ status: "failed", entries: [] });
    const defect = AsyncResult.failure<ReadonlyArray<string>, never>(Cause.die(new Error("boom")));
    expect(menuSource(defect).status).toBe("failed");
  });

  it("reads an instance without the extension as having none", () => {
    expect(menuSource(rpcFailure("unavailable"))).toEqual({ status: "ready", entries: [] });
  });
});

describe("heldMenuSource", () => {
  const ready = (entries: ReadonlyArray<string>) => ({ status: "ready" as const, entries });
  const inFlight = { status: "loading" as const, entries: [] as ReadonlyArray<string> };

  it("says searching, not no match, while the menu opens on the closed menu's empty answer", () => {
    // The first render after `#x` opens still reads the `""` query's answer:
    // a finished, empty list.
    expect(heldMenuSource(ready([]), false, [])).toEqual({ status: "loading", entries: [] });
  });

  it("keeps the last rows while the next query's answer is behind the draft", () => {
    expect(heldMenuSource(ready(["src"]), false, ["src"])).toEqual({
      status: "loading",
      entries: ["src"],
    });
  });

  it("keeps the last rows while the next query's atom is still in flight", () => {
    expect(heldMenuSource(inFlight, true, ["src"])).toEqual({
      status: "loading",
      entries: ["src"],
    });
    expect(heldMenuSource(inFlight, true, [])).toEqual({ status: "loading", entries: [] });
  });

  it("shows the answer once it has caught up with the draft", () => {
    expect(heldMenuSource(ready(["docs"]), true, ["src"])).toEqual(ready(["docs"]));
    expect(heldMenuSource(ready([]), true, ["src"])).toEqual(ready([]));
    const failed = { status: "failed" as const, entries: [] as ReadonlyArray<string> };
    expect(heldMenuSource(failed, true, ["src"])).toEqual(failed);
  });
});

describe("fileMenuEmptyLabel", () => {
  it("says what the # menu is doing when it lists no files", () => {
    expect(fileMenuEmptyLabel("loading")).toBe("Searching…");
    expect(fileMenuEmptyLabel("failed")).toBe("Could not search files");
    expect(fileMenuEmptyLabel("ready")).toBe("No files match");
  });
});

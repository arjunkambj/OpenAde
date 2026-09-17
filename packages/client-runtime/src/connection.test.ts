/**
 * The half of the reconnect supervisor that decides whether the client is
 * looking at the same server it was before.
 *
 * Getting this wrong is expensive in both directions: keep an id the server
 * no longer has and every subscription resumes from a sequence the new
 * instance never issued; drop it on an ordinary socket drop and every
 * subscription resnapshots on every blip.
 */

import { describe, expect, it } from "@effect/vitest";

import { retainedInstanceId } from "./connection";

describe("retainedInstanceId", () => {
  it("keeps the boot id across a plain reconnect to the same server", () => {
    expect(retainedInstanceId("boot-1", "boot-1")).toBe("boot-1");
  });

  it("drops the boot id when the channel reports a different server", () => {
    // The supervisor restarted the server: the cached snapshots belong to an
    // instance that is gone, so the next subscribe must resnapshot.
    expect(retainedInstanceId("boot-1", "boot-2")).toBeNull();
  });

  it("keeps the boot id when the channel does not know one", () => {
    // `?server=&token=` carries no instance id; silence is not a restart.
    expect(retainedInstanceId("boot-1", undefined)).toBe("boot-1");
  });

  it("stays null until a connected server reports its id", () => {
    expect(retainedInstanceId(null, undefined)).toBeNull();
    // Nothing to invalidate yet — `markConnected` records the id off
    // `server.hello`, not off the channel that resolved the credentials.
    expect(retainedInstanceId(null, "boot-2")).toBeNull();
  });
});

/**
 * Two halves of the reconnect supervisor:
 *
 * - whether the client is looking at the same server it was before. Getting
 *   this wrong is expensive in both directions: keep an id the server no
 *   longer has and every subscription resumes from a sequence the new instance
 *   never issued; drop it on an ordinary socket drop and every subscription
 *   resnapshots on every blip.
 * - what it does when the window opened before any server existed, which is
 *   the ordinary desktop cold start.
 */

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { makeConnection, retainedInstanceId, type ConnectionCredentials } from "./connection";

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

/**
 * A socket that never opens. The claim under test is which url the supervisor
 * dialled once credentials appeared, not anything that came back over it.
 */
const deadSocket = (): globalThis.WebSocket =>
  ({
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    send: () => undefined,
    close: () => undefined,
    readyState: 0,
    binaryType: "arraybuffer",
  }) as unknown as globalThis.WebSocket;

describe("makeConnection with no boot credentials", () => {
  it.live("dials the server the supervisor publishes after the window opened", () => {
    // The desktop shell creates its window without waiting for the server, so
    // the renderer's first resolve attempts find no channel with a port yet.
    // The connection must stay a live attempt loop through that, not collapse
    // into an offline runtime the user can only escape by reloading.
    let announce: ((url: string) => void) | undefined;
    const dialled = new Promise<string>((resolve) => {
      announce = resolve;
    });
    const ready: ConnectionCredentials = {
      url: "ws://127.0.0.1:4242/ws",
      token: "token minted at boot",
    };
    return Effect.scoped(
      Effect.gen(function* () {
        const attemptsLeft = yield* Ref.make(2);
        const resolve = Effect.gen(function* () {
          const before = yield* Ref.getAndUpdate(attemptsLeft, (left) =>
            left === 0 ? 0 : left - 1,
          );
          return before === 0 ? ready : null;
        });
        yield* Layer.build(
          makeConnection({
            resolve,
            webSocketConstructor: (url) => {
              announce?.(url);
              return deadSocket();
            },
          }),
        );
        expect(yield* Effect.promise(() => dialled)).toBe(
          "ws://127.0.0.1:4242/ws?token=token%20minted%20at%20boot",
        );
        // And it really did wait for the channel rather than dialling a
        // placeholder first.
        expect(yield* Ref.get(attemptsLeft)).toBe(0);
      }),
    );
  });
});

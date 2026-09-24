/**
 * The Poseidon server entrypoint.
 *
 * Only what belongs to a process lives here: reading the arguments and the
 * environment, handing them to `boot`, and staying alive until the runtime
 * tears the scope down. The graph itself is `./boot`, so a test can build the
 * real server without a child process.
 */

import * as Effect from "effect/Effect";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import { boot } from "./boot";

const DEV = process.env.POSEIDON_DEV === "1" || process.argv.includes("--dev");
const PORT = Number.parseInt(process.env.POSEIDON_PORT ?? "0", 10);

NodeRuntime.runMain(
  Effect.scoped(
    // `home` is left to the environment: `POSEIDON_HOME` is what the desktop
    // shell, the dev scripts and the tests all set.
    Effect.andThen(boot({ dev: DEV, port: Number.isNaN(PORT) ? 0 : PORT }), Effect.never),
  ),
);

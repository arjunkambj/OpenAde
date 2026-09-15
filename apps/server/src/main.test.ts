import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { configDir } from "@OpenAde/shared/paths";

describe("server", () => {
  it.effect("resolves the OpenAde config directory through @OpenAde/shared", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.sync(() => configDir({ OPENADE_HOME: "/tmp/openade-server-test" }));
      expect(dir).toBe("/tmp/openade-server-test");
    }),
  );
});

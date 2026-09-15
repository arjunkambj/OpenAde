import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PACKAGE_NAME } from "./meta";

describe("@OpenAde/client-runtime", () => {
  it.effect("is wired into the workspace", () =>
    Effect.gen(function* () {
      const name = yield* Effect.succeed(PACKAGE_NAME);
      expect(name).toBe("@OpenAde/client-runtime");
    }),
  );
});

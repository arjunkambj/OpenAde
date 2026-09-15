import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DEFAULT_RUNTIME_MODE } from "./enums";
import {
  CmdConnectorConfig,
  ConnectorInstanceConfig,
  DEFAULT_KEYBINDINGS,
  Keybinding,
  PermissionRule,
  Settings,
  defaultSettings,
} from "./settings";

/** Every field of a struct, with the `settingsForm` annotation it carries. */
const formAnnotations = (struct: Schema.Struct<Schema.Struct.Fields>) =>
  Object.entries(struct.fields).map(([name, field]) => [
    name,
    field.ast.context?.annotations?.["settingsForm"],
  ]);

describe("defaultSettings", () => {
  it.effect("asks before acting, like DEFAULT_RUNTIME_MODE says", () =>
    Effect.gen(function* () {
      const settings = yield* Effect.sync(defaultSettings);
      expect(DEFAULT_RUNTIME_MODE).toBe("approval-required");
      expect(settings.defaults.runtimeMode).toBe("approval-required");
    }),
  );

  it.effect("is a valid Settings document", () =>
    Effect.gen(function* () {
      const settings = yield* Effect.sync(defaultSettings);
      const encoded = yield* Effect.sync(() => Schema.encodeUnknownSync(Settings)(settings));
      const decoded = yield* Effect.sync(() => Schema.decodeUnknownSync(Settings)(encoded));
      expect(decoded).toEqual(settings);
    }),
  );

  it.effect("configures no connector, so it names no model", () =>
    Effect.gen(function* () {
      const settings = yield* Effect.sync(defaultSettings);
      expect(settings.connectors).toEqual([]);
      expect(settings.defaults.model).toBeNull();
    }),
  );
});

describe("DEFAULT_KEYBINDINGS", () => {
  it.effect("binds the five shortcuts the shell promises", () =>
    Effect.gen(function* () {
      const bindings = yield* Effect.succeed(DEFAULT_KEYBINDINGS);
      const byCommand = new Map(bindings.map((binding) => [binding.command, binding.shortcut]));
      expect(byCommand.get("thread.new")).toBe("Cmd+N");
      expect(byCommand.get("commandPalette.toggle")).toBe("Cmd+K");
      expect(byCommand.get("composer.queue")).toBe("Cmd+Enter");
      expect(byCommand.get("thread.interrupt")).toBe("Escape");
      expect(byCommand.get("browserPane.toggle")).toBe("Cmd+Shift+B");
    }),
  );

  it.effect("decodes as Keybindings", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownSync(Schema.Array(Keybinding));
      const decoded = yield* Effect.sync(() => decode(DEFAULT_KEYBINDINGS));
      expect(decoded).toEqual(DEFAULT_KEYBINDINGS);
    }),
  );
});

describe("settingsForm annotations", () => {
  it.effect("cover every field the settings pages can reach", () =>
    Effect.gen(function* () {
      const structs = yield* Effect.succeed([
        ["Settings", Settings],
        ["ConnectorInstanceConfig", ConnectorInstanceConfig],
        ["PermissionRule", PermissionRule],
        ["CmdConnectorConfig", CmdConnectorConfig],
      ] as const);
      for (const [name, struct] of structs) {
        for (const [field, annotation] of formAnnotations(struct)) {
          expect(
            annotation,
            `${name}.${String(field)} has no settingsForm annotation`,
          ).toBeDefined();
        }
      }
    }),
  );

  it.effect("keeps the annotation out of the encoded document", () =>
    Effect.gen(function* () {
      const encoded = yield* Effect.sync(() =>
        Schema.encodeUnknownSync(Settings)(defaultSettings()),
      );
      expect(Object.keys(encoded as object).sort()).toEqual([
        "connectors",
        "defaults",
        "keybindings",
        "permissions",
        "theme",
      ]);
    }),
  );
});

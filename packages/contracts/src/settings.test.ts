import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DEFAULT_RUNTIME_MODE } from "./enums";
import {
  ConnectorInstanceConfig,
  DEFAULT_BRANCH_PREFIX,
  DEFAULT_FONT_SIZE,
  DEFAULT_KEYBINDINGS,
  Keybinding,
  MAX_FONT_SIZE,
  PermissionRule,
  Settings,
  defaultSettings,
  settingsFormFields,
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
  it.effect("binds every shortcut the shell promises", () =>
    Effect.gen(function* () {
      const bindings = yield* Effect.succeed(DEFAULT_KEYBINDINGS);
      const byCommand = new Map(bindings.map((binding) => [binding.command, binding.shortcut]));
      expect(byCommand.get("thread.new")).toBe("Cmd+N");
      expect(byCommand.get("commandPalette.toggle")).toBe("Cmd+K");
      expect(byCommand.get("composer.queue")).toBe("Cmd+Enter");
      expect(byCommand.get("thread.interrupt")).toBe("Escape");
      expect(byCommand.get("browserPane.toggle")).toBe("Cmd+Shift+B");
      expect(byCommand.get("sidebar.toggle")).toBe("Cmd+B");
      expect(byCommand.get("skills.open")).toBe("Cmd+Shift+S");
      expect(byCommand.get("settings.open")).toBe("Cmd+,");
      expect(byCommand.get("terminal.toggle")).toBe("Cmd+J");
    }),
  );

  it.effect("binds each command once", () =>
    Effect.gen(function* () {
      const bindings = yield* Effect.succeed(DEFAULT_KEYBINDINGS);
      const commands = bindings.map((binding) => binding.command);
      expect(new Set(commands).size).toBe(commands.length);
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

  it.effect("settingsFormFields reads them in declaration order, optionality included", () =>
    Effect.gen(function* () {
      const fields = yield* Effect.sync(() => settingsFormFields(ConnectorInstanceConfig));
      expect(fields.map((field) => [field.key, field.control, field.optional])).toEqual([
        ["connectorInstanceId", "hidden", false],
        ["kind", "select", false],
        ["displayName", "text", false],
        ["enabled", "toggle", false],
        ["config", "hidden", false],
      ]);
      expect(fields[2]).toEqual({
        key: "displayName",
        label: "Name",
        description: "How this instance is listed in the model picker.",
        control: "text",
        optional: false,
      });
      const rule = settingsFormFields(PermissionRule);
      expect(rule.find((field) => field.key === "projectId")?.optional).toBe(true);
      expect(rule.find((field) => field.key === "pattern")?.placeholder).toBe("Shell(npm run *)");
    }),
  );

  it.effect("settingsFormFields leaves out a field nothing says how to render", () =>
    Effect.gen(function* () {
      const fields = yield* Effect.sync(() =>
        settingsFormFields(Schema.Struct({ bare: Schema.String })),
      );
      expect(fields).toEqual([]);
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
        "git",
        "keybindings",
        "mainFontSize",
        "permissions",
        "projectSettings",
        "sidebarFontSize",
        "theme",
      ]);
    }),
  );
});

describe("font sizes", () => {
  it.effect("default to 14 px when a stored document predates them", () =>
    Effect.gen(function* () {
      const {
        mainFontSize: _main,
        sidebarFontSize: _sidebar,
        ...older
      } = Schema.encodeUnknownSync(Settings)(defaultSettings()) as Record<string, unknown>;
      const decoded = yield* Schema.decodeUnknownEffect(Settings)(older);
      expect(decoded.mainFontSize).toBe(DEFAULT_FONT_SIZE);
      expect(decoded.sidebarFontSize).toBe(DEFAULT_FONT_SIZE);
    }),
  );

  it.effect("reject a size outside the px range", () =>
    Effect.gen(function* () {
      const tooBig = { ...defaultSettings(), mainFontSize: MAX_FONT_SIZE + 1 };
      const exit = yield* Effect.exit(Schema.decodeUnknownEffect(Settings)(tooBig));
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("accept half-px steps and reject anything finer", () =>
    Effect.gen(function* () {
      const half = { ...defaultSettings(), mainFontSize: 14.5 };
      const decoded = yield* Schema.decodeUnknownEffect(Settings)(half);
      expect(decoded.mainFontSize).toBe(14.5);
      const finer = { ...defaultSettings(), sidebarFontSize: 14.25 };
      const exit = yield* Effect.exit(Schema.decodeUnknownEffect(Settings)(finer));
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("git settings", () => {
  it.effect("default to the openade/ prefix and no project settings when a row predates them", () =>
    Effect.gen(function* () {
      const {
        git: _git,
        projectSettings: _projects,
        ...older
      } = Schema.encodeUnknownSync(Settings)(defaultSettings()) as Record<string, unknown>;
      const decoded = yield* Schema.decodeUnknownEffect(Settings)(older);
      expect(decoded.git).toEqual({ branchPrefix: DEFAULT_BRANCH_PREFIX });
      expect(DEFAULT_BRANCH_PREFIX).toBe("openade/");
      expect(decoded.projectSettings).toEqual({});
    }),
  );

  it.effect("carry a project's setup script and an empty prefix through a round-trip", () =>
    Effect.gen(function* () {
      const settings = {
        ...defaultSettings(),
        git: { branchPrefix: "" },
        projectSettings: { "0199c0de-0001-7000-8000-000000000001": { setupScript: "pnpm i" } },
      };
      const encoded = Schema.encodeUnknownSync(Settings)(settings);
      const decoded = yield* Schema.decodeUnknownEffect(Settings)(encoded);
      expect(decoded).toEqual(settings);
    }),
  );

  it.effect("hide both from the generic form: a page of their own renders them", () =>
    Effect.gen(function* () {
      const fields = yield* Effect.sync(() => settingsFormFields(Settings));
      const hidden = fields.filter((field) => field.control === "hidden").map((field) => field.key);
      expect(hidden).toContain("git");
      expect(hidden).toContain("projectSettings");
    }),
  );
});

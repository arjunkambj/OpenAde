import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";

import { binDir, configDir, configPath, databasePath, devConnectionPath } from "./paths";

describe("configDir", () => {
  it("defaults to ~/.openade", () => {
    expect(configDir({})).toBe(NodePath.join(NodeOS.homedir(), ".openade"));
  });

  it("honours OPENADE_HOME and resolves it to an absolute path", () => {
    const home = NodePath.join(NodeOS.tmpdir(), "openade-test-home");
    expect(configDir({ OPENADE_HOME: home })).toBe(home);
    expect(NodePath.isAbsolute(configDir({ OPENADE_HOME: "relative/home" }))).toBe(true);
  });

  it("ignores a blank override", () => {
    expect(configDir({ OPENADE_HOME: "   " })).toBe(configDir({}));
  });
});

describe("well-known paths", () => {
  const env = { OPENADE_HOME: NodePath.join(NodeOS.tmpdir(), "openade-test-home") };

  it("hang off the configuration directory", () => {
    expect(configPath(["a", "b"], env)).toBe(NodePath.join(configDir(env), "a", "b"));
    expect(databasePath(env)).toBe(NodePath.join(configDir(env), "openade.db"));
    expect(binDir(env)).toBe(NodePath.join(configDir(env), "bin"));
    expect(devConnectionPath(env)).toBe(NodePath.join(configDir(env), "dev", "connection.json"));
  });
});

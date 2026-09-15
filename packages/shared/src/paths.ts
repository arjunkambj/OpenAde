import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Where OpenAde keeps everything it owns on disk: the SQLite database, the
 * generated Command Code hook script, the dev connection file. `~/.openade` by
 * default; set `OPENADE_HOME` to point a test, a sandbox or a second install
 * somewhere else.
 */

export const CONFIG_DIR_NAME = ".openade";

export const OPENADE_HOME_ENV = "OPENADE_HOME";

type Env = Readonly<Record<string, string | undefined>>;

const defaultEnv = (): Env => globalThis.process?.env ?? {};

/** Absolute path of the OpenAde configuration directory. */
export const configDir = (env: Env = defaultEnv()): string => {
  const override = env[OPENADE_HOME_ENV]?.trim();
  if (override !== undefined && override !== "") {
    return NodePath.resolve(override);
  }
  return NodePath.join(NodeOS.homedir(), CONFIG_DIR_NAME);
};

/** Joins `segments` onto the configuration directory. */
export const configPath = (segments: ReadonlyArray<string>, env: Env = defaultEnv()): string =>
  NodePath.join(configDir(env), ...segments);

/** The SQLite database the server owns. */
export const databasePath = (env: Env = defaultEnv()): string => configPath(["state.sqlite"], env);

/** Directory for generated executables, such as the Command Code hook script. */
export const binDir = (env: Env = defaultEnv()): string => configPath(["bin"], env);

/** Dev-mode connection descriptor written by `apps/server` (decision D3). */
export const devConnectionPath = (env: Env = defaultEnv()): string =>
  configPath(["dev", "connection.json"], env);

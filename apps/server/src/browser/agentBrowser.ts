/**
 * The `agent-browser` CLI: binary discovery, the browser bridge handoff, one
 * `--json` invocation against a named session, and the envelope parse.
 *
 * Everything here is argv-form `execFile` — never a shell. A session is just a
 * `--session <name>` argument; the Rust daemon underneath persists between
 * invocations, which is what makes per-call CLI commands cheap.
 *
 * Which browser a session drives is decided once, at layer build, from what
 * the desktop shell handed over (`bridgeConfig`):
 *
 * - **in-app** — the shell runs the browser bridge and gave us its origin and
 *   launch key. A thread's session carries its bridge URL in
 *   `AGENT_BROWSER_CDP`, so the daemon drives that thread's pane webviews and
 *   nothing else. The URL is a capability and never goes in argv, where any
 *   local process can read it.
 * - **disabled** — the shell ran with `OPENADE_REMOTE_DEBUG=0`. There is no
 *   bridge and no fallback: every call reports the in-app browser disabled.
 * - **owned-chromium** — no desktop at all (the web renderer, or
 *   `pnpm -F server dev`): agent-browser runs its own headless Chrome.
 *
 * Discovery order: `OPENADE_AGENT_BROWSER` → `agent-browser` on PATH. The probe
 * runs `--version` once at layer build; a missing binary is not fatal — the
 * service reports `binary: null` and every exec fails with
 * `AgentBrowserUnavailable`, which the pane renders as an install prompt.
 */

import { execFile } from "node:child_process";

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { BrowserState } from "@OpenAde/contracts/rpc";
import {
  BRIDGE_DISABLED,
  BRIDGE_ENV,
  BRIDGE_KEY_ENV,
  bridgeThreadUrl,
} from "@OpenAde/shared/browserBridge";

/**
 * What the pane reads when the binary is missing. The renderer keys its
 * install prompt off this exact opening clause (see
 * `apps/web/src/components/panes/browser/install.ts`), so it is one constant
 * here rather than a sentence written twice.
 */
export const AGENT_BROWSER_MISSING_MESSAGE =
  "agent-browser is not installed. Install it with `npm install -g agent-browser`, " +
  "then run `agent-browser install`.";

/** What every browser tool answers while the shell has the bridge switched off. */
export const BROWSER_DISABLED_MESSAGE = "the in-app browser is disabled (OPENADE_REMOTE_DEBUG=0)";

/** The daemon session name for a thread — `ade-<threadId>`. */
export const sessionNameFor = (threadId: string): string => `ade-${threadId}`;

/** Every call gets this long before the child is SIGKILLed (spec: 30s ceiling). */
const COMMAND_TIMEOUT_MS = 30_000;

/** A daemon exits this long after its last command if we never close it. */
export const IDLE_TIMEOUT_MS = 300_000;

/**
 * The env one session's invocations run with, beyond the allowlist.
 *
 * The idle timeout is the safety net behind `close`: a daemon we never got to
 * close (a crashed server) still reaps itself.
 */
export const sessionEnvFor = (
  extra?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => ({
  AGENT_BROWSER_IDLE_TIMEOUT_MS: String(IDLE_TIMEOUT_MS),
  ...extra,
});

/**
 * What the `agent-browser` child — and the Chromium it drives — may inherit.
 *
 * The connector keeps the harness's environment to a named allowlist for
 * exactly one reason, and `agent-browser` is the component that then visits
 * untrusted web pages: it is a third-party CLI with an auto-connect, a plugin
 * system and an auth vault of its own. So the operator's `ANTHROPIC_*` and
 * `OPENAI_*` keys, `AWS_*`, `GITHUB_TOKEN` and every `OPENADE_*` control-plane
 * variable stay out.
 *
 * So do the operator's own `AGENT_BROWSER_*` and `CHROME_*`. They used to pass
 * by prefix, and several of them redirect or loosen the child:
 * `AGENT_BROWSER_CDP` points the daemon at another browser,
 * `AGENT_BROWSER_AUTO_CONNECT` makes it go looking for one, and
 * `AGENT_BROWSER_ALLOW_FILE_ACCESS` lets pages read local files. The only
 * `AGENT_BROWSER_*` values the child sees are the ones this module sets.
 *
 * The list is here rather than shared with `packages/connector-cmd/src/spawn.ts`
 * because the two children need different things: this one wants the display
 * variables a browser needs, and none of the harness's credential variables.
 */
const BROWSER_ENV = new Set([
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  // A Chrome that has to find a display: X11 and Wayland on Linux, and the
  // per-session bootstrap socket on macOS.
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XAUTHORITY",
]);

const INHERITED_PREFIXES = ["LC_"];

/** Names only we may set: `extra` passes them, the inherited env never does. */
const OWN_PREFIX = "AGENT_BROWSER_";

/** The environment one invocation runs with: the allowlist, plus our own. */
export const browserEnv = (
  env: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => {
  const inherited = (name: string): boolean =>
    BROWSER_ENV.has(name) || INHERITED_PREFIXES.some((prefix) => name.startsWith(prefix));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && inherited(name)) {
      out[name] = value;
    }
  }
  // `extra` is ours — the idle timeout, the bridge URL — and is not filtered
  // out from under itself, but it cannot smuggle a name the list refuses either.
  for (const [name, value] of Object.entries(extra)) {
    if (inherited(name) || name.startsWith(OWN_PREFIX)) {
      out[name] = value;
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// The bridge handoff

/**
 * What the desktop shell told us about the browser bridge: where it is and the
 * launch key to mint thread URLs with, that it is switched off, or — `null` —
 * nothing, because there is no shell.
 */
export type BridgeConfig =
  | { readonly base: string; readonly key: string }
  | typeof BRIDGE_DISABLED
  | null;

const LAUNCH_KEY = /^[0-9a-f]{64}$/;

/**
 * Reads the bridge handoff out of an environment.
 *
 * A shell that announced a bridge but handed over something unusable (no key,
 * a key of the wrong shape, an origin that is not loopback) gets `disabled`,
 * not `null`: `null` means owned Chromium, and a desktop must never fall back
 * to a headless browser the user cannot see.
 */
export const readBridgeConfig = (
  env: Readonly<Record<string, string | undefined>>,
): BridgeConfig => {
  const base = env[BRIDGE_ENV]?.trim();
  if (base === undefined || base === "") return null;
  if (base === BRIDGE_DISABLED) return BRIDGE_DISABLED;
  const key = env[BRIDGE_KEY_ENV]?.trim() ?? "";
  if (!LAUNCH_KEY.test(key)) return BRIDGE_DISABLED;
  try {
    bridgeThreadUrl(base, key, "probe");
  } catch {
    return BRIDGE_DISABLED;
  }
  return { base, key };
};

/**
 * Reads the handoff and removes it from `env`, so nothing this process spawns
 * later — a terminal, a harness — inherits the launch key. The harness spawn
 * drops the `OPENADE_SERVER_` prefix as well; this is the belt to that brace.
 */
export const takeBridgeConfig = (env: Record<string, string | undefined>): BridgeConfig => {
  const config = readBridgeConfig(env);
  delete env[BRIDGE_ENV];
  delete env[BRIDGE_KEY_ENV];
  return config;
};

/** The service's mode, as `BrowserState` reports it, for a handoff. */
export const modeFor = (bridge: BridgeConfig): BrowserState["mode"] =>
  bridge === null ? "owned-chromium" : bridge === BRIDGE_DISABLED ? "disabled" : "in-app";

// ---------------------------------------------------------------------------
// One invocation

const Envelope = Schema.Struct({
  success: Schema.Boolean,
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeEnvelope = Schema.decodeUnknownExit(Schema.fromJsonString(Envelope));

/** The CLI ran and reported failure (`success: false`), or could not be run. */
export class AgentBrowserError extends Data.TaggedError("AgentBrowserError")<{
  readonly command: string;
  readonly message: string;
  /** How the daemon classified the failure — e.g. `tab_gone`. */
  readonly code: string | null;
  readonly data: unknown;
}> {}

/** The binary is not installed — the pane shows the install prompt. */
export class AgentBrowserUnavailable extends Data.TaggedError("AgentBrowserUnavailable")<{
  readonly message: string;
}> {}

/** What one child run left behind; `error` is set when it exited non-zero or died. */
export interface ChildResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string | null;
}

/**
 * Runs the binary once. Tests replace it to replay recorded envelopes and to
 * see exactly what argv and env the child would have got.
 */
export type ChildRunner = (
  binary: string,
  args: ReadonlyArray<string>,
  options: { readonly env: Record<string, string>; readonly timeoutMs: number },
) => Effect.Effect<ChildResult>;

const runChild: ChildRunner = (binary, args, options) =>
  Effect.callback<ChildResult>((resume) => {
    const child = execFile(
      binary,
      [...args],
      {
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        env: options.env,
      },
      (error, stdout, stderr) =>
        resume(
          Effect.succeed({
            stdout: String(stdout),
            stderr: String(stderr),
            error: error === null ? null : error.message,
          }),
        ),
    );
    return Effect.sync(() => child.kill("SIGKILL"));
  });

/**
 * The daemon's failure class. `data.code` when it sets one; a pinned session
 * whose tab is gone says so only in its message — `tab_gone: bound tab is
 * gone (…)` with `data: {targetId, lastUrl}` (recorded in
 * `packages/testkit/fixtures/agent-browser/cli-tab-gone`).
 */
const codeOf = (error: string | null | undefined, data: unknown): string | null => {
  if (typeof data === "object" && data !== null && "code" in data) {
    return String((data as { code: unknown }).code);
  }
  const prefix = /^([a-z_]+):/.exec(error ?? "");
  return prefix?.[1] === "tab_gone" ? "tab_gone" : null;
};

const toRecord = (data: unknown): Record<string, unknown> =>
  typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : { value: data };

/** One child run's output as the command's result. */
export const decodeResult = (
  command: string,
  result: ChildResult,
): Effect.Effect<Record<string, unknown>, AgentBrowserError> => {
  const parsed = decodeEnvelope(result.stdout);
  if (Exit.isFailure(parsed)) {
    return Effect.fail(
      new AgentBrowserError({
        command,
        message:
          result.error !== null
            ? `${result.error}: ${result.stderr.trim()}`
            : `unparseable output: ${result.stdout.slice(0, 200)}`,
        code: null,
        data: null,
      }),
    );
  }
  const envelope = parsed.value;
  if (!envelope.success) {
    return Effect.fail(
      new AgentBrowserError({
        command,
        message: envelope.error ?? "agent-browser command failed",
        code: codeOf(envelope.error, envelope.data),
        data: envelope.data ?? null,
      }),
    );
  }
  return Effect.succeed(toRecord(envelope.data));
};

export interface ExecOptions {
  readonly timeoutMs?: number;
}

/** One thread's invocation channel: `agent-browser --session ade-<id> --json <argv>`. */
export interface AgentBrowserSession {
  readonly session: string;
  readonly exec: (
    argv: ReadonlyArray<string>,
    options?: ExecOptions,
  ) => Effect.Effect<Record<string, unknown>, AgentBrowserError | AgentBrowserUnavailable>;
}

export class AgentBrowser extends Context.Service<
  AgentBrowser,
  {
    /** Absolute path or bare name when found, `null` when the probe failed. */
    readonly binary: string | null;
    readonly version: string | null;
    /** Which browser every session drives; fixed for the server's life. */
    readonly mode: BrowserState["mode"];
    /** The thread's session: its own bridge URL in in-app mode. */
    readonly session: (threadId: string) => AgentBrowserSession;
  }
>()("server/browser/AgentBrowser") {
  static readonly layer = Layer.effect(
    AgentBrowser,
    Effect.gen(function* () {
      const announced = process.env[BRIDGE_ENV]?.trim();
      const bridge = takeBridgeConfig(process.env);
      if (bridge === BRIDGE_DISABLED && announced !== BRIDGE_DISABLED) {
        yield* Effect.logWarning("browser: the shell's bridge handoff was unusable; disabled");
      }
      const binaryOverride = process.env.OPENADE_AGENT_BROWSER?.trim();
      const probe = yield* runChild(binaryOverride ?? "agent-browser", ["--version"], {
        env: browserEnv(process.env),
        timeoutMs: 10_000,
      });
      const found = probe.error === null;
      return makeAgentBrowser({
        binary: binaryOverride ?? (found ? "agent-browser" : null),
        version: found ? probe.stdout.trim() : null,
        bridge,
      });
    }),
  );
}

/**
 * The service over an explicit binary, handoff and runner. The layer builds it
 * from the process; tests build it over a recording.
 */
export const makeAgentBrowser = (options: {
  readonly binary: string | null;
  readonly version: string | null;
  readonly bridge: BridgeConfig;
  /** The environment the allowlist filters; the server's own by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run?: ChildRunner;
}): AgentBrowser["Service"] => {
  const run = options.run ?? runChild;
  const bridge = options.bridge;

  const session = (threadId: string): AgentBrowserSession => {
    const name = sessionNameFor(threadId);
    const exec = (
      argv: ReadonlyArray<string>,
      execOptions: ExecOptions = {},
    ): Effect.Effect<Record<string, unknown>, AgentBrowserError | AgentBrowserUnavailable> =>
      Effect.suspend(
        (): Effect.Effect<Record<string, unknown>, AgentBrowserError | AgentBrowserUnavailable> => {
          const binary = options.binary;
          if (binary === null) {
            return Effect.fail(
              new AgentBrowserUnavailable({ message: AGENT_BROWSER_MISSING_MESSAGE }),
            );
          }
          const command = `agent-browser ${argv.join(" ")}`;
          if (bridge === BRIDGE_DISABLED) {
            return Effect.fail(
              new AgentBrowserError({
                command,
                message: BROWSER_DISABLED_MESSAGE,
                code: null,
                data: null,
              }),
            );
          }
          // The bridge URL goes in the child's env, never its argv.
          let cdp: Record<string, string> = {};
          if (bridge !== null) {
            try {
              cdp = { AGENT_BROWSER_CDP: bridgeThreadUrl(bridge.base, bridge.key, threadId) };
            } catch (error) {
              return Effect.fail(
                new AgentBrowserError({ command, message: String(error), code: null, data: null }),
              );
            }
          }
          const env = browserEnv(options.env ?? process.env, sessionEnvFor(cdp));
          return run(binary, ["--session", name, "--json", ...argv], {
            env,
            timeoutMs: execOptions.timeoutMs ?? COMMAND_TIMEOUT_MS,
          }).pipe(Effect.flatMap((result) => decodeResult(command, result)));
        },
      );
    return { session: name, exec };
  };

  return AgentBrowser.of({
    binary: options.binary,
    version: options.version,
    mode: modeFor(bridge),
    session,
  });
};

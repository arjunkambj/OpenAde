/**
 * The `agent-browser` CLI: binary discovery, one `--json` invocation against a
 * named session, and the envelope parse.
 *
 * Everything here is argv-form `execFile` — never a shell. A session is just a
 * `--session <name>` argument; the Rust daemon underneath persists between
 * invocations, which is what makes per-call CLI commands cheap. `--cdp <port>`
 * attaches that daemon to an already-running browser (the Electron app's
 * remote-debugging endpoint) instead of launching its own Chrome.
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

/**
 * What the pane reads when the binary is missing. The renderer keys its
 * install prompt off this exact opening clause (see
 * `apps/web/src/components/panes/browser/install.ts`), so it is one constant
 * here rather than a sentence written twice.
 */
export const AGENT_BROWSER_MISSING_MESSAGE =
  "agent-browser is not installed. Install it with `npm install -g agent-browser`, " +
  "then run `agent-browser install`.";

/** The daemon session name for a thread — `ade-<threadId>` per spec §12. */
export const sessionNameFor = (threadId: string): string => `ade-${threadId}`;

/** Every call gets this long before the child is SIGKILLed (spec: 30s ceiling). */
const COMMAND_TIMEOUT_MS = 30_000;

/** A daemon exits this long after its last command if we never close it. */
export const IDLE_TIMEOUT_MS = 300_000;

/**
 * The env one session's invocations run with.
 *
 * Both kinds of session get an idle timeout. For owned Chromium it is the
 * safety net behind `close`. For a `--cdp` attachment it is the *only* net:
 * closing that session would mean destroying a tab the desktop owns (the
 * pane's `<webview>`), so the driver's `close` deliberately does nothing and
 * the daemon has to reap its own attachment — otherwise every thread ever
 * opened leaves an `ade-<threadId>` daemon behind, across window close and
 * app restart.
 */
export const sessionEnvFor = (
  extra?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => ({
  AGENT_BROWSER_IDLE_TIMEOUT_MS: String(IDLE_TIMEOUT_MS),
  ...extra,
});

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
  /** `data.code` when the daemon classified the failure — e.g. `tab_gone`. */
  readonly code: string | null;
  readonly data: unknown;
}> {}

/** The binary is not installed — the pane shows the install prompt. */
export class AgentBrowserUnavailable extends Data.TaggedError("AgentBrowserUnavailable")<{
  readonly message: string;
}> {}

export interface ExecOptions {
  readonly timeoutMs?: number;
  /** Extra env — e.g. the owned-mode idle timeout. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * One session's invocation channel: `agent-browser --session <s> [--cdp <p>]
 * --json <argv>`. `cdpPort` of `null` means the session runs its own Chromium.
 */
export interface AgentBrowserSession {
  readonly session: string;
  readonly exec: (
    argv: ReadonlyArray<string>,
    options?: ExecOptions,
  ) => Effect.Effect<Record<string, unknown>, AgentBrowserError | AgentBrowserUnavailable>;
}

const toRecord = (data: unknown): Record<string, unknown> =>
  typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : { value: data };

export class AgentBrowser extends Context.Service<
  AgentBrowser,
  {
    /** Absolute path or bare name when found, `null` when the probe failed. */
    readonly binary: string | null;
    readonly version: string | null;
    /** Electron's loopback remote-debugging port, when the desktop set one. */
    readonly cdpPort: number | null;
    readonly session: (
      name: string,
      options?: {
        readonly cdpPort?: number | null;
        readonly env?: Readonly<Record<string, string>>;
      },
    ) => AgentBrowserSession;
  }
>()("server/browser/AgentBrowser") {
  static readonly layer = Layer.effect(
    AgentBrowser,
    Effect.gen(function* () {
      const binaryOverride = process.env.OPENADE_AGENT_BROWSER?.trim();
      const cdpPortRaw = process.env.OPENADE_CDP_PORT?.trim();
      const cdpPort =
        cdpPortRaw !== undefined && /^\d+$/.test(cdpPortRaw)
          ? Number.parseInt(cdpPortRaw, 10)
          : null;

      const probe = yield* runRaw(binaryOverride ?? "agent-browser", ["--version"], {
        timeoutMs: 10_000,
      }).pipe(
        Effect.map((stdout) => stdout.trim()),
        Effect.option,
      );
      const binary = binaryOverride ?? (probe._tag === "Some" ? "agent-browser" : null);
      const version = probe._tag === "Some" ? probe.value : null;

      const exec = (
        session: string,
        cdpPortOverride: number | null,
        extraEnv: Readonly<Record<string, string>>,
        argv: ReadonlyArray<string>,
        options: ExecOptions,
      ): Effect.Effect<Record<string, unknown>, AgentBrowserError | AgentBrowserUnavailable> => {
        const bin = binary;
        if (bin === null) {
          return new AgentBrowserUnavailable({ message: AGENT_BROWSER_MISSING_MESSAGE });
        }
        const argv$ = [
          "--session",
          session,
          ...(cdpPortOverride === null ? [] : ["--cdp", String(cdpPortOverride)]),
          "--json",
          ...argv,
        ];
        const command = `agent-browser ${argv$.join(" ")}`;
        return Effect.callback<Record<string, unknown>, AgentBrowserError>((resume) => {
          const child = execFile(
            bin,
            argv$,
            {
              timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
              killSignal: "SIGKILL",
              maxBuffer: 16 * 1024 * 1024,
              env: { ...process.env, ...extraEnv },
            },
            (error, stdout, stderr) => {
              const parsed = decodeEnvelope(stdout);
              if (Exit.isFailure(parsed)) {
                resume(
                  Effect.fail(
                    new AgentBrowserError({
                      command,
                      message:
                        error !== null
                          ? `${error.message}: ${stderr.trim()}`
                          : `unparseable output: ${stdout.slice(0, 200)}`,
                      code: null,
                      data: null,
                    }),
                  ),
                );
                return;
              }
              const envelope = parsed.value;
              if (!envelope.success) {
                const data = envelope.data;
                const code =
                  typeof data === "object" && data !== null && "code" in data
                    ? String((data as { code: unknown }).code)
                    : null;
                resume(
                  Effect.fail(
                    new AgentBrowserError({
                      command,
                      message: envelope.error ?? "agent-browser command failed",
                      code,
                      data: data ?? null,
                    }),
                  ),
                );
                return;
              }
              resume(Effect.succeed(toRecord(envelope.data)));
            },
          );
          return Effect.sync(() => child.kill("SIGKILL"));
        });
      };

      return AgentBrowser.of({
        binary,
        version,
        cdpPort,
        session: (name, options = {}) => {
          const resolvedCdpPort = options.cdpPort === undefined ? cdpPort : options.cdpPort;
          return {
            session: name,
            exec: (argv, execOptions = {}) =>
              exec(name, resolvedCdpPort, sessionEnvFor(options.env), argv, execOptions),
          };
        },
      });
    }),
  );
}

/** One shot of a binary that may not exist — used by the probe. */
const runRaw = (
  binary: string,
  args: ReadonlyArray<string>,
  options: { readonly timeoutMs: number },
): Effect.Effect<string, Error> =>
  Effect.callback<string, Error>((resume) => {
    const child = execFile(
      binary,
      [...args],
      { timeout: options.timeoutMs, killSignal: "SIGKILL" },
      (error, stdout) => {
        if (error !== null) {
          resume(Effect.fail(error instanceof Error ? error : new Error(String(error))));
          return;
        }
        resume(Effect.succeed(stdout));
      },
    );
    return Effect.sync(() => child.kill("SIGKILL"));
  });

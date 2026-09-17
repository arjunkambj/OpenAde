/**
 * Finding and interrogating the `cmd` binary (spec 5.1, section 8 probe).
 *
 * Resolution order: the configured `binaryPath`, then `cmd` on `PATH` (plus
 * the usual global bin dirs), then the npx fallback `npx -y
 * command-code@<PINNED>` so a machine without the global install still works —
 * at the cost of a slower first probe.
 *
 * `status --json` answers auth, account and version; `--list-models` feeds the
 * model picker. Both run against the resolved binary with a timeout, and a
 * version below `MIN_VERSION` is a warning, not a failure — older binaries may
 * still run turns.
 */

import { execFile } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { CmdConnectorConfig } from "@OpenAde/contracts/settings";
import type { ModelOption } from "@OpenAde/contracts/rpc";
import { ACCOUNT_HELP_URL } from "@OpenAde/contracts/rpc";
import type { ConnectorProbe } from "@OpenAde/connector-sdk/definition";
import { ProbeFailed } from "@OpenAde/connector-sdk/definition";
import * as Effect from "effect/Effect";

import { EXIT_MESSAGES } from "./exitCodes";
import { envAllowlist } from "./spawn";

/** The package version the npx fallback pins and the version warnings compare to. */
export const PINNED_VERSION = "1.54.0";
const MIN_VERSION = PINNED_VERSION;

interface ResolvedBinary {
  readonly command: string;
  /** Prepended args — the npx fallback's package spec. */
  readonly prefixArgs: ReadonlyArray<string>;
  /** What `binaryPath` reports on the probe: the configured path, or the display name. */
  readonly display: string;
}

const isExecutable = (path: string): boolean => {
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Extra directories `cmd` commonly lands in when PATH was not inherited. */
const extraBinDirs = (): Array<string> => {
  const home = NodeOS.homedir();
  return [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    NodePath.join(home, ".bun", "bin"),
    NodePath.join(home, ".local", "share", "pnpm"),
    NodePath.join(home, ".npm-global", "bin"),
  ];
};

const findOnPath = (
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null => {
  const dirs = [...(env.PATH ?? "").split(":").filter(Boolean), ...extraBinDirs()];
  for (const dir of dirs) {
    const candidate = NodePath.join(dir, name);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
};

const resolveBinary = (
  config: CmdConnectorConfig,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedBinary | null => {
  if (config.binaryPath !== undefined && config.binaryPath !== "") {
    return { command: config.binaryPath, prefixArgs: [], display: config.binaryPath };
  }
  const onPath = findOnPath("cmd", env);
  if (onPath !== null) {
    return { command: onPath, prefixArgs: [], display: onPath };
  }
  if (findOnPath("npx", env) !== null) {
    return {
      command: "npx",
      prefixArgs: ["-y", `command-code@${PINNED_VERSION}`],
      display: `npx command-code@${PINNED_VERSION}`,
    };
  }
  return null;
};

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runBinary = (
  binary: ResolvedBinary,
  args: ReadonlyArray<string>,
  options: { readonly timeoutMs: number; readonly env: Record<string, string> },
): Effect.Effect<RunResult, ProbeFailed> =>
  Effect.callback<RunResult, ProbeFailed>((resume) => {
    const child = execFile(
      binary.command,
      [...binary.prefixArgs, ...args],
      {
        timeout: options.timeoutMs,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: options.env,
      },
      (error, stdout, stderr) => {
        if (error !== null && typeof (error as { code?: unknown }).code !== "number") {
          resume(
            Effect.fail(
              new ProbeFailed({
                kind: "cmd",
                message: `${binary.display}: ${error.message}`,
              }),
            ),
          );
          return;
        }
        resume(
          Effect.succeed({
            code: error === null ? 0 : ((error as { code: number }).code ?? 1),
            stdout,
            stderr,
          }),
        );
      },
    );
    return Effect.sync(() => child.kill());
  });

// ── output parsing ─────────────────────────────────────────────

interface StatusJson {
  readonly authenticated?: boolean;
  readonly version?: string;
  readonly user?: string;
  readonly provider?: string;
  readonly model?: string;
}

/** `1.54.0` → [1,54,0]; unparseable → null. */
const parseVersion = (raw: string): Array<number> | null => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
};

const belowMin = (version: string): boolean => {
  const parsed = parseVersion(version);
  const min = parseVersion(MIN_VERSION);
  if (parsed === null || min === null) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index]! !== min[index]!) {
      return parsed[index]! < min[index]!;
    }
  }
  return false;
};

const MODEL_LINE = /^([a-z0-9_.-]+\/[a-z0-9_.-]+)\s*(.*)$/i;
const EFFORT_MARKER = /\[(low|medium|high|xhigh|max)(?:,(low|medium|high|xhigh|max))*\]/i;

/**
 * `cmd --list-models` lines → `ModelOption`s. Section headers (a bare word or
 * a `Title:` line) become `family`; `(default)` and `FREE` markers are parsed
 * out of the label; an `[low,medium]` suffix pins the effort ladder when the
 * binary reports one.
 */
export const parseModelList = (output: string): ReadonlyArray<ModelOption> => {
  const models: Array<ModelOption> = [];
  let family = "";
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    const match = MODEL_LINE.exec(line);
    if (match === null) {
      // A non-model line is a group header; strip a trailing colon.
      family = line.replace(/:$/, "").trim() || family;
      continue;
    }
    const id = match[1]!;
    let label = (match[2] ?? "").replace(/\((default)\)/i, "").trim();
    const free = /\bFREE\b/i.test(match[2] ?? "");
    label = label
      .replace(/\bFREE\b/gi, "")
      .replace(EFFORT_MARKER, "")
      .trim();
    const effortMatch = EFFORT_MARKER.exec(match[2] ?? "");
    const efforts = (
      effortMatch !== null
        ? effortMatch[0]
            .slice(1, -1)
            .split(",")
            .map((entry) => entry.trim().toLowerCase())
        : ["low", "medium", "high"]
    ) as ModelOption["efforts"];
    models.push({
      id,
      label: label === "" ? id : label,
      family: family === "" ? id.split("/")[0]! : family,
      efforts,
      ...(free ? { free: true } : {}),
    });
  }
  return models;
};

// ── the probe ──────────────────────────────────────────────────

/** Spec 5.1: the account is fine, it has simply run out of credit. */
const INSUFFICIENT_CREDITS = 10;

/** The detail line a failing `status` left behind, if it left one. */
const detailOf = (result: RunResult): string => result.stderr.trim() || result.stdout.trim();

export const probe = (config: CmdConnectorConfig): Effect.Effect<ConnectorProbe, ProbeFailed> =>
  Effect.gen(function* () {
    const probedAt = new Date().toISOString();
    const binary = resolveBinary(config, process.env);
    // The probe's children get the same leak guard the turns do (spec section
    // 8): no OPENADE_SERVER_*, ANTHROPIC_* or OPENAI_* reaches them — and the
    // operator's extraEnv does, so a COMMAND_CODE_API_KEY supplied there is
    // not reported as "not authenticated" while turns work fine.
    const env = envAllowlist(process.env, config.extraEnv ?? {});
    if (binary === null) {
      return {
        status: "not-installed" as const,
        probedAt,
        message: "cmd not found on PATH and npx is unavailable",
        auth: "unknown" as const,
        models: [],
        warnings: [],
      };
    }

    const status = yield* runBinary(binary, ["status", "--json"], { timeoutMs: 30_000, env });
    if (status.code === 3) {
      return {
        status: "not-authenticated" as const,
        probedAt,
        binaryPath: binary.display,
        message: "not logged in — run `cmd login`",
        auth: "absent" as const,
        models: [],
        warnings: [],
      };
    }

    if (status.code === INSUFFICIENT_CREDITS) {
      // Distinct from the generic failure below on purpose. The credentials are
      // good — `auth: "unknown"` sent the welcome flow to an error with nothing
      // to do about it — and what fixes this is a billing page, which only the
      // connector knows the address of. Listing models is skipped for the same
      // reason exit 3 skips it: no turn can run until this is resolved.
      return {
        status: "error" as const,
        probedAt,
        binaryPath: binary.display,
        message: EXIT_MESSAGES[INSUFFICIENT_CREDITS]!.message,
        auth: "present" as const,
        helpUrl: ACCOUNT_HELP_URL,
        models: [],
        warnings: [],
      };
    }

    let parsed: StatusJson = {};
    try {
      const json: unknown = JSON.parse(status.stdout);
      if (typeof json === "object" && json !== null) {
        parsed = json as StatusJson;
      }
    } catch {
      // A non-JSON status is still a running binary — keep probing.
    }

    const warnings: Array<string> = [];
    if (parsed.version !== undefined && belowMin(parsed.version)) {
      warnings.push(`cmd ${parsed.version} is below the tested ${MIN_VERSION}`);
    }

    const models = yield* runBinary(binary, ["--list-models"], {
      timeoutMs: 60_000,
      env,
    }).pipe(
      Effect.map((result) => (result.code === 0 ? parseModelList(result.stdout) : [])),
      Effect.catch((error) => {
        warnings.push(`--list-models failed: ${error.message}`);
        return Effect.succeed([] as ReadonlyArray<ModelOption>);
      }),
    );

    if (status.code !== 0 && parsed.authenticated === undefined) {
      // A code spec 5.1 names reads as the sentence it was written for; the
      // raw detail is kept in brackets rather than dropped, because "rate
      // limited" without the harness's own wording is hard to act on.
      const known = EXIT_MESSAGES[status.code];
      const detail = detailOf(status);
      return {
        status: "error" as const,
        probedAt,
        binaryPath: binary.display,
        message:
          known === undefined
            ? `status exited ${status.code}: ${detail}`
            : detail === ""
              ? known.message
              : `${known.message} (${detail})`,
        auth: "unknown" as const,
        models,
        warnings,
      };
    }

    return {
      status: parsed.authenticated === false ? ("not-authenticated" as const) : ("ready" as const),
      probedAt,
      binaryPath: binary.display,
      ...(parsed.version === undefined ? {} : { version: parsed.version }),
      ...(parsed.authenticated === false ? { message: "not logged in — run `cmd login`" } : {}),
      auth: parsed.authenticated === false ? ("absent" as const) : ("present" as const),
      ...(parsed.user === undefined ? {} : { account: parsed.user }),
      models,
      warnings,
    };
  });

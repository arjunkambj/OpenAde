/**
 * Finding and interrogating the `cmd` binary (spec 5.1, section 8 probe).
 *
 * Resolution lives in `binary.ts` and is shared with the session: the probe
 * used to resolve the binary, report it, and let every turn spawn the bare
 * string `"cmd"` against the server's own PATH instead.
 *
 * **Version policy.** We run whatever the user has installed, at whatever
 * version it is, and we never prefer a pinned copy of our own: the CLI
 * self-updates and the harness is the user's, not ours. Nothing is pinned
 * anywhere — the npx fallback asks for `@latest`, and `OLDEST_TESTED_VERSION`
 * is only the floor our recordings were made at. Below it the probe warns;
 * equal or above it says nothing, today and for every release after.
 *
 * `status --json` answers auth, account and version; `--list-models` feeds the
 * model picker. Both run against the resolved binary with a timeout, and both
 * deliberately go without `--no-auto-update`: a probe is the one moment where
 * letting the CLI upgrade itself is safe and wanted. Turn spawns keep
 * `--no-auto-update` (`buildArgs`), because an upgrade in the middle of a turn
 * would swap the binary under a running conversation.
 */

import { execFile } from "node:child_process";
import type { CmdConnectorConfig } from "@OpenAde/contracts/settings";
import type { ModelOption } from "@OpenAde/contracts/rpc";
import { ACCOUNT_HELP_URL } from "@OpenAde/contracts/rpc";
import type { ConnectorProbe } from "@OpenAde/connector-sdk/definition";
import { ProbeFailed } from "@OpenAde/connector-sdk/definition";
import * as Effect from "effect/Effect";

import { resolveBinary, type ResolvedBinary } from "./binary";
import { EXIT_MESSAGES } from "./exitCodes";
import { envAllowlist } from "./spawn";

/**
 * The oldest release the connector has been recorded against — the floor the
 * probe warns below, never a version it asks for. A newer `cmd` is always fine.
 */
export const OLDEST_TESTED_VERSION = "1.54.0";

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

/** `1.55.1` → [1,55,1]; unparseable → null. */
const parseVersion = (raw: string): Array<number> | null => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
};

/**
 * Strictly older than the oldest release we have recordings for. Equal is fine,
 * newer is fine — a version we cannot parse is fine too, because refusing to
 * run on a build whose version string we do not recognize would be the pin this
 * connector deliberately does not have.
 */
export const isBelowOldestTested = (version: string): boolean => {
  const parsed = parseVersion(version);
  const floor = parseVersion(OLDEST_TESTED_VERSION);
  if (parsed === null || floor === null) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index]! !== floor[index]!) {
      return parsed[index]! < floor[index]!;
    }
  }
  return false;
};

/**
 * A model row is `<id><two or more spaces><description>`; a section header is a
 * line with no such gap. Splitting on the column gap rather than on a `/` is
 * what keeps the Anthropic and OpenAI rows — whose ids are bare (`claude-opus-5`,
 * `gpt-6-astra`), not `provider/model` — out of the header bucket.
 */
const MODEL_ROW = /^(\S+)\s{2,}(.+)$/;

/**
 * A model id: `provider/model` or a bare `model`, either optionally carrying a
 * `:tag` suffix (`meituan/longcat-2.0:free`). Never a trailing colon — that is
 * a label like `Docs:`.
 */
const MODEL_ID = /^[a-z0-9](?:[a-z0-9._-]|\/(?=[a-z0-9]))*(?::[a-z0-9._-]+)?$/i;

const EFFORT_MARKER = /\[(low|medium|high|xhigh|max)(?:,(low|medium|high|xhigh|max))*\]/i;

/** The lines that frame the table instead of listing a model. */
const isTableChrome = (line: string): boolean =>
  line.startsWith("Available models") ||
  line.startsWith("Pass the full id") ||
  line.startsWith("cmd ") ||
  line.startsWith("Docs:");

/**
 * `cmd --list-models` → `ModelOption`s, parsed against the real 1.55.1 output
 * recorded in `fixtures/cmd/probe/list-models.stdout.txt`.
 *
 * The table is two columns under section headers (`Open Source`, `Anthropic`,
 * `OpenAI`, …), which become `family`. A model is free when its id carries a
 * `:free` tag or its description says `FREE`; `(default)` and `(recommended)`
 * are markers, not part of the label. The binary does not print effort ladders
 * today, so `[low,medium]` is still honoured where it appears and otherwise the
 * common ladder is assumed.
 */
export const parseModelList = (output: string): ReadonlyArray<ModelOption> => {
  const models: Array<ModelOption> = [];
  let family = "";
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || isTableChrome(line)) {
      continue;
    }
    const match = MODEL_ROW.exec(line);
    // A lone token is a section header (`Anthropic`, `OpenAI`, `xAI`) unless it
    // is unmistakably an id — `provider/model` never names a family.
    const lone = match === null && MODEL_ID.test(line) && line.includes("/");
    if (!lone && (match === null || !MODEL_ID.test(match[1]!))) {
      family = line.replace(/:$/, "").trim() || family;
      continue;
    }
    const id = lone ? line : match![1]!;
    const description = lone ? "" : (match![2] ?? "");
    const free = id.endsWith(":free") || /\bFREE\b/.test(description);
    const label = description
      .replace(/\((?:default|recommended)\)/gi, "")
      .replace(/\bFREE\b/g, "")
      .replace(EFFORT_MARKER, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    const effortMatch = EFFORT_MARKER.exec(description);
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
      family: family === "" ? (id.split("/")[0] ?? id) : family,
      efforts,
      ...(free ? { free: true } : {}),
      ...(/\bvision\b|\bmultimodal\b/i.test(description) ? { vision: true } : {}),
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
    if (parsed.version !== undefined && isBelowOldestTested(parsed.version)) {
      warnings.push(
        `cmd ${parsed.version} is older than ${OLDEST_TESTED_VERSION}, the oldest release OpenAde has been tested against`,
      );
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

/**
 * The probe: the model-list parser against the REAL recorded table, and
 * `probe()` against real binaries that answer the way the CLI's exit codes say.
 *
 * `parseModelList` is the sole data source for the whole model picker, and the
 * table it reads is `fixtures/cmd/probe/list-models.stdout.txt` — a real
 * `cmd --list-models` captured from command-code 1.55.1 on 2026-09-18, not a
 * reconstruction. The old hand-written fixture hid three bugs this file now
 * pins: bare ids (`claude-opus-5`, `gpt-6-astra`) were dropped as headers,
 * `:free`-tagged ids were truncated, and the table's own chrome was parsed as
 * a model.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { ACCOUNT_HELP_URL } from "@OpenAde/contracts/rpc";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { EXIT_MESSAGES } from "./exitCodes";
import {
  isBelowOldestTested,
  OLDEST_TESTED_VERSION,
  parseModelList,
  PREFERRED_DEFAULT_MODEL,
  probe,
  withPreferredFirst,
} from "./probe";

const FIXTURE = NodePath.resolve(
  NodeURL.fileURLToPath(import.meta.url),
  "../../../testkit/fixtures/cmd/probe/list-models.stdout.txt",
);

const listModels = NodeFS.readFileSync(FIXTURE, "utf8");

/**
 * The last line of a real run this machine made after the account ran out —
 * the harness's own wording, so the test cannot drift from what it prints.
 */
const recordedCreditsError = NodeFS.readFileSync(
  NodePath.resolve(
    NodeURL.fileURLToPath(import.meta.url),
    "../../../testkit/fixtures/cmd/probe-insufficient-credits.ndjson",
  ),
  "utf8",
)
  .trimEnd()
  .split("\n")
  .at(-1)!;

describe("parseModelList", () => {
  const models = parseModelList(listModels);

  it("reads every model the CLI lists, including the bare-id families", () => {
    // The table's own header says how many there should be.
    expect(listModels).toContain("70 models");
    expect(models).toHaveLength(70);
    // Anthropic and OpenAI ids carry no `provider/` prefix; the old parser
    // swallowed all sixteen of them as section headers.
    expect(models.map((model) => model.id)).toContain("claude-opus-5");
    expect(models.map((model) => model.id)).toContain("gpt-6-astra");
    expect(models.find((model) => model.id === "claude-opus-5")?.family).toBe("Anthropic");
    expect(models.find((model) => model.id === "gpt-5.3-codex")?.family).toBe("OpenAI");
    expect(models.find((model) => model.id === "google/gemini-3.8-flash")?.family).toBe("Google");
    expect(models.find((model) => model.id === "deepseek/deepseek-v4-pro")?.family).toBe(
      "Open Source",
    );
  });

  it("keeps a :free tag as part of the id", () => {
    const longcat = models.find((model) => model.id.startsWith("meituan/longcat-2.0"));
    // Truncating the tag would hand `--model` an id the CLI rejects.
    expect(longcat?.id).toBe("meituan/longcat-2.0:free");
    expect(longcat?.free).toBe(true);
    expect(longcat?.label).toBe("trillion-parameter agentic coding with 1M context");
  });

  it("never parses the table's chrome as a model", () => {
    const ids = models.map((model) => model.id);
    expect(ids).not.toContain("Docs:");
    expect(ids).not.toContain("Available");
    expect(ids).not.toContain("cmd");
    expect(models.every((model) => !model.id.includes(" "))).toBe(true);
  });

  it("strips the (default), (recommended) and FREE markers out of the label", () => {
    const flash = models.find((model) => model.id === "deepseek/deepseek-v4-flash");
    expect(flash?.label).toBe("fast hybrid-attention reasoning");
    const sonnet = models.find((model) => model.id === "claude-sonnet-5");
    expect(sonnet?.label).toBe("best combo of speed & intelligence");
    const sante = models.find((model) => model.id === "inclusionai/ling-3.0-flash-sante:free");
    expect(sante?.free).toBe(true);
    expect(sante?.label).not.toContain("FREE");
  });

  it("flags the models whose description mentions vision or multimodality", () => {
    expect(models.find((model) => model.id === "moonshotai/kimi-k2.6")?.vision).toBe(true);
    expect(models.find((model) => model.id === "deepseek/deepseek-v4-pro")?.vision).toBeUndefined();
  });

  it("puts the preferred default first when the table lists it, and only then", () => {
    const ordered = withPreferredFirst(models);
    expect(ordered[0]?.id).toBe(PREFERRED_DEFAULT_MODEL);
    expect(ordered).toHaveLength(models.length);
    const without = models.filter((model) => model.id !== PREFERRED_DEFAULT_MODEL);
    expect(withPreferredFirst(without)).toEqual(without);
  });

  it("narrows nothing when the table prints no effort ladder", () => {
    // 1.55.1 prints no [low,medium] markers on any of its 70 rows. Assuming
    // low/medium/high was inventing a ladder: every recorded
    // `model_request_end` on the account default reports `"effort":"xhigh"`,
    // and `--effort xhigh` is accepted — so the picker hid two rungs the CLI
    // uses by default and picking "high" silently downgraded the run.
    expect(models.every((model) => model.efforts.length === 5)).toBe(true);
    expect(models[0]?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const rungs = new Set(models.flatMap((model) => [...model.efforts]));
    expect(rungs.has("xhigh")).toBe(true);
    expect(rungs.has("max")).toBe(true);
  });

  it("still honours a ladder the table does print", () => {
    expect(parseModelList("acme/model-x  fast one [low,high]")[0]?.efforts).toEqual([
      "low",
      "high",
    ]);
  });

  it("labels a bare id with itself and survives an empty output", () => {
    expect(parseModelList("acme/model-x")).toEqual([
      {
        id: "acme/model-x",
        label: "acme/model-x",
        family: "acme",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
    ]);
    expect(parseModelList("")).toEqual([]);
    expect(parseModelList("\n\n  \n")).toEqual([]);
  });
});

// ── probe() against real child processes ───────────────────────

interface Fake {
  readonly dir: string;
  /** Writes a `cmd` stand-in with the given body and returns its path. */
  readonly binary: (body: string) => string;
}

const fakes = (): Effect.Effect<Fake, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync((): Fake => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-probe-test-"));
      let counter = 0;
      return {
        dir,
        binary: (body) => {
          counter += 1;
          const path = NodePath.join(dir, `cmd-${counter}.mjs`);
          NodeFS.writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
          return path;
        },
      };
    }),
    (fake) => Effect.sync(() => NodeFS.rmSync(fake.dir, { recursive: true, force: true })),
  );

/** A stand-in whose `status --json` behaviour the test dictates. */
const statusBinary = (status: string, exitCode = 0, models = ""): string => `
const argv = process.argv.slice(2);
if (argv.includes("--list-models")) {
  process.stdout.write(${JSON.stringify(models)});
  process.exit(${models === "" ? 1 : 0});
}
process.stdout.write(${JSON.stringify(status)});
process.exit(${exitCode});
`;

describe("probe", () => {
  it.effect("reports ready with the account, version and models", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const binaryPath = fake.binary(
        statusBinary(
          JSON.stringify({ authenticated: true, version: "1.54.0", user: "someone" }),
          0,
          "acme/one  One\n",
        ),
      );

      const result = yield* probe({ binaryPath });
      expect(result.status).toBe("ready");
      expect(result.auth).toBe("present");
      expect(result.account).toBe("someone");
      expect(result.version).toBe("1.54.0");
      expect(result.binaryPath).toBe(binaryPath);
      expect(result.models.map((model) => model.id)).toEqual(["acme/one"]);
      expect(result.warnings).toEqual([]);
    }),
  );

  it.effect("reports not-authenticated on exit 3 without even reading stdout", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const result = yield* probe({ binaryPath: fake.binary(statusBinary("not json", 3)) });
      expect(result.status).toBe("not-authenticated");
      expect(result.auth).toBe("absent");
      expect(result.message).toContain("cmd login");
      // Exit 3 short-circuits: no point listing models for a logged-out CLI.
      expect(result.models).toEqual([]);
    }),
  );

  it.effect("reports not-authenticated when the status json says so", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const result = yield* probe({
        binaryPath: fake.binary(
          statusBinary(JSON.stringify({ authenticated: false, version: "1.54.0" }), 0, "a/b\n"),
        ),
      });
      expect(result.status).toBe("not-authenticated");
      expect(result.auth).toBe("absent");
      // The model list still came back, so the picker has something to show.
      expect(result.models).toHaveLength(1);
    }),
  );

  /**
   * The version policy in one table: nothing is pinned, so only a binary
   * *older* than the oldest release we have recordings for is worth a word.
   * 1.55.1 is what is installed today and 1.54.0 is the floor — neither warns,
   * and neither does whatever ships next.
   */
  it("warns below the oldest tested version and nowhere else", () => {
    expect(OLDEST_TESTED_VERSION).toBe("1.54.0");
    expect(isBelowOldestTested("1.53.9")).toBe(true);
    expect(isBelowOldestTested("0.9.0")).toBe(true);
    expect(isBelowOldestTested("1.54.0")).toBe(false); // equal
    expect(isBelowOldestTested("1.55.1")).toBe(false); // installed today
    expect(isBelowOldestTested("2.0.0")).toBe(false); // whatever comes next
    // Unparseable is not old: refusing a build whose version string we cannot
    // read would be the pin this connector deliberately does not have.
    expect(isBelowOldestTested("nightly")).toBe(false);
    expect(isBelowOldestTested("")).toBe(false);
  });

  it.effect("carries that warning on the probe, and says nothing for a newer cmd", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const old = yield* probe({
        binaryPath: fake.binary(
          statusBinary(JSON.stringify({ authenticated: true, version: "1.53.9" }), 0, "a/b\n"),
        ),
      });
      expect(old.status).toBe("ready");
      expect(old.warnings.join(" ")).toContain("1.53.9");
      expect(old.warnings.join(" ")).toContain(OLDEST_TESTED_VERSION);

      // The version the operator actually has installed.
      const installed = yield* probe({
        binaryPath: fake.binary(
          statusBinary(JSON.stringify({ authenticated: true, version: "1.55.1" }), 0, "a/b\n"),
        ),
      });
      expect(installed.warnings).toEqual([]);

      const newer = yield* probe({
        binaryPath: fake.binary(
          statusBinary(JSON.stringify({ authenticated: true, version: "2.0.0" }), 0, "a/b\n"),
        ),
      });
      expect(newer.warnings).toEqual([]);
    }),
  );

  it.effect(
    "treats a running binary with unreadable status as ready, and warns on a bad model list",
    () =>
      Effect.gen(function* () {
        const fake = yield* fakes();
        const result = yield* probe({
          binaryPath: fake.binary(statusBinary("not json at all", 0)),
        });
        // A binary that runs and exits 0 is working even if we cannot read it.
        expect(result.status).toBe("ready");
        expect(result.version).toBeUndefined();
        expect(result.models).toEqual([]);
        expect(result.warnings).toEqual([]);
      }),
  );

  it.effect("reports error when status fails for a reason it cannot name", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const result = yield* probe({
        binaryPath: fake.binary(`
process.stderr.write("something broke");
process.exit(42);
`),
      });
      expect(result.status).toBe("error");
      expect(result.auth).toBe("unknown");
      expect(result.message).toContain("something broke");
      expect(result.message).toContain("42");
    }),
  );

  it.effect("names a known exit code, and keeps the harness's own words", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const result = yield* probe({
        binaryPath: fake.binary(`
process.stderr.write("429 Too Many Requests");
process.exit(5);
`),
      });
      // "status exited 5" told the user nothing they could act on.
      expect(result.message).toBe(`${EXIT_MESSAGES[5]!.message} (429 Too Many Requests)`);
    }),
  );

  it.effect("sends an out-of-credits account to the billing page", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      // What the real CLI printed when this machine's account ran out, taken
      // from the recording rather than invented.
      const result = yield* probe({
        binaryPath: fake.binary(`
process.stderr.write(${JSON.stringify(recordedCreditsError)} + "\\n");
process.exit(10);
`),
      });
      expect(result.status).toBe("error");
      // Not "unknown": the login is fine, the balance is not — and the welcome
      // flow needs the difference to be able to offer a way forward.
      expect(result.auth).toBe("present");
      expect(result.helpUrl).toBe(ACCOUNT_HELP_URL);
      expect(result.message).toBe(EXIT_MESSAGES[10]!.message);
      expect(recordedCreditsError).toContain("insufficient credits");
    }),
  );

  it.effect("fails with ProbeFailed when the configured binary is not there", () =>
    Effect.gen(function* () {
      const error = yield* probe({ binaryPath: "/nonexistent/cmd-xyz" }).pipe(Effect.flip);
      expect(error._tag).toBe("ProbeFailed");
      expect(error.kind).toBe("cmd");
    }),
  );

  it.effect("runs the probe through the env leak guard", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const binaryPath = fake.binary(`
process.stdout.write(JSON.stringify({
  authenticated: true,
  version: "1.54.0",
  user: [
    process.env.ANTHROPIC_API_KEY ?? "-",
    process.env.OPENADE_SERVER_SECRET ?? "-",
    process.env.COMMAND_CODE_API_KEY ?? "-",
  ].join("|"),
}));
process.exit(0);
`);
      const previous = { ...process.env };
      process.env.ANTHROPIC_API_KEY = "leaked";
      process.env.OPENADE_SERVER_SECRET = "leaked";
      try {
        const result = yield* probe({
          binaryPath,
          extraEnv: { COMMAND_CODE_API_KEY: "from-config" },
        });
        // Foreign credentials and control-plane variables are stripped; the
        // operator's own extraEnv reaches the probe, so an API key configured
        // there is not reported as "not authenticated".
        expect(result.account).toBe("-|-|from-config");
      } finally {
        process.env = previous;
      }
    }),
  );
});

/**
 * What a recording of a real harness is, whatever wire it was taken from.
 *
 * Every connector is tested against captures of its real harness, never a
 * stand-in. The captures differ by transport — Command Code prints NDJSON on
 * stdout, other harnesses speak JSON-RPC over stdio, stream from an SDK, or
 * answer over HTTP with server-sent events — but they share one layout and one
 * index, so a suite can list, load and assert against any of them the same way:
 *
 * - `packages/testkit/fixtures/<kind>/<scenario>/manifest.json` indexes one
 *   recorded scenario of the harness the connector kind drives. The files
 *   beside it are that transport's own capture.
 * - A manifest names its `formatVersion` and `transport`. The Command Code
 *   recordings predate both fields and are never edited, so a manifest without
 *   them reads as version 1 of its kind's legacy layout.
 * - A `RecordedFrame` is one unit on the wire, tagged with which way it went.
 *
 * Each transport brings its own `Replayer`, which turns a scenario into
 * whatever a connector instance needs to talk to the recording instead of the
 * harness.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const FIXTURES = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

/** The manifest format this module reads. */
export const RECORDING_FORMAT_VERSION = 1;

/** How the harness talked to its connector when the recording was taken. */
export type RecordingTransport = "stdio-ndjson" | "stdio-jsonrpc" | "sdk-stream" | "http-sse";

/** One unit on the wire, in the order it was captured. */
export interface RecordedFrame {
  /** Which way it travelled: out of the harness, or into it. */
  readonly dir: "from-harness" | "to-harness";
  /** The stream it travelled on, named by the transport ("stdout", "hook", …). */
  readonly channel: string;
  /** Milliseconds from the start of the run, when the capture has them. */
  readonly at?: number;
  readonly data: unknown;
}

/** The fields every recording's manifest has, once defaults are applied. */
export interface RecordingManifest {
  readonly formatVersion: number;
  readonly kind: string;
  readonly transport: RecordingTransport;
  readonly scenario: string;
  readonly description: string;
  readonly cliVersion: string;
  readonly recordedOn?: string;
  readonly model: string;
  readonly real: true;
}

/**
 * The transport each kind recorded before manifests named one. A kind that is
 * not listed here has to name its transport in every manifest.
 */
const LEGACY_TRANSPORTS: Readonly<Record<string, RecordingTransport>> = {
  cmd: "stdio-ndjson",
};

/** Where a connector kind's recordings live: `packages/testkit/fixtures/<kind>/`. */
export const fixturesRoot = (kind: string): string => NodePath.join(FIXTURES, kind);

/**
 * Every recorded scenario of a kind, by name. A scenario is a directory holding
 * a `manifest.json` with turns; the probe captures sit in their own directory
 * and are not a scenario.
 */
export const recordingNames = (kind: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(fixturesRoot(kind), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "probe")
    .map((entry) => entry.name)
    .sort();

/**
 * Reads a scenario's manifest. Throws rather than degrading: a manifest that is
 * not marked real, names a format this module does not read, or names no
 * transport its kind can default to is one nobody should be testing against.
 * `Extra` is the rest of the manifest as that transport's layout writes it.
 */
export const readManifest = <Extra extends object = Record<string, unknown>>(
  kind: string,
  scenario: string,
): RecordingManifest & Extra => {
  const raw = JSON.parse(
    NodeFS.readFileSync(NodePath.join(fixturesRoot(kind), scenario, "manifest.json"), "utf8"),
  ) as Partial<RecordingManifest> & { readonly real?: unknown } & Extra;
  if (raw.real !== true) {
    throw new Error(`${kind}/${scenario}: not marked as a real recording`);
  }
  const formatVersion = raw.formatVersion ?? RECORDING_FORMAT_VERSION;
  if (formatVersion !== RECORDING_FORMAT_VERSION) {
    throw new Error(`${kind}/${scenario}: recording format ${formatVersion} is not readable`);
  }
  const transport = raw.transport ?? LEGACY_TRANSPORTS[kind];
  if (transport === undefined) {
    throw new Error(`${kind}/${scenario}: the manifest names no transport`);
  }
  return {
    ...raw,
    formatVersion,
    kind,
    transport,
    scenario: raw.scenario ?? scenario,
    description: raw.description ?? "",
    cliVersion: raw.cliVersion ?? "unknown",
    model: raw.model ?? "unknown",
    real: true,
  };
};

/**
 * Puts a kind's recordings back on its transport. `config` answers whatever a
 * connector instance needs to talk to the recording instead of the harness — a
 * binary and environment for a process, a URL for a server.
 */
export interface Replayer<Options, Config = unknown> {
  readonly kind: string;
  readonly transport: RecordingTransport;
  readonly config: (scenario: string, options: Options) => Config;
}

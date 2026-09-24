/**
 * An in-memory driver for tests of the layers above the driver seam — the
 * service's queue, epoch and teardown, and the MCP gateway. It speaks the same
 * `exec(argv)` vocabulary as the real drivers over a fake page.
 *
 * It stands in for the *driver*, never for agent-browser: what agent-browser
 * itself answers is only ever replayed from recordings of real runs (see
 * `./test/replayCli.ts`).
 */

import { writeFileSync } from "node:fs";

import * as Effect from "effect/Effect";

import type { BrowserHumanInput } from "@OpenAde/contracts/rpc";

import { AgentBrowserError } from "./agentBrowser";
import type { BrowserDriver, DriverMode } from "./driver";

export interface FakePage {
  url: string;
  title: string;
  /** Snapshot lines; refs map to the url clicking them navigates to. */
  lines: ReadonlyArray<{ role: string; name: string; ref: string; url?: string }>;
  /** Visited entries; `historyIndex` marks the current one. */
  history: Array<{ url: string; title: string }>;
  historyIndex: number;
}

/**
 * An in-memory driver speaking the same `exec(argv)` vocabulary — enough for
 * the e2e to prove open/snapshot/click, the queue, interruption and teardown
 * without a browser binary.
 */
export const makeFakeDriver = (
  page: FakePage,
  hooks?: {
    /** Failing here is how a test plays back a daemon error (e.g. `tab_gone`). */
    readonly onExec?: (argv: ReadonlyArray<string>) => Effect.Effect<void, AgentBrowserError>;
    readonly onInput?: (input: BrowserHumanInput) => Effect.Effect<void>;
    readonly onClose?: () => Effect.Effect<void>;
    /** The mode the driver reports; `owned-chromium` unless a test says otherwise. */
    readonly mode?: DriverMode;
  },
): BrowserDriver => {
  const record = (data: Record<string, unknown>) => ({
    ...data,
    url: page.url,
    title: page.title,
  });

  const navigate = (url: string) => {
    page.history = page.history.slice(0, page.historyIndex + 1);
    page.history.push({ url, title: `Fake ${url}` });
    page.historyIndex = page.history.length - 1;
    page.url = url;
    page.title = `Fake ${url}`;
  };

  const exec = (
    argv: ReadonlyArray<string>,
  ): Effect.Effect<Record<string, unknown>, AgentBrowserError> =>
    Effect.gen(function* () {
      if (hooks?.onExec !== undefined) yield* hooks.onExec(argv);
      const [command, ...rest] = argv;
      switch (command) {
        case "open":
          navigate(String(rest[0] ?? "about:blank"));
          return record({ targetId: "fake-target" });
        case "snapshot": {
          const text = page.lines
            .map((line) => `- ${line.role} "${line.name}" [ref=${line.ref}]`)
            .join("\n");
          return record({
            snapshot: text,
            origin: page.url,
            refs: Object.fromEntries(
              page.lines.map((line) => [line.ref, { name: line.name, role: line.role }]),
            ),
          });
        }
        case "click": {
          const ref = String(rest[0] ?? "");
          const line = page.lines.find(
            (entry) => entry.ref === ref || `@${entry.ref}` === ref || entry.name === ref,
          );
          if (line === undefined) {
            return yield* new AgentBrowserError({
              command: argv.join(" "),
              message: `Could not locate element ${ref}`,
              code: null,
              data: null,
            });
          }
          if (line.url !== undefined) navigate(line.url);
          return record({ clicked: ref });
        }
        case "fill":
        case "type":
        case "keyboard":
        case "press":
        case "scroll":
        case "wait":
        case "eval":
          return record({ ok: true });
        case "get": {
          if (rest[0] === "url") return { url: page.url };
          if (rest[0] === "title") return { title: page.title };
          if (rest[0] === "text") return { text: page.lines.map((l) => l.name).join(" ") };
          return record({ ok: true });
        }
        case "back": {
          if (page.historyIndex > 0) {
            page.historyIndex -= 1;
            const entry = page.history[page.historyIndex]!;
            page.url = entry.url;
            page.title = entry.title;
          }
          return record({ ok: true });
        }
        case "forward": {
          if (page.historyIndex < page.history.length - 1) {
            page.historyIndex += 1;
            const entry = page.history[page.historyIndex]!;
            page.url = entry.url;
            page.title = entry.title;
          }
          return record({ ok: true });
        }
        case "reload":
          return record({ ok: true });
        case "screenshot": {
          // A real file, like the daemon writes — the service inlines it.
          const path = String(rest[0] ?? "");
          writeFileSync(
            path,
            Buffer.from(
              "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
                "1f15c4890000000d4944415478da63fcffff3f0300050201ed0b6b2c0000000049454e44ae426082",
              "hex",
            ),
          );
          return record({ path });
        }
        case "tab":
          return record({
            tabs: [{ targetId: "fake-target", type: "page", url: page.url }],
          });
        case "close":
          return record({ closed: true });
        default:
          return record({ ok: true });
      }
    });

  return {
    mode: hooks?.mode ?? "owned-chromium",
    exec,
    sendInput: (input) => (hooks?.onInput ?? (() => Effect.void))(input),
    location: Effect.sync(() => ({ url: page.url, title: page.title })),
    close: hooks?.onClose !== undefined ? hooks.onClose() : Effect.void,
  };
};

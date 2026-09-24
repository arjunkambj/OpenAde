#!/usr/bin/env node
/**
 * Records real agent-browser runs through the desktop's browser bridge into
 * `packages/testkit/fixtures/agent-browser/`.
 *
 * The bridge's tests replay what this captures — every CDP frame the real
 * CLI sent and every frame the bridge answered — so nothing about how
 * agent-browser drives a browser is invented. It spends no plan, but it
 * launches Electron and the operator's installed CLI, so it is run by hand:
 *
 *     node packages/testkit/scripts/record-agent-browser.mjs            # every scenario
 *     node packages/testkit/scripts/record-agent-browser.mjs popup reload
 *     node packages/testkit/scripts/record-agent-browser.mjs --list
 *
 * How: a loopback static site serves the pages; the desktop's recording host
 * (`apps/desktop/scripts/bridge-recording-host.mjs`, bundled with the
 * desktop's own esbuild) opens `<webview>` guests and the real bridge in
 * front of them; each scenario runs `agent-browser --json` commands with the
 * thread's bridge URL in `AGENT_BROWSER_CDP` — never in argv — exactly as
 * the server will. The CLI's `--json` envelopes are kept in the manifest.
 *
 * Scrubbing on the way in: the site and bridge ports become `<SITE_PORT>` and
 * `<BRIDGE_PORT>`, the scratch root `<SCRATCH>`, the home directory `<HOME>`,
 * the launch key and every 64-hex capability `<REDACTED>`, the daemon's
 * stream port `<STREAM_PORT>`, and a screenshot's
 * image bytes are replaced by their length. Target and session ids are per-run
 * identifiers and stay as recorded; the tests match on them.
 */

import { spawn, execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import { createRequire } from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import { bridgeThreadUrl } from "@poseidon/shared/browserBridge";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const REPO = NodePath.resolve(HERE, "..", "..", "..");
const FIXTURES = NodePath.join(HERE, "..", "fixtures", "agent-browser");
const DESKTOP = NodePath.join(REPO, "apps", "desktop");
const HOST_ENTRY = NodePath.join(DESKTOP, "scripts", "bridge-recording-host.mjs");
const NAMESPACE = "poseidon-record";

/** The pages every scenario browses; served from 127.0.0.1 on a fresh port. */
const PAGES = {
  "/": `<!doctype html><html><head><meta charset="utf-8"><title>Recording home</title></head>
<body><h1>Recording home</h1>
<label>Name <input id="name" autocomplete="off"></label>
<button id="go" onclick="document.getElementById('out').textContent = 'Hello, ' + document.getElementById('name').value">Greet</button>
<p id="out"></p>
<p id="loads"></p>
<a id="next" href="/page2">Second page</a>
<button id="popup" onclick="window.open('/popup')">Open popup</button>
<div style="height:2000px"></div>
<script>
  const loads = Number(sessionStorage.getItem("loads") ?? "0") + 1;
  sessionStorage.setItem("loads", String(loads));
  document.getElementById("loads").textContent = "loads: " + loads;
</script></body></html>`,
  "/page2": `<!doctype html><html><head><meta charset="utf-8"><title>Second page</title></head>
<body><h1>Second page</h1><a href="/">Home</a></body></html>`,
  "/popup": `<!doctype html><html><head><meta charset="utf-8"><title>Popup page</title></head>
<body><h1>Popup page</h1></body></html>`,
};

/**
 * Each scenario: the tabs the thread has before agent-browser connects, and
 * the CLI commands run against it. `{site}` is the site origin, `{shot}` a
 * scratch file, `{tabN}` the target id of the thread's Nth tab at the moment
 * the step runs. A `{host: "remove", index}` step is the pane closing that tab
 * between two commands; a `{pause: ms}` step is time passing between two.
 *
 * The `cli-*` scenarios are the server's in-app driver's own command
 * sequences (`apps/server/src/browser/inAppDriver.ts`), so their manifests
 * are `cli-json`: the envelopes are what the driver's tests replay.
 */
const SCENARIOS = {
  "connect-and-drive": {
    description:
      "attach to the thread's one tab, read it, fill and click, type, press, scroll, screenshot, eval and navigate",
    tabs: ["{site}/"],
    steps: [
      ["get", "title"],
      ["snapshot", "-i"],
      ["fill", "#name", "Ada"],
      ["click", "#go"],
      ["get", "text", "#out"],
      ["click", "#name"],
      ["keyboard", "type", " L"],
      ["press", "Enter"],
      ["scroll", "down", "300"],
      ["screenshot", "{shot}"],
      ["eval", "document.getElementById('name').value"],
      ["open", "{site}/page2"],
      ["get", "url"],
    ],
  },
  "empty-thread-createTarget": {
    description:
      "a thread with no tab yet: agent-browser creates one (about:blank) and opens the site",
    tabs: [],
    steps: [
      ["open", "{site}/"],
      ["get", "title"],
    ],
  },
  "tab-new-close": {
    description: "open a second tab, read it, close it again",
    tabs: ["{site}/"],
    steps: [
      ["tab", "list"],
      ["tab", "new", "{site}/page2"],
      ["tab", "list"],
      ["get", "title"],
      ["tab", "close"],
      ["tab", "list"],
    ],
  },
  popup: {
    description: "the page calls window.open; the popup arrives as a new tab of the same thread",
    tabs: ["{site}/"],
    steps: [
      ["click", "#popup"],
      ["wait", "1000"],
      ["tab", "list"],
      ["tab", "t1"],
      ["get", "title"],
      ["tab", "t2"],
      ["get", "title"],
    ],
  },
  reload: {
    description: "reload the tab: the bridge turns Page.reload into a guest reload",
    tabs: ["{site}/"],
    steps: [["get", "text", "#loads"], ["reload"], ["get", "text", "#loads"]],
  },
  "cli-attach": {
    description:
      "the in-app driver's open (list, pin the first tab, stream off), a call, the daemon stopping, the re-attach, close",
    tabs: ["{site}/", "{site}/page2"],
    steps: [
      ["stream", "status"],
      ["tab", "list"],
      ["--pin-tab", "tab", "{tab0}"],
      ["stream", "disable"],
      ["stream", "status"],
      ["get", "title"],
      ["close"],
      ["--pin-tab", "tab", "{tab0}"],
      ["stream", "disable"],
      ["get", "title"],
      ["close"],
      ["tab", "list"],
    ],
  },
  "cli-empty-thread": {
    description:
      "the first browser call on a thread with no tab: tab list makes agent-browser create one",
    tabs: [],
    steps: [
      ["tab", "list"],
      ["--pin-tab", "tab", "{tab0}"],
      ["stream", "disable"],
      ["get", "url"],
      ["close"],
    ],
  },
  "cli-tabs-pinned": {
    description:
      "browser_tabs on a pinned session: new and switch move the pin; closing the bound tab leaves it pinned to nothing",
    tabs: ["{site}/"],
    steps: [
      ["tab", "list"],
      ["--pin-tab", "tab", "{tab0}"],
      ["stream", "disable"],
      ["tab", "new", "{site}/page2"],
      ["get", "title"],
      ["tab", "t1"],
      ["get", "title"],
      ["tab", "t2"],
      ["tab", "close"],
      ["tab", "list"],
      ["--pin-tab", "tab", "{tab0}"],
      ["stream", "disable"],
      ["get", "title"],
      ["close"],
    ],
  },
  "cli-last-tab-gone": {
    description:
      "the pane closes the thread's only tab: tab_gone, an empty list, and a new tab to pin",
    tabs: ["{site}/"],
    steps: [
      ["tab", "list"],
      ["--pin-tab", "tab", "{tab0}"],
      ["stream", "disable"],
      { host: "remove", index: 0 },
      ["get", "title"],
      ["tab", "list"],
      ["tab", "new"],
      ["--pin-tab", "tab", "{tab0}"],
      ["stream", "disable"],
      ["get", "url"],
      ["close"],
    ],
  },
  "cli-tab-gone": {
    description:
      "the pane closes the pinned tab: the next command fails tab_gone, and the driver re-resolves",
    tabs: ["{site}/", "{site}/page2"],
    steps: [
      ["tab", "list"],
      ["--pin-tab", "tab", "{tab0}"],
      ["stream", "disable"],
      ["get", "title"],
      { host: "remove", index: 0 },
      ["get", "title"],
      ["tab", "list"],
      ["--pin-tab", "tab", "{tab0}"],
      ["stream", "disable"],
      ["get", "title"],
      ["close"],
    ],
  },
  "cli-reap": {
    description:
      "a daemon left running in the namespace: session info names its pid and socket directory, session list the namespace's sessions, close --all closes them and the list empties",
    tabs: ["{site}/"],
    steps: [
      ["tab", "list"],
      ["--pin-tab", "tab", "{tab0}"],
      ["stream", "disable"],
      ["session", "info"],
      ["session", "list"],
      ["close", "--all"],
      // `close --all` answers before the daemons have finished exiting.
      { pause: 1500 },
      ["session", "list"],
    ],
  },
};

const resolveBinary = () => {
  const override = process.env.POSEIDON_AGENT_BROWSER?.trim();
  if (override) return override;
  return execFileSync("/usr/bin/which", ["agent-browser"], { encoding: "utf8" }).trim();
};

const serveSite = () =>
  new Promise((resolve) => {
    const server = NodeHttp.createServer((request, response) => {
      const page = PAGES[new URL(request.url ?? "/", "http://x").pathname];
      if (page === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

/** Bundles the recording host with the desktop's esbuild and starts it under Electron. */
const startHost = async (scratch) => {
  const requireFromDesktop = createRequire(NodePath.join(DESKTOP, "package.json"));
  const esbuild = requireFromDesktop("esbuild");
  const electron = requireFromDesktop("electron");
  const bundle = NodePath.join(scratch, "host.cjs");
  await esbuild.build({
    entryPoints: [HOST_ENTRY],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    logLevel: "warning",
  });
  const child = spawn(electron, [bundle], {
    env: { ...process.env, POSEIDON_RECORD_HOST_DIR: scratch },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const frames = [];
  const waiting = new Map();
  let ready;
  const readyPromise = new Promise((resolve) => (ready = resolve));
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Electron's own chatter
    }
    if (message.type === "ready") ready(message);
    if (message.type === "frame") frames.push(message);
    if (message.type === "log")
      process.stdout.write(`  bridge: ${JSON.stringify(message.entry)}\n`);
    if (message.type === "result") waiting.get(message.seq)?.(message);
  });
  let seq = 0;
  const request = (body) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, (message) => {
        waiting.delete(id);
        if (message.error) reject(new Error(message.error));
        else resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ seq: id, ...body })}\n`);
    });
  const { origin, launchKey } = await readyPromise;
  return { child, frames, request, origin, launchKey };
};

const runCli = (binary, env, argv) =>
  new Promise((resolve) => {
    const child = spawn(binary, ["--json", ...argv], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      let envelope = null;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        envelope = { unparsed: stdout, stderr };
      }
      resolve({ code, envelope });
    });
  });

const makeScrubber = ({ sitePort, bridgePort, launchKey, scratch }) => {
  const replacements = [
    [launchKey, "<REDACTED>"],
    [scratch, "<SCRATCH>"],
    [NodeFS.realpathSync(scratch), "<SCRATCH>"],
    [NodeOS.homedir(), "<HOME>"],
    [`127.0.0.1:${sitePort}`, "127.0.0.1:<SITE_PORT>"],
    [`127.0.0.1:${bridgePort}`, "127.0.0.1:<BRIDGE_PORT>"],
  ];
  const scrubText = (text) => {
    let out = text;
    for (const [from, to] of replacements) out = out.replaceAll(from, to);
    out = out.replaceAll(`"remotePort":${sitePort}`, '"remotePort":"<SITE_PORT>"');
    // `stream status` names the daemon's own loopback frame-stream port.
    out = out.replaceAll(/"port":\d+/g, '"port":"<STREAM_PORT>"');
    return out.replaceAll(/\b[0-9a-f]{64}\b/g, "<REDACTED>");
  };
  const scrubValue = (value) => JSON.parse(scrubText(JSON.stringify(value)));
  return { scrubText, scrubValue };
};

/** A screenshot's bytes are not what the tests read; keep their size. */
const elideImages = (message) => {
  const data = message?.result?.data;
  if (typeof data === "string" && data.length > 1024) {
    return {
      ...message,
      result: { ...message.result, data: `<image base64, ${data.length} chars>` },
    };
  }
  return message;
};

const record = async (name, context) => {
  const scenario = SCENARIOS[name];
  const threadId = `rec-${name}`;
  const fill = (text) =>
    text
      .replaceAll("{site}", context.site)
      .replaceAll("{shot}", NodePath.join(context.scratch, `${name}.png`));
  const setup = await context.host.request({
    op: "setup",
    threadId,
    tabs: scenario.tabs.map(fill),
  });
  const cdpUrl = bridgeThreadUrl(context.host.origin, context.host.launchKey, threadId);
  const env = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR ?? NodeOS.tmpdir(),
    AGENT_BROWSER_CDP: cdpUrl,
    AGENT_BROWSER_NAMESPACE: NAMESPACE,
    AGENT_BROWSER_SESSION: threadId,
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "60000",
  };
  const firstFrame = context.host.frames.length;
  const steps = [];
  for (const step of scenario.steps) {
    if (!Array.isArray(step) && step.pause !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, step.pause));
      steps.push({ pause: step.pause });
      continue;
    }
    if (!Array.isArray(step)) {
      const { guests } = await context.host.request({ op: step.host, threadId, index: step.index });
      steps.push({ host: step.host, index: step.index, guests });
      process.stdout.write(`  ${name}: host ${step.host} ${step.index}\n`);
      continue;
    }
    const { guests } = await context.host.request({ op: "guests", threadId });
    const argv = step.map((part) =>
      fill(part).replace(/\{tab(\d+)\}/g, (_match, index) => guests[Number(index)]?.targetId ?? ""),
    );
    const { code, envelope } = await runCli(context.binary, env, argv);
    steps.push({ argv, exitCode: code, envelope });
    process.stdout.write(
      `  ${name}: ${argv.join(" ")} -> ${envelope?.success === true ? "ok" : "FAILED"}\n`,
    );
  }
  await runCli(context.binary, env, ["close"]);
  const frames = context.host.frames
    .slice(firstFrame)
    .filter((frame) => frame.threadId === threadId)
    .map((frame) => ({
      dir: frame.direction === "from-client" ? "from-harness" : "to-harness",
      channel: `ws:${frame.connection}`,
      at: frame.at,
      data: elideImages(frame.message),
    }));
  const { scrubText, scrubValue } = context.scrubber;
  const dir = NodePath.join(FIXTURES, name);
  NodeFS.rmSync(dir, { recursive: true, force: true });
  NodeFS.mkdirSync(dir, { recursive: true });
  const manifest = {
    formatVersion: 1,
    kind: "agent-browser",
    transport: name.startsWith("cli-") ? "cli-json" : "cdp-websocket",
    scenario: name,
    description: scenario.description,
    cliVersion: context.cliVersion,
    recordedOn: new Date().toISOString().slice(0, 10),
    model: "none",
    real: true,
    electronVersion: context.electronVersion,
    threadId,
    tabs: scrubValue(setup.guests.map(({ targetId, url }) => ({ targetId, url }))),
    steps: scrubValue(steps),
  };
  NodeFS.writeFileSync(
    NodePath.join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(dir, "frames.jsonl"),
    frames.map((frame) => scrubText(JSON.stringify(frame))).join("\n") + "\n",
  );
  const failed = steps.filter(
    (step) => step.argv !== undefined && step.envelope?.success !== true,
  ).length;
  process.stdout.write(`${name}: ${frames.length} frames, ${failed} failed step(s)\n`);
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    for (const [name, { description }] of Object.entries(SCENARIOS)) {
      process.stdout.write(`${name.padEnd(28)}${description}\n`);
    }
    return;
  }
  const names = args.length === 0 ? Object.keys(SCENARIOS) : args;
  for (const name of names) {
    if (!(name in SCENARIOS)) throw new Error(`unknown scenario ${name}; see --list`);
  }
  const binary = resolveBinary();
  const cliVersion = execFileSync(binary, ["--version"], { encoding: "utf8" })
    .trim()
    .split(/\s+/)
    .at(-1);
  const scratch = NodeFS.mkdtempSync(
    NodePath.join(process.env.RECORD_SCRATCH ?? NodeOS.tmpdir(), "poseidon-record-agent-browser-"),
  );
  const site = await serveSite();
  const sitePort = site.address().port;
  const host = await startHost(scratch);
  const electronVersion = createRequire(NodePath.join(DESKTOP, "package.json"))(
    "electron/package.json",
  ).version;
  const context = {
    binary,
    cliVersion,
    electronVersion,
    scratch,
    host,
    site: `http://127.0.0.1:${sitePort}`,
    scrubber: makeScrubber({
      sitePort,
      bridgePort: new URL(host.origin).port,
      launchKey: host.launchKey,
      scratch,
    }),
  };
  try {
    for (const name of names) await record(name, context);
  } finally {
    await runCli(binary, { HOME: process.env.HOME, PATH: process.env.PATH }, [
      "--namespace",
      NAMESPACE,
      "close",
      "--all",
    ]);
    // `close --all` leaves each session's `.config`/`.target` behind; the
    // namespace is the recorder's own, so it goes entirely.
    NodeFS.rmSync(NodePath.join(NodeOS.homedir(), ".agent-browser", "namespaces", NAMESPACE), {
      recursive: true,
      force: true,
    });
    await host.request({ op: "quit" }).catch(() => undefined);
    host.child.kill();
    site.close();
  }
};

await main();

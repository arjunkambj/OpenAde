#!/usr/bin/env node
/**
 * Records the CLI's non-model surfaces — the ones `probe.ts` parses.
 *
 * None of these spend a model turn, so this is the cheap half of the recording
 * story: `status --json`, `--list-models`, `--version`, `--help`, and the error
 * a bad `--model` produces. Output lands beside the turn recordings in
 * `packages/testkit/fixtures/cmd/probe/`.
 *
 *     node packages/testkit/scripts/record-probe.mjs
 */

import { spawn } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const CLI_PACKAGE = "command-code@1.54.0";
const ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL("../../..", import.meta.url)));
const OUT = NodePath.join(ROOT, "packages", "testkit", "fixtures", "cmd", "probe");

const PROBES = [
  { name: "status", args: ["status", "--json"] },
  { name: "list-models", args: ["--list-models"] },
  { name: "version", args: ["--version"] },
  { name: "help", args: ["--help"] },
  {
    name: "invalid-model",
    args: [
      "-p",
      "hi",
      "--output-format",
      "json",
      "--verbose",
      "-t",
      "--skip-onboarding",
      "--no-auto-update",
      "--no-session",
      "--model",
      "definitely/not-a-real-model",
      "--max-turns",
      "1",
    ],
  },
];

const capture = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn("npx", ["-y", CLI_PACKAGE, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code, signal) => resolve({ stdout, stderr, code, signal }));
    child.once("error", (error) => resolve({ stdout, stderr: String(error), code: -1, signal: null }));
  });

const scrub = (text, home) => {
  const user = NodePath.basename(home);
  let out = text.split(home).join("<HOME>");
  if (user.length > 2) out = out.replaceAll(new RegExp(`\\b${user}\\b`, "g"), "user");
  return out.replaceAll(/\b(sk|pk|ghp|gho|Bearer)[-_ ][A-Za-z0-9._-]{12,}/g, "<REDACTED>");
};

const main = async () => {
  const home = NodeOS.homedir();
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "openade-probe-"));
  NodeFS.rmSync(OUT, { recursive: true, force: true });
  NodeFS.mkdirSync(OUT, { recursive: true });
  const manifest = {
    cli: CLI_PACKAGE,
    recordedOn: "2026-09-18",
    real: true,
    probes: [],
  };
  for (const probe of PROBES) {
    process.stderr.write(`▸ ${probe.name}\n`);
    const result = await capture(probe.args, cwd);
    NodeFS.writeFileSync(
      NodePath.join(OUT, `${probe.name}.stdout.txt`),
      scrub(result.stdout, home),
      "utf8",
    );
    if (result.stderr.length > 0) {
      NodeFS.writeFileSync(
        NodePath.join(OUT, `${probe.name}.stderr.txt`),
        scrub(result.stderr, home),
        "utf8",
      );
    }
    manifest.probes.push({
      name: probe.name,
      args: probe.args,
      exitCode: result.code,
      signal: result.signal,
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
    });
    process.stderr.write(`  exit=${result.code} stdout=${result.stdout.length}b\n`);
  }
  NodeFS.writeFileSync(
    NodePath.join(OUT, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  NodeFS.rmSync(cwd, { recursive: true, force: true });
  process.stderr.write(`✓ wrote ${NodePath.relative(ROOT, OUT)}\n`);
};

await main();

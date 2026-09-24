import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { devServerEntry, packagedServerEntry } from "./serverArgs";

const here = dirname(fileURLToPath(import.meta.url));
/** Where `out/main/index.cjs` sits at runtime, relative to this source file. */
const MAIN_DIR = join(here, "..", "..", "out", "main");

const scratch = mkdtempSync(join(tmpdir(), "poseidon-serverargs-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("packagedServerEntry", () => {
  it("points at the asar-unpacked server bundle", () => {
    const entry = packagedServerEntry(
      "/Apps/Poseidon.app/Contents/MacOS/Poseidon",
      "/Apps/Poseidon.app/Contents/Resources/app.asar/out/main",
    );
    expect(entry.args).toEqual([
      "/Apps/Poseidon.app/Contents/Resources/app.asar.unpacked/out/server/main.cjs",
    ]);
  });
});

describe("devServerEntry", () => {
  it("registers the tsx loader in-process instead of shelling out to the tsx CLI", () => {
    const { args } = devServerEntry(process.execPath, MAIN_DIR);

    // `tsx/cli` re-execs node, and the grandchild loses the supervisor's fd 3.
    // Matched on the file name alone: every argument here is an absolute path,
    // and a checkout under a directory whose own name happens to contain "cli"
    // is not the tsx CLI.
    expect(args.some((arg) => basename(arg).includes("cli"))).toBe(false);
    expect(args.includes("watch")).toBe(false);

    expect(args[0]).toBe("--import");
    expect(args[1]).toMatch(/^file:\/\/.*tsx.*\.mjs$/);
    expect(args[2]?.endsWith(join("apps", "server", "src", "main.ts"))).toBe(true);
  });

  it("keeps fd 3 open for the handshake when the entry is spawned", async () => {
    const entry = join(scratch, "handshake.ts");
    writeFileSync(
      entry,
      [
        'import { writeSync } from "node:fs";',
        'const line: string = JSON.stringify({ url: "http://127.0.0.1:1", token: "t" });',
        "writeSync(3, `${line}\\n`);",
      ].join("\n"),
      "utf8",
    );

    const { command, args } = devServerEntry(process.execPath, MAIN_DIR);
    const child = spawn(command, [...args.slice(0, 2), entry], {
      env: { ...process.env },
      stdio: ["ignore", "ignore", "inherit", "pipe"],
    });

    const received = await new Promise<string>((resolve, reject) => {
      let text = "";
      child.stdio[3]?.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      child.once("error", reject);
      child.once("exit", () => resolve(text));
    });

    expect(JSON.parse(received)).toEqual({ url: "http://127.0.0.1:1", token: "t" });
  });
});

/**
 * The things `record-cmd.mjs` has to *make* before it can record anything.
 *
 * A PNG with real pixels for the image scenario, a dependency-free stdio MCP
 * server for the MCP one, and the source of the PreToolUse hook the recorder
 * installs. They are payloads rather than recording logic, and keeping them
 * here is what stops the recorder growing into a file nobody reads.
 */

import * as NodeZlib from "node:zlib";

/**
 * A solid-colour PNG, built here rather than checked in: the image scenario
 * needs real pixels the model can look at, and a dependency-free encoder is
 * shorter than a base64 blob nobody can read.
 */
export const solidPng = (red, green, blue, size = 2) => {
  const crc = (buffer) => {
    let value = 0xffffffff;
    for (const byte of buffer) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
      }
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body), 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const raw = Buffer.concat(
    Array.from({ length: size }, () =>
      Buffer.concat([
        Buffer.from([0]), // filter: none
        ...Array.from({ length: size }, () => Buffer.from([red, green, blue])),
      ]),
    ),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

export const COLOURS = { red: [220, 30, 30] };
export const MCP_SERVER_SOURCE = `#!/usr/bin/env node
// A minimal stdio MCP server: initialize, tools/list, tools/call(echo).
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\\n");
    if (line === "") continue;
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.method === "initialize") {
      send({ jsonrpc: "2.0", id: request.id, result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "rec", version: "0.0.0" },
      } });
    } else if (request.method === "tools/list") {
      send({ jsonrpc: "2.0", id: request.id, result: { tools: [{
        name: "echo",
        description: "Echo the text back",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      }] } });
    } else if (request.method === "tools/call") {
      const text = (request.params && request.params.arguments && request.params.arguments.text) ?? "";
      send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "echo: " + text }] } });
    } else if (request.id !== undefined) {
      send({ jsonrpc: "2.0", id: request.id, result: {} });
    }
  }
});
`;

/** A throwaway git repo the CLI can safely edit, with the scenario's seed files. */
/**
 * The hook the CLI actually invokes. It is deliberately dumber than the
 * connector's: append the payload the CLI handed us, answer from a policy file
 * on disk, append the answer. The recording then shows both halves of the
 * conversation at the point the CLI blocked on it.
 */
export const HOOK_SOURCE = `#!/usr/bin/env node
import * as NodeFS from "node:fs";
const log = process.env.POSEIDON_RECORD_HOOK_LOG;
const policyPath = process.env.POSEIDON_RECORD_HOOK_POLICY;
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { data += c; });
process.stdin.on("end", () => {
  let payload = null;
  try { payload = JSON.parse(data); } catch { payload = { unparseable: data }; }
  let policy = { default: "allow" };
  try { policy = JSON.parse(NodeFS.readFileSync(policyPath, "utf8")); } catch {}
  const tool = payload && payload.tool_name;
  const decision = (policy.byTool && policy.byTool[tool]) || policy.default || "allow";
  const answer = {
    hookSpecificOutput: {
      permissionDecision: decision,
      permissionDecisionReason:
        decision === "deny" ? "recorded deny from the recording hook" : "recorded allow",
    },
  };
  NodeFS.appendFileSync(
    log,
    JSON.stringify({ at: Date.now(), stdin: payload, answer, env: {
      COMMANDCODE_PROJECT_DIR: process.env.COMMANDCODE_PROJECT_DIR ?? null,
      COMMANDCODE_SESSION_ID: process.env.COMMANDCODE_SESSION_ID ?? null,
      COMMANDCODE_HOOK_EVENT: process.env.COMMANDCODE_HOOK_EVENT ?? null,
      COMMANDCODE_CWD: process.env.COMMANDCODE_CWD ?? null,
    } }) + "\\n",
    "utf8",
  );
  process.stdout.write(JSON.stringify(answer) + "\\n");
  process.exit(0);
});
`;

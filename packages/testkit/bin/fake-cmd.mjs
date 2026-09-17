#!/usr/bin/env node
/**
 * A stand-in for the Command Code CLI.
 *
 * The account that built OpenAde has no credits, so no real turn was ever
 * recorded (docs/decisions/w2-cmd-frames.md). This executable speaks the part
 * of the CLI surface the connector uses, well enough that the whole desktop app
 * runs an end-to-end turn against it: point a connector instance's binary path
 * at this file and send a message.
 *
 *   status --json      auth, version, account, default model
 *   --list-models      the model table the picker parses
 *   --help / --version
 *   -p "<prompt>" --output-format json --verbose ...
 *                      one turn, NDJSON frames on stdout (spec 5.2), a session
 *                      transcript appended under $HOME (5.3), PreToolUse hooks
 *                      invoked for tool calls (5.5), SIGINT → exit 130
 *
 * The turn it runs is chosen from the prompt text, so a human driving the app
 * picks a scenario by what they type:
 *
 *   contains "question"   ask_user_question, through the hook
 *   contains "plan"       a plan file plus its plans-index entry
 *   contains "edit"       an edit_file tool call that really edits a file
 *   contains "tool"/"shell"  a shell_command tool call, through the hook
 *   anything else         a short text answer
 *
 * Deliberately faithful where the connector looks: the transcript is appended
 * line by line while the run is in flight (so a tailer sees partial files), the
 * `session: <id>` line goes to stderr first, `--session` resumes an existing
 * transcript instead of truncating it, and a tool call blocks on the hook's
 * answer exactly as the real harness does.
 *
 * Plain node, no dependencies, never imported by the server bundle.
 *
 * Env knobs, for tests: OPENADE_FAKE_SESSION_ID pins the session id,
 * OPENADE_FAKE_EXIT_CODE overrides the exit code, OPENADE_FAKE_HANG=1 keeps
 * the process alive after the frames so a test can interrupt it, and
 * OPENADE_FAKE_PID_DIR gets a file named after this pid so a suite can check
 * that the process tree really is gone.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.54.0";
const MODEL = "stealth/ox-alpha";

// ── argv ───────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

const out = (line) => process.stdout.write(`${line}\n`);
const emit = (event) => out(JSON.stringify({ type: "event", event }));

// ── status / models / help ─────────────────────────────────────

const listModels = () => {
  const fixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "fixtures",
    "cmd",
    "list-models.txt",
  );
  process.stdout.write(fs.readFileSync(fixture, "utf8"));
};

const help = () => {
  out("Usage: cmd [options] [query]");
  out("");
  out("  -p, --print                 print mode: one turn, then exit");
  out("      --output-format <fmt>   text | json");
  out("      --verbose               progress on stderr");
  out("      --session <id>          resume a session");
  out("      --model <id>            model for this run");
  out("      --effort <level>        low | medium | high | xhigh | max");
  out("      --permission-mode <m>   standard | plan | auto-accept");
  out("      --yolo                  skip permission prompts");
  out("      --list-models           list available models");
  out("  -V, --version               print the version");
  out("");
  out("Commands: status, whoami, login, logout, mcp, skills, mods, update");
};

if (has("--help") || has("-h")) {
  help();
  process.exit(0);
}
if (has("--version") || has("-V")) {
  out(VERSION);
  process.exit(0);
}
if (has("--list-models")) {
  listModels();
  process.exit(0);
}
if (argv[0] === "status") {
  const status = {
    authenticated: true,
    version: VERSION,
    user: "fake-cmd",
    provider: "command-code",
    model: MODEL,
  };
  out(has("--json") ? JSON.stringify(status) : `authenticated as ${status.user}`);
  process.exit(0);
}
if (argv[0] === "whoami") {
  out("fake-cmd");
  process.exit(0);
}

// ── print mode ─────────────────────────────────────────────────

const prompt = value("-p") ?? value("--print") ?? argv.find((arg) => !arg.startsWith("-")) ?? "";
const sessionId =
  value("--session") ??
  value("--resume") ??
  process.env.OPENADE_FAKE_SESSION_ID ??
  crypto.randomUUID();
const resuming = value("--session") !== undefined || value("--resume") !== undefined;
const planMode = value("--permission-mode") === "plan";
const model = value("--model") ?? MODEL;
const cwd = process.cwd();
const home = process.env.HOME ?? os.homedir();

// Spec 5.3: the slug is the cwd lowercased, "/" → "-", leading "-" dropped.
if (process.env.OPENADE_FAKE_PID_DIR !== undefined) {
  fs.mkdirSync(process.env.OPENADE_FAKE_PID_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.OPENADE_FAKE_PID_DIR, String(process.pid)), "", "utf8");
}

const slug = cwd.toLowerCase().replaceAll("/", "-").replace(/^-/, "");
const projectDir = path.join(home, ".commandcode", "projects", slug);
fs.mkdirSync(projectDir, { recursive: true });
const transcript = path.join(projectDir, `${sessionId}.jsonl`);

const append = (line) => fs.appendFileSync(transcript, `${JSON.stringify(line)}\n`, "utf8");

if (!resuming || !fs.existsSync(transcript)) {
  fs.writeFileSync(
    transcript,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd,
    })}\n`,
    "utf8",
  );
}

let lineCounter = 0;
const nextId = (prefix) => {
  lineCounter += 1;
  return `${prefix}-${sessionId.slice(0, 8)}-${lineCounter}`;
};

/** One transcript message line (5.3) plus the message itself, for nextState. */
const messages = [];
const record = (message, extra = {}) => {
  messages.push(message);
  append({
    type: "message",
    id: nextId("line"),
    parentId: null,
    timestamp: new Date().toISOString(),
    message,
    model,
    ...extra,
  });
};

const userMessage = {
  role: "user",
  content: [{ type: "text", text: prompt }],
  meta: { source: "user", createdAt: Date.now(), messageId: nextId("user") },
};

// ── the PreToolUse hook (spec 5.5) ─────────────────────────────

/** The project's hook commands whose matcher accepts `toolName`. */
const hookCommandsFor = (toolName) => {
  const file = path.join(cwd, ".commandcode", "settings.local.json");
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const entries = settings?.hooks?.PreToolUse;
  if (!Array.isArray(entries)) {
    return [];
  }
  const commands = [];
  for (const entry of entries) {
    const matcher = typeof entry?.matcher === "string" ? entry.matcher : ".*";
    let matches = true;
    try {
      matches = matcher === "" || new RegExp(matcher).test(toolName);
    } catch {
      matches = true;
    }
    if (!matches || !Array.isArray(entry?.hooks)) {
      continue;
    }
    for (const hook of entry.hooks) {
      if (typeof hook?.command === "string" && hook.command !== "") {
        commands.push(hook.command);
      }
    }
  }
  return commands;
};

/**
 * Asks the installed hook about one tool call and returns its decision.
 * Plan mode skips hooks entirely, as the real harness does, and no hook (or a
 * hook that prints nothing) means the harness's own flow decided — under
 * `--yolo` that is an allow.
 */
const askHook = (toolName, toolInput) => {
  if (planMode) {
    return { decision: "allow", reason: "plan mode skips hooks" };
  }
  const payload = JSON.stringify({
    session_id: sessionId,
    transcript_path: transcript,
    cwd,
    hook_event_name: "PreToolUse",
    permission_mode: value("--permission-mode") ?? (has("--yolo") ? "bypass" : "default"),
    tool_use_id: nextId("tool"),
    tool_name: toolName,
    tool_display_name: toolName,
    tool_input: toolInput,
  });
  for (const command of hookCommandsFor(toolName)) {
    const result = spawnSync(command, {
      shell: true,
      input: payload,
      encoding: "utf8",
      env: {
        ...process.env,
        COMMANDCODE_PROJECT_DIR: cwd,
        COMMANDCODE_SESSION_ID: sessionId,
        COMMANDCODE_HOOK_EVENT: "PreToolUse",
        COMMANDCODE_CWD: cwd,
      },
    });
    if (result.status === 2) {
      return { decision: "deny", reason: (result.stderr ?? "").trim() || "blocked by hook" };
    }
    const text = (result.stdout ?? "").trim();
    if (text === "") {
      continue;
    }
    try {
      const parsed = JSON.parse(text);
      const output = parsed?.hookSpecificOutput;
      if (output?.permissionDecision !== undefined) {
        return { decision: output.permissionDecision, reason: output.permissionDecisionReason };
      }
    } catch {
      // An unparseable answer is no answer.
    }
  }
  return { decision: "allow", reason: "no hook answered" };
};

// ── the turn ───────────────────────────────────────────────────

const say = (text) =>
  record({
    role: "assistant",
    content: [{ type: "text", text }],
    meta: { source: "model", createdAt: Date.now(), messageId: nextId("asst") },
  });

/** A tool call: the frame, the hook, the transcript pair. Returns the result text. */
const runTool = (toolName, input, run) => {
  const toolUseId = nextId("use");
  emit({ type: "tool_running", toolCallId: toolUseId, toolName, description: toolName });
  const { decision, reason } = askHook(toolName, input);
  const denied = decision === "deny" || decision === "ask";
  const output = denied ? `denied: ${reason ?? "no reason given"}` : run();
  record({
    role: "assistant",
    content: [{ type: "tool_use", id: toolUseId, name: toolName, input }],
    meta: { source: "model", createdAt: Date.now(), messageId: nextId("asst") },
  });
  record({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: [{ type: "text", text: output }],
        ...(denied ? { is_error: true } : {}),
      },
    ],
    meta: { source: "tool", createdAt: Date.now(), messageId: nextId("tool") },
  });
  return output;
};

const writePlan = () => {
  const plansDir = path.join(home, ".commandcode", "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  const file = `fake-cmd-${sessionId.slice(0, 8)}.md`;
  fs.writeFileSync(
    path.join(plansDir, file),
    `# Plan for: ${prompt}\n\n1. Read the code\n2. Make the change\n3. Run the tests\n`,
    "utf8",
  );
  const indexPath = path.join(plansDir, "plans-index.json");
  let index = { version: 1, plans: {} };
  try {
    index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    index.plans = index.plans ?? {};
  } catch {
    // First plan on this machine.
  }
  index.plans[file] = {
    title: `Plan for: ${prompt}`,
    sessionId,
    cwd,
    status: "ready",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return file;
};

const lower = prompt.toLowerCase();

const scenario = () => {
  if (lower.includes("question")) {
    const answer = runTool(
      "ask_user_question",
      {
        questions: [
          {
            questionId: "q1",
            question: "Which one should I use?",
            header: "Pick one",
            options: [
              { optionId: "a", label: "The first one" },
              { optionId: "b", label: "The second one" },
            ],
          },
        ],
      },
      () => "the user did not answer",
    );
    say(`You answered: ${answer}`);
    return "end_turn";
  }
  if (lower.includes("plan")) {
    const file = writePlan();
    say(`I wrote a plan to ~/.commandcode/plans/${file}.`);
    return "end_turn";
  }
  if (lower.includes("edit")) {
    const target = path.join(cwd, "fake-cmd-edit.txt");
    runTool("edit_file", { file_path: target, old_string: "", new_string: prompt }, () => {
      fs.writeFileSync(target, `${prompt}\n`, "utf8");
      return `Edited ${target}`;
    });
    say(`I edited ${path.basename(target)}.`);
    return "end_turn";
  }
  if (lower.includes("tool") || lower.includes("shell")) {
    const command = "echo hello from fake-cmd";
    const output = runTool("shell_command", { command, cwd }, () => "hello from fake-cmd");
    say(`I ran \`${command}\` and it printed: ${output.trim()}`);
    return "end_turn";
  }
  say(`Fake Command Code here. You said: ${prompt}`);
  return "end_turn";
};

// ── run ────────────────────────────────────────────────────────

let interrupted = false;
const onInterrupt = () => {
  interrupted = true;
  process.exit(130);
};
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);

process.stderr.write(`session: ${sessionId}\n`);

record(userMessage);

emit({ type: "run_start", sessionId });
emit({ type: "turn_start", turnNumber: 1 });
emit({ type: "message_start" });
emit({ type: "model_request_start", model });

const stopReason = scenario();

const usage = {
  inputTokens: Math.max(1, prompt.length),
  outputTokens: 24,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const finalText = messages.at(-1)?.content?.find((block) => block.type === "text")?.text ?? "";

emit({
  type: "run_end",
  result: {
    finalText,
    stopReason,
    turnCount: 1,
    usage,
    systemPromptTokens: null,
    nextState: { sessionId, messages, interrupted, modState: {} },
  },
});
out(
  JSON.stringify({
    type: "result",
    subtype: "success",
    sessionId,
    usage,
    durationMs: 1,
    finalText,
  }),
);

if (process.env.OPENADE_FAKE_HANG === "1") {
  // Stay alive so a test (or a human) can interrupt a running turn.
  setInterval(() => {}, 1000);
} else {
  process.exit(Number(process.env.OPENADE_FAKE_EXIT_CODE ?? "0"));
}

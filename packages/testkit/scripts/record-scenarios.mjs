/**
 * What `record-cmd.mjs` asks the real CLI to do.
 *
 * Every scenario answers a question the connector had to guess at (spec 5.7)
 * or exercises a path the connector implements. Prompts are deliberately tiny:
 * each one spends the operator's plan, so they say the least that still forces
 * the behaviour, and `maxTurns` caps every run.
 *
 * A turn is `{ prompt, ...flags }`, or a function of the previous turn's
 * session id when it has to resume.
 */

export const SCENARIOS = {
  text: {
    description: "Text-only answer: does print mode stream deltas? (spec 5.7 q1)",
    turns: [{ prompt: "Reply with exactly: ok", maxTurns: 1 }],
  },

  "shell-allow": {
    description: "shell_command approved through the PreToolUse hook (no --yolo)",
    seed: { "note.txt": "hello\n" },
    turns: [
      {
        prompt: "Run the shell command `cat note.txt` and tell me the output. Use the shell tool.",
        maxTurns: 3,
        yolo: false,
        hookPolicy: { default: "allow" },
      },
    ],
  },

  "shell-deny": {
    description: "shell_command denied through the PreToolUse hook (no --yolo)",
    seed: { "note.txt": "hello\n" },
    turns: [
      {
        prompt: "Run the shell command `cat note.txt` and tell me the output. Use the shell tool.",
        maxTurns: 3,
        yolo: false,
        hookPolicy: { default: "deny" },
      },
    ],
  },

  "shell-yolo": {
    description:
      "the same shell call WITH --yolo — the PreToolUse hook still fires and still gates the call",
    seed: { "note.txt": "hello\n" },
    turns: [
      {
        prompt: "Run the shell command `cat note.txt` and tell me the output. Use the shell tool.",
        maxTurns: 3,
        hookPolicy: { default: "allow" },
      },
    ],
  },

  "file-edit": {
    description: "edit_file / write_file blocks in frames and transcript",
    seed: { "greeting.txt": "hello world\n" },
    turns: [
      {
        prompt: "Edit greeting.txt so it says `hello there` instead of `hello world`.",
        maxTurns: 3,
        hookPolicy: { default: "allow" },
      },
    ],
  },

  plan: {
    description:
      "plan mode: is the plan file written before run_end, does run_end reference it? (5.7 q6)",
    seed: { "app.js": "export const add = (a, b) => a + b;\n" },
    turns: [
      {
        prompt:
          "Plan how to add a subtract function to app.js, then call exit_plan_mode to present it.",
        maxTurns: 10,
        permissionMode: "plan",
        // Plan mode skips PreToolUse hooks and denies writes, so without
        // --yolo the model cannot write the plan file it is told to write.
        yolo: true,
      },
      ({ sessionId }) => ({
        prompt: "The plan is accepted. Implement it now.",
        maxTurns: 6,
        sessionId,
        hookPolicy: { default: "allow" },
      }),
    ],
  },

  question: {
    description: "ask_user_question in print mode: fail, auto-answer, or block? (5.7 q3)",
    turns: [
      {
        prompt:
          "Use the ask_user_question tool to ask me whether I prefer tabs or spaces. Ask before doing anything else.",
        maxTurns: 2,
        hookPolicy: { default: "deny" },
      },
    ],
  },

  interrupt: {
    description: "SIGINT mid-turn — exit code and whether run_end still lands",
    seed: { "note.txt": "hello\n" },
    turns: [
      {
        prompt: "Count slowly from 1 to 200, one number per line, with a short comment on each.",
        maxTurns: 2,
        sigintAfterMs: 9000,
      },
    ],
  },

  resume: {
    description: "second turn resuming the first session id (--session)",
    turns: [
      { prompt: "Remember the word `pineapple`. Reply with exactly: stored", maxTurns: 1 },
      ({ sessionId }) => ({
        prompt: "What word did I ask you to remember? Reply with just the word.",
        maxTurns: 1,
        sessionId,
      }),
    ],
  },

  "max-turns": {
    description: "--max-turns exhausted: stopReason, result.subtype and exit code",
    seed: { "note.txt": "one\n" },
    turns: [
      {
        prompt:
          "Read note.txt, then run `ls`, then run `pwd`, then run `date`, then summarise. Use one tool per step.",
        maxTurns: 1,
        hookPolicy: { default: "allow" },
      },
    ],
  },

  image: {
    description:
      "image attachment by absolute path in the prompt (decision w10-attachments) (5.7 q4)",
    turns: [
      ({ scratch }) => ({
        prompt: `Look at the image at ${scratch}/red.png and tell me in one word what colour it is.`,
        maxTurns: 3,
        addDir: [scratch],
        hookPolicy: { default: "allow" },
      }),
    ],
  },

  mcp: {
    description: "an mcp__<server>__<tool> call — does PreToolUse fire for it? (5.7 q7)",
    turns: [
      {
        prompt: "Use the openade_echo tool from the `rec` MCP server with text `hi`.",
        maxTurns: 3,
        hookPolicy: { default: "allow" },
      },
    ],
  },
};

export const scenarioNames = () => Object.keys(SCENARIOS);

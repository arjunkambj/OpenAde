OpenADE MVP Build Spec

-

-

  OpenADEMVP build specv0.2 · 2026-09-15Electron · Command Code first

# OpenADE MVP Build Spec

  A spec that independent agents can pick up and build in parallel. It fixes the stack, the repo layout, the contracts every workstream shares, the facts we verified about the Command Code harness, and one workstream per agent with owned directories, reference files on this machine, and a definition of done.

  Fixed decisions. Electron desktop app. Command Code (npm command-code, binary cmd, by the Langbase team) is the only connector, behind an extensible connector SDK so Claude Code, Codex and others can follow. Transport is Effect RPC over WebSocket. Renderer state is Effect Atom only, no Zustand. Browser automation is Vercel agent-browser. Everything else was chosen as the best option from Log 01. Reference repos live beside this spec at /Volumes/main/Code/ade/{t3code,zuse,synara,opencodex} and are read-only.

  Verification gap. The Command Code account on this machine had no credits on 2026-09-15 (exit code 10). The headless event frames below were captured up to the model call; text-delta granularity, image attachments in print mode and the behavior of ask_user_question in headless runs are unverified and are W2's first task once credits exist. Two probe sessions were created under ~/.commandcode/projects/private-tmp-claude-501-...-cmd-probe/; delete that directory when convenient.

  Contents

- 0. How agents use this spec

- 1. Scope

- 2. Architecture

- 3. Stack and versions

- 4. Repo layout

- 5. Command Code harness facts

- 5.1 CLI and headless mode

- 5.2 NDJSON frames (captured)

- 5.3 Session transcript on disk

- 5.4 Tool vocabulary

- 5.5 Permissions and hooks

- 5.6 MCP, skills, IDE socket

- 5.7 Unknowns to verify

- 6. Contracts

- 7. Connector SDK

- 8. Command Code connector design

- 9. Server design

- 10. Transport and client runtime

- 11. Renderer

- 12. Browser (agent-browser)

- 13. Desktop shell

- 14. Workstreams

- 15. Milestones

- 16. Guardrails

- 17. Open items

## 00How agents use this spec

- One agent per workstream (section 14). Each workstream owns a directory set and must not edit files outside it except through a PR to the contracts owner. W0 lands first; every other workstream starts from W0's stubs and fakes, not from each other.

- Contracts are the seam. Cross-workstream communication happens only through packages/contracts and packages/connector-sdk. Need a new field or RPC? Add it to contracts first with a schema test, then build against it.

- Read the reference files before writing. Every workstream lists files on this machine. Copy the shape and the lessons, not the code, unless the source is MIT and small enough to vendor with attribution (t3code and synara are MIT; zuse is AGPL, read only; Command Code itself is UNLICENSED and must never be vendored, only spawned).

- Definition of done is per workstream and includes tests. Tests wait on receipts, queues and deferreds, never on sleeps.

- Ask by writing. If something is ambiguous, write the assumption into docs/decisions/<workstream>-<topic>.md and proceed. Do not block.

- Root of the new code: /Volumes/main/Code/ade/openade/. Nothing is created outside it except docs/.

## 01Scope

### MVP (in)

- macOS Electron app. Linux and Windows are P1 but nothing may block them: OS-specific code lives only in apps/desktop/src/platform/.

- Projects (a local git repo path) and threads (a conversation bound to one project and one Command Code session id).

- Full timeline: assistant text, reasoning, shell commands, file changes, MCP tool calls, subagent tasks, plan proposals, errors, compaction.

- Composer with slash commands, @ file mentions, image attachments, queued messages. Mid-turn steering is not supported by Command Code's print mode; queued messages start the next turn.

- Approvals with allow-once, allow-for-session, allow-always by pattern; AskUserQuestion cards; plan mode with accept and revise; interrupt.

- Model and effort selection per thread (Command Code's 70-model catalog), runtime modes approval-required, auto-accept-edits, full-access; default approval-required.

- Session resume after app restart and after server crash, using Command Code's own session ids.

- Changes pane: per-turn checkpoints (hidden git refs) and a diff view of the working tree or any turn.

- Browser pane driven by agent-browser, exposed to Command Code through our MCP server, with a human-interrupt rule.

- Settings: connector instances (binary path), MCP server editor writing Command Code's native config, skills list, keybindings, theme.

### Explicitly out (P1 or later)

- Any second connector (Claude Code is the obvious next; its SDK facts are in Log 01), mobile, web-hosted client, remote access, cloud, billing.

- Integrated terminal, file editor, git worktree per thread (Command Code has -w built in; surface it in P1), PR review, multi-account (Command Code has no config-dir override; only HOME).

- Acting as Command Code's IDE over its unix socket (getContext, getDiagnostics). Reserved for P1.

- Any-model routing through opencodex. The connector reserves an extraEnv hook.

## 02Architecture

      Electron main
Window, preload, custom scheme, server child supervisor, remote-debugging port for agent-browser, updater stub.
apps/desktop

      Server (child process)
Effect runtime. SQLite event log + projections, orchestration engine, connector registry, permission service, hook bridge, MCP HTTP server, browser service, git service.
apps/server · owns all state

      Renderer
React 19, TanStack Router, Effect Atom only. RpcClient over WebSocket. Timeline, composer, panes, settings.
apps/web · stateless, replayable

    renderer ⇄ server: Effect RPC over one WebSocket (JSON) · main ⇄ server: stdio JSON handshake only · main ⇄ renderer: minimal preload bridge

      connector-cmd
Spawns cmd -p --output-format json per turn, tails the session JSONL, bridges PreToolUse hooks to approvals, emits canonical runtime events.
packages/connector-cmd

      agent-browser
Rust CLI + daemon attached over CDP to the in-app preview webview. Wrapped by BrowserService, exposed as MCP tools.
external binary

      Command Code CLI
User's own cmd install and login. Gets our MCP server via its native mcp.json and our hook via project settings. Never sees control-plane env.
external binary · UNLICENSED

  InvariantThe server is the only writer of durable state. The renderer is a projection of the event log and can be closed, crashed and reopened at any time without losing a turn. The desktop main process owns no product state.

  InvariantConnector identity never reaches the renderer as a literal. The renderer renders from capability flags and the canonical event union. Adding a connector touches zero files under apps/web.

## 03Stack and versions

     |  | Layer | Choice | Version | Why / reference

       | Package manager | pnpm workspaces + catalog | pnpm 10 | Same as t3code. See /Volumes/main/Code/ade/t3code/pnpm-workspace.yaml.

       | Runtime | Node | 22.16+ | node:sqlite needs 22.13+. No Bun in the runtime path.

       | Effect | effect, @effect/platform-node, @effect/atom-react | 4.0.0-rc.112, all pinned together | The version t3code ships on; its patch is at /Volumes/main/Code/ade/t3code/patches/. Use effect/unstable/rpc and effect/unstable/sql as t3code does. Never an unreleased fork.

       | Harness | Command Code CLI, spawned | command-code 1.54.0 (npm) | No SDK exists; the CLI's print mode plus its on-disk transcript is the integration surface. The package is UNLICENSED: spawn the user's install, never bundle or vendor.

       | Desktop | Electron + electron-builder + electron-updater | Electron 44 | Renderer served from a privileged custom scheme with code cache (synara pattern).

       | UI | React 19.2, TanStack Router, Tailwind 4, @base-ui/react, lucide-react | 19.2.x / 1.160+ | What all three IDEs converged on.

       | State | @effect/atom-react only | rc.112 | Server-derived state via atoms bound to the RPC runtime, UI state via Atom.make. No Zustand, no TanStack Query.

       | Timeline / diffs | @legendapp/list, @pierre/diffs in a worker, react-markdown + gfm | list 3.3.x, diffs 1.3.x | All three use these.

       | Composer | Textarea + popovers for MVP; Lexical is P1 | – | Lexical composers in t3code and synara are 6k+ lines.

       | DB | node:sqlite wrapped as an Effect SqlClient | built-in | Zero native modules. Zuse's wrapper: /Volumes/main/Code/ade/zuse/packages/sqlite/src/index.ts.

       | Browser | agent-browser (Vercel) | 0.37.x | Fixed by decision. CDP mode against the Electron preview webview.

       | Build | Vite 7 (renderer), tsdown or esbuild (server, desktop), tsc for typecheck | – | Keep the toolchain boring.

       | Quality | vitest + @effect/vitest, oxlint, oxfmt, knip | – | Lint errors are errors. See section 16.

## 04Repo layout

```
/Volumes/main/Code/ade/openade/
  package.json                 # workspace root, scripts: dev, build, test, lint, typecheck, check
  pnpm-workspace.yaml          # packages + catalog
  tsconfig.base.json
  apps/
    desktop/                   # Electron main + preload (W7)
      src/main.ts, src/preload.ts, src/backend/ServerSupervisor.ts, src/platform/*
    server/                    # Effect server, spawned as a child (W1, W3, W6, W8, W9)
      src/main.ts              # boots Layers, prints {port, token, serverInstanceId} to fd 3
      src/persistence/         # Sqlite layer, Migrations/, EventStore, Projections
      src/orchestration/       # decider.ts, projector.ts, Engine.ts, reactors/, LiveStream*
      src/connectors/          # Registry.ts, instances, SessionSupervisor.ts
      src/permissions/         # PermissionService, PatternMatcher (Command Code's pattern language)
      src/hooks/               # HookBridge.ts: loopback HTTP endpoint the cmd hook script calls; blocks on approvals
      src/mcp/                 # McpHttpServer.ts, tools/browser.ts
      src/browser/             # BrowserService.ts (agent-browser wrapper)
      src/git/                 # GitService.ts, CheckpointStore.ts, DiffService.ts
      src/settings/            # SettingsStore.ts, CmdConfigWriter.ts (mcp.json, settings.local.json with ownership markers)
      src/rpc/                 # RpcGroup handlers, WsServer.ts, auth
      test/
    web/                       # React renderer (W4, W5, W9)
      src/routes/  src/state/ (atoms only)  src/components/{timeline,composer,panes,sidebar,settings,approvals}/
  packages/
    contracts/                 # Effect Schema: ids, runtime events, orchestration, rpc, settings (W0 owns)
    connector-sdk/             # SessionHandle, ConnectorDefinition, TurnScopedHandle, conformance test, fakes (W0 owns)
    connector-cmd/             # Command Code implementation (W2)
      src/spawn.ts             # argv builder, env allowlist, process-tree teardown
      src/ndjson.ts            # frame parser for --output-format json
      src/transcript.ts        # JSONL tailer for ~/.commandcode/projects/<slug>/<session>.jsonl
      src/translate.ts         # frames + transcript → RuntimeEvent
      src/hookScript.ts        # generates the hook script installed to ~/.openade/bin/
      src/config.ts            # writes .commandcode/settings.local.json + projects/<slug>/mcp.json with markers
    client-runtime/            # RpcClient, WS protocol, reconnect, atom runtime factory (W3)
    shared/                    # tiny utils, ids, paths; no barrel
    testkit/                   # FakeConnector, FakeCmdProcess (replays captured NDJSON + JSONL), receipts, sqlite helper
  docs/decisions/
```

  RuleNo file over 800 lines outside tests. No barrel files. Boundaries enforced in CI: web imports only contracts, client-runtime, shared; connector-* imports only connector-sdk, contracts, shared.

## 05Command Code harness facts

  Everything in this section was verified on this machine on 2026-09-15 against command-code@1.54.0, the public docs at commandcode.ai/docs, the user's existing transcripts under ~/.commandcode, and the bundled VS Code extension. Items marked verify could not be confirmed without account credits.

### 5.1 CLI and headless mode

```
npm i -g command-code            # binary: cmd   (not on PATH on this machine today; run via `npx -y command-code@latest` until installed)
cmd status --json                # {"authenticated":true,"version":"1.54.0","user":"...","provider":"command-code","model":"stealth/ox-alpha"}
cmd --list-models                # 70 models, e.g. deepseek/deepseek-v4-flash (default), moonshotai/kimi-k3, zai-org/glm-5.3, qwen/qwen3.8-max
cmd whoami · cmd login · cmd logout · cmd mcp · cmd skills · cmd mods · cmd update

# one turn, headless
cmd -p "<prompt>" --output-format json --verbose \
    [--session <id-or-transcript-path>]   # resume; omit on the first turn, read sessionId from run_start
    [--model <id>] [--effort low|medium|high|xhigh|max]   # effort ladder is per model
    [--permission-mode standard|plan|auto-accept]           # help says "standard", docs say "default"; treat both
    [--yolo]                                                # alias of --dangerously-skip-permissions
    -t --skip-onboarding --no-auto-update [--max-turns N] [--add-dir <dir>] [--name <n>] [--no-session]
# stdin is auto-detected as the prompt when no query arg is given; piped stdin times out after 30s
# --verbose prints "session: <uuid>" to stderr first, then tool progress
# exit codes: 0 ok · 1 error · 3 not authenticated · 4 permission denied · 5 rate limit · 6 network · 7 api 5xx
#             8 max turns · 9 no response · 10 insufficient credits · 130 interrupted (SIGINT/SIGTERM)
```

- Print mode is one turn per process. There is no stdin control protocol and no way to inject a message mid-turn. Steering is therefore a queued next turn. Interrupt is SIGINT, exit 130.

- Headless permission defaults: reads, grep and glob allowed; edits, writes and shell blocked unless --yolo or --permission-mode auto-accept. There is no interactive approval channel in print mode. The approval channel we use is the PreToolUse hook (5.5).

- Sessions: --session <id> resumes; --fork-session branches; -r and -c exist for interactive use. -w runs in a managed worktree (P1).

- Config file locations: ~/.commandcode/{config.json, settings.json, auth.json, providers.json, keybindings.json, mcp.json, skills/, plans/, projects/<slug>/, file-history/, ide/}; project .commandcode/{settings.json, settings.local.json} and .mcp.json. Precedence: project local → project → user settings → config.json. Permission lists union across layers.

- Env: COMMAND_CODE_API_KEY overrides auth.json; COMMANDCODE_SKIP_UPDATES; DO_NOT_TRACK; MCP_TOOL_TIMEOUT; MAX_MCP_OUTPUT_TOKENS. No config-dir override; only HOME.

### 5.2 NDJSON frames (captured) verified

  One JSON object per line on stdout. Every frame is {"type":"event","event":{...}} except the last, which is {"type":"result",...}. Captured on a run that failed at the model call:

```
{"type":"event","event":{"type":"run_start","sessionId":"5bc08bab-..."}}
{"type":"event","event":{"type":"turn_start","turnNumber":1}}
{"type":"event","event":{"type":"message_start"}}
{"type":"event","event":{"type":"model_request_start","model":"stealth/ox-alpha"}}
{"type":"event","event":{"type":"model_trace","traceId":"4ecfff3e..."}}
{"type":"event","event":{"type":"run_error","error":{"name":"TransportError","message":"POST /alpha/generate → 400 error: ..."}}}
{"type":"event","event":{"type":"run_end","result":{"finalText":"","stopReason":"run_error","turnCount":1,
   "usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0},"systemPromptTokens":null,
   "nextState":{"sessionId":"...","messages":[{"role":"user","content":[{"type":"text","text":"..."}],
      "meta":{"source":"user","createdAt":1789479681987,"messageId":"7c47ccfc-..."}}],"interrupted":false,"modState":{...}}}}}
{"type":"result","subtype":"error","sessionId":"5bc08bab-...","usage":{...},"durationMs":3308,"finalText":"","error":"Error: ..."}
# documented but not yet captured:  {"type":"event","event":{"type":"tool_running","toolCallId":"…","toolName":"read_file","description":"…"}}
# documented result.subtype values: success | error | max_turns ; stopReason e.g. end_turn | max_turns | run_error
```

- run_end.result.nextState.messages carries the complete message list of the run in the same shape as the transcript (5.3): content blocks, meta, and per-assistant usage. That is our authoritative end-of-turn source even if streaming frames are sparse.

- Whether text deltas stream (a text_delta or message_delta frame) is unverified. Design for both: the timeline shows a live "working" row fed by tool_running frames and the transcript tailer, and the assistant text appears as soon as either a delta frame or a transcript append delivers it.

### 5.3 Session transcript on disk verified from 180 local sessions

```
~/.commandcode/projects/<slug>/<sessionId>.jsonl            # slug = cwd lowercased, "/" → "-", leading "-" stripped
                                        <sessionId>.meta.json         # { entrypoint, traceIds[] }   (title, model, lineage per docs)
                                        <sessionId>.checkpoints.jsonl # { id, messageId, turnNumber, createdAt, prompt, messageCount, files[] } one per prompt
                                        <sessionId>.prompts.jsonl
                                        mcp.json                      # local-scope MCP servers for this project
~/.commandcode/file-history/<sessionId>/                            # file backups for checkpoints (30 days, 200 per session, 10MB per file)

# line 1 (header)
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/abs/path"}
# every other line
{"type":"message","id":"<uuid>","parentId":"<uuid>|null","timestamp":"...",
 "message":{"role":"user|assistant","content":[Block...],"meta":{"source":"user|model|tool|followup","createdAt":ms,"messageId":"..."}},
 "usage":{"inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens","costUsd"}?,   // assistant lines only
 "model":"provider/model"?, "effort":"..."?}
# Block = {type:"text",text} | {type:"thinking",thinking,signature} | {type:"tool_use",id,name,input}
#       | {type:"tool_result",tool_use_id,content:[{type:"text",text}],is_error?} | {type:"image",source:{type:"base64",media_type,data}}
# tool results arrive as a "user" role line with meta.source:"tool"; parentId forms a tree (forks, /rewind)
```

  The transcript is Claude-Code-shaped: a message tree with content blocks. The connector tails it with an inotify/fs.watch reader keyed by byte offset, parses complete lines only, and emits item.* events per block. The NDJSON stream and the transcript overlap; the translator dedupes on tool_use.id and messageId.

### 5.4 Tool vocabulary verified from transcripts

     |  | Command Code tool | Input keys seen | Canonical ItemKind | ApprovalKind

       | shell_command | command, description, timeout?, cwd? | command_execution | command

       | edit_file | file_path, old_string, new_string | file_change (edit) | file_write

       | write_file | file_path, content | file_change (create) | file_write

       | read_file | file_path | paths[], offset?, limit? | tool_call (read) | file_read

       | read_directory, glob, grep | path / pattern, output_mode, head_limit, -n | tool_call (read) | file_read

       | todo_write | todos[] | todo | –

       | agent | prompt, subagent_type, description? | task (nested) | –

       | ask_user_question | questions[] | user-input.requested | –

       | activate_skill | name, arguments? | skill | –

       | web_search, web_fetch | query / url, format? | web_search | web

       | mcp__<server>__<tool> | server-defined | mcp_tool_call | mcp_tool

  DecisionCommand Code's tool names and input keys are the canonical vocabulary of our ItemSnapshot. A future Claude Code connector translates Bash → shell_command, Edit → edit_file, and so on. The renderer never sees any other names.

### 5.5 Permissions and hooks documented

```
# .commandcode/settings.json | settings.local.json  (project)   or ~/.commandcode/settings.json (user)
{ "permissions": { "defaultMode": "default|auto-accept|plan|dont-ask",
                   "deny": ["Read(secrets/**)", "Shell(rm -rf /*)"],
                   "ask":  ["Shell(git push:*)", "Edit(.env*)"],
                   "allow": ["Shell(git status:*)", "Shell(npm run *)", "Edit(/src/**)", "mcp__github__get_issue"],
                   "additionalDirectories": [] },
  "hooks": { "PreToolUse": [{ "matcher": "shell|write|edit|read", "hooks": [{ "type": "command", "command": "/abs/hook", "timeout": 600 }] }],
             "PostToolUse": [...], "Stop": [...], "SessionStart": [...] } }
# ladder (simplified, from docs): deny → ask → external dir? ask → plan+mutates? deny → read-only? allow → root/home removal? ask
#                                 → bypass? allow → sensitive write? ask → allow rules → auto-accept+workspace? allow → else ask (deny in dont-ask)
# hook stdin JSON: session_id, transcript_path, cwd, hook_event_name, permission_mode, tool_use_id, tool_name, tool_display_name, tool_input
# hook stdout for PreToolUse: {"hookSpecificOutput":{"permissionDecision":"allow|deny","permissionDecisionReason":"...","additionalContext":"..."}}
# exit 0 = parse stdout; exit 2 = block; hooks run through the system shell; timeout default 30s, max 600s; hooks are skipped in plan mode
# env injected: COMMANDCODE_PROJECT_DIR, COMMANDCODE_SESSION_ID, COMMANDCODE_HOOK_EVENT, COMMANDCODE_CWD
```

- Our approval bridge: run print mode with --yolo so the CLI never blocks on its own prompts, and install a PreToolUse hook that POSTs the stdin JSON to the server's HookBridge and blocks until the user decides (or 590s, then deny with a reason). The hook returns permissionDecision. Command Code's own deny rules still win, which is what we want.

- Sensitive paths: bypass mode skips Command Code's sensitive-write prompt, so our permission engine reproduces the list (.env*, *.pem, *.key, id_rsa, .ssh/**, .git/**, .aws/**, .commandcode settings, and so on) and always prompts on them.

- Pattern language is Command Code's: Shell(npm run *), Edit(/src/**), Read(~/.ssh/**), mcp__server__tool, deny wins then ask then allow. Our PatternMatcher implements exactly this and our allow-always writes into settings.local.json so the rule also applies when the user runs cmd in a terminal.

- Stop hook with decision:"block" can force a revision; we do not use it in MVP. SessionStart gives us the session id when resuming interactive sessions (P1 IDE mode).

### 5.6 MCP, skills, plans, IDE socket

```
cmd mcp add --transport http <name> <url> [--header "Authorization: Bearer ..."]     # scopes: user ~/.commandcode/mcp.json
cmd mcp add <name> -- <command>                                                       #         project .mcp.json
{ "transport": "http", "enabled": true, "url": "http://127.0.0.1:PORT/mcp", "headers": { "Authorization": "Bearer ${OPENADE_MCP_TOKEN}" } }
# ${VAR} and ${VAR:-default} resolve at runtime → the per-session bearer is injected as env on spawn, never written to disk
# tools appear to the model as mcp__<server>__<tool>; MCP_TOOL_TIMEOUT and MAX_MCP_OUTPUT_TOKENS (25000) cap them

skills: ~/.commandcode/skills/<name>/SKILL.md (7 installed here), `cmd skills`, --skill <path>, settings.skills[], disabledSkills[]
plans:  --permission-mode plan writes only ~/.commandcode/plans/<name>.md; plans-index.json = { version, plans: { file: { title, sessionId, cwd, status, createdAt, updatedAt, annotations[] } } }
IDE:    ~/.commandcode/ide/<ideName>-<8hex>.json { socketPath, workspaceFolders[], pid, ideName, timestamp } + a unix socket;
        request/response JSON with methods getContext (active file, selection, maxSelectionLength) and getDiagnostics; ideName ∈ code|cursor|windsurf
        → P1: we register as an IDE so `cmd` in our future terminal gets open-file context from our panes
```

### 5.7 Unknowns to verify first W2 day one, needs credits

- Does --output-format json stream assistant text deltas, or only tool events plus the final run_end? Record a real turn to packages/testkit/fixtures/cmd/.

- Does the transcript JSONL grow during the turn (per message) or only at turn end?

- What does ask_user_question do in print mode: fail, auto-answer, or block? Our fallback is a PreToolUse hook on it that shows our card and returns deny with the user's answers in permissionDecisionReason.

- How are images attached in print mode? No flag is documented. Fallback: write the image to the attachments dir and reference the path in the prompt.

- --permission-mode accepted values: help lists standard|plan|auto-accept, docs list default|plan|auto-accept|dont-ask.

- Is the plan file written before run_end, and does run_end reference it?

- Whether PreToolUse fires for agent subagent tool calls and for MCP tools (matcher value for MCP tools).

## 06Contracts

  All wire types are Effect Schema in packages/contracts. W0 turns this into code with encode/decode round-trip tests. Field names are final unless a decision doc says otherwise.

```
// ids.ts
ProjectId, ThreadId, TurnId, ItemId, RequestId, EventId, CommandId, ConnectorInstanceId, CheckpointId  // branded UUIDv7 strings
ConnectorKind      = Schema.String                       // opaque, e.g. "cmd". NEVER a Literals union.
RuntimeMode        = Literals("approval-required" | "auto-accept-edits" | "full-access")
InteractionMode    = Literals("default" | "plan")
Effort             = Literals("low" | "medium" | "high" | "xhigh" | "max")   // ModelOption.efforts lists what a model accepts
ItemKind           = Literals("user_message" | "assistant_message" | "reasoning" | "plan" | "command_execution" | "file_change"
                     | "tool_call" | "mcp_tool_call" | "web_search" | "task" | "todo" | "skill" | "context_compaction" | "error" | "unknown")
ApprovalKind       = Literals("command" | "file_write" | "file_read" | "mcp_tool" | "web" | "other")
ApprovalDecision   = Literals("allow-once" | "allow-session" | "allow-always" | "deny")

// runtime.ts  (connector → server)
RuntimeEventEnvelope = { eventId, connectorInstanceId, threadId, createdAt, turnId?, itemId?, requestId?,
                         raw?: { source: string, method?: string, payload: unknown } }   // e.g. "cmd.ndjson" | "cmd.transcript" | "cmd.hook"
RuntimeEvent = Union(
  session.started      { sessionRef: unknown, model, capabilities: ConnectorCapabilities }
  session.ended        { reason: "stopped" | "crashed" | "interrupted", exitCode?: number }
  session.warning      { message }
  turn.started         { turnId }
  turn.completed       { turnId, stopReason: "end_turn" | "interrupted" | "error" | "max_turns" }
  turn.plan.proposed   { turnId, planMarkdown, planPath? }
  item.started / item.updated / item.completed { item: ItemSnapshot }
  content.delta        { itemId, kind: "text" | "reasoning" | "tool_input", delta }
  request.opened       { request: ApprovalRequest }
  request.resolved     { requestId, decision: ApprovalDecision }
  user-input.requested { requestId, questions: UserQuestion[] }
  user-input.resolved  { requestId }
  task.started / task.updated / task.completed { taskId: ItemId, parentItemId?, title, model?, status }
  usage.updated        { turnId, input, output, cacheRead, cacheWrite, costUsd? }
  context.updated      { used, limit }
  model.changed        { model, effort? }
  mcp.status.updated   { servers: { name, status }[] }
  runtime.error        { message, fatal: boolean }
  event.unmapped       { }                                   // raw is mandatory here
)
ItemSnapshot = { itemId, kind, status: "in_progress" | "completed" | "failed", parentItemId?,
                 text?, command?: { cmd, cwd?, exitCode?, output? }, fileChange?: { path, kind: "create" | "edit" | "delete", diff? },
                 tool?: { name, server?, input: unknown, output?: unknown }, plan?: { markdown }, todos?: Todo[], error?: { message } }
ApprovalRequest = { requestId, kind: ApprovalKind, toolName, input: unknown, patternSuggestion?: string, description }
ConnectorCapabilities = { modelSwitch: "per-turn" | "in-session" | "restart", effortSwitch: "per-turn" | "in-session" | "restart",
                          steering: boolean, planMode: boolean, subagents: boolean, images: boolean, resume: boolean, fork: boolean }
// Command Code reports: modelSwitch "per-turn", effortSwitch "per-turn", steering false, planMode true, subagents true, images ?, resume true, fork true

// orchestration.ts  (unchanged shape from v0.1)
Command = project.create | project.remove | thread.create | thread.rename | thread.archive | thread.delete
        | thread.turn.start { threadId, text, attachments, mentions, queued } | thread.turn.interrupt
        | thread.settings.update { model?, effort?, runtimeMode?, interactionMode? }
        | thread.approval.respond { requestId, decision, pattern? } | thread.userInput.respond { requestId, answers }
        | thread.plan.respond { turnId, action: "accept" | "accept-auto" | "revise", feedback? } | thread.checkpoint.restore
CommandReceipt = { commandId, status: "accepted" | "rejected", reason?, lastSequence }
OrchestrationEvent = { sequence, eventId, streamKind, streamId, streamVersion, occurredAt, commandId?, causationEventId?, correlationId?, actor, type, payload }
OrchestrationEventType = project.* | thread.created | thread.renamed | thread.archived | thread.session.bound { connectorInstanceId, sessionRef }
  | thread.session.lost | thread.turn.requested | thread.turn.started | thread.turn.completed | thread.turn.interrupted
  | thread.message.queued | thread.message.dequeued | thread.item.upserted | thread.approval.opened | thread.approval.resolved
  | thread.userInput.requested | thread.userInput.resolved | thread.plan.proposed | thread.plan.responded
  | thread.settings.updated | thread.usage.updated | thread.context.updated | thread.checkpoint.created | thread.error
ThreadSummary, ThreadDetailSnapshot, ThreadStreamItem = { snapshot } | { event } | { synchronized } | { resnapshot-required }   // as v0.1

// rpc.ts — one RpcGroup, Effect RPC, JSON, stream: true where noted
server.hello · orchestration.dispatch · projects.list · threads.list · threads.subscribe(stream) · threads.listSubscribe(stream)
connectors.list · connectors.models({instanceId}) → ModelOption[] { id, label, family, efforts: Effort[], contextWindow?, vision?, free? }
files.search · files.read · git.status · git.diff · browser.subscribe(stream) · browser.humanInput
settings.get / update / subscribe(stream) · cmdConfig.mcp.list / upsert / remove · cmdConfig.skills.list · keybindings.get / update

// settings.ts
Settings = { connectors: ConnectorInstanceConfig[], defaults: { model, effort, runtimeMode }, theme, keybindings, permissions: PermissionRule[] }
PermissionRule = { scope: "global" | "project" | "session", projectId?, threadId?, pattern: string /* Command Code syntax */, decision: "allow" | "deny", createdAt }
CmdConnectorConfig = { binaryPath?: string, extraEnv?: Record<string,string>, defaultModel?: string }   // settingsForm annotations on each field
```

  BudgetEvery stream RPC has a server-side budget: 1,000 items or 8MB per subscription, 50ms coalescing. Exceeding it fails the stream with resnapshot-required. A CI test asserts bytes-on-the-wire for a 200-item thread.

## 07Connector SDK

```
// packages/connector-sdk
interface ConnectorDefinition<Config> {
  kind: ConnectorKind; displayName: string
  configSchema: Schema.Codec<Config, unknown>; defaultConfig: () => Config
  probe: (config) => Effect<ConnectorProbe>        // binary path + version, auth: present | absent | unknown, account, models, warnings
  createInstance: (input: { instanceId, config, services: ConnectorServices }) => Effect<ConnectorInstance, ConnectorError, Scope>
}
interface ConnectorInstance { instanceId; kind; capabilities; startSession(input); resumeSession(input & { sessionRef }); listModels() }
interface SessionHandle {                              // one per thread
  events: Stream<RuntimeEvent>                        // bounded 2048 with a 64-slot reserve for terminal events
  send(turn: TurnInput): Effect<void>                 // fails with TurnInProgress if a turn is running and !capabilities.steering
  interrupt(); respondToRequest(requestId, decision, updatedInput?); respondToUserInput(requestId, answers); respondToPlan(turnId, action, feedback?)
  updateSettings(patch: { model?, effort?, runtimeMode?, interactionMode? })   // applied on the next turn when capabilities say "per-turn"
  sessionRef(): Effect<unknown>; close(): Effect<void>  // close proves the process tree is gone
}
ConnectorServices = { mcpEndpoint(threadId) → { url, bearer }, hookEndpoint(threadId) → { url, bearer },   // our loopback servers
                      permissions: { decide(request) → "allow" | "prompt" | "deny" }, attachmentsDir, logger, clock }
TurnInput = { text, attachments: { path, mime }[], mentions: FileRef[] }
```

- makeTurnScopedHandle wraps any handle: tags events with the active turnId, synthesizes turn.completed { stopReason: "error" } if the process dies mid-turn, refuses overlapping turns. Semantics from /Volumes/main/Code/ade/zuse/packages/agents/src/kernel/turn-protocol.ts.

- Conformance test takes any definition plus a fake process and asserts event ordering: started before items, completed exactly once per turn, every request.opened resolved, nothing after close.

- Registry is one array: [cmdConnector]. Routing is by instance id, never by kind.

## 08Command Code connector design

### Turn lifecycle

```
send(turn)
  1. write attachments to <attachmentsDir>/<threadId>/, expand @mentions into "@path" text (Command Code resolves @ paths itself)
  2. ensure project config: .commandcode/settings.local.json has our hook block (ownership marker "// openade:managed"), projects/<slug>/mcp.json has our server entry
  3. argv = cmd -p <text> --output-format json --verbose -t --skip-onboarding --no-auto-update --yolo
           [--session <sessionId>]  [--model m] [--effort e]  [--permission-mode plan]   (plan mode replaces --yolo)
     env  = allowlist(PATH, HOME, LANG, TERM, TMPDIR) + OPENADE_MCP_TOKEN + OPENADE_HOOK_URL + OPENADE_HOOK_TOKEN + OPENADE_THREAD_ID + config.extraEnv
            minus anything starting with OPENADE_SERVER_, ANTHROPIC_, OPENAI_ (control plane and foreign credentials never leak)
  4. spawn detached process group; parse stdout NDJSON line by line; parse stderr "session: <id>" on the first turn
  5. on run_start → session.started (first turn) / turn.started; start the transcript tailer at the file's current byte offset
  6. tool_running → item.started; transcript blocks → item.* and content.delta; hook POSTs → request.opened / user-input.requested
  7. run_end → reconcile items against nextState.messages (authoritative), emit usage.updated, turn.completed; result line → exit code mapping
  8. exit code 3 → runtime.error fatal auth; 10 → runtime.error "insufficient credits" with billing link; 130 → turn.completed interrupted
interrupt()  → SIGINT to the process group, then SIGKILL after 5s, then verify no descendants remain
close()      → same teardown; remove our hook block only if we wrote it this session (marker + hash)
```

### Approvals through the hook

```
~/.openade/bin/cmd-hook.mjs  (generated, mode 0700, node script, no dependencies)
  reads stdin JSON → POST $OPENADE_HOOK_URL/pretooluse  { Authorization: Bearer $OPENADE_HOOK_TOKEN, body: stdin }  (timeout 590s)
  server: PermissionService.decide(...)  → allow: respond {"hookSpecificOutput":{"permissionDecision":"allow"}} immediately
                                          → deny:  respond deny + reason
                                          → prompt: emit request.opened, await Deferred (user decision), respond; on timeout respond deny "approval timed out"
  ask_user_question: server emits user-input.requested, awaits answers, responds deny with reason "The user answered: …" (until 5.7 is verified)
  hook config written to .commandcode/settings.local.json: { "hooks": { "PreToolUse": [ { "matcher": ".*", "hooks": [ { "type": "command", "command": "node ~/.openade/bin/cmd-hook.mjs", "timeout": 600 } ] } ] } }
```

- Runtime modes → CLI: approval-required = --yolo + hook prompts for everything mutating; auto-accept-edits = --yolo + hook auto-allows edits and writes inside the project, prompts for shell and web; full-access = --yolo + hook allows all except sensitive paths and deny rules. interactionMode: plan = --permission-mode plan without --yolo; the plan file is read from ~/.commandcode/plans/ via plans-index (match on sessionId) and emitted as turn.plan.proposed.

- Plan accept = next turn with the text "Implement the approved plan at <path>" and interactionMode: default; accept-auto also switches to auto-accept-edits; revise = next turn in plan mode with the feedback.

- Model and effort are per-turn flags; changing them mid-thread applies on the next turn. Models come from --list-models parsed into ModelOption (group headers become family, "(default)" sets the default, "FREE" sets free).

- Session ref persisted per thread: { sessionId, transcriptPath, cwd, lastMessageId }. Resume = --session <sessionId>; if the transcript is gone, emit thread.session.lost and start fresh with a note in the timeline.

- Probe: find cmd from config, PATH, npm global bin, pnpm and bun bins; run cmd status --json (exit 3 = not logged in → show "run cmd login"); parse version; warn if below 1.54.

- Fake: FakeCmdProcess in testkit replays captured NDJSON plus a transcript file written progressively, and answers hook POSTs, so W1, W3 and the renderer can be built and tested with no real CLI.

## 09Server design

- Persistence: SQLite at ~/.openade/state.sqlite, WAL, busy_timeout=5000, foreign_keys=ON. Numbered migrations imported statically; a CI test refuses renumbering. Tables: events (append-only, sequence autoincrement, unique (stream_kind, stream_id, stream_version)), command_receipts, projection tables per read model, projection_state, settings, permission_rules. Events, projections and the receipt commit in one transaction; the decider is pure; reactors do all I/O.

- Engine: dispatch(command) loads the stream, runs decide, appends, projects, writes the receipt, publishes to subscribers with 50ms coalescing and the per-subscription budget. Idempotent on commandId.

- Reactors: ProviderCommandReactor drives SessionHandle; RuntimeIngestion turns runtime events into commands and coalesces deltas into thread.item.upserted; SessionSupervisor resumes non-terminal threads at boot and retries crashed sessions with backoff; CheckpointReactor snapshots the worktree into refs/openade/checkpoints/<threadId>/<turnId> after each turn.

- Permissions: pure decide({ runtimeMode, interactionMode, request, rules }) → allow | prompt | deny, table-tested, using Command Code's pattern semantics (deny, then ask, then allow). Sensitive paths always prompt.

- HookBridge: loopback HTTP on the server, per-session bearer, POST /pretooluse as in section 8, 590s ceiling, request bodies capped at 1MB, every decision journaled as an orchestration event.

- MCP server: Streamable HTTP on loopback, per-session bearer via ${OPENADE_MCP_TOKEN} in the native mcp.json; tools browser_*. Results capped at 64KB; each call emits item.* so it shows in the timeline.

## 10Transport and client runtime

- Server: RpcServer.make(OpenAdeRpcGroup) with RpcServer.makeProtocolWithHttpEffectWebsocket on GET /ws, RpcSerialization.layerJson; token on the upgrade query, generated at boot, handed to desktop main over fd 3. Reference /Volumes/main/Code/ade/t3code/apps/server/src/ws.ts lines 3427 to 3466.

- Client: packages/client-runtime exports makeConnection({ url, token }) returning a Layer with the RpcClient, a reconnecting WebSocket protocol, and connection state. Reference /Volumes/main/Code/ade/t3code/packages/client-runtime/src/rpc/{protocol,session}.ts.

- Reconnect: re-subscribe with afterSequence; resnapshot-required replaces atom state; a changed serverInstanceId forces full resnapshot.

- Atoms: AtomRuntime from the connection Layer; factories threadDetailAtom(threadId), threadListAtom(projectId), connectorsAtom, settingsAtom, connectionStateAtom, dispatchAtom. UI-only state is Atom.make with keepAlive plus localStorage helpers in apps/web/src/state/ui.ts. Reference /Volumes/main/Code/ade/t3code/apps/web/src/state/orchestration.ts.

## 11Renderer

- Routes: /, /t/$threadId, /settings/$section, /welcome. Pane state in atoms and search params.

- Layout: left sidebar (projects → threads, status pill, unread dot), center thread view, right dock with tabs changes | browser | files, per-thread tab state persisted.

- Timeline rows by ItemKind: user, assistant (markdown), reasoning (collapsed), command_execution (cmd, exit code, output disclosure), file_change (inline diff via worker), tool_call (read tools, compact), mcp_tool_call, task (nested), todo (checklist), skill (chip), plan (card), error, context_compaction. Settled turns fold tool rows into "Worked for Ns · N tools". Virtualized; disclosure state keyed by itemId.

- Composer: textarea; / command popover (/clear, /model, /effort, /mode, /plan, plus skills from cmdConfig.skills.list); @ fuzzy file search inserting a chip; image paste or drop; Enter sends, Shift+Enter newline, Cmd+Enter queues; queue strip with reorder and remove. While a turn runs the send button becomes "Queue".

- Interaction cards in the composer slot: approval (allow once / for session / always with editable pattern / deny), AskUserQuestion, plan (accept / accept and run / revise). One active card at a time.

- Header controls: model, effort, runtime mode, interaction mode; disabled with a tooltip when the capability says restart; "applies next turn" hint when per-turn.

- Keybindings: VS Code-style table with server-owned defaults: Cmd+N new thread, Cmd+K palette, Cmd+Enter queue, Escape interrupt, Cmd+Shift+B browser pane.

- Theme: system, light, dark via tokens.

  RuleComponents never call the RPC client directly; they read atoms and call dispatch. No component file over 400 lines; the timeline is a directory of row components.

## 12Browser: agent-browser integration

  agent-browser is a Rust CLI plus daemon driving Chromium over CDP: ref-based snapshots (snapshot -i → @e1), --cdp <port> to attach to any Electron app launched with --remote-debugging-port, --session, --pin-tab, --json, agent-browser mcp, and stream enable for a JPEG viewport stream with input forwarding.

     |  |  | Mode A: CDP attach to in-app webview preferred | Mode B: own Chromium + stream

       | How | Electron main starts with remote-debugging-port=<random> on 127.0.0.1; the dock hosts a sandboxed <webview partition="persist:thread-<id>">; BrowserService runs agent-browser --cdp <port> --session ade-<threadId> --pin-tab ... --json after selecting the webview's target from tab listing. | BrowserService runs agent-browser --session ade-<threadId> with its own Chrome, enables stream; the dock renders JPEG frames on a canvas and forwards input.

       | Spike DoD | Navigate, snapshot -i, click @eN, see the click in the pane; kill the daemon and the pane keeps working. | 10 fps or better on a laptop; a click in the pane lands on the right element.

```
browser_open {url} · browser_snapshot {interactive?} · browser_click {ref|selector} · browser_fill {ref|selector,text} · browser_type {text}
browser_press {key} · browser_scroll {direction,px?} · browser_wait {selector?|load?,timeoutMs?} · browser_get {what:"url"|"title"|"text",selector?}
browser_screenshot {full?} → image block · browser_eval {js} (ApprovalKind "web", denied in plan mode) · browser_tabs {action,url?,tab?}
```

- Each tool shells out to the CLI in --json mode through a per-thread serialized queue; 30s ceiling; 64KB result cap.

- Human interrupt: real user input into the pane bumps a per-thread epoch; a tool call started under an older epoch returns interrupted_by_human.

- Wrapping the CLI ourselves (rather than injecting agent-browser mcp) gives per-thread sessions, target pinning, timeline items and the interrupt rule. Keep agent-browser mcp as a fallback behind a setting.

- WebMCP is P1; reference /Volumes/main/Code/ade/synara/apps/desktop/src/browserWebMcp/guestBridge.ts.

## 13Desktop shell

- Single window; contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag only for the preview partition; will-attach-webview overwrites renderer-supplied prefs. Renderer served from openade://app with codeCache. Remote debugging port on loopback only when the browser pane is enabled.

- Server supervisor: spawns the server with ELECTRON_RUN_AS_NODE=1 and a fourth pipe for the { port, token, serverInstanceId } handshake; backoff 500ms → 10s; after 5 consecutive failures a "paused automatic restarts" dialog. Reference /Volumes/main/Code/ade/t3code/apps/desktop/src/backend/DesktopBackendManager.ts.

- Preload exposes only getConnection(), onServerState(cb), openExternal(url), pickDirectory(), and the browser-pane bridge.

- Packaging: electron-builder dmg + zip, updater against GitHub Releases with autoDownload=false behind a flag. pnpm dev runs Vite, the server in watch mode and Electron in one command; a .claude/launch.json entry lets agents run it.

## 14Workstreams

  Ten workstreams, one agent each. Dependencies flow only through W0's contracts and fakes. "Owns" is exclusive. Paths are on this machine.

    W0Foundation, contracts, testkitlands first · blocks all

      Deliverables
- pnpm workspace with catalog, tsconfig, vitest, oxlint, oxfmt, knip, boundary check, CI green on an empty app

- Every schema in section 6 with round-trip tests and fixtures in contracts/fixtures/

- connector-sdk: interfaces, makeTurnScopedHandle, conformance test

- testkit: FakeConnector replaying scripted RuntimeEvent[], receipts helpers, in-memory SQLite helper, and the FakeCmdProcess skeleton W2 will fill with captured fixtures

- Stub packages for every workstream

      Read first

- /Volumes/main/Code/ade/t3code/packages/contracts/src/providerRuntime.ts 49-type union, raw envelope

- /Volumes/main/Code/ade/t3code/packages/contracts/src/orchestration.ts stream item union near line 2025

- /Volumes/main/Code/ade/t3code/packages/contracts/src/rpc.ts

- /Volumes/main/Code/ade/zuse/packages/agents/src/kernel/driver.ts session handle

- /Volumes/main/Code/ade/zuse/packages/agents/src/kernel/turn-protocol.ts

- /Volumes/main/Code/ade/zuse/tests/testkit/src/fake-acp.ts fake peer pattern

- /Volumes/main/Code/ade/t3code/oxlint-plugin-t3code/

- /Volumes/main/Code/ade/t3code/pnpm-workspace.yaml

        Done when
- pnpm check passes; CI green

- Fixture round-trips for every schema

- Conformance test passes against FakeConnector

    W1Persistence and orchestration engineapps/server/src/{persistence,orchestration,permissions}

      Deliverables
- Sqlite Layer over node:sqlite, migrations, event store with optimistic concurrency

- Pure decider.ts for every command with a table test each; projector.ts; Engine.ts with transactional append and the live budget

- SessionSupervisor, ProviderCommandReactor, RuntimeIngestion against SessionHandle, tested with FakeConnector only

- PermissionService with Command Code's pattern matcher (deny → ask → allow, Shell(npm run *), Edit(/src/**), mcp__s__t) and the sensitive-path list, table-tested

- Boot-time resume of non-terminal threads

      Read first

- /Volumes/main/Code/ade/t3code/docs/internals/overview.md lines 56 to 74

- /Volumes/main/Code/ade/t3code/apps/server/src/persistence/Migrations/001_OrchestrationEvents.ts

- /Volumes/main/Code/ade/t3code/apps/server/src/persistence/Migrations/005_Projections.ts

- /Volumes/main/Code/ade/t3code/apps/server/src/orchestration/decider.ts

- /Volumes/main/Code/ade/t3code/apps/server/src/orchestration/LiveStreamBudget.ts

- /Volumes/main/Code/ade/t3code/apps/server/src/orchestration/ThreadLiveEventCoalescer.ts

- /Volumes/main/Code/ade/t3code/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts

- /Volumes/main/Code/ade/zuse/packages/agents/src/kernel/permission-policy.ts pure decide + sensitive list

- /Volumes/main/Code/ade/zuse/apps/server/src/persistence/migrations/0020_events.ts lines 17 to 37

- https://commandcode.ai/docs/permissions pattern language and ladder

        Done when
- A scripted conversation (turn, tool, approval, plan, interrupt, crash-resume) yields byte-identical projections across runs

- Kill mid-turn → resume from the persisted sessionRef

- Budget test fails the stream and a resubscribe recovers

- 100-row permission table test passes

    W2Command Code connectorpackages/connector-cmd · apps/server/src/hooks · testkit/fixtures/cmd

      Deliverables
- Day one: with a funded account, record real turns (text only, tool use, plan mode, ask_user_question, interrupt) to testkit/fixtures/cmd/*.ndjson plus the matching transcript files; write docs/decisions/w2-cmd-frames.md answering every item in 5.7

- cmdConnector definition: probe, argv builder, env allowlist, spawn, NDJSON parser, transcript tailer, translator, session ref, process-tree teardown

- HookBridge server route + generated hook script + settings.local.json and mcp.json writers with ownership markers and hash-checked removal

- Runtime mode → flag mapping, plan mode round trip via plans-index, per-turn model and effort

- Exit-code and error mapping (3, 10, 130 especially) into runtime events with user-facing messages

- FakeCmdProcess replaying fixtures progressively and serving hook POSTs

      Read first

- Section 5 of this spec, then https://commandcode.ai/docs/headless, /docs/hooks, /docs/sessions, /docs/mcp, /docs/settings, /docs/reference/cli

- ~/.commandcode/projects/*/ real transcripts; read shapes, never copy content into fixtures

- /Volumes/main/Code/ade/zuse/packages/agents/src/drivers/claude.ts lines 1666 to 1806: env scrub and binary lookup pattern

- /Volumes/main/Code/ade/synara/apps/server/src/providerChildEnvironment.ts default-deny env

- /Volumes/main/Code/ade/synara/apps/server/src/provider/boundedCallbackIngress.ts terminal-event reserve

- /Volumes/main/Code/ade/synara/apps/server/src/provider/providerRuntimeEventPump.ts

- /Volumes/main/Code/ade/synara/apps/server/src/terminal/managedTerminalWrappers.ts lines 93 to 123: writing hook config for a CLI

- /Volumes/main/Code/ade/opencodex/src/codex/injected-marker.ts ownership markers

- /Volumes/main/Code/ade/opencodex/src/adapters/command-code.ts only for the /alpha/generate wire, if ever needed

        Done when
- Conformance test passes with FakeCmdProcess

- Live smoke (opt-in): a turn that runs a shell command, edits a file, asks a question and proposes a plan, all visible as events with approvals answered from a test client

- Kill -9 the cmd child mid-turn → session.ended crashed, then resume works

- Removing the thread leaves no hook block, no orphan process, no bearer on disk

    W3Transport and client runtimeapps/server/src/rpc · packages/client-runtime

      Deliverables
- WebSocket RPC server Layer with token auth, JSON serialization, every RPC wired to W1 services behind interfaces (fakes until W1 lands)

- server.hello with protocol version negotiation

- Client: reconnecting protocol, makeConnection, AtomRuntime, atom factories, dispatch with receipt awaiting

- Resume with afterSequence; transfer-budget test

      Read first

- /Volumes/main/Code/ade/t3code/apps/server/src/ws.ts lines 3427 to 3466

- /Volumes/main/Code/ade/t3code/packages/client-runtime/src/rpc/protocol.ts

- /Volumes/main/Code/ade/t3code/packages/client-runtime/src/rpc/session.ts

- /Volumes/main/Code/ade/t3code/apps/web/src/state/orchestration.ts

- /Volumes/main/Code/ade/zuse/internal-docs/architecture/realtime-runtime.md

- /Volumes/main/Code/ade/synara/.docs/transport.md

        Done when
- Headless client drops the socket, reconnects, receives exactly the missed events

- Atoms re-render only on their own thread's events

- Wrong token → 401

    W4Renderer shell and timelineapps/web (routes, sidebar, timeline, panes shell, theme)

      Deliverables
- App shell, routes, sidebar, command palette

- Timeline with every row kind in section 11, virtualized, worker-pool diffs, markdown, turn folding, subagent nesting

- Right dock shell with tabs and persisted layout

- Design tokens for both themes; base-ui primitives in components/ui/

- Fixture page /dev/timeline rendering every row kind from contracts/fixtures/

      Read first

- /Volumes/main/Code/ade/synara/apps/web/src/components/chat/MessagesTimeline.logic.ts lines 216 to 275

- /Volumes/main/Code/ade/synara/apps/web/src/workLog.ts

- /Volumes/main/Code/ade/t3code/apps/web/src/components/chat/MessagesTimeline.tsx lines 71 to 74, 490, 531

- /Volumes/main/Code/ade/t3code/apps/web/src/components/DiffWorkerPoolProvider.tsx

- /Volumes/main/Code/ade/zuse/apps/renderer/src/components/subagent-row.tsx

- /Volumes/main/Code/ade/zuse/DESIGN.md

        Done when
- Fixture page renders every row kind in both themes with no console errors

- 1,000-item fixture scrolls at 60fps

- No component file over 400 lines

    W5Composer and interaction cardsapps/web/src/components/{composer,approvals} · header controls · keybindings

      Deliverables
- Composer per section 11 including the queue strip and "applies next turn" hints

- Approval, AskUserQuestion and plan cards; pattern editor with live match preview using the same matcher as the server (shared package)

- Header controls bound to capability flags

- Keybinding table, matcher, editor

      Read first

- /Volumes/main/Code/ade/zuse/packages/client-runtime/src/composer-trigger.ts

- /Volumes/main/Code/ade/zuse/packages/contracts/src/composer.ts

- /Volumes/main/Code/ade/t3code/packages/contracts/src/keybindings.ts

- /Volumes/main/Code/ade/t3code/apps/web/src/components/ChatComposer.tsx lines 2290 to 2318 only

        Done when
- Fixture page /dev/composer exercises every card and trigger

- Approval round-trips through dispatch; the card closes on the resolved event, not optimistically

- Keyboard-only walkthrough of send, queue, approve, revise plan, interrupt

    W6Browser: agent-browser, MCP server, preview paneapps/server/src/{browser,mcp} · apps/web/src/components/panes/browser · desktop preview bridge

      Deliverables
- Day-one spike of modes A and B, decision doc

- BrowserService: per-thread session, serialized queue, JSON parsing, human epoch, teardown

- MCP HTTP server with per-session bearer and the browser_* tools; timeline items per call

- Preview pane with address bar, navigation, "agent is driving" indicator, human-input signalling

- agent-browser binary discovery and agent-browser install prompt

      Read first

- https://agent-browser.dev and https://github.com/vercel-labs/agent-browser cdp-mode, mcp, stream

- /Volumes/main/Code/ade/synara/packages/contracts/src/browserAutomationToolCatalogue.ts

- /Volumes/main/Code/ade/synara/apps/server/src/agentGateway/httpRoute.ts

- /Volumes/main/Code/ade/synara/apps/server/src/agentGateway/mcpInjection.ts

- /Volumes/main/Code/ade/synara/apps/desktop/src/browserManager.ts human control

- /Volumes/main/Code/ade/t3code/apps/server/src/mcp/McpHttpServer.ts lines 43 to 55

- /Volumes/main/Code/ade/zuse/packages/agents/src/mcp-gateway/index.ts

        Done when
- Command Code, via our MCP server, opens a URL, snapshots, clicks a ref, and the pane shows it

- A human click during a tool call returns interrupted_by_human

- Closing the thread tears down the daemon session

    W7Desktop shell and packagingapps/desktop · root dev scripts · .claude/launch.json

      Deliverables
- Main, preload, custom scheme, window state, server supervisor with fd-3 handshake and backoff, remote-debugging switch, dev loop, electron-builder config, updater stub

- Platform folder with the only OS-specific code

- Crash and restart UX via preload onServerState

      Read first

- /Volumes/main/Code/ade/t3code/apps/desktop/src/backend/DesktopBackendManager.ts

- /Volumes/main/Code/ade/synara/apps/desktop/src/main.ts lines 1059 to 1071, 3634 to 3690, 4052 to 4078, 4865 to 4867

- /Volumes/main/Code/ade/zuse/apps/desktop/src/updater.ts

        Done when
- pnpm dev opens the app connected to a live server

- Kill the server → reconnect within 3s with a banner

- pnpm build:desktop produces a dmg + zip that launches

    W8Git, checkpoints, filesapps/server/src/git · files RPCs · changes pane

      Deliverables
- GitService via argv-form execFile: status, diff (worktree, HEAD, checkpoint to checkpoint)

- CheckpointStore: hidden refs per turn, list, restore with confirmation, prune on thread delete (independent of Command Code's own file-history)

- files.search ignore-aware walker and files.read

- Changes pane with turn selector and per-file worker diffs

      Read first

- /Volumes/main/Code/ade/t3code/apps/server/src/checkpointing/CheckpointStore.ts

- /Volumes/main/Code/ade/synara/apps/server/src/checkpointing/Layers/CheckpointStore.ts

- /Volumes/main/Code/ade/t3code/apps/server/src/vcs/GitVcsDriverCore.ts diff and status parsing only

        Done when
- Two turns → two checkpoints → correct diff between them; restore reverts the worktree

- Search over a 50k-file repo under 200ms warm

    W9Settings, connector instances, MCP and skills editorapps/server/src/settings · apps/web/src/routes/settings · components/settings

      Deliverables
- SettingsStore with settings.subscribe

- Generic connector settings form from configSchema annotations; probe button showing binary, version, auth state, account, model count

- CmdConfigWriter: read and write ~/.commandcode/mcp.json and project .mcp.json with ownership markers; skills listing from ~/.commandcode/skills and project skills; model list from cmd --list-models

- Settings pages: General, Connectors, MCP servers, Skills, Keybindings, Appearance

- Welcome flow: pick a project, verify cmd is installed and logged in, show the billing link on exit code 10

      Read first

- /Volumes/main/Code/ade/t3code/apps/web/src/components/settings/ProviderSettingsForm.tsx lines 59 to 106

- /Volumes/main/Code/ade/t3code/packages/contracts/src/settings.ts lines 613 to 668

- /Volumes/main/Code/ade/zuse/apps/server/src/mcp/native-config.ts

- /Volumes/main/Code/ade/zuse/apps/server/src/skill/layers/skill-discovery.ts

- https://commandcode.ai/docs/mcp and /docs/settings

        Done when
- Adding an MCP server in the UI appears in the next Command Code session's mcp.status.updated

- A hand edit outside our marker survives a round-trip

- Connector form renders with zero connector-specific JSX

## 15Milestones

    M0Workspace builds, CI green, contracts and fakes published.W0 · day 2

    M1Hello turn: prompt in, Command Code answers, text lands in the timeline, survives an app restart. Requires W2's fixture capture, which requires account credits.W1 W2 W3 W4 W7 · day 6

    M2Tools, hook-bridged approvals, AskUserQuestion, plan mode, interrupt, queue, per-turn model and effort.W1 W2 W5 · day 10

    M3Browser pane driven by Command Code through our MCP server, with human interrupt.W6 W7 · day 13

    M4Checkpoints, changes pane, settings, MCP editor, skills, keybindings, welcome flow.W8 W9 · day 16

    M5Packaged dmg, crash and reconnect UX, perf pass on a 1,000-item thread, docs.all · day 19

## 16Guardrails (CI-enforced from M0)

     Lint errors are errors. oxlint with t3code's plugin rules re-implemented where they apply.
     Typecheck on every package. No @ts-ignore; @ts-expect-error needs an issue link; as any only in tests.
     New non-test files over 800 lines fail CI. Renderer components over 400 lines fail CI.
     Package boundary check as in section 4.
     A grep test asserts the strings commandcode, "cmd" and claude do not appear in apps/web/src outside components/ui/icons.
     Tests wait on receipts, deferreds and queues. setTimeout and sleep are banned in test files.
     Transfer-budget test, migration-lineage test, connector conformance test.
     knip for dead exports. No barrel files.
     Default runtime mode is approval-required; a test asserts it. The hook script is regenerated and hash-checked on every spawn.
     PRs under 600 changed lines unless titled [large] with a decision doc.

## 17Open items

- Credits. W2 cannot record fixtures until the Command Code account at commandcode.ai/billing has credits. Everything else proceeds on fakes.

- Install cmd on PATH (npm i -g command-code) so the probe does not fall back to npx. Version 1.54.0 is current.

- Product name. "OpenADE" is the working title for package scopes, the scheme and the config dir. Decide before M1.

- Browser mode A vs B is W6's day-one decision; the tool contract does not change.

- Effect version. rc.112 matches t3code; W0 may bump all three Effect packages together if a newer 4.x stable exists.

- License of the new repo. MIT recommended; settles what can be vendored from t3code and synara.

- Second connector. Claude Code via its Agent SDK is the natural next; the canonical tool vocabulary is Command Code's, so that connector translates names. Log 01 section 5 holds the wire facts.

OpenADE · MVP build spec v0.2 · Command Code first · derived from docs/logs/01-ide-comparison.html and live probes on 2026-09-15

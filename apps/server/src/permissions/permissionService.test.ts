/**
 * The permission ladder over the real `permission_rules` table.
 *
 * `decidePermission` is covered exhaustively by the table test next door; what
 * this file is about is which rows reach it — a session rule must never leak
 * out of its thread, and a project rule never out of its project.
 */

import { describe, expect, it } from "@effect/vitest";
import { makeProjectId, makeRequestId, makeThreadId } from "@OpenAde/contracts/ids";
import type { ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import type { ApprovalRequest } from "@OpenAde/contracts/runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { persistenceLayer } from "../../test/layers";
import { PermissionService } from "./PermissionService";

/** The service over a fresh in-memory database, migrations and all. */
const serviceLayer = () => PermissionService.layer.pipe(Layer.provide(persistenceLayer()));

const shell = (command: string): ApprovalRequest => ({
  requestId: makeRequestId(),
  kind: "command",
  toolName: "shell_command",
  input: { command },
  description: `Run ${command}`,
});

const projectA = makeProjectId();
const projectB = makeProjectId();
const threadA = makeThreadId();
const threadB = makeThreadId();

describe("PermissionService over permission_rules", () => {
  it.effect("keeps a session rule inside its own thread", () =>
    Effect.gen(function* () {
      const permissions = yield* PermissionService;
      yield* permissions.addRule({
        scope: "session",
        threadId: threadA,
        pattern: "Shell(npm run *)",
        decision: "allow",
      });

      const ask = (threadId?: ThreadId) =>
        permissions.decide({
          request: shell("npm run build"),
          runtimeMode: "approval-required",
          interactionMode: "default",
          ...(threadId === undefined ? {} : { threadId }),
        });

      expect(yield* ask(threadA)).toBe("allow");
      expect(yield* ask(threadB)).toBe("prompt");
      // A caller with no thread id used to inherit every session rule there is.
      expect(yield* ask()).toBe("prompt");
    }).pipe(Effect.provide(serviceLayer())),
  );

  it.effect("keeps a project rule inside its own project", () =>
    Effect.gen(function* () {
      const permissions = yield* PermissionService;
      yield* permissions.addRule({
        scope: "project",
        projectId: projectA,
        pattern: "Shell(git *)",
        decision: "deny",
      });

      const ask = (projectId: ProjectId) =>
        permissions.decide({
          request: shell("git push"),
          runtimeMode: "full-access",
          interactionMode: "default",
          projectId,
          threadId: threadA,
        });

      expect(yield* ask(projectA)).toBe("deny");
      expect(yield* ask(projectB)).toBe("allow");
    }).pipe(Effect.provide(serviceLayer())),
  );

  it.effect("applies a global rule to every thread, and lists what it stored", () =>
    Effect.gen(function* () {
      const permissions = yield* PermissionService;
      yield* permissions.addRule({ scope: "global", pattern: "Shell(rm -rf *)", decision: "deny" });
      yield* permissions.addRule({
        scope: "session",
        threadId: threadB,
        pattern: "Shell(ls)",
        decision: "allow",
      });

      expect(
        yield* permissions.decide({
          request: shell("rm -rf /"),
          runtimeMode: "full-access",
          interactionMode: "default",
          projectId: projectB,
          threadId: threadB,
        }),
      ).toBe("deny");

      expect((yield* permissions.rules()).map((rule) => rule.pattern)).toEqual([
        "Shell(rm -rf *)",
        "Shell(ls)",
      ]);
      expect((yield* permissions.rules("session")).map((rule) => rule.threadId)).toEqual([threadB]);
    }).pipe(Effect.provide(serviceLayer())),
  );
});

/**
 * Scenario (f): two editing turns, two checkpoints, and a restore.
 *
 * A checkpoint is a hidden git ref taken per turn from a temporary index, so
 * the worktree it records is the one the turn left behind. The claim end to
 * end is the one the Changes pane makes: two turns give two checkpoints, the
 * diff between them is the second turn's work and not the first's, and
 * restoring the first really puts the files back — on disk, and in the view
 * the pane is reading.
 *
 * `fixtures/cmd/file-edit-twice/` is the recording: two real editing turns in
 * one session, each changing a different file.
 */

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  autoApprove,
  bootServer,
  command,
  connect,
  forEachDriver,
  isSettled,
  makeHome,
  openThread,
  seedSettings,
  startTurn,
  staticCredentials,
  type Driver,
} from "./harness";

/** The two prompts `fixtures/cmd/file-edit-twice/` was recorded on. */
const EDIT_GREETING = "Edit greeting.txt so it says `hello there` instead of `hello world`.";
const EDIT_FAREWELL = "Now edit farewell.txt so it says `bye there` instead of `bye world`.";

const SEED = { "greeting.txt": "hello world\n", "farewell.txt": "bye world\n" };

const checkpoints = (driver: Driver) => {
  it.live("takes one per turn, diffs them, and restores the first", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome("checkpoints", SEED);
        yield* seedSettings(home, [driver.connector(home, "file-edit-twice")]);
        const server = yield* bootServer(home);
        const client = yield* connect(Effect.succeed(staticCredentials(server)));
        const open = yield* openThread(client, home);
        yield* autoApprove(client, open);

        const read = (name: string) =>
          NodeFS.readFileSync(NodePath.join(home.workspace, name), "utf8");

        const first = yield* startTurn(client, open, { text: EDIT_GREETING });
        const afterFirst = yield* open.view.awaitAt(
          (view) => isSettled(view) && view.checkpoints.length >= 1,
          first,
        );
        expect(afterFirst.value.checkpoints).toHaveLength(1);

        const second = yield* startTurn(client, open, { text: EDIT_FAREWELL });
        const afterSecond = yield* open.view.awaitValue(
          (view) => isSettled(view) && view.checkpoints.length >= 2,
          second,
        );
        // One per turn, and each against its own turn.
        expect(afterSecond.checkpoints).toHaveLength(2);
        const [one, two] = afterSecond.checkpoints;
        expect(one!.turnId).not.toBe(two!.turnId);

        // The repository agrees the refs exist. The timeline's own list is a
        // fold of `checkpoint.created`, which cannot know about a ref removed
        // outside the app — intersecting the two is what stops the pane
        // offering a restore that can only fail.
        const listed = yield* (yield* client.rpc)
          ["checkpoints.list"]({
            projectId: open.projectId,
            threadId: open.threadId,
          })
          .pipe(Effect.orDie);
        expect(listed.map((c) => c.checkpointId).sort()).toEqual(
          afterSecond.checkpoints.map((c) => c.checkpointId).sort(),
        );

        // Between the two snapshots is the second turn's work alone.
        const between = yield* (yield* client.rpc)
          ["git.diff"]({
            projectId: open.projectId,
            from: one!.ref,
            to: two!.ref,
          })
          .pipe(Effect.orDie);
        const changed = between.files.map((file) => file.path);
        expect(changed).toContain("farewell.txt");
        expect(changed).not.toContain("greeting.txt");

        // Restore the first: a durable work order, not a synchronous call. The
        // server accepts it, the reactor runs git, and only then does the
        // outcome arrive — which is why the client folds all three events.
        // Marked *before* the dispatch, not after its receipt: the thing to
        // assert here is the command's own event. `markAfter` waits until the
        // view carrying it has arrived and answers with the position past it,
        // which is exactly the one view a "restore is running" wait needs.
        const ordered = yield* open.view.mark;
        yield* client.send(
          command({
            type: "thread.checkpoint.restore",
            threadId: open.threadId,
            checkpointId: one!.checkpointId,
          }),
        );
        // Both halves, in order: the pane has to be able to say a restore is
        // running, and then that it finished. Waiting only for "not running"
        // is answered by the state before it started.
        const running = yield* open.view.awaitAt(
          (view) => (view.restoring ?? null) !== null,
          ordered,
        );
        expect(running.value.restoring!.checkpointId).toBe(one!.checkpointId);
        const restored = yield* open.view.awaitValue(
          (view) => (view.restoring ?? null) === null,
          running.next,
        );
        expect(restored.restoreFailure ?? null).toBeNull();

        // The worktree really went back: the second turn's edit is undone and
        // the first turn's is not.
        expect(read("farewell.txt")).toContain("bye world");
        expect(read("greeting.txt")).not.toContain("hello world");
      }),
    ),
  );
};

forEachDriver("checkpoints", checkpoints);

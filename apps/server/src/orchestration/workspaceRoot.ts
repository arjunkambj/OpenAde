/**
 * Which directory a thread works in.
 *
 * A local thread works in its project's folder; a thread created with a
 * worktree works in that worktree. Everything that acts on "the thread's
 * directory" — the harness session, the permission gate's sensitive-path
 * check, checkpoint capture and restore, the diff, the `@` search — asks here,
 * so the two kinds of thread cannot drift apart.
 *
 * Checkpoint prune is the one exception and deliberately stays on the project
 * root: the hidden refs under `refs/openade` are shared by every worktree of a
 * repository, and a deleted thread's worktree may already be gone.
 */

import { realpathSync } from "node:fs";
import * as nodePath from "node:path";
import type { ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import * as Effect from "effect/Effect";

import type { ReadModelStore } from "../persistence/ReadModels";
import { worktreeOf, type ProjectDoc, type ThreadDoc } from "./state";

/** The thread's workspace root: its worktree when it has one, the project's otherwise. */
export const threadWorkspaceRoot = (
  doc: ThreadDoc,
  project: Pick<ProjectDoc, "workspaceRoot">,
): string => worktreeOf(doc)?.path ?? project.workspaceRoot;

/**
 * Whether two threads write to the same directory: both local threads of one
 * project, or both in the same worktree. A checkpoint restore rewrites that
 * directory, so it excludes exactly these siblings and no others.
 */
export const sharesWorkspaceRoot = (a: ThreadDoc, b: ThreadDoc): boolean =>
  a.projectId === b.projectId && (worktreeOf(a)?.path ?? null) === (worktreeOf(b)?.path ?? null);

/**
 * The directory an RPC scoped to a project, and optionally one of its threads,
 * reads: the thread's root when `threadId` names a live thread of that
 * project, the project's root otherwise, and `null` for an unknown project.
 * A thread of another project is ignored rather than trusted, so a client
 * cannot point one project's RPC at another project's worktree.
 */
export const resolveWorkspaceRoot = (
  readModels: ReadModelStore["Service"],
  projectId: ProjectId,
  threadId: ThreadId | undefined,
) =>
  Effect.gen(function* () {
    const project = yield* readModels.getProjectDoc(projectId);
    if (project === null) {
      return null;
    }
    if (threadId === undefined) {
      return project.workspaceRoot;
    }
    const doc = yield* readModels.getThreadDoc(threadId);
    return doc === null || doc.deleted || doc.projectId !== projectId
      ? project.workspaceRoot
      : threadWorkspaceRoot(doc, project);
  });

/** A path by its real location, so `/var/…` and `/private/var/…` compare equal. */
export const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return nodePath.resolve(path);
  }
};

/**
 * Whether a turn is running, or a checkpoint restore is rewriting files, in
 * any live thread whose workspace root is `root`. A branch switch or a commit
 * there would pull the tree out from under that turn — and every local thread
 * of a project shares the project's root, so one running local thread blocks
 * them all.
 */
export const workspaceRootBusy = (readModels: ReadModelStore["Service"], root: string) =>
  Effect.gen(function* () {
    const target = canonicalPath(root);
    const docs = yield* readModels.listThreadDocs;
    const projects = new Map<ProjectId, ProjectDoc | null>();
    for (const doc of docs) {
      if (doc.deleted || (doc.currentTurn === null && !doc.restoring)) continue;
      let project = projects.get(doc.projectId);
      if (project === undefined) {
        project = yield* readModels.getProjectDoc(doc.projectId);
        projects.set(doc.projectId, project);
      }
      if (project !== null && canonicalPath(threadWorkspaceRoot(doc, project)) === target) {
        return true;
      }
    }
    return false;
  });

/**
 * The name of a project whose own folder is `path`, or null. A worktree one
 * project cut can be added as a project of its own, and removing it would then
 * take that project's folder with it.
 */
export const projectRootedAt = (readModels: ReadModelStore["Service"], path: string) =>
  Effect.gen(function* () {
    const target = canonicalPath(path);
    const projects = yield* readModels.listProjects();
    return (
      projects.find((project) => canonicalPath(project.workspaceRoot) === target)?.name ?? null
    );
  });

/**
 * Whether a thread that has not been deleted still works in the worktree at
 * `path`. An archived thread counts: it can be unarchived, and its worktree
 * has to be there when it is.
 */
export const worktreeInUse = (readModels: ReadModelStore["Service"], path: string) =>
  Effect.gen(function* () {
    const target = canonicalPath(path);
    const docs = yield* readModels.listThreadDocs;
    return docs.some((doc) => {
      const worktree = doc.deleted ? null : worktreeOf(doc);
      return worktree !== null && canonicalPath(worktree.path) === target;
    });
  });

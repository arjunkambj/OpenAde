/**
 * The MCP servers page: everything `cmdConfig.mcp.list` returns for the
 * chosen project context, grouped by the file it lives in. Entries carrying
 * the `_openade` marker are edited and removed here; entries without it are
 * shown read-only — the server refuses to touch them anyway, and the marker
 * rule is what keeps a hand edit safe across a round-trip.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Button } from "@OpenAde/ui/components/button";
import { Card, CardContent } from "@OpenAde/ui/components/card";
import { Checkbox } from "@OpenAde/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@OpenAde/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@OpenAde/ui/components/select";
import { Textarea } from "@OpenAde/ui/components/textarea";
import type { ProjectId } from "@OpenAde/contracts/ids";
import type { McpServerConfig, McpServerScope } from "@OpenAde/contracts/rpc";
import * as Exit from "effect/Exit";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import { toast } from "sonner";

import { describeExitError, useAppAtoms } from "@/lib/app-runtime";
import { Icon } from "@/lib/icon";

import { CommitInput, KeyValueInput, SettingsRow } from "./schema-form";

/** The select's value for "no project" — `null` is base-ui's empty state. */
const USER_SCOPE = "__user__";

const describeServer = (server: McpServerConfig): string =>
  server.transport === "stdio"
    ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
    : (server.url ?? "");

interface Draft {
  name: string;
  scope: McpServerScope;
  transport: "stdio" | "http";
  command: string;
  args: string;
  env: Record<string, string> | undefined;
  url: string;
  headers: Record<string, string> | undefined;
  enabled: boolean;
}

const draftFrom = (server: McpServerConfig | null): Draft => ({
  name: server?.name ?? "",
  scope: server?.scope ?? "user",
  transport: server?.transport ?? "stdio",
  command: server?.command ?? "",
  args: (server?.args ?? []).join("\n"),
  env: server?.env,
  url: server?.url ?? "",
  headers: server?.headers,
  enabled: server?.enabled ?? true,
});

const draftToConfig = (draft: Draft): McpServerConfig | string => {
  if (draft.name.trim() === "") {
    return "Name is required";
  }
  const base = {
    name: draft.name.trim(),
    scope: draft.scope,
    enabled: draft.enabled,
  };
  if (draft.transport === "stdio") {
    if (draft.command.trim() === "") {
      return "Command is required for a stdio server";
    }
    return {
      ...base,
      transport: "stdio",
      command: draft.command.trim(),
      ...(draft.args.trim() === ""
        ? {}
        : {
            args: draft.args
              .split("\n")
              .map((line) => line.trim())
              .filter((l) => l !== ""),
          }),
      ...(draft.env === undefined ? {} : { env: draft.env }),
    };
  }
  if (draft.url.trim() === "") {
    return "URL is required for an HTTP server";
  }
  return {
    ...base,
    transport: "http",
    url: draft.url.trim(),
    ...(draft.headers === undefined ? {} : { headers: draft.headers }),
  };
};

function ServerDialog({
  open,
  onClose,
  editing,
  projectId,
  canUseProjectScope,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The entry being edited, or `null` for a new server. */
  readonly editing: McpServerConfig | null;
  readonly projectId: ProjectId | null;
  readonly canUseProjectScope: boolean;
}) {
  const atoms = useAppAtoms();
  const upsert = useAtomSet(atoms.mcpUpsertAtom, { mode: "promiseExit" });
  const [draft, setDraft] = React.useState<Draft>(() => draftFrom(editing));
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Re-seed the draft whenever the dialog opens on a different entry.
  React.useEffect(() => {
    if (open) {
      setDraft(draftFrom(editing));
      setError(null);
    }
  }, [open, editing]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = async () => {
    const config = draftToConfig(draft);
    if (typeof config === "string") {
      setError(config);
      return;
    }
    setSaving(true);
    const exit = await upsert({ projectId, server: config });
    setSaving(false);
    if (Exit.isSuccess(exit)) {
      onClose();
      return;
    }
    setError(describeExitError(exit, "Could not save the server"));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing === null ? "Add MCP server" : `Edit ${editing.name}`}</DialogTitle>
          <DialogDescription>
            Written to the connector&apos;s own config with an ownership marker — edits by hand
            outside the marker are preserved.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col">
          <SettingsRow field={{ label: "Name", control: "text" }}>
            <CommitInput
              value={draft.name}
              placeholder="my-server"
              onCommit={(next) => set("name", next)}
            />
          </SettingsRow>
          <SettingsRow
            field={{
              label: "Scope",
              control: "select",
              description: canUseProjectScope
                ? "User scope writes the user-level mcp.json; project scope writes the project's .mcp.json."
                : "Pick a project above to write into a project .mcp.json.",
            }}
          >
            <Select
              value={draft.scope}
              onValueChange={(next) => set("scope", next === "project" ? "project" : "user")}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="project" disabled={!canUseProjectScope}>
                  Project
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow field={{ label: "Transport", control: "select" }}>
            <Select
              value={draft.transport}
              onValueChange={(next) => set("transport", next === "http" ? "http" : "stdio")}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">stdio</SelectItem>
                <SelectItem value="http">http</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>

          {draft.transport === "stdio" ? (
            <>
              <SettingsRow field={{ label: "Command", control: "text" }}>
                <CommitInput
                  value={draft.command}
                  placeholder="npx"
                  onCommit={(next) => set("command", next)}
                />
              </SettingsRow>
              <SettingsRow
                field={{ label: "Arguments", control: "text", description: "One per line." }}
              >
                <Textarea
                  value={draft.args}
                  onChange={(event) => set("args", event.target.value)}
                  rows={3}
                />
              </SettingsRow>
              <SettingsRow field={{ label: "Environment", control: "keyValue" }}>
                <KeyValueInput value={draft.env ?? {}} onChange={(next) => set("env", next)} />
              </SettingsRow>
            </>
          ) : (
            <>
              <SettingsRow field={{ label: "URL", control: "text" }}>
                <CommitInput
                  value={draft.url}
                  placeholder="https://example.com/mcp"
                  onCommit={(next) => set("url", next)}
                />
              </SettingsRow>
              <SettingsRow field={{ label: "Headers", control: "keyValue" }}>
                <KeyValueInput
                  value={draft.headers ?? {}}
                  onChange={(next) => set("headers", next)}
                />
              </SettingsRow>
            </>
          )}

          <SettingsRow field={{ label: "Enabled", control: "toggle" }}>
            <div className="flex justify-end">
              <Checkbox
                checked={draft.enabled}
                onCheckedChange={(checked) => set("enabled", checked === true)}
                aria-label="Enabled"
              />
            </div>
          </SettingsRow>
        </div>

        {error === null ? null : <p className="text-xs text-removed">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function McpPanel() {
  const atoms = useAppAtoms();
  const projectsResult = useAtomValue(atoms.projectsAtom);
  const [projectId, setProjectId] = React.useState<ProjectId | null>(null);
  const serversResult = useAtomValue(atoms.mcpServersAtom(projectId));
  const remove = useAtomSet(atoms.mcpRemoveAtom, { mode: "promiseExit" });
  const [dialog, setDialog] = React.useState<{ open: boolean; editing: McpServerConfig | null }>({
    open: false,
    editing: null,
  });

  const projects = AsyncResult.isSuccess(projectsResult) ? projectsResult.value : [];
  const servers = AsyncResult.isSuccess(serversResult) ? serversResult.value : [];

  const removeServer = async (server: McpServerConfig) => {
    const exit = await remove({ projectId, scope: server.scope, name: server.name });
    if (!Exit.isSuccess(exit)) {
      toast.error(describeExitError(exit, "Could not remove server"));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">MCP servers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Servers the connector launches at session start. OpenAde writes them with an ownership
            marker; anything else in the file is yours.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={projectId ?? USER_SCOPE}
            onValueChange={(next) => setProjectId(next === USER_SCOPE ? null : (next as ProjectId))}
          >
            <SelectTrigger className="w-56">
              <SelectValue placeholder="User scope" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={USER_SCOPE}>User scope</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.projectId} value={project.projectId}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDialog({ open: true, editing: null })}
          >
            <Icon icon="hugeicons:add-01" />
            Add server
          </Button>
        </div>
      </div>

      <Card size="sm">
        <CardContent>
          <div className="flex flex-col divide-y divide-border/60">
            {servers.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">No MCP servers configured.</p>
            ) : (
              servers.map((server) => {
                const managed = server.managed === true;
                return (
                  <div
                    key={`${server.scope}:${server.name}`}
                    className="flex items-center gap-3 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{server.name}</span>
                        <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                          {server.transport}
                        </span>
                        <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {server.scope}
                        </span>
                        {!server.enabled ? (
                          <span className="text-xs text-muted-foreground">disabled</span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                        {describeServer(server)}
                      </p>
                    </div>
                    {managed ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDialog({ open: true, editing: server })}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${server.name}`}
                          onClick={() => void removeServer(server)}
                        >
                          <Icon icon="hugeicons:delete-02" />
                        </Button>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">managed by hand</span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </CardContent>
      </Card>

      <ServerDialog
        open={dialog.open}
        editing={dialog.editing}
        projectId={projectId}
        canUseProjectScope={projectId !== null}
        onClose={() => setDialog({ open: false, editing: null })}
      />
    </div>
  );
}

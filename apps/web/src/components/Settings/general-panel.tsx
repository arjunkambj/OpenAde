/**
 * The General page: `defaults` (model, effort, runtime mode) plus the theme —
 * each rendered by `SchemaForm` off the schema's `settingsForm` annotations.
 * Model options come from every enabled connector's probe, effort and runtime
 * mode from their contract enums. Writes are `settings.update` patches; the
 * subscribe stream echoes them back, which is also how a second window sees
 * the change.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Card, CardContent } from "@OpenAde/ui/components/card";
import { Effort, RuntimeMode } from "@OpenAde/contracts/enums";
import {
  Settings,
  SettingsDefaults,
  type Settings as SettingsDoc,
  type Theme,
} from "@OpenAde/contracts/settings";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";
import { toast } from "sonner";

import { useTheme } from "@/components/theme-provider";
import { describeExitError, useAppAtoms } from "@/lib/app-runtime";

import { SchemaForm, type SelectOption } from "./schema-form";

const enumOptions = (literals: ReadonlyArray<string>): ReadonlyArray<SelectOption> =>
  literals.map((value) => ({ value, label: value }));

export function GeneralPanel() {
  const atoms = useAppAtoms();
  const settingsResult = useAtomValue(atoms.settingsAtom);
  const modelsResult = useAtomValue(atoms.allModelsAtom);
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "promiseExit" });
  const { setTheme } = useTheme();

  const settings = AsyncResult.isSuccess(settingsResult) ? settingsResult.value : null;
  const models = AsyncResult.isSuccess(modelsResult) ? modelsResult.value : [];

  const write = async (patch: Parameters<typeof updateSettings>[0]) => {
    const exit = await updateSettings(patch);
    if (!Exit.isSuccess(exit)) {
      toast.error(describeExitError(exit, "Could not save settings"));
    }
  };

  if (settings === null) {
    return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  }

  const setDefault = (key: string, value: unknown) => {
    const next = { ...settings.defaults } as Record<string, unknown>;
    if (value === undefined) {
      // `model` is null-or-string, not optional — clearing writes null.
      if (key === "model") {
        next.model = null;
      } else {
        delete next[key];
      }
    } else {
      next[key] = value;
    }
    void write({ defaults: next as SettingsDoc["defaults"] });
  };

  const setThemeField = (value: unknown) => {
    if (value !== "system" && value !== "light" && value !== "dark") {
      return;
    }
    const theme: Theme = value;
    setTheme(theme);
    void write({ theme });
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-medium">General</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What new threads start with, and how the app looks.
        </p>
      </div>

      <Card size="sm">
        <CardContent>
          <SchemaForm
            schema={Settings}
            value={settings as unknown as Record<string, unknown>}
            onFieldChange={(key, value) => {
              if (key === "theme") {
                setThemeField(value);
              }
            }}
            skip={["connectors", "defaults", "keybindings", "permissions"]}
            optionsFor={(key) => (key === "theme" ? enumOptions(["system", "light", "dark"]) : [])}
          />
        </CardContent>
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-medium">New thread defaults</h2>
        <Card size="sm">
          <CardContent>
            <SchemaForm
              schema={SettingsDefaults}
              value={settings.defaults as unknown as Record<string, unknown>}
              onFieldChange={setDefault}
              optionsFor={(key) => {
                switch (key) {
                  case "model":
                    return models.map((model) => ({
                      value: model.id,
                      label: `${model.family} · ${model.label}`,
                    }));
                  case "effort":
                    return enumOptions(Effort.literals);
                  case "runtimeMode":
                    return enumOptions(RuntimeMode.literals);
                  default:
                    return [];
                }
              }}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

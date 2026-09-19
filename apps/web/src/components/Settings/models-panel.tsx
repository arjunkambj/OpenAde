/**
 * The Models page: `defaults` (model, effort, runtime mode) — what a new
 * thread starts with — rendered by `SchemaForm` off the schema's
 * `settingsForm` annotations. Model options come from every enabled
 * connector's probe, effort and runtime mode from their contract enums.
 *
 * With no default model saved, the picker shows the first listed model: that
 * is the one the server seeds a new thread with (`seedModel`), so the page
 * says what will actually happen instead of "Choose…".
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Card, CardContent } from "@OpenAde/ui/components/card";
import { Effort, RuntimeMode } from "@OpenAde/contracts/enums";
import { SettingsDefaults, type Settings as SettingsDoc } from "@OpenAde/contracts/settings";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";
import { toast } from "sonner";

import { describeExitError, useAppAtoms } from "@/lib/app-runtime";

import { SchemaForm, type SelectOption } from "./schema-form";

const enumOptions = (literals: ReadonlyArray<string>): ReadonlyArray<SelectOption> =>
  literals.map((value) => ({ value, label: value }));

export function ModelsPanel() {
  const atoms = useAppAtoms();
  const settingsResult = useAtomValue(atoms.settingsAtom);
  const modelsResult = useAtomValue(atoms.allModelsAtom);
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "promiseExit" });

  const settings = AsyncResult.isSuccess(settingsResult) ? settingsResult.value : null;
  const models = AsyncResult.isSuccess(modelsResult) ? modelsResult.value : [];

  if (settings === null) {
    return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  }

  const setDefault = async (key: string, value: unknown) => {
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
    const exit = await updateSettings({ defaults: next as SettingsDoc["defaults"] });
    if (!Exit.isSuccess(exit)) {
      toast.error(describeExitError(exit, "Could not save settings"));
    }
  };

  const shown = {
    ...settings.defaults,
    model: settings.defaults.model ?? models[0]?.id ?? null,
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-medium">Models</h1>
        <p className="mt-1 text-sm text-muted-foreground">What new threads start with.</p>
      </div>

      <Card size="sm">
        <CardContent>
          <SchemaForm
            schema={SettingsDefaults}
            value={shown as unknown as Record<string, unknown>}
            onFieldChange={(key, value) => void setDefault(key, value)}
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
  );
}

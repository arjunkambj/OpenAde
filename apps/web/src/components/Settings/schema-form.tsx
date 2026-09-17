/**
 * Renders a `Schema.Struct`'s fields from their `settingsForm` key
 * annotations — label, description and control all come from the schema, so a
 * connector (or any settings struct) gets a form with zero bespoke JSX. The
 * value in flight is a plain `Record<string, unknown>`; `onFieldChange`
 * receives `undefined` to mean "leave the key absent", which is how optional
 * fields stay unset rather than written back as empty strings.
 *
 * Controls: `text`/`path` commit on blur or Enter, `toggle`/`select` commit on
 * change, `keyValue` edits a `Record<string, string>` row-wise, `shortcut`
 * captures the next chord, `hidden` renders nothing.
 */

import { Button } from "@OpenAde/ui/components/button";
import { Checkbox } from "@OpenAde/ui/components/checkbox";
import { Input } from "@OpenAde/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@OpenAde/ui/components/select";
import type { SettingsFormField } from "@OpenAde/contracts/settings";
import { isObject, isString } from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as React from "react";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/** The `settingsForm` key annotation on a struct field, when it has one. */
const formFieldOf = (
  field: Parameters<typeof Schema.resolveAnnotationsKey>[0],
): SettingsFormField | undefined =>
  Schema.resolveAnnotationsKey(field)?.["settingsForm"] as SettingsFormField | undefined;

const stringValue = (value: unknown): string => (isString(value) ? value : "");

const recordValue = (value: unknown): Record<string, string> => {
  if (!isObject(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isString(item)) {
      out[key] = item;
    }
  }
  return out;
};

/** One settings row: the annotation's label and description left, control right. */
export function SettingsRow({
  field,
  children,
}: {
  readonly field: SettingsFormField;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{field.label}</div>
        {field.description === undefined ? null : (
          <p className="mt-0.5 text-xs text-muted-foreground">{field.description}</p>
        )}
      </div>
      <div className="w-72 shrink-0">{children}</div>
    </div>
  );
}

/**
 * A text input that edits a local draft and commits on blur or Enter, so the
 * subscribed settings document cannot echo a stale value over a half-typed one.
 */
export function CommitInput({
  value,
  placeholder,
  onCommit,
}: {
  readonly value: string;
  readonly placeholder?: string;
  readonly onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  return (
    <Input
      value={draft ?? value}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) {
          onCommit(draft);
        }
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * A `keyValue` control: rows of key + value inputs. Rows live in local state so
 * a half-edited `["", ""]` row survives; the emitted record drops empty keys.
 */
export function KeyValueInput({
  value,
  onChange,
}: {
  readonly value: Record<string, string>;
  readonly onChange: (next: Record<string, string> | undefined) => void;
}) {
  const [rows, setRows] = React.useState<Array<readonly [string, string]>>(() =>
    Object.entries(value),
  );

  // Resync when the record changes underneath us (a subscribe echo or reset).
  React.useEffect(() => {
    const incoming = Object.entries(value);
    const projected = rows.filter(([key]) => key !== "");
    const same =
      projected.length === incoming.length &&
      projected.every(([key, item]) => value[key] === item && incoming.some(([k]) => k === key));
    if (!same) {
      setRows(incoming);
    }
    // `rows` is the draft; `value` is the truth — resync on value only.
  }, [value]);

  const emit = (next: Array<readonly [string, string]>) => {
    setRows(next);
    const record: Record<string, string> = {};
    for (const [key, item] of next) {
      if (key !== "") {
        record[key] = item;
      }
    }
    onChange(Object.keys(record).length === 0 ? undefined : record);
  };

  return (
    <div className="flex flex-col gap-2">
      {rows.map(([key, item], index) => (
        <div key={index} className="flex items-center gap-2">
          <CommitInput
            value={key}
            placeholder="NAME"
            onCommit={(nextKey) =>
              emit(rows.map((row, i) => (i === index ? ([nextKey, row[1]] as const) : row)))
            }
          />
          <CommitInput
            value={item}
            placeholder="value"
            onCommit={(nextValue) =>
              emit(rows.map((row, i) => (i === index ? ([row[0], nextValue] as const) : row)))
            }
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={key === "" ? "Remove row" : `Remove ${key}`}
            onClick={() => emit(rows.filter((_, i) => i !== index))}
          >
            ×
          </Button>
        </div>
      ))}
      <div>
        <Button variant="outline" size="sm" onClick={() => setRows([...rows, ["", ""]])}>
          Add variable
        </Button>
      </div>
    </div>
  );
}

/**
 * A `shortcut` control: click, then press the chord. The stored notation is
 * `Cmd+Shift+B` — `Cmd` stands for the platform modifier and is normalised at
 * the point of use. Escape alone records `Escape` (it is a real binding);
 * Backspace clears.
 */
export function ShortcutInput({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (next: string | undefined) => void;
}) {
  const [listening, setListening] = React.useState(false);
  return (
    <Button
      variant={listening ? "secondary" : "outline"}
      size="sm"
      onClick={() => setListening(true)}
      onBlur={() => setListening(false)}
      onKeyDown={(event) => {
        if (!listening) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Backspace") {
          onChange(undefined);
          setListening(false);
          return;
        }
        if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) {
          return;
        }
        const parts: Array<string> = [];
        if (event.metaKey || event.ctrlKey) {
          parts.push("Cmd");
        }
        if (event.altKey) {
          parts.push("Alt");
        }
        if (event.shiftKey) {
          parts.push("Shift");
        }
        const key = event.key === " " ? "Space" : event.key;
        parts.push(key.length === 1 ? key.toUpperCase() : key);
        onChange(parts.join("+"));
        setListening(false);
      }}
    >
      {listening ? "Press keys…" : value === "" ? "Set shortcut" : value}
    </Button>
  );
}

export interface SchemaFormProps {
  readonly schema: Schema.Struct<Schema.Struct.Fields>;
  readonly value: Record<string, unknown>;
  readonly onFieldChange: (key: string, value: unknown) => void;
  /** Options for `select` controls — the page decides where choices come from. */
  readonly optionsFor?: (key: string, field: SettingsFormField) => ReadonlyArray<SelectOption>;
  /** Extra keys to skip even though they are not annotated `hidden`. */
  readonly skip?: ReadonlyArray<string>;
}

/** Every annotated, non-hidden field of the struct, in declaration order. */
export function SchemaForm({ schema, value, onFieldChange, optionsFor, skip }: SchemaFormProps) {
  return (
    <div className="divide-y divide-border/60">
      {Object.entries(schema.fields).map(([key, fieldSchema]) => {
        if (skip !== undefined && skip.includes(key)) {
          return null;
        }
        const field = formFieldOf(fieldSchema);
        if (field === undefined || field.control === "hidden") {
          return null;
        }
        const current = value[key];
        const change = (next: unknown) => onFieldChange(key, next);
        let control: React.ReactNode;
        switch (field.control) {
          case "toggle":
            control = (
              <Checkbox
                checked={current === true}
                onCheckedChange={(checked) => change(checked === true)}
                aria-label={field.label}
              />
            );
            break;
          case "select": {
            const options = optionsFor?.(key, field) ?? [];
            control = (
              <Select
                value={isString(current) ? current : null}
                onValueChange={(next) => change(next ?? undefined)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose…" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
            break;
          }
          case "keyValue":
            control = (
              <KeyValueInput value={recordValue(current)} onChange={(next) => change(next)} />
            );
            break;
          case "shortcut":
            control = (
              <ShortcutInput value={stringValue(current)} onChange={(next) => change(next)} />
            );
            break;
          case "path":
            control = (
              <CommitInput
                value={stringValue(current)}
                placeholder={field.placeholder}
                onCommit={(next) => change(next === "" ? undefined : next)}
              />
            );
            break;
          default:
            control = (
              <CommitInput
                value={stringValue(current)}
                placeholder={field.placeholder}
                onCommit={(next) => change(next === "" ? undefined : next)}
              />
            );
        }
        return (
          <SettingsRow key={key} field={field}>
            {control}
          </SettingsRow>
        );
      })}
    </div>
  );
}

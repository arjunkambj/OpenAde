import type { ConnectorModels } from "@OpenAde/client-runtime/connectorAtoms";
import type { ConnectorInstanceId } from "@OpenAde/contracts/ids";
import type { ModelOption } from "@OpenAde/contracts/connectors";
import { describe, expect, it } from "vitest";

import {
  decodeModelPick,
  defaultModelPick,
  encodeModelPick,
  findModel,
  modelPickerGroups,
} from "./model-picks";

const id = (value: string) => value as ConnectorInstanceId;

const model = (modelId: string, efforts: ModelOption["efforts"] = []): ModelOption => ({
  id: modelId,
  label: modelId.toUpperCase(),
  family: "family",
  efforts,
});

const group = (instanceId: string, models: ReadonlyArray<ModelOption>): ConnectorModels => ({
  connector: {
    connectorInstanceId: id(instanceId),
    kind: "harness",
    displayName: `Instance ${instanceId}`,
    enabled: true,
    capabilities: null,
    extensions: { skills: false, mcpServers: false },
    probe: { status: "ready", probedAt: "2026-09-18T00:00:00.000Z" },
  },
  models,
});

// Two instances of one harness list the same ids.
const catalog = [group("a", [model("m1"), model("m2")]), group("b", [model("m1")])];

describe("encodeModelPick / decodeModelPick", () => {
  it("round-trips a pick, whatever the ids contain", () => {
    for (const pick of [
      { connectorInstanceId: id("a"), model: "m1" },
      { connectorInstanceId: id("with::colons"), model: "vendor/model::v2" },
      { connectorInstanceId: null, model: "stale" },
    ]) {
      expect(decodeModelPick(encodeModelPick(pick))).toEqual(pick);
    }
  });

  it("keeps the same model under two instances apart", () => {
    expect(encodeModelPick({ connectorInstanceId: id("a"), model: "m1" })).not.toBe(
      encodeModelPick({ connectorInstanceId: id("b"), model: "m1" }),
    );
  });

  it("answers null for anything it did not encode", () => {
    for (const value of ["", "m1", "[]", '["a"]', '["a", 3]', '[1, "m1"]', '["a", ""]', "{"]) {
      expect(decodeModelPick(value)).toBeNull();
    }
  });
});

describe("modelPickerGroups", () => {
  it("lists one section per instance, in catalog order, with unique values", () => {
    const groups = modelPickerGroups(catalog, { instanceId: id("a"), locked: false });
    expect(groups.map((entry) => entry.connector.connectorInstanceId)).toEqual(["a", "b"]);
    const values = groups.flatMap((entry) => entry.items.map((item) => item.value));
    expect(new Set(values).size).toBe(3);
    expect(groups.every((entry) => !entry.locked)).toBe(true);
    expect(groups.flatMap((entry) => entry.items).every((item) => !item.disabled)).toBe(true);
  });

  it("disables every other instance on a thread that can no longer switch", () => {
    const groups = modelPickerGroups(catalog, { instanceId: id("b"), locked: true });
    expect(groups.map((entry) => [entry.connector.connectorInstanceId, entry.locked])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(groups[0]?.items.every((item) => item.disabled)).toBe(true);
    expect(groups[1]?.items.every((item) => !item.disabled)).toBe(true);
  });
});

describe("findModel", () => {
  it("prefers the thread's own instance, then any that lists the id", () => {
    const own = group("a", [model("m1", ["low"])]);
    const other = group("b", [model("m1", ["high"]), model("only-b", ["max"])]);
    expect(findModel([own, other], { connectorInstanceId: id("b"), model: "m1" })?.efforts).toEqual(
      ["high"],
    );
    expect(
      findModel([own, other], { connectorInstanceId: id("a"), model: "only-b" })?.efforts,
    ).toEqual(["max"]);
    expect(findModel([own, other], { connectorInstanceId: null, model: "nope" })).toBeUndefined();
  });
});

describe("defaultModelPick", () => {
  it("puts the saved default under the first instance that lists it", () => {
    expect(defaultModelPick(catalog, "m1")).toEqual({ connectorInstanceId: "a", model: "m1" });
    expect(defaultModelPick([group("a", [model("x")]), ...catalog], "m1")).toEqual({
      connectorInstanceId: "a",
      model: "m1",
    });
    expect(defaultModelPick([group("z", []), group("b", [model("m1")])], "m1")).toEqual({
      connectorInstanceId: "b",
      model: "m1",
    });
  });

  it("keeps a saved default no instance lists, with no instance", () => {
    expect(defaultModelPick(catalog, "gone")).toEqual({ connectorInstanceId: null, model: "gone" });
    expect(defaultModelPick([], "gone")).toEqual({ connectorInstanceId: null, model: "gone" });
  });

  it("falls back to the first instance that lists any model", () => {
    expect(defaultModelPick([group("empty", []), ...catalog], null)).toEqual({
      connectorInstanceId: "a",
      model: "m1",
    });
    expect(defaultModelPick([], undefined)).toBeNull();
  });
});

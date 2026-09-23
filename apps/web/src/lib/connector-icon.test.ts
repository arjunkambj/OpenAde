import { Server, Terminal } from "@honeyicons/react";
import { describe, expect, it } from "vitest";

import { connectorIconFor } from "./connector-icon";

describe("connectorIconFor", () => {
  it("maps the generic keys a connector may name", () => {
    expect(connectorIconFor("terminal")).toBe(Terminal);
    expect(connectorIconFor("server")).toBe(Server);
  });

  it("falls back to the server glyph for an unknown or missing key", () => {
    expect(connectorIconFor("unheard-of")).toBe(Server);
    expect(connectorIconFor(undefined)).toBe(Server);
  });
});

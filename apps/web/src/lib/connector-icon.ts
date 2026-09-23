/**
 * A connector's `metadata.iconKey` → the icon the renderer draws for it. The
 * key names a generic glyph, never a product's logo, so the map stays small;
 * a key this build does not know falls back to the generic server glyph.
 */

import { type HoneyIcon, Server, Terminal } from "@honeyicons/react";

const CONNECTOR_ICONS: Readonly<Record<string, HoneyIcon>> = {
  terminal: Terminal,
  server: Server,
};

export const connectorIconFor = (iconKey: string | undefined): HoneyIcon =>
  (iconKey === undefined ? undefined : CONNECTOR_ICONS[iconKey]) ?? Server;

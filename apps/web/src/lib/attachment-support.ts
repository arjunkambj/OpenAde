/**
 * Whether the composer may take attachments at all, from the harness's
 * capabilities.
 *
 * The server stages images only (`attachments.stage` sniffs the bytes), so
 * `images` is the one flag that gates anything today. `attachments: "files"`
 * is declared by connectors that could carry any file, and is read once the
 * server can stage more than images.
 */

import type { ConnectorCapabilities } from "@poseidon/contracts/runtime";

export const IMAGES_UNSUPPORTED =
  "The connector this thread runs on cannot read images — start a thread on one that can";

/**
 * The reason attaching is refused, or `null` when it is allowed. Unknown
 * capabilities allow it: a connector that has not opened yet is not a "no".
 */
export const attachmentRefusal = (
  capabilities: Pick<ConnectorCapabilities, "images"> | null | undefined,
): string | null => (capabilities?.images === false ? IMAGES_UNSUPPORTED : null);

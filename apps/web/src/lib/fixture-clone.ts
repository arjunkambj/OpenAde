/**
 * Replicating a fixture thread into the 1,000-row timeline the virtualization
 * check needs.
 *
 * Both halves of the id have to move per copy. The node field mixes the copy
 * index with the source item's own counter, because every fixture id shares
 * the first 24 characters — keying clones on the copy alone gives all items of
 * a copy the same id, which collides React keys, collapses `buildTimeline`'s
 * `byId` map (so a task's children nest under the wrong item) and leaves
 * `LegendList` rendering a handful of rows. The timestamp field moves a second
 * per item and a minute per copy, because the fold labels read durations out
 * of these ids and a shared millisecond measures no time at all.
 */

import { decodeItemId, type ItemId } from "@OpenAde/contracts/ids";
import type { ItemSnapshot } from "@OpenAde/contracts/runtime";

/** `0199c0de-0005-7000-8000-000000000001` → its 48-bit millisecond field. */
const millisOf = (id: string): number => Number.parseInt(`${id.slice(0, 8)}${id.slice(9, 13)}`, 16);

/** The node field, which the fixtures use as a per-item counter. */
const counterOf = (id: string): number => Number.parseInt(id.slice(24), 16);

const cloneItemId = (id: ItemId, copy: number): ItemId => {
  const index = counterOf(id);
  const stamp = (millisOf(id) + copy * 60_000 + index * 1_000).toString(16).padStart(12, "0");
  const node = (copy * 0x10000 + index).toString(16).padStart(12, "0");
  return decodeItemId(
    `${stamp.slice(0, 8)}-${stamp.slice(8, 12)}-${id.slice(14, 18)}-${id.slice(19, 23)}-${node}`,
  );
};

const cloneItem = (item: ItemSnapshot, copy: number): ItemSnapshot => ({
  ...item,
  itemId: cloneItemId(item.itemId, copy),
  // Children follow their own copy's parent, not copy 0's.
  parentItemId: item.parentItemId === undefined ? undefined : cloneItemId(item.parentItemId, copy),
});

/** `items` repeated `copies` times, every clone carrying a distinct id. */
export const cloneItems = (
  items: ReadonlyArray<ItemSnapshot>,
  copies: number,
): ReadonlyArray<ItemSnapshot> =>
  copies <= 1
    ? items
    : Array.from({ length: copies }, (_, copy) =>
        items.map((item) => cloneItem(item, copy)),
      ).flat();

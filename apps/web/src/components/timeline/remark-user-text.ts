/**
 * Two small remark plugins for text a person typed, which the user bubble
 * renders as markdown without reading it the way a document is read:
 *
 * - `remarkHtmlAsText` turns every raw HTML node into plain text, so `<b>x</b>`
 *   shows as typed. The bubble does not depend on how the renderer happens to
 *   treat raw HTML by default; the tree it gets simply holds none. HTML that
 *   stood as a block of its own becomes a paragraph, since text may not sit
 *   directly in a block container.
 * - `remarkSoftBreaks` turns each line ending inside text into a hard break,
 *   so a single Enter in the composer is a new line in the bubble, as it was
 *   when the bubble was plain text.
 *
 * Run `remarkHtmlAsText` first, so the line endings of an HTML block it turned
 * into text are broken too. Code keeps its line endings: a code node holds a
 * `value`, not `text` children, so neither plugin touches it.
 *
 * The nodes are typed loosely rather than through the mdast types, which this
 * app does not depend on.
 */

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/** Containers whose children are blocks; anything else holds inline content. */
const FLOW_PARENTS: ReadonlySet<string> = new Set([
  "root",
  "blockquote",
  "listItem",
  "footnoteDefinition",
]);

const htmlAsText = (node: MdNode): void => {
  const children = node.children;
  if (children === undefined) {
    return;
  }
  node.children = children.map((child) => {
    if (child.type !== "html") {
      htmlAsText(child);
      return child;
    }
    const text: MdNode = { type: "text", value: child.value ?? "" };
    return FLOW_PARENTS.has(node.type) ? { type: "paragraph", children: [text] } : text;
  });
};

const LINE_ENDING = /\r\n|\r|\n/;

const softBreaks = (node: MdNode): void => {
  const children = node.children;
  if (children === undefined) {
    return;
  }
  node.children = children.flatMap((child) => {
    if (child.type !== "text") {
      softBreaks(child);
      return [child];
    }
    const lines = (child.value ?? "").split(LINE_ENDING);
    return lines.flatMap((line, index): MdNode[] => {
      const parts: MdNode[] = index === 0 ? [] : [{ type: "break" }];
      return line === "" ? parts : [...parts, { type: "text", value: line }];
    });
  });
};

export function remarkHtmlAsText() {
  return (tree: MdNode) => htmlAsText(tree);
}

export function remarkSoftBreaks() {
  return (tree: MdNode) => softBreaks(tree);
}

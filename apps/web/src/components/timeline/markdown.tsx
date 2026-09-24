/**
 * Assistant text and plan bodies render through this one markdown component so
 * heading/code/list styling stays consistent between the timeline and cards.
 * Elements are mapped to styled tags rather than arbitrary-variant selectors.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

interface HastLike {
  readonly type: string;
  readonly value?: string;
  readonly children?: ReadonlyArray<HastLike>;
}

const hastText = (node: HastLike): string =>
  node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(hastText).join("");

/** A fence's text without the newline mdast-util-to-hast appends to it. */
const blockText = (node: HastLike | undefined): string =>
  node === undefined ? "" : hastText(node).replace(/\n$/, "");

const components: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="mb-3 text-base font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-3 text-base font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 text-sm font-semibold">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-2 text-sm font-semibold">{children}</h4>,
  ul: ({ children }) => <ul className="mb-3 list-disc pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="mb-1">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-file underline underline-offset-2"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-border pl-3 text-muted-foreground last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-left">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border px-2 py-1 font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-border px-2 py-1">{children}</td>,
  // react-markdown passes no `inline` flag, and a fence without a language has
  // no class either, so a block is told apart here: `pre` renders its `code`
  // child's text itself, and the `code` override only ever sees inline code.
  pre: ({ node }) => (
    <pre className="mb-3 overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs last:mb-0">
      <code>{blockText(node)}</code>
    </pre>
  ),
  code: ({ children }) => (
    <code className="rounded-sm bg-hover px-1 py-0.5 font-mono text-xs">{children}</code>
  ),
};

export function MarkdownBody({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("text-sm leading-prose text-foreground", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

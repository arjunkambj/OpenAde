/**
 * Assistant text and plan bodies render through this one markdown component so
 * heading/code/list styling stays consistent between the timeline and cards.
 * Elements are mapped to styled tags rather than arbitrary-variant selectors.
 *
 * Fenced blocks render as a `CodeBlock` (header, copy, wrap, highlighting).
 * The body's `id` — the item it belongs to — keys each block by item and
 * offset, so a row the list recycles for another item neither keeps the old
 * block's wrap state nor reuses its highlight. While `streaming`, a block whose
 * closing fence has not arrived stays plain.
 *
 * The `user` variant renders what a person typed in the user bubble: a single
 * line ending is a line break, raw HTML shows as the text it is
 * (`remark-user-text.ts`), headings stay at body size, and inline code sits on
 * a lighter chip that reads on the bubble's background.
 */

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

import { CodeBlock } from "./code-block";
import { codeFenceInfo, type HastLike, hastText, openFenceOffset } from "./code-fence";
import { remarkHtmlAsText, remarkSoftBreaks } from "./remark-user-text";

interface BlockContext {
  readonly id: string | undefined;
  /** Where an unterminated fence opens in the text, while it streams. */
  readonly openFrom: number | undefined;
}

const MarkdownBlockContext = React.createContext<BlockContext>({
  id: undefined,
  openFrom: undefined,
});

interface HastElementLike extends HastLike {
  readonly tagName?: string;
  readonly properties?: { readonly className?: unknown };
  readonly data?: unknown;
  readonly position?: { readonly start: { readonly offset?: number } };
}

/**
 * react-markdown passes no `inline` flag, and a fence without a language has
 * no class either, so a block is told apart here: `pre` reads its `code`
 * child off the hast node and renders the block itself, and the `code`
 * override only ever sees inline code.
 */
function FencedBlock({ node }: { readonly node: HastElementLike | undefined }) {
  const { id, openFrom } = React.useContext(MarkdownBlockContext);
  const code = node?.children?.find(
    (child): child is HastElementLike => (child as HastElementLike).tagName === "code",
  );
  const meta = (code?.data as { readonly meta?: unknown } | undefined)?.meta;
  const info = codeFenceInfo(
    code?.properties?.className,
    typeof meta === "string" ? meta : undefined,
  );
  // mdast-util-to-hast appends a newline to a fence's text; the source has none.
  const text = code === undefined ? "" : hastText(code).replace(/\n$/, "");
  const offset = node?.position?.start.offset ?? 0;
  const key = id === undefined ? undefined : `${id}:${offset}`;
  return (
    <CodeBlock
      key={key ?? offset}
      code={text}
      info={info}
      cacheKey={key === undefined ? undefined : `${key}:${text.length}`}
      plain={openFrom !== undefined && offset >= openFrom}
    />
  );
}

const components: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  h1: ({ children }) => (
    <h1 className="mt-5 mb-3 text-base font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-5 mb-3 text-base font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => <h3 className="mt-4 mb-2 text-sm font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-4 mb-2 text-sm font-semibold first:mt-0">{children}</h4>,
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
      <table className="w-full border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border px-2 py-1 align-bottom font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-border px-2 py-1 align-top">{children}</td>,
  pre: ({ node }) => <FencedBlock node={node} />,
  code: ({ children }) => (
    <code className="rounded-sm bg-hover px-1 py-0.5 font-mono text-xs">{children}</code>
  ),
};

// A heading someone typed stays a heading, at the size of the text around it.
const userHeading =
  (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
  ({ children }: { readonly children?: React.ReactNode }) => (
    <Tag className="mt-3 mb-2 text-sm font-semibold first:mt-0">{children}</Tag>
  );

const userComponents: typeof components = {
  ...components,
  h1: userHeading("h1"),
  h2: userHeading("h2"),
  h3: userHeading("h3"),
  h4: userHeading("h4"),
  h5: userHeading("h5"),
  h6: userHeading("h6"),
  code: ({ children }) => (
    <code className="rounded-sm bg-background/60 px-1 py-0.5 font-mono text-xs">{children}</code>
  ),
};

type MarkdownProps = React.ComponentProps<typeof ReactMarkdown>;

interface Variant {
  readonly remarkPlugins: MarkdownProps["remarkPlugins"];
  readonly components: MarkdownProps["components"];
  readonly className: string;
}

const VARIANTS: Readonly<Record<"agent" | "user", Variant>> = {
  agent: {
    remarkPlugins: [remarkGfm],
    components,
    className: "leading-prose",
  },
  user: {
    remarkPlugins: [remarkGfm, remarkHtmlAsText, remarkSoftBreaks],
    components: userComponents,
    className: "leading-normal",
  },
};

export function MarkdownBody({
  text,
  id,
  streaming = false,
  variant = "agent",
  className,
}: {
  text: string;
  /** The item the text belongs to, which keys its code blocks. */
  id?: string;
  /** The text is still arriving: an open fence at its end is not highlighted. */
  streaming?: boolean;
  /** `user` for the text a person typed, `agent` (the default) for the rest. */
  variant?: keyof typeof VARIANTS;
  className?: string;
}) {
  const openFrom = streaming ? openFenceOffset(text) : undefined;
  const context = React.useMemo(() => ({ id, openFrom }), [id, openFrom]);
  const config = VARIANTS[variant];
  return (
    <div className={cn("text-sm text-foreground", config.className, className)}>
      <MarkdownBlockContext.Provider value={context}>
        <ReactMarkdown remarkPlugins={config.remarkPlugins} components={config.components}>
          {text}
        </ReactMarkdown>
      </MarkdownBlockContext.Provider>
    </div>
  );
}

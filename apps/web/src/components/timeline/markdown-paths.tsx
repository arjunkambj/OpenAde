/**
 * The markdown elements that can name a workspace file — links and inline
 * code — and the context that says which of the message's paths are files.
 *
 * `MarkdownBody` scans its text for candidates (`collectPathCandidates`) and
 * asks the workspace about them once, through `PathChipsProvider`.
 * A link or a code span whose path is in the answer renders as a `FileChip`
 * at its line. Anything else is left as it was written, with one exception: a
 * link whose target is a path the workspace does not confirm renders as its
 * text, because following it would load the app's own origin at that path.
 */

import * as React from "react";

import { FileChip } from "@/components/timeline/file-chip";
import { PathChipsContext } from "@/components/timeline/path-chips";
import { inlineCodePathCandidate, parsePathLink } from "@/components/timeline/path-links";

export function MarkdownLink({
  href,
  children,
}: {
  readonly href?: string | undefined;
  readonly children?: React.ReactNode;
}) {
  const files = React.useContext(PathChipsContext);
  const link = href === undefined ? null : parsePathLink(href);
  if (link === null) {
    // What the sanitizer emptied (a `javascript:` URL) is not a link either.
    if (href === undefined || href === "") {
      return <>{children}</>;
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-file underline underline-offset-2"
      >
        {children}
      </a>
    );
  }
  const file = files.get(link.path);
  return file === undefined ? <>{children}</> : <FileChip file={file} position={link} />;
}

/** Inline code, or the file chip it names. */
export function InlineCode({
  className,
  children,
}: {
  readonly className: string;
  readonly children?: React.ReactNode;
}) {
  const files = React.useContext(PathChipsContext);
  const link =
    typeof children === "string" && files.size > 0
      ? inlineCodePathCandidate(children.trim())
      : null;
  const file = link === null ? undefined : files.get(link.path);
  if (link !== null && file !== undefined) {
    return <FileChip file={file} position={link} />;
  }
  return <code className={className}>{children}</code>;
}

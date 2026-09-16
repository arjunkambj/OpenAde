import { site } from "../site";

export const Footer = () => (
  <footer className="border-t border-border">
    <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 px-6 py-10 text-sm text-muted-foreground sm:flex-row">
      <span>
        {site.name} — open source under the{" "}
        <a href={site.licenseUrl} className="underline underline-offset-4 hover:text-foreground">
          MIT license
        </a>
        .
      </span>
      <div className="flex gap-6">
        <a href={site.repoUrl} className="hover:text-foreground">
          GitHub
        </a>
        <a href={site.docsUrl} className="hover:text-foreground">
          Docs
        </a>
        <a href={site.feedbackUrl} className="hover:text-foreground">
          Feedback
        </a>
      </div>
    </div>
  </footer>
);

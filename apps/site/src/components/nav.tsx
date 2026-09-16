import { site } from "../site";

const links = [
  { href: "#features", label: "Features" },
  { href: "#get-started", label: "Docs" },
  { href: "#download", label: "Download" },
  { href: "#feedback", label: "Feedback" },
] as const;

export const Nav = () => (
  <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
    <nav className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
      <a href="#top" className="text-base font-semibold tracking-tight text-strong">
        {site.name}
      </a>
      <div className="flex items-center gap-6">
        {links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:block"
          >
            {link.label}
          </a>
        ))}
        <a
          href={site.repoUrl}
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          GitHub
        </a>
        <a
          href="#download"
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-strong"
        >
          Download
        </a>
      </div>
    </nav>
  </header>
);

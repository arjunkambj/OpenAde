import { site } from "../site";

export const Feedback = () => (
  <section id="feedback" className="mx-auto max-w-5xl px-6 py-20 text-center">
    <h2 className="text-3xl font-semibold tracking-tight text-strong">
      Found a bug? Have an idea?
    </h2>
    <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
      Launch feedback shapes what gets built next. File an issue and it lands in the triage log —
      every item gets a decision, and feature ideas become written proposals.
    </p>
    <a
      href={site.feedbackUrl}
      className="mt-8 inline-block rounded-md border border-border bg-card px-6 py-3 text-sm font-medium text-foreground transition-colors hover:bg-hover"
    >
      Send feedback
    </a>
  </section>
);

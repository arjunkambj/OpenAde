# Feedback triage — how launch feedback becomes work

Applies from the first public launch. The channel is GitHub Issues on
`arjunkambj/OpenAde`; the site's "Send feedback" link opens the issue chooser
(bug report / feedback-or-idea templates). Once the repository is public this
works for anyone; while it is private, feedback comes in through whichever
channel the maintainer exposes and is logged here the same way.

## Roles

- **Maintainer triages.** Every item is read, labelled and decided by the
  maintainer. Nothing auto-closes.
- **Proposals are drafted for the maintainer.** Any item that implies new
  functionality gets a proposal doc (see below) before it can become work.

## Flow

1. **Intake.** New issue lands via the site link or directly. Label `bug`,
   `feedback` or `proposal` (the templates pre-apply `bug` / `feedback`).
2. **Log it.** Add a row to `feedback-log.md`: date, source (issue number or
   channel), one-line summary. Logging happens even for duplicates — the log
   is the evidence base for proposals.
3. **Decide.** One of:
   - `fix` — a defect in shipped behaviour; goes to the owning workstream as a
     bug, no proposal needed.
   - `proposal` — implies new functionality; write
     `docs/launch/proposals/<slug>.md` from `_template.md`.
   - `wont-fix` / `duplicate` — close with a reason; keep the log row so the
     pattern is visible if it recurs.
4. **Route.** A proposal that fits an existing workstream's brief goes to that
   workstream's owner **through the maintainer** — never by editing another
   workstream's directories. A proposal that fits nothing becomes a candidate
   workstream only after the maintainer says so.
5. **Close the loop.** When a decision lands, update the log row's status and
   reply on the issue.

## Proposal format

`docs/launch/proposals/_template.md` is the shape: problem, evidence (links to
log rows), proposed change, affected workstream, size. Keep them to a page —
a proposal is a decision aid, not a spec.

# Launch track (W11)

The public face of OpenADE and the feedback loop around it. The app itself is
a desktop download — nothing here hosts the product.

| Doc                  | What it covers                                                                          |
| -------------------- | --------------------------------------------------------------------------------------- |
| `hosting.md`         | Cloudflare Pages deploy: git integration and Wrangler paths, domain, previews, rollback |
| `feedback-triage.md` | How GitHub issues become decisions and proposals                                        |
| `feedback-log.md`    | The running log — every feedback item, its source, its decision                         |
| `proposals/`         | One file per feature proposal (`_template.md` is the shape)                             |

State: the site builds, prerenders and is smoke-tested inside `pnpm check`;
the deploy path is wired and waiting on the maintainer's go plus the
Cloudflare account connection. The download link points at GitHub Releases
until W7's `pnpm build:desktop` produces a dmg.

Commands: `pnpm dev:site` (port 3020) · `pnpm preview:site` ·
`pnpm deploy:site` · `pnpm -F site deploy:preview`.

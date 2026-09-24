# Hosting — Cloudflare Pages

The site (`apps/site`) deploys to **Cloudflare Pages**, project `poseidon`,
custom domain `poseidoncode.com`. Pages is free for this use (unlimited
bandwidth, unlimited requests) and gives per-branch preview URLs for free.

Two deploy paths exist; use either, they converge on the same project.

## Path A — git integration (recommended once connected)

Pages builds and deploys on every push. **Preview deploys per branch come
free**: each branch gets `<branch>.poseidon.pages.dev`.

One-time setup, done in the Cloudflare dashboard by the account owner:

1. Pages → Create project → Connect to git → `arjunkambj/Poseidon`.
2. Build settings: root directory `/` (repo root), build command
   `pnpm -F site build`, output directory `apps/site/dist`, Node 22+.
   Add env var `PNPM_VERSION=11.21.0` if the build image's pnpm is older.
3. Production branch: `main`.
4. Custom domains → add `poseidoncode.com`. If the domain's DNS is on
   Cloudflare this is automatic; otherwise add the CNAME Pages prints at the
   registrar.

After that, merges to `main` deploy automatically and every workstream branch
gets a preview on push — no code changes needed.

## Path B — manual deploy via Wrangler

For a deploy straight from a checkout (or before the repo is connected):

```bash
pnpm deploy:site            # production deploy of the current checkout
pnpm -F site deploy:preview # preview deploy under the current branch name
```

The scripts pin `wrangler@4.133.0` via `pnpm dlx` — it is a deploy tool, not
a dependency, so it stays out of `package.json` and the lockfile.

Credentials, once per machine (the account owner does this):

```bash
export CLOUDFLARE_ACCOUNT_ID=<from dashboard → overview → right rail>
export CLOUDFLARE_API_TOKEN=<API token with the "Cloudflare Pages: Edit" permission>
```

or run `pnpm dlx wrangler@4.133.0 login` once for OAuth. Never commit the
token; it stays an environment variable by name.

If the project does not exist yet:
`pnpm dlx wrangler@4.133.0 pages project create poseidon --production-branch main`.

## The first real deploy

Happens only when the maintainer says go. Until then `pnpm preview:site`
serves the exact production build locally on port 3020.

## Rollback

Pages keeps every deployment. Dashboard → `poseidon` → Deployments → pick the
last good one → Rollback. With git integration, reverting the commit on
`main` redeploys the previous build.

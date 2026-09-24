/**
 * Every external URL the site links out to, in one place. The smoke test
 * asserts each of these renders into the built HTML.
 */
export const site = {
  name: "Poseidon",
  repoUrl: "https://github.com/arjunkambj/Poseiden",
  // Placeholder until W7's `pnpm build:desktop` produces a dmg.
  downloadUrl: "https://github.com/arjunkambj/Poseiden/releases",
  feedbackUrl: "https://github.com/arjunkambj/Poseiden/issues/new/choose",
  docsUrl: "https://github.com/arjunkambj/Poseiden/tree/main/docs",
  licenseUrl: "https://github.com/arjunkambj/Poseiden/blob/main/LICENSE",
} as const;

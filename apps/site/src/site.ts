/**
 * Every external URL the site links out to, in one place. The smoke test
 * asserts each of these renders into the built HTML.
 */
export const site = {
  name: "OpenADE",
  repoUrl: "https://github.com/arjunkambj/OpenAde",
  // Placeholder until W7's `pnpm build:desktop` produces a dmg.
  downloadUrl: "https://github.com/arjunkambj/OpenAde/releases",
  feedbackUrl: "https://github.com/arjunkambj/OpenAde/issues/new/choose",
  docsUrl: "https://github.com/arjunkambj/OpenAde/tree/main/docs",
  licenseUrl: "https://github.com/arjunkambj/OpenAde/blob/main/LICENSE",
} as const;

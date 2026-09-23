/**
 * The one-line `subject` a resolved decision is recorded with.
 *
 * Both folds write the record — the server's into the stored thread, the
 * client's between snapshots — and they have to agree on its text or a
 * resnapshot rewrites a line the user is looking at. Living here, both import
 * the same functions. Dependency-free like `permissionPattern`: the contract
 * types satisfy these shapes structurally.
 */

/** The fields of an approval request the subject reads. */
export interface ApprovalSubjectSource {
  readonly toolName: string;
  readonly input: unknown;
}

/** The fields of a question the subject reads. */
export interface QuestionSubjectSource {
  readonly question: string;
  readonly header?: string | undefined;
}

/** The input keys that name what an approval is about, most telling first. */
const TARGET_KEYS = ["command", "path", "file_path", "filePath", "url", "query"] as const;

const firstLine = (text: string): string => text.split("\n", 1)[0]?.trim() ?? "";

/**
 * What an approval was for: the first non-empty target in its input, first
 * line only, and else the tool's name.
 */
export const approvalSubject = (request: ApprovalSubjectSource): string => {
  const input = request.input;
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    for (const key of TARGET_KEYS) {
      const value = record[key];
      if (typeof value === "string") {
        const line = firstLine(value);
        if (line.length > 0) {
          return line;
        }
      }
    }
  }
  return request.toolName;
};

/** What a question asked: the first question's header, else its text. */
export const questionSubject = (
  questions: ReadonlyArray<QuestionSubjectSource>,
): string | undefined => {
  const first = questions[0];
  if (first === undefined) {
    return undefined;
  }
  const header = first.header?.trim() ?? "";
  return header.length > 0 ? header : firstLine(first.question);
};

/** Which plan was answered: the plan file's name, when it has one. */
export const planSubject = (planPath: string | undefined): string | undefined => {
  if (planPath === undefined) {
    return undefined;
  }
  const name = planPath
    .split(/[\\/]/)
    .filter((part) => part.length > 0)
    .pop();
  return name === undefined || name.length === 0 ? undefined : name;
};

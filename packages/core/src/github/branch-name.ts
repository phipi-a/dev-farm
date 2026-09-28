const DEFAULT_PREFIX = "linear";
const DEFAULT_MAX_LENGTH = 200;

export interface BranchNameOptions {
  /** Namespace used before the issue identifier (for example, "linear"). */
  prefix?: string;
  /** Maximum complete ref length. Git supports 255-byte refs; 200 leaves room for callers. */
  maxLength?: number;
}

function cleanPart(value: string): string {
  // NFKD makes common accented characters deterministic before the ASCII filter.
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanPrefix(value: string): string {
  return value.split("/").map(cleanPart).filter(Boolean).join("/");
}

/**
 * Returns a conservative Git ref name for a Linear issue.
 *
 * Only lower-case ASCII, hyphens, and namespace slashes are emitted. Input
 * separators (including path traversal-looking strings) are treated as words,
 * never as Git ref syntax.
 */
export function generateBranchName(
  issueIdentifier: string,
  issueSlug: string,
  options: BranchNameOptions = {},
): string {
  if (typeof issueIdentifier !== "string" || !issueIdentifier.trim()) {
    throw new Error("issueIdentifier must not be empty");
  }

  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 255) {
    throw new Error("maxLength must be an integer between 1 and 255");
  }

  const identifier = cleanPart(issueIdentifier);
  if (!identifier) {
    throw new Error("issueIdentifier must contain at least one ASCII letter or number");
  }

  const prefix = cleanPrefix(options.prefix ?? DEFAULT_PREFIX);
  const base = prefix ? `${prefix}/${identifier}` : identifier;
  if (base.length > maxLength) {
    throw new Error("maxLength is too short for the issue identifier");
  }

  const slug = typeof issueSlug === "string" ? cleanPart(issueSlug) : "";
  const candidate = slug ? `${base}-${slug}` : base;
  // Truncate only the human-readable slug so the issue identity always remains.
  const branch = candidate.slice(0, maxLength).replace(/[-.]+$/, "");
  if (!branch || !isSafeBranchName(branch)) {
    throw new Error("generated branch name is not a safe Git ref");
  }
  return branch;
}

/** Alias that reads naturally at call sites handling an issue. */
export const branchNameForIssue = generateBranchName;

/**
 * Checks Git's ref-format rules needed at the provider boundary. Generated
 * names remain deliberately more conservative, while direct refs may use any
 * punctuation that Git permits.
 */
export function isSafeBranchName(name: string): boolean {
  if (typeof name !== "string" || !name || name.length > 255 || name.trim() !== name) {
    return false;
  }
  // These are forbidden by git-check-ref-format. Keep the check explicit so
  // direct provider inputs cannot smuggle control characters or ref syntax.
  if (
    /[\u0000-\u0020\u007f]/u.test(name) ||
    ["~", "^", ":", "?", "*", "[", "\\"].some((character) => name.includes(character))
  ) {
    return false;
  }
  if (
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.includes("..") ||
    name.includes("//") ||
    name.includes("@{") ||
    name === "@"
  ) {
    return false;
  }
  return name
    .split("/")
    .every(
      (part) =>
        part.length > 0 &&
        part !== "." &&
        part !== ".." &&
        !part.startsWith(".") &&
        !part.toLowerCase().endsWith(".lock"),
    );
}

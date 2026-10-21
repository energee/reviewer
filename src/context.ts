import { matchesGlob } from 'node:path';
import type { ReviewFile } from "./reviewer.js";

const MAX_LISTED_FILES = 5_000;
const MAX_INSTRUCTION_FILES = 32;
const MAX_INSTRUCTION_BYTES = 64 * 1024;
const INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md"];

type ContextOptions = {
  files: ReviewFile[];
  listFiles: () => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  excludePaths: string[];
};

type ReviewContext = {
  files: ReviewFile[];
  listFiles: () => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  instructions: string;
  limitations: string[];
};

function byteLength(value: string): number {
  return Buffer.byteLength(value);
}

function safePath(path: string): boolean {
  return path.length > 0
    && path.length <= 1024
    && !path.includes("\0")
    && !path.includes("\\")
    && !path.startsWith("/")
    && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function globMatches(pattern: string, path: string): boolean {
  return matchesGlob(path, pattern);
}

function customPatterns(excludePaths: string[]): string[] {
  const patterns = excludePaths.flatMap(value => value.split(/\r?\n/)).map(value => value.trim()).filter(Boolean);
  if (patterns.length > 100 || patterns.some(pattern => !safePath(pattern) || pattern.startsWith('!'))) {
    throw new Error('exclude-paths requires at most 100 repository-relative globs; absolute, traversal, and negated patterns are not supported');
  }
  return patterns;
}

function isSensitivePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (path === ".git" || path.startsWith(".git/")) return true;
  if (name === ".env") return true;
  if (name.startsWith(".env.") && name !== ".env.example" && name !== ".env.sample") return true;
  return globMatches("*.pem", name)
    || globMatches("*.key", name)
    || globMatches("*.p12", name)
    || globMatches("*.pfx", name)
    || name === "credentials.json"
    || globMatches("service-account*.json", name);
}

function parentPaths(path: string): string[] {
  const parts = path.split("/");
  const parents = [""];
  for (let index = 1; index < parts.length; index++) parents.push(parts.slice(0, index).join("/"));
  return parents;
}

function clampText(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && byteLength(value.slice(0, end)) > maxBytes) end--;
  return value.slice(0, end);
}

export async function createContext({ files, listFiles, readFile, excludePaths }: ContextOptions): Promise<ReviewContext> {
  const limitations: string[] = [];
  const patterns = customPatterns(excludePaths);
  const isExcluded = (path: string): boolean => isSensitivePath(path) || patterns.some((pattern) => globMatches(pattern, path));
  const changed = new Set<string>();
  let excludedChanged = 0;

  for (const file of files) {
    if (!safePath(file.path) || isExcluded(file.path)) {
      excludedChanged++;
    } else {
      changed.add(file.path);
    }
  }
  if (excludedChanged) limitations.push(`${excludedChanged} changed path(s) were excluded from review context.`);

  let listed: string[] = [];
  try {
    const raw = await listFiles();
    if (!Array.isArray(raw)) {
      limitations.push("Repository file listing was unavailable for review context.");
    } else {
      const allowed = new Set<string>();
      let invalidOrExcluded = 0;
      for (const path of raw) {
        if (typeof path !== "string" || !safePath(path) || isExcluded(path)) {
          invalidOrExcluded++;
          continue;
        }
        allowed.add(path);
      }
      if (invalidOrExcluded) limitations.push(`${invalidOrExcluded} repository path(s) were excluded from review context.`);
      const ordered = [...allowed].sort((left, right) => left.localeCompare(right));
      const prioritized = [...changed].sort((left, right) => left.localeCompare(right));
      const combined = new Set<string>(prioritized);
      for (const path of ordered) {
        if (combined.size >= MAX_LISTED_FILES) break;
        combined.add(path);
      }
      listed = [...combined];
      const allPaths = new Set([...allowed, ...changed]);
      if (allPaths.size > listed.length) limitations.push("The repository file list was truncated before review context tools used it.");
    }
  } catch {
    limitations.push("Repository file listing was unavailable for review context.");
    listed = [...changed].sort((left, right) => left.localeCompare(right)).slice(0, MAX_LISTED_FILES);
  }

  const listedPaths = new Set(listed);
  const contextFiles = files.filter((file) => safePath(file.path) && !isExcluded(file.path));
  const instructionCandidates = new Set<string>();
  for (const name of INSTRUCTION_NAMES) {
    if (listedPaths.has(name)) instructionCandidates.add(name);
  }
  for (const path of changed) {
    for (const parent of parentPaths(path)) {
      for (const name of INSTRUCTION_NAMES) {
        const candidate = parent ? `${parent}/${name}` : name;
        if (listedPaths.has(candidate)) instructionCandidates.add(candidate);
      }
    }
  }

  const instructionParts: string[] = [];
  let instructionBytes = 0;
  for (const path of [...instructionCandidates].sort((left, right) => left.localeCompare(right))) {
    if (instructionParts.length >= MAX_INSTRUCTION_FILES || instructionBytes >= MAX_INSTRUCTION_BYTES) {
      limitations.push("Repository instructions were truncated before review.");
      break;
    }
    try {
      const value = await readFile(path);
      if (typeof value !== "string") throw new Error("instruction is not text");
      const remaining = MAX_INSTRUCTION_BYTES - instructionBytes;
      const text = clampText(value, remaining);
      instructionParts.push(`--- ${path} ---\n${text}`);
      instructionBytes += byteLength(text);
      if (text.length !== value.length) limitations.push("Repository instructions were truncated before review.");
    } catch {
      limitations.push("One or more repository instructions could not be read.");
    }
  }

  const safeListFiles = (): Promise<string[]> => Promise.resolve([...listed]);
  const safeReadFile = async (path: string): Promise<string> => {
    if (!safePath(path) || isExcluded(path) || !listedPaths.has(path)) throw new Error("path is not available in review context");
    return readFile(path);
  };

  return {
    files: contextFiles,
    listFiles: safeListFiles,
    readFile: safeReadFile,
    instructions: instructionParts.join("\n\n"),
    limitations,
  };
}

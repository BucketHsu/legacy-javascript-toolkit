import * as path from "node:path";
import * as vscode from "vscode";

const JAVA_MARKER_FILES = ["pom.xml", "build.gradle"];
const WEB_DIRECTORIES = [
  "src/main/webapp",
  "src/main/resources/static",
  "src/main/resources/public",
  "src/main/resources/META-INF/resources",
  "WebRoot",
  "WebContent"
];

const INCLUDE_SUFFIXES = [
  ["src/main/resources/static", ["**/*.js"]],
  ["src/main/resources/public", ["**/*.js"]],
  ["src/main/resources/META-INF/resources", ["**/*.js"]],
  ["src/main/webapp", ["**/*.js", "**/*.jsp"]],
  ["WebRoot", ["**/*.js", "**/*.jsp"]],
  ["WebContent", ["**/*.js", "**/*.jsp"]],
  ["public", ["**/*.js"]],
  ["static", ["**/*.js"]],
  ["assets", ["**/*.js"]],
  ["js", ["**/*.js"]],
  ["script", ["**/*.js"]],
  ["scripts", ["**/*.js"]]
] as const;

const SKIPPED_DIRECTORIES = new Set([
  "node_modules", "target", "dist", "build", ".git", ".idea", ".vscode", "coverage"
]);

export interface ProjectDetection {
  isJavaWebProject: boolean;
  hasJsconfig: boolean;
  hasTsconfig: boolean;
  includes: string[];
}

export async function detectProject(folder: vscode.WorkspaceFolder): Promise<ProjectDetection> {
  const [hasJsconfig, hasTsconfig, hasBuildMarker, directories] = await Promise.all([
    exists(vscode.Uri.joinPath(folder.uri, "jsconfig.json")),
    exists(vscode.Uri.joinPath(folder.uri, "tsconfig.json")),
    hasAnyFile(folder.uri, JAVA_MARKER_FILES),
    discoverCandidateDirectories(folder.uri)
  ]);

  const includes = buildIncludes(directories);
  const hasWebDirectory = directories.some((directory) =>
    WEB_DIRECTORIES.some((candidate) => directory === candidate || directory.endsWith(`/${candidate}`))
  );

  return {
    isJavaWebProject: hasBuildMarker || hasWebDirectory,
    hasJsconfig,
    hasTsconfig,
    includes
  };
}

async function hasAnyFile(root: vscode.Uri, names: string[]): Promise<boolean> {
  for (const name of names) {
    if (await exists(vscode.Uri.joinPath(root, name))) {
      return true;
    }
  }
  return false;
}

async function discoverCandidateDirectories(root: vscode.Uri): Promise<string[]> {
  const found = new Set<string>();

  async function visit(directory: vscode.Uri, relative: string, depth: number): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(directory);
    } catch {
      return;
    }

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory || SKIPPED_DIRECTORIES.has(name)) {
        continue;
      }
      const childRelative = relative ? `${relative}/${name}` : name;
      const normalized = childRelative.replace(/\\/g, "/");
      const isCandidate = INCLUDE_SUFFIXES.some(([suffix]) =>
        normalized === suffix || normalized.endsWith(`/${suffix}`)
      );
      if (isCandidate) {
        found.add(normalized);
        continue;
      }
      if (depth < 5) {
        await visit(vscode.Uri.joinPath(directory, name), normalized, depth + 1);
      }
    }
  }

  await visit(root, "", 0);
  return [...found].sort();
}

function buildIncludes(directories: string[]): string[] {
  const includes: string[] = [];
  for (const directory of directories) {
    const match = INCLUDE_SUFFIXES.find(([suffix]) =>
      directory === suffix || directory.endsWith(`/${suffix}`)
    );
    if (!match) {
      continue;
    }
    for (const pattern of match[1]) {
      includes.push(path.posix.join(directory, pattern));
    }
  }
  return [...new Set(includes)];
}

export async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

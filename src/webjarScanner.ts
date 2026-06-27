import * as fs from "node:fs/promises";
import * as path from "node:path";
import AdmZip from "adm-zip";
import * as vscode from "vscode";
import { MavenArtifact, MavenDependencyResolver } from "./mavenDependencyResolver";

const TARGET_RESOURCE_GLOBS = [
  "**/target/classes/META-INF/resources/**/*.js",
  "**/target/classes/static/**/*.js",
  "**/target/classes/public/**/*.js",
  "**/target/classes/resources/**/*.js"
];
const TARGET_EXCLUDE = "{**/node_modules/**,**/dist/**,**/build/**,**/.git/**}";
const MAX_WEBJAR_FILE_SIZE = 2 * 1024 * 1024;
const MAX_DEPENDENCY_JAR_SIZE = 100 * 1024 * 1024;
const RESOURCE_ROOTS = [
  "META-INF/resources/webjars/",
  "META-INF/resources/",
  "static/",
  "public/",
  "resources/"
];

export interface WebjarFile {
  uri: vscode.Uri;
  webjarPath: string;
}

interface WebjarDependency {
  groupId: string;
  artifactId: string;
  version: string;
}

export class WebjarScanner {
  private readonly mavenResolver: MavenDependencyResolver;

  public constructor(
    private readonly cacheRoot: vscode.Uri,
    private readonly output: vscode.OutputChannel
  ) {
    this.mavenResolver = new MavenDependencyResolver(output);
  }

  public async scan(maxFiles: number, requestedPaths: ReadonlySet<string> = new Set()): Promise<WebjarFile[]> {
    const files = new Map<string, WebjarFile>();
    await this.scanTargetOutput(files, maxFiles);
    if (files.size >= maxFiles) {
      return [...files.values()];
    }

    const { artifacts } = await this.mavenResolver.resolveWorkspaceArtifacts();
    for (const artifact of artifacts) {
      if (files.size >= maxFiles) {
        break;
      }
      try {
        await this.scanArtifact(artifact, files, maxFiles, requestedPaths);
      } catch (error) {
        this.output.appendLine(
          `警告：無法掃描 Maven dependency ${artifact.groupId}:${artifact.artifactId}:${artifact.version}（${messageOf(error)}）`
        );
      }
    }
    return [...files.values()];
  }

  private async scanTargetOutput(files: Map<string, WebjarFile>, maxFiles: number): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const glob of TARGET_RESOURCE_GLOBS) {
        const matches = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, glob),
          TARGET_EXCLUDE,
          maxFiles - files.size
        );
        for (const uri of matches) {
          const webjarPath = toPublicResourcePath(uri.path);
          files.set(uri.toString(), { uri, webjarPath });
        }
        if (files.size >= maxFiles) return;
      }
    }
  }

  private async scanArtifact(
    artifact: MavenArtifact,
    files: Map<string, WebjarFile>,
    maxFiles: number,
    requestedPaths: ReadonlySet<string>
  ): Promise<void> {
    const requested = [...requestedPaths];
    if (requested.length > 0 && !shouldInspectArtifact(artifact, requested)) return;
    const stat = await fs.stat(artifact.jarPath);
    if (stat.size > MAX_DEPENDENCY_JAR_SIZE) {
      this.output.appendLine(`警告：略過超過 100 MB 的 Maven dependency JAR：${artifact.jarPath}`);
      return;
    }
    const zip = new AdmZip(artifact.jarPath);
    for (const entry of zip.getEntries()) {
      if (files.size >= maxFiles) {
        break;
      }
      const entryName = entry.entryName.replace(/\\/g, "/");
      const resource = getDependencyResourcePath(entryName);
      if (entry.isDirectory || !resource || !entryName.toLowerCase().endsWith(".js")) {
        continue;
      }
      if (requested.length > 0 && !requested.some((requestedPath) =>
        resourcePathMatches(requestedPath, resource.publicPath)
      )) {
        continue;
      }
      if (entry.header.size > MAX_WEBJAR_FILE_SIZE) {
        this.output.appendLine(`警告：略過過大的 WebJar JavaScript：${entryName}`);
        continue;
      }
      const cacheUri = vscode.Uri.joinPath(
        this.cacheRoot,
        "maven-resources",
        artifact.groupId,
        artifact.artifactId,
        artifact.version,
        ...resource.publicPath.split("/")
      );
      await vscode.workspace.fs.createDirectory(cacheUri.with({ path: path.posix.dirname(cacheUri.path) }));
      await vscode.workspace.fs.writeFile(cacheUri, entry.getData());
      files.set(cacheUri.toString(), { uri: cacheUri, webjarPath: resource.publicPath });
    }
  }
}

function shouldInspectArtifact(artifact: MavenArtifact, requestedPaths: string[]): boolean {
  if (artifact.groupId === "org.webjars" || artifact.groupId === "org.webjars.npm") {
    return requestedPaths.some((requestedPath) => {
      const parts = requestedPath.replace(/^\/+/, "").split("/");
      return parts[0] === "webjars" && parts[1]?.toLowerCase() === artifact.artifactId.toLowerCase();
    });
  }
  const needsClasspathResource = requestedPaths.some((requestedPath) =>
    !requestedPath.replace(/^\/+/, "").startsWith("webjars/")
  );
  return needsClasspathResource &&
    /(?:^|[-_.])(frontend|webapp|assets|static|ui|react|theme)(?:[-_.]|$)/i.test(artifact.artifactId);
}

function resourcePathMatches(requestedPath: string, candidatePath: string): boolean {
  const requested = requestedPath.replace(/^\/+/, "").split("/");
  const candidate = candidatePath.replace(/^\/+/, "").split("/");
  if (requested.join("/") === candidate.join("/")) return true;
  if (requested[0] !== "webjars" || candidate[0] !== "webjars" || requested[1] !== candidate[1]) {
    return false;
  }
  return candidate.slice(-(requested.length - 2)).join("/") === requested.slice(2).join("/");
}

export function parseWebjarDependencies(xml: string): WebjarDependency[] {
  const properties = new Map<string, string>();
  const propertiesBlock = /<properties>([\s\S]*?)<\/properties>/i.exec(xml)?.[1] ?? "";
  for (const match of propertiesBlock.matchAll(/<([\w.-]+)>\s*([^<]+?)\s*<\/\1>/g)) {
    properties.set(match[1], match[2].trim());
  }
  const projectVersion = firstTag(xml, "version");
  if (projectVersion) {
    properties.set("project.version", projectVersion);
    properties.set("pom.version", projectVersion);
  }

  const dependencies: WebjarDependency[] = [];
  for (const match of xml.matchAll(/<dependency>([\s\S]*?)<\/dependency>/gi)) {
    const block = match[1];
    const groupId = firstTag(block, "groupId") ?? "";
    if (groupId !== "org.webjars" && groupId !== "org.webjars.npm") {
      continue;
    }
    const artifactId = firstTag(block, "artifactId") ?? "";
    const rawVersion = firstTag(block, "version") ?? "";
    const version = resolveProperties(rawVersion, properties);
    if (artifactId && version && !version.includes("${")) {
      dependencies.push({ groupId, artifactId, version });
    }
  }
  return dependencies;
}

function firstTag(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`, "i").exec(xml)?.[1].trim();
}

function resolveProperties(value: string, properties: Map<string, string>): string {
  let resolved = value;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const next = resolved.replace(/\$\{([^}]+)}/g, (whole, name: string) => properties.get(name) ?? whole);
    if (next === resolved) {
      break;
    }
    resolved = next;
  }
  return resolved;
}

export function getDependencyResourcePath(entryName: string): { publicPath: string } | undefined {
  for (const root of RESOURCE_ROOTS) {
    if (!entryName.startsWith(root)) continue;
    const relative = entryName.slice(root.length);
    if (!relative || relative.includes("..")) return undefined;
    return {
      publicPath: root === "META-INF/resources/webjars/" ? `webjars/${relative}` : relative
    };
  }
  return undefined;
}

function toPublicResourcePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  for (const marker of [
    "/target/classes/META-INF/resources/webjars/",
    "/target/classes/META-INF/resources/",
    "/target/classes/static/",
    "/target/classes/public/",
    "/target/classes/resources/"
  ]) {
    const index = normalized.indexOf(marker);
    if (index < 0) continue;
    const relative = normalized.slice(index + marker.length);
    return marker.includes("/webjars/") ? `webjars/${relative}` : relative;
  }
  return normalized;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

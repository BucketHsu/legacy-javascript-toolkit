import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import AdmZip from "adm-zip";
import * as vscode from "vscode";

const TARGET_WEBJAR_GLOB = "**/target/classes/META-INF/resources/webjars/**/*.js";
const TARGET_EXCLUDE = "{**/node_modules/**,**/dist/**,**/build/**,**/.git/**}";
const MAX_WEBJAR_FILE_SIZE = 2 * 1024 * 1024;

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
  public constructor(
    private readonly cacheRoot: vscode.Uri,
    private readonly output: vscode.OutputChannel
  ) {}

  public async scan(maxFiles: number): Promise<WebjarFile[]> {
    const files = new Map<string, WebjarFile>();
    await this.scanTargetOutput(files, maxFiles);
    if (files.size >= maxFiles) {
      return [...files.values()];
    }

    const dependencies = await this.findDependencies();
    const repository = process.env.M2_REPO || path.join(os.homedir(), ".m2", "repository");
    for (const dependency of dependencies) {
      if (files.size >= maxFiles) {
        break;
      }
      try {
        await this.scanDependency(repository, dependency, files, maxFiles);
      } catch (error) {
        this.output.appendLine(
          `警告：無法掃描 WebJar ${dependency.groupId}:${dependency.artifactId}:${dependency.version}（${messageOf(error)}）`
        );
      }
    }
    return [...files.values()];
  }

  private async scanTargetOutput(files: Map<string, WebjarFile>, maxFiles: number): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const matches = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, TARGET_WEBJAR_GLOB),
        TARGET_EXCLUDE,
        maxFiles - files.size
      );
      for (const uri of matches) {
        const webjarPath = toWebjarPath(uri.path);
        files.set(uri.toString(), { uri, webjarPath });
      }
    }
  }

  private async findDependencies(): Promise<WebjarDependency[]> {
    const result = new Map<string, WebjarDependency>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const poms = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, "**/pom.xml"),
        "{**/target/**,**/node_modules/**,**/.git/**}",
        300
      );
      for (const pom of poms) {
        try {
          const xml = Buffer.from(await vscode.workspace.fs.readFile(pom)).toString("utf8");
          for (const dependency of parseWebjarDependencies(xml)) {
            result.set(`${dependency.groupId}:${dependency.artifactId}:${dependency.version}`, dependency);
          }
        } catch (error) {
          this.output.appendLine(`警告：無法解析 ${pom.fsPath} 的 WebJar dependency（${messageOf(error)}）`);
        }
      }
    }
    return [...result.values()];
  }

  private async scanDependency(
    repository: string,
    dependency: WebjarDependency,
    files: Map<string, WebjarFile>,
    maxFiles: number
  ): Promise<void> {
    const artifactDirectory = path.join(
      repository,
      ...dependency.groupId.split("."),
      dependency.artifactId,
      dependency.version
    );
    const expandedRoot = path.join(artifactDirectory, "META-INF", "resources", "webjars");
    if (await nodeExists(expandedRoot)) {
      await this.collectExpanded(expandedRoot, expandedRoot, files, maxFiles);
    }
    if (files.size >= maxFiles) {
      return;
    }

    const jarPath = path.join(artifactDirectory, `${dependency.artifactId}-${dependency.version}.jar`);
    if (!(await nodeExists(jarPath))) {
      return;
    }
    const zip = new AdmZip(jarPath);
    for (const entry of zip.getEntries()) {
      if (files.size >= maxFiles) {
        break;
      }
      const entryName = entry.entryName.replace(/\\/g, "/");
      const marker = "META-INF/resources/webjars/";
      if (entry.isDirectory || !entryName.startsWith(marker) || !entryName.toLowerCase().endsWith(".js")) {
        continue;
      }
      if (entry.header.size > MAX_WEBJAR_FILE_SIZE) {
        this.output.appendLine(`警告：略過過大的 WebJar JavaScript：${entryName}`);
        continue;
      }
      const relative = entryName.slice(marker.length);
      const cacheUri = vscode.Uri.joinPath(
        this.cacheRoot,
        "webjars",
        dependency.groupId,
        dependency.artifactId,
        dependency.version,
        ...relative.split("/")
      );
      await vscode.workspace.fs.createDirectory(cacheUri.with({ path: path.posix.dirname(cacheUri.path) }));
      await vscode.workspace.fs.writeFile(cacheUri, entry.getData());
      files.set(cacheUri.toString(), { uri: cacheUri, webjarPath: `webjars/${relative}` });
    }
  }

  private async collectExpanded(
    root: string,
    directory: string,
    files: Map<string, WebjarFile>,
    maxFiles: number
  ): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files.size >= maxFiles) {
        return;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await this.collectExpanded(root, absolute, files, maxFiles);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".js")) {
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        const uri = vscode.Uri.file(absolute);
        files.set(uri.toString(), { uri, webjarPath: `webjars/${relative}` });
      }
    }
  }
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

function toWebjarPath(value: string): string {
  const marker = "/META-INF/resources/webjars/";
  const index = value.indexOf(marker);
  return index >= 0 ? `webjars/${value.slice(index + marker.length)}` : value;
}

async function nodeExists(value: string): Promise<boolean> {
  try {
    await fs.stat(value);
    return true;
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

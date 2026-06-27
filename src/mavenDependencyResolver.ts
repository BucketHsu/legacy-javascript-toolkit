import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const MAX_MAVEN_ARTIFACTS = 600;

export interface MavenCoordinate {
  groupId: string;
  artifactId: string;
  version: string;
}

export interface MavenArtifact extends MavenCoordinate {
  jarPath: string;
  pomPath?: string;
}

interface RawDependency extends MavenCoordinate {
  scope?: string;
  type?: string;
  optional?: string;
}

interface RawPom {
  filePath: string;
  groupId?: string;
  artifactId: string;
  version?: string;
  parent?: MavenCoordinate & { relativePath?: string };
  properties: Map<string, string>;
  dependencyManagement: RawDependency[];
  dependencies: RawDependency[];
}

interface EffectivePom {
  coordinate: MavenCoordinate;
  properties: Map<string, string>;
  dependencyManagement: Map<string, string>;
  dependencies: RawDependency[];
}

/**
 * Resolves the locally available Maven dependency graph without invoking Maven
 * or downloading artifacts. Parent POMs, dependencyManagement and imported BOMs
 * are followed on a best-effort basis.
 */
export class MavenDependencyResolver {
  private readonly rawPomCache = new Map<string, RawPom>();
  private readonly effectivePomCache = new Map<string, EffectivePom | undefined>();

  public constructor(private readonly output: vscode.OutputChannel) {}

  public async resolveWorkspaceArtifacts(): Promise<{ repository: string; artifacts: MavenArtifact[] }> {
    this.rawPomCache.clear();
    this.effectivePomCache.clear();
    const repository = await this.findLocalRepository();
    const workspacePoms = await this.findWorkspacePoms();
    const queue: MavenCoordinate[] = [];
    const resourceGroups = new Set<string>();
    const workspaceDependencies: RawDependency[] = [];

    for (const pomPath of workspacePoms) {
      const effective = await this.loadEffectivePom(pomPath, repository, new Set());
      if (effective) {
        if (effective.coordinate.groupId) resourceGroups.add(effective.coordinate.groupId);
        workspaceDependencies.push(...effective.dependencies.filter(isRuntimeDependency));
      }
    }
    for (const dependency of workspaceDependencies) {
      if (isResourceHint(dependency)) resourceGroups.add(dependency.groupId);
    }
    queue.push(...workspaceDependencies.filter((dependency) => shouldFollowDependency(dependency, resourceGroups)));

    const artifacts = new Map<string, MavenArtifact>();
    const visited = new Set<string>();
    while (queue.length > 0 && visited.size < MAX_MAVEN_ARTIFACTS) {
      const unresolved = queue.shift();
      if (!unresolved) break;
      const coordinate = normalizeCoordinate(unresolved);
      if (!coordinate) continue;
      const key = coordinateKey(coordinate);
      if (visited.has(key)) continue;
      visited.add(key);

      const located = await locateArtifact(repository, coordinate);
      if (!located) continue;
      if (located.jarPath) {
        artifacts.set(key, { ...coordinate, jarPath: located.jarPath, pomPath: located.pomPath });
      }
      if (located.pomPath) {
        const effective = await this.loadEffectivePom(located.pomPath, repository, new Set());
        if (effective) {
          queue.push(...effective.dependencies.filter((dependency) =>
            isRuntimeDependency(dependency) && shouldFollowDependency(dependency, resourceGroups)
          ));
        }
      }
    }

    if (visited.size >= MAX_MAVEN_ARTIFACTS) {
      this.output.appendLine(`警告：Maven dependency 數量超過 ${MAX_MAVEN_ARTIFACTS}，已停止繼續解析。`);
    }
    this.output.appendLine(`Maven local repository：${repository}；已解析 ${artifacts.size} 個本機 dependency JAR。`);
    return { repository, artifacts: [...artifacts.values()] };
  }

  private async findWorkspacePoms(): Promise<string[]> {
    const result: string[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const poms = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, "**/pom.xml"),
        "{**/target/**,**/node_modules/**,**/.git/**}",
        300
      );
      result.push(...poms.map((uri) => uri.fsPath));
    }
    return result;
  }

  private async findLocalRepository(): Promise<string> {
    const configured = vscode.workspace.getConfiguration("legacyJavaScriptToolkit")
      .get<string>("mavenRepository", "").trim();
    if (configured) {
      return expandHomeAndEnvironment(configured);
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const configPath = path.join(folder.uri.fsPath, ".mvn", "maven.config");
      const config = await readTextIfExists(configPath);
      const match = config && /-Dmaven\.repo\.local=(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(config);
      const value = match?.[1] ?? match?.[2] ?? match?.[3];
      if (value) {
        const expanded = expandHomeAndEnvironment(value);
        return path.isAbsolute(expanded) ? expanded : path.resolve(folder.uri.fsPath, expanded);
      }
    }

    const environmentRepository = process.env.MAVEN_REPO_LOCAL || process.env.M2_REPO;
    if (environmentRepository) {
      return expandHomeAndEnvironment(environmentRepository);
    }

    const settingsPath = path.join(os.homedir(), ".m2", "settings.xml");
    const settings = await readTextIfExists(settingsPath);
    const settingsRepository = settings ? tagValue(settings, "localRepository") : undefined;
    return settingsRepository
      ? expandHomeAndEnvironment(settingsRepository)
      : path.join(os.homedir(), ".m2", "repository");
  }

  private async loadEffectivePom(
    pomPath: string,
    repository: string,
    loading: Set<string>
  ): Promise<EffectivePom | undefined> {
    const normalizedPath = path.resolve(pomPath);
    if (this.effectivePomCache.has(normalizedPath)) {
      return this.effectivePomCache.get(normalizedPath);
    }
    if (loading.has(normalizedPath)) return undefined;
    loading.add(normalizedPath);

    try {
      const raw = await this.loadRawPom(normalizedPath);
      let parent: EffectivePom | undefined;
      if (raw.parent) {
        const parentPath = await this.resolveParentPomPath(raw, repository);
        if (parentPath) parent = await this.loadEffectivePom(parentPath, repository, loading);
      }

      const properties = new Map(parent?.properties ?? []);
      for (const [name, value] of raw.properties) properties.set(name, value);
      const groupId = resolveValue(raw.groupId ?? parent?.coordinate.groupId ?? raw.parent?.groupId ?? "", properties);
      const version = resolveValue(raw.version ?? parent?.coordinate.version ?? raw.parent?.version ?? "", properties);
      const artifactId = resolveValue(raw.artifactId, properties);
      setProjectProperties(properties, { groupId, artifactId, version }, raw.parent);
      resolvePropertyMap(properties);

      const dependencyManagement = new Map(parent?.dependencyManagement ?? []);
      const managementEntries = raw.dependencyManagement.map((dependency) => resolveDependency(dependency, properties));
      for (const dependency of managementEntries) {
        if (dependency.scope === "import" && (dependency.type ?? "jar") === "pom") {
          const bomPath = (await locateArtifact(repository, dependency))?.pomPath;
          if (bomPath) {
            const bom = await this.loadEffectivePom(bomPath, repository, loading);
            for (const [key, managedVersion] of bom?.dependencyManagement ?? []) {
              if (!dependencyManagement.has(key)) dependencyManagement.set(key, managedVersion);
            }
          }
        } else if (dependency.version) {
          dependencyManagement.set(dependencyKey(dependency), dependency.version);
        }
      }

      const dependencies = raw.dependencies.map((dependency) => {
        const resolved = resolveDependency(dependency, properties);
        if (!resolved.version) {
          resolved.version = dependencyManagement.get(dependencyKey(resolved)) ?? "";
        }
        return resolved;
      }).filter((dependency) => Boolean(dependency.groupId && dependency.artifactId && dependency.version));

      const effective: EffectivePom = {
        coordinate: { groupId, artifactId, version },
        properties,
        dependencyManagement,
        dependencies
      };
      this.effectivePomCache.set(normalizedPath, effective);
      return effective;
    } catch (error) {
      this.output.appendLine(`警告：無法解析 Maven POM：${normalizedPath}（${messageOf(error)}）`);
      this.effectivePomCache.set(normalizedPath, undefined);
      return undefined;
    } finally {
      loading.delete(normalizedPath);
    }
  }

  private async loadRawPom(pomPath: string): Promise<RawPom> {
    const cached = this.rawPomCache.get(pomPath);
    if (cached) return cached;
    const xml = stripComments(await fs.readFile(pomPath, "utf8"));
    const parsed = parseRawPom(xml, pomPath);
    this.rawPomCache.set(pomPath, parsed);
    return parsed;
  }

  private async resolveParentPomPath(raw: RawPom, repository: string): Promise<string | undefined> {
    if (!raw.parent) return undefined;
    if (raw.parent.relativePath !== "") {
      const relativePath = raw.parent.relativePath ?? "../pom.xml";
      const localPath = path.resolve(path.dirname(raw.filePath), relativePath);
      if (await fileExists(localPath)) return localPath;
    }
    return (await locateArtifact(repository, raw.parent))?.pomPath;
  }
}

export function parseRawPom(xml: string, filePath = "pom.xml"): RawPom {
  const parentBlock = blockValue(xml, "parent");
  const relativePathMatch = parentBlock && /<relativePath\s*(?:\/\s*>|>\s*([^<]*)<\/relativePath>)/i.exec(parentBlock);
  const parent = parentBlock ? {
    groupId: tagValue(parentBlock, "groupId") ?? "",
    artifactId: tagValue(parentBlock, "artifactId") ?? "",
    version: tagValue(parentBlock, "version") ?? "",
    relativePath: relativePathMatch ? (relativePathMatch[1] ?? "").trim() : undefined
  } : undefined;

  const withoutParent = parentBlock ? xml.replace(/<parent>[\s\S]*?<\/parent>/i, "") : xml;
  const header = withoutParent.split(/<(?:properties|dependencyManagement|dependencies|build|modules|profiles)\b/i, 1)[0];
  const properties = new Map<string, string>();
  const propertiesBlock = blockValue(xml, "properties") ?? "";
  for (const match of propertiesBlock.matchAll(/<([\w.-]+)>\s*([\s\S]*?)\s*<\/\1>/g)) {
    properties.set(match[1], decodeXml(match[2].trim()));
  }

  const managementBlock = blockValue(xml, "dependencyManagement") ?? "";
  const xmlWithoutManagement = xml.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/gi, "");
  const dependenciesBlock = blockValue(xmlWithoutManagement, "dependencies") ?? "";
  return {
    filePath,
    groupId: tagValue(header, "groupId"),
    artifactId: tagValue(header, "artifactId") ?? path.basename(path.dirname(filePath)),
    version: tagValue(header, "version"),
    parent,
    properties,
    dependencyManagement: parseDependencies(managementBlock),
    dependencies: parseDependencies(dependenciesBlock)
  };
}

async function locateArtifact(
  repository: string,
  coordinate: MavenCoordinate
): Promise<{ pomPath?: string; jarPath?: string } | undefined> {
  if (!coordinate.groupId || !coordinate.artifactId || !coordinate.version) return undefined;
  const directory = path.join(repository, ...coordinate.groupId.split("."), coordinate.artifactId, coordinate.version);
  if (!(await fileExists(directory))) return undefined;
  const baseName = `${coordinate.artifactId}-${coordinate.version}`;
  const canonicalPom = path.join(directory, `${baseName}.pom`);
  const canonicalJar = path.join(directory, `${baseName}.jar`);
  let pomPath = await fileExists(canonicalPom) ? canonicalPom : undefined;
  let jarPath = await fileExists(canonicalJar) ? canonicalJar : undefined;

  if ((!pomPath || !jarPath) && coordinate.version.endsWith("-SNAPSHOT")) {
    const entries = await fs.readdir(directory).catch(() => [] as string[]);
    const prefix = `${coordinate.artifactId}-${coordinate.version.slice(0, -"SNAPSHOT".length)}`;
    pomPath ??= selectSnapshotFile(entries, prefix, ".pom", directory);
    jarPath ??= selectSnapshotFile(entries, prefix, ".jar", directory);
  }
  return pomPath || jarPath ? { pomPath, jarPath } : undefined;
}

function parseDependencies(xml: string): RawDependency[] {
  const dependencies: RawDependency[] = [];
  for (const match of xml.matchAll(/<dependency>([\s\S]*?)<\/dependency>/gi)) {
    const block = match[1];
    dependencies.push({
      groupId: tagValue(block, "groupId") ?? "",
      artifactId: tagValue(block, "artifactId") ?? "",
      version: tagValue(block, "version") ?? "",
      scope: tagValue(block, "scope"),
      type: tagValue(block, "type"),
      optional: tagValue(block, "optional")
    });
  }
  return dependencies;
}

function resolveDependency(dependency: RawDependency, properties: Map<string, string>): RawDependency {
  return {
    groupId: resolveValue(dependency.groupId, properties),
    artifactId: resolveValue(dependency.artifactId, properties),
    version: resolveValue(dependency.version, properties),
    scope: dependency.scope ? resolveValue(dependency.scope, properties) : undefined,
    type: dependency.type ? resolveValue(dependency.type, properties) : undefined,
    optional: dependency.optional ? resolveValue(dependency.optional, properties) : undefined
  };
}

function setProjectProperties(
  properties: Map<string, string>,
  coordinate: MavenCoordinate,
  parent?: MavenCoordinate
): void {
  properties.set("project.groupId", coordinate.groupId);
  properties.set("pom.groupId", coordinate.groupId);
  properties.set("project.artifactId", coordinate.artifactId);
  properties.set("pom.artifactId", coordinate.artifactId);
  properties.set("project.version", coordinate.version);
  properties.set("pom.version", coordinate.version);
  if (parent) {
    properties.set("project.parent.groupId", parent.groupId);
    properties.set("project.parent.version", parent.version);
  }
}

function resolvePropertyMap(properties: Map<string, string>): void {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let changed = false;
    for (const [name, value] of properties) {
      const resolved = resolveValue(value, properties);
      if (resolved !== value) {
        properties.set(name, resolved);
        changed = true;
      }
    }
    if (!changed) break;
  }
}

function resolveValue(value: string, properties: Map<string, string>): string {
  let resolved = value.trim();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const next = resolved.replace(/\$\{([^}]+)}/g, (whole, name: string) => properties.get(name) ?? whole);
    if (next === resolved) break;
    resolved = next;
  }
  return resolved;
}

function normalizeCoordinate(coordinate: MavenCoordinate): MavenCoordinate | undefined {
  const groupId = coordinate.groupId.trim();
  const artifactId = coordinate.artifactId.trim();
  const version = coordinate.version.trim();
  if (!groupId || !artifactId || !version || version.includes("${")) return undefined;
  return { groupId, artifactId, version };
}

function isRuntimeDependency(dependency: RawDependency): boolean {
  const scope = dependency.scope ?? "compile";
  const type = dependency.type ?? "jar";
  return dependency.optional !== "true" &&
    type !== "pom" &&
    scope !== "test" &&
    scope !== "provided" &&
    scope !== "system" &&
    scope !== "import";
}

function shouldFollowDependency(dependency: RawDependency, resourceGroups: Set<string>): boolean {
  return resourceGroups.has(dependency.groupId) ||
    dependency.groupId === "org.webjars" ||
    dependency.groupId === "org.webjars.npm" ||
    isResourceHint(dependency);
}

function isResourceHint(dependency: Pick<MavenCoordinate, "groupId" | "artifactId">): boolean {
  return dependency.groupId === "org.webjars" ||
    dependency.groupId === "org.webjars.npm" ||
    /(?:^|[-_.])(frontend|webapp|webjar|assets|static|ui|react|theme)(?:[-_.]|$)/i.test(dependency.artifactId);
}

function dependencyKey(coordinate: Pick<MavenCoordinate, "groupId" | "artifactId">): string {
  return `${coordinate.groupId}:${coordinate.artifactId}`;
}

function coordinateKey(coordinate: MavenCoordinate): string {
  return `${coordinate.groupId}:${coordinate.artifactId}:${coordinate.version}`;
}

function selectSnapshotFile(entries: string[], prefix: string, extension: string, directory: string): string | undefined {
  const candidates = entries.filter((entry) =>
    entry.startsWith(prefix) &&
    entry.endsWith(extension) &&
    !/(?:-sources|-javadoc|-tests|-frontend-sources)\.(?:jar|pom)$/i.test(entry)
  ).sort().reverse();
  return candidates[0] ? path.join(directory, candidates[0]) : undefined;
}

function blockValue(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml)?.[1];
}

function tagValue(xml: string, name: string): string | undefined {
  const value = new RegExp(`<${name}(?:\\s[^>]*)?>\\s*([^<]*?)\\s*</${name}>`, "i").exec(xml)?.[1];
  return value === undefined ? undefined : decodeXml(value.trim());
}

function stripComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, "");
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function expandHomeAndEnvironment(value: string): string {
  let expanded = value.trim();
  if (expanded === "~" || expanded.startsWith(`~${path.sep}`) || expanded.startsWith("~/")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  expanded = expanded.replace(/\$\{env\.([^}]+)}/gi, (whole, name: string) => process.env[name] ?? whole);
  expanded = expanded.replace(/\$\{user\.home}/gi, os.homedir());
  expanded = expanded.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
  return path.normalize(expanded);
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

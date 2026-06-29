import * as vscode from "vscode";
import { StylesheetReferenceScanner } from "./stylesheetReferenceScanner";
import { WebjarScanner } from "./webjarScanner";

const STYLESHEET_GLOB = "**/*.css";
const MAX_STYLESHEET_SIZE = 2 * 1024 * 1024;

export type CssClassSourceType = "project" | "stylesheet-src" | "dependency";

export interface CssClassDefinition {
  name: string;
  uri: vscode.Uri;
  range: vscode.Range;
  selectionRange: vscode.Range;
  ruleText: string;
  sourceType: CssClassSourceType;
}

export interface CssClassIndexStatus {
  cssFilesCount: number;
  classesCount: number;
  dependencyFilesCount: number;
  lastIndexedTime?: Date;
  truncated: boolean;
  indexing: boolean;
}

export class CssClassIndexer implements vscode.Disposable {
  private readonly definitionsByUri = new Map<string, CssClassDefinition[]>();
  private readonly definitionsByName = new Map<string, CssClassDefinition[]>();
  private readonly watchers: vscode.Disposable[] = [];
  private rebuildPromise?: Promise<CssClassIndexStatus>;
  private status: CssClassIndexStatus = {
    cssFilesCount: 0,
    classesCount: 0,
    dependencyFilesCount: 0,
    truncated: false,
    indexing: false
  };

  public constructor(
    private readonly webjarScanner: WebjarScanner,
    private readonly referenceScanner: StylesheetReferenceScanner,
    private readonly output: vscode.OutputChannel
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher(STYLESHEET_GLOB);
    this.watchers.push(
      watcher,
      watcher.onDidCreate((uri) => void this.updateFile(uri)),
      watcher.onDidChange((uri) => void this.updateFile(uri)),
      watcher.onDidDelete((uri) => this.removeFile(uri))
    );
  }

  public dispose(): void {
    for (const watcher of this.watchers) watcher.dispose();
  }

  public rebuild(): Promise<CssClassIndexStatus> {
    if (this.rebuildPromise) return this.rebuildPromise;
    this.rebuildPromise = this.performRebuild().finally(() => {
      this.rebuildPromise = undefined;
    });
    return this.rebuildPromise;
  }

  public getStatus(): CssClassIndexStatus {
    return { ...this.status };
  }

  public findDefinitions(name: string, fromUri?: vscode.Uri): CssClassDefinition[] {
    const definitions = [...(this.definitionsByName.get(name) ?? [])];
    return definitions.sort((left, right) => {
      if (fromUri && left.uri.toString() === fromUri.toString()) return -1;
      if (fromUri && right.uri.toString() === fromUri.toString()) return 1;
      return sourcePriority(left.sourceType) - sourcePriority(right.sourceType);
    });
  }

  private async performRebuild(): Promise<CssClassIndexStatus> {
    const started = Date.now();
    const configuration = vscode.workspace.getConfiguration("legacyJavaScriptToolkit");
    const maxFiles = Math.max(50, configuration.get<number>("maxStylesheetFilesToIndex", 1500));
    const exclude = toCombinedGlob(configuration.get<string[]>("excludeGlobs", []));
    const projectUris: vscode.Uri[] = [];
    this.status = { cssFilesCount: 0, classesCount: 0, dependencyFilesCount: 0, truncated: false, indexing: true };
    this.output.appendLine("開始建立 CSS class index。");

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const remaining = maxFiles + 1 - projectUris.length;
      if (remaining <= 0) break;
      projectUris.push(...await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, STYLESHEET_GLOB),
        exclude,
        remaining
      ));
    }
    const truncated = projectUris.length > maxFiles;
    if (truncated) {
      projectUris.length = maxFiles;
      this.output.appendLine(`警告：CSS 檔案數量超過上限 ${maxFiles}，本次只索引前 ${maxFiles} 個檔案。`);
    }

    const references = await this.referenceScanner.scan();
    const referencedUris = new Set(
      references.flatMap((reference) => reference.resolvedUri ? [reference.resolvedUri.toString()] : [])
    );
    const requestedPaths = new Set(
      references.flatMap((reference) => reference.dependencyPath ? [reference.dependencyPath] : [])
    );
    const includeDependencies = configuration.get<boolean>("includeWebjars", true);
    const dependencyFiles = includeDependencies
      ? await this.webjarScanner.scanStylesheets(Math.max(0, maxFiles - projectUris.length), requestedPaths)
      : [];

    const nextByUri = new Map<string, CssClassDefinition[]>();
    await runInBatches(projectUris, 8, async (uri) => {
      const sourceType: CssClassSourceType = referencedUris.has(uri.toString()) ? "stylesheet-src" : "project";
      const parsed = await this.parseUri(uri, sourceType);
      if (parsed) nextByUri.set(uri.toString(), parsed);
    });
    await runInBatches(dependencyFiles, 4, async (file) => {
      const parsed = await this.parseUri(file.uri, "dependency");
      if (parsed) nextByUri.set(file.uri.toString(), parsed);
    });

    this.definitionsByUri.clear();
    for (const [uri, definitions] of nextByUri) this.definitionsByUri.set(uri, definitions);
    this.rebuildLookup();
    this.status = {
      cssFilesCount: projectUris.length,
      classesCount: [...this.definitionsByUri.values()].reduce((count, values) => count + values.length, 0),
      dependencyFilesCount: dependencyFiles.length,
      lastIndexedTime: new Date(),
      truncated,
      indexing: false
    };
    this.output.appendLine(
      `CSS class 索引完成：${projectUris.length} 個專案 CSS、${this.status.classesCount} 個 class 定義、` +
      `${dependencyFiles.length} 個 dependency CSS，耗時 ${Date.now() - started} ms。`
    );
    return this.getStatus();
  }

  private async updateFile(uri: vscode.Uri): Promise<void> {
    const sourceType = this.definitionsByUri.get(uri.toString())?.[0]?.sourceType ?? "project";
    const parsed = await this.parseUri(uri, sourceType);
    if (parsed) this.definitionsByUri.set(uri.toString(), parsed);
    this.rebuildLookup();
    this.status.classesCount = [...this.definitionsByUri.values()].reduce((count, values) => count + values.length, 0);
    this.status.lastIndexedTime = new Date();
  }

  private removeFile(uri: vscode.Uri): void {
    this.definitionsByUri.delete(uri.toString());
    this.rebuildLookup();
    this.status.classesCount = [...this.definitionsByUri.values()].reduce((count, values) => count + values.length, 0);
    this.status.lastIndexedTime = new Date();
  }

  private rebuildLookup(): void {
    this.definitionsByName.clear();
    for (const definition of [...this.definitionsByUri.values()].flat()) {
      const values = this.definitionsByName.get(definition.name) ?? [];
      values.push(definition);
      this.definitionsByName.set(definition.name, values);
    }
  }

  private async parseUri(
    uri: vscode.Uri,
    sourceType: CssClassSourceType
  ): Promise<CssClassDefinition[] | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_STYLESHEET_SIZE) {
        this.output.appendLine(`警告：略過超過 2 MB 的 CSS 檔案：${uri.fsPath}`);
        return [];
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\u0000")) throw new Error("檔案含有 NUL 字元，可能不是 UTF-8");
      return parseCssClassDefinitions(uri, text, sourceType);
    } catch (error) {
      this.output.appendLine(`警告：略過無法讀取或解析的 CSS：${uri.fsPath}（${messageOf(error)}）`);
      return undefined;
    }
  }
}

export function parseCssClassDefinitions(
  uri: vscode.Uri,
  text: string,
  sourceType: CssClassSourceType
): CssClassDefinition[] {
  const definitions: CssClassDefinition[] = [];
  const lineStarts = buildLineStarts(text);

  const parseRegion = (start: number, end: number): void => {
    let statementStart = start;
    let index = start;
    while (index < end) {
      const skipped = skipCssTrivia(text, index, end);
      if (skipped !== index) {
        index = skipped;
        continue;
      }
      if (text[index] === ";") {
        statementStart = index + 1;
        index += 1;
        continue;
      }
      if (text[index] !== "{") {
        index += 1;
        continue;
      }

      const close = findMatchingBrace(text, index, end);
      if (close < 0) break;
      const preludeStart = skipWhitespace(text, statementStart, index);
      const prelude = text.slice(preludeStart, index);
      if (prelude && !prelude.trimStart().startsWith("@")) {
        const maskedPrelude = maskCssTrivia(prelude);
        const classPattern = /(?<!\\)\.(-?[_a-zA-Z][\w-]*)/g;
        let match: RegExpExecArray | null;
        while ((match = classPattern.exec(maskedPrelude)) !== null) {
          const name = match[1];
          const selectionStart = preludeStart + match.index + 1;
          definitions.push({
            name,
            uri,
            range: toRange(lineStarts, preludeStart, close + 1),
            selectionRange: toRange(lineStarts, selectionStart, selectionStart + name.length),
            ruleText: text.slice(preludeStart, close + 1).trim(),
            sourceType
          });
        }
      }
      // Descend into at-rules and CSS nesting while ignoring ordinary declarations.
      parseRegion(index + 1, close);
      index = close + 1;
      statementStart = index;
    }
  };

  parseRegion(0, text.length);
  const seen = new Set<string>();
  return definitions.filter((definition) => {
    const key = `${definition.name}:${definition.selectionRange.start.line}:${definition.selectionRange.start.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function skipCssTrivia(text: string, index: number, end: number): number {
  if (text.startsWith("/*", index)) {
    const close = text.indexOf("*/", index + 2);
    return close < 0 || close + 2 > end ? end : close + 2;
  }
  const quote = text[index];
  if (quote !== "\"" && quote !== "'") return index;
  for (let cursor = index + 1; cursor < end; cursor += 1) {
    if (text[cursor] === "\\") cursor += 1;
    else if (text[cursor] === quote) return cursor + 1;
  }
  return end;
}

function findMatchingBrace(text: string, open: number, end: number): number {
  let depth = 1;
  for (let index = open + 1; index < end; index += 1) {
    const skipped = skipCssTrivia(text, index, end);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

function maskCssTrivia(value: string): string {
  const result = value.split("");
  for (let index = 0; index < value.length;) {
    const skipped = skipCssTrivia(value, index, value.length);
    if (skipped === index) {
      index += 1;
      continue;
    }
    for (let cursor = index; cursor < skipped; cursor += 1) result[cursor] = " ";
    index = skipped;
  }
  return result.join("");
}

function skipWhitespace(text: string, start: number, end: number): number {
  let index = start;
  while (index < end && /\s/.test(text[index])) index += 1;
  return index;
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function toRange(lineStarts: number[], start: number, end: number): vscode.Range {
  const startPoint = positionAt(lineStarts, start);
  const endPoint = positionAt(lineStarts, end);
  return new vscode.Range(startPoint.line, startPoint.character, endPoint.line, endPoint.character);
}

function positionAt(lineStarts: number[], offset: number): { line: number; character: number } {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] > offset) high = middle;
    else low = middle + 1;
  }
  const line = Math.max(0, low - 1);
  return { line, character: offset - lineStarts[line] };
}

function sourcePriority(sourceType: CssClassSourceType): number {
  if (sourceType === "stylesheet-src") return 0;
  if (sourceType === "project") return 1;
  return 2;
}

function toCombinedGlob(patterns: string[]): string | undefined {
  const valid = patterns.map((pattern) => pattern.trim()).filter(Boolean);
  if (valid.length === 0) return undefined;
  return valid.length === 1 ? valid[0] : `{${valid.join(",")}}`;
}

async function runInBatches<T>(items: T[], size: number, task: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map(task));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import * as path from "node:path";
import * as ts from "typescript";
import * as vscode from "vscode";
import { ScriptReferenceScanner } from "./scriptReferenceScanner";
import { WebjarFile, WebjarScanner } from "./webjarScanner";

const JAVASCRIPT_GLOB = "**/*.{js,jsx,ts,tsx}";
const MAX_SOURCE_FILE_SIZE = 2 * 1024 * 1024;

export type FunctionSourceType = "project" | "script-src" | "webjar" | "generated" | "typings";

export interface FunctionDefinition {
  name: string;
  fullName: string;
  uri: vscode.Uri;
  range: vscode.Range;
  selectionRange: vscode.Range;
  parameters: string[];
  jsdoc?: string;
  sourceType: FunctionSourceType;
}

export interface JavaScriptIndexStatus {
  workspaceRoots: string[];
  jsFilesCount: number;
  functionsCount: number;
  webjarFilesCount: number;
  lastIndexedTime?: Date;
  truncated: boolean;
  indexing: boolean;
}

export class JavaScriptIndexer implements vscode.Disposable {
  private definitions: FunctionDefinition[] = [];
  private readonly definitionsByUri = new Map<string, FunctionDefinition[]>();
  private readonly definitionsByName = new Map<string, FunctionDefinition[]>();
  private readonly scriptOrderByDocument = new Map<string, Map<string, number>>();
  private status: JavaScriptIndexStatus = {
    workspaceRoots: [],
    jsFilesCount: 0,
    functionsCount: 0,
    webjarFilesCount: 0,
    truncated: false,
    indexing: false
  };
  private rebuildPromise: Promise<JavaScriptIndexStatus> | undefined;
  private readonly watchers: vscode.Disposable[] = [];
  private updateTimer: NodeJS.Timeout | undefined;
  private readonly pendingUpdates = new Map<string, vscode.Uri>();

  public constructor(
    private readonly webjarScanner: WebjarScanner,
    private readonly scriptScanner: ScriptReferenceScanner,
    private readonly output: vscode.OutputChannel
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher(JAVASCRIPT_GLOB);
    this.watchers.push(
      watcher,
      watcher.onDidCreate((uri) => this.queueUpdate(uri)),
      watcher.onDidChange((uri) => this.queueUpdate(uri)),
      watcher.onDidDelete((uri) => this.removeFile(uri))
    );
  }

  public dispose(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
  }

  public async rebuild(): Promise<JavaScriptIndexStatus> {
    if (this.rebuildPromise) {
      return this.rebuildPromise;
    }
    this.rebuildPromise = this.performRebuild().finally(() => {
      this.rebuildPromise = undefined;
    });
    return this.rebuildPromise;
  }

  public getStatus(): JavaScriptIndexStatus {
    return {
      ...this.status,
      workspaceRoots: [...this.status.workspaceRoots]
    };
  }

  public findDefinitions(name: string, fullName?: string, fromUri?: vscode.Uri): FunctionDefinition[] {
    if (fullName && fullName.includes(".")) {
      const exact = this.definitions.filter((definition) => definition.fullName === fullName);
      if (exact.length > 0) {
        return this.sortForDocument(exact, fromUri);
      }
    }
    return this.sortForDocument([...(this.definitionsByName.get(name) ?? [])], fromUri);
  }

  private async performRebuild(): Promise<JavaScriptIndexStatus> {
    const started = Date.now();
    const configuration = vscode.workspace.getConfiguration("legacyJavaScriptToolkit");
    const maxFiles = Math.max(100, configuration.get<number>("maxFilesToIndex", 3000));
    const excludeGlobs = configuration.get<string[]>("excludeGlobs", []);
    const exclude = toCombinedGlob(excludeGlobs);
    const projectUris: vscode.Uri[] = [];

    this.status = {
      workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      jsFilesCount: 0,
      functionsCount: 0,
      webjarFilesCount: 0,
      truncated: false,
      indexing: true
    };
    this.output.appendLine("開始建立 JavaScript function index。");

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const remaining = maxFiles + 1 - projectUris.length;
      if (remaining <= 0) {
        break;
      }
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, JAVASCRIPT_GLOB),
        exclude,
        remaining
      );
      projectUris.push(...uris);
    }

    const truncated = projectUris.length > maxFiles;
    if (truncated) {
      projectUris.length = maxFiles;
      this.output.appendLine(`警告：JavaScript 檔案數量超過上限 ${maxFiles}，本次只索引前 ${maxFiles} 個檔案。`);
      void vscode.window.showWarningMessage(
        `Legacy JavaScript Toolkit：JavaScript 檔案超過索引上限 ${maxFiles}，請調整設定或排除不需要的資料夾。`
      );
    }

    const scriptReferences = await this.scriptScanner.scan();
    const scriptUris = new Set(
      scriptReferences.flatMap((reference) => reference.resolvedUri ? [reference.resolvedUri.toString()] : [])
    );
    const includeWebjars = configuration.get<boolean>("includeWebjars", true);
    const webjarFiles = includeWebjars
      ? await this.webjarScanner.scan(Math.max(0, maxFiles - projectUris.length))
      : [];
    this.rebuildScriptOrder(scriptReferences, webjarFiles);

    const nextByUri = new Map<string, FunctionDefinition[]>();
    await runInBatches(projectUris, 8, async (uri) => {
      const sourceType = classifyProjectSource(uri, scriptUris);
      const parsed = await this.parseUri(uri, sourceType);
      if (parsed) {
        nextByUri.set(uri.toString(), parsed);
      }
    });
    await runInBatches(webjarFiles, 4, async (file) => {
      const parsed = await this.parseUri(file.uri, "webjar");
      if (parsed) {
        nextByUri.set(file.uri.toString(), parsed);
      }
    });

    this.definitionsByUri.clear();
    for (const [uri, values] of nextByUri) {
      this.definitionsByUri.set(uri, values);
    }
    this.rebuildLookup();
    this.status = {
      workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      jsFilesCount: projectUris.length,
      functionsCount: this.definitions.length,
      webjarFilesCount: webjarFiles.length,
      lastIndexedTime: new Date(),
      truncated,
      indexing: false
    };
    this.output.appendLine(
      `索引完成：${projectUris.length} 個專案檔案、${this.definitions.length} 個 function、${webjarFiles.length} 個 WebJar 檔案，耗時 ${Date.now() - started} ms。`
    );
    return this.getStatus();
  }

  private queueUpdate(uri: vscode.Uri): void {
    this.pendingUpdates.set(uri.toString(), uri);
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }
    this.updateTimer = setTimeout(() => {
      const updates = [...this.pendingUpdates.values()];
      this.pendingUpdates.clear();
      void this.updateFiles(updates);
    }, 500);
  }

  private async updateFiles(uris: vscode.Uri[]): Promise<void> {
    for (const uri of uris) {
      const existingSourceType = this.definitionsByUri.get(uri.toString())?.[0]?.sourceType;
      const sourceType = existingSourceType ?? (uri.path.endsWith(".d.ts") ? "typings" : "project");
      const parsed = await this.parseUri(uri, sourceType);
      if (parsed) {
        this.definitionsByUri.set(uri.toString(), parsed);
      }
    }
    this.rebuildLookup();
    this.status.functionsCount = this.definitions.length;
    this.status.lastIndexedTime = new Date();
  }

  private removeFile(uri: vscode.Uri): void {
    this.definitionsByUri.delete(uri.toString());
    this.rebuildLookup();
    this.status.functionsCount = this.definitions.length;
    this.status.lastIndexedTime = new Date();
  }

  private rebuildLookup(): void {
    this.definitions = [...this.definitionsByUri.values()].flat();
    this.definitionsByName.clear();
    for (const definition of this.definitions) {
      const values = this.definitionsByName.get(definition.name) ?? [];
      values.push(definition);
      this.definitionsByName.set(definition.name, values);
    }
  }

  private rebuildScriptOrder(
    references: Awaited<ReturnType<ScriptReferenceScanner["scan"]>>,
    webjarFiles: WebjarFile[]
  ): void {
    this.scriptOrderByDocument.clear();
    for (const reference of references) {
      let target = reference.resolvedUri;
      if (!target && reference.webjarPath) {
        target = webjarFiles.find((file) => webjarReferenceMatches(reference.webjarPath ?? "", file.webjarPath))?.uri;
      }
      if (!target) {
        continue;
      }
      const order = this.scriptOrderByDocument.get(reference.documentUri.toString()) ?? new Map<string, number>();
      order.set(target.toString(), reference.order);
      this.scriptOrderByDocument.set(reference.documentUri.toString(), order);
    }
  }

  private sortForDocument(definitions: FunctionDefinition[], fromUri?: vscode.Uri): FunctionDefinition[] {
    if (!fromUri) {
      return definitions;
    }
    const sourceOrder = this.scriptOrderByDocument.get(fromUri.toString());
    return definitions.sort((left, right) => {
      if (left.uri.toString() === fromUri.toString()) return -1;
      if (right.uri.toString() === fromUri.toString()) return 1;
      const leftOrder = sourceOrder?.get(left.uri.toString()) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = sourceOrder?.get(right.uri.toString()) ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return sourcePriority(left.sourceType) - sourcePriority(right.sourceType);
    });
  }

  private async parseUri(uri: vscode.Uri, sourceType: FunctionSourceType): Promise<FunctionDefinition[] | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_SOURCE_FILE_SIZE) {
        this.output.appendLine(`警告：略過超過 2 MB 的 JavaScript 檔案：${uri.fsPath}`);
        return [];
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\u0000")) {
        throw new Error("檔案含有 NUL 字元，可能不是 UTF-8");
      }
      return parseFunctionDefinitions(uri, text, sourceType);
    } catch (error) {
      this.output.appendLine(`警告：略過無法讀取或解析的檔案：${uri.fsPath}（${messageOf(error)}）`);
      return undefined;
    }
  }
}

export function parseFunctionDefinitions(
  uri: vscode.Uri,
  text: string,
  sourceType: FunctionSourceType
): FunctionDefinition[] {
  const sourceFile = ts.createSourceFile(
    uri.fsPath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(uri.fsPath)
  );
  const definitions: FunctionDefinition[] = [];

  const addDefinition = (
    name: string,
    fullName: string,
    node: ts.Node,
    selectionNode: ts.Node,
    parameters: readonly ts.ParameterDeclaration[],
    documentationNode: ts.Node = node
  ): void => {
    if (!name) {
      return;
    }
    definitions.push({
      name,
      fullName,
      uri,
      range: toRange(sourceFile, node.getStart(sourceFile), node.getEnd()),
      selectionRange: toRange(sourceFile, selectionNode.getStart(sourceFile), selectionNode.getEnd()),
      parameters: parameters.map((parameter) => parameter.getText(sourceFile)),
      jsdoc: extractJsDoc(sourceFile, documentationNode),
      sourceType
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      addDefinition(node.name.text, node.name.text, node, node.name, node.parameters, node);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isFunctionLikeInitializer(node.initializer)) {
      const documentationNode = findAncestor(node, ts.isVariableStatement) ?? node;
      addDefinition(node.name.text, node.name.text, node, node.name, node.initializer.parameters, documentationNode);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isFunctionLikeInitializer(node.right)
    ) {
      const fullName = expressionName(node.left, sourceFile);
      const name = lastNamePart(fullName);
      const documentationNode = findAncestor(node, ts.isExpressionStatement) ?? node;
      addDefinition(name, fullName, node, node.left, node.right.parameters, documentationNode);
    } else if (ts.isMethodDeclaration(node) && node.name) {
      const name = propertyName(node.name, sourceFile);
      const prefix = methodOwnerName(node, sourceFile);
      addDefinition(name, prefix ? `${prefix}.${name}` : name, node, node.name, node.parameters, node);
    } else if (
      ts.isPropertyAssignment(node) &&
      node.name &&
      isFunctionLikeInitializer(node.initializer)
    ) {
      const name = propertyName(node.name, sourceFile);
      const prefix = objectLiteralOwnerName(node.parent, sourceFile);
      addDefinition(name, prefix ? `${prefix}.${name}` : name, node, node.name, node.initializer.parameters, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return deduplicateDefinitions(definitions);
}

function isFunctionLikeInitializer(
  node: ts.Expression | undefined
): node is ts.FunctionExpression | ts.ArrowFunction {
  return Boolean(node && (ts.isFunctionExpression(node) || ts.isArrowFunction(node)));
}

function methodOwnerName(node: ts.MethodDeclaration, sourceFile: ts.SourceFile): string {
  if (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent)) {
    return node.parent.name?.text ?? "";
  }
  if (ts.isObjectLiteralExpression(node.parent)) {
    return objectLiteralOwnerName(node.parent, sourceFile);
  }
  return "";
}

function objectLiteralOwnerName(node: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile): string {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent)) {
    const outer = ts.isObjectLiteralExpression(parent.parent)
      ? objectLiteralOwnerName(parent.parent, sourceFile)
      : "";
    const current = propertyName(parent.name, sourceFile);
    return outer ? `${outer}.${current}` : current;
  }
  if (ts.isBinaryExpression(parent) && parent.right === node) {
    return expressionName(parent.left, sourceFile);
  }
  return "";
}

function expressionName(node: ts.Expression, sourceFile: ts.SourceFile): string {
  if (ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword) {
    return node.getText(sourceFile);
  }
  if (ts.isPropertyAccessExpression(node)) {
    const left = expressionName(node.expression, sourceFile);
    return left ? `${left}.${node.name.text}` : node.name.text;
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const argument = node.argumentExpression;
    if (ts.isStringLiteral(argument) || ts.isNumericLiteral(argument)) {
      const left = expressionName(node.expression, sourceFile);
      return left ? `${left}.${argument.text}` : argument.text;
    }
  }
  return node.getText(sourceFile).replace(/\s+/g, "");
}

function propertyName(node: ts.PropertyName, sourceFile: ts.SourceFile): string {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return node.getText(sourceFile).replace(/^\[|\]$/g, "");
}

function extractJsDoc(sourceFile: ts.SourceFile, node: ts.Node): string | undefined {
  const leading = sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile));
  const match = /\/\*\*([\s\S]*?)\*\/\s*$/.exec(leading);
  if (!match) {
    return undefined;
  }
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\* ?/, "").trimEnd())
    .join("\n")
    .trim();
}

function findAncestor<T extends ts.Node>(
  node: ts.Node,
  predicate: (candidate: ts.Node) => candidate is T
): T | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (predicate(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function toRange(sourceFile: ts.SourceFile, start: number, end: number): vscode.Range {
  const startPoint = sourceFile.getLineAndCharacterOfPosition(start);
  const endPoint = sourceFile.getLineAndCharacterOfPosition(end);
  return new vscode.Range(startPoint.line, startPoint.character, endPoint.line, endPoint.character);
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".ts")) return ts.ScriptKind.TS;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function lastNamePart(value: string): string {
  const parts = value.split(".");
  return parts[parts.length - 1] ?? value;
}

function deduplicateDefinitions(definitions: FunctionDefinition[]): FunctionDefinition[] {
  const seen = new Set<string>();
  return definitions.filter((definition) => {
    const key = `${definition.fullName}:${definition.selectionRange.start.line}:${definition.selectionRange.start.character}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function classifyProjectSource(uri: vscode.Uri, scriptUris: Set<string>): FunctionSourceType {
  if (uri.path.endsWith(".d.ts")) {
    return "typings";
  }
  if (scriptUris.has(uri.toString())) {
    return "script-src";
  }
  const normalized = uri.path.toLowerCase();
  if (normalized.includes("/generated/") || normalized.includes("/target/generated-")) {
    return "generated";
  }
  return "project";
}

function webjarReferenceMatches(reference: string, candidate: string): boolean {
  const expected = reference.replace(/^\/+/, "").split("/");
  const actual = candidate.replace(/^\/+/, "").split("/");
  if (expected.join("/") === actual.join("/")) {
    return true;
  }
  if (expected.length < 3 || actual.length < expected.length) {
    return false;
  }
  return expected[0] === actual[0] &&
    expected[1] === actual[1] &&
    actual.slice(-(expected.length - 2)).join("/") === expected.slice(2).join("/");
}

function sourcePriority(sourceType: FunctionSourceType): number {
  switch (sourceType) {
    case "script-src": return 0;
    case "project": return 1;
    case "typings": return 2;
    case "generated": return 3;
    case "webjar": return 4;
  }
}

function toCombinedGlob(patterns: string[]): string | undefined {
  const valid = patterns.map((pattern) => pattern.trim()).filter(Boolean);
  if (valid.length === 0) {
    return undefined;
  }
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

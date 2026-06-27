import * as path from "node:path";
import * as vscode from "vscode";
import { exists } from "./projectDetector";

const DOCUMENT_GLOB = "**/*.{html,htm,jsp,jspx,tag,tagx}";
const DEFAULT_EXCLUDE = "{**/node_modules/**,**/target/**,**/dist/**,**/build/**,**/.git/**}";

export interface ScriptReference {
  documentUri: vscode.Uri;
  source: string;
  order: number;
  resolvedUri?: vscode.Uri;
  webjarPath?: string;
}

export class ScriptReferenceScanner {
  public constructor(private readonly output: vscode.OutputChannel) {}

  public async scan(maxDocuments = 2000): Promise<ScriptReference[]> {
    const references: ScriptReference[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const documents = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, DOCUMENT_GLOB),
        DEFAULT_EXCLUDE,
        maxDocuments
      );
      for (const documentUri of documents) {
        try {
          const bytes = await vscode.workspace.fs.readFile(documentUri);
          const text = decodeUtf8(bytes, documentUri);
          const sources = extractScriptSources(text);
          for (let order = 0; order < sources.length; order += 1) {
            references.push(await this.resolve(folder, documentUri, sources[order], order));
          }
        } catch (error) {
          this.output.appendLine(`警告：無法掃描 script src：${documentUri.fsPath}（${messageOf(error)}）`);
        }
      }
    }
    return references;
  }

  private async resolve(
    folder: vscode.WorkspaceFolder,
    documentUri: vscode.Uri,
    source: string,
    order: number
  ): Promise<ScriptReference> {
    const cleanSource = source.split(/[?#]/, 1)[0].replace(/\\/g, "/");
    const reference: ScriptReference = { documentUri, source, order };

    if (/^\/webjars\//i.test(cleanSource)) {
      reference.webjarPath = cleanSource.replace(/^\/+/, "");
      return reference;
    }
    if (!cleanSource || /^(?:https?:)?\/\//i.test(cleanSource) || /^(?:data|javascript):/i.test(cleanSource)) {
      return reference;
    }
    if (/[<%]|\$\{/.test(cleanSource)) {
      return reference;
    }

    if (!cleanSource.startsWith("/")) {
      const candidate = vscode.Uri.joinPath(documentUri, "..", ...cleanSource.split("/"));
      if (await exists(candidate)) {
        reference.resolvedUri = candidate;
        return reference;
      }
    }

    const suffix = cleanSource.replace(/^\/+/, "");
    if (!suffix || suffix.includes("..")) {
      return reference;
    }
    const matches = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, `**/${escapeGlobPath(suffix)}`),
      DEFAULT_EXCLUDE,
      20
    );
    reference.resolvedUri = selectBestMatch(matches, documentUri, suffix);
    return reference;
  }
}

export function extractScriptSources(text: string): string[] {
  const sources: string[] = [];
  const scriptPattern = /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(text)) !== null) {
    sources.push(match[2].trim());
  }
  return sources;
}

function decodeUtf8(bytes: Uint8Array, uri: vscode.Uri): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\u0000")) {
    throw new Error(`檔案可能不是 UTF-8：${uri.fsPath}`);
  }
  return text;
}

function selectBestMatch(matches: vscode.Uri[], documentUri: vscode.Uri, suffix: string): vscode.Uri | undefined {
  const pageDirectory = path.dirname(documentUri.fsPath);
  return matches.sort((left, right) => {
    const leftScore = commonPrefixLength(pageDirectory, left.fsPath) + (left.path.endsWith(suffix) ? 1000 : 0);
    const rightScore = commonPrefixLength(pageDirectory, right.fsPath) + (right.path.endsWith(suffix) ? 1000 : 0);
    return rightScore - leftScore;
  })[0];
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function escapeGlobPath(value: string): string {
  return value.replace(/[\[\]{}*?]/g, (character) => `[${character}]`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

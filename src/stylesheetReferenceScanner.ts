import * as path from "node:path";
import * as vscode from "vscode";
import { exists } from "./projectDetector";

const DOCUMENT_GLOB = "**/*.{html,htm,jsp,jspx,tag,tagx}";
const DEFAULT_EXCLUDE = "{**/node_modules/**,**/target/**,**/dist/**,**/build/**,**/.git/**}";

export interface StylesheetReference {
  documentUri: vscode.Uri;
  source: string;
  order: number;
  resolvedUri?: vscode.Uri;
  dependencyPath?: string;
}

export class StylesheetReferenceScanner {
  public constructor(private readonly output: vscode.OutputChannel) {}

  public async scan(maxDocuments = 2000): Promise<StylesheetReference[]> {
    const references: StylesheetReference[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const documents = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, DOCUMENT_GLOB),
        DEFAULT_EXCLUDE,
        maxDocuments
      );
      for (const documentUri of documents) {
        try {
          const text = new TextDecoder("utf-8", { fatal: true })
            .decode(await vscode.workspace.fs.readFile(documentUri));
          if (text.includes("\u0000")) throw new Error("檔案含有 NUL 字元，可能不是 UTF-8");
          const sources = extractStylesheetSources(text);
          for (let order = 0; order < sources.length; order += 1) {
            references.push(await this.resolve(folder, documentUri, sources[order], order));
          }
        } catch (error) {
          this.output.appendLine(`警告：無法掃描 stylesheet href：${documentUri.fsPath}（${messageOf(error)}）`);
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
  ): Promise<StylesheetReference> {
    const cleanSource = source.split(/[?#]/, 1)[0].replace(/\\/g, "/");
    const reference: StylesheetReference = { documentUri, source, order };
    if (!cleanSource || /^(?:https?:)?\/\//i.test(cleanSource) || /^(?:data|javascript):/i.test(cleanSource)) {
      return reference;
    }
    if (/[<%]|\$\{/.test(cleanSource)) return reference;

    if (!cleanSource.startsWith("/")) {
      const candidate = vscode.Uri.joinPath(documentUri, "..", ...cleanSource.split("/"));
      if (await exists(candidate)) {
        reference.resolvedUri = candidate;
        return reference;
      }
    }

    const suffix = cleanSource.replace(/^\/+/, "");
    if (!suffix || suffix.includes("..")) return reference;
    const matches = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, `**/${escapeGlobPath(suffix)}`),
      DEFAULT_EXCLUDE,
      20
    );
    reference.resolvedUri = selectBestMatch(matches, documentUri, suffix);
    if (!reference.resolvedUri) reference.dependencyPath = suffix;
    return reference;
  }
}

export function extractStylesheetSources(text: string): string[] {
  const sources: string[] = [];
  const linkPattern = /<link\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(text)) !== null) {
    const attributes = match[1];
    const rel = /(?:^|\s)rel\s*=\s*(["'])(.*?)\1/i.exec(attributes)?.[2]?.trim().toLowerCase();
    const nativeSource = /(?:^|\s)href\s*=\s*(["'])(.*?)\1/i.exec(attributes)?.[2]?.trim();
    const thymeleafSource = /(?:^|\s)th:href\s*=\s*(["'])(.*?)\1/i.exec(attributes)?.[2]?.trim();
    const staticSource = thymeleafSource && /^@\{([^${}]+)}$/.exec(thymeleafSource)?.[1];
    const source = staticSource ?? nativeSource;
    if (source && (rel?.split(/\s+/).includes("stylesheet") || /\.css(?:[?#]|$)/i.test(source))) {
      sources.push(source);
    }
  }
  return sources;
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
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

function escapeGlobPath(value: string): string {
  return value.replace(/[\[\]{}*?]/g, (character) => `[${character}]`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

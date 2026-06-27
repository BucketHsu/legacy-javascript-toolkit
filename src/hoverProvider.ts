import * as vscode from "vscode";
import { FunctionDefinition, JavaScriptIndexer } from "./javascriptIndexer";
import { symbolAt } from "./navigationProvider";

export class JSDocHoverProvider implements vscode.HoverProvider {
  public constructor(private readonly indexer: JavaScriptIndexer) {}

  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    if (!vscode.workspace.getConfiguration("legacyJavaScriptToolkit").get<boolean>("enableNavigation", true)) {
      return undefined;
    }
    const symbol = symbolAt(document, position);
    if (!symbol) {
      return undefined;
    }
    const definitions = this.indexer.findDefinitions(symbol.name, symbol.fullName, document.uri);
    if (definitions.length === 0) {
      return undefined;
    }

    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = false;
    const displayed = definitions.slice(0, 8);
    displayed.forEach((definition, index) => {
      if (index > 0) {
        markdown.appendMarkdown("\n\n---\n\n");
      }
      appendDefinition(markdown, definition);
    });
    if (definitions.length > displayed.length) {
      markdown.appendMarkdown(`\n\n另有 ${definitions.length - displayed.length} 個同名候選位置。`);
    }
    return new vscode.Hover(markdown, symbol.range);
  }
}

function appendDefinition(markdown: vscode.MarkdownString, definition: FunctionDefinition): void {
  markdown.appendCodeblock(`${definition.fullName}(${definition.parameters.join(", ")})`, "javascript");
  if (definition.jsdoc) {
    const { summary, tags } = splitJsDoc(definition.jsdoc);
    if (summary) {
      markdown.appendMarkdown(`${escapeMarkdown(summary).replace(/\n/g, "  \n")}\n\n`);
    }
    for (const tag of tags) {
      markdown.appendMarkdown(`- ${formatTag(tag)}\n`);
    }
    if (tags.length > 0) {
      markdown.appendMarkdown("\n");
    }
  }
  const source = vscode.workspace.asRelativePath(definition.uri, false).replace(/\\/g, "/");
  markdown.appendMarkdown(
    `來源：\`${escapeInlineCode(source)}:${definition.selectionRange.start.line + 1}\` ` +
    `（${definition.sourceType}）`
  );
}

function splitJsDoc(jsdoc: string): { summary: string; tags: string[] } {
  const summary: string[] = [];
  const tags: string[] = [];
  let currentTag = "";
  for (const line of jsdoc.split(/\r?\n/)) {
    if (line.trimStart().startsWith("@")) {
      if (currentTag) tags.push(currentTag);
      currentTag = line.trim();
    } else if (currentTag && line.trim()) {
      currentTag += ` ${line.trim()}`;
    } else if (!currentTag) {
      summary.push(line);
    }
  }
  if (currentTag) tags.push(currentTag);
  return { summary: summary.join("\n").trim(), tags };
}

function formatTag(tag: string): string {
  const match = /^@(param|returns?|return)\b\s*(.*)$/i.exec(tag);
  if (!match) {
    return `\`${escapeInlineCode(tag)}\``;
  }
  const label = match[1].toLowerCase().startsWith("param") ? "@param" : "@returns";
  return `\`${label}\` ${escapeMarkdown(match[2])}`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+.!>|-])/g, "\\$1");
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, "\\`");
}

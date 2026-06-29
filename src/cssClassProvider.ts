import * as vscode from "vscode";
import { CssClassDefinition, CssClassIndexer } from "./cssClassIndexer";

export interface CssClassReference {
  name: string;
  range: vscode.Range;
}

export class CssClassDefinitionProvider implements vscode.DefinitionProvider {
  public constructor(private readonly indexer: CssClassIndexer) {}

  public provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.DefinitionLink[]> {
    if (!isEnabled()) return undefined;
    const reference = cssClassReferenceAt(document, position);
    if (!reference) return undefined;
    const definitions = this.indexer.findDefinitions(reference.name, document.uri);
    if (definitions.length === 0) return undefined;
    return definitions.map((definition) => ({
      originSelectionRange: reference.range,
      targetUri: definition.uri,
      targetRange: definition.range,
      targetSelectionRange: definition.selectionRange
    }));
  }
}

export class CssClassHoverProvider implements vscode.HoverProvider {
  public constructor(private readonly indexer: CssClassIndexer) {}

  public provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
    if (!isEnabled()) return undefined;
    const reference = cssClassReferenceAt(document, position);
    if (!reference) return undefined;
    const definitions = this.indexer.findDefinitions(reference.name, document.uri);
    if (definitions.length === 0) return undefined;

    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = false;
    definitions.slice(0, 6).forEach((definition, index) => {
      if (index > 0) markdown.appendMarkdown("\n\n---\n\n");
      appendDefinition(markdown, definition);
    });
    if (definitions.length > 6) markdown.appendMarkdown(`\n\n另有 ${definitions.length - 6} 個同名 class 定義。`);
    return new vscode.Hover(markdown, reference.range);
  }
}

export function cssClassReferenceAt(document: vscode.TextDocument, position: vscode.Position): CssClassReference | undefined {
  const wordRange = document.getWordRangeAtPosition(position, /-?[_a-zA-Z][\w-]*/);
  if (!wordRange) return undefined;
  const line = document.lineAt(position.line).text;
  const start = wordRange.start.character;
  const end = wordRange.end.character;
  const name = document.getText(wordRange);

  if (isClassAttributeReference(line, start, end)) return { name, range: wordRange };
  if (!isScriptLanguage(document.languageId) || !quotedSpanAt(line, start)) return undefined;

  const prefix = line.slice(Math.max(0, start - 300), start);
  if (/\.classList\.(?:add|remove|toggle|contains|replace)\s*\([^)]*$/i.test(prefix) ||
      /\.getElementsByClassName\s*\([^)]*$/i.test(prefix) ||
      /\.setAttribute\s*\(\s*(["'])class\1\s*,[^)]*$/i.test(prefix)) {
    return { name, range: wordRange };
  }
  if (line[start - 1] === "." && /(?:querySelectorAll|querySelector|matches|closest|\$)\s*\([^)]*$/i.test(prefix)) {
    return { name, range: wordRange };
  }
  return undefined;
}

function isClassAttributeReference(line: string, start: number, end: number): boolean {
  const quoted = /(?:^|\s)(?:class|className)\s*=\s*(["'])(.*?)\1/gi;
  let match: RegExpExecArray | null;
  while ((match = quoted.exec(line)) !== null) {
    const quoteIndex = match.index + match[0].indexOf(match[1]);
    const valueStart = quoteIndex + 1;
    if (start >= valueStart && end <= valueStart + match[2].length) {
      return !insideDynamicExpression(match[2], start - valueStart);
    }
  }
  const unquoted = /(?:^|\s)(?:class|className)\s*=\s*([^\s>"']+)/gi;
  while ((match = unquoted.exec(line)) !== null) {
    const valueStart = match.index + match[0].lastIndexOf(match[1]);
    if (start >= valueStart && end <= valueStart + match[1].length) return true;
  }
  return false;
}

function insideDynamicExpression(value: string, offset: number): boolean {
  const before = value.slice(0, offset);
  return before.lastIndexOf("${") > before.lastIndexOf("}") || before.lastIndexOf("<%") > before.lastIndexOf("%>");
}

function quotedSpanAt(line: string, offset: number): boolean {
  let quote = "";
  let start = -1;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (!quote) {
      if (character === "\"" || character === "'" || character === "`") {
        quote = character;
        start = index;
      }
    } else if (character === "\\") {
      index += 1;
    } else if (character === quote) {
      if (offset > start && offset < index) return true;
      quote = "";
      start = -1;
    }
  }
  return Boolean(quote && offset > start);
}

function isScriptLanguage(languageId: string): boolean {
  return languageId === "javascript" || languageId === "javascriptreact" ||
    languageId === "typescript" || languageId === "typescriptreact";
}

function appendDefinition(markdown: vscode.MarkdownString, definition: CssClassDefinition): void {
  const rule = definition.ruleText.length > 2500 ? `${definition.ruleText.slice(0, 2500)}\n/* ... */` : definition.ruleText;
  markdown.appendCodeblock(rule, "css");
  const source = vscode.workspace.asRelativePath(definition.uri, false).replace(/\\/g, "/");
  markdown.appendMarkdown(`來源：\`${source.replace(/`/g, "\\`")}:${definition.selectionRange.start.line + 1}\`（${definition.sourceType}）`);
}

function isEnabled(): boolean {
  return vscode.workspace.getConfiguration("legacyJavaScriptToolkit").get<boolean>("enableCssClassNavigation", true);
}

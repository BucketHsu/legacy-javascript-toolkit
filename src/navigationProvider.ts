import * as vscode from "vscode";
import { JavaScriptIndexer } from "./javascriptIndexer";

export class NavigationProvider implements vscode.DefinitionProvider {
  public constructor(private readonly indexer: JavaScriptIndexer) {}

  public provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.DefinitionLink[]> {
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
    return definitions.map((definition) => ({
      originSelectionRange: symbol.range,
      targetUri: definition.uri,
      targetRange: definition.range,
      targetSelectionRange: definition.selectionRange
    }));
  }
}

export interface DocumentSymbolReference {
  name: string;
  fullName: string;
  range: vscode.Range;
}

export function symbolAt(
  document: vscode.TextDocument,
  position: vscode.Position
): DocumentSymbolReference | undefined {
  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_$][\w$]*/);
  if (!wordRange) {
    return undefined;
  }
  const name = document.getText(wordRange);
  const line = document.lineAt(position.line).text;
  const beforeEnd = line.slice(0, wordRange.end.character);
  const qualified = /([A-Za-z_$][\w$]*(?:(?:\.|\?\.)[A-Za-z_$][\w$]*)*)$/.exec(beforeEnd)?.[1] ?? name;
  const fullName = qualified.replace(/\?\./g, ".");
  const startCharacter = wordRange.end.character - qualified.length;
  return {
    name,
    fullName,
    range: new vscode.Range(position.line, Math.max(0, startCharacter), position.line, wordRange.end.character)
  };
}

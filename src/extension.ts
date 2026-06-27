import * as vscode from "vscode";
import { JSDocHoverProvider } from "./hoverProvider";
import { JavaScriptIndexer } from "./javascriptIndexer";
import { JsconfigManager } from "./jsconfigManager";
import { NavigationProvider } from "./navigationProvider";
import { exists } from "./projectDetector";
import { ScriptReferenceScanner } from "./scriptReferenceScanner";
import { WebjarScanner } from "./webjarScanner";

const LANGUAGE_SELECTOR: vscode.DocumentSelector = [
  { language: "javascript", scheme: "file" },
  { language: "javascriptreact", scheme: "file" },
  { language: "typescript", scheme: "file" },
  { language: "typescriptreact", scheme: "file" },
  { language: "html", scheme: "file" },
  { language: "jsp", scheme: "file" }
];

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Legacy JavaScript Toolkit");
  const jsconfigManager = new JsconfigManager(context, output);
  const scriptScanner = new ScriptReferenceScanner(output);
  const webjarScanner = new WebjarScanner(context.globalStorageUri, output);
  const indexer = new JavaScriptIndexer(webjarScanner, scriptScanner, output);

  context.subscriptions.push(
    output,
    indexer,
    vscode.languages.registerDefinitionProvider(LANGUAGE_SELECTOR, new NavigationProvider(indexer)),
    vscode.languages.registerHoverProvider(LANGUAGE_SELECTOR, new JSDocHoverProvider(indexer)),
    vscode.commands.registerCommand("legacyJavaScriptToolkit.createJsconfig", () => jsconfigManager.createFromCommand()),
    vscode.commands.registerCommand("legacyJavaScriptToolkit.resetJsconfigPrompt", () => jsconfigManager.resetPrompt()),
    vscode.commands.registerCommand("legacyJavaScriptToolkit.rebuildIndex", async () => {
      const status = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Legacy JavaScript Toolkit：正在重建 JavaScript 索引",
          cancellable: false
        },
        () => indexer.rebuild()
      );
      void vscode.window.showInformationMessage(
        `JavaScript 索引完成：${status.jsFilesCount} 個檔案、${status.functionsCount} 個 function、${status.webjarFilesCount} 個 WebJar 檔案。`
      );
    }),
    vscode.commands.registerCommand("legacyJavaScriptToolkit.showIndexStatus", async () => {
      await showIndexStatus(indexer, output);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("legacyJavaScriptToolkit.maxFilesToIndex") ||
        event.affectsConfiguration("legacyJavaScriptToolkit.excludeGlobs") ||
        event.affectsConfiguration("legacyJavaScriptToolkit.includeWebjars")
      ) {
        void indexer.rebuild();
      }
    })
  );

  const promptTimer = setTimeout(() => {
    void jsconfigManager.promptForEligibleProjects().catch((error) => {
      output.appendLine(`警告：jsconfig.json 偵測失敗（${messageOf(error)}）`);
    });
  }, 800);
  const indexTimer = setTimeout(() => {
    const enabled = vscode.workspace.getConfiguration("legacyJavaScriptToolkit").get<boolean>("enableNavigation", true);
    if (enabled && (vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
      void indexer.rebuild().catch((error) => {
        output.appendLine(`錯誤：JavaScript 索引建立失敗（${messageOf(error)}）`);
      });
    }
  }, 1500);
  context.subscriptions.push({
    dispose: () => {
      clearTimeout(promptTimer);
      clearTimeout(indexTimer);
    }
  });
}

export function deactivate(): void {}

async function showIndexStatus(indexer: JavaScriptIndexer, output: vscode.OutputChannel): Promise<void> {
  const status = indexer.getStatus();
  const folders = vscode.workspace.workspaceFolders ?? [];
  const jsconfigStates = await Promise.all(
    folders.map(async (folder) => ({
      name: folder.name,
      exists: await exists(vscode.Uri.joinPath(folder.uri, "jsconfig.json"))
    }))
  );
  const lines = [
    `Workspace root：${status.workspaceRoots.join(", ") || "未開啟 workspace"}`,
    `JS files count：${status.jsFilesCount}`,
    `Functions count：${status.functionsCount}`,
    `WebJar files count：${status.webjarFilesCount}`,
    `Last indexed time：${status.lastIndexedTime?.toLocaleString() ?? "尚未建立索引"}`,
    `Index state：${status.indexing ? "建立中" : "待命"}${status.truncated ? "（已達檔案上限）" : ""}`,
    `jsconfig.json：${jsconfigStates.length === 0 ? "不適用" : jsconfigStates.map((item) => `${item.name}=${item.exists ? "有" : "無"}`).join(", ")}`
  ];
  output.appendLine("");
  output.appendLine("JavaScript Index Status");
  for (const line of lines) output.appendLine(line);
  output.show(true);
  void vscode.window.showInformationMessage(
    `JavaScript 索引：${status.jsFilesCount} 個檔案、${status.functionsCount} 個 function、${status.webjarFilesCount} 個 WebJar 檔案。`
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

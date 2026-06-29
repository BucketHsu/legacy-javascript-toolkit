import * as vscode from "vscode";
import { CssClassIndexer, CssClassIndexStatus } from "./cssClassIndexer";
import { CssClassDefinitionProvider, CssClassHoverProvider } from "./cssClassProvider";
import { JSDocHoverProvider } from "./hoverProvider";
import { JavaScriptIndexer } from "./javascriptIndexer";
import { JsconfigManager } from "./jsconfigManager";
import { NavigationProvider } from "./navigationProvider";
import { exists } from "./projectDetector";
import { ScriptReferenceScanner } from "./scriptReferenceScanner";
import { StylesheetReferenceScanner } from "./stylesheetReferenceScanner";
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
  const stylesheetScanner = new StylesheetReferenceScanner(output);
  const cssClassIndexer = new CssClassIndexer(webjarScanner, stylesheetScanner, output);

  context.subscriptions.push(
    output,
    indexer,
    cssClassIndexer,
    vscode.languages.registerDefinitionProvider(LANGUAGE_SELECTOR, new NavigationProvider(indexer)),
    vscode.languages.registerHoverProvider(LANGUAGE_SELECTOR, new JSDocHoverProvider(indexer)),
    vscode.languages.registerDefinitionProvider(LANGUAGE_SELECTOR, new CssClassDefinitionProvider(cssClassIndexer)),
    vscode.languages.registerHoverProvider(LANGUAGE_SELECTOR, new CssClassHoverProvider(cssClassIndexer)),
    vscode.commands.registerCommand("legacyJavaScriptToolkit.createJsconfig", () => jsconfigManager.createFromCommand()),
    vscode.commands.registerCommand("legacyJavaScriptToolkit.checkJsconfig", () => jsconfigManager.checkFromCommand()),
    vscode.commands.registerCommand("legacyJavaScriptToolkit.updateJsconfig", () => jsconfigManager.updateFromCommand()),
    vscode.commands.registerCommand("legacyJavaScriptToolkit.resetJsconfigPrompt", () => jsconfigManager.resetPrompt()),
    vscode.commands.registerCommand("legacyJavaScriptToolkit.rebuildIndex", async () => {
      const status = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Legacy JavaScript Toolkit：正在重建 JavaScript 與 CSS 索引",
          cancellable: false
        },
        () => rebuildIndexes(webjarScanner, indexer, cssClassIndexer)
      );
      void vscode.window.showInformationMessage(
        `索引完成：${status.javascript.jsFilesCount} 個 JS、${status.javascript.functionsCount} 個 function、` +
        `${status.css.cssFilesCount} 個 CSS、${status.css.classesCount} 個 class 定義。`
      );
    }),
    vscode.commands.registerCommand("legacyJavaScriptToolkit.showIndexStatus", async () => {
      await showIndexStatus(indexer, cssClassIndexer, output);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("legacyJavaScriptToolkit.maxFilesToIndex") ||
        event.affectsConfiguration("legacyJavaScriptToolkit.maxStylesheetFilesToIndex") ||
        event.affectsConfiguration("legacyJavaScriptToolkit.enableNavigation") ||
        event.affectsConfiguration("legacyJavaScriptToolkit.enableCssClassNavigation") ||
        event.affectsConfiguration("legacyJavaScriptToolkit.excludeGlobs") ||
        event.affectsConfiguration("legacyJavaScriptToolkit.includeWebjars") ||
        event.affectsConfiguration("legacyJavaScriptToolkit.mavenRepository")
      ) {
        void rebuildIndexes(webjarScanner, indexer, cssClassIndexer);
      }
    })
  );

  const promptTimer = setTimeout(() => {
    void (async () => {
      await jsconfigManager.promptForEligibleProjects();
      await jsconfigManager.promptForUpdates();
    })().catch((error) => {
      output.appendLine(`警告：jsconfig.json 偵測失敗（${messageOf(error)}）`);
    });
  }, 800);
  const indexTimer = setTimeout(() => {
    const enabled = vscode.workspace.getConfiguration("legacyJavaScriptToolkit").get<boolean>("enableNavigation", true);
    const cssEnabled = vscode.workspace.getConfiguration("legacyJavaScriptToolkit")
      .get<boolean>("enableCssClassNavigation", true);
    if ((enabled || cssEnabled) && (vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
      void rebuildIndexes(webjarScanner, indexer, cssClassIndexer).catch((error) => {
        output.appendLine(`錯誤：JavaScript／CSS 索引建立失敗（${messageOf(error)}）`);
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

async function rebuildIndexes(
  webjarScanner: WebjarScanner,
  indexer: JavaScriptIndexer,
  cssClassIndexer: CssClassIndexer
): Promise<{ javascript: Awaited<ReturnType<JavaScriptIndexer["rebuild"]>>; css: CssClassIndexStatus }> {
  webjarScanner.resetCache();
  const configuration = vscode.workspace.getConfiguration("legacyJavaScriptToolkit");
  const javascriptTask = configuration.get<boolean>("enableNavigation", true)
    ? indexer.rebuild()
    : Promise.resolve(indexer.getStatus());
  const cssTask = configuration.get<boolean>("enableCssClassNavigation", true)
    ? cssClassIndexer.rebuild()
    : Promise.resolve(cssClassIndexer.getStatus());
  const [javascript, css] = await Promise.all([javascriptTask, cssTask]);
  return { javascript, css };
}

async function showIndexStatus(
  indexer: JavaScriptIndexer,
  cssClassIndexer: CssClassIndexer,
  output: vscode.OutputChannel
): Promise<void> {
  const status = indexer.getStatus();
  const cssStatus = cssClassIndexer.getStatus();
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
    `CSS files count：${cssStatus.cssFilesCount}`,
    `CSS classes count：${cssStatus.classesCount}`,
    `Dependency CSS files count：${cssStatus.dependencyFilesCount}`,
    `Last indexed time：${status.lastIndexedTime?.toLocaleString() ?? "尚未建立索引"}`,
    `Index state：${status.indexing ? "建立中" : "待命"}${status.truncated ? "（已達檔案上限）" : ""}`,
    `jsconfig.json：${jsconfigStates.length === 0 ? "不適用" : jsconfigStates.map((item) => `${item.name}=${item.exists ? "有" : "無"}`).join(", ")}`
  ];
  output.appendLine("");
  output.appendLine("JavaScript and CSS Index Status");
  for (const line of lines) output.appendLine(line);
  output.show(true);
  void vscode.window.showInformationMessage(
    `索引狀態：${status.jsFilesCount} 個 JS、${status.functionsCount} 個 function、` +
    `${cssStatus.cssFilesCount} 個 CSS、${cssStatus.classesCount} 個 class 定義。`
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

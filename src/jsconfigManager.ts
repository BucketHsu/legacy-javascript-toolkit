import * as vscode from "vscode";
import { analyzeJsconfig, JsconfigUpdateAnalysis } from "./jsconfigUpdater";
import { detectProject, exists } from "./projectDetector";

const SKIP_PROMPT_KEY = "legacyJavascriptToolkit.skipJsconfigPrompt";
const SKIP_UPDATE_PROMPT_KEY = "legacyJavascriptToolkit.skipJsconfigUpdatePrompt";

interface JsconfigContent {
  compilerOptions: {
    target: string;
    allowJs: boolean;
    checkJs: boolean;
  };
  include: string[];
  exclude: string[];
}

export class JsconfigManager {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  public async promptForEligibleProjects(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("legacyJavaScriptToolkit");
    if (!configuration.get<boolean>("promptCreateJsconfig", true)) {
      return;
    }
    if (this.context.workspaceState.get<boolean>(SKIP_PROMPT_KEY, false)) {
      return;
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const detection = await detectProject(folder);
      if (!detection.isJavaWebProject || detection.hasJsconfig || detection.hasTsconfig) {
        continue;
      }

      const choice = await vscode.window.showInformationMessage(
        "目前專案尚未偵測到 jsconfig.json。是否要建立一份適合 Java / Spring Boot / 傳統 Java Web 專案的 jsconfig.json，以改善 JavaScript Ctrl+Click、Go to Definition、Hover 與 JSDoc 支援？",
        "建立",
        "稍後提醒",
        "不要再提醒"
      );
      if (choice === "建立") {
        await this.create(folder, "jsconfig.json");
      } else if (choice === "不要再提醒") {
        await this.context.workspaceState.update(SKIP_PROMPT_KEY, true);
      }
      return;
    }
  }

  public async promptForUpdates(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("legacyJavaScriptToolkit");
    if (!configuration.get<boolean>("promptUpdateJsconfig", true)) return;
    if (this.context.workspaceState.get<boolean>(SKIP_UPDATE_PROMPT_KEY, false)) return;

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const detection = await detectProject(folder);
      if (!detection.isJavaWebProject || !detection.hasJsconfig || detection.hasTsconfig) continue;
      const result = await this.analyze(folder);
      if (!result || !result.analysis.valid || !result.analysis.changed) continue;

      const choice = await vscode.window.showInformationMessage(
        `偵測到 ${folder.name} 的 jsconfig.json 可安全補齊 JavaScript 專案範圍，是否更新？`,
        "安全更新",
        "查看差異",
        "稍後提醒",
        "不要再提醒"
      );
      if (choice === "安全更新") {
        await this.applyUpdate(folder);
      } else if (choice === "查看差異") {
        await this.showDiffAndOfferUpdate(folder, result);
      } else if (choice === "不要再提醒") {
        await this.context.workspaceState.update(SKIP_UPDATE_PROMPT_KEY, true);
      }
      return;
    }
  }

  public async checkFromCommand(): Promise<void> {
    const folder = await this.selectWorkspaceFolder("選擇要檢查 jsconfig.json 的 workspace 資料夾");
    if (!folder) return;
    await this.checkFolder(folder);
  }

  private async checkFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const result = await this.analyze(folder);
    if (!result) return;
    if (!result.analysis.valid) {
      await this.showInvalidJsconfig(result.target, result.analysis);
      return;
    }
    if (!result.analysis.changed) {
      void vscode.window.showInformationMessage("目前 jsconfig.json 已涵蓋偵測到的 JavaScript 目錄與建議設定，不需要更新。");
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `jsconfig.json 可補入：${summarizeChanges(result.analysis)}`,
      "查看差異",
      "安全更新",
      "取消"
    );
    if (choice === "查看差異") {
      await this.showDiffAndOfferUpdate(folder, result);
    } else if (choice === "安全更新") {
      await this.applyUpdate(folder);
    }
  }

  public async updateFromCommand(): Promise<void> {
    const folder = await this.selectWorkspaceFolder("選擇要更新 jsconfig.json 的 workspace 資料夾");
    if (!folder) return;
    const result = await this.analyze(folder);
    if (!result) return;
    if (!result.analysis.valid) {
      await this.showInvalidJsconfig(result.target, result.analysis);
      return;
    }
    if (!result.analysis.changed) {
      void vscode.window.showInformationMessage("目前 jsconfig.json 不需要更新。");
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `即將只補入缺少的設定，不會變更既有值。更新內容：${summarizeChanges(result.analysis)}`,
      "安全更新",
      "查看差異",
      "取消"
    );
    if (choice === "安全更新") {
      await this.applyUpdate(folder);
    } else if (choice === "查看差異") {
      await this.showDiffAndOfferUpdate(folder, result);
    }
  }

  public async createFromCommand(): Promise<void> {
    const folder = await this.selectWorkspaceFolder();
    if (!folder) {
      void vscode.window.showWarningMessage("目前未開啟 workspace，無法建立 jsconfig.json。");
      return;
    }

    const target = vscode.Uri.joinPath(folder.uri, "jsconfig.json");
    if (await exists(target)) {
      const choice = await vscode.window.showInformationMessage(
        "目前專案已存在 jsconfig.json，要如何處理？",
        "開啟現有檔案",
        "檢查是否需要更新",
        "建立 jsconfig.generated.json",
        "取消"
      );
      if (choice === "開啟現有檔案") {
        await vscode.window.showTextDocument(target);
      } else if (choice === "檢查是否需要更新") {
        await this.checkFolder(folder);
      } else if (choice === "建立 jsconfig.generated.json") {
        const generated = vscode.Uri.joinPath(folder.uri, "jsconfig.generated.json");
        if (await exists(generated)) {
          await vscode.window.showTextDocument(generated);
          void vscode.window.showInformationMessage("jsconfig.generated.json 已存在，已開啟現有檔案。");
        } else {
          await this.create(folder, "jsconfig.generated.json");
        }
      }
      return;
    }
    await this.create(folder, "jsconfig.json");
  }

  public async resetPrompt(): Promise<void> {
    await this.context.workspaceState.update(SKIP_PROMPT_KEY, undefined);
    await this.context.workspaceState.update(SKIP_UPDATE_PROMPT_KEY, undefined);
    void vscode.window.showInformationMessage("已重設 jsconfig.json 建立與更新提醒狀態。");
  }

  public async hasJsconfig(folder: vscode.WorkspaceFolder): Promise<boolean> {
    return exists(vscode.Uri.joinPath(folder.uri, "jsconfig.json"));
  }

  private async create(folder: vscode.WorkspaceFolder, fileName: string): Promise<void> {
    const target = vscode.Uri.joinPath(folder.uri, fileName);
    if (await exists(target)) {
      await vscode.window.showTextDocument(target);
      void vscode.window.showInformationMessage(`${fileName} 已存在，未覆蓋現有檔案。`);
      return;
    }
    const detection = await detectProject(folder);
    const content: JsconfigContent = {
      compilerOptions: {
        target: "ES2020",
        allowJs: true,
        checkJs: false
      },
      include: detection.includes,
      exclude: ["node_modules", "target", "dist", "build", ".git"]
    };

    await vscode.workspace.fs.writeFile(target, Buffer.from(`${JSON.stringify(content, null, 2)}\n`, "utf8"));
    this.output.appendLine(`已建立 ${target.fsPath}`);

    const choice = await vscode.window.showInformationMessage(
      `已建立 ${fileName}。建議重新啟動 TypeScript Server 或重新載入 VS Code 視窗。`,
      "Restart TS Server",
      "Reload Window",
      "稍後"
    );
    if (choice === "Restart TS Server") {
      await vscode.commands.executeCommand("typescript.restartTsServer");
    } else if (choice === "Reload Window") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  }

  private async analyze(folder: vscode.WorkspaceFolder): Promise<{
    target: vscode.Uri;
    originalText: string;
    analysis: JsconfigUpdateAnalysis;
  } | undefined> {
    const target = vscode.Uri.joinPath(folder.uri, "jsconfig.json");
    if (!(await exists(target))) {
      void vscode.window.showWarningMessage("目前專案沒有 jsconfig.json，請先執行 Create jsconfig.json。");
      return undefined;
    }
    try {
      const originalText = new TextDecoder("utf-8", { fatal: true })
        .decode(await vscode.workspace.fs.readFile(target));
      const detection = await detectProject(folder);
      return {
        target,
        originalText,
        analysis: analyzeJsconfig(originalText, detection.includes)
      };
    } catch (error) {
      this.output.appendLine(`警告：無法讀取 ${target.fsPath}（${messageOf(error)}）`);
      void vscode.window.showWarningMessage("無法以 UTF-8 讀取 jsconfig.json，未進行更新。");
      return undefined;
    }
  }

  private async applyUpdate(folder: vscode.WorkspaceFolder): Promise<void> {
    // 寫入前重新分析，避免使用者在預覽期間修改檔案後被舊內容覆蓋。
    const current = await this.analyze(folder);
    if (!current || !current.analysis.valid) {
      if (current) await this.showInvalidJsconfig(current.target, current.analysis);
      return;
    }
    if (!current.analysis.changed) {
      void vscode.window.showInformationMessage("目前 jsconfig.json 不需要更新。");
      return;
    }
    await vscode.workspace.fs.writeFile(
      current.target,
      Buffer.from(current.analysis.updatedText, "utf8")
    );
    this.output.appendLine(`已安全更新 ${current.target.fsPath}：${summarizeChanges(current.analysis)}`);
    await this.showRestartPrompt("已安全更新 jsconfig.json。既有設定值均已保留。");
  }

  private async showDiffAndOfferUpdate(
    folder: vscode.WorkspaceFolder,
    result: { target: vscode.Uri; originalText: string; analysis: JsconfigUpdateAnalysis }
  ): Promise<void> {
    const preview = await vscode.workspace.openTextDocument({
      content: result.analysis.updatedText,
      language: "jsonc"
    });
    await vscode.commands.executeCommand(
      "vscode.diff",
      result.target,
      preview.uri,
      `${folder.name}: jsconfig.json 安全更新預覽`,
      { preview: true }
    );
    const choice = await vscode.window.showInformationMessage(
      "是否套用剛才預覽的 jsconfig.json 安全更新？",
      "安全更新",
      "取消"
    );
    if (choice === "安全更新") await this.applyUpdate(folder);
  }

  private async showInvalidJsconfig(target: vscode.Uri, analysis: JsconfigUpdateAnalysis): Promise<void> {
    this.output.appendLine(`警告：${target.fsPath} 無法安全更新：${analysis.errors.join("；")}`);
    const choice = await vscode.window.showWarningMessage(
      `jsconfig.json 格式或欄位型別不正確，未進行更新：${analysis.errors[0] ?? "未知錯誤"}`,
      "開啟檔案",
      "取消"
    );
    if (choice === "開啟檔案") await vscode.window.showTextDocument(target);
  }

  private async showRestartPrompt(message: string): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      `${message} 建議重新啟動 TypeScript Server 或重新載入 VS Code 視窗。`,
      "Restart TS Server",
      "Reload Window",
      "稍後"
    );
    if (choice === "Restart TS Server") {
      await vscode.commands.executeCommand("typescript.restartTsServer");
    } else if (choice === "Reload Window") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  }

  private async selectWorkspaceFolder(
    placeHolder = "選擇要建立 jsconfig.json 的 workspace 資料夾"
  ): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length <= 1) {
      return folders[0];
    }
    const choice = await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      { placeHolder }
    );
    return choice?.folder;
  }
}

function summarizeChanges(analysis: JsconfigUpdateAnalysis): string {
  const parts: string[] = [];
  if (analysis.missingIncludes.length > 0) parts.push(`${analysis.missingIncludes.length} 個 include`);
  if (analysis.missingExcludes.length > 0) parts.push(`${analysis.missingExcludes.length} 個 exclude`);
  const optionCount = Object.keys(analysis.missingCompilerOptions).length;
  if (optionCount > 0) parts.push(`${optionCount} 個 compilerOptions`);
  if (analysis.removedCompilerOptions.length > 0) {
    parts.push(`移除 ${analysis.removedCompilerOptions.length} 個已棄用 compilerOptions`);
  }
  return parts.join("、") || "無";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

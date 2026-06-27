import * as vscode from "vscode";
import { detectProject, exists } from "./projectDetector";

const SKIP_PROMPT_KEY = "legacyJavascriptToolkit.skipJsconfigPrompt";

interface JsconfigContent {
  compilerOptions: {
    target: string;
    allowJs: boolean;
    checkJs: boolean;
    baseUrl: string;
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
        "建立 jsconfig.generated.json",
        "取消"
      );
      if (choice === "開啟現有檔案") {
        await vscode.window.showTextDocument(target);
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
    void vscode.window.showInformationMessage("已重設 jsconfig.json 提醒狀態。");
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
        checkJs: false,
        baseUrl: "."
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

  private async selectWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length <= 1) {
      return folders[0];
    }
    const choice = await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      { placeHolder: "選擇要建立 jsconfig.json 的 workspace 資料夾" }
    );
    return choice?.folder;
  }
}

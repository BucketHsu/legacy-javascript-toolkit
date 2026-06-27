# Legacy JavaScript Toolkit

繁體中文版：`README.md` | English version: `README.en.md`

Legacy JavaScript Toolkit 是為 Java / Spring Boot / 傳統 Java Web 專案設計的 VS Code 擴充套件。它補強原生 JavaScript 的 inline HTML 語法高亮、function 定義導覽、JSDoc Hover、JSP / HTML `script src` 關聯、Maven WebJar 索引，以及 `jsconfig.json` 建立輔助。

0.0.2 起支援 Maven parent、transitive dependency 與 Spring Boot dependency JAR 內的前端資產，可直接導覽 gkweb `gk-frontend` 提供的 `createView`、`createButtonbar` 等 function，不需要設定特定電腦的 gkweb 原始碼路徑。

## 適合的專案類型

- Spring Boot 的 `src/main/resources/static`、`public` 與 `META-INF/resources`
- 傳統 Java Web 的 `src/main/webapp`
- 使用 JSP、JSPX、Tag File 的專案
- Eclipse 常見的 `WebRoot` 或 `WebContent` 專案
- 透過 Maven WebJar 引用 JavaScript 的專案
- 未使用 npm bundler、以原生 JavaScript 為主的既有系統
- Maven 多模組 workspace；掃描範圍不限於 workspace 根目錄下的單一模組

## Inline HTML Highlight

擴充套件使用 TextMate grammar injection，將符合規則的 JavaScript / TypeScript template literal 內容交由 HTML grammar 高亮。支援 `.js`、`.jsx`、`.ts`、`.tsx`。

### 自動辨識規則

變數名稱包含 `html`、`template`、`markup`、`view`（不分大小寫），或名稱本身就是上述字詞：

```javascript
const html = `<div>${name}</div>`;
const rowHtml = `<tr><td>${id}</td></tr>`;
const USER_HTML = `<section>${content}</section>`;
const pageTemplate = `<main>${title}</main>`;
```

DOM HTML 屬性與 API：

```javascript
element.innerHTML = `<div>${message}</div>`;
element?.outerHTML = `<section>${title}</section>`;
element.insertAdjacentHTML("beforeend", `<li>${item.name}</li>`);
```

### 明確標記

`/*html*/`、`/* html */` 與大小寫變形是最穩定的指定方式：

```javascript
const result = /*html*/ `<div class="card">${content}</div>`;
```

HTML 內的 `${...}` 會切回 JavaScript expression 高亮。TextMate grammar 是 regex 規則，不是完整 parser；巢狀大括號或很複雜的 expression 仍可能受限。

一般的 SQL、訊息、URL 與 query template literal 不符合命名、DOM API 或 marker 規則，因此不會全部被誤判成 HTML：

```javascript
const sql = `SELECT * FROM USER`;
const message = `hello ${name}`;
const url = `/api/user/${id}`;
```

## JavaScript Function Navigator

擴充套件啟動後會延遲掃描 workspace，並以 TypeScript AST 建立輕量 function index。支援：

- `Ctrl + Click` 與 Go to Definition
- Peek Definition
- Hover 顯示參數、JSDoc 摘要、`@param`、`@returns`、來源路徑與來源類型
- 同名 function 回傳多個 location，由 VS Code 顯示候選位置
- Qualified name 優先比對，例如 `MyApp.util.getUserName`
- JS / JSX / TS / TSX，以及 HTML / JSP 內可辨識的呼叫位置

目前索引下列常見形式：

```javascript
function foo(value) {}
const foo = function (value) {};
const foo = (value) => {};
const service = { foo(value) {} };
MyApp.util.foo = function (value) {};
window.foo = function (value) {};
$.fn.myPlugin = function (options) {};
class Service { foo(value) {} }
```

檔案建立或修改後會做 500 ms debounce 的單檔增量更新。大量移動、設定變更或 WebJar dependency 更新後，建議執行 `Rebuild JavaScript Index`。

## jsconfig.json 輔助功能

`jsconfig.json` 能讓 VS Code 的 JavaScript / TypeScript Language Service 更清楚專案範圍，改善內建的 Ctrl+Click、定義導覽、Hover 與 JSDoc 體驗。

啟動時只在符合以下條件時詢問：

- workspace 沒有 `jsconfig.json`
- workspace 沒有 `tsconfig.json`
- 偵測到 `pom.xml`、`build.gradle` 或 Java Web 常見資料夾
- `promptCreateJsconfig` 已啟用，且使用者未選擇「不要再提醒」

只有選擇「建立」才會寫入檔案，`include` 只納入實際存在的目錄，也支援 Maven 多模組路徑。既有 `jsconfig.json` 不會被覆蓋；手動執行建立指令時，可以開啟既有檔案或另建 `jsconfig.generated.json`。

## WebJar 支援

索引器依序嘗試：

1. 掃描 `target/classes` 下的 `META-INF/resources`、`static`、`public` 與 `resources` JavaScript。
2. 解析 workspace POM、parent POM、`dependencyManagement`、imported BOM 與相關 transitive dependency。
3. 從每台電腦自己的 Maven local repository 找到對應 JAR，不依賴固定磁碟或專案原始碼路徑。
4. 索引標準 `META-INF/resources/webjars`，以及 Spring Boot dependency JAR 內的 `static`、`public`、`resources`、`META-INF/resources`。
5. 辨識 HTML / JSP / Thymeleaf 的 `src` 與靜態 `th:src="@{...}"`，並優先解壓實際引用的 JavaScript。

Maven local repository 依序取自：

1. `legacyJavaScriptToolkit.mavenRepository` 設定。
2. workspace 的 `.mvn/maven.config` 內 `-Dmaven.repo.local`。
3. `MAVEN_REPO_LOCAL` 或 `M2_REPO` 環境變數。
4. 使用者 `~/.m2/settings.xml` 的 `<localRepository>`。
5. 使用者的 `~/.m2/repository`。

例如 NTPCLandFx 經 `gk-react` 間接相依 `gk-frontend` 時，索引器可從本機 Maven repository 的 `gk-frontend` JAR 找到 `static/js/view.js`、`buttonbar.js` 與 `function.js`，不需要知道 gkweb 原始碼位於哪個磁碟。

這是 best-effort 索引，不等同 Java classpath。Minified JavaScript 的 function 導覽通常不理想；第三方 library 建議另外提供 `.d.ts`、`@types/*` 或專案自己的 typings。

## 指令列表

| 指令 | 用途 |
| --- | --- |
| `Legacy JavaScript Toolkit: Create jsconfig.json` | 建立適合目前 Java Web 專案的設定檔 |
| `Legacy JavaScript Toolkit: Reset jsconfig.json Prompt` | 清除「不要再提醒」狀態 |
| `Legacy JavaScript Toolkit: Rebuild JavaScript Index` | 重新掃描專案與 WebJar |
| `Legacy JavaScript Toolkit: Show JavaScript Index Status` | 顯示 workspace、檔案、function、WebJar、時間與 jsconfig 狀態 |

診斷訊息會寫入 Output 面板的 `Legacy JavaScript Toolkit` channel。

## Extension settings

| 設定 | 預設值 | 說明 |
| --- | --- | --- |
| `legacyJavaScriptToolkit.enableInlineHtmlHighlight` | `true` | Inline HTML 高亮偏好；TextMate contribution 由 VS Code 載入，變更後需重新載入視窗 |
| `legacyJavaScriptToolkit.enableNavigation` | `true` | 啟用 function Definition 與 Hover Provider |
| `legacyJavaScriptToolkit.promptCreateJsconfig` | `true` | 符合條件時詢問建立 jsconfig |
| `legacyJavaScriptToolkit.includeWebjars` | `true` | 納入 Maven WebJar |
| `legacyJavaScriptToolkit.mavenRepository` | 空字串 | 選用的 Maven local repository；留空時自動依 Maven 設定與使用者目錄判斷 |
| `legacyJavaScriptToolkit.maxFilesToIndex` | `3000` | 索引檔案上限 |
| `legacyJavaScriptToolkit.excludeGlobs` | 常見產物資料夾 | 排除的 glob patterns |

TextMate grammar contribution 目前無法由 extension runtime 動態卸載；若要完全停用 inline HTML grammar，請停用此擴充套件。`enableInlineHtmlHighlight` 保留為偏好設定與後續版本相容用途。

## 安裝方式

從 VSIX 安裝：

```bash
code --install-extension legacy-javascript-toolkit-0.0.2.vsix
```

也可以在 VS Code 的 Extensions 檢視中，使用 `Install from VSIX...`。

## 開發方式

需求：Node.js 20 以上與 VS Code 1.90 以上。

```bash
npm ci
npm run compile
```

用 VS Code 開啟此資料夾，按 `F5` 啟動 Extension Development Host。修改 TypeScript 時可執行：

```bash
npm run watch
```

## VSIX 打包方式

```bash
npm run package
```

成功後會在專案根目錄產生 `legacy-javascript-toolkit-0.0.2.vsix`。

## 已知限制

- JavaScript 是動態語言，function 來源不一定能 100% 精準判斷。
- 同名 function 可能有多個候選；擴充套件會全部交給 VS Code，不任意選第一個。
- 動態產生的 `script src` 無法保證解析。
- JSP 以 Java 變數、EL 或字串運算組出的 script path 不一定能解析。
- 目前不索引 JSP / HTML 的 inline `<script>` function，只利用其中的呼叫與靜態 `src` 關聯。
- Minified JS 的導覽效果可能不好，超過 2 MB 的單一檔案會略過。
- Big5、MS950 或其他非 UTF-8 檔案會略過並在 Output channel 顯示警告。
- Maven dependency resource 支援是 best-effort，不等同完整 Maven effective model；複雜 profile、classifier、exclusion 或非標準資產目錄可能無法定位。
- WebJar 不是 npm package，VS Code 不一定能自動取得型別；第三方 library 建議搭配 `.d.ts` 或 `@types/*`。
- `jsp` language id 取決於已安裝的 JSP 語言擴充套件；若檔案被辨識為其他 language id，JSP Provider 不會自動生效。
- TextMate grammar injection 對複雜 template literal 的判斷有限，`/*html*/` 是最穩定的明確標記方式。
- `${...}` expression 目前使用 JavaScript grammar；TypeScript 專屬型別語法的內嵌高亮可能不完整。

## 疑難排解

- 無法跳轉：先執行 `Show JavaScript Index Status`，確認 function 數量，再執行 `Rebuild JavaScript Index`。
- 檔案未被索引：檢查 `excludeGlobs`、`maxFilesToIndex` 與 Output channel 的警告。
- WebJar 或 Spring Boot dependency resource 未被索引：確認 JAR 已存在 Maven local repository；自訂 repository 可設定 `legacyJavaScriptToolkit.mavenRepository`。
- VS Code 內建 JavaScript 導覽不足：執行 `Create jsconfig.json` 後，選擇 Restart TS Server 或 Reload Window。
- Inline HTML 未高亮：確認變數名稱符合規則，或改用 `/*html*/`；變更擴充套件或 grammar 後請重新載入視窗。

## 授權

MIT

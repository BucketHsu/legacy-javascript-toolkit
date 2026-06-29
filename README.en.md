# Legacy JavaScript Toolkit

Traditional Chinese: `README.md` | English: `README.en.md`

Legacy JavaScript Toolkit improves native JavaScript development in Spring Boot and traditional Java Web projects. It provides inline HTML highlighting, function navigation, JSDoc hover, JSP/HTML script reference scanning, Maven WebJar indexing, and `jsconfig.json` assistance.

## Feature demos

![Legacy JavaScript Toolkit feature demo 1](images/legacy-javascript-toolkit%20-demo1.gif)

![Legacy JavaScript Toolkit feature demo 2](images/legacy-javascript-toolkit%20-demo2.gif)

Version 0.0.2 adds Maven parent and transitive dependency resolution plus Spring Boot classpath resource indexing. Functions supplied by dependency JARs such as gkweb `gk-frontend` can be navigated without a machine-specific source path.

Version 0.0.3 can inspect and safely update an existing `jsconfig.json`. It previews the diff and only adds missing project paths or recommended settings without replacing existing `target`, `baseUrl`, `paths`, comments, or other user settings.

## Suitable projects

- Spring Boot static resources
- Traditional `src/main/webapp`, `WebRoot`, and `WebContent` applications
- JSP, JSPX, and tag files
- Maven multi-module workspaces
- WebJar-based front ends
- Legacy JavaScript without an npm bundler

## Inline HTML Highlight

The TextMate injection supports JS, JSX, TS, and TSX template literals assigned to names containing `html`, `template`, `markup`, or `view` (case-insensitive). It also supports `innerHTML`, `outerHTML`, the second argument of `insertAdjacentHTML`, and the explicit `/*html*/` marker.

```javascript
const rowHtml = `<tr><td>${name}</td></tr>`;
element?.innerHTML = `<div>${message}</div>`;
element.insertAdjacentHTML("beforeend", `<li>${item.name}</li>`);
const explicit = /*html*/ `<section>${content}</section>`;
```

Unrelated SQL, URL, message, and query template literals are not highlighted. `${...}` regions retain JavaScript expression highlighting. For complex templates, `/*html*/` is the most reliable opt-in.

## JavaScript Function Navigator

The delayed workspace index uses the TypeScript AST and supports function declarations, function expressions, arrow functions, object methods, namespace assignments, and class methods.

- Ctrl+Click and Go to Definition
- Peek Definition
- Hover with parameters, JSDoc summary, `@param`, `@returns`, source path, and source type
- Multiple locations for ambiguous names
- Exact qualified-name matching before short-name fallback
- JS/JSX/TS/TSX definitions and call sites in JavaScript, TypeScript, HTML, and JSP documents

Changed files receive a debounced incremental update. Use `Rebuild JavaScript Index` after dependency or large workspace changes.

## jsconfig.json assistance

The extension prompts only when a workspace has no `jsconfig.json` or `tsconfig.json` and looks like a Java Web project. It never overwrites an existing file. Generated `include` entries only reference directories that exist, including nested Maven modules.

The manual command can open the existing file or create `jsconfig.generated.json`. After creation, the extension can restart the TypeScript server or reload the VS Code window.

Existing JSONC files, including comments and trailing commas, can be checked and updated safely. The extension only appends missing include/exclude entries and missing compiler options. Invalid files are opened for correction and are never overwritten. Automatic update prompts remain disabled when a root `tsconfig.json` exists.

## WebJar and classpath resource support

The scanner follows workspace POMs, parent POMs, dependency management, imported BOMs, and relevant transitive dependencies. It indexes standard WebJars and Spring Boot dependency resources under `static`, `public`, `resources`, and `META-INF/resources`.

The Maven local repository is resolved from the extension setting, `.mvn/maven.config`, environment variables, `~/.m2/settings.xml`, or the current user's `~/.m2/repository`. No machine-specific project path is required. Static Thymeleaf `th:src="@{...}"` references are also recognized.

This is best-effort support, not a Java classpath. Minified libraries are difficult to navigate. Prefer `.d.ts`, project typings, or `@types/*` where available.

## Commands

- `Legacy JavaScript Toolkit: Create jsconfig.json`
- `Legacy JavaScript Toolkit: Check jsconfig.json`
- `Legacy JavaScript Toolkit: Update jsconfig.json Safely`
- `Legacy JavaScript Toolkit: Reset jsconfig.json Prompt`
- `Legacy JavaScript Toolkit: Rebuild JavaScript Index`
- `Legacy JavaScript Toolkit: Show JavaScript Index Status`

Diagnostics are written to the `Legacy JavaScript Toolkit` output channel.

## Extension settings

- `legacyJavaScriptToolkit.enableInlineHtmlHighlight` (default: `true`)
- `legacyJavaScriptToolkit.enableNavigation` (default: `true`)
- `legacyJavaScriptToolkit.promptCreateJsconfig` (default: `true`)
- `legacyJavaScriptToolkit.promptUpdateJsconfig` (default: `true`)
- `legacyJavaScriptToolkit.includeWebjars` (default: `true`)
- `legacyJavaScriptToolkit.mavenRepository` (default: empty; auto-detected)
- `legacyJavaScriptToolkit.maxFilesToIndex` (default: `3000`)
- `legacyJavaScriptToolkit.excludeGlobs`

VS Code loads TextMate contributions statically, so the grammar cannot currently be unloaded at runtime. Fully disabling inline HTML highlighting requires disabling the extension; the setting is retained for preference and forward compatibility.

## Installation

```bash
code --install-extension legacy-javascript-toolkit-0.0.4.vsix
```

You can also use `Install from VSIX...` in the Extensions view.

## Development

Node.js 20+ and VS Code 1.90+ are recommended.

```bash
npm ci
npm run compile
npm run watch
```

Press `F5` in VS Code to launch an Extension Development Host.

## VSIX packaging

```bash
npm run package
```

## Known limitations

- JavaScript is dynamic, so function origin cannot be determined with complete accuracy.
- Duplicate names produce multiple candidates.
- Dynamic or JSP-generated script paths may not resolve.
- Inline functions declared inside JSP/HTML `<script>` blocks are not indexed yet.
- Minified or files larger than 2 MB are poor indexing candidates.
- Non-UTF-8 files are skipped with an output warning.
- Maven dependency resource support is best-effort and may not resolve complex profiles, classifiers, exclusions, or non-standard resource roots.
- A JSP language extension must provide the `jsp` language id for the JSP provider selector.
- TextMate matching is regex-based; use `/*html*/` for deterministic highlighting.
- Embedded expressions currently use JavaScript grammar, so TS-only syntax may be incomplete.

## Troubleshooting

- Run `Show JavaScript Index Status`, then `Rebuild JavaScript Index`.
- Check exclude globs, the file limit, and the output channel.
- Verify WebJar artifacts exist in the local Maven repository.
- Create `jsconfig.json`, then restart the TypeScript server.
- Reload the VS Code window after grammar or extension changes.

## License

MIT

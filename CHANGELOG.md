# Changelog

## 0.0.6

- Stop generating the TypeScript 6 deprecated `baseUrl` compiler option.
- Remove legacy generated `"baseUrl": "."` during safe `jsconfig.json` updates.
- Preserve custom non-dot `baseUrl` values to avoid changing module resolution behavior.
- Index frontend artifacts inherited from Maven parent `dependencyManagement` when resolving referenced JavaScript resources.
- Restore navigation for shared functions and returned object methods such as `createButtonbar` and `setApiUrl`.

## 0.0.5

- Fix the Traditional Chinese and English README language switch links.

## 0.0.4

- Add two animated feature demos to the Traditional Chinese and English README files.
- Add repository metadata so Marketplace README images resolve correctly.

## 0.0.3

- Add automatic checks for safe jsconfig.json updates in Java Web workspaces.
- Add Check jsconfig.json and Update jsconfig.json Safely commands.
- Add a diff preview before applying jsconfig.json changes.
- Preserve existing compiler options, paths, comments, trailing commas, and custom settings.
- Only append missing include/exclude entries and missing recommended compiler options.
- Re-read jsconfig.json before writing to avoid overwriting edits made during preview.
- Refuse to update invalid JSONC or unsupported field types.
- Add a separate prompt setting and reset state for jsconfig.json updates.

## 0.0.2

- Change the Marketplace publisher to BucketHsu.
- Resolve Maven parent POMs, dependency management, imported BOMs, and relevant transitive dependencies.
- Index JavaScript from Spring Boot dependency JAR resource roots: static, public, resources, and META-INF/resources.
- Support gkweb gk-frontend functions such as createView and createButtonbar without a machine-specific source path.
- Detect the Maven local repository from extension settings, Maven configuration, environment variables, settings.xml, or the current user home directory.
- Prefer static Thymeleaf th:src references over browser fallback src paths.
- Limit Maven dependency traversal and prioritize referenced JavaScript resources to reduce indexing time and memory usage.

## 0.0.1

- Add JavaScript / TypeScript inline HTML syntax highlighting.
- Support automatic detection for html/template/markup/view variables.
- Support innerHTML and outerHTML assignments.
- Support insertAdjacentHTML second argument.
- Support optional /*html*/ marker.
- Add legacy JavaScript function indexing.
- Add Go to Definition support for common JavaScript function patterns.
- Add Hover support with JSDoc extraction.
- Add best-effort WebJar JavaScript indexing.
- Add JSP / HTML script src scanning.
- Add jsconfig.json creation prompt for Java Web projects.
- Add Traditional Chinese and English documentation.
- Add VSIX packaging ignore rules and GitHub CI.

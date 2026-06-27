# Changelog

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

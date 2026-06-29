const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = new Position(startLine, startCharacter);
    this.end = new Position(endLine, endCharacter);
  }
}

const vscodeMock = {
  Range,
  RelativePattern: class RelativePattern {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  Uri: {
    file(fsPath) {
      return { fsPath, path: fsPath, toString: () => `file://${fsPath}` };
    }
  },
  workspace: {}
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

const { parseFunctionDefinitions } = require("../out/javascriptIndexer");
const { analyzeJsconfig } = require("../out/jsconfigUpdater");
const { extractScriptSources } = require("../out/scriptReferenceScanner");
const { getDependencyResourcePath, parseWebjarDependencies } = require("../out/webjarScanner");
const { MavenDependencyResolver } = require("../out/mavenDependencyResolver");

const source = `
/**
 * Query a user.
 * @param {string} id user id
 * @returns {string} name
 */
function declared(id) {}
const expressed = function (value) {};
const arrow = value => value;
const service = {
  objectMethod(id) { return id; }
};
MyApp.util.assigned = function (id) {};
window.globalFunction = function () {};
$.fn.myPlugin = function (options) {};
class UserService {
  classMethod(id) { return id; }
}
`;

const definitions = parseFunctionDefinitions(vscodeMock.Uri.file("/workspace/sample.js"), source, "project");
const byFullName = new Map(definitions.map((definition) => [definition.fullName, definition]));

for (const expected of [
  "declared",
  "expressed",
  "arrow",
  "service.objectMethod",
  "MyApp.util.assigned",
  "window.globalFunction",
  "$.fn.myPlugin",
  "UserService.classMethod"
]) {
  assert.ok(byFullName.has(expected), `missing definition: ${expected}`);
}
assert.match(byFullName.get("declared").jsdoc, /@returns/);
assert.deepEqual(
  extractScriptSources('<script th:src="@{/js/buttonbar.js}" src="../../js/buttonbar.js"></script><script src="/js/page.js?v=1"></script>'),
  ["/js/buttonbar.js", "/js/page.js?v=1"]
);
assert.deepEqual(getDependencyResourcePath("static/js/view.js"), { publicPath: "js/view.js" });
assert.deepEqual(
  getDependencyResourcePath("META-INF/resources/webjars/jquery/3.7.1/jquery.js"),
  { publicPath: "webjars/jquery/3.7.1/jquery.js" }
);

const dependencies = parseWebjarDependencies(`
  <project>
    <properties><jquery.version>3.7.1</jquery.version></properties>
    <dependencies>
      <dependency>
        <groupId>org.webjars</groupId>
        <artifactId>jquery</artifactId>
        <version>\${jquery.version}</version>
      </dependency>
    </dependencies>
  </project>
`);
assert.deepEqual(dependencies, [{ groupId: "org.webjars", artifactId: "jquery", version: "3.7.1" }]);

const jsconfig = `{
  // Keep project-specific compiler settings.
  "compilerOptions": {
    "target": "ES2018",
    "paths": { "@app/*": ["src/*"] },
  },
  "include": [
    "src/main/resources/static/**/*.js",
  ],
  "exclude": ["node_modules"],
}`;
const jsconfigAnalysis = analyzeJsconfig(jsconfig, [
  "src/main/resources/static/**/*.js",
  "module-a/src/main/resources/static/**/*.js"
]);
assert.equal(jsconfigAnalysis.valid, true);
assert.equal(jsconfigAnalysis.changed, true);
assert.match(jsconfigAnalysis.updatedText, /Keep project-specific compiler settings/);
const updatedJsconfig = require("jsonc-parser").parse(jsconfigAnalysis.updatedText);
assert.equal(updatedJsconfig.compilerOptions.target, "ES2018");
assert.deepEqual(updatedJsconfig.compilerOptions.paths, { "@app/*": ["src/*"] });
assert.equal(updatedJsconfig.compilerOptions.allowJs, true);
assert.ok(updatedJsconfig.include.includes("module-a/src/main/resources/static/**/*.js"));
assert.ok(updatedJsconfig.exclude.includes("target"));
assert.equal(analyzeJsconfig("{ invalid", []).valid, false);

async function testMavenResolution() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-js-toolkit-"));
  const project = path.join(root, "project");
  const repository = path.join(root, "repository");
  const writeArtifact = async (artifactId, version, pom) => {
    const directory = path.join(repository, "com", "example", artifactId, version);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${artifactId}-${version}.pom`), pom);
    await fs.writeFile(path.join(directory, `${artifactId}-${version}.jar`), "fixture");
  };

  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "pom.xml"), `
    <project>
      <parent><groupId>com.example</groupId><artifactId>parent</artifactId><version>1</version><relativePath/></parent>
      <artifactId>sample</artifactId>
      <dependencies><dependency><groupId>com.example</groupId><artifactId>app</artifactId></dependency></dependencies>
    </project>
  `);
  await writeArtifact("parent", "1", `
    <project><groupId>com.example</groupId><artifactId>parent</artifactId><version>1</version>
      <dependencyManagement><dependencies>
        <dependency><groupId>com.example</groupId><artifactId>app</artifactId><version>1.0</version></dependency>
        <dependency><groupId>com.example</groupId><artifactId>frontend</artifactId><version>2.0</version></dependency>
      </dependencies></dependencyManagement>
    </project>
  `);
  await writeArtifact("app", "1.0", `
    <project>
      <parent><groupId>com.example</groupId><artifactId>parent</artifactId><version>1</version><relativePath/></parent>
      <artifactId>app</artifactId>
      <dependencies><dependency><groupId>com.example</groupId><artifactId>frontend</artifactId></dependency></dependencies>
    </project>
  `);
  await writeArtifact("frontend", "2.0", `
    <project><groupId>com.example</groupId><artifactId>frontend</artifactId><version>2.0</version></project>
  `);

  vscodeMock.workspace.workspaceFolders = [{ uri: vscodeMock.Uri.file(project), name: "fixture" }];
  vscodeMock.workspace.getConfiguration = () => ({
    get: (name, fallback) => name === "mavenRepository" ? repository : fallback
  });
  vscodeMock.workspace.findFiles = async () => [vscodeMock.Uri.file(path.join(project, "pom.xml"))];
  const resolver = new MavenDependencyResolver({ appendLine() {} });
  const result = await resolver.resolveWorkspaceArtifacts();
  assert.deepEqual(
    result.artifacts.map(({ groupId, artifactId, version }) => `${groupId}:${artifactId}:${version}`).sort(),
    ["com.example:app:1.0", "com.example:frontend:2.0"]
  );
  await fs.rm(root, { recursive: true, force: true });
}

testMavenResolution()
  .then(() => console.log(`Indexer tests passed (${definitions.length} definitions).`))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

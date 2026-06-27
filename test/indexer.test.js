const assert = require("node:assert/strict");
const Module = require("node:module");

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
  Uri: {
    file(fsPath) {
      return { fsPath, path: fsPath, toString: () => `file://${fsPath}` };
    }
  }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

const { parseFunctionDefinitions } = require("../out/javascriptIndexer");
const { extractScriptSources } = require("../out/scriptReferenceScanner");
const { parseWebjarDependencies } = require("../out/webjarScanner");

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
  extractScriptSources('<script src="/js/common.js?v=1"></script><script src="../page.js"></script>'),
  ["/js/common.js?v=1", "../page.js"]
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

console.log(`Indexer tests passed (${definitions.length} definitions).`);

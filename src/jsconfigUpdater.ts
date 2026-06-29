import {
  applyEdits,
  FormattingOptions,
  modify,
  parse,
  ParseError,
  printParseErrorCode
} from "jsonc-parser";

const REQUIRED_COMPILER_OPTIONS: Record<string, string | boolean> = {
  target: "ES2020",
  allowJs: true,
  checkJs: false
};

const RECOMMENDED_EXCLUDES = ["node_modules", "target", "dist", "build", ".git"];

export interface JsconfigUpdateAnalysis {
  valid: boolean;
  changed: boolean;
  updatedText: string;
  errors: string[];
  missingIncludes: string[];
  missingExcludes: string[];
  missingCompilerOptions: Record<string, string | boolean>;
  removedCompilerOptions: string[];
}

/**
 * Computes a minimal JSONC update. Existing values and array entries are not
 * replaced. Missing settings are inserted, and the obsolete generated
 * `baseUrl: "."` setting is removed for TypeScript 6/7 compatibility.
 */
export function analyzeJsconfig(text: string, expectedIncludes: string[]): JsconfigUpdateAnalysis {
  const parseErrors: ParseError[] = [];
  const value = parse(text, parseErrors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (parseErrors.length > 0) {
    return invalidAnalysis(text, parseErrors.map((error) =>
      `${printParseErrorCode(error.error)}（offset ${error.offset}）`
    ));
  }
  if (!isObject(value)) {
    return invalidAnalysis(text, ["jsconfig.json 根節點必須是 JSON object。"]);
  }

  const compilerOptions = value.compilerOptions;
  const include = value.include;
  const exclude = value.exclude;
  const semanticErrors: string[] = [];
  if (compilerOptions !== undefined && !isObject(compilerOptions)) {
    semanticErrors.push("compilerOptions 必須是 object。");
  }
  if (include !== undefined && !Array.isArray(include)) {
    semanticErrors.push("include 必須是陣列。");
  }
  if (exclude !== undefined && !Array.isArray(exclude)) {
    semanticErrors.push("exclude 必須是陣列。");
  }
  if (semanticErrors.length > 0) return invalidAnalysis(text, semanticErrors);

  const existingIncludes = new Set(
    (Array.isArray(include) ? include : []).filter(isString).map(normalizePattern)
  );
  const existingExcludes = new Set(
    (Array.isArray(exclude) ? exclude : []).filter(isString).map(normalizePattern)
  );
  const missingIncludes = [...new Set(expectedIncludes)]
    .filter((pattern) => !existingIncludes.has(normalizePattern(pattern)));
  const missingExcludes = RECOMMENDED_EXCLUDES
    .filter((pattern) => !existingExcludes.has(normalizePattern(pattern)));
  const existingCompilerOptions = isObject(compilerOptions) ? compilerOptions : {};
  const removedCompilerOptions = existingCompilerOptions.baseUrl === "." ? ["baseUrl"] : [];
  const missingCompilerOptions = Object.fromEntries(
    Object.entries(REQUIRED_COMPILER_OPTIONS).filter(([name]) => !(name in existingCompilerOptions))
  );

  let updatedText = text;
  const formattingOptions = detectFormatting(text);
  if (compilerOptions === undefined && Object.keys(missingCompilerOptions).length > 0) {
    updatedText = applyModification(updatedText, ["compilerOptions"], missingCompilerOptions, formattingOptions);
  } else {
    for (const [name, optionValue] of Object.entries(missingCompilerOptions)) {
      updatedText = applyModification(updatedText, ["compilerOptions", name], optionValue, formattingOptions);
    }
  }
  for (const name of removedCompilerOptions) {
    updatedText = applyModification(updatedText, ["compilerOptions", name], undefined, formattingOptions);
  }
  updatedText = appendMissingArrayValues(
    updatedText,
    "include",
    Array.isArray(include) ? include.length : undefined,
    missingIncludes,
    formattingOptions
  );
  updatedText = appendMissingArrayValues(
    updatedText,
    "exclude",
    Array.isArray(exclude) ? exclude.length : undefined,
    missingExcludes,
    formattingOptions
  );

  return {
    valid: true,
    changed: updatedText !== text,
    updatedText,
    errors: [],
    missingIncludes,
    missingExcludes,
    missingCompilerOptions,
    removedCompilerOptions
  };
}

function appendMissingArrayValues(
  text: string,
  property: "include" | "exclude",
  existingLength: number | undefined,
  missing: string[],
  formattingOptions: FormattingOptions
): string {
  if (missing.length === 0) return text;
  if (existingLength === undefined) {
    return applyModification(text, [property], missing, formattingOptions);
  }
  let updated = text;
  for (let index = 0; index < missing.length; index += 1) {
    updated = applyModification(
      updated,
      [property, existingLength + index],
      missing[index],
      formattingOptions,
      true
    );
  }
  return updated;
}

function applyModification(
  text: string,
  path: (string | number)[],
  value: unknown,
  formattingOptions: FormattingOptions,
  isArrayInsertion = false
): string {
  return applyEdits(text, modify(text, path, value, { formattingOptions, isArrayInsertion }));
}

function detectFormatting(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indentation = /\r?\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
  return {
    insertSpaces: !indentation.includes("\t"),
    tabSize: indentation.includes("\t") ? 1 : Math.max(2, indentation.length),
    eol
  };
}

function invalidAnalysis(text: string, errors: string[]): JsconfigUpdateAnalysis {
  return {
    valid: false,
    changed: false,
    updatedText: text,
    errors,
    missingIncludes: [],
    missingExcludes: [],
    missingCompilerOptions: {},
    removedCompilerOptions: []
  };
}

function normalizePattern(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

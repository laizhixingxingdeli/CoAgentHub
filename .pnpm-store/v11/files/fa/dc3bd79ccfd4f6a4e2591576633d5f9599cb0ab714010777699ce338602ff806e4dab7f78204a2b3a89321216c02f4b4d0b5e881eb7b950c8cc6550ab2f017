import * as path from 'node:path';
import { createRequire } from 'node:module';
import remapping from '@jridgewell/remapping';
import MagicString from 'magic-string';
import fs from 'node:fs/promises';
import { decode, encode } from '@jridgewell/sourcemap-codec';
import convert$1 from 'convert-source-map';

// This module replaces `import ts from "typescript"` in the bundled output
// (see the typescript-shim plugin in rollup.config.ts).
//
// TypeScript 7 (the native compiler) does not ship a compiler API — it only
// exports `version`. Until the new API arrives in TypeScript 7.1+, users on
// typescript@7 need the `@typescript/typescript6` compatibility package,
// which provides the TypeScript 6.0 API.
//
// `require` is used instead of static imports so that a missing or API-less
// `typescript` package can be detected and recovered from at runtime.

const require$1 = createRequire(import.meta.url);

function loadTypeScript() {
  let ts;
  try {
    ts = require$1("typescript");
  } catch {
    // not installed, or an ESM-only entry point that this Node version cannot `require`
  }
  if (ts && typeof ts.createProgram === "function") {
    return ts;
  }
  try {
    return require$1("@typescript/typescript6");
  } catch {
    if (ts) {
      throw new Error(
        `rollup-plugin-dts requires the TypeScript compiler API. The installed typescript@${ts.version} does not provide it, ` +
          "and the `@typescript/typescript6` fallback is not installed.\n" +
          "TypeScript 7 does not ship a compiler API, so please additionally install the compatibility package:\n" +
          "  npm install -D @typescript/typescript6",
      );
    }
    throw new Error(
      "rollup-plugin-dts requires the TypeScript compiler API, but the `typescript` package could not be loaded.\n" +
        "Please install typescript 4.5 - 6.x, or typescript 7 together with the `@typescript/typescript6` compatibility package:\n" +
        "  npm install -D typescript",
    );
  }
}

var ts = loadTypeScript();

function resolveDefaultOptions(options) {
    return {
        ...options,
        compilerOptions: options.compilerOptions ?? {},
        respectExternal: options.respectExternal ?? false,
        includeExternal: options.includeExternal ?? [],
        sourcemap: options.sourcemap ?? false,
    };
}

const DTS_EXTENSIONS = /\.d\.(c|m)?tsx?$/;
const JSON_EXTENSIONS = /\.json$/;
const SUPPORTED_EXTENSIONS = /((\.d)?\.(c|m)?(t|j)sx?|\.json)$/;
function trimExtension(path) {
    return path.replace(SUPPORTED_EXTENSIONS, "");
}
function getDeclarationId(path) {
    return path.replace(SUPPORTED_EXTENSIONS, ".d.ts");
}
function parse(fileName, code) {
    return ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
}

const formatHost = {
    getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
    getNewLine: () => ts.sys.newLine,
    getCanonicalFileName: ts.sys.useCaseSensitiveFileNames ? (f) => f : (f) => f.toLowerCase(),
};
const DEFAULT_OPTIONS = {
    // Ensure ".d.ts" modules are generated
    declaration: true,
    // Skip ".js" generation
    noEmit: false,
    emitDeclarationOnly: true,
    // Skip code generation when error occurs
    noEmitOnError: true,
    // Avoid extra work
    checkJs: false,
    declarationMap: false,
    skipLibCheck: true,
    // Ensure TS2742 errors are visible
    preserveSymlinks: true,
    // Ensure we can parse the latest code
    target: ts.ScriptTarget.ESNext,
    // Allows importing `*.json`
    resolveJsonModule: true,
};
const configByPath = new Map();
const logCache = (...args) => (process.env.DTS_LOG_CACHE ? console.log("[cache]", ...args) : null);
/**
 * Caches the config for every path between two given paths.
 *
 * It starts from the first path and walks up the directory tree until it reaches the second path.
 */
function cacheConfig([fromPath, toPath], config) {
    logCache(fromPath);
    configByPath.set(fromPath, config);
    while (fromPath !== toPath &&
        // make sure we're not stuck in an infinite loop
        fromPath !== path.dirname(fromPath)) {
        fromPath = path.dirname(fromPath);
        logCache("up", fromPath);
        if (configByPath.has(fromPath))
            return logCache("has", fromPath);
        configByPath.set(fromPath, config);
    }
}
function getCompilerOptions(input, overrideOptions, overrideConfigPath, enableDeclarationMap) {
    const compilerOptions = {
        ...DEFAULT_OPTIONS,
        ...overrideOptions,
        // When plugin's sourcemap option is explicitly true, force declarationMap
        // regardless of user's compilerOptions setting.
        // When sourcemap is false/undefined, respect user's compilerOptions.declarationMap.
        ...(enableDeclarationMap === true && { declarationMap: true }),
    };
    let dirName = path.dirname(input);
    let dtsFiles = [];
    // if a custom config is provided we'll use that as the cache key since it will always be used
    const cacheKey = overrideConfigPath || dirName;
    if (!configByPath.has(cacheKey)) {
        logCache("miss", cacheKey);
        const configPath = overrideConfigPath
            ? path.resolve(process.cwd(), overrideConfigPath)
            : ts.findConfigFile(dirName, ts.sys.fileExists);
        if (!configPath) {
            return { dtsFiles, dirName, compilerOptions };
        }
        const inputDirName = dirName;
        dirName = path.dirname(configPath);
        const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
        if (error) {
            console.error(ts.formatDiagnostic(error, formatHost));
            return { dtsFiles, dirName, compilerOptions };
        }
        logCache("tsconfig", config);
        const configContents = ts.parseJsonConfigFileContent(config, ts.sys, dirName);
        if (overrideConfigPath) {
            // if a custom config is provided, we always only use that one
            cacheConfig([overrideConfigPath, overrideConfigPath], configContents);
        }
        else {
            // cache the config for all directories between input and resolved config path
            cacheConfig([inputDirName, dirName], configContents);
        }
    }
    else {
        logCache("HIT", cacheKey);
    }
    const { fileNames, options, errors } = configByPath.get(cacheKey);
    dtsFiles = fileNames.filter((name) => DTS_EXTENSIONS.test(name));
    if (errors.length) {
        console.error(ts.formatDiagnostics(errors, formatHost));
        return { dtsFiles, dirName, compilerOptions };
    }
    return {
        dtsFiles,
        dirName,
        compilerOptions: {
            ...options,
            ...compilerOptions,
        },
    };
}
function createProgram$1(fileName, overrideOptions, tsconfig, enableDeclarationMap) {
    const { dtsFiles, compilerOptions } = getCompilerOptions(fileName, overrideOptions, tsconfig, enableDeclarationMap);
    return ts.createProgram([fileName].concat(Array.from(dtsFiles)), compilerOptions, ts.createCompilerHost(compilerOptions, true));
}
function createPrograms(input, overrideOptions, tsconfig, enableDeclarationMap) {
    const programs = [];
    const dtsFiles = new Set();
    let inputs = [];
    let dirName = "";
    let compilerOptions = {};
    for (let main of input) {
        if (DTS_EXTENSIONS.test(main)) {
            continue;
        }
        main = path.resolve(main);
        const options = getCompilerOptions(main, overrideOptions, tsconfig, enableDeclarationMap);
        options.dtsFiles.forEach(dtsFiles.add, dtsFiles);
        if (!inputs.length) {
            inputs.push(main);
            ({ dirName, compilerOptions } = options);
            continue;
        }
        if (options.dirName === dirName) {
            inputs.push(main);
        }
        else {
            const host = ts.createCompilerHost(compilerOptions, true);
            const program = ts.createProgram(inputs.concat(Array.from(dtsFiles)), compilerOptions, host);
            programs.push(program);
            inputs = [main];
            ({ dirName, compilerOptions } = options);
        }
    }
    if (inputs.length) {
        const host = ts.createCompilerHost(compilerOptions, true);
        const program = ts.createProgram(inputs.concat(Array.from(dtsFiles)), compilerOptions, host);
        programs.push(program);
    }
    return programs;
}

function getCodeFrame() {
    let codeFrameColumns = undefined;
    try {
        ({ codeFrameColumns } = require("@babel/code-frame"));
        return codeFrameColumns;
    }
    catch {
        try {
            const esmRequire = createRequire(import.meta.url);
            ({ codeFrameColumns } = esmRequire("@babel/code-frame"));
            return codeFrameColumns;
        }
        catch { }
    }
    return undefined;
}
function getLocation(node) {
    const sourceFile = node.getSourceFile();
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    return {
        start: { line: start.line + 1, column: start.character + 1 },
        end: { line: end.line + 1, column: end.character + 1 },
    };
}
function frameNode(node) {
    const codeFrame = getCodeFrame();
    const sourceFile = node.getSourceFile();
    const code = sourceFile.getFullText();
    const location = getLocation(node);
    if (codeFrame) {
        return ("\n" +
            codeFrame(code, location, {
                highlightCode: true,
            }));
    }
    else {
        return `\n${location.start.line}:${location.start.column}: \`${node.getFullText().trim()}\``;
    }
}
class UnsupportedSyntaxError extends Error {
    constructor(node, message = "Syntax not yet supported") {
        super(`${message}\n${frameNode(node)}`);
    }
}

class NamespaceFixer {
    sourceFile;
    constructor(sourceFile) {
        this.sourceFile = sourceFile;
    }
    findNamespaces() {
        const namespaces = [];
        const items = {};
        for (const node of this.sourceFile.statements) {
            const location = {
                start: node.getStart(),
                end: node.getEnd(),
            };
            // Well, this is a big hack:
            // For some global `namespace` and `module` declarations, we generate
            // some fake IIFE code, so rollup can correctly scan its scope.
            // However, rollup will then insert bogus semicolons,
            // these `EmptyStatement`s, which are a syntax error and we want to
            // remove them. Well, we do that here…
            if (ts.isEmptyStatement(node)) {
                namespaces.unshift({
                    name: "",
                    exports: [],
                    location,
                });
                continue;
            }
            // When generating multiple chunks, rollup links those via import
            // statements, obviously. But rollup uses full filenames with typescript extension,
            // which typescript does not like. So make sure to change those to javascript extension here.
            // `.d.ts` -> `.js`
            // `.d.cts` -> `.cjs`
            // `.d.mts` -> `.mjs`
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
                node.moduleSpecifier &&
                ts.isStringLiteral(node.moduleSpecifier)) {
                const { text } = node.moduleSpecifier;
                if (text.startsWith(".") && (text.endsWith(".d.ts") || text.endsWith(".d.cts") || text.endsWith(".d.mts"))) {
                    const start = node.moduleSpecifier.getStart() + 1; // +1 to account for the quote
                    const end = node.moduleSpecifier.getEnd() - 1; // -1 to account for the quote
                    namespaces.unshift({
                        name: "",
                        exports: [],
                        location: {
                            start,
                            end,
                        },
                        textBeforeCodeAfter: text
                            .replace(/\.d\.ts$/, ".js")
                            .replace(/\.d\.cts$/, ".cjs")
                            .replace(/\.d\.mts$/, ".mjs"),
                    });
                }
            }
            // Remove redundant `{ Foo as Foo }` exports from a namespace which we
            // added in pre-processing to fix up broken renaming
            if (ts.isModuleDeclaration(node) && node.body) {
                let body = node.body;
                // Traverse dotted namespace chain (e.g. `namespace A.B.C {}`)
                while (ts.isModuleDeclaration(body) && body.body) {
                    body = body.body;
                }
                if (!ts.isModuleBlock(body)) {
                    continue;
                }
                for (const stmt of body.statements) {
                    if (ts.isExportDeclaration(stmt) && stmt.exportClause) {
                        if (ts.isNamespaceExport(stmt.exportClause)) {
                            continue;
                        }
                        for (const decl of stmt.exportClause.elements) {
                            if (decl.propertyName && decl.propertyName.getText() == decl.name.getText()) {
                                namespaces.unshift({
                                    name: "",
                                    exports: [],
                                    location: {
                                        start: decl.propertyName.getEnd(),
                                        end: decl.name.getEnd(),
                                    },
                                });
                            }
                        }
                    }
                }
            }
            if (ts.isClassDeclaration(node)) {
                items[node.name.getText()] = { type: "class", generics: node.typeParameters };
            }
            else if (ts.isFunctionDeclaration(node)) {
                // a function has generics, but these don’t need to be specified explicitly,
                // since functions are treated as values.
                items[node.name.getText()] = { type: "function" };
            }
            else if (ts.isInterfaceDeclaration(node)) {
                items[node.name.getText()] = { type: "interface", generics: node.typeParameters };
            }
            else if (ts.isTypeAliasDeclaration(node)) {
                items[node.name.getText()] = { type: "type", generics: node.typeParameters };
            }
            else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
                items[node.name.getText()] = { type: "namespace" };
            }
            else if (ts.isEnumDeclaration(node)) {
                items[node.name.getText()] = { type: "enum" };
            }
            if (!ts.isVariableStatement(node)) {
                continue;
            }
            const { declarations } = node.declarationList;
            if (declarations.length !== 1) {
                continue;
            }
            const decl = declarations[0];
            const name = decl.name.getText();
            if (!decl.initializer || !ts.isCallExpression(decl.initializer)) {
                items[name] = { type: "var" };
                continue;
            }
            const obj = decl.initializer.arguments[0];
            if (!decl.initializer.expression.getFullText().includes("/*#__PURE__*/Object.freeze") ||
                !ts.isObjectLiteralExpression(obj)) {
                continue;
            }
            const exports = [];
            for (const prop of obj.properties) {
                if (!ts.isPropertyAssignment(prop) ||
                    !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ||
                    (prop.name.text !== "__proto__" && !ts.isIdentifier(prop.initializer))) {
                    throw new UnsupportedSyntaxError(prop, "Expected a property assignment");
                }
                if (prop.name.text === "__proto__") {
                    continue;
                }
                exports.push({
                    exportedName: prop.name.text,
                    localName: prop.initializer.getText(),
                });
            }
            // sort in reverse order, since we will do string manipulation
            namespaces.unshift({
                name,
                exports,
                location,
            });
        }
        return { namespaces, itemTypes: items };
    }
    fix() {
        let code = this.sourceFile.getFullText();
        const { namespaces, itemTypes } = this.findNamespaces();
        for (const ns of namespaces) {
            const codeAfter = code.slice(ns.location.end);
            code = code.slice(0, ns.location.start);
            for (const { exportedName, localName } of ns.exports) {
                if (exportedName === localName) {
                    const { type, generics } = itemTypes[localName] || {};
                    if (type === "interface" || type === "type") {
                        // an interface is just a type
                        const typeParams = renderTypeParams(generics);
                        code += `type ${ns.name}_${exportedName}${typeParams.in} = ${localName}${typeParams.out};\n`;
                    }
                    else if (type === "enum" || type === "class") {
                        // enums and classes are both types and values
                        const typeParams = renderTypeParams(generics);
                        code += `type ${ns.name}_${exportedName}${typeParams.in} = ${localName}${typeParams.out};\n`;
                        code += `declare const ${ns.name}_${exportedName}: typeof ${localName};\n`;
                    }
                    else if (type === "namespace") {
                        // namespaces may contain both types and values
                        code += `import ${ns.name}_${exportedName} = ${localName};\n`;
                    }
                    else {
                        // functions and vars are just values
                        code += `declare const ${ns.name}_${exportedName}: typeof ${localName};\n`;
                    }
                }
            }
            if (ns.name) {
                code += `declare namespace ${ns.name} {\n`;
                code += `  export {\n`;
                for (const { exportedName, localName } of ns.exports) {
                    if (exportedName === localName) {
                        code += `    ${ns.name}_${exportedName} as ${exportedName},\n`;
                    }
                    else {
                        code += `    ${localName} as ${exportedName},\n`;
                    }
                }
                code += `  };\n`;
                code += `}`;
            }
            code += ns.textBeforeCodeAfter ?? "";
            code += codeAfter;
        }
        return code;
    }
}
function renderTypeParams(typeParameters) {
    if (!typeParameters || !typeParameters.length) {
        return { in: "", out: "" };
    }
    return {
        in: `<${typeParameters.map((param) => param.getText()).join(", ")}>`,
        out: `<${typeParameters.map((param) => param.name.getText()).join(", ")}>`,
    };
}

let IDs = 1;
/**
 * Create a new `Program` for the given `node`:
 */
function createProgram(node) {
    return withStartEnd({
        type: "Program",
        sourceType: "module",
        body: [],
    }, { start: node.getFullStart(), end: node.getEnd() });
}
/**
 * Creates a reference to `id`:
 * `_ = ${id}`
 */
function createReference(id) {
    const ident = {
        type: "Identifier",
        name: String(IDs++),
    };
    return {
        ident,
        expr: {
            type: "AssignmentPattern",
            left: ident,
            right: id,
        },
    };
}
function createIdentifier(node) {
    return withStartEnd({
        type: "Identifier",
        name: node.text,
    }, node);
}
/**
 * Create a new Scope which is always included
 * `(function (_ = MARKER) {})()`
 */
function createIIFE(range) {
    const fn = withStartEnd({
        type: "FunctionExpression",
        id: null,
        params: [],
        body: { type: "BlockStatement", body: [] },
    }, range);
    const iife = withStartEnd({
        type: "ExpressionStatement",
        expression: {
            type: "CallExpression",
            callee: { type: "Identifier", name: String(IDs++) },
            arguments: [fn],
            optional: false,
        },
    }, range);
    return { fn, iife };
}
/**
 * Create a dummy ReturnStatement with an ArrayExpression:
 * `return [];`
 */
function createReturn() {
    const expr = {
        type: "ArrayExpression",
        elements: [],
    };
    return {
        expr,
        stmt: {
            type: "ReturnStatement",
            argument: expr,
        },
    };
}
/**
 * Create a new Declaration and Scope for `id`:
 * `function ${id}(_ = MARKER) {}`
 */
function createDeclaration(id, range) {
    return withStartEnd({
        type: "FunctionDeclaration",
        id: withStartEnd({
            type: "Identifier",
            name: ts.idText(id),
        }, id),
        params: [],
        body: { type: "BlockStatement", body: [] },
    }, range);
}
function convertExpression(node) {
    if (ts.isLiteralExpression(node)) {
        return { type: "Literal", value: node.text };
    }
    if (ts.isPropertyAccessExpression(node)) {
        if (ts.isPrivateIdentifier(node.name)) {
            throw new UnsupportedSyntaxError(node.name);
        }
        return withStartEnd({
            type: "MemberExpression",
            computed: false,
            optional: false,
            object: convertExpression(node.expression),
            property: convertExpression(node.name),
        }, {
            start: node.expression.getStart(),
            end: node.name.getEnd(),
        });
    }
    if (ts.isObjectLiteralExpression(node)) {
        return withStartEnd({
            type: "ObjectExpression",
            properties: node.properties.map((prop) => {
                if (ts.isPropertyAssignment(prop)) {
                    return withStartEnd({
                        type: "Property",
                        key: ts.isIdentifier(prop.name) ? createIdentifier(prop.name) : convertExpression(prop.name),
                        value: convertExpression(prop.initializer),
                        kind: "init",
                        method: false,
                        shorthand: false,
                        computed: ts.isComputedPropertyName(prop.name),
                    }, prop);
                }
                else if (ts.isShorthandPropertyAssignment(prop)) {
                    return withStartEnd({
                        type: "Property",
                        key: createIdentifier(prop.name),
                        value: createIdentifier(prop.name),
                        kind: "init",
                        method: false,
                        shorthand: true,
                        computed: false,
                    }, prop);
                }
                else {
                    throw new UnsupportedSyntaxError(prop, "Unsupported property type in object literal");
                }
            }),
        }, node);
    }
    if (ts.isArrayLiteralExpression(node)) {
        return withStartEnd({
            type: "ArrayExpression",
            elements: node.elements.map((elem) => {
                if (ts.isExpression(elem)) {
                    return convertExpression(elem);
                }
                else {
                    throw new UnsupportedSyntaxError(elem, "Unsupported element type in array literal");
                }
            }),
        }, node);
    }
    if (ts.isIdentifier(node)) {
        return createIdentifier(node);
    }
    else if (node.kind == ts.SyntaxKind.NullKeyword) {
        return { type: "Literal", value: null };
    }
    else {
        throw new UnsupportedSyntaxError(node);
    }
}
function withStartEnd(esNode, nodeOrRange) {
    const range = "start" in nodeOrRange ? nodeOrRange : { start: nodeOrRange.getStart(), end: nodeOrRange.getEnd() };
    return Object.assign(esNode, range);
}
function matchesModifier(node, flags) {
    const nodeFlags = ts.getCombinedModifierFlags(node);
    return (nodeFlags & flags) === flags;
}

class LanguageService {
    fileName = "index.d.ts";
    service;
    constructor(code) {
        const serviceHost = {
            getCompilationSettings: () => ({
                noEmit: true,
                noResolve: true,
                skipLibCheck: true,
                declaration: false,
                checkJs: false,
                declarationMap: false,
                target: ts.ScriptTarget.ESNext,
            }),
            getScriptFileNames: () => [this.fileName],
            getScriptVersion: () => "1",
            getScriptSnapshot: (fileName) => fileName === this.fileName
                ? ts.ScriptSnapshot.fromString(code)
                : undefined,
            getCurrentDirectory: () => "",
            getDefaultLibFileName: () => "",
            fileExists: (fileName) => fileName === this.fileName,
            readFile: (fileName) => fileName === this.fileName ? code : undefined,
        };
        this.service = ts.createLanguageService(serviceHost, ts.createDocumentRegistry(undefined, ""), ts.LanguageServiceMode.PartialSemantic);
    }
    findReferenceCount(node) {
        const referencedSymbols = this.service.findReferences(this.fileName, node.getStart());
        if (!referencedSymbols?.length) {
            return 0;
        }
        return referencedSymbols.reduce((total, symbol) => total + symbol.references.length, 0);
    }
}

class TypeOnlyFixer {
    rawCode;
    code;
    source;
    service;
    types = new Set();
    values = new Set();
    typeHints = new Map();
    reExportTypeHints = new Map();
    importNodes = [];
    exportNodes = [];
    constructor(fileName, rawCode) {
        this.rawCode = rawCode;
        this.source = parse(fileName, rawCode);
        this.code = new MagicString(rawCode);
    }
    fix() {
        this.analyze(this.source.statements);
        if (this.typeHints.size || this.reExportTypeHints.size) {
            this.service = new LanguageService(this.rawCode);
            this.importNodes.forEach((node) => this.fixTypeOnlyImport(node));
        }
        if (this.types.size) {
            this.exportNodes.forEach((node) => this.fixTypeOnlyExport(node));
        }
        return this.types.size
            ? {
                magicCode: this.code,
            }
            : {
                code: this.rawCode,
                map: null,
            };
    }
    fixTypeOnlyImport(node) {
        let hasRemoved = false;
        const typeImports = [];
        const valueImports = [];
        const specifier = node.moduleSpecifier.getText();
        const nameNode = node.importClause.name;
        const namedBindings = node.importClause.namedBindings;
        if (nameNode) {
            const name = nameNode.text;
            if (this.isTypeOnly(name)) {
                if (this.isUselessImport(nameNode)) {
                    hasRemoved = true;
                }
                else {
                    // import A from 'a';    ->   import type A from 'a';
                    typeImports.push(`import type ${name} from ${specifier};`);
                }
            }
            else {
                valueImports.push(`import ${name} from ${specifier};`);
            }
        }
        if (namedBindings && ts.isNamespaceImport(namedBindings)) {
            const name = namedBindings.name.text;
            if (this.isTypeOnly(name)) {
                if (this.isUselessImport(namedBindings.name)) {
                    hasRemoved = true;
                }
                else {
                    // import * as A from 'a';   ->   import type * as A from 'a';
                    typeImports.push(`import type * as ${name} from ${specifier};`);
                }
            }
            else {
                valueImports.push(`import * as ${name} from ${specifier};`);
            }
        }
        if (namedBindings && ts.isNamedImports(namedBindings)) {
            const typeNames = [];
            const valueNames = [];
            for (const element of namedBindings.elements) {
                if (this.isTypeOnly(element.name.text)) {
                    if (this.isUselessImport(element.name)) {
                        hasRemoved = true;
                    }
                    else {
                        // import { A as B } from 'a';   ->   import type { A as B } from 'a';
                        typeNames.push(element.getText());
                    }
                }
                else {
                    valueNames.push(element.getText());
                }
            }
            if (typeNames.length) {
                typeImports.push(`import type { ${typeNames.join(', ')} } from ${specifier};`);
            }
            if (valueNames.length) {
                valueImports.push(`import { ${valueNames.join(', ')} } from ${specifier};`);
            }
        }
        if (typeImports.length || hasRemoved) {
            this.code.overwrite(node.getStart(), node.getEnd(), [...valueImports, ...typeImports].join(`\n${getNodeIndent(node)}`));
        }
    }
    fixTypeOnlyExport(node) {
        const typeExports = [];
        const valueExports = [];
        const specifier = node.moduleSpecifier?.getText();
        if (ts.isNamespaceExport(node.exportClause)) {
            const name = node.exportClause.name.text;
            if (this.isReExportTypeOnly(name)) {
                // export * as A from 'a';   ->   export type * as A from 'a';
                typeExports.push(`export type * as ${name} from ${specifier};`);
            }
            else {
                valueExports.push(`export * as ${name} from ${specifier};`);
            }
        }
        if (ts.isNamedExports(node.exportClause)) {
            const typeNames = [];
            const valueNames = [];
            for (const element of node.exportClause.elements) {
                const name = element.propertyName?.text || element.name.text;
                const isType = node.moduleSpecifier
                    ? this.isReExportTypeOnly(element.name.text)
                    : this.isTypeOnly(name);
                if (isType) {
                    // export { A as B } from 'a';   ->   export type { A as B } from 'a';
                    typeNames.push(getExportSpecifierBinding(element));
                }
                else {
                    // export { A as B };   ->   export { A as B };
                    valueNames.push(element.getText());
                }
            }
            if (typeNames.length) {
                typeExports.push(`export type { ${typeNames.join(', ')} }${specifier ? ` from ${specifier}` : ''};`);
            }
            if (valueNames.length) {
                valueExports.push(`export { ${valueNames.join(', ')} }${specifier ? ` from ${specifier}` : ''};`);
            }
        }
        if (typeExports.length) {
            this.code.overwrite(node.getStart(), node.getEnd(), [...valueExports, ...typeExports].join(`\n${getNodeIndent(node)}`));
        }
    }
    analyze(nodes) {
        for (const node of nodes) {
            if (ts.isImportDeclaration(node) && node.importClause) {
                this.importNodes.push(node);
                continue;
            }
            if (ts.isExportDeclaration(node) && node.exportClause) {
                this.exportNodes.push(node);
                continue;
            }
            if (ts.isInterfaceDeclaration(node)) {
                this.types.add(node.name.text);
                continue;
            }
            if (ts.isTypeAliasDeclaration(node)) {
                const alias = node.name.text;
                this.types.add(alias);
                /**
                 * TODO: type-only import/export fixer.
                 * Temporarily disable the type-only import/export transformation,
                 * because the current implementation is unsafe.
                 *
                 * Issue: https://github.com/Swatinem/rollup-plugin-dts/issues/340
                 */
                // if (ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName)) {
                //   const reference = node.type.typeName.text;
                //   const aliasHint = parseTypeOnlyName(alias);
                //   if(aliasHint.isTypeOnly) {
                //     this.DEBUG && console.log(`${reference} is a type (from type-only hint)`);
                //     this.types.add(reference);
                //     this.typeHints.set(reference, (this.typeHints.get(reference) || 0) + 1);
                //     if(aliasHint.isReExport) {
                //       const reExportName = alias.split(TYPE_ONLY_RE_EXPORT)[0]!
                //       this.DEBUG && console.log(`${reExportName} is a type (from type-only re-export hint)`);
                //       this.reExportTypeHints.set(reExportName, (this.reExportTypeHints.get(reExportName) || 0) + 1);
                //     }
                //     this.code.remove(node.getStart(), node.getEnd());
                //   }
                // }
                continue;
            }
            if (ts.isEnumDeclaration(node) ||
                ts.isFunctionDeclaration(node) ||
                ts.isClassDeclaration(node) ||
                ts.isVariableStatement(node)) {
                if (ts.isVariableStatement(node)) {
                    for (const declaration of node.declarationList.declarations) {
                        if (ts.isIdentifier(declaration.name)) {
                            this.values.add(declaration.name.text);
                        }
                    }
                }
                else {
                    if (node.name) {
                        this.values.add(node.name.text);
                    }
                }
                continue;
            }
            if (ts.isModuleBlock(node)) {
                this.analyze(node.statements);
                continue;
            }
            if (ts.isModuleDeclaration(node)) {
                if (node.name && ts.isIdentifier(node.name)) {
                    this.values.add(node.name.text);
                }
                this.analyze(node.getChildren());
                continue;
            }
        }
    }
    // The type-hint statements may lead to redundant import statements.
    // After type-hint statements been removed,
    // it is better to also remove these redundant import statements as well.
    // Of course, this is not necessary since it won't cause issues,
    // but it can make the output bundles cleaner :)
    isUselessImport(node) {
        // `referenceCount` contains it self.
        const referenceCount = this.service.findReferenceCount(node);
        const typeHintCount = this.typeHints.get(node.text);
        return (typeHintCount && typeHintCount + 1 >= referenceCount);
    }
    isTypeOnly(name) {
        return this.typeHints.has(name)
            || (this.types.has(name) && !this.values.has(name));
    }
    isReExportTypeOnly(name) {
        return this.reExportTypeHints.has(name);
    }
}
function getNodeIndent(node) {
    const match = node.getFullText().match(/^(?:\n*)([ ]*)/);
    return ' '.repeat(match?.[1]?.length || 0);
}
function getExportSpecifierBinding(element) {
    if (element.propertyName) {
        return `${element.propertyName.getText()} as ${element.name.getText()}`;
    }
    return element.name.getText();
}

const RESOLVED_MODULE_PREFIX = "dts-resolved:";
const RESOLVED_MODULE_COMMENT = new RegExp(`\\/\\*${RESOLVED_MODULE_PREFIX}(.+?)\\*\\/`);
/** Encode a resolved absolute path as a marker comment for later chunk resolution. */
function encodeResolvedModule(absolutePath) {
    return `/*${RESOLVED_MODULE_PREFIX}${absolutePath}*/`;
}
/** Decode a resolved module marker comment from text. Returns the absolute path, or null if not found. */
function decodeResolvedModule(text) {
    return text.match(RESOLVED_MODULE_COMMENT)?.[1] ?? null;
}
/** Strip the resolved module marker comment. */
function stripResolvedModuleComment(text) {
    return text.replace(RESOLVED_MODULE_COMMENT, "");
}
/** Normalize paths for comparison (handle Windows backslashes) */
function normalizePath(p) {
    return p.split("\\").join("/");
}
/** Collect the names declared at the top level of an augmentation body. */
function getAugmentedNames(body) {
    const names = [];
    for (const statement of body.statements) {
        if ((ts.isInterfaceDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isFunctionDeclaration(statement) ||
            ts.isEnumDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement)) &&
            statement.name) {
            names.push(statement.name.text);
        }
        else if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) {
                    names.push(declaration.name.text);
                }
            }
        }
    }
    return names;
}
/**
 * Rewrites relative `declare module './x'` specifiers in bundled output so they point
 * at the chunk containing the target module, keeping module augmentations reachable
 * for consumers.
 *
 * preprocess resolves each relative specifier lexically against its source file's
 * directory and stamps it with a `dts-resolved:` marker comment that rides through
 * bundling attached to its declaration; this fixer decodes the marker, locates the
 * target chunk via Rollup's chunk metadata, and overwrites the specifier with a
 * chunk-relative path.
 *
 * The rewrite is skipped (original specifier kept + warning) when:
 * - the target module is not part of any output chunk (orphaned files, asset-style
 *   declarations) — a dangling specifier stays inert, while rewriting it would merge
 *   the augmentation into the wrong module;
 * - the target chunk does not export every augmented name unchanged (aliased
 *   re-exports, `Foo` → `Foo$1` deconfliction) — augmentation matches by exported
 *   name, so retargeting the specifier alone would desynchronize the two.
 *
 * Scope: only `./`/`../` specifiers are handled. Bare package names must be preserved
 * verbatim, since consumers resolve them by name. tsconfig-paths aliases
 * (`declare module "@/foo"`) are a known limitation — they cannot be resolved
 * lexically. Supporting them would mean: in preprocess, for specifiers matching a
 * `compilerOptions.paths` pattern (never for other bare names), resolve with
 * `ts.resolveModuleName` against the declaring file's compiler options (synchronous,
 * unlike the plugin context's `resolve`), skip `isExternalLibraryImport` results, and
 * stamp the resolved file name; the extension probe below already bridges the
 * remaining `.d.ts`-versus-`.ts` module id gap.
 */
class ModuleDeclarationFixer {
    code;
    sourcemap;
    source;
    chunkFileName;
    moduleToChunk;
    chunks;
    warn;
    constructor(chunk, code, sourcemap, moduleToChunk, chunks, warn) {
        this.code = code;
        this.sourcemap = sourcemap;
        // Parse the MagicString's original text, not toString(): the code may already
        // carry TypeOnlyFixer edits, but overwrite() coordinates always refer to the
        // original string, so node positions must come from that same text
        this.source = parse(chunk.fileName, code.original);
        this.chunkFileName = chunk.fileName;
        this.moduleToChunk = moduleToChunk;
        this.chunks = chunks;
        this.warn = warn;
    }
    fix() {
        let modified = false;
        for (const node of this.source.statements) {
            if (!ts.isModuleDeclaration(node) || !node.body || !ts.isModuleBlock(node.body)) {
                continue;
            }
            const sourceText = this.source.getFullText();
            const textBetween = sourceText.slice(node.name.getEnd(), node.body.getStart());
            const absolutePath = decodeResolvedModule(textBetween);
            if (!absolutePath) {
                continue;
            }
            const target = this.findTargetChunk(absolutePath);
            let specifier = node.name.getText();
            if (target === null) {
                // Keep the original specifier; consumers resolve it relative to the emitted
                // chunk, where it will typically dangle (a no-op augmentation) rather than
                // merge into the wrong module the way a current-chunk rewrite would
                this.warn(`declare module ${specifier} (${absolutePath}) could not be resolved to any output chunk, keeping the original specifier`);
            }
            else if (!this.augmentationApplies(getAugmentedNames(node.body), target.moduleId, target.chunkFileName)) {
                // Module augmentation matches by the target module's exported names; when the
                // chunk renamed, dropped, or ambiguously exports an augmented name, retargeting
                // the specifier would merge the augmentation into the wrong declaration
                this.warn(`declare module ${specifier} (${absolutePath}) augments names that the target chunk does not export unchanged, keeping the original specifier`);
            }
            else {
                const quote = node.name.kind === ts.SyntaxKind.StringLiteral && "singleQuote" in node.name && node.name.singleQuote
                    ? "'"
                    : '"';
                specifier = `${quote}${this.formatChunkReference(target.chunkFileName, target.jsExt)}${quote}`;
            }
            const cleanedBetween = stripResolvedModuleComment(textBetween);
            this.code.overwrite(node.name.getStart(), node.body.getStart(), specifier + cleanedBetween);
            modified = true;
        }
        return {
            code: this.code.toString(),
            map: modified && this.sourcemap ? this.code.generateMap() : null,
        };
    }
    /**
     * Find the output chunk containing the module at an absolute path.
     * Returns null when the module is not part of any output chunk.
     */
    findTargetChunk(absolutePath) {
        // Detect JS extension from the resolved path (present when the source uses ESM-style specifiers)
        const jsExtMatch = absolutePath.match(/\.[cm]?js$/);
        const basePath = jsExtMatch ? absolutePath.slice(0, -jsExtMatch[0].length) : absolutePath;
        // Try all file extensions that could appear as module IDs in Rollup's chunk metadata,
        // probing both the path itself and a directory index
        const extensions = ["", ".d.ts", ".d.mts", ".d.cts", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
        const possiblePaths = [];
        for (const base of [basePath, `${basePath}/index`]) {
            for (const ext of extensions) {
                possiblePaths.push(base + ext);
            }
        }
        // Find which chunk contains this module
        for (const possiblePath of possiblePaths) {
            const moduleId = normalizePath(possiblePath);
            const chunkFileName = this.moduleToChunk.get(moduleId);
            if (chunkFileName) {
                return { chunkFileName, moduleId, jsExt: jsExtMatch?.[0] };
            }
        }
        return null;
    }
    /**
     * Check that every augmented name is exported from the target chunk under its
     * original name. Augmentation matches by exported name, so a name the chunk
     * dropped, re-exported under an alias, or deconflicted (`Foo` → `Foo$1` when two
     * modules in the chunk export a `Foo`) would merge into the wrong declaration.
     */
    augmentationApplies(names, moduleId, chunkFileName) {
        const chunkInfo = this.chunks[chunkFileName];
        if (!chunkInfo) {
            return true;
        }
        const targetModule = Object.entries(chunkInfo.modules).find(([id]) => normalizePath(id) === moduleId)?.[1];
        return names.every((name) => {
            if (!targetModule?.renderedExports.includes(name) || !chunkInfo.exports.includes(name)) {
                return false;
            }
            // A `name$<digits>` sibling export means this name was deconflicted within the
            // chunk, and there is no way to tell which module's declaration kept the name
            const deconflicted = new RegExp(`^${name.replace(/\$/g, "\\$")}\\$\\d+$`);
            return !chunkInfo.exports.some((exportName) => deconflicted.test(exportName));
        });
    }
    /**
     * Format a chunk filename as a relative path from the current chunk.
     */
    formatChunkReference(chunkFileName, jsExt) {
        // Compute the relative path from the current chunk's directory to the target chunk
        const chunkDir = path.dirname(this.chunkFileName);
        let relativePath = normalizePath(path.relative(chunkDir, chunkFileName));
        // Strip declaration extension and apply JS extension if the source used one
        relativePath = relativePath.replace(/\.d\.[cm]?tsx?$/, "");
        if (jsExt) {
            relativePath += jsExt;
        }
        // Ensure it starts with "./"
        if (!relativePath.startsWith(".")) {
            relativePath = "./" + relativePath;
        }
        return relativePath;
    }
}

function preProcessNamespaceBody(body, code, sourceFile) {
    // Recurse through dotted namespace chain (e.g. `namespace A.B.C {}`)
    if (ts.isModuleDeclaration(body)) {
        if (body.body && (ts.isModuleBlock(body.body) || ts.isModuleDeclaration(body.body))) {
            preProcessNamespaceBody(body.body, code);
        }
        return;
    }
    for (const stmt of body.statements) {
        // Safely call the new context-aware function on all children
        fixModifiers(code, stmt);
        // Recurse for nested namespaces
        if (ts.isModuleDeclaration(stmt) && stmt.body && (ts.isModuleBlock(stmt.body) || ts.isModuleDeclaration(stmt.body))) {
            preProcessNamespaceBody(stmt.body, code);
        }
    }
}
/**
 * The pre-process step has the following goals:
 * - [x] Fixes the "modifiers", removing any `export` modifier and adding any
 *   missing `declare` modifier.
 * - [x] Splitting compound `VariableStatement` into its parts.
 * - [x] Moving declarations for the same "name" to be next to each other.
 * - [x] Removing any triple-slash directives and recording them.
 * - [x] Create a synthetic name for any nameless "export default".
 * - [x] Resolve inline `import()` statements and generate top-level imports for
 *   them.
 * - [x] Generate a separate `export {}` statement for any item which had its
 *   modifiers rewritten.
 * - [ ] Duplicate the identifiers of a namespace `export`, so that renaming does
 *   not break it
 */
function preProcess({ sourceFile, isEntry, isJSON }) {
    const code = new MagicString(sourceFile.getFullText());
    // Only treat as global module if it's not an entry point,
    // otherwise the final output will be mismatched with the entry.
    const treatAsGlobalModule = !isEntry && isGlobalModule(sourceFile);
    /** All the names that are declared in the `SourceFile`. */
    const declaredNames = new Set();
    /** All the names that are exported. */
    const exportedNames = new Set();
    /** The name of the default export. */
    let defaultExport = "";
    /** Inlined exports from `fileId` -> <synthetic name>. */
    const inlineImports = new Map();
    /** The ranges that each name covers, for re-ordering. */
    const nameRanges = new Map();
    /**
     * Pass 1:
     *
     * - Remove statements that we can’t handle.
     * - Collect a `Set` of all the declared names.
     * - Collect a `Set` of all the exported names.
     * - Maybe collect the name of the default export if present.
     * - Fix the modifiers of all the items.
     * - Collect the ranges of each named statement.
     * - Duplicate the identifiers of a namespace `export`, so that renaming does
     *   not break it
     */
    for (const node of sourceFile.statements) {
        if (ts.isEmptyStatement(node)) {
            code.remove(node.getStart(), node.getEnd());
            continue;
        }
        if (ts.isImportDeclaration(node)) {
            if (!node.importClause) {
                continue;
            }
            if (node.importClause.name) {
                declaredNames.add(node.importClause.name.text);
            }
            if (node.importClause.namedBindings) {
                if (ts.isNamespaceImport(node.importClause.namedBindings)) {
                    declaredNames.add(node.importClause.namedBindings.name.text);
                }
                else {
                    node.importClause.namedBindings.elements
                        .forEach((element) => declaredNames.add(element.name.text));
                }
            }
        }
        else if (ts.isEnumDeclaration(node) ||
            ts.isFunctionDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isModuleDeclaration(node)) {
            // collect the declared name
            if (node.name) {
                const name = node.name.getText();
                declaredNames.add(name);
                // collect the exported name, maybe as `default`.
                // `declare global` blocks are global augmentations, not actual exports.
                if (node.flags & ts.NodeFlags.GlobalAugmentation) ;
                else if (matchesModifier(node, ts.ModifierFlags.ExportDefault)) {
                    defaultExport = name;
                }
                else if ((treatAsGlobalModule && ts.isIdentifier(node.name))
                    || matchesModifier(node, ts.ModifierFlags.Export)) {
                    exportedNames.add(name);
                }
                if (!(node.flags & ts.NodeFlags.GlobalAugmentation)) {
                    pushNamedNode(name, [getStart(node), getEnd(node)]);
                }
            }
            // duplicate exports of namespaces
            if (ts.isModuleDeclaration(node)) {
                if (node.body && (ts.isModuleBlock(node.body) || ts.isModuleDeclaration(node.body))) {
                    preProcessNamespaceBody(node.body, code);
                }
                duplicateExports(code, node);
            }
            fixModifiers(code, node);
        }
        else if (ts.isVariableStatement(node)) {
            const { declarations } = node.declarationList;
            // collect all the names, also check if they are exported
            const isExport = matchesModifier(node, ts.ModifierFlags.Export);
            for (const decl of node.declarationList.declarations) {
                if (ts.isIdentifier(decl.name)) {
                    const name = decl.name.getText();
                    declaredNames.add(name);
                    if (treatAsGlobalModule || isExport) {
                        exportedNames.add(name);
                    }
                }
            }
            fixModifiers(code, node);
            // collect the ranges for re-ordering
            if (declarations.length === 1) {
                const decl = declarations[0];
                if (ts.isIdentifier(decl.name)) {
                    pushNamedNode(decl.name.getText(), [getStart(node), getEnd(node)]);
                }
            }
            else {
                // we do reordering after splitting
                const decls = declarations.slice();
                const first = decls.shift();
                pushNamedNode(first.name.getText(), [getStart(node), first.getEnd()]);
                for (const decl of decls) {
                    if (ts.isIdentifier(decl.name)) {
                        pushNamedNode(decl.name.getText(), [decl.getFullStart(), decl.getEnd()]);
                    }
                }
            }
            // split the variable declaration into different statements
            const { flags } = node.declarationList;
            const type = flags & ts.NodeFlags.Let ? "let" : flags & ts.NodeFlags.Const ? "const" : "var";
            const prefix = `declare ${type} `;
            const list = node.declarationList
                .getChildren()
                .find((c) => c.kind === ts.SyntaxKind.SyntaxList)
                .getChildren();
            let commaPos = 0;
            for (const node of list) {
                if (node.kind === ts.SyntaxKind.CommaToken) {
                    commaPos = node.getStart();
                    code.remove(commaPos, node.getEnd());
                }
                else if (commaPos) {
                    code.appendLeft(commaPos, ";\n");
                    const start = node.getFullStart();
                    const slice = code.slice(start, node.getStart());
                    const whitespace = slice.length - slice.trimStart().length;
                    if (whitespace) {
                        code.overwrite(start, start + whitespace, prefix);
                    }
                    else {
                        code.appendLeft(start, prefix);
                    }
                }
            }
        }
    }
    /**
     * Pass 2:
     *
     * Now that we have a Set of all the declared names, we can use that to
     * generate and de-conflict names for the following steps:
     *
     * - Resolve all the inline imports.
     * - Give any name-less `default export` a name.
     */
    for (const node of sourceFile.statements) {
        // recursively check inline imports
        checkInlineImport(node);
        /**
         * TODO: type-only import/export fixer.
         * Temporarily disable the type-only import/export transformation,
         * because the current implementation is unsafe.
         *
         * Issue: https://github.com/Swatinem/rollup-plugin-dts/issues/340
         */
        // transformTypeOnlyImport(node);
        // transformTypeOnlyExport(node);
        // Handle export default with object/array literals
        // These need to be converted to named declarations so Rollup can track references within them
        if (ts.isExportAssignment(node) && !node.isExportEquals) {
            if (ts.isObjectLiteralExpression(node.expression) || ts.isArrayLiteralExpression(node.expression)) {
                if (!defaultExport) {
                    defaultExport = uniqName("export_default");
                }
                // Replace "export default" with "declare var export_default ="
                code.overwrite(node.getStart(), node.expression.getStart(), `declare var ${defaultExport} = `);
                continue;
            }
        }
        if (!matchesModifier(node, ts.ModifierFlags.ExportDefault)) {
            continue;
        }
        // only function and class can be default exported, and be missing a name
        if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
            if (node.name) {
                continue;
            }
            if (!defaultExport) {
                defaultExport = uniqName("export_default");
            }
            const children = node.getChildren();
            const idx = children.findIndex((node) => node.kind === ts.SyntaxKind.ClassKeyword || node.kind === ts.SyntaxKind.FunctionKeyword);
            const token = children[idx];
            const nextToken = children[idx + 1];
            const isPunctuation = nextToken.kind >= ts.SyntaxKind.FirstPunctuation && nextToken.kind <= ts.SyntaxKind.LastPunctuation;
            if (isPunctuation) {
                const addSpace = code.slice(token.getEnd(), nextToken.getStart()) != " ";
                code.appendLeft(nextToken.getStart(), `${addSpace ? " " : ""}${defaultExport}`);
            }
            else {
                code.appendRight(token.getEnd(), ` ${defaultExport}`);
            }
        }
    }
    // and re-order all the name ranges to be contiguous
    for (const ranges of nameRanges.values()) {
        // we have to move all the nodes in front of the *last* one, which is a bit
        // unintuitive but is a workaround for:
        // https://github.com/Rich-Harris/magic-string/issues/180
        const last = ranges.pop();
        const start = last[0];
        for (const node of ranges) {
            code.move(node[0], node[1], start);
        }
    }
    // render all the inline imports, and all the exports
    if (defaultExport) {
        code.append(`\nexport default ${defaultExport};\n`);
    }
    if (exportedNames.size) {
        code.append(`\nexport { ${[...exportedNames].join(", ")} };\n`);
    }
    if (isJSON && exportedNames.size) {
        /**
         * Add default export for JSON modules.
         *
         * The typescript compiler only generate named exports for each top-level key,
         * but we also need a default export for JSON modules in most cases.
         * This also aligns with the behavior of `@rollup/plugin-json`.
         */
        defaultExport = uniqName("export_default");
        code.append([
            `\ndeclare const ${defaultExport}: {`,
            [...exportedNames].map(name => `  ${name}: typeof ${name};`).join("\n"),
            `};`,
            `export default ${defaultExport};\n`
        ].join('\n'));
    }
    for (const [fileId, importName] of inlineImports.entries()) {
        code.prepend(`import * as ${importName} from "${fileId}";\n`);
    }
    const lineStarts = sourceFile.getLineStarts();
    // and collect/remove all the typeReferenceDirectives
    const typeReferences = new Set();
    for (const ref of sourceFile.typeReferenceDirectives) {
        typeReferences.add(ref.fileName);
        const { line } = sourceFile.getLineAndCharacterOfPosition(ref.pos);
        const start = lineStarts[line];
        let end = sourceFile.getLineEndOfPosition(ref.pos);
        if (code.slice(end, end + 1) === "\n") {
            end += 1;
        }
        code.remove(start, end);
    }
    // and collect/remove all the fileReferenceDirectives
    const fileReferences = new Set();
    for (const ref of sourceFile.referencedFiles) {
        fileReferences.add(ref.fileName);
        const { line } = sourceFile.getLineAndCharacterOfPosition(ref.pos);
        const start = lineStarts[line];
        let end = sourceFile.getLineEndOfPosition(ref.pos);
        if (code.slice(end, end + 1) === "\n") {
            end += 1;
        }
        code.remove(start, end);
    }
    // Resolve relative module declarations to absolute paths
    // This allows correct chunk resolution later even when files from different
    // directories are bundled together
    //
    // Deliberately limited to `./` / `../` specifiers: bare names (`declare module "vue"`)
    // must stay untouched since consumers resolve them by package name, and tsconfig-paths
    // aliases cannot be resolved lexically (see ModuleDeclarationFixer for the full
    // mechanism and what alias support would require)
    const sourceDir = path.dirname(sourceFile.fileName);
    for (const node of sourceFile.statements) {
        if (ts.isModuleDeclaration(node) &&
            node.body &&
            ts.isModuleBlock(node.body) &&
            ts.isStringLiteral(node.name) &&
            /^\.\.?\//.test(node.name.text)) {
            const resolvedPath = path.resolve(sourceDir, node.name.text);
            code.appendRight(node.name.getEnd(), encodeResolvedModule(resolvedPath));
        }
    }
    // Strip trailing sourceMappingURL comments so they don't leak into bundled output
    const fullText = sourceFile.getFullText();
    // Check EOF token's leading trivia (comment on its own line after last statement)
    // and last statement's trailing trivia (comment on same line as last statement)
    const eofTrivia = ts.getLeadingCommentRanges(fullText, sourceFile.endOfFileToken.getFullStart());
    const lastStatement = sourceFile.statements[sourceFile.statements.length - 1];
    const trailingTrivia = lastStatement
        ? ts.getTrailingCommentRanges(fullText, lastStatement.getEnd())
        : undefined;
    for (const comment of [...(eofTrivia ?? []), ...(trailingTrivia ?? [])]) {
        // Skip block comments — sourceMappingURL text inside /** */ must not be stripped
        if (comment.kind !== ts.SyntaxKind.SingleLineCommentTrivia)
            continue;
        const text = fullText.slice(comment.pos, comment.end);
        if (!/^\/\/[#@]\s*sourceMappingURL=/.test(text))
            continue;
        let start = comment.pos;
        if (start > 0 && fullText[start - 1] === "\n") {
            start -= 1;
        }
        code.remove(start, comment.end);
        break;
    }
    return {
        code,
        typeReferences,
        fileReferences,
    };
    function checkInlineImport(node) {
        ts.forEachChild(node, checkInlineImport);
        if (ts.isImportTypeNode(node)) {
            if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal)) {
                throw new UnsupportedSyntaxError(node, "inline imports should have a literal argument");
            }
            const fileId = node.argument.literal.text;
            const children = node.getChildren();
            const start = children.find((t) => t.kind === ts.SyntaxKind.ImportKeyword).getStart();
            let end = node.getEnd();
            const token = children.find((t) => t.kind === ts.SyntaxKind.DotToken || t.kind === ts.SyntaxKind.LessThanToken);
            if (token) {
                end = token.getStart();
            }
            const importName = createNamespaceImport(fileId);
            code.overwrite(start, end, importName);
        }
    }
    function createNamespaceImport(fileId) {
        let importName = inlineImports.get(fileId);
        if (!importName) {
            importName = uniqName(getSafeName(fileId));
            inlineImports.set(fileId, importName);
        }
        return importName;
    }
    function uniqName(hint) {
        let name = hint;
        while (declaredNames.has(name)) {
            name = `_${name}`;
        }
        declaredNames.add(name);
        return name;
    }
    function pushNamedNode(name, range) {
        let nodes = nameRanges.get(name);
        if (!nodes) {
            nodes = [range];
            nameRanges.set(name, nodes);
        }
        else {
            const last = nodes[nodes.length - 1];
            if (last[1] === range[0]) {
                last[1] = range[1];
            }
            else {
                nodes.push(range);
            }
        }
    }
}
/**
 * If the `SourceFile` is a "global module":
 *
 * 1. Doesn't have any top-level `export {}` or `export default` statements,
 *    otherwise it's a "scoped module".
 *
 * 2. Should have at least one top-level `import` or `export` statement,
 *    otherwise it's not a module.
 *
 * Issue: https://github.com/Swatinem/rollup-plugin-dts/issues/334
 */
function isGlobalModule(sourceFile) {
    let isModule = false;
    for (const node of sourceFile.statements) {
        if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
            return false;
        }
        if (isModule || ts.isImportDeclaration(node) || matchesModifier(node, ts.ModifierFlags.Export)) {
            isModule = true;
        }
    }
    return isModule;
}
function fixModifiers(code, node) {
    // remove the `export` and `default` modifier, add a `declare` if its missing.
    if (!ts.canHaveModifiers(node)) {
        return;
    }
    const isTopLevel = node.parent.kind === ts.SyntaxKind.SourceFile;
    if (isTopLevel) {
        // For top-level statements, remove `export`/`default` and ensure `declare` exists
        let hasDeclare = false;
        const needsDeclare = ts.isEnumDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isFunctionDeclaration(node) ||
            ts.isModuleDeclaration(node) ||
            ts.isVariableStatement(node);
        for (const mod of node.modifiers ?? []) {
            switch (mod.kind) {
                case ts.SyntaxKind.ExportKeyword: // fall through
                case ts.SyntaxKind.DefaultKeyword:
                    // TODO: be careful about that `+ 1`
                    code.remove(mod.getStart(), mod.getEnd() + 1);
                    break;
                case ts.SyntaxKind.DeclareKeyword:
                    hasDeclare = true;
            }
        }
        if (needsDeclare && !hasDeclare) {
            code.appendRight(node.getStart(), "declare ");
        }
    }
    // For statements inside namespaces, preserve all modifiers (including export)
}
function duplicateExports(code, module) {
    if (!module.body) {
        return;
    }
    // Recurse through dotted namespace chain
    if (ts.isModuleDeclaration(module.body)) {
        duplicateExports(code, module.body);
        return;
    }
    if (!ts.isModuleBlock(module.body)) {
        return;
    }
    for (const node of module.body.statements) {
        if (ts.isExportDeclaration(node) && node.exportClause) {
            if (ts.isNamespaceExport(node.exportClause)) {
                continue;
            }
            for (const decl of node.exportClause.elements) {
                if (!decl.propertyName) {
                    code.appendLeft(decl.name.getEnd(), ` as ${decl.name.getText()}`);
                }
            }
        }
    }
}
function getSafeName(fileId) {
    return fileId.replace(/[^a-zA-Z0-9_$]/g, () => "_");
}
function getStart(node) {
    const start = node.getFullStart();
    return start + (newlineAt(node, start) ? 1 : 0);
}
function getEnd(node) {
    const end = node.getEnd();
    return end + (newlineAt(node, end) ? 1 : 0);
}
function newlineAt(node, idx) {
    return node.getSourceFile().getFullText()[idx] === "\n";
}

const IGNORE_TYPENODES = new Set([
    ts.SyntaxKind.LiteralType,
    ts.SyntaxKind.VoidKeyword,
    ts.SyntaxKind.UnknownKeyword,
    ts.SyntaxKind.AnyKeyword,
    ts.SyntaxKind.BooleanKeyword,
    ts.SyntaxKind.NumberKeyword,
    ts.SyntaxKind.StringKeyword,
    ts.SyntaxKind.ObjectKeyword,
    ts.SyntaxKind.NullKeyword,
    ts.SyntaxKind.UndefinedKeyword,
    ts.SyntaxKind.SymbolKeyword,
    ts.SyntaxKind.NeverKeyword,
    ts.SyntaxKind.ThisKeyword,
    ts.SyntaxKind.ThisType,
    ts.SyntaxKind.BigIntKeyword,
]);
class DeclarationScope {
    declaration;
    iife;
    returnExpr;
    constructor({ id, range }) {
        if (id) {
            this.declaration = createDeclaration(id, range);
        }
        else {
            const { iife, fn } = createIIFE(range);
            this.iife = iife;
            this.declaration = fn;
        }
        const ret = createReturn();
        this.declaration.body.body.push(ret.stmt);
        this.returnExpr = ret.expr;
    }
    /**
     * As we walk the AST, we need to keep track of type variable bindings that
     * shadow the outer identifiers. To achieve this, we keep a stack of scopes,
     * represented as Sets of variable names.
     */
    scopes = [];
    pushScope() {
        this.scopes.push(new Set());
    }
    popScope(n = 1) {
        for (let i = 0; i < n; i++) {
            this.scopes.pop();
        }
    }
    pushTypeVariable(id) {
        const name = id.getText();
        this.scopes[this.scopes.length - 1]?.add(name);
    }
    pushReference(id) {
        let name;
        // We convert references from TS AST to ESTree
        // to hand them off to rollup.
        // This means we have to check the left-most identifier inside our scope
        // tree and avoid to create the reference in that case
        if (id.type === "Identifier") {
            name = id.name;
        }
        else if (id.type === "MemberExpression") {
            if (id.object.type === "Identifier") {
                name = id.object.name;
            }
        }
        if (name) {
            for (const scope of this.scopes) {
                if (scope.has(name)) {
                    return;
                }
            }
        }
        // `this` is a reserved keyword that retrains meaning in certain Type-only contexts, including classes
        if (name === "this")
            return;
        const { ident, expr } = createReference(id);
        this.declaration.params.push(expr);
        this.returnExpr.elements.push(ident);
    }
    pushIdentifierReference(id) {
        this.pushReference(createIdentifier(id));
    }
    convertEntityName(node) {
        if (ts.isIdentifier(node)) {
            return createIdentifier(node);
        }
        return withStartEnd({
            type: "MemberExpression",
            computed: false,
            optional: false,
            object: this.convertEntityName(node.left),
            property: createIdentifier(node.right),
        }, node);
    }
    convertPropertyAccess(node) {
        // hm, we only care about property access expressions here…
        if (!ts.isIdentifier(node.expression) && !ts.isPropertyAccessExpression(node.expression)) {
            throw new UnsupportedSyntaxError(node.expression);
        }
        if (ts.isPrivateIdentifier(node.name)) {
            throw new UnsupportedSyntaxError(node.name);
        }
        const object = ts.isIdentifier(node.expression)
            ? createIdentifier(node.expression)
            : this.convertPropertyAccess(node.expression);
        return withStartEnd({
            type: "MemberExpression",
            computed: false,
            optional: false,
            object,
            property: createIdentifier(node.name),
        }, node);
    }
    convertComputedPropertyName(node) {
        if (!node.name || !ts.isComputedPropertyName(node.name)) {
            return;
        }
        const { expression } = node.name;
        if (ts.isLiteralExpression(expression) || ts.isPrefixUnaryExpression(expression)) {
            return;
        }
        if (ts.isIdentifier(expression)) {
            return this.pushReference(createIdentifier(expression));
        }
        if (ts.isPropertyAccessExpression(expression)) {
            return this.pushReference(this.convertPropertyAccess(expression));
        }
        throw new UnsupportedSyntaxError(expression);
    }
    convertParametersAndType(node) {
        this.convertComputedPropertyName(node);
        const typeVariables = this.convertTypeParameters(node.typeParameters);
        for (const param of node.parameters) {
            this.convertTypeNode(param.type);
        }
        this.convertTypeNode(node.type);
        this.popScope(typeVariables);
    }
    convertHeritageClauses(node) {
        for (const heritage of node.heritageClauses || []) {
            for (const type of heritage.types) {
                this.pushReference(convertExpression(type.expression));
                this.convertTypeArguments(type);
            }
        }
    }
    convertTypeArguments(node) {
        if (!node.typeArguments) {
            return;
        }
        for (const arg of node.typeArguments) {
            this.convertTypeNode(arg);
        }
    }
    convertMembers(members) {
        for (const node of members) {
            if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isIndexSignatureDeclaration(node)) {
                if (ts.isPropertyDeclaration(node) && node.initializer && ts.isPropertyAccessExpression(node.initializer)) {
                    this.pushReference(this.convertPropertyAccess(node.initializer));
                }
                this.convertComputedPropertyName(node);
                this.convertTypeNode(node.type);
                continue;
            }
            if (ts.isMethodDeclaration(node) ||
                ts.isMethodSignature(node) ||
                ts.isConstructorDeclaration(node) ||
                ts.isConstructSignatureDeclaration(node) ||
                ts.isCallSignatureDeclaration(node) ||
                ts.isGetAccessorDeclaration(node) ||
                ts.isSetAccessorDeclaration(node)) {
                this.convertParametersAndType(node);
            }
            else {
                throw new UnsupportedSyntaxError(node);
            }
        }
    }
    convertTypeParameters(params) {
        if (!params) {
            return 0;
        }
        for (const node of params) {
            this.convertTypeNode(node.constraint);
            this.convertTypeNode(node.default);
            this.pushScope();
            this.pushTypeVariable(node.name);
        }
        return params.length;
    }
    convertTypeNode(node) {
        if (!node) {
            return;
        }
        if (IGNORE_TYPENODES.has(node.kind)) {
            return;
        }
        if (ts.isTypeReferenceNode(node)) {
            this.pushReference(this.convertEntityName(node.typeName));
            this.convertTypeArguments(node);
            return;
        }
        if (ts.isTypeLiteralNode(node)) {
            this.convertMembers(node.members);
            return;
        }
        if (ts.isArrayTypeNode(node)) {
            this.convertTypeNode(node.elementType);
            return;
        }
        if (ts.isTupleTypeNode(node)) {
            for (const type of node.elements) {
                this.convertTypeNode(type);
            }
            return;
        }
        if (ts.isNamedTupleMember(node) ||
            ts.isParenthesizedTypeNode(node) ||
            ts.isTypeOperatorNode(node) ||
            ts.isTypePredicateNode(node)) {
            this.convertTypeNode(node.type);
            return;
        }
        if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
            for (const type of node.types) {
                this.convertTypeNode(type);
            }
            return;
        }
        if (ts.isMappedTypeNode(node)) {
            const { typeParameter, type, nameType } = node;
            this.convertTypeNode(typeParameter.constraint);
            this.pushScope();
            this.pushTypeVariable(typeParameter.name);
            this.convertTypeNode(type);
            if (nameType) {
                this.convertTypeNode(nameType);
            }
            this.popScope();
            return;
        }
        if (ts.isConditionalTypeNode(node)) {
            this.convertTypeNode(node.checkType);
            this.pushScope();
            this.convertTypeNode(node.extendsType);
            this.convertTypeNode(node.trueType);
            this.convertTypeNode(node.falseType);
            this.popScope();
            return;
        }
        if (ts.isIndexedAccessTypeNode(node)) {
            this.convertTypeNode(node.objectType);
            this.convertTypeNode(node.indexType);
            return;
        }
        if (ts.isFunctionOrConstructorTypeNode(node)) {
            this.convertParametersAndType(node);
            return;
        }
        if (ts.isTypeQueryNode(node)) {
            const reference = this.convertEntityName(node.exprName);
            this.pushReference(reference);
            this.convertTypeArguments(node);
            return;
        }
        if (ts.isRestTypeNode(node)) {
            this.convertTypeNode(node.type);
            return;
        }
        if (ts.isOptionalTypeNode(node)) {
            this.convertTypeNode(node.type);
            return;
        }
        if (ts.isTemplateLiteralTypeNode(node)) {
            for (const span of node.templateSpans) {
                this.convertTypeNode(span.type);
            }
            return;
        }
        if (ts.isInferTypeNode(node)) {
            const { typeParameter } = node;
            this.convertTypeNode(typeParameter.constraint);
            this.pushTypeVariable(typeParameter.name);
            return;
        }
        else {
            throw new UnsupportedSyntaxError(node);
        }
    }
    convertNamespace(node, relaxedModuleBlock = false) {
        this.pushScope();
        if (relaxedModuleBlock && node.body && ts.isModuleDeclaration(node.body)) {
            this.convertNamespace(node.body, true);
            return;
        }
        if (!node.body || !ts.isModuleBlock(node.body)) {
            throw new UnsupportedSyntaxError(node, `namespace must have a "ModuleBlock" body.`);
        }
        const { statements } = node.body;
        // first, hoist all the declarations for correct shadowing
        for (const stmt of statements) {
            if (ts.isEnumDeclaration(stmt) ||
                ts.isFunctionDeclaration(stmt) ||
                ts.isClassDeclaration(stmt) ||
                ts.isInterfaceDeclaration(stmt) ||
                ts.isTypeAliasDeclaration(stmt) ||
                ts.isModuleDeclaration(stmt)) {
                if (stmt.name && ts.isIdentifier(stmt.name)) {
                    this.pushTypeVariable(stmt.name);
                }
                else {
                    throw new UnsupportedSyntaxError(stmt, "non-Identifier name not supported");
                }
                continue;
            }
            if (ts.isVariableStatement(stmt)) {
                for (const decl of stmt.declarationList.declarations) {
                    if (ts.isIdentifier(decl.name)) {
                        this.pushTypeVariable(decl.name);
                    }
                    else {
                        throw new UnsupportedSyntaxError(decl, "non-Identifier name not supported");
                    }
                }
                continue;
            }
            if (ts.isImportDeclaration(stmt)) {
                if (stmt.importClause) {
                    if (stmt.importClause.name) {
                        this.pushTypeVariable(stmt.importClause.name);
                    }
                    if (stmt.importClause.namedBindings) {
                        if (ts.isNamespaceImport(stmt.importClause.namedBindings)) {
                            this.pushTypeVariable(stmt.importClause.namedBindings.name);
                        }
                        else {
                            for (const el of stmt.importClause.namedBindings.elements) {
                                this.pushTypeVariable(el.name);
                            }
                        }
                    }
                }
                continue;
            }
            if (ts.isImportEqualsDeclaration(stmt)) {
                this.pushTypeVariable(stmt.name);
                continue;
            }
            if (ts.isExportDeclaration(stmt)) ;
            else {
                throw new UnsupportedSyntaxError(stmt, "namespace child (hoisting) not supported yet");
            }
        }
        // and then walk all the children like normal…
        for (const stmt of statements) {
            if (ts.isVariableStatement(stmt)) {
                for (const decl of stmt.declarationList.declarations) {
                    if (decl.type) {
                        this.convertTypeNode(decl.type);
                    }
                }
                continue;
            }
            if (ts.isFunctionDeclaration(stmt)) {
                this.convertParametersAndType(stmt);
                continue;
            }
            if (ts.isInterfaceDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
                const typeVariables = this.convertTypeParameters(stmt.typeParameters);
                this.convertHeritageClauses(stmt);
                this.convertMembers(stmt.members);
                this.popScope(typeVariables);
                continue;
            }
            if (ts.isTypeAliasDeclaration(stmt)) {
                const typeVariables = this.convertTypeParameters(stmt.typeParameters);
                this.convertTypeNode(stmt.type);
                this.popScope(typeVariables);
                continue;
            }
            if (ts.isModuleDeclaration(stmt)) {
                this.convertNamespace(stmt, relaxedModuleBlock);
                continue;
            }
            if (ts.isEnumDeclaration(stmt)) {
                // noop
                continue;
            }
            // handle imports in the walking pass
            if (ts.isImportDeclaration(stmt)) {
                // noop, already handled by hoisting
                continue;
            }
            if (ts.isImportEqualsDeclaration(stmt)) {
                if (ts.isEntityName(stmt.moduleReference)) {
                    this.pushReference(this.convertEntityName(stmt.moduleReference));
                }
                // we ignore `import foo = require(...)` as that is a module import
                continue;
            }
            if (ts.isExportDeclaration(stmt)) {
                if (stmt.exportClause) {
                    if (ts.isNamespaceExport(stmt.exportClause)) {
                        throw new UnsupportedSyntaxError(stmt.exportClause);
                    }
                    for (const decl of stmt.exportClause.elements) {
                        const id = decl.propertyName || decl.name;
                        this.pushIdentifierReference(id);
                    }
                }
            }
            else {
                throw new UnsupportedSyntaxError(stmt, "namespace child (walking) not supported yet");
            }
        }
        this.popScope();
    }
}

function convert({ sourceFile }) {
    const transformer = new Transformer(sourceFile);
    return transformer.transform();
}
class Transformer {
    sourceFile;
    ast;
    declarations = new Map();
    constructor(sourceFile) {
        this.sourceFile = sourceFile;
        this.ast = createProgram(sourceFile);
        for (const stmt of sourceFile.statements) {
            this.convertStatement(stmt);
        }
    }
    transform() {
        return {
            ast: this.ast,
        };
    }
    pushStatement(node) {
        this.ast.body.push(node);
    }
    createDeclaration(node, id) {
        const range = { start: node.getFullStart(), end: node.getEnd() };
        if (!id) {
            const scope = new DeclarationScope({ range });
            this.pushStatement(scope.iife);
            return scope;
        }
        const name = id.getText();
        // We have re-ordered and grouped declarations in `reorderStatements`,
        // so we can assume same-name statements are next to each other, so we just
        // bump the `end` range.
        const scope = new DeclarationScope({ id, range });
        const existingScope = this.declarations.get(name);
        if (existingScope) {
            existingScope.pushIdentifierReference(id);
            existingScope.declaration.end = range.end;
            // we possibly have other declarations, such as an ExportDeclaration in
            // between, which should also be updated to the correct start/end.
            const selfIdx = this.ast.body.findIndex((node) => node == existingScope.declaration);
            for (let i = selfIdx + 1; i < this.ast.body.length; i++) {
                const decl = this.ast.body[i];
                decl.start = decl.end = range.end;
            }
        }
        else {
            this.pushStatement(scope.declaration);
            this.declarations.set(name, scope);
        }
        return existingScope || scope;
    }
    convertStatement(node) {
        if (ts.isEnumDeclaration(node)) {
            return this.convertEnumDeclaration(node);
        }
        if (ts.isFunctionDeclaration(node)) {
            return this.convertFunctionDeclaration(node);
        }
        if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
            return this.convertClassOrInterfaceDeclaration(node);
        }
        if (ts.isTypeAliasDeclaration(node)) {
            return this.convertTypeAliasDeclaration(node);
        }
        if (ts.isVariableStatement(node)) {
            return this.convertVariableStatement(node);
        }
        if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
            return this.convertExportDeclaration(node);
        }
        if (ts.isModuleDeclaration(node)) {
            return this.convertNamespaceDeclaration(node);
        }
        if (node.kind === ts.SyntaxKind.NamespaceExportDeclaration) {
            // just ignore `export as namespace FOO` statements…
            return this.removeStatement(node);
        }
        if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
            return this.convertImportDeclaration(node);
        }
        else {
            throw new UnsupportedSyntaxError(node);
        }
    }
    removeStatement(node) {
        this.pushStatement(withStartEnd({
            type: "ExpressionStatement",
            expression: { type: "Literal", value: "pls remove me" },
        }, node));
    }
    convertNamespaceDeclaration(node) {
        // we want to keep `declare global` augmentations, and we want to
        // pull in all the things referenced inside.
        // so for this case, we need to figure out some way so that rollup does
        // the right thing and not rename these…
        const isGlobalAugmentation = node.flags & ts.NodeFlags.GlobalAugmentation;
        if (isGlobalAugmentation || !ts.isIdentifier(node.name)) {
            const scope = this.createDeclaration(node);
            scope.convertNamespace(node, true);
            return;
        }
        const scope = this.createDeclaration(node, node.name);
        scope.pushIdentifierReference(node.name);
        scope.convertNamespace(node, true);
    }
    convertEnumDeclaration(node) {
        const scope = this.createDeclaration(node, node.name);
        scope.pushIdentifierReference(node.name);
    }
    convertFunctionDeclaration(node) {
        if (!node.name) {
            throw new UnsupportedSyntaxError(node, "FunctionDeclaration should have a name");
        }
        const scope = this.createDeclaration(node, node.name);
        scope.pushIdentifierReference(node.name);
        scope.convertParametersAndType(node);
    }
    convertClassOrInterfaceDeclaration(node) {
        if (!node.name) {
            throw new UnsupportedSyntaxError(node, "ClassDeclaration / InterfaceDeclaration should have a name");
        }
        const scope = this.createDeclaration(node, node.name);
        const typeVariables = scope.convertTypeParameters(node.typeParameters);
        scope.convertHeritageClauses(node);
        scope.convertMembers(node.members);
        scope.popScope(typeVariables);
    }
    convertTypeAliasDeclaration(node) {
        /**
         * TODO: type-only import/export fixer.
         * Temporarily disable the type-only import/export transformation,
         * because the current implementation is unsafe.
         *
         * Issue: https://github.com/Swatinem/rollup-plugin-dts/issues/340
         */
        // if(parseTypeOnlyName(node.name.text).isTypeOnly) {
        //   this.pushStatement(convertTypeOnlyHintStatement(node))
        //   return
        // }
        const scope = this.createDeclaration(node, node.name);
        const typeVariables = scope.convertTypeParameters(node.typeParameters);
        scope.convertTypeNode(node.type);
        scope.popScope(typeVariables);
    }
    convertVariableStatement(node) {
        const { declarations } = node.declarationList;
        if (declarations.length !== 1) {
            throw new UnsupportedSyntaxError(node, "VariableStatement with more than one declaration not yet supported");
        }
        for (const decl of declarations) {
            if (!ts.isIdentifier(decl.name)) {
                throw new UnsupportedSyntaxError(node, "VariableDeclaration must have a name");
            }
            const scope = this.createDeclaration(node, decl.name);
            scope.convertTypeNode(decl.type);
            // Track references in the initializer (e.g., for object literals)
            if (decl.initializer) {
                this.trackExpressionReferences(decl.initializer, scope);
            }
        }
    }
    // Helper to track identifier references in expressions
    trackExpressionReferences(expr, scope) {
        if (ts.isIdentifier(expr)) {
            scope.pushIdentifierReference(expr);
        }
        else if (ts.isObjectLiteralExpression(expr)) {
            for (const prop of expr.properties) {
                if (ts.isShorthandPropertyAssignment(prop)) {
                    scope.pushIdentifierReference(prop.name);
                }
                else if (ts.isPropertyAssignment(prop)) {
                    this.trackExpressionReferences(prop.initializer, scope);
                }
            }
        }
        else if (ts.isArrayLiteralExpression(expr)) {
            for (const elem of expr.elements) {
                if (ts.isExpression(elem)) {
                    this.trackExpressionReferences(elem, scope);
                }
            }
        }
        else if (ts.isPropertyAccessExpression(expr)) {
            this.trackExpressionReferences(expr.expression, scope);
        }
    }
    convertExportDeclaration(node) {
        if (ts.isExportAssignment(node)) {
            this.pushStatement(withStartEnd({
                type: "ExportDefaultDeclaration",
                declaration: convertExpression(node.expression),
            }, node));
            return;
        }
        const source = node.moduleSpecifier ? convertExpression(node.moduleSpecifier) : undefined;
        if (!node.exportClause) {
            // export * from './other'
            this.pushStatement(withStartEnd({
                type: "ExportAllDeclaration",
                source,
                exported: null,
                attributes: [],
            }, node));
        }
        else if (ts.isNamespaceExport(node.exportClause)) {
            // export * as name from './other'
            this.pushStatement(withStartEnd({
                type: "ExportAllDeclaration",
                source,
                exported: createIdentifier(node.exportClause.name),
                attributes: [],
            }, node));
        }
        else {
            // export { name } from './other'
            const specifiers = [];
            for (const elem of node.exportClause.elements) {
                specifiers.push(this.convertExportSpecifier(elem));
            }
            this.pushStatement(withStartEnd({
                type: "ExportNamedDeclaration",
                declaration: null,
                specifiers,
                source,
                attributes: [],
            }, node));
        }
    }
    convertImportDeclaration(node) {
        if (ts.isImportEqualsDeclaration(node)) {
            if (ts.isEntityName(node.moduleReference)) {
                const scope = this.createDeclaration(node, node.name);
                scope.pushReference(scope.convertEntityName(node.moduleReference));
                return;
            }
            // assume its like `import default`
            if (!ts.isExternalModuleReference(node.moduleReference)) {
                throw new UnsupportedSyntaxError(node, "ImportEquals should have a literal source.");
            }
            this.pushStatement(withStartEnd({
                type: "ImportDeclaration",
                specifiers: [
                    {
                        type: "ImportDefaultSpecifier",
                        local: createIdentifier(node.name),
                    },
                ],
                source: convertExpression(node.moduleReference.expression),
                attributes: [],
            }, node));
            return;
        }
        const source = convertExpression(node.moduleSpecifier);
        const specifiers = node.importClause && node.importClause.namedBindings
            ? this.convertNamedImportBindings(node.importClause.namedBindings)
            : [];
        if (node.importClause && node.importClause.name) {
            specifiers.push({
                type: "ImportDefaultSpecifier",
                local: createIdentifier(node.importClause.name),
            });
        }
        this.pushStatement(withStartEnd({
            type: "ImportDeclaration",
            specifiers,
            source,
            attributes: [],
        }, node));
    }
    convertNamedImportBindings(node) {
        if (ts.isNamedImports(node)) {
            return node.elements.map((el) => {
                const local = createIdentifier(el.name);
                const imported = el.propertyName ? createIdentifier(el.propertyName) : local;
                return {
                    type: "ImportSpecifier",
                    local,
                    imported,
                };
            });
        }
        return [
            {
                type: "ImportNamespaceSpecifier",
                local: createIdentifier(node.name),
            },
        ];
    }
    convertExportSpecifier(node) {
        const exported = createIdentifier(node.name);
        return {
            type: "ExportSpecifier",
            exported: exported,
            local: node.propertyName ? createIdentifier(node.propertyName) : exported,
        };
    }
}

/**
 * Hydrate sparse sourcemap with detailed segments from input map.
 *
 * Problem: Rollup produces sparse mappings because this plugin uses a "virtual AST"
 * trick - it generates fake ESTree nodes with start/end positions but no token-level
 * detail. Standard sourcemap composition (@jridgewell/remapping) can only trace
 * existing segments through the chain, not add new ones.
 *
 * Solution: Use Rollup's sparse segments as "anchors" to find which source line
 * each output line came from, then copy ALL segments from that input line.
 * The column delta between anchor positions aligns the segments correctly.
 *
 * This enables Go-to-Definition to work for individual identifiers, not just line starts.
 */
function hydrateSourcemap(sparseMappings, inputMap, outputCode) {
    const sparseDecoded = decode(sparseMappings);
    const inputDecoded = decode(inputMap.mappings);
    const outputLines = outputCode.split("\n");
    const hydratedMappings = [];
    for (let outLine = 0; outLine < sparseDecoded.length; outLine += 1) {
        const sparseSegments = sparseDecoded[outLine];
        if (!sparseSegments || sparseSegments.length === 0) {
            hydratedMappings.push([]);
            continue;
        }
        // Use first mapped segment as anchor to find source line
        const anchor = sparseSegments.find((segment) => segment.length >= 4);
        if (!anchor) {
            hydratedMappings.push(sparseSegments);
            continue;
        }
        const [, srcIdx, srcLine] = anchor;
        if (srcIdx !== 0 || srcLine === undefined || srcLine < 0 || srcLine >= inputDecoded.length) {
            hydratedMappings.push(sparseSegments);
            continue;
        }
        const inputSegments = inputDecoded[srcLine];
        if (!inputSegments || inputSegments.length === 0) {
            hydratedMappings.push(sparseSegments);
            continue;
        }
        const anchorOutCol = anchor[0];
        const anchorSrcCol = anchor.length >= 4 ? anchor[3] : 0;
        const delta = anchorOutCol - (anchorSrcCol ?? 0);
        const outputLine = outputLines[outLine] || "";
        const hydratedSegments = [];
        for (const seg of inputSegments) {
            const adjustedCol = seg[0] + delta;
            // Sanity check: skip segments outside valid range
            if (adjustedCol < 0 || adjustedCol > outputLine.length)
                continue;
            if (seg.length === 5) {
                hydratedSegments.push([adjustedCol, seg[1], seg[2], seg[3], seg[4]]);
            }
            else if (seg.length === 4) {
                hydratedSegments.push([adjustedCol, seg[1], seg[2], seg[3]]);
            }
            else {
                hydratedSegments.push([adjustedCol]);
            }
        }
        // Sort by column (required by sourcemap spec)
        hydratedSegments.sort((a, b) => a[0] - b[0]);
        hydratedMappings.push(hydratedSegments);
    }
    return encode(hydratedMappings);
}
// Load sourcemap from inline data URL, file reference, or external .map file
async function loadInputSourcemap(info) {
    const { fileName, originalCode, inputMapText } = info;
    // Use pre-loaded map if available (from TypeScript emit of .ts files)
    if (inputMapText) {
        try {
            return JSON.parse(inputMapText);
        }
        catch {
            return null;
        }
    }
    // Try inline sourcemap (base64 or url-encoded data URL)
    // Note: TypeScript never emits inline declaration maps, but other tools might.
    // This is defensive code - low cost since convert.fromSource returns null for TS maps.
    const inlineConverter = convert$1.fromSource(originalCode);
    if (inlineConverter) {
        return inlineConverter.toObject();
    }
    // Try file reference (//# sourceMappingURL=foo.map)
    const readMap = async (mapFile) => {
        // Strip query string or fragment if present (e.g., "index.d.ts.map?v=12345" or "index.d.ts.map#hash")
        // Note: TypeScript doesn't add these, but other build tools might. Defensive code - trivial cost.
        const urlWithoutQuery = mapFile.split(/[?#]/)[0];
        const mapFilePath = path.resolve(path.dirname(fileName), urlWithoutQuery);
        return fs.readFile(mapFilePath, "utf8");
    };
    try {
        const fileConverter = await convert$1.fromMapFileSource(originalCode, readMap);
        if (fileConverter) {
            return fileConverter.toObject();
        }
    }
    catch {
        // File not found or parse error, try external .map
    }
    // Try external .map file (no comment in source)
    try {
        const mapContent = await fs.readFile(fileName + ".map", "utf8");
        return JSON.parse(mapContent);
    }
    catch {
        return null;
    }
}

function rewritePortableSharedChunkImportsInBundle(bundle, warn) {
    const chunks = Object.values(bundle).filter(isOutputChunk);
    const sharedChunks = chunks.filter((chunk) => !chunk.isEntry);
    if (sharedChunks.length === 0)
        return;
    const entryChunks = chunks.filter((chunk) => chunk.isEntry);
    const chunkGraph = new Map(chunks.map((chunk) => [
        chunk.fileName,
        {
            exports: chunk.exports,
            isEntry: chunk.isEntry,
        },
    ]));
    const analyses = new Map(chunks.map((chunk) => [chunk.fileName, analyzeChunk(chunk, chunkGraph)]));
    for (const chunk of entryChunks) {
        const analysis = analyses.get(chunk.fileName);
        const magicCode = new MagicString(chunk.code);
        let hasChanges = false;
        const unresolvedSymbols = new Set();
        for (const statement of analysis.importStatements) {
            const sharedChunk = sharedChunks.find((candidate) => getChunkImportSpecifier(chunk.fileName, candidate.fileName) === statement.moduleSpecifier);
            if (!sharedChunk) {
                continue;
            }
            const keptSpecifiers = [];
            const rewrittenSpecifiers = new Map();
            for (const specifier of statement.specifiers) {
                if (hasPublicHostRoute(analysis, statement.moduleSpecifier, specifier.importedName)) {
                    keptSpecifiers.push(specifier);
                    continue;
                }
                const hostCandidate = pickHostCandidate(entryChunks, analyses, chunk.fileName, sharedChunk.fileName, specifier);
                if (!hostCandidate) {
                    keptSpecifiers.push(specifier);
                    unresolvedSymbols.add(specifier.localName);
                    continue;
                }
                const hostSpecifier = getChunkImportSpecifier(chunk.fileName, hostCandidate.chunk.fileName);
                const hostImportSpecifiers = rewrittenSpecifiers.get(hostSpecifier) || [];
                hostImportSpecifiers.push({
                    importedName: hostCandidate.exportedName,
                    isTypeOnly: specifier.isTypeOnly || hostCandidate.isTypeOnly,
                    localName: specifier.localName,
                });
                rewrittenSpecifiers.set(hostSpecifier, hostImportSpecifiers);
            }
            if (!rewrittenSpecifiers.size) {
                continue;
            }
            const replacementStatements = [];
            if (keptSpecifiers.length) {
                replacementStatements.push(buildImportStatement(statement, keptSpecifiers, statement.moduleSpecifier, statement.quote));
            }
            const hostSpecifiers = Array.from(rewrittenSpecifiers.keys()).sort(compareStrings);
            for (const hostSpecifier of hostSpecifiers) {
                replacementStatements.push(buildImportStatement(statement, rewrittenSpecifiers.get(hostSpecifier), hostSpecifier, statement.quote));
            }
            magicCode.overwrite(statement.statement.getStart(), statement.statement.getEnd(), replacementStatements.join("\n"));
            hasChanges = true;
        }
        if (hasChanges) {
            applyChunkEdits(chunk, magicCode);
        }
        if (unresolvedSymbols.size) {
            warn(formatUnresolvedSharedTypeWarning(chunk.fileName, unresolvedSymbols));
        }
    }
}
function analyzeChunk(chunk, chunkGraph) {
    const source = parse(chunk.fileName, chunk.code);
    const importStatements = [];
    const importedBindings = new Map();
    const hostRoutesByModule = new Map();
    const starExports = [];
    for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement) &&
            !statement.importClause?.name &&
            ts.isStringLiteral(statement.moduleSpecifier) &&
            statement.importClause?.namedBindings &&
            ts.isNamedImports(statement.importClause.namedBindings)) {
            const moduleSpecifier = statement.moduleSpecifier.text;
            const quote = statement.moduleSpecifier.getText(source).startsWith('"') ? '"' : "'";
            const specifiers = statement.importClause.namedBindings.elements.map((element) => {
                const specifier = {
                    importedName: element.propertyName?.text || element.name.text,
                    isTypeOnly: element.isTypeOnly || statement.importClause?.isTypeOnly || false,
                    localName: element.name.text,
                };
                importedBindings.set(specifier.localName, {
                    importedName: specifier.importedName,
                    isTypeOnly: specifier.isTypeOnly,
                    moduleSpecifier,
                });
                return specifier;
            });
            importStatements.push({
                isTypeOnly: statement.importClause.isTypeOnly,
                moduleSpecifier,
                quote,
                specifiers,
                statement,
            });
            continue;
        }
        if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) {
            continue;
        }
        if (!statement.exportClause) {
            starExports.push(statement.moduleSpecifier.text);
            continue;
        }
        if (!ts.isNamedExports(statement.exportClause)) {
            continue;
        }
        for (const element of statement.exportClause.elements) {
            addHostExportRoute(hostRoutesByModule, statement.moduleSpecifier.text, element.propertyName?.text || element.name.text, {
                exportedName: element.name.text,
                isTypeOnly: statement.isTypeOnly || element.isTypeOnly,
            });
        }
    }
    for (const statement of source.statements) {
        if (!ts.isExportDeclaration(statement) ||
            statement.moduleSpecifier ||
            !statement.exportClause ||
            !ts.isNamedExports(statement.exportClause)) {
            continue;
        }
        for (const element of statement.exportClause.elements) {
            const localName = element.propertyName?.text || element.name.text;
            const binding = importedBindings.get(localName);
            if (!binding) {
                continue;
            }
            addHostExportRoute(hostRoutesByModule, binding.moduleSpecifier, binding.importedName, {
                exportedName: element.name.text,
                isTypeOnly: binding.isTypeOnly || statement.isTypeOnly || element.isTypeOnly,
            });
        }
    }
    for (const moduleSpecifier of starExports) {
        const sharedChunk = Array.from(chunkGraph.entries()).find(([candidateFileName, candidate]) => !candidate.isEntry && getChunkImportSpecifier(chunk.fileName, candidateFileName) === moduleSpecifier);
        if (!sharedChunk) {
            continue;
        }
        for (const exportedName of sharedChunk[1].exports) {
            if (exportedName === "default") {
                continue;
            }
            addHostExportRoute(hostRoutesByModule, moduleSpecifier, exportedName, {
                exportedName,
                isTypeOnly: false,
            });
        }
    }
    return {
        hostRoutesByModule,
        importStatements,
    };
}
const isOutputChunk = (chunk) => chunk.type === "chunk";
function pickHostCandidate(entryChunks, analyses, currentChunkFileName, sharedChunkFileName, specifier) {
    const candidates = [];
    for (const hostChunk of entryChunks) {
        if (hostChunk.fileName === currentChunkFileName) {
            continue;
        }
        const hostAnalysis = analyses.get(hostChunk.fileName);
        const sharedSpecifier = getChunkImportSpecifier(hostChunk.fileName, sharedChunkFileName);
        const routes = getHostExportRoutes(hostAnalysis, sharedSpecifier, specifier.importedName);
        for (const route of routes) {
            candidates.push({
                ...route,
                chunk: hostChunk,
            });
        }
    }
    candidates.sort((left, right) => {
        const leftMatchesLocal = left.exportedName === specifier.localName ? 0 : 1;
        const rightMatchesLocal = right.exportedName === specifier.localName ? 0 : 1;
        if (leftMatchesLocal !== rightMatchesLocal) {
            return leftMatchesLocal - rightMatchesLocal;
        }
        const fileNameOrder = compareStrings(left.chunk.fileName, right.chunk.fileName);
        if (fileNameOrder !== 0) {
            return fileNameOrder;
        }
        return compareStrings(left.exportedName, right.exportedName);
    });
    return candidates[0];
}
const getHostExportRoutes = (analysis, moduleSpecifier, importedName) => analysis.hostRoutesByModule.get(moduleSpecifier)?.get(importedName) || [];
const hasPublicHostRoute = (analysis, moduleSpecifier, importedName) => getHostExportRoutes(analysis, moduleSpecifier, importedName).length > 0;
const compareStrings = (left, right) => {
    if (left < right) {
        return -1;
    }
    if (left > right) {
        return 1;
    }
    return 0;
};
function addHostExportRoute(hostRoutesByModule, moduleSpecifier, importedName, route) {
    const routesByImportedName = hostRoutesByModule.get(moduleSpecifier) || new Map();
    const routes = routesByImportedName.get(importedName) || [];
    if (!routes.some((existing) => existing.exportedName === route.exportedName && existing.isTypeOnly === route.isTypeOnly)) {
        routes.push(route);
    }
    routesByImportedName.set(importedName, routes);
    hostRoutesByModule.set(moduleSpecifier, routesByImportedName);
}
function buildImportStatement(statement, specifiers, moduleSpecifier, quote) {
    const useTypeOnlyImport = statement.isTypeOnly || specifiers.every((specifier) => specifier.isTypeOnly);
    const importKeyword = useTypeOnlyImport ? "import type" : "import";
    const namedImports = specifiers
        .map((specifier) => {
        const prefix = !useTypeOnlyImport && specifier.isTypeOnly ? "type " : "";
        if (specifier.importedName === specifier.localName) {
            return `${prefix}${specifier.importedName}`;
        }
        return `${prefix}${specifier.importedName} as ${specifier.localName}`;
    })
        .join(", ");
    return `${importKeyword} { ${namedImports} } from ${quote}${moduleSpecifier}${quote};`;
}
function applyChunkEdits(chunk, code) {
    const nextCode = code.toString();
    if (nextCode === chunk.code) {
        return;
    }
    if (chunk.map) {
        const chunkFileName = normalizeChunkPath(chunk.fileName);
        const rewriteMap = code.generateMap({
            file: chunkFileName,
            hires: true,
            includeContent: true,
            source: chunkFileName,
        });
        const remapped = remapping(rewriteMap, (file) => {
            if (normalizeChunkPath(file) === chunkFileName) {
                return chunk.map;
            }
            return null;
        });
        chunk.map = {
            ...chunk.map,
            mappings: typeof remapped.mappings === "string" ? remapped.mappings : "",
            names: remapped.names || [],
            sources: remapped.sources,
        };
        delete chunk.map.sourcesContent;
    }
    chunk.code = nextCode;
}
const formatUnresolvedSharedTypeWarning = (chunkFileName, symbols) => {
    const symbolList = Array.from(symbols).sort().join(", ");
    return [
        `Entry "${chunkFileName}" still references private shared type exports with no public re-export: ${symbolList}.`,
        "rollup-plugin-dts will not invent new public exports for these types.",
        "Re-export them from a public entry to avoid downstream TS2742 errors.",
    ].join(" ");
};
const getChunkImportSpecifier = (fromChunkFileName, toChunkFileName) => {
    const fromDir = path.posix.dirname(normalizeChunkPath(fromChunkFileName));
    const toRuntimeFileName = getChunkRuntimeFileName(normalizeChunkPath(toChunkFileName));
    let relativePath = path.posix.relative(fromDir, toRuntimeFileName);
    if (!relativePath.startsWith(".")) {
        relativePath = `./${relativePath}`;
    }
    return relativePath;
};
const getChunkRuntimeFileName = (fileName) => {
    if (fileName.endsWith(".d.mts")) {
        return `${fileName.slice(0, -6)}.mjs`;
    }
    if (fileName.endsWith(".d.cts")) {
        return `${fileName.slice(0, -6)}.cjs`;
    }
    if (fileName.endsWith(".d.ts")) {
        return `${fileName.slice(0, -5)}.js`;
    }
    return `${fileName}.js`;
};
const normalizeChunkPath = (fileName) => fileName.replaceAll("\\", "/");

/**
 * This is the *transform* part of `rollup-plugin-dts`.
 *
 * It sets a few input and output options, and otherwise is the core part of the
 * plugin responsible for bundling `.d.ts` files.
 *
 * That itself is a multi-step process:
 *
 * 1. The plugin has a preprocessing step that moves code around and cleans it
 *    up a bit, so that later steps can work with it easier. See `preprocess.ts`.
 * 2. It then converts the TypeScript AST into a ESTree-like AST that rollup
 *    understands. See `Transformer.ts`.
 * 3. After rollup is finished, the plugin will postprocess the output in a
 *    `renderChunk` hook. As rollup usually outputs javascript, it can output
 *    some code that is invalid in the context of a `.d.ts` file. In particular,
 *    the postprocess convert any javascript code that was created for namespace
 *    exports into TypeScript namespaces. See `NamespaceFixer.ts`.
 */
const transform = (enableSourcemap) => {
    const allTypeReferences = new Map();
    const allFileReferences = new Map();
    // Track pending sourcemaps to load lazily in generateBundle
    const pendingSourcemaps = new Map();
    return {
        name: "dts-transform",
        buildStart() {
            // Clear state for watch mode rebuilds
            allTypeReferences.clear();
            allFileReferences.clear();
            pendingSourcemaps.clear();
        },
        options({ onLog, ...options }) {
            return {
                ...options,
                onLog(level, log, defaultHandler) {
                    if (level === "warn" && log.code === "CIRCULAR_DEPENDENCY") {
                        return;
                    }
                    if (onLog) {
                        onLog(level, log, defaultHandler);
                    }
                    else {
                        defaultHandler(level, log);
                    }
                },
                treeshake: {
                    moduleSideEffects: "no-external",
                    propertyReadSideEffects: true,
                    unknownGlobalSideEffects: false,
                },
            };
        },
        outputOptions(options) {
            return {
                ...options,
                chunkFileNames: options.chunkFileNames || "[name]-[hash].d.ts",
                entryFileNames: options.entryFileNames || "[name].d.ts",
                format: "es",
                exports: "named",
                compact: false,
                freeze: true,
                interop: "esModule",
                generatedCode: Object.assign({ symbols: false }, options.generatedCode),
                strict: false,
            };
        },
        transform(code, fileName, inputMapTextOrOptions) {
            // `fileName` may not match the name in the moduleIds,
            // as we generate the `fileName` manually in the previews step,
            // so we need to find the correct moduleId.
            const name = trimExtension(fileName);
            const moduleIds = this.getModuleIds();
            const moduleId = Array.from(moduleIds).find((id) => trimExtension(id) === name);
            const isEntry = Boolean(moduleId && this.getModuleInfo(moduleId)?.isEntry);
            const isJSON = Boolean(moduleId && JSON_EXTENSIONS.test(moduleId));
            const inputMapText = typeof inputMapTextOrOptions === "string" ? inputMapTextOrOptions : undefined;
            // Preserve original code for loadInputSourcemap() before preProcess strips sourceMappingURL
            const rawCode = code;
            let sourceFile = parse(fileName, code);
            const preprocessed = preProcess({ sourceFile, isEntry, isJSON });
            // `sourceFile.fileName` here uses forward slashes
            allTypeReferences.set(sourceFile.fileName, preprocessed.typeReferences);
            allFileReferences.set(sourceFile.fileName, preprocessed.fileReferences);
            code = preprocessed.code.toString();
            sourceFile = parse(fileName, code);
            const converted = convert({ sourceFile });
            if (process.env.DTS_DUMP_AST) {
                console.log(fileName);
                console.log(code);
                console.log(JSON.stringify(converted.ast.body, undefined, 2));
            }
            if (!enableSourcemap) {
                return { code, ast: converted.ast, map: null };
            }
            // hires:true generates per-character mappings instead of per-line.
            // Without this, Go-to-Definition jumps to line starts instead of identifiers.
            const map = preprocessed.code.generateMap({ hires: true, source: fileName });
            // Store info for lazy sourcemap loading in generateBundle
            // For .d.ts files: will look for external .d.ts.map file
            // For .ts files compiled via generateDts(): inputMapText contains the in-memory map
            if (DTS_EXTENSIONS.test(fileName)) {
                pendingSourcemaps.set(fileName, {
                    fileName,
                    originalCode: rawCode,
                    inputMapText,
                });
            }
            return { code, ast: converted.ast, map };
        },
        renderChunk(inputCode, chunk, options, meta) {
            const source = parse(chunk.fileName, inputCode);
            const fixer = new NamespaceFixer(source);
            const typeReferences = new Set();
            const fileReferences = new Set();
            for (const fileName of Object.keys(chunk.modules)) {
                for (const ref of allTypeReferences.get(fileName.split("\\").join("/")) || []) {
                    typeReferences.add(ref);
                }
                for (const ref of allFileReferences.get(fileName.split("\\").join("/")) || []) {
                    if (ref.startsWith(".")) {
                        // Need absolute path of the target file here
                        const absolutePathToOriginal = path.join(path.dirname(fileName), ref);
                        const chunkFolder = (options.file && path.dirname(options.file)) ||
                            (chunk.facadeModuleId && path.dirname(chunk.facadeModuleId)) ||
                            ".";
                        let targetRelPath = path.relative(chunkFolder, absolutePathToOriginal).split("\\").join("/");
                        if (targetRelPath[0] !== ".") {
                            targetRelPath = "./" + targetRelPath;
                        }
                        fileReferences.add(targetRelPath);
                    }
                    else {
                        fileReferences.add(ref);
                    }
                }
            }
            let code = writeBlock(Array.from(fileReferences, (ref) => `/// <reference path="${ref}" />`));
            code += writeBlock(Array.from(typeReferences, (ref) => `/// <reference types="${ref}" />`));
            code += fixer.fix();
            if (!code) {
                code += "\nexport { };";
            }
            const typeOnlyFixer = new TypeOnlyFixer(chunk.fileName, code);
            const typesFixed = typeOnlyFixer.fix();
            // Build mapping from module paths to chunk filenames
            const moduleToChunk = new Map();
            for (const [chunkFileName, chunkInfo] of Object.entries(meta.chunks)) {
                for (const moduleId of Object.keys(chunkInfo.modules)) {
                    moduleToChunk.set(moduleId.split("\\").join("/"), chunkFileName);
                }
            }
            const moduleDeclarationFixer = new ModuleDeclarationFixer(chunk, "magicCode" in typesFixed && typesFixed.magicCode ? typesFixed.magicCode : new MagicString(code), !!options.sourcemap, moduleToChunk, meta.chunks, (message) => this.warn(message));
            return moduleDeclarationFixer.fix();
        },
        async generateBundle(options, bundle) {
            rewritePortableSharedChunkImportsInBundle(bundle, (message) => this.warn(message));
            // Fix sourcemap sources to point to original .ts files
            // When input .d.ts files have associated .d.ts.map files pointing to original .ts sources,
            // we use sourcemap remapping to compose the transform's map with the input map
            if (!options.sourcemap)
                return;
            // Lazily load input sourcemaps in parallel now that we know sourcemaps are enabled
            const inputSourcemaps = new Map();
            const entries = Array.from(pendingSourcemaps.entries());
            const loadedMaps = await Promise.all(entries.map(async ([fileName, info]) => ({
                fileName,
                inputMap: await loadInputSourcemap(info),
            })));
            // Helper to detect URL paths (http://, https://, file://, etc.)
            // Requires :// to avoid matching Windows drive letters like C:\ or D:/
            const isUrl = (p) => /^[a-z][a-z0-9+.-]*:\/\//i.test(p);
            for (const { fileName, inputMap } of loadedMaps) {
                if (inputMap && inputMap.sources) {
                    const inputMapDir = path.dirname(fileName);
                    // Resolve sourceRoot: preserve URLs verbatim, resolve filesystem paths
                    let sourceRoot;
                    if (inputMap.sourceRoot) {
                        sourceRoot = isUrl(inputMap.sourceRoot)
                            ? inputMap.sourceRoot
                            : path.resolve(inputMapDir, inputMap.sourceRoot);
                    }
                    else {
                        sourceRoot = inputMapDir;
                    }
                    const sourceRootIsUrl = isUrl(sourceRoot);
                    inputSourcemaps.set(fileName, {
                        version: inputMap.version ?? 3,
                        sources: inputMap.sources.map((source) => {
                            if (source === null)
                                return null;
                            // URL sources pass through unchanged
                            if (isUrl(source))
                                return source;
                            // URL sourceRoot: use URL constructor for proper path resolution (handles ../ segments)
                            if (sourceRootIsUrl) {
                                const base = sourceRoot.endsWith("/") ? sourceRoot : sourceRoot + "/";
                                return new URL(source, base).toString();
                            }
                            // Filesystem paths: use path.resolve
                            return path.isAbsolute(source) ? source : path.resolve(sourceRoot, source);
                        }),
                        // Note: sourcesContent intentionally not copied.
                        // TypeScript's declaration maps never include sourcesContent, and tsserver's
                        // getDocumentPositionMapper() rejects maps that have it (returns identity mapper).
                        // https://github.com/microsoft/TypeScript/blob/b19a9da2a3b8f2a720d314d01258dd2bdc110fef/src/services/sourcemaps.ts#L226
                        mappings: inputMap.mappings,
                        names: inputMap.names,
                    });
                }
            }
            const outputDir = options.dir || (options.file ? path.dirname(options.file) : process.cwd());
            for (const chunk of Object.values(bundle)) {
                if (chunk.type !== "chunk" || !chunk.map)
                    continue;
                // Check if any sources have input sourcemaps that need to be composed
                // Sources in chunk.map are relative to the chunk's output location, not the outputDir
                const chunkDir = path.join(outputDir, path.dirname(chunk.fileName));
                // Normalize path to relative forward-slash format for sourcemaps
                // Must be relative to chunkDir since sourcemap paths are relative to the .map file location
                // URL sources pass through unchanged (e.g., https://..., file://...)
                const toRelativeSourcePath = (source) => {
                    if (isUrl(source))
                        return source;
                    const relative = path.isAbsolute(source) ? path.relative(chunkDir, source) : source;
                    return relative.replaceAll("\\", "/");
                };
                const toRelativeSourcePathOrNull = (source) => source === null ? null : toRelativeSourcePath(source);
                const sourcesToRemap = new Map();
                for (const source of chunk.map.sources) {
                    if (!source)
                        continue;
                    // Skip URL sources - they can't be remapped via filesystem lookup
                    // and path.resolve would mangle them
                    if (isUrl(source))
                        continue;
                    const absoluteSource = path.resolve(chunkDir, source);
                    let inputMap = inputSourcemaps.get(absoluteSource);
                    // For .ts inputs compiled via generateDts(), the input map is stored under the .d.ts key
                    // but Rollup's chunk.map.sources uses the original .ts module ID.
                    // Match getDeclarationId() behavior: all source extensions (.ts, .mts, .tsx, etc.) → .d.ts
                    if (!inputMap && /\.[cm]?[tj]sx?$/.test(absoluteSource) && !absoluteSource.endsWith(".d.ts")) {
                        const dtsPath = absoluteSource.replace(/\.[cm]?[tj]sx?$/, ".d.ts");
                        inputMap = inputSourcemaps.get(dtsPath);
                    }
                    if (inputMap) {
                        sourcesToRemap.set(absoluteSource, inputMap);
                    }
                }
                if (sourcesToRemap.size === 0) {
                    // Always strip sourcesContent for TypeScript compatibility
                    // (tsserver rejects maps with sourcesContent)
                    delete chunk.map.sourcesContent;
                    // Handle empty chunks (like "export {};") - Rollup produces empty sources
                    // but we want to preserve original source references from input map
                    if (chunk.map.sources.length === 0 && chunk.facadeModuleId) {
                        const inputMap = inputSourcemaps.get(chunk.facadeModuleId);
                        if (inputMap && inputMap.sources.length > 0) {
                            const newSources = inputMap.sources.map(toRelativeSourcePathOrNull);
                            chunk.map.sources = newSources;
                        }
                    }
                    // Update the sourcemap asset (Rollup creates it separately from chunk.map)
                    updateSourcemapAsset(bundle, chunk.fileName, {
                        sources: chunk.map.sources.map(toRelativeSourcePathOrNull),
                        mappings: chunk.map.mappings,
                        names: chunk.map.names || [],
                    });
                    continue;
                }
                // For single-source cases where the input sourcemap also has a single source,
                // just replace the source directly to preserve the transform's hires mappings
                // This is important for Go-to-Definition to work line-by-line
                const isSingleSource = chunk.map.sources.length === 1 && sourcesToRemap.size === 1;
                const singleInputMap = isSingleSource ? Array.from(sourcesToRemap.values())[0] : null;
                const canSimplyReplace = singleInputMap && singleInputMap.sources.length === 1;
                let newSources;
                let newMappings;
                let newNames;
                if (canSimplyReplace && singleInputMap) {
                    // Sparse-Anchor Hydration: Rollup's output map is sparse (few segments per line)
                    // because the plugin uses a virtual AST that doesn't preserve token positions.
                    // Standard remapping via @jridgewell/remapping can only trace existing segments,
                    // not add new ones - so we'd lose the per-identifier mappings from the input map.
                    // Instead, we use Rollup's sparse segments as "anchors" to determine which source
                    // line each output line came from, then copy all detailed segments from that line.
                    newSources = singleInputMap.sources.map(toRelativeSourcePathOrNull);
                    newMappings = hydrateSourcemap(chunk.map.mappings, singleInputMap, chunk.code);
                    newNames = singleInputMap.names || [];
                }
                else {
                    // Track visited files to prevent infinite recursion.
                    // When TypeScript compiles foo.ts → foo.d.ts + foo.d.ts.map, the map's sources
                    // point back to foo.ts. If we return the same map when resolving foo.ts,
                    // @jridgewell/remapping will recursively try to resolve foo.ts again → infinite loop.
                    const visitedFiles = new Set();
                    const remapped = remapping(chunk.map, (file) => {
                        // File paths from remapping are relative to the chunk's output location
                        const absolutePath = path.resolve(chunkDir, file);
                        // Prevent infinite recursion: if we've already returned a map for this file,
                        // return null to stop the chain (this file is the original source)
                        if (visitedFiles.has(absolutePath)) {
                            return null;
                        }
                        visitedFiles.add(absolutePath);
                        const inputMap = sourcesToRemap.get(absolutePath);
                        if (inputMap) {
                            return inputMap;
                        }
                        return null;
                    });
                    newSources = remapped.sources.map(toRelativeSourcePathOrNull);
                    newMappings = typeof remapped.mappings === "string" ? remapped.mappings : "";
                    newNames = remapped.names || [];
                }
                chunk.map.sources = newSources;
                delete chunk.map.sourcesContent;
                chunk.map.mappings = newMappings;
                chunk.map.names = newNames;
                updateSourcemapAsset(bundle, chunk.fileName, {
                    sources: newSources,
                    mappings: newMappings,
                    names: newNames,
                });
            }
        },
    };
};
function writeBlock(codes) {
    if (codes.length) {
        return codes.join("\n") + "\n";
    }
    return "";
}
function updateSourcemapAsset(bundle, chunkFileName, data) {
    const mapFileName = `${chunkFileName}.map`;
    const mapAsset = bundle[mapFileName];
    if (mapAsset && mapAsset.type === "asset") {
        mapAsset.source = JSON.stringify({
            version: 3,
            // file should be just the basename since the .map is in the same directory
            file: path.basename(chunkFileName),
            ...data,
        });
    }
}

const TS_EXTENSIONS = /\.([cm]ts|[tj]sx?)$/;
function getModule({ entries, programs, resolvedOptions }, fileName, code) {
    const { compilerOptions, tsconfig } = resolvedOptions;
    // Create any `ts.SourceFile` objects on-demand for ".d.ts" modules,
    // but only when there are zero ".ts" entry points.
    if (!programs.length && DTS_EXTENSIONS.test(fileName)) {
        return { code };
    }
    const isEntry = entries.includes(fileName);
    // Rollup doesn't tell you the entry point of each module in the bundle,
    // so we need to ask every TypeScript program for the given filename.
    const existingProgram = programs.find((p) => {
        // Entry points may be in the other entry source files, but it can't emit from them.
        // So we should find the program about the entry point which is the root files.
        if (isEntry) {
            return p.getRootFileNames().includes(fileName);
        }
        else {
            const sourceFile = p.getSourceFile(fileName);
            if (sourceFile && p.isSourceFileFromExternalLibrary(sourceFile)) {
                return false;
            }
            return !!sourceFile;
        }
    });
    if (existingProgram) {
        // we know this exists b/c of the .filter above, so this non-null assertion is safe
        const source = existingProgram.getSourceFile(fileName);
        return {
            code: source?.getFullText(),
            source,
            program: existingProgram,
        };
    }
    else if (ts.sys.fileExists(fileName)) {
        // For .d.ts files from external libraries (node_modules), return just the code without creating a program.
        // The programs.find() above returns false for external library files (line 52-54), causing
        // existingProgram to be undefined even though the file exists in a program. Without this check,
        // we would create a new program for each external .d.ts file, causing memory exhaustion
        // with large packages like type-fest (170+ files → 170+ programs → OOM).
        if (programs.length > 0 && DTS_EXTENSIONS.test(fileName)) {
            // Apply this optimization when bundling external packages via includeExternal or respectExternal
            const shouldBundleExternal = resolvedOptions.includeExternal.length > 0 || resolvedOptions.respectExternal;
            if (shouldBundleExternal) {
                return { code };
            }
        }
        const newProgram = createProgram$1(fileName, compilerOptions, tsconfig, resolvedOptions.sourcemap);
        programs.push(newProgram);
        // we created hte program from this fileName, so the source file must exist :P
        const source = newProgram.getSourceFile(fileName);
        return {
            code: source?.getFullText(),
            source,
            program: newProgram,
        };
    }
    else {
        // the file isn't part of an existing program and doesn't exist on disk
        return null;
    }
}
const plugin = (options = {}) => {
    const ctx = { entries: [], programs: [], resolvedOptions: resolveDefaultOptions(options) };
    const transformPlugin = transform(ctx.resolvedOptions.sourcemap);
    return {
        name: "dts",
        // pass outputOptions, renderChunk, and generateBundle hooks to the inner transform plugin
        outputOptions: transformPlugin.outputOptions,
        renderChunk: transformPlugin.renderChunk,
        generateBundle: transformPlugin.generateBundle,
        options(options) {
            let { input = [] } = options;
            if (!Array.isArray(input)) {
                input = typeof input === "string" ? [input] : Object.values(input);
            }
            else if (input.length > 1) {
                // when dealing with multiple unnamed inputs, transform the inputs into
                // an explicit object, which strips the file extension
                options.input = {};
                for (const filename of input) {
                    let name = trimExtension(filename);
                    if (path.isAbsolute(filename)) {
                        name = path.basename(name);
                    }
                    else {
                        name = path.normalize(name);
                    }
                    options.input[name] = filename;
                }
            }
            ctx.programs = createPrograms(Object.values(input), ctx.resolvedOptions.compilerOptions, ctx.resolvedOptions.tsconfig, ctx.resolvedOptions.sourcemap);
            return transformPlugin.options.call(this, options);
        },
        transform(code, id) {
            if (!TS_EXTENSIONS.test(id) && !JSON_EXTENSIONS.test(id)) {
                return null;
            }
            const watchFiles = (module) => {
                if (module.program) {
                    const sourceDirectory = path.dirname(id);
                    const sourceFilesInProgram = module.program
                        .getSourceFiles()
                        .map((sourceFile) => sourceFile.fileName)
                        .filter((fileName) => fileName.startsWith(sourceDirectory));
                    sourceFilesInProgram.forEach(this.addWatchFile);
                }
            };
            const handleDtsFile = () => {
                const module = getModule(ctx, id, code);
                if (module) {
                    watchFiles(module);
                    return transformPlugin.transform.call(this, module.code, id);
                }
                return null;
            };
            const treatTsAsDts = () => {
                const declarationId = getDeclarationId(id);
                const module = getModule(ctx, declarationId, code);
                if (module) {
                    watchFiles(module);
                    return transformPlugin.transform.call(this, module.code, declarationId);
                }
                return null;
            };
            const generateDts = () => {
                const module = getModule(ctx, id, code);
                if (!module || !module.source || !module.program)
                    return null;
                watchFiles(module);
                const declarationId = getDeclarationId(id);
                // Capture both .d.ts and .d.ts.map from TypeScript emit
                // Emit order: .d.ts.map first, .d.ts second (verified via experiments/ts-emit-test.ts)
                let declarationText;
                let declarationMapText;
                const { emitSkipped, diagnostics } = module.program.emit(module.source, (emitFileName, text) => {
                    if (emitFileName.endsWith(".map")) {
                        declarationMapText = text;
                    }
                    else {
                        declarationText = text;
                    }
                }, undefined, // cancellationToken
                true, // emitOnlyDtsFiles
                undefined, // customTransformers
                // @ts-ignore This is a private API for workers, should be safe to use as TypeScript Playground has used it for a long time.
                true);
                if (emitSkipped) {
                    const errors = diagnostics.filter((diag) => diag.category === ts.DiagnosticCategory.Error);
                    if (errors.length) {
                        console.error(ts.formatDiagnostics(errors, formatHost));
                        this.error("Failed to compile. Check the logs above.");
                    }
                }
                if (!declarationText)
                    return null;
                // Strip //# sourceMappingURL comment from declaration text since we handle the map via inputMapText
                // Otherwise Rollup would double-process: once from the comment, once from our transform map
                // Note: TypeScript's emit only produces external maps (never inline), so this is safe.
                // If a custom transformer were to inject an inline map, it would also be stripped.
                const cleanDeclarationText = declarationText.replace(/\n?\/\/# sourceMappingURL=[^\n]+/, "");
                // Pass declaration map text to transform for sourcemap hydration
                return transformPlugin.transform.call(this, cleanDeclarationText, declarationId, declarationMapText);
            };
            // if it's a .d.ts file, handle it as-is
            if (DTS_EXTENSIONS.test(id))
                return handleDtsFile();
            // if it's a json file, use the typescript compiler to generate the declarations,
            // requires `compilerOptions.resolveJsonModule: true`.
            // This is also commonly used with `@rollup/plugin-json` to import JSON files.
            if (JSON_EXTENSIONS.test(id))
                return generateDts();
            // first attempt to treat .ts files as .d.ts files, and otherwise use the typescript compiler to generate the declarations
            return treatTsAsDts() ?? generateDts();
        },
        resolveId(source, importer) {
            if (!importer) {
                // store the entry point, because we need to know which program to add the file
                ctx.entries.push(path.resolve(source));
                return;
            }
            // normalize directory separators to forward slashes, as apparently typescript expects that?
            importer = importer.split("\\").join("/");
            let resolvedCompilerOptions = ctx.resolvedOptions.compilerOptions;
            if (ctx.resolvedOptions.tsconfig) {
                // Here we have a chicken and egg problem.
                // `source` would be resolved by `ts.nodeModuleNameResolver` a few lines below, but
                // `ts.nodeModuleNameResolver` requires `compilerOptions` which we have to resolve here,
                // since we have a custom `tsconfig.json`.
                // So, we use Node's resolver algorithm so we can see where the request is coming from so we
                // can load the custom `tsconfig.json` from the correct path.
                const resolvedSource = source.startsWith(".") ? path.resolve(path.dirname(importer), source) : source;
                resolvedCompilerOptions = getCompilerOptions(resolvedSource, ctx.resolvedOptions.compilerOptions, ctx.resolvedOptions.tsconfig, ctx.resolvedOptions.sourcemap).compilerOptions;
            }
            // resolve this via typescript
            const { resolvedModule } = ts.resolveModuleName(source, importer, {
                // Default moduleResolution to node10 if not explicitly set. TS6 changed
                // the default from node10 to bundler, and bundler resolution picks .js
                // files over directories with .d.ts index files, breaking .d.ts bundling.
                moduleResolution: ts.ModuleResolutionKind.Node10,
                ...resolvedCompilerOptions,
            }, ts.sys);
            if (!resolvedModule) {
                return;
            }
            if (resolvedModule.isExternalLibraryImport && resolvedModule.packageId && ctx.resolvedOptions.includeExternal.includes(resolvedModule.packageId.name)) {
                // include types from specified external modules
                return { id: path.resolve(resolvedModule.resolvedFileName) };
            }
            else if (!ctx.resolvedOptions.respectExternal && resolvedModule.isExternalLibraryImport) {
                // here, we define everything else that comes from `node_modules` as `external`.
                return { id: source, external: true };
            }
            else {
                // using `path.resolve` here converts paths back to the system specific separators
                return { id: path.resolve(resolvedModule.resolvedFileName) };
            }
        },
    };
};

export { plugin as default, plugin as dts };

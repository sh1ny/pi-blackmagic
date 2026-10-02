import { resolve } from "node:path";
import * as ts from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";

/** Native TS 7 parsing through an isolated virtual project; no disk writes or host evaluation. */
function parseSource(source: string, filename: string): ts.SourceFile {
  const configPath = resolve(
    ".pi-settings-inventory",
    "tsconfig.json",
  ).replaceAll("\\", "/");
  const sourcePath = resolve(".pi-settings-inventory", filename).replaceAll(
    "\\",
    "/",
  );
  const api = new API({
    cwd: resolve(".pi-settings-inventory").replaceAll("\\", "/"),
    fs: createVirtualFileSystem({
      [configPath]: JSON.stringify({
        compilerOptions: { allowJs: true, noLib: true, noResolve: true },
        files: [sourcePath],
      }),
      [sourcePath]: source,
    }),
  });
  try {
    const snapshot = api.updateSnapshot({ openProject: configPath });
    try {
      const project = snapshot.getProject(configPath);
      if (!project)
        throw new Error("TypeScript 7 did not open the virtual project.");
      const file = project.program.getSourceFile(sourcePath);
      if (!file)
        throw new Error("TypeScript 7 did not parse the baseline source.");
      if (project.program.getSyntacticDiagnostics(sourcePath).length > 0)
        throw new Error("Baseline source has syntax errors.");
      return file;
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

export function nativeInventory(
  source: string,
  rootName = "Settings",
  prefix = "",
): string[] {
  const file = parseSource(source, "baseline.d.ts");
  const definitions = new Map<string, ts.InterfaceDeclaration | ts.TypeNode>();
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement))
      definitions.set(statement.name.text, statement);
    else if (ts.isTypeAliasDeclaration(statement))
      definitions.set(statement.name.text, statement.type);
  }
  const paths = new Set<string>();
  function structural(node: ts.TypeNode): boolean {
    if (ts.isTypeLiteralNode(node)) return true;
    if (ts.isUnionTypeNode(node)) return node.types.some(structural);
    if (ts.isTypeReferenceNode(node)) {
      const name = node.typeName.getText(file);
      const definition = definitions.get(name);
      return (
        name === "Record" ||
        (definition !== undefined &&
          (ts.isInterfaceDeclaration(definition) || structural(definition)))
      );
    }
    return false;
  }
  function visit(
    node: ts.InterfaceDeclaration | ts.TypeNode,
    path: string,
  ): void {
    if (path) paths.add(path);
    if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
      if (ts.isInterfaceDeclaration(node)) {
        for (const clause of node.heritageClauses ?? []) {
          for (const type of clause.types) {
            const inherited = definitions.get(type.expression.getText(file));
            if (inherited) visit(inherited, path);
          }
        }
      }
      for (const member of node.members) {
        if (ts.isPropertySignatureDeclaration(member) && member.type) {
          const name = member.name.getText(file).replace(/^["']|["']$/g, "");
          visit(member.type, path ? `${path}.${name}` : name);
        }
      }
    } else if (ts.isUnionTypeNode(node)) {
      for (const type of node.types) visit(type, path);
    } else if (ts.isArrayTypeNode(node) && structural(node.elementType))
      visit(node.elementType, `${path}[]`);
    else if (ts.isTypeReferenceNode(node)) {
      const name = node.typeName.getText(file);
      if (name === "Record" && node.typeArguments?.[1])
        visit(node.typeArguments[1], `${path}.*`);
      else {
        const definition = definitions.get(name);
        if (definition) visit(definition, path);
      }
    }
  }
  const root = definitions.get(rootName);
  if (!root)
    throw new Error(`Missing reviewed baseline ${rootName} declaration`);
  visit(root, prefix);
  return [...paths].sort();
}

/** Test-only syntax inspection: no host runtime/credential code is imported or evaluated. */
export function schemaInventory(source: string, rootName: string): string[] {
  const file = parseSource(source, "baseline.js");
  const variables = new Map<string, ts.Expression>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer)
        variables.set(declaration.name.text, declaration.initializer);
    }
  }
  const paths = new Set<string>();
  function resolve(node: ts.Expression): ts.Expression {
    return ts.isIdentifier(node) && variables.has(node.text)
      ? resolve(variables.get(node.text) as ts.Expression)
      : node;
  }
  function properties(node: ts.Expression): [string, ts.Expression][] {
    const resolved = resolve(node);
    if (!ts.isObjectLiteralExpression(resolved)) return [];
    return resolved.properties.flatMap(
      (property): [string, ts.Expression][] => {
        if (ts.isSpreadAssignment(property))
          return properties(property.expression);
        if (!ts.isPropertyAssignment(property)) return [];
        return [
          [
            property.name.getText(file).replace(/^["']|["']$/g, ""),
            property.initializer,
          ],
        ];
      },
    );
  }
  function kind(node: ts.Expression): string {
    const resolved = resolve(node);
    return ts.isCallExpression(resolved) &&
      ts.isPropertyAccessExpression(resolved.expression)
      ? resolved.expression.name.text
      : "";
  }
  function structural(node: ts.Expression): boolean {
    const resolved = resolve(node);
    if (!ts.isCallExpression(resolved)) return false;
    const method = kind(resolved);
    if (method === "Object" || method === "Record") return true;
    const arg = resolved.arguments[0];
    if (!arg) return false;
    if (method === "Optional") return structural(arg);
    if (method === "Union" && ts.isArrayLiteralExpression(arg))
      return arg.elements.some((element) =>
        structural(element as ts.Expression),
      );
    return false;
  }
  function visit(node: ts.Expression, path: string): void {
    if (path) paths.add(path);
    const resolved = resolve(node);
    if (!ts.isCallExpression(resolved)) return;
    const method = kind(resolved);
    const first = resolved.arguments[0];
    if (!first) return;
    if (method === "Object") {
      for (const [key, value] of properties(first))
        visit(value, path ? `${path}.${key}` : key);
    } else if (method === "Optional") visit(first, path);
    else if (method === "Record" && resolved.arguments[1])
      visit(resolved.arguments[1], `${path}.*`);
    else if (method === "Array" && structural(first)) visit(first, `${path}[]`);
    else if (method === "Union" && ts.isArrayLiteralExpression(first)) {
      for (const element of first.elements)
        visit(element as ts.Expression, path);
    }
  }
  const root = variables.get(rootName);
  if (!root) throw new Error(`Missing reviewed baseline schema ${rootName}`);
  visit(root, "");
  return [...paths].sort();
}

import { parse as vue } from '@vue/compiler-sfc';
import { syntax, walk } from './resolution.js';

export interface Dependency { specifier: string; names?: string[] }
export function dependencies(file: string, text: string, wanted?: string[]): Dependency[] | null {
  let script = text;
  if (file.endsWith('.vue')) {
    const parsed = vue(text).descriptor;
    script = [parsed.script?.content, parsed.scriptSetup?.content].filter(Boolean).join('\n');
  }
  if (!/\.(vue|[cm]?[jt]sx?)$/.test(file)) return null;
  const ast = syntax(script);
  if (!ast) return null;
  const imports = new Map<string, Dependency>(), declarations = new Map<string, any>();
  const exported = new Map<string, any>(), stars: Dependency[] = [], effects: any[] = [];
  const literal = (name: any): string => name?.name ?? name?.value;
  const addDeclaration = (node: any): void => {
    if (node?.type === 'VariableDeclaration') for (const item of node.declarations) {
      if (item.id?.type === 'Identifier') declarations.set(item.id.name, item.init);
      else effects.push(item.init);
      // Initializers can have side effects even when their export is unused.
      if (item.init && !['Identifier','StringLiteral','NumericLiteral','BooleanLiteral','NullLiteral','ArrowFunctionExpression','FunctionExpression'].includes(item.init.type)) effects.push(item.init);
    }
    else if (node?.id?.name) declarations.set(node.id.name, node);
  };
  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
      if (!node.specifiers.length) stars.push({specifier:node.source.value});
      for (const spec of node.specifiers.filter((spec: any) => spec.importKind !== 'type')) imports.set(spec.local.name, {specifier:node.source.value, ...(spec.type === 'ImportNamespaceSpecifier' ? {} : {names:[spec.type === 'ImportDefaultSpecifier' ? 'default' : literal(spec.imported)]})});
    } else if (node.type === 'ExportAllDeclaration' && node.exportKind !== 'type') stars.push({specifier:node.source.value, ...(wanted ? {names:wanted} : {})});
    else if (node.type === 'ExportNamedDeclaration' && node.exportKind !== 'type') {
      if (node.declaration) {
        addDeclaration(node.declaration);
        if (node.declaration.id?.name) exported.set(node.declaration.id.name,node.declaration);
        for (const item of node.declaration.declarations ?? []) if (item.id?.name) exported.set(item.id.name,item.id);
      }
      for (const spec of node.specifiers.filter((spec: any) => spec.exportKind !== 'type')) exported.set(literal(spec.exported), node.source ? {dependency:{specifier:node.source.value,names:[literal(spec.local)]}} : spec.local);
    } else if (node.type === 'ExportDefaultDeclaration') exported.set('default',node.declaration);
    else if (!['ImportDeclaration','TSTypeAliasDeclaration','TSInterfaceDeclaration'].includes(node.type)) {
      addDeclaration(node);
      if (!['VariableDeclaration','FunctionDeclaration','ClassDeclaration'].includes(node.type)) effects.push(node);
    }
  }
  const result: Dependency[] = [...stars], used = new Set<string>();
  const follow = (node: any): void => {
    if (node?.dependency) { result.push(node.dependency); return; }
    walk(node, part => {
      if (part.type === 'Identifier' && !used.has(part.name)) {
        used.add(part.name);
        if (imports.has(part.name)) result.push(imports.get(part.name)!);
        else if (declarations.has(part.name)) follow(declarations.get(part.name));
      }
      if (part.type === 'CallExpression' && part.callee.type === 'Import' && part.arguments[0]?.type === 'StringLiteral') result.push({specifier:part.arguments[0].value});
    });
  };
  if (!wanted || file.endsWith('.vue') || wanted.some(name => !exported.has(name)) && !stars.length) {
    for (const edge of imports.values()) result.push(edge);
    for (const node of ast.program.body) follow(node);
  } else {
    for (const name of wanted) follow(exported.get(name));
  }
  for (const node of effects) follow(node);
  return result;
}

import path from 'node:path';
import { property, syntax, walk } from './resolution.js';

interface Source { path: string; text: string }
export function vueRoutes(files: Source[], resolve: (from: string, specifier: string) => string | null) {
  const routes = new Map<string, { addresses: string[]; wrappers: string[]; sources: string[] }>();
  const routers: string[] = [], reasons: string[] = [];
  for (const file of files.filter(file => /\.[cm]?[jt]s$/.test(file.path) && /['"]vue-router['"]/.test(file.text))) {
    const ast = syntax(file.text);
    if (!ast) { reasons.push(`Cannot parse router ${file.path}`); continue; }
    const imports = new Map<string, string>(), declarations = new Map<string, any>(), factories = new Set<string>();
    walk(ast, node => {
      if (node.type === 'ImportDeclaration') for (const spec of node.specifiers) {
        imports.set(spec.local.name, node.source.value);
        if (node.source.value === 'vue-router' && spec.imported?.name === 'createRouter') factories.add(spec.local.name);
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') declarations.set(node.id.name, node.init);
    });
    const value = (node: any, seen = new Set<string>()): any => {
      while (node && ['TSAsExpression', 'TSSatisfiesExpression'].includes(node.type)) node = node.expression;
      if (node?.type === 'Identifier' && declarations.has(node.name) && !seen.has(node.name)) { seen.add(node.name); return value(declarations.get(node.name), seen); }
      return node;
    };
    const component = (node: any): string | null => {
      node = value(node);
      if (node?.type === 'Identifier' && imports.has(node.name)) return resolve(file.path, imports.get(node.name)!);
      let specifier: string | undefined;
      walk(node, part => {
        if (part.type === 'CallExpression' && part.callee.type === 'Import' && part.arguments[0]?.type === 'StringLiteral') specifier = part.arguments[0].value;
      });
      return specifier ? resolve(file.path, specifier) : null;
    };
    const read = (node: any, parent: string, wrappers: string[]): void => {
      node = value(node);
      if (node?.type !== 'ArrayExpression') { reasons.push(`Routes in ${file.path} are not a static array`); return; }
      for (let entry of node.elements) {
        entry = value(entry);
        const address = value(property(entry, 'path'));
        if (entry?.type !== 'ObjectExpression' || address?.type !== 'StringLiteral') { reasons.push(`A route in ${file.path} has a computed path`); continue; }
        const full = address.value.startsWith('/') ? address.value : path.posix.join(parent || '/', address.value);
        const view = property(entry, 'component');
        const at = component(view);
        if (view && !at) reasons.push(`Cannot resolve route component for ${full} in ${file.path}`);
        if (at) {
          const route = routes.get(at) ?? { addresses: [], wrappers: [], sources: [] };
          route.addresses.push(full); route.wrappers.push(...wrappers); route.sources.push(file.path);
          const alias = value(property(entry, 'alias'));
          for (const item of alias?.type === 'ArrayExpression' ? alias.elements : alias ? [alias] : []) {
            if (item?.type === 'StringLiteral') route.addresses.push(item.value.startsWith('/') ? item.value : path.posix.join(parent || '/', item.value));
            else reasons.push(`A route alias in ${file.path} is not literal`);
          }
          routes.set(at, route);
        }
        const children = property(entry, 'children');
        if (children) read(children, full, at ? [...wrappers, at] : wrappers);
      }
    };
    walk(ast, node => {
      if (node.type !== 'CallExpression' || !factories.has(node.callee?.name)) return;
      routers.push(file.path);
      read(property(value(node.arguments[0]), 'routes'), '/', []);
    });
  }
  return { routes, routers, reasons };
}

import ts from 'typescript';
import type { ProjectReport, ReviewFinding } from '../project-review';

const sourceName = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const isNextConfig = /(^|\/)next\.config\.(?:[cm]?[jt]s)$/;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function literal(node: ts.Node | undefined, value: string) {
  return !!node && ts.isStringLiteralLike(node) && node.text === value;
}

function assignment(node: ts.Statement): ts.ObjectLiteralExpression | undefined {
  if (ts.isExportAssignment(node) && !node.isExportEquals && ts.isObjectLiteralExpression(node.expression)) {
    return node.expression;
  }
  if (!ts.isExpressionStatement(node) || !ts.isBinaryExpression(node.expression)) return;
  const { left, right, operatorToken } = node.expression;
  if (operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(left)
      && ts.isIdentifier(left.expression) && left.expression.text === 'module' && left.name.text === 'exports'
      && ts.isObjectLiteralExpression(right)) return right;
}

function inspect(path: string, source: string, suggestFix: boolean) {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const findings: ReviewFinding[] = [];
  const edits: { start: number; end: number; text: string }[] = [];
  const imports = new Set<string>();
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  function report(node: ts.Node, title: string, detail: string, status: ReviewFinding['status'] = 'Review') {
    findings.push({ file: path, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, title, detail, status });
  }

  for (const statement of tree.statements) {
    if (ts.isImportDeclaration(statement) && literal(statement.moduleSpecifier, 'express') && statement.importClause?.name) {
      imports.add(statement.importClause.name.text);
    }
    if (ts.isVariableStatement(statement)) {
      for (const { name, initializer } of statement.declarationList.declarations) {
        if (ts.isIdentifier(name) && initializer && ts.isCallExpression(initializer)
            && ts.isIdentifier(initializer.expression) && initializer.expression.text === 'require'
            && literal(initializer.arguments[0], 'express')) imports.add(name.text);
      }
    }
  }
  for (const statement of tree.statements) {
    if (suggestFix && imports.size && !/x-powered-by/i.test(source) && ts.isVariableStatement(statement)) {
      for (const { name, initializer } of statement.declarationList.declarations) {
        if (ts.isIdentifier(name) && initializer && ts.isCallExpression(initializer)
            && ts.isIdentifier(initializer.expression) && imports.has(initializer.expression.text)) {
          edits.push({ start: statement.end, end: statement.end, text: newline + name.text + ".disable('x-powered-by');" });
          report(name, 'Express framework header', 'Disabled the default X-Powered-By response header.', 'Patched');
        }
      }
    }
    if (suggestFix && isNextConfig.test(path)) {
      const config = assignment(statement);
      if (!config || config.properties.some((prop) => ts.isSpreadAssignment(prop)
        || prop.name && ts.isComputedPropertyName(prop.name))) continue;
      const props = config.properties.filter(({ name }) => name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'poweredByHeader');
      if (props.length === 0) {
        const start = config.getStart(tree) + 1;
        edits.push({ start, end: start, text: ' poweredByHeader: false' + (config.properties.length ? ', ' : ' ') });
        report(config, 'Next.js framework header', 'Disabled the default X-Powered-By response header.', 'Patched');
      } else if (props.length === 1 && ts.isPropertyAssignment(props[0]) && props[0].initializer.kind === ts.SyntaxKind.TrueKeyword) {
        const value = props[0].initializer;
        edits.push({ start: value.getStart(tree), end: value.end, text: 'false' });
        report(value, 'Next.js framework header', 'Changed poweredByHeader to false.', 'Patched');
      }
    }
  }
  function visit(node: ts.Node) {
    if (findings.length >= 35) return;
    if (ts.isCallExpression(node)) {
      const fn = node.expression;
      if (ts.isIdentifier(fn) && fn.text === 'eval') report(node, 'Dynamic code execution', 'Review whether untrusted input can reach eval().');
      const arg = node.arguments[0];
      if (ts.isPropertyAccessExpression(fn) && /^(query|execute|prepare)$/.test(fn.name.text)
          && arg && ts.isTemplateExpression(arg) && /\b(select|insert|update|delete)\b/i.test(arg.head.text)) {
        report(node, 'Interpolated SQL', 'Review whether request data reaches this query. Use bound parameters where possible.');
      }
    }
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
        && node.name.text === 'rejectUnauthorized' && node.initializer.kind === ts.SyntaxKind.FalseKeyword) {
      report(node, 'TLS certificate verification disabled', 'Review whether this setting can reach a production connection.');
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);

  let patched = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    patched = patched.slice(0, edit.start) + edit.text + patched.slice(edit.end);
  }
  const changes = edits.map(({ start, end, text }) => ({
    file: path,
    line: tree.getLineAndCharacterOfPosition(start).line + 1,
    before: source.slice(start, end),
    after: text,
  }));
  return { patched, findings, changes };
}

export function reviewSources(files: Map<string, Buffer>) {
  const patched = new Map(files);
  const findings: ReviewFinding[] = [];
  const aiSources: { file: string; source: string }[] = [];
  const checks: string[] = [];
  const changes: ProjectReport['changes'] = [];
  let scannedFiles = 0;
  let aiChars = 0;
  for (const [path, bytes] of files) {
    if (!sourceName.test(path) || bytes.length > 384 * 1024) continue;
    let source: string;
    try { source = textDecoder.decode(bytes); } catch { continue; }
    const result = inspect(path, source, true);
    scannedFiles++;
    if (result.patched !== source) {
      const diagnostics = ts.transpileModule(result.patched, {
        fileName: path, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.Preserve },
      }).diagnostics ?? [];
      if (diagnostics.some(({ category }) => category === ts.DiagnosticCategory.Error)) {
        for (const finding of result.findings.filter(({ status }) => status === 'Patched')) {
          finding.status = 'Review';
          finding.detail = 'Candidate skipped because its syntax check reported an error.';
        }
      } else {
        patched.set(path, Buffer.from(result.patched));
        changes.push(...result.changes);
        checks.push(path + ' passed the post-edit syntax check.');
      }
    }
    findings.push(...result.findings);
    if (aiSources.length < 8 && source.length <= 7000 && aiChars + source.length <= 24000
        && !/\b(?:sk-[\w-]{16,}|AKIA[A-Z0-9]{16}|gh[pousr]_[\w]{20,}|BEGIN [A-Z ]*PRIVATE KEY)\b/.test(source)) {
      aiSources.push({ file: path, source });
      aiChars += source.length;
    }
  }
  return { patched, findings: findings.slice(0, 150), aiSources, checks, changes, scannedFiles };
}

export function identifyProject(files: Map<string, Buffer>) {
  const manifests = [...files.keys()].filter((name) => /(^|\/)package\.json$/.test(name)).sort((a, b) => a.length - b.length);
  for (const path of manifests) {
    try {
      const { dependencies, devDependencies } = JSON.parse(files.get(path)!.toString('utf8'));
      const deps = { ...dependencies, ...devDependencies };
      return { framework: deps.next ? 'Next.js' : deps.express ? 'Express' : 'Node.js', path };
    } catch {
      // A malformed manifest is not a project root.
    }
  }
  return { framework: 'JavaScript / TypeScript sources', path: undefined };
}

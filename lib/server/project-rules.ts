import ts from 'typescript';
import type { ProjectReport, ReviewFinding } from '../project-review';

export const sourceName = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
// Languages the AI reviewer accepts. The deterministic AST scanner and auto-fix stay JS/TS only.
export const reviewable = /\.(?:[cm]?[jt]s|[jt]sx|py|rb|go|php|java)$/i;
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

function nameOf(node: ts.Node) {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
}

function assignedTo(parent: ts.Node, child: ts.Node) {
  if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.initializer === child) return nameOf(parent.name);
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === child) return nameOf(parent.left);
}

function contains(node: ts.Node, test: (item: ts.Node) => boolean): boolean {
  return test(node) || !!ts.forEachChild(node, (child) => contains(child, test) || undefined);
}

// Request-controlled data: Express/Koa req.*, and Next.js/Fetch searchParams.
function fromRequest(node: ts.Node) {
  return contains(node, (item) => (ts.isPropertyAccessExpression(item) && ts.isIdentifier(item.expression)
    && /^(req|request|ctx)$/.test(item.expression.text) && /^(query|body|params|headers|cookies|url|originalUrl)$/.test(item.name.text))
    || (ts.isPropertyAccessExpression(item) && item.name.text === 'searchParams'));
}

const aiModules = /^(openai|groq-sdk|@anthropic-ai\/sdk|ai|@ai-sdk\/.+|@google\/gen(erative-)?ai|langchain|@langchain\/.+|ollama|cohere-ai|@mistralai\/.+)$/;
const modelOutput = /\b(choices|output_text|completion|tool_?calls?|toolCall|llm\w*|aiResponse|modelOutput|generated\w*|answer)\b/i;

function moduleBindings(tree: ts.SourceFile) {
  const bound = new Map<string, { module: string; name: string }>();
  for (const statement of tree.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier) && statement.importClause) {
      const module = statement.moduleSpecifier.text;
      const { name, namedBindings } = statement.importClause;
      if (name) bound.set(name.text, { module, name: '*' });
      if (namedBindings && ts.isNamespaceImport(namedBindings)) bound.set(namedBindings.name.text, { module, name: '*' });
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const item of namedBindings.elements) bound.set(item.name.text, { module, name: (item.propertyName ?? item.name).text });
      }
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const { name, initializer } of statement.declarationList.declarations) {
      if (!initializer || !ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'require') continue;
      const specifier = initializer.arguments[0];
      if (!specifier || !ts.isStringLiteralLike(specifier)) continue;
      if (ts.isIdentifier(name)) bound.set(name.text, { module: specifier.text, name: '*' });
      if (ts.isObjectBindingPattern(name)) {
        for (const item of name.elements) {
          if (ts.isIdentifier(item.name)) bound.set(item.name.text, { module: specifier.text, name: nameOf(item.propertyName ?? item.name) ?? item.name.text });
        }
      }
    }
  }
  return bound;
}

// Returns undefined unless every interpolation is a value position that a placeholder can safely replace.
function boundSql(tree: ts.SourceFile, template: ts.TemplateExpression, style: '$' | '?') {
  const parts = [template.head.text, ...template.templateSpans.map(({ literal: tail }) => tail.text)];
  if (parts.some((part) => /\?|\$\d/.test(part))) return;
  let sql = template.head.text;
  const values: string[] = [];
  for (const { expression, literal: tail } of template.templateSpans) {
    const before = /(?:[=<>]|\bLIKE|\bIN\s*\(|\bVALUES\s*\(|\b(?:IN|VALUES)\s*\([^()]*,)\s*(['"]?)$/i.exec(sql);
    if (!before) return;
    const quote = before[1];
    const prior = sql.slice(0, sql.length - quote.length);
    // An odd count of apostrophes means this position is inside an SQL string, not a value slot.
    if (prior.split("'").length % 2 === 0) return;
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === 'join') return;
    if (quote ? !tail.text.startsWith(quote) : /^[\w'"]/.test(tail.text)) return;
    values.push(expression.getText(tree));
    sql = prior + (style === '$' ? '$' + values.length : '?') + tail.text.slice(quote.length);
  }
  return { sql: "'" + sql.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n') + "'", values };
}

function inspect(path: string, source: string, suggestFix: boolean) {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const findings: ReviewFinding[] = [];
  const edits: { start: number; end: number; text: string }[] = [];
  const imports = new Set<string>();
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const bound = moduleBindings(tree);
  const modules = new Set([...bound.values()].map(({ module }) => module));
  const usesDollar = modules.has('pg');
  const usesQuestion = ['mysql', 'mysql2', 'mysql2/promise', 'sqlite3', 'better-sqlite3', 'node:sqlite'].some((name) => modules.has(name));
  const placeholder = usesDollar === usesQuestion ? undefined : usesDollar ? '$' as const : '?' as const;
  const usesAI = [...modules].some((name) => aiModules.test(name));
  const usesMongo = modules.has('mongoose') || modules.has('mongodb');
  function report(node: ts.Node, title: string, detail: string, severity: ReviewFinding['severity'], cwe: string, status: ReviewFinding['status'] = 'Review') {
    findings.push({ file: path, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, title, detail, status, severity, cwe });
  }
  function resolved(fn: ts.Expression) {
    if (ts.isIdentifier(fn)) return bound.get(fn.text);
    if (!ts.isPropertyAccessExpression(fn)) return;
    const owner = ts.isPropertyAccessExpression(fn.expression) && fn.expression.name.text === 'promises' ? fn.expression.expression : fn.expression;
    const binding = ts.isIdentifier(owner) ? bound.get(owner.text) : undefined;
    return binding && (binding.name === '*' || binding.name === 'promises') ? { module: binding.module, name: fn.name.text } : undefined;
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
          report(name, 'Express framework header', 'Disabled the default X-Powered-By response header.', 'Low', 'CWE-200', 'Patched');
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
        report(config, 'Next.js framework header', 'Disabled the default X-Powered-By response header.', 'Low', 'CWE-200', 'Patched');
      } else if (props.length === 1 && ts.isPropertyAssignment(props[0]) && props[0].initializer.kind === ts.SyntaxKind.TrueKeyword) {
        const value = props[0].initializer;
        edits.push({ start: value.getStart(tree), end: value.end, text: 'false' });
        report(value, 'Next.js framework header', 'Changed poweredByHeader to false.', 'Low', 'CWE-200', 'Patched');
      }
    }
  }
  function visit(node: ts.Node) {
    if (findings.length >= 35) return;
    if (ts.isCallExpression(node)) {
      const fn = node.expression;
      if (ts.isIdentifier(fn) && fn.text === 'eval') report(node, 'Dynamic code execution', 'Review whether untrusted input can reach eval().', 'High', 'CWE-95');
      const arg = node.arguments[0];
      const callee = ts.isIdentifier(fn) ? fn.text : ts.isPropertyAccessExpression(fn) ? fn.name.text : '';
      const target = resolved(fn);
      // SSRF: the server fetches a URL the client chose (cloud metadata, internal admin panels).
      if (arg && fromRequest(arg) && ((ts.isIdentifier(fn) && fn.text === 'fetch')
          || (target && /^(axios|got|node-fetch|undici|superagent|needle|(node:)?https?)$/.test(target.module) && /^(\*|default|get|post|put|request|fetch)$/.test(target.name === '*' ? '*' : target.name))
          || (ts.isPropertyAccessExpression(fn) && ts.isIdentifier(fn.expression) && /^(axios|got|http|https)$/.test(fn.expression.text)))) {
        report(node, 'Server-side request forgery (SSRF)', 'The server requests a URL taken from the client. Allowlist hosts and block private and metadata addresses.', 'High', 'CWE-918');
      }
      if (callee === 'redirect' && node.arguments.some((item) => fromRequest(item))) {
        report(node, 'Open redirect', 'The redirect target comes from the request. Allow only relative paths or known hosts.', 'Medium', 'CWE-601');
      }
      if (target && /^(lodash|lodash\.\w+|lodash-es)$/.test(target.module) && /^(merge|mergeWith|defaultsDeep|set|setWith|zipObjectDeep)$/.test(target.name === '*' ? callee : target.name)
          && node.arguments.some((item) => fromRequest(item))) {
        report(node, 'Prototype pollution', 'Request data is deep-merged into an object, so a __proto__ key can change every object in the process.', 'High', 'CWE-1321');
      }
      // Model-style receivers (User.findOne) count even when the model is imported from another file.
      const modelCall = ts.isPropertyAccessExpression(fn) && ts.isIdentifier(fn.expression) && /^[A-Z]/.test(fn.expression.text);
      if ((usesMongo || modelCall) && /^(find|findOne|findOneAndUpdate|findOneAndDelete|updateOne|updateMany|deleteOne|deleteMany|countDocuments|where)$/.test(callee) && arg
          && ((ts.isPropertyAccessExpression(arg) && fromRequest(arg) && /^(body|query|params)$/.test(arg.name.text))
            || (ts.isObjectLiteralExpression(arg) && arg.properties.some((prop) => ts.isPropertyAssignment(prop) && ts.isPropertyAccessExpression(prop.initializer) && fromRequest(prop.initializer))))) {
        report(node, 'NoSQL injection', 'Request values reach a MongoDB filter unchanged, so an object such as {"$ne": null} bypasses the check. Cast values with String() or validate them.', 'High', 'CWE-943');
      }
      if (target?.module === 'node-serialize' && /^(unserialize|\*)$/.test(target.name)) {
        report(node, 'Unsafe deserialization', 'node-serialize executes functions embedded in the payload. Use JSON.parse.', 'Critical', 'CWE-502');
      }
      if (target && /^(node:)?vm$/.test(target.module) && /^(runInNewContext|runInThisContext|runInContext|compileFunction|Script)$/.test(target.name === '*' ? callee : target.name) && arg && !ts.isStringLiteralLike(arg)) {
        report(node, 'Code execution in node:vm', 'node:vm is not a security sandbox; code can escape to the host process.', 'High', 'CWE-94');
      }
      if (target?.module === 'jsonwebtoken' && /^(sign|verify)$/.test(target.name === '*' ? callee : target.name) && node.arguments[1] && ts.isStringLiteralLike(node.arguments[1])) {
        report(node.arguments[1], 'Hardcoded JWT secret', 'Anyone with the source can mint valid tokens. Load the signing key from the environment.', 'High', 'CWE-798');
      }
      if (/^(insertAdjacentHTML|write|writeln)$/.test(callee) && ts.isPropertyAccessExpression(fn)
          && (callee === 'insertAdjacentHTML' || (ts.isIdentifier(fn.expression) && fn.expression.text === 'document'))) {
        const html = callee === 'insertAdjacentHTML' ? node.arguments[1] : arg;
        if (html && !ts.isStringLiteralLike(html)) report(node, 'DOM XSS sink', 'Dynamic HTML is written into the page. Use textContent or sanitize with DOMPurify.', 'Medium', 'CWE-79');
      }
      // Model output treated as trusted code or markup (OWASP LLM05: improper output handling).
      if (usesAI && (callee === 'eval' || /^exec(Sync)?$/.test(callee) || /^(runInNewContext|runInThisContext)$/.test(callee))
          && node.arguments.some((item) => modelOutput.test(item.getText(tree)))) {
        report(node, 'LLM output executed as code', 'A model response reaches a code or shell sink. Prompt injection can turn this into remote code execution. Never execute model output; map it to an allowlist of actions.', 'Critical', 'CWE-94');
      }
      if (ts.isPropertyAccessExpression(fn) && /^(query|execute|prepare)$/.test(fn.name.text)
          && arg && ts.isTemplateExpression(arg) && /\b(select|insert|update|delete)\b/i.test(arg.head.text)) {
        const member = node.parent;
        const terminal = fn.name.text === 'prepare' && placeholder === '?' && node.arguments.length === 1
          && ts.isPropertyAccessExpression(member) && member.expression === node && /^(all|get|run)$/.test(member.name.text)
          && ts.isCallExpression(member.parent) && member.parent.expression === member && !member.parent.arguments.length ? member.parent : undefined;
        const direct = fn.name.text !== 'prepare' && node.arguments.length === 1;
        const rewrite = suggestFix && placeholder && (direct || terminal) ? boundSql(tree, arg, placeholder) : undefined;
        const start = arg.getStart(tree);
        const end = terminal ? terminal.end : arg.end;
        if (rewrite && !edits.some((edit) => start < edit.end && end > edit.start)) {
          const values = rewrite.values.join(', ');
          edits.push({ start, end, text: terminal ? rewrite.sql + source.slice(arg.end, terminal.end - 1) + values + ')' : rewrite.sql + ', [' + values + ']' });
          report(node, 'Interpolated SQL', 'Rewrote to bound parameters.', 'Critical', 'CWE-89', 'Patched');
        } else {
          report(node, 'Interpolated SQL', 'Review whether request data reaches this query. Use bound parameters where possible.', 'Critical', 'CWE-89');
        }
      }
      const call = resolved(fn);
      if (call && /^(node:)?child_process$/.test(call.module) && arg && !ts.isStringLiteralLike(arg)
          && (/^exec(Sync)?$/.test(call.name) || (call.name === 'spawn' && node.arguments.slice(1).some((option) => ts.isObjectLiteralExpression(option)
            && option.properties.some((prop) => ts.isPropertyAssignment(prop) && nameOf(prop.name) === 'shell' && prop.initializer.kind === ts.SyntaxKind.TrueKeyword))))) {
        report(node, 'Command injection', 'A non-literal command runs through a shell. Use execFile with an argument array.', 'High', 'CWE-78');
      }
      if (ts.isIdentifier(fn) && fn.text === 'cors' && !node.arguments.length) report(node, 'Open CORS policy', 'cors() with no options allows every origin. Set an explicit allowlist.', 'Medium', 'CWE-942');
      if ((ts.isPropertyAccessExpression(fn) && fn.name.text === 'verify' && ts.isIdentifier(fn.expression) && fn.expression.text === 'jwt')
          || (call?.module === 'jsonwebtoken' && call.name === 'verify')) {
        const options = node.arguments[2];
        if (!options || ts.isFunctionLike(options) || (ts.isObjectLiteralExpression(options) && !options.properties.some((prop) => prop.name && nameOf(prop.name) === 'algorithms'))) {
          report(node, 'JWT algorithm not pinned', 'Pass an options object with an explicit algorithms list to jwt.verify.', 'High', 'CWE-347');
        }
      }
      if (call && /^(node:)?fs(\/promises)?$/.test(call.module) && /^(read|write|append|open|create(Read|Write)Stream)/.test(call.name) && arg
          && contains(arg, (item) => ts.isPropertyAccessExpression(item) && ts.isIdentifier(item.expression) && /^(req|request)$/.test(item.expression.text))) {
        report(node, 'Path traversal', 'A file path is built from request data. Resolve it and confirm it stays inside an allowed directory.', 'High', 'CWE-22');
      }
      if (ts.isPropertyAccessExpression(fn) && fn.name.text === 'random' && ts.isIdentifier(fn.expression) && fn.expression.text === 'Math') {
        for (let child: ts.Node = node; child.parent && !ts.isFunctionLike(child.parent); child = child.parent) {
          const target = assignedTo(child.parent, child);
          if (!target) continue;
          if (/token|secret|password|session|otp|key/i.test(target)) report(node, 'Weak randomness', 'Math.random() is predictable. Use crypto.randomBytes or crypto.randomUUID for security values.', 'Medium', 'CWE-338');
          break;
        }
      }
      if (ts.isIdentifier(fn) && /^set(Timeout|Interval)$/.test(fn.text) && arg && (ts.isStringLiteralLike(arg) || ts.isTemplateExpression(arg))) {
        report(node, 'Dynamic code execution', 'A string passed to ' + fn.text + ' runs as code. Pass a function instead.', 'High', 'CWE-95');
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'RegExp' && node.arguments?.[0] && fromRequest(node.arguments[0])) {
      report(node, 'Regular expression from user input', 'A client-supplied pattern can trigger catastrophic backtracking (ReDoS) and stall the event loop. Escape the input or use a fixed pattern.', 'Medium', 'CWE-1333');
    }
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node))
        && ts.isVariableDeclarationList(node.initializer) && ts.isIdentifier(node.initializer.declarations[0]?.name)) {
      const key = (node.initializer.declarations[0].name as ts.Identifier).text;
      // A for-of only pollutes when it walks a path: cur = cur[key] descends into nested objects.
      const descends = contains(node.statement, (item) => ts.isBinaryExpression(item) && item.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(item.left) && ts.isElementAccessExpression(item.right) && ts.isIdentifier(item.right.expression)
        && item.right.expression.text === item.left.text && ts.isIdentifier(item.right.argumentExpression) && item.right.argumentExpression.text === key);
      let owner: ts.Node | undefined = node.parent;
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
      const assignsByKey = contains(node.statement, (item) => ts.isBinaryExpression(item) && item.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isElementAccessExpression(item.left) && ts.isIdentifier(item.left.argumentExpression) && item.left.argumentExpression.text === key);
      const guarded = owner && /__proto__|hasOwn|Object\.create\(null\)|new Map/.test(owner.getText(tree));
      const name = owner && 'name' in owner && owner.name && ts.isIdentifier(owner.name as ts.Node) ? (owner.name as ts.Identifier).text : '';
      const recursive = !!name && contains(node.statement, (item) => ts.isCallExpression(item) && ts.isIdentifier(item.expression) && item.expression.text === name);
      if (assignsByKey && !guarded && (ts.isForOfStatement(node) ? descends : recursive || /merge|extend|assign|clone|deep|set|defaults/i.test(name))) {
        if (suggestFix && ts.isBlock(node.statement)) {
          const at = node.statement.getStart(tree) + 1;
          edits.push({ start: at, end: at, text: ' if (' + key + " === '__proto__' || " + key + " === 'constructor' || " + key + " === 'prototype') continue;" });
          report(node, 'Prototype pollution', 'Added a guard that skips __proto__, constructor and prototype keys.', 'High', 'CWE-1321', 'Patched');
        } else {
          report(node, 'Prototype pollution', 'Keys from input are copied without blocking __proto__, constructor and prototype.', 'High', 'CWE-1321');
        }
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)
        && /^(innerHTML|outerHTML)$/.test(node.left.name.text) && !ts.isStringLiteralLike(node.right)) {
      if (usesAI && modelOutput.test(node.right.getText(tree))) {
        report(node, 'LLM output rendered as HTML', 'A model response is inserted as HTML; prompt injection can plant script in the page. Render it as text or sanitize it.', 'High', 'CWE-79');
      } else {
        report(node, 'DOM XSS sink', 'Dynamic HTML is assigned to ' + node.left.name.text + '. Use textContent or sanitize with DOMPurify.', 'Medium', 'CWE-79');
      }
    }
    // Build-time public env vars are inlined into the client bundle.
    if (ts.isPropertyAccessExpression(node) && /^(NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|PUBLIC)_\w*(SECRET|PRIVATE|PASSWORD|SERVICE_ROLE|TOKEN)/i.test(node.name.text)
        && /(process\.env|import\.meta\.env)$/.test(node.expression.getText(tree))) {
      report(node, 'Server secret exposed to the browser', node.name.text + ' is inlined into the client bundle at build time, so every visitor can read it. Keep secrets in server-only variables.', 'High', 'CWE-200');
    }
    if (ts.isObjectLiteralExpression(node)) {
      const prop = (name: string) => node.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && nameOf(item.name) === name);
      const role = prop('role');
      const content = prop('content');
      if (role && literal(role.initializer, 'system') && content && fromRequest(content.initializer)) {
        report(content, 'User input in system prompt', 'Request data is written into the system prompt, so users can rewrite the model\'s instructions (prompt injection). Pass user text only in user messages.', 'High', 'CWE-1427');
      }
      for (const name of ['system', 'instructions', 'systemInstruction']) {
        const item = prop(name);
        if (usesAI && item && fromRequest(item.initializer)) {
          report(item, 'User input in system prompt', 'Request data is written into the model instructions, so users can rewrite them (prompt injection). Pass user text only in user messages.', 'High', 'CWE-1427');
        }
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      report(node, 'Dynamic code execution', 'new Function() compiles strings into code. Review whether untrusted input can reach it.', 'High', 'CWE-95');
    }
    if (ts.isPropertyAssignment(node)) {
      const name = nameOf(node.name);
      if (name === 'rejectUnauthorized' && node.initializer.kind === ts.SyntaxKind.FalseKeyword) {
        report(node, 'TLS certificate verification disabled', 'Review whether this setting can reach a production connection.', 'High', 'CWE-295');
      }
      if (name === 'origin' && literal(node.initializer, '*')) report(node, 'Open CORS policy', "origin: '*' allows every origin. Set an explicit allowlist.", 'Medium', 'CWE-942');
      if (name === 'algorithms' && ts.isArrayLiteralExpression(node.initializer)
          && node.initializer.elements.some((item) => ts.isStringLiteralLike(item) && item.text.toLowerCase() === 'none')) {
        report(node, 'JWT accepts the none algorithm', "Remove 'none' from the algorithms list.", 'High', 'CWE-347');
      }
      if (name === 'dangerouslySetInnerHTML') report(node, 'Raw HTML rendering', 'Sanitize this HTML or render it as text.', 'Medium', 'CWE-79');
      if (name === 'httpOnly' && node.initializer.kind === ts.SyntaxKind.FalseKeyword) {
        report(node, 'Session cookie readable by scripts', 'httpOnly: false lets any XSS steal the cookie. Set httpOnly: true.', 'Medium', 'CWE-1004');
      }
    }
    if (ts.isJsxAttribute(node) && node.name.getText(tree) === 'dangerouslySetInnerHTML') report(node, 'Raw HTML rendering', 'Sanitize this HTML or render it as text.', 'Medium', 'CWE-79');
    if (ts.isStringLiteralLike(node)) {
      const target = assignedTo(node.parent, node);
      if ((node.text.length >= 8 && target && /pass(word)?|secret|api_?key|token/i.test(target)) || /\b(?:sk-[\w-]{16,}|sk-ant-[\w-]{20,}|gsk_\w{20,}|AKIA[A-Z0-9]{16}|gh[pousr]_\w{20,}|github_pat_\w{20,}|glpat-[\w-]{20}|xox[abp]-[\w-]{10,}|sk_live_\w{16,}|AIza[\w-]{35})\b/.test(node.text)) {
        report(node, 'Hardcoded secret', 'A credential-like value is stored in source. Move it to a secret store. The value is omitted from this report.', 'High', 'CWE-798');
      }
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

export function parses(path: string, source: string) {
  const diagnostics = ts.transpileModule(source, {
    fileName: path, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.Preserve },
  }).diagnostics ?? [];
  return !diagnostics.some(({ category }) => category === ts.DiagnosticCategory.Error);
}

export function reviewSources(files: Map<string, Buffer>, aiCharLimit = 24000) {
  const patched = new Map(files);
  const findings: ReviewFinding[] = [];
  const aiSources: { file: string; source: string }[] = [];
  const checks: string[] = [];
  const changes: ProjectReport['changes'] = [];
  let scannedFiles = 0;
  let aiChars = 0;
  for (const [path, bytes] of files) {
    if (!reviewable.test(path) || bytes.length > 384 * 1024) continue;
    let source: string;
    try { source = textDecoder.decode(bytes); } catch { continue; }
    scannedFiles++;
    // The AST scanner and auto-fix only understand JS/TS; other languages are AI-review only.
    // Minified and vendored bundles are third-party code; their advisories come from the dependency audit.
    if (sourceName.test(path) && !/\.min\.[cm]?js$|(^|\/)vendor\//i.test(path)) {
      const result = inspect(path, source, true);
      if (result.patched !== source) {
        if (!parses(path, result.patched)) {
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
    }
    if (aiSources.length < 8 && source.length <= 7000 && aiChars + source.length <= aiCharLimit
        && !/\b(?:sk-[\w-]{16,}|gsk_\w{20,}|github_pat_\w{20,}|AKIA[A-Z0-9]{16}|gh[pousr]_[\w]{20,}|BEGIN [A-Z ]*PRIVATE KEY)\b/.test(source)) {
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
  const names = [...files.keys()];
  const pythonMarker = names.some((name) => /(^|\/)(requirements\.txt|pyproject\.toml|setup\.py|Pipfile)$/.test(name));
  const py = names.filter((name) => /\.py$/i.test(name)).length;
  const code = names.filter((name) => reviewable.test(name)).length;
  if (pythonMarker || (code > 0 && py * 2 > code)) return { framework: 'Python', path: undefined };
  return { framework: 'JavaScript / TypeScript sources', path: undefined };
}

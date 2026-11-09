import { splitTemplate } from "./classicPhrasebook.js";
import { QUALIFIED_ENUM_TYPE_RE, BARE_ENUM_TYPE_RE, qualifyEnumTypeText, defaultLiteralForKind } from "./classicModuleSignatures.js";
const CONNECT_BUILTINS = {};
[
  "isNumber",
  "upper",
  "lower",
  "val",
  "len",
  "urlEncode",
  "urlDecode",
  "chr",
  "left",
  "right",
  "mid",
  "regexMatch",
  "regexMatches",
  "regexReplace",
  "replace",
  "trim",
  "inStr",
  "guid",
  "str",
  "rgb",
  "split",
  "splitToTable",
  "join",
  "format",
  "formatLocale",
  "encodeText",
  "decodeText",
  "base64Encode",
  "base64Decode",
  "isNull",
  "isNullOrEmpty",
  "average",
  "ceil",
  "floor",
  "random",
  "max",
  "min",
  "pow",
  "round",
  "sum",
  "now",
  "date",
  "toDate",
  "any",
  "count",
  "first",
  "firstOrDefault",
  "firstOrNull",
  "last",
  "lastOrDefault",
  "lastOrNull",
  "range",
  "take",
  "skip",
  "eval",
  "flatten",
  "empty",
  "hash",
  "identity",
  "sleep",
  "map",
  "filter",
  "collect",
  "fold",
  "choose",
  "groupBy",
  "forAll",
  "exists",
  "takeWhile",
  "skipWhile",
  "indexed",
  "toLookup",
  "scan",
  "zip",
  "reverse",
  "updateAt",
  "distinctBy",
  "prepend",
  "append"
].forEach((name) => {
  CONNECT_BUILTINS[name.toLowerCase()] = name;
});
const NON_NULLABLE_ARG_FUNCTIONS = {
  // Text
  upper: ["text"],
  lower: ["text"],
  val: ["text"],
  len: ["text"],
  urlEncode: ["text"],
  urlDecode: ["text"],
  left: ["text", "number"],
  right: ["text", "number"],
  mid: ["text", "number", "number"],
  regexMatch: ["text", "text"],
  regexMatches: ["text", "text"],
  regexReplace: ["text", "text", "text"],
  replace: ["text", "text", "text"],
  trim: ["text"],
  inStr: ["text", "text"],
  rgb: ["number", "number", "number"],
  split: ["text", "text"],
  splitToTable: ["text", "text"],
  format: [void 0, "text"],
  formatLocale: [void 0, "text", "text"],
  join: [void 0, "text"],
  // Binary (only the confirmed-non-nullable text/number params; the binary-typed ones are left
  // alone, same "no confirmed handling for this kind" rule as the any/primitive exclusions above)
  encodeText: ["text", "text"],
  decodeText: [void 0, "text"],
  base64Decode: ["text"],
  // Number
  ceil: ["number"],
  floor: ["number"],
  random: ["number", "number"],
  pow: ["number", "number"],
  round: ["number"],
  // Date
  date: ["text"],
  toDate: ["text", "text"],
  // Misc
  sleep: ["number", "number"]
};
const VARIADIC_NON_NULLABLE_FUNCTIONS = { max: "number", min: "number" };
const NON_NULLABLE_RETURN_FUNCTIONS = /* @__PURE__ */ new Set([
  "isNumber",
  "upper",
  "lower",
  "val",
  "len",
  "urlEncode",
  "urlDecode",
  "chr",
  "left",
  "right",
  "mid",
  "regexMatch",
  "regexReplace",
  "replace",
  "trim",
  "inStr",
  "guid",
  "str",
  "rgb",
  "join",
  "format",
  "formatLocale",
  "encodeText",
  "decodeText",
  "base64Encode",
  "base64Decode",
  "isNull",
  "isNullOrEmpty",
  "average",
  "ceil",
  "floor",
  "random",
  "max",
  "min",
  "pow",
  "round",
  "sum",
  "now",
  "date",
  "toDate",
  "any",
  "count",
  "hash",
  "sleep"
]);
const SEQ_MODULE_FUNCTIONS = /* @__PURE__ */ new Set([
  "map",
  "collect",
  "choose",
  "filter",
  "groupBy",
  "forAll",
  "exists",
  "takeWhile",
  "skipWhile",
  "indexed",
  "toLookup",
  "fold",
  "scan",
  "zip",
  "reverse",
  "updateAt",
  "distinctBy",
  "count",
  "any",
  "first",
  "firstOrNull",
  "firstOrDefault",
  "last",
  "lastOrNull",
  "lastOrDefault",
  "range",
  "take",
  "skip",
  "sum",
  "empty",
  "flatten",
  "eval",
  "join",
  "prepend",
  "append"
]);
function usesSeqModule(translatedFlowScriptText) {
  const text = String(translatedFlowScriptText || "");
  for (const name of SEQ_MODULE_FUNCTIONS) {
    if (new RegExp(`\\b${name}\\(`).test(text)) return true;
  }
  return false;
}
const DATETIME_STATIC_FUNCTIONS = {
  createdate: "createDate",
  createdateandtime: "createDateAndTime",
  isvaliddate: "isValidDate",
  settime: "setTime",
  differenceindays: "differenceInDays",
  differenceinseconds: "differenceInSeconds",
  createhhmmtext: "createHHMMText",
  getminutefromhhmmtext: "getMinuteFromHHMMText",
  gethourfromhhmmtext: "getHourFromHHMMText"
};
const DATETIME_METHOD_FUNCTIONS = {
  addseconds: "addSeconds",
  addminutes: "addMinutes",
  addhours: "addHours",
  adddays: "addDays",
  addmonths: "addMonths",
  addyears: "addYears",
  getsecond: "getSecond",
  getminute: "getMinute",
  gethour: "getHour",
  getdayofmonth: "getDayOfMonth",
  getmonth: "getMonth",
  getyear: "getYear"
};
const JSON_STATIC_FUNCTIONS = {
  encode: "serialize",
  encodetable: "serialize",
  decode: "deserialize",
  decodetable: "deserialize"
};
const KNOWN_RENAMES = {
  isnull: "isNull",
  first: "first",
  firstordefault: "firstOrDefault",
  firstornull: "firstOrNull",
  // FirstOrEmpty is deprecated in Connect — confirmed 2026-08-05: use firstOrNull instead.
  firstorempty: "firstOrNull",
  not: "not"
  // keyword, not a function, but harmless to normalize if seen called like one
};
function resolveFunctionName(classicName) {
  const key = classicName.toLowerCase();
  if (KNOWN_RENAMES[key]) return { name: KNOWN_RENAMES[key], resolved: true };
  if (CONNECT_BUILTINS[key]) return { name: CONNECT_BUILTINS[key], resolved: true };
  return { name: classicName, resolved: false };
}
function tokenize(text) {
  const tokens = [];
  let i = 0;
  const len = text.length;
  while (i < len) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      let j = i + 2;
      while (j < len && text[j] !== "\r" && text[j] !== "\n") j++;
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      const quoteChar = c;
      const start = i;
      let j = i + 1;
      let raw = "";
      while (j < len) {
        if (text[j] === quoteChar && text[j + 1] === quoteChar) {
          raw += quoteChar;
          j += 2;
          continue;
        }
        if (text[j] === quoteChar) break;
        raw += text[j];
        j++;
      }
      tokens.push({ type: "string", value: raw, start, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (c === "=" && text[i + 1] === ">") {
      tokens.push({ type: "op", value: "=>", start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (c === "!" && text[i + 1] === "=") {
      tokens.push({ type: "op", value: "!=", start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (c === "<" && text[i + 1] === "=") {
      tokens.push({ type: "op", value: "<=", start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (c === ">" && text[i + 1] === "=") {
      tokens.push({ type: "op", value: ">=", start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if ("=<>&+-*/(),{}[]:;.".includes(c)) {
      tokens.push({ type: "op", value: c, start: i, end: i + 1 });
      i++;
      continue;
    }
    const numMatch = text.slice(i).match(/^\d+(\.\d+)?/);
    if (numMatch) {
      tokens.push({ type: "number", value: numMatch[0], start: i, end: i + numMatch[0].length });
      i += numMatch[0].length;
      continue;
    }
    const wordMatch = text.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/);
    if (wordMatch) {
      tokens.push({ type: "word", value: wordMatch[0], start: i, end: i + wordMatch[0].length });
      i += wordMatch[0].length;
      continue;
    }
    throw new Error(`FlowClassicScript: unrecognized character '${c}' at position ${i} in: ${text}`);
  }
  return tokens;
}
function createParser(tokens, sourceText) {
  let pos = 0;
  const peek = (offset = 0) => tokens[pos + offset];
  const isWord = (t, word) => !!t && t.type === "word" && t.value.toLowerCase() === word;
  const isOp = (t, op) => !!t && t.type === "op" && t.value === op;
  const atEnd = () => pos >= tokens.length;
  const typeAliases = /* @__PURE__ */ new Map();
  function parseOr() {
    let left = parseAnd();
    while (isWord(peek(), "or")) {
      pos++;
      left = { type: "binary", op: "or", left, right: parseAnd() };
    }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (isWord(peek(), "and")) {
      pos++;
      left = { type: "binary", op: "and", left, right: parseNot() };
    }
    return left;
  }
  function parseNot() {
    if (isWord(peek(), "not")) {
      pos++;
      return { type: "unary", op: "not", operand: parseNot() };
    }
    return parseComparison();
  }
  function parseComparison() {
    const left = parseConcat();
    const t = peek();
    if (t && t.type === "op" && ["=", "!=", "<", ">", "<=", ">="].includes(t.value)) {
      pos++;
      return { type: "binary", op: t.value, left, right: parseConcat() };
    }
    if (isWord(t, "in")) {
      pos++;
      if (!isOp(peek(), "(")) throw new Error("FlowClassicScript: expected '(' after 'in'");
      pos++;
      const values = [];
      while (!isOp(peek(), ")")) {
        values.push(parseOr());
        if (isOp(peek(), ",")) pos++;
      }
      pos++;
      return { type: "in", left, values };
    }
    return left;
  }
  function parseConcat() {
    let left = parseAdditive();
    while (isOp(peek(), "&")) {
      pos++;
      left = { type: "binary", op: "&", left, right: parseAdditive() };
    }
    return left;
  }
  function parseAdditive() {
    let left = parseMultiplicative();
    while (isOp(peek(), "+") || isOp(peek(), "-")) {
      const op = tokens[pos++].value;
      left = { type: "binary", op, left, right: parseMultiplicative() };
    }
    return left;
  }
  function parseMultiplicative() {
    let left = parseWhere();
    while (isOp(peek(), "*") || isOp(peek(), "/")) {
      const op = tokens[pos++].value;
      left = { type: "binary", op, left, right: parseWhere() };
    }
    return left;
  }
  function parseWhere() {
    let left = parseUnary();
    if (isWord(peek(), "where")) {
      pos++;
      left = { type: "where", source: left, condition: parseOr() };
    } else if (isWord(peek(), "except")) {
      pos++;
      if (isWord(peek(), "where")) {
        pos++;
        const condition = parseOr();
        left = { type: "binary", op: "except", left, right: { type: "where", source: left, condition } };
      } else {
        left = { type: "binary", op: "except", left, right: parseUnary() };
      }
    }
    if (isWord(peek(), "with") && isOp(peek(1), "[")) {
      pos += 2;
      const fields = parseFieldList(parseOr);
      left = { type: "with", source: left, fields };
    }
    return left;
  }
  function parseUnary() {
    if (isOp(peek(), "-")) {
      pos++;
      return { type: "unary", op: "-", operand: parseUnary() };
    }
    if (isOp(peek(), "*")) {
      pos++;
      const t = peek();
      if (t && t.type === "word" && isOp(peek(1), "[")) {
        pos += 2;
        const fields = parseFieldList(parseOr);
        return { type: "unary", op: "table", operand: { type: "record", fields } };
      }
      return { type: "unary", op: "table", operand: parseUnary() };
    }
    return parsePostfix();
  }
  function parsePostfix() {
    let node = parsePrimary();
    while (isOp(peek(), ".")) {
      pos++;
      const fieldTok = peek();
      if (!fieldTok || fieldTok.type !== "word") throw new Error("FlowClassicScript: expected a field name after '.'");
      pos++;
      if (isOp(peek(), "(")) {
        pos++;
        const args = [node];
        while (!isOp(peek(), ")")) {
          args.push(parseOr());
          if (isOp(peek(), ",")) pos++;
        }
        pos++;
        node = { type: "call", name: fieldTok.value, args };
      } else {
        node = { type: "member", object: node, name: fieldTok.value };
      }
    }
    return node;
  }
  function parseFieldList(parseExprFn) {
    const fields = [];
    while (!isOp(peek(), "]")) {
      const fieldNameTok = peek();
      if (!fieldNameTok || fieldNameTok.type !== "word") throw new Error("FlowClassicScript: expected a field name in '[...]'");
      pos++;
      if (isOp(peek(), ":")) {
        pos++;
        const fieldExpr = parseExprFn();
        fields.push({ name: fieldNameTok.value, expr: fieldExpr });
      } else {
        fields.push({ name: fieldNameTok.value, expr: { type: "identifier", name: fieldNameTok.value } });
      }
      if (isOp(peek(), ",")) pos++;
    }
    pos++;
    return fields;
  }
  function tryParseMapAs() {
    if (!isWord(peek(), "map")) return null;
    const savedPos = pos;
    pos++;
    let source;
    if (isOp(peek(), "(")) {
      pos++;
      source = parseOr();
      if (!isOp(peek(), ")")) {
        pos = savedPos;
        return null;
      }
      pos++;
    } else if (peek() && peek().type === "word") {
      source = { type: "identifier", name: peek().value };
      pos++;
    } else {
      pos = savedPos;
      return null;
    }
    if (!isWord(peek(), "as") || !isOp(peek(1), "[")) {
      pos = savedPos;
      return null;
    }
    pos += 2;
    const fields = parseFieldList(parseOr);
    return { type: "mapAs", source, fields };
  }
  function tryParseSelectProjection() {
    if (!isWord(peek(), "select")) return null;
    const savedPos = pos;
    pos++;
    const distinct = isWord(peek(), "distinct");
    if (distinct) pos++;
    if (isOp(peek(), "*") && isWord(peek(1), "from")) {
      pos += 2;
      const source2 = parseOr();
      const orderBy2 = tryParseOrderByClause();
      if (source2.type === "innerJoin" || orderBy2) {
        return { type: "select", distinct, fields: [{ expr: { type: "identifier", name: "*" }, alias: null }], source: source2, orderBy: orderBy2 };
      }
      pos = savedPos;
      return null;
    }
    const fields = [];
    for (; ; ) {
      const expr = parseOr();
      let alias = null;
      if (isWord(peek(), "as")) {
        pos++;
        const aliasTok = peek();
        if (!aliasTok || aliasTok.type !== "word") {
          pos = savedPos;
          return null;
        }
        alias = aliasTok.value;
        pos++;
      }
      fields.push({ expr, alias });
      if (isOp(peek(), ",")) {
        pos++;
        continue;
      }
      break;
    }
    if (!isWord(peek(), "from")) {
      pos = savedPos;
      return null;
    }
    pos++;
    const source = parseOr();
    const orderBy = tryParseOrderByClause();
    return { type: "select", distinct, fields, source, orderBy };
  }
  function tryParseOrderByClause() {
    if (!isWord(peek(), "order") || !isWord(peek(1), "by")) return void 0;
    pos += 2;
    const specifiers = [];
    for (; ; ) {
      const expr = parseOr();
      let direction = null;
      if (isWord(peek(), "asc")) {
        direction = "asc";
        pos++;
      } else if (isWord(peek(), "desc")) {
        direction = "desc";
        pos++;
      }
      specifiers.push({ expr, direction });
      if (isOp(peek(), ",")) {
        pos++;
        continue;
      }
      break;
    }
    return specifiers;
  }
  function tryParseAliasedWhereSuffix(source) {
    if (!isWord(peek(), "as")) return null;
    const savedPos = pos;
    pos++;
    const aliasTok = peek();
    if (!aliasTok || aliasTok.type !== "word") {
      pos = savedPos;
      return null;
    }
    pos++;
    if (isWord(peek(), "where")) {
      pos++;
      const condition = parseOr();
      return { type: "anyAliasedWhere", source, alias: aliasTok.value, condition };
    }
    if (isWord(peek(), "inner") && isWord(peek(1), "join")) {
      pos += 2;
      const right = parsePrimaryAtom();
      if (!isWord(peek(), "as")) {
        pos = savedPos;
        return null;
      }
      pos++;
      const rightAliasTok = peek();
      if (!rightAliasTok || rightAliasTok.type !== "word") {
        pos = savedPos;
        return null;
      }
      pos++;
      if (!isWord(peek(), "on")) {
        pos = savedPos;
        return null;
      }
      pos++;
      const conditions = [parseComparison()];
      while (isWord(peek(), "and")) {
        pos++;
        conditions.push(parseComparison());
      }
      return { type: "innerJoin", left: source, leftAlias: aliasTok.value, right, rightAlias: rightAliasTok.value, conditions };
    }
    pos = savedPos;
    return null;
  }
  function parsePrimary() {
    const source = parsePrimaryAtom();
    return tryParseAliasedWhereSuffix(source) ?? source;
  }
  function parsePrimaryAtom() {
    const t = peek();
    if (!t) throw new Error("FlowClassicScript: unexpected end of expression");
    if (t.type === "string") {
      pos++;
      return { type: "literal", kind: "string", value: t.value };
    }
    if (t.type === "number") {
      pos++;
      return { type: "literal", kind: "number", value: t.value };
    }
    if (isWord(t, "nil") || isWord(t, "null")) {
      pos++;
      return { type: "literal", kind: "null", value: "null" };
    }
    if (isOp(t, "(")) {
      pos++;
      const inner = parseOr();
      if (!isOp(peek(), ")")) throw new Error("FlowClassicScript: expected ')'");
      pos++;
      return inner;
    }
    if (isOp(t, "[")) {
      pos++;
      const fields = parseFieldList(parseOr);
      return { type: "record", fields };
    }
    const mapAsNode = tryParseMapAs();
    if (mapAsNode) return mapAsNode;
    const selectNode = tryParseSelectProjection();
    if (selectNode) return selectNode;
    if (isWord(t, "function")) {
      pos++;
      if (!isOp(peek(), "(")) throw new Error("FlowClassicScript: expected '(' after 'function'");
      pos++;
      const params = [];
      while (!isOp(peek(), ")")) {
        const p = peek();
        if (!p || p.type !== "word") throw new Error("FlowClassicScript: expected a parameter name in function literal");
        params.push(p.value);
        pos++;
        if (isOp(peek(), ",")) pos++;
      }
      pos++;
      if (!isOp(peek(), "=>")) throw new Error("FlowClassicScript: expected '=>' in function literal");
      pos++;
      let body;
      const block = parseBraceThenDoBlock();
      if (block) {
        body = { kind: "block", statements: block };
      } else {
        body = { kind: "expr", expr: parseOr() };
      }
      return { type: "functionLiteral", params, body };
    }
    if (isWord(t, "case")) {
      pos++;
      const branches = [];
      while (isWord(peek(), "when")) {
        pos++;
        const cond = parseOr();
        if (!isWord(peek(), "then")) throw new Error("FlowClassicScript: expected 'then' in case expression");
        pos++;
        const result = parseOr();
        branches.push({ cond, result });
      }
      if (branches.length === 0) throw new Error("FlowClassicScript: expected at least one 'when' branch in case expression");
      if (!isWord(peek(), "else")) throw new Error("FlowClassicScript: expected 'else' in case expression");
      pos++;
      const elseResult = parseOr();
      if (!isWord(peek(), "end")) throw new Error("FlowClassicScript: expected 'end' to close case expression");
      pos++;
      return { type: "case", branches, elseResult };
    }
    if (t.type === "word") {
      pos++;
      const genericArgs = tryParseGenericTypeArgs();
      if (isOp(peek(), "(")) {
        pos++;
        const args = [];
        while (!isOp(peek(), ")")) {
          args.push(parseOr());
          if (isOp(peek(), ",")) pos++;
        }
        pos++;
        const lastDot = t.value.lastIndexOf(".");
        if (lastDot !== -1) {
          const methodName = t.value.slice(lastDot + 1);
          const receiverPath = t.value.slice(0, lastDot);
          if (resolveFunctionName(methodName).resolved) {
            return { type: "call", name: methodName, args: [{ type: "identifier", name: receiverPath }, ...args], genericArgs: genericArgs ?? void 0 };
          }
        }
        return { type: "call", name: t.value, args, genericArgs: genericArgs ?? void 0 };
      }
      return { type: "identifier", name: t.value };
    }
    throw new Error(`FlowClassicScript: unexpected token '${t.value}' (${t.type})`);
  }
  function parseTopLevelExpression() {
    return parseOr();
  }
  function consumeOptionalSemicolon() {
    if (isOp(peek(), ";")) pos++;
  }
  function assertStatementEnd(statementKind) {
    const t = peek();
    if (t && !isOp(t, ";") && !isOp(t, "}")) {
      throw new Error(`FlowClassicScript: unexpected token '${t.value}' after ${statementKind} statement's value`);
    }
  }
  function parseLet() {
    pos++;
    const nameTok = peek();
    if (!nameTok || nameTok.type !== "word") throw new Error("FlowClassicScript: expected a variable name after 'let'");
    pos++;
    if (!isOp(peek(), "=")) throw new Error(`FlowClassicScript: expected '=' after 'let ${nameTok.value}'`);
    pos++;
    const expr = parseTopLevelExpression();
    assertStatementEnd("let");
    consumeOptionalSemicolon();
    return { type: "let", name: nameTok.value, expr };
  }
  function parseSet() {
    pos++;
    const nameTok = peek();
    if (!nameTok || nameTok.type !== "word") throw new Error("FlowClassicScript: expected a variable name after 'set'");
    pos++;
    if (!isOp(peek(), "=")) throw new Error(`FlowClassicScript: expected '=' after 'set ${nameTok.value}'`);
    pos++;
    const expr = parseTopLevelExpression();
    assertStatementEnd("set");
    consumeOptionalSemicolon();
    return { type: "set", name: nameTok.value, expr };
  }
  function parseReturn() {
    pos++;
    if (!peek() || isOp(peek(), ";")) {
      consumeOptionalSemicolon();
      return { type: "return", expr: null };
    }
    const expr = parseTopLevelExpression();
    assertStatementEnd("return");
    consumeOptionalSemicolon();
    return { type: "return", expr };
  }
  function parseBraceThenDoBlock() {
    if (isOp(peek(), "{")) {
      pos++;
      const statements = parseStatementsUntil(() => isOp(peek(), "}") || isWord(peek(), "else"), false);
      if (isOp(peek(), "}")) pos++;
      return statements;
    }
    if (isWord(peek(), "then")) {
      pos++;
      const statements = parseStatementsUntil(
        () => isWord(peek(), "end") || isWord(peek(), "elseif") || isWord(peek(), "else"),
        false
      );
      if (isWord(peek(), "end")) pos++;
      return statements;
    }
    if (isWord(peek(), "do")) {
      pos++;
      return parseStatementsUntil(() => isWord(peek(), "done"), true);
    }
    return null;
  }
  function parseBlockOrSingleStatement() {
    const block = parseBraceThenDoBlock();
    if (block) return block;
    if (isOp(peek(), ":")) {
      pos++;
      return [parseStatement()];
    }
    throw new Error("FlowClassicScript: expected '{', ':', 'then', or 'do' to start a statement body");
  }
  function parseIf() {
    pos++;
    const cond = parseOr();
    const body = parseBlockOrSingleStatement();
    const branches = [{ cond, body }];
    let elseBody = null;
    for (; ; ) {
      if (isWord(peek(), "elseif")) {
        pos++;
        const elseifCond = parseOr();
        branches.push({ cond: elseifCond, body: parseBlockOrSingleStatement() });
        continue;
      }
      if (isWord(peek(), "else") && isWord(peek(1), "if")) {
        pos += 2;
        const elseifCond = parseOr();
        branches.push({ cond: elseifCond, body: parseBlockOrSingleStatement() });
        continue;
      }
      if (isWord(peek(), "else")) {
        pos++;
        elseBody = isOp(peek(), "{") || isOp(peek(), ":") || isWord(peek(), "then") || isWord(peek(), "do") ? parseBlockOrSingleStatement() : parseStatementsUntil(() => isWord(peek(), "end"), true);
      }
      break;
    }
    return { type: "if", branches, elseBody };
  }
  function parseFor() {
    pos++;
    const varTok = peek();
    if (!varTok || varTok.type !== "word") throw new Error("FlowClassicScript: expected a loop variable name after 'for'");
    pos++;
    if (!isWord(peek(), "in")) throw new Error(`FlowClassicScript: expected 'in' after 'for ${varTok.value}'`);
    pos++;
    const source = parseOr();
    const body = parseBlockOrSingleStatement();
    return { type: "for", varName: varTok.value, source, body };
  }
  function parseWhile() {
    pos++;
    const cond = parseOr();
    const body = parseBlockOrSingleStatement();
    return { type: "while", cond, body };
  }
  function inferConnectTypeFromDefaultLiteral() {
    if (isOp(peek(), "-")) pos++;
    const t = peek();
    if (!t) throw new Error("FlowClassicScript: expected a default value in type literal");
    if (t.type === "string") {
      pos++;
      return "text";
    }
    if (t.type === "number") {
      pos++;
      return "number";
    }
    if (isWord(t, "true") || isWord(t, "false")) {
      pos++;
      return "boolean";
    }
    throw new Error(`FlowClassicScript: unsupported default value '${t.value}' in type literal`);
  }
  function parseTypeLiteral() {
    if (!isOp(peek(), "[")) throw new Error("FlowClassicScript: expected '[' in type literal");
    pos++;
    const fields = [];
    while (!isOp(peek(), "]")) {
      const fieldNameTok = peek();
      if (!fieldNameTok || fieldNameTok.type !== "word") throw new Error("FlowClassicScript: expected a field name in type literal");
      pos++;
      let fieldType;
      if (isOp(peek(), "=")) {
        pos++;
        fieldType = `${inferConnectTypeFromDefaultLiteral()}?`;
      } else if (isOp(peek(), ":")) {
        pos++;
        let isArray = false;
        if (isOp(peek(), "*")) {
          pos++;
          isArray = true;
        }
        if (isArray && peek() && peek().type === "word" && !isOp(peek(), "[")) {
          const aliasTok = peek();
          pos++;
          fieldType = `${typeAliases.get(aliasTok.value) ?? aliasTok.value}*`;
        } else {
          if (!isOp(peek(), "[")) {
            throw new Error(`FlowClassicScript: expected a nested '[...]' type after ':' for field '${fieldNameTok.value}' in type literal`);
          }
          const nested = parseTypeLiteral();
          fieldType = isArray ? `${nested}*` : nested;
        }
      } else if (isOp(peek(), ",") || isOp(peek(), "]")) {
        fieldType = "text?";
      } else {
        throw new Error(`FlowClassicScript: expected '=' or ':' after field name '${fieldNameTok.value}' in type literal`);
      }
      fields.push(`${fieldNameTok.value}: ${fieldType}`);
      if (isOp(peek(), ",")) pos++;
    }
    pos++;
    return `{ ${fields.join(", ")} }`;
  }
  function parseTypeAliasStatement() {
    pos++;
    const nameTok = peek();
    if (!nameTok || nameTok.type !== "word") throw new Error("FlowClassicScript: expected a type name after 'type'");
    pos++;
    if (!isOp(peek(), "=")) throw new Error(`FlowClassicScript: expected '=' after 'type ${nameTok.value}'`);
    pos++;
    const typeExpr = parseTypeLiteral();
    typeAliases.set(nameTok.value, typeExpr);
    consumeOptionalSemicolon();
    return { type: "noop" };
  }
  function tryParseGenericTypeArgs() {
    if (!isOp(peek(), "<")) return null;
    const saved = pos;
    pos++;
    const args = [];
    for (; ; ) {
      const t = peek();
      if (!t || t.type !== "word") {
        pos = saved;
        return null;
      }
      args.push(typeAliases.get(t.value) ?? t.value);
      pos++;
      if (isOp(peek(), ",")) {
        pos++;
        continue;
      }
      break;
    }
    if (!isOp(peek(), ">") || !isOp(peek(1), "(")) {
      pos = saved;
      return null;
    }
    pos++;
    return args;
  }
  function tryParseBareAssignment() {
    const t = peek();
    if (!t || t.type !== "word" || !isOp(peek(1), "=")) return null;
    pos += 2;
    const expr = parseTopLevelExpression();
    assertStatementEnd("assignment");
    consumeOptionalSemicolon();
    return { type: "set", name: t.value, expr };
  }
  function parseOneStatement() {
    const t = peek();
    if (isWord(t, "if")) return parseIf();
    if (isWord(t, "for")) return parseFor();
    if (isWord(t, "while")) return parseWhile();
    if (isWord(t, "type") && peek(1) && peek(1).type === "word" && isOp(peek(2), "=")) return parseTypeAliasStatement();
    if (isWord(t, "let")) return parseLet();
    if (isWord(t, "set")) return parseSet();
    if (isWord(t, "return")) return parseReturn();
    if (isWord(t, "break")) {
      pos++;
      consumeOptionalSemicolon();
      return { type: "break" };
    }
    if (isWord(t, "continue")) {
      pos++;
      consumeOptionalSemicolon();
      return { type: "continue" };
    }
    const bareAssignment = tryParseBareAssignment();
    if (bareAssignment) return bareAssignment;
    throw new Error(`FlowClassicScript: unrecognized statement starting with '${t ? t.value : "<end of script>"}'`);
  }
  function parseStatement() {
    const start = pos;
    try {
      return parseOneStatement();
    } catch (e) {
      pos = start;
      return recoverStatement(e);
    }
  }
  function recoverStatement(error) {
    const startPos = pos;
    let depth = 0;
    let sawOpenBrace = false;
    let i = pos;
    let found = false;
    for (; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.type !== "op") continue;
      if (tok.value === "(" || tok.value === "[" || tok.value === "{") {
        depth++;
        if (tok.value === "{") sawOpenBrace = true;
      } else if (tok.value === ")" || tok.value === "]" || tok.value === "}") {
        depth--;
        if (depth < 0) {
          if (i === startPos) i++;
          found = true;
          break;
        }
        if (depth === 0 && tok.value === "}" && sawOpenBrace) {
          i++;
          found = true;
          break;
        }
      } else if (tok.value === ";" && depth === 0) {
        i++;
        found = true;
        break;
      }
    }
    if (!found) throw error;
    const endPos = i;
    const originalText = sourceText.slice(tokens[startPos].start, tokens[endPos - 1].end).trim();
    pos = endPos;
    return { type: "raw", originalText, errorMessage: error.message };
  }
  function parseStatementsUntil(stopCheck, consumeEndToken) {
    const statements = [];
    while (!atEnd() && !stopCheck()) {
      statements.push(parseStatement());
    }
    if (consumeEndToken) {
      if (!stopCheck()) throw new Error("FlowClassicScript: unexpected end of script inside a block");
      pos++;
    }
    return statements;
  }
  function parseProgram() {
    return parseStatementsUntil(() => false, false);
  }
  return {
    parseExpression: parseOr,
    parseTopLevelExpression,
    parseProgram,
    getPos: () => pos,
    atEnd
  };
}
function parseExpression(text) {
  const tokens = tokenize(text);
  const parser = createParser(tokens, text);
  const node = parser.parseTopLevelExpression();
  if (!parser.atEnd()) throw new Error(`FlowClassicScript: unexpected trailing token '${tokens[parser.getPos()].value}'`);
  return node;
}
function matchTableCall(classicExpression) {
  const trimmed = String(classicExpression || "").trim();
  const braced = trimmed.match(/^\{([\s\S]*)\}$/);
  const inner = (braced ? braced[1] : trimmed).trim();
  const m = /^table\s*\(([\s\S]*)\)$/i.exec(inner);
  if (!m) return null;
  const columnNames = m[1].split(",").map((c) => c.trim()).filter(Boolean);
  return columnNames.length > 0 ? columnNames : null;
}
function requiredEnumOpens(realFields, contextModuleName) {
  const modules = /* @__PURE__ */ new Set();
  (realFields || []).forEach((f) => {
    const qualified = QUALIFIED_ENUM_TYPE_RE.exec(f.type);
    if (qualified) {
      modules.add(qualified[1]);
      return;
    }
    if (contextModuleName && BARE_ENUM_TYPE_RE.exec(f.type)) modules.add(contextModuleName);
  });
  return [...modules];
}
function buildTypedFieldsText(columnNames, realFields, indent, contextModuleName) {
  const realByUpperName = new Map((realFields || []).map((f) => [f.name.toUpperCase(), f]));
  return columnNames.map((name) => {
    const real = realByUpperName.get(name.toUpperCase());
    if (!real) return `${indent}${name}: text?`;
    return `${indent}${name}: ${qualifyEnumTypeText(real.type, contextModuleName)}`;
  }).join(",\n");
}
function buildTableDeclaration(targetVariableName, columnNames, realFields, contextModuleName) {
  const fields = buildTypedFieldsText(columnNames, realFields, "    ", contextModuleName);
  const realByUpperName = new Map((realFields || []).map((f) => [f.name.toUpperCase(), f]));
  const anyReal = columnNames.some((name) => realByUpperName.has(name.toUpperCase()));
  const note = anyReal ? "// NOTE: column types resolved from a real query's row type where a later 'TableA & TableB' usage matched a column name; anything unmatched still defaults to nullable text \u2014 verify" : "// NOTE: column types default to nullable text (safe generic placeholder, not confirmed) \u2014 verify/adjust per real downstream usage";
  return `let ${targetVariableName}: {
${fields}
}* = []; ${note}`;
}
function emitStringLiteral(raw) {
  return JSON.stringify(raw);
}
function flattenConcatChain(node, leaves) {
  if (node.type === "binary" && node.op === "&") {
    flattenConcatChain(node.left, leaves);
    flattenConcatChain(node.right, leaves);
  } else {
    leaves.push(node);
  }
}
function chainIsTextConcat(node) {
  const leaves = [];
  flattenConcatChain(node, leaves);
  return leaves.some((leaf) => {
    if (leaf.type === "literal" && leaf.kind === "string") return true;
    if (leaf.type === "case") return true;
    if (leaf.type === "call") {
      const { name } = resolveFunctionName(leaf.name);
      return NON_NULLABLE_RETURN_FUNCTIONS.has(name);
    }
    return false;
  });
}
function uniqueFilterParamName(ctx) {
  const depth = ctx && ctx.filterDepth || 0;
  return depth === 0 ? "x" : `x${depth}`;
}
function bareIdentifierNameOf(node) {
  return node.type === "identifier" && !node.name.includes(".") ? node.name : null;
}
function schemaLookupKeyOf(node) {
  if (node.type !== "identifier") return null;
  return node.name.replace(/\.Results$/, "");
}
const SINGLE_ROW_PICK_FUNCTIONS = /* @__PURE__ */ new Set([
  "first",
  "firstordefault",
  "firstornull",
  "firstorempty",
  "last",
  "lastordefault",
  "lastornull"
]);
function unwrapToSourceIdentifier(node) {
  if (node.type === "identifier") return node;
  if (node.type === "where" && node.source.type === "identifier") return node.source;
  if (node.type === "call" && node.args.length === 1 && SINGLE_ROW_PICK_FUNCTIONS.has(node.name.toLowerCase())) {
    return unwrapToSourceIdentifier(node.args[0]);
  }
  return null;
}
function rowFieldNameOf(expr, ctx) {
  const bare = bareIdentifierNameOf(expr);
  if (bare) return bare;
  if (expr.type === "identifier" && expr.name.includes(".")) return expr.name.slice(expr.name.lastIndexOf(".") + 1);
  return null;
}
function resolveFieldType(expr, ctx) {
  if (!ctx) return null;
  const bare = bareIdentifierNameOf(expr);
  if (bare) return ctx.rowSchema ? ctx.rowSchema.get(bare) ?? null : null;
  if (expr.type !== "identifier" || !expr.name.includes(".")) return null;
  const lastDot = expr.name.lastIndexOf(".");
  const objectName = expr.name.slice(0, lastDot);
  const fieldName = expr.name.slice(lastDot + 1);
  const objectSchema = ctx.schemaLookup ? ctx.schemaLookup(objectName) : null;
  if (objectSchema) return objectSchema.get(fieldName) ?? null;
  return ctx.rowSchema ? ctx.rowSchema.get(fieldName) ?? null : null;
}
function enumFieldTypeOf(expr, ctx) {
  const fieldType = resolveFieldType(expr, ctx);
  return fieldType && fieldType.kind === "enum" ? fieldType : null;
}
function recordFieldTypeOf(expr, ctx) {
  const fieldType = resolveFieldType(expr, ctx);
  return fieldType && fieldType.kind === "record" && fieldType.hasKeyrefField === true ? fieldType : null;
}
function booleanFieldTypeOf(expr, ctx) {
  const fieldType = resolveFieldType(expr, ctx);
  return fieldType && fieldType.kind === "boolean" ? fieldType : null;
}
function isBooleanLiteralSpelling(value) {
  return /^(true|false)$/i.test(value);
}
function isConfirmedNonNullableArg(expr, ctx) {
  if (expr.type === "literal" && expr.kind === "null") return false;
  if (expr.type === "literal") return true;
  if (expr.type === "identifier" && expr.name.endsWith(".TotalCount")) return true;
  if (expr.type === "binary") {
    if (expr.op === "&") return true;
    return isConfirmedNonNullableArg(expr.left, ctx) && isConfirmedNonNullableArg(expr.right, ctx);
  }
  if (expr.type === "call") {
    const { name } = resolveFunctionName(expr.name);
    if (NON_NULLABLE_RETURN_FUNCTIONS.has(name)) return true;
  }
  const fieldType = resolveFieldType(expr, ctx);
  return !!fieldType && fieldType.optional === false;
}
function isConfirmedNumberExpr(expr, ctx) {
  if (expr.type === "literal") return expr.kind === "number";
  if (expr.type === "binary" && (expr.op === "+" || expr.op === "-" || expr.op === "*" || expr.op === "/")) return true;
  if (expr.type === "call") {
    const { name } = resolveFunctionName(expr.name);
    if (name === "isNull" && expr.args.length >= 1) return isConfirmedNumberExpr(expr.args[0], ctx);
  }
  if (expr.type === "identifier" && ctx && ctx.scalarVarKinds && ctx.scalarVarKinds.get(expr.name) === "number") return true;
  const fieldType = resolveFieldType(expr, ctx);
  return !!fieldType && fieldType.kind === "number";
}
function matchEnvironmentPropertyGroupLookup(node) {
  if (node.name !== "Value") return null;
  if (node.object.type !== "call" || node.object.args.length !== 1) return null;
  const { name } = resolveFunctionName(node.object.name);
  if (name !== "firstOrNull") return null;
  const arg = node.object.args[0];
  if (arg.type !== "where") return null;
  if (arg.source.type !== "identifier" || !/^environment\.\w+$/.test(arg.source.name)) return null;
  if (arg.condition.type !== "binary" || arg.condition.op !== "=") return null;
  const { left, right } = arg.condition;
  if (left.type !== "identifier" || left.name !== "Property") return null;
  if (right.type !== "literal" || right.kind !== "string") return null;
  return right.value;
}
function emitFieldValueWithEnumExtraction(expr, ctx, rowSchema) {
  const mergedCtx = Object.assign({}, ctx, { rowSchema });
  const text = emit(expr, mergedCtx);
  const enumType = enumFieldTypeOf(expr, mergedCtx);
  return enumType ? `${text}.name` : text;
}
function emit(node, ctx) {
  switch (node.type) {
    case "literal":
      return node.kind === "string" ? emitStringLiteral(node.value) : node.value;
    case "identifier": {
      if (node.name.endsWith(".TotalCount")) {
        return `count(${node.name.slice(0, -".TotalCount".length)})`;
      }
      if (/\.Results\./.test(node.name)) return node.name.replace(/\.Results(?=\.)/g, "");
      if (node.name.includes(".") || !ctx || !ctx.qualifyParam) return node.name;
      if (ctx.protectedNames && ctx.protectedNames.has(node.name)) return node.name;
      if (ctx.rowSchema) {
        if (!ctx.rowSchema.has(node.name)) return node.name;
      } else if (ctx.enclosingRowSchemas && ctx.enclosingRowSchemas.some((s) => s.has(node.name))) {
        return node.name;
      }
      return `${ctx.qualifyParam}.${node.name}`;
    }
    case "member": {
      const envProp = matchEnvironmentPropertyGroupLookup(node);
      if (envProp !== null) return `environment.${envProp}`;
      const objectText = emit(node.object, ctx);
      const isAtomic = node.object.type === "literal" || node.object.type === "identifier" || node.object.type === "member" || node.object.type === "call" || node.object.type === "record";
      return isAtomic ? `${objectText}.${node.name}` : `(${objectText}).${node.name}`;
    }
    case "call": {
      if (node.name.toLowerCase() === "table") {
        const columnNames = node.args.map((a) => a.type === "identifier" ? a.name : emit(a, ctx));
        return `/* TODO: Classic 'table(${columnNames.join(", ")})' declares an empty array with columns [${columnNames.join(", ")}] \u2014 needs a confirmed Connect empty-typed-array literal syntax */ []`;
      }
      if (/^isnan$/i.test(node.name)) {
        return `not (${emit({ type: "call", name: "IsNumber", args: node.args }, ctx)})`;
      }
      if (/^isnull$/i.test(node.name) && node.args.length === 2 && node.args[1].type === "literal" && node.args[1].kind === "string" && isConfirmedNumberExpr(node.args[0], ctx)) {
        return `isNull(${emit(node.args[0], ctx)}, 0)`;
      }
      const moduleCallMatch = /^(\w+)\.(\w+)$/.exec(node.name);
      if (moduleCallMatch) {
        const moduleKey = moduleCallMatch[1].toLowerCase();
        const subKey = moduleCallMatch[2].toLowerCase();
        if (moduleKey === "datetime" && DATETIME_STATIC_FUNCTIONS[subKey]) {
          return `DateTime.${DATETIME_STATIC_FUNCTIONS[subKey]}(${node.args.map((a) => emit(a, ctx)).join(", ")})`;
        }
        if (moduleKey === "datetime" && DATETIME_METHOD_FUNCTIONS[subKey] && node.args.length >= 1) {
          const [receiver, ...rest] = node.args;
          const restText = rest.map((a) => emit(a, ctx)).join(", ");
          return `${emit(receiver, ctx)}.${DATETIME_METHOD_FUNCTIONS[subKey]}(${restText})`;
        }
        if (moduleKey === "json" && JSON_STATIC_FUNCTIONS[subKey]) {
          const genericSuffix = node.genericArgs && node.genericArgs.length > 0 ? `<${node.genericArgs.join(", ")}>` : "";
          return `JSON.${JSON_STATIC_FUNCTIONS[subKey]}${genericSuffix}(${node.args.map((a) => emit(a, ctx)).join(", ")})`;
        }
      }
      if (/^base64decodetext$/i.test(node.name) && node.args.length >= 1) {
        return `base64Decode(${emit(node.args[0], ctx)})`;
      }
      const { name, resolved: builtinResolved } = resolveFunctionName(node.name);
      const resolved = builtinResolved || !!(ctx && ctx.localFunctionSignatures && ctx.localFunctionSignatures.has(node.name));
      const argsText = node.args.map((a, i) => {
        const text = emit(a, ctx);
        const argKindForEnum = NON_NULLABLE_ARG_FUNCTIONS[name] ? NON_NULLABLE_ARG_FUNCTIONS[name][i] : VARIADIC_NON_NULLABLE_FUNCTIONS[name] ?? localFunctionParamKind(node.name, i, ctx);
        if (argKindForEnum === "text" && enumFieldTypeOf(a, ctx)) return `${text}.name`;
        const argKind = NON_NULLABLE_ARG_FUNCTIONS[name] ? NON_NULLABLE_ARG_FUNCTIONS[name][i] : VARIADIC_NON_NULLABLE_FUNCTIONS[name];
        if (argKind && !isConfirmedNonNullableArg(a, ctx)) {
          const ownFieldType = resolveFieldType(a, ctx);
          const ownKind = ownFieldType ? ownFieldType.kind : isConfirmedNumberExpr(a, ctx) ? "number" : null;
          const ownDefault = ownKind ? nullableWrapDefault(ownKind) : null;
          const replacement = ownDefault ?? (argKind === "number" ? "0" : '""');
          const wrapped = `isNull(${text}, ${replacement})`;
          if (ownKind === "number" && argKind === "text") return `str(${wrapped})`;
          if (ownKind === "text" && argKind === "number") return `val(${wrapped})`;
          return wrapped;
        }
        return text;
      }).join(", ");
      const call = `${name}(${argsText})`;
      return resolved ? call : `/* TODO: verify Connect equivalent for Classic function '${node.name}' */ ${call}`;
    }
    case "unary": {
      if (node.op === "table") return `[${emit(node.operand, ctx)}]`;
      if (node.op !== "not") return `-(${emit(node.operand, ctx)})`;
      const textBoolean = emitTextAsBooleanOperand(node.operand, ctx, true);
      return textBoolean ?? `not (${emitScalarWithNullableWrap(node.operand, ctx)})`;
    }
    case "binary": {
      if ((node.op === "=" || node.op === "!=") && node.left.type === "identifier" && node.left.name === "clientType" && node.right.type === "literal" && node.right.kind === "string" && node.right.value === "Designer") {
        return `(environmentType ${node.op} "dev")`;
      }
      if (node.op === "=" || node.op === "!=") {
        const enumSide = enumFieldTypeOf(node.left, ctx) ? { field: node.left, literal: node.right } : enumFieldTypeOf(node.right, ctx) ? { field: node.right, literal: node.left } : null;
        if (enumSide && enumSide.literal.type === "literal" && enumSide.literal.kind === "string") {
          const enumType = enumFieldTypeOf(enumSide.field, ctx);
          const value = `${enumType.enumType}.fromText(${JSON.stringify(enumSide.literal.value)})`;
          return `(${emit(enumSide.field, ctx)} ${node.op} ${value})`;
        }
      }
      if (node.op === "=" || node.op === "!=") {
        const isNullLiteral = (n) => n.type === "literal" && n.kind === "null";
        const recordSide = isNullLiteral(node.right) && recordFieldTypeOf(node.left, ctx) ? node.left : isNullLiteral(node.left) && recordFieldTypeOf(node.right, ctx) ? node.right : null;
        if (recordSide) return `(${emit(recordSide, ctx)}.keyref ${node.op} null)`;
      }
      if (node.op === "=" || node.op === "!=") {
        const boolSide = booleanFieldTypeOf(node.left, ctx) ? node.left : booleanFieldTypeOf(node.right, ctx) ? node.right : null;
        const literalSide = boolSide === node.left ? node.right : node.left;
        if (boolSide && literalSide.type === "literal" && literalSide.kind === "string" && isBooleanLiteralSpelling(literalSide.value)) {
          return `(${emit(boolSide, ctx)} ${node.op} ${literalSide.value.toLowerCase()})`;
        }
      }
      if (node.op === "&") {
        const terms = [];
        flattenConcatChain(node, terms);
        const isTextConcat = chainIsTextConcat(node);
        return terms.map((t) => {
          if (!isTextConcat || t.type !== "identifier" && t.type !== "case") return emit(t, ctx);
          const fieldType = resolveFieldType(t, ctx);
          if (fieldType && fieldType.kind === "enum") return `${emit(t, ctx)}.name`;
          if (fieldType && fieldType.kind !== "text" && fieldType.kind !== "unknown") {
            return fieldType.optional === true ? `isNull(str(${emit(t, ctx)}), "")` : emit(t, ctx);
          }
          return `isNull(${emit(t, ctx)}, "")`;
        }).join(" & ");
      }
      const isArithmetic = node.op === "+" || node.op === "-" || node.op === "*" || node.op === "/";
      const isLogical = node.op === "and" || node.op === "or";
      const needsWrap = isArithmetic || isLogical;
      const left = isLogical && emitTextAsBooleanOperand(node.left, ctx, false) || (needsWrap ? emitScalarWithNullableWrap(node.left, ctx) : emit(node.left, ctx));
      const right = isLogical && emitTextAsBooleanOperand(node.right, ctx, false) || (needsWrap ? emitScalarWithNullableWrap(node.right, ctx) : emit(node.right, ctx));
      return `(${left} ${node.op} ${right})`;
    }
    case "in": {
      const values = node.values.map((v) => emit(v, ctx)).join(", ");
      return `${emit(node.left, ctx)} in [${values}]`;
    }
    case "where": {
      const sourceKey = schemaLookupKeyOf(node.source);
      const rowSchema = sourceKey && ctx && ctx.schemaLookup ? ctx.schemaLookup(sourceKey) : null;
      if (ctx && ctx.noSeqAvailable) {
        const nativeCtx = Object.assign({}, ctx, { qualifyParam: void 0, rowSchema });
        return `${emit(node.source, ctx)} where ${emit(node.condition, nativeCtx)}`;
      }
      const paramName = uniqueFilterParamName(ctx);
      const innerCtx = Object.assign({}, ctx, {
        qualifyParam: paramName,
        rowSchema,
        rowSchemaIsForLoopVar: false,
        filterDepth: (ctx && ctx.filterDepth || 0) + 1,
        enclosingRowSchemas: ctx && ctx.rowSchema && !ctx.rowSchemaIsForLoopVar ? [...ctx.enclosingRowSchemas || [], ctx.rowSchema] : ctx && ctx.enclosingRowSchemas
      });
      return `(${emit(node.source, ctx)}).filter(${paramName} => ${emit(node.condition, innerCtx)})`;
    }
    case "innerJoin":
      return `/* TODO: Classic 'inner join' is only rewritten at a statement's own top-level let/return value (real Connect limits: no wildcard select, single equality condition only) -- this occurrence wasn't rewritten */ null`;
    case "anyAliasedWhere": {
      const conditionCtx = Object.assign({}, ctx, {
        protectedNames: new Set(ctx && ctx.protectedNames ? ctx.protectedNames : []).add(node.alias)
      });
      if (ctx && ctx.noSeqAvailable) {
        // Decision steps cannot open Seq, so no .filter(): use the native SQL-like form and keep the alias.
        return `${emit(node.source, ctx)} as ${node.alias} where ${emit(node.condition, conditionCtx)}`;
      }
      return `(${emit(node.source, ctx)}).filter(${node.alias} => ${emit(node.condition, conditionCtx)})`;
    }
    case "select": {
      const sourceIdentifier = unwrapToSourceIdentifier(node.source);
      const sourceKey = sourceIdentifier ? schemaLookupKeyOf(sourceIdentifier) : null;
      const sourceRowSchema = sourceKey && ctx && ctx.schemaLookup ? ctx.schemaLookup(sourceKey) : null;
      const fieldsCtx = sourceRowSchema ? Object.assign({}, ctx, {
        enclosingRowSchemas: [...ctx && ctx.enclosingRowSchemas ? ctx.enclosingRowSchemas : [], sourceRowSchema]
      }) : ctx;
      const fieldsText = node.fields.map((f) => {
        const exprText = emit(f.expr, fieldsCtx);
        return f.alias ? `${exprText} as ${f.alias}` : exprText;
      }).join(", ");
      const orderByText = node.orderBy && node.orderBy.length > 0 ? ` order by ${node.orderBy.map((o) => `${emit(o.expr, fieldsCtx)}${o.direction ? ` ${o.direction}` : ""}`).join(", ")}` : "";
      return `select ${node.distinct ? "distinct " : ""}${fieldsText} from ${emit(node.source, ctx)}${orderByText}`;
    }
    case "record": {
      const fieldsText = node.fields.map((f) => `${f.name}: ${emitFieldValueWithEnumExtraction(f.expr, ctx, ctx && ctx.rowSchema)}`).join(", ");
      return `{${fieldsText}}`;
    }
    case "mapAs": {
      const sourceKey = schemaLookupKeyOf(node.source);
      const sourceRowSchema = sourceKey && ctx && ctx.schemaLookup ? ctx.schemaLookup(sourceKey) : null;
      const fieldsText = node.fields.map((f) => `${f.name}: ${emitFieldValueWithEnumExtraction(f.expr, ctx, sourceRowSchema)}`).join(", ");
      return `map (${emit(node.source, ctx)}) as {${fieldsText}}`;
    }
    case "with": {
      const sourceIdentifier = unwrapToSourceIdentifier(node.source);
      const sourceKey = sourceIdentifier ? schemaLookupKeyOf(sourceIdentifier) : null;
      const sourceRowSchema = sourceKey && ctx && ctx.schemaLookup ? ctx.schemaLookup(sourceKey) : null;
      const fieldsText = node.fields.map((f) => `${f.name}: ${emitFieldValueWithEnumExtraction(f.expr, ctx, sourceRowSchema)}`).join(", ");
      return `${emit(node.source, ctx)} with {${fieldsText}}`;
    }
    case "case": {
      const branchesText = node.branches.map((b) => `when ${emit(b.cond, ctx)} then ${emit(b.result, ctx)}`).join(" ");
      return `case ${branchesText} else ${emit(node.elseResult, ctx)} end`;
    }
    case "functionLiteral": {
      const paramsText = node.params.join(", ");
      const bodyText = node.body.kind === "expr" ? emit(node.body.expr, ctx) : `{ ${emitStatements(node.body.statements, ctx)} }`;
      return `(${paramsText}) => ${bodyText}`;
    }
    default:
      throw new Error(`FlowClassicScript: unknown AST node type '${node.type}'`);
  }
}
function indentBlock(text) {
  return text.split("\n").map((line) => "    " + line).join("\n");
}
let mapAsTempCounter = 0;
function hoistNestedMapAs(node, hoisted, isTopLevel) {
  switch (node.type) {
    case "mapAs": {
      const rebuilt = {
        type: "mapAs",
        source: hoistNestedMapAs(node.source, hoisted, false),
        fields: node.fields.map((f) => ({ name: f.name, expr: hoistNestedMapAs(f.expr, hoisted, true) }))
      };
      if (isTopLevel) return rebuilt;
      const tempName = `_mapAsTemp${++mapAsTempCounter}`;
      hoisted.push({ type: "let", name: tempName, expr: rebuilt });
      return { type: "identifier", name: tempName };
    }
    case "literal":
    case "identifier":
      return node;
    case "member":
      return { type: "member", object: hoistNestedMapAs(node.object, hoisted, false), name: node.name };
    case "call":
      return { type: "call", name: node.name, args: node.args.map((a) => hoistNestedMapAs(a, hoisted, false)), genericArgs: node.genericArgs };
    case "unary":
      return { type: "unary", op: node.op, operand: hoistNestedMapAs(node.operand, hoisted, false) };
    case "binary":
      return { type: "binary", op: node.op, left: hoistNestedMapAs(node.left, hoisted, false), right: hoistNestedMapAs(node.right, hoisted, false) };
    case "where":
      return { type: "where", source: hoistNestedMapAs(node.source, hoisted, false), condition: hoistNestedMapAs(node.condition, hoisted, false) };
    case "anyAliasedWhere":
      return {
        type: "anyAliasedWhere",
        source: hoistNestedMapAs(node.source, hoisted, false),
        alias: node.alias,
        condition: hoistNestedMapAs(node.condition, hoisted, false)
      };
    case "select":
      return {
        type: "select",
        distinct: node.distinct,
        fields: node.fields.map((f) => ({ expr: hoistNestedMapAs(f.expr, hoisted, false), alias: f.alias })),
        source: hoistNestedMapAs(node.source, hoisted, false),
        orderBy: node.orderBy && node.orderBy.map((o) => ({ expr: hoistNestedMapAs(o.expr, hoisted, false), direction: o.direction }))
      };
    case "record":
      return { type: "record", fields: node.fields.map((f) => ({ name: f.name, expr: hoistNestedMapAs(f.expr, hoisted, false) })) };
    case "with":
      return {
        type: "with",
        source: hoistNestedMapAs(node.source, hoisted, false),
        fields: node.fields.map((f) => ({ name: f.name, expr: hoistNestedMapAs(f.expr, hoisted, false) }))
      };
    case "case":
      return {
        type: "case",
        branches: node.branches.map((b) => ({ cond: hoistNestedMapAs(b.cond, hoisted, false), result: hoistNestedMapAs(b.result, hoisted, false) })),
        elseResult: hoistNestedMapAs(node.elseResult, hoisted, false)
      };
    case "functionLiteral":
      return node;
    default:
      return node;
  }
}
function renameIdentifierInExpr(node, from, to) {
  switch (node.type) {
    case "literal":
      return node;
    case "identifier":
      return node.name === from ? { type: "identifier", name: to } : node;
    case "member":
      return { type: "member", object: renameIdentifierInExpr(node.object, from, to), name: node.name };
    case "call":
      return { type: "call", name: node.name, args: node.args.map((a) => renameIdentifierInExpr(a, from, to)), genericArgs: node.genericArgs };
    case "unary":
      return { type: "unary", op: node.op, operand: renameIdentifierInExpr(node.operand, from, to) };
    case "binary":
      return { type: "binary", op: node.op, left: renameIdentifierInExpr(node.left, from, to), right: renameIdentifierInExpr(node.right, from, to) };
    case "in":
      return { type: "in", left: renameIdentifierInExpr(node.left, from, to), values: node.values.map((v) => renameIdentifierInExpr(v, from, to)) };
    case "where":
      return { type: "where", source: renameIdentifierInExpr(node.source, from, to), condition: renameIdentifierInExpr(node.condition, from, to) };
    case "anyAliasedWhere":
      return { type: "anyAliasedWhere", source: renameIdentifierInExpr(node.source, from, to), alias: node.alias, condition: renameIdentifierInExpr(node.condition, from, to) };
    case "select":
      return {
        type: "select",
        distinct: node.distinct,
        fields: node.fields.map((f) => ({ expr: renameIdentifierInExpr(f.expr, from, to), alias: f.alias })),
        source: renameIdentifierInExpr(node.source, from, to),
        orderBy: node.orderBy && node.orderBy.map((o) => ({ expr: renameIdentifierInExpr(o.expr, from, to), direction: o.direction }))
      };
    case "record":
      return { type: "record", fields: node.fields.map((f) => ({ name: f.name, expr: renameIdentifierInExpr(f.expr, from, to) })) };
    case "mapAs":
      return { type: "mapAs", source: renameIdentifierInExpr(node.source, from, to), fields: node.fields.map((f) => ({ name: f.name, expr: renameIdentifierInExpr(f.expr, from, to) })) };
    case "with":
      return { type: "with", source: renameIdentifierInExpr(node.source, from, to), fields: node.fields.map((f) => ({ name: f.name, expr: renameIdentifierInExpr(f.expr, from, to) })) };
    case "case":
      return { type: "case", branches: node.branches.map((b) => ({ cond: renameIdentifierInExpr(b.cond, from, to), result: renameIdentifierInExpr(b.result, from, to) })), elseResult: renameIdentifierInExpr(node.elseResult, from, to) };
    case "functionLiteral":
      return node;
    default:
      return node;
  }
}
function renameIdentifierInStatement(stmt, from, to) {
  switch (stmt.type) {
    case "if":
      return {
        type: "if",
        branches: stmt.branches.map((b) => ({ cond: renameIdentifierInExpr(b.cond, from, to), body: b.body.map((s) => renameIdentifierInStatement(s, from, to)) })),
        elseBody: stmt.elseBody ? stmt.elseBody.map((s) => renameIdentifierInStatement(s, from, to)) : null
      };
    case "for":
      return { type: "for", varName: stmt.varName, source: renameIdentifierInExpr(stmt.source, from, to), body: stmt.body.map((s) => renameIdentifierInStatement(s, from, to)) };
    case "while":
      return { type: "while", cond: renameIdentifierInExpr(stmt.cond, from, to), body: stmt.body.map((s) => renameIdentifierInStatement(s, from, to)) };
    case "let":
      return { type: "let", name: stmt.name, expr: renameIdentifierInExpr(stmt.expr, from, to), declaredType: stmt.declaredType };
    case "set":
      return { type: "set", name: stmt.name === from ? to : stmt.name, expr: renameIdentifierInExpr(stmt.expr, from, to) };
    case "return":
      return { type: "return", expr: stmt.expr ? renameIdentifierInExpr(stmt.expr, from, to) : null };
    case "break":
    case "continue":
    case "raw":
    case "noop":
      return stmt;
  }
}
function renameReassignedParamForward(statements, paramName) {
  const freshName = `${paramName}Sanitized`;
  const { result } = renameFirstReassignmentForward(statements, paramName, freshName, () => true);
  return result;
}
function renameFirstReassignmentForward(statements, from, to, shouldRename) {
  const out = [];
  let found = false;
  for (const stmt of statements) {
    if (found) {
      out.push(renameIdentifierInStatement(stmt, from, to));
      continue;
    }
    if (stmt.type === "set" && stmt.name === from && shouldRename(stmt.expr)) {
      out.push({ type: "let", name: to, expr: stmt.expr });
      found = true;
      continue;
    }
    const [rewritten, foundInside] = renameFirstReassignmentForwardInStatement(stmt, from, to, shouldRename);
    out.push(rewritten);
    if (foundInside) found = true;
  }
  return { result: out, found };
}
function renameFirstReassignmentForwardInStatement(stmt, from, to, shouldRename) {
  switch (stmt.type) {
    case "if": {
      let anyFound = false;
      const branches = stmt.branches.map((b) => {
        const { result, found } = renameFirstReassignmentForward(b.body, from, to, shouldRename);
        if (found) anyFound = true;
        return { cond: b.cond, body: result };
      });
      let elseBody = stmt.elseBody;
      if (stmt.elseBody) {
        const { result, found } = renameFirstReassignmentForward(stmt.elseBody, from, to, shouldRename);
        elseBody = result;
        if (found) anyFound = true;
      }
      return [{ type: "if", branches, elseBody }, anyFound];
    }
    case "for": {
      const { result, found } = renameFirstReassignmentForward(stmt.body, from, to, shouldRename);
      return [{ type: "for", varName: stmt.varName, source: stmt.source, body: result }, found];
    }
    case "while": {
      const { result, found } = renameFirstReassignmentForward(stmt.body, from, to, shouldRename);
      return [{ type: "while", cond: stmt.cond, body: result }, found];
    }
    default:
      return [stmt, false];
  }
}
const BUILTIN_RETURN_KIND = {
  replace: "text",
  regexReplace: "text",
  trim: "text",
  upper: "text",
  lower: "text",
  left: "text",
  right: "text",
  mid: "text",
  str: "text",
  join: "text",
  format: "text",
  formatLocale: "text",
  encodeText: "text",
  decodeText: "text",
  base64Encode: "text",
  base64Decode: "text",
  urlEncode: "text",
  urlDecode: "text",
  chr: "text",
  guid: "text",
  val: "number",
  len: "number",
  ceil: "number",
  floor: "number",
  round: "number",
  random: "number",
  pow: "number",
  average: "number",
  max: "number",
  min: "number",
  sum: "number",
  count: "number",
  hash: "number",
  inStr: "number",
  isNumber: "boolean",
  any: "boolean",
  isNullOrEmpty: "boolean"
};
function inferExprKind(expr, ctx) {
  if (expr.type === "literal") {
    if (expr.kind === "string") return "text";
    if (expr.kind === "number") return "number";
    return null;
  }
  if (expr.type === "identifier" && (expr.name === "true" || expr.name === "false")) return "boolean";
  if (expr.type === "binary") {
    if (expr.op === "+" || expr.op === "-" || expr.op === "*" || expr.op === "/") return "number";
    if (expr.op === "&") {
      // `[..] & [..]` appends records (builds a table); only a chain without record leaves is text.
      const leaves = [];
      flattenConcatChain(expr, leaves);
      return leaves.some((leaf) => leaf.type === "record") ? null : "text";
    }
    if (["=", "!=", "<", ">", "<=", ">=", "and", "or"].includes(expr.op)) return "boolean";
    return null;
  }
  if (expr.type === "unary" && expr.op === "not") return "boolean";
  if (expr.type === "call") {
    const { name } = resolveFunctionName(expr.name);
    if (name === "isNull" && expr.args.length >= 1) return inferExprKind(expr.args[0], ctx);
    return BUILTIN_RETURN_KIND[name] ?? null;
  }
  if (expr.type === "identifier" && ctx && ctx.scalarVarKinds && ctx.scalarVarKinds.has(expr.name)) {
    return ctx.scalarVarKinds.get(expr.name);
  }
  const fieldType = resolveFieldType(expr, ctx);
  return fieldType && (fieldType.kind === "text" || fieldType.kind === "number" || fieldType.kind === "boolean") ? fieldType.kind : null;
}
function annotateTopLevelLetKindTransitions(statements, ctx) {
  const out = [...statements];
  for (let i = 0; i < out.length; i++) {
    const stmt = out[i];
    if (stmt.type !== "let" || stmt.declaredType) continue;
    const initialKind = inferExprKind(stmt.expr, ctx);
    if (!initialKind) continue;
    out[i] = { ...stmt, declaredType: initialKind };
    if (ctx && ctx.scalarVarKinds) ctx.scalarVarKinds.set(stmt.name, initialKind);
    let divergentKind = null;
    const shouldRename = (expr) => {
      const k = inferExprKind(expr, ctx);
      if (k && k !== initialKind) {
        divergentKind = k;
        return true;
      }
      return false;
    };
    const rest = out.slice(i + 1);
    const { result, found } = renameFirstReassignmentForward(rest, stmt.name, `${stmt.name}Converted`, shouldRename);
    if (found && divergentKind) {
      const convertedName = `${stmt.name}Converted`;
      const annotated = result.map((s) => s.type === "let" && s.name === convertedName && !s.declaredType ? { ...s, declaredType: divergentKind } : s);
      out.splice(i + 1, rest.length, ...annotated);
      if (ctx && ctx.scalarVarKinds) ctx.scalarVarKinds.set(convertedName, divergentKind);
    }
  }
  return out;
}
function inferTableColumnTypesFromAppendUsage(statements, targetVariableName, columnNames, ctx) {
  const columnNamesUpper = new Set(columnNames.map((c) => c.toUpperCase()));
  const kindByColumn = /* @__PURE__ */ new Map();
  const disagreedColumns = /* @__PURE__ */ new Set();
  const visitAppendExpr = (expr) => {
    if (expr.type !== "binary" || expr.op !== "&") return;
    const leaves = [];
    flattenConcatChain(expr, leaves);
    for (const leaf of leaves) {
      if (leaf.type !== "record") continue;
      for (const f of leaf.fields) {
        const upper = f.name.toUpperCase();
        if (!columnNamesUpper.has(upper) || disagreedColumns.has(upper)) continue;
        const kind = inferExprKind(f.expr, ctx);
        if (!kind) continue;
        const existing = kindByColumn.get(upper);
        if (existing && existing !== kind) {
          kindByColumn.delete(upper);
          disagreedColumns.add(upper);
          continue;
        }
        kindByColumn.set(upper, kind);
      }
    }
  };
  const walk = (stmts) => {
    for (const s of stmts) {
      if ((s.type === "set" || s.type === "let") && s.name === targetVariableName) visitAppendExpr(s.expr);
      if (s.type === "if") {
        s.branches.forEach((b) => walk(b.body));
        if (s.elseBody) walk(s.elseBody);
      }
      if (s.type === "for" || s.type === "while") walk(s.body);
    }
  };
  walk(statements);
  if (kindByColumn.size === 0) return null;
  const fields = [];
  columnNames.forEach((name) => {
    const kind = kindByColumn.get(name.toUpperCase());
    if (kind) fields.push({ name, type: `${kind}?` });
  });
  return fields.length > 0 ? fields : null;
}
function inferTableColumnTypesForTopLevelTables(statements, ctx) {
  const result = /* @__PURE__ */ new Map();
  statements.forEach((s) => {
    if (s.type !== "let" || s.expr.type !== "call" || s.expr.name.toLowerCase() !== "table") return;
    const columnNames = s.expr.args.map((a) => a.type === "identifier" ? a.name : null);
    if (!columnNames.every((c) => !!c)) return;
    const fields = inferTableColumnTypesFromAppendUsage(statements, s.name, columnNames, ctx);
    if (fields) result.set(s.name, fields);
  });
  return result;
}
function inferDottedFieldKindsFromScriptUsage(classicScriptText, paramNames) {
  const result = /* @__PURE__ */ new Map();
  let statements;
  try {
    const text = String(classicScriptText || "");
    const tokens = tokenize(text);
    statements = createParser(tokens, text).parseProgram();
  } catch {
    return result;
  }
  const dottedKeyOf = (node) => {
    if (node.type !== "identifier") return null;
    const dotIdx = node.name.indexOf(".");
    if (dotIdx < 0) return null;
    if (!paramNames.has(node.name.slice(0, dotIdx))) return null;
    return node.name;
  };
  const passthroughByVar = /* @__PURE__ */ new Map();
  const collectPassthroughs = (stmts) => {
    stmts.forEach((s) => {
      if (s.type === "let" || s.type === "set") {
        const dotted = dottedKeyOf(s.expr);
        if (dotted) passthroughByVar.set(s.name, dotted);
      }
      if (s.type === "if") {
        s.branches.forEach((b) => collectPassthroughs(b.body));
        if (s.elseBody) collectPassthroughs(s.elseBody);
      }
      if (s.type === "for" || s.type === "while") collectPassthroughs(s.body);
    });
  };
  collectPassthroughs(statements);
  const disagreed = /* @__PURE__ */ new Set();
  const record = (dotted, kind) => {
    if (disagreed.has(dotted)) return;
    const existing = result.get(dotted);
    if (existing && existing !== kind) {
      result.delete(dotted);
      disagreed.add(dotted);
      return;
    }
    result.set(dotted, kind);
  };
  const dottedKeyOfOperand = (node) => {
    const direct = dottedKeyOf(node);
    if (direct) return direct;
    if (node.type === "identifier") return passthroughByVar.get(node.name) ?? null;
    return null;
  };
  const ARITH_OPS = /* @__PURE__ */ new Set(["+", "-", "*", "/"]);
  const visitExpr = (node) => {
    switch (node.type) {
      case "binary": {
        if (ARITH_OPS.has(node.op) || node.op === "&") {
          const kind = node.op === "&" ? "text" : "number";
          const leftKey = dottedKeyOfOperand(node.left);
          const rightKey = dottedKeyOfOperand(node.right);
          if (leftKey) record(leftKey, kind);
          if (rightKey) record(rightKey, kind);
        }
        visitExpr(node.left);
        visitExpr(node.right);
        return;
      }
      case "unary":
        visitExpr(node.operand);
        return;
      case "member":
        visitExpr(node.object);
        return;
      case "call":
        node.args.forEach(visitExpr);
        return;
      case "in":
        visitExpr(node.left);
        node.values.forEach(visitExpr);
        return;
      case "where":
      case "anyAliasedWhere":
        visitExpr(node.source);
        visitExpr(node.condition);
        return;
      case "select":
        visitExpr(node.source);
        node.fields.forEach((f) => visitExpr(f.expr));
        (node.orderBy || []).forEach((o) => visitExpr(o.expr));
        return;
      case "record":
      case "mapAs":
      case "with":
        node.fields.forEach((f) => visitExpr(f.expr));
        return;
      case "case":
        node.branches.forEach((b) => {
          visitExpr(b.cond);
          visitExpr(b.result);
        });
        visitExpr(node.elseResult);
        return;
      default:
        return;
    }
  };
  const visitStatements = (stmts) => {
    stmts.forEach((s) => {
      switch (s.type) {
        case "let":
        case "set":
          visitExpr(s.expr);
          return;
        case "if":
          s.branches.forEach((b) => {
            visitExpr(b.cond);
            visitStatements(b.body);
          });
          if (s.elseBody) visitStatements(s.elseBody);
          return;
        case "while":
          visitExpr(s.cond);
          visitStatements(s.body);
          return;
        case "for":
          visitExpr(s.source);
          visitStatements(s.body);
          return;
        case "return":
          if (s.expr) visitExpr(s.expr);
          return;
        default:
          return;
      }
    });
  };
  visitStatements(statements);
  return result;
}
function nullableWrapDefault(kind) {
  return defaultLiteralForKind(kind);
}
function emitScalarWithNullableWrap(expr, ctx) {
  const text = emit(expr, ctx);
  const fieldType = resolveFieldType(expr, ctx);
  if (!fieldType || fieldType.optional !== true) return text;
  const replacement = nullableWrapDefault(fieldType.kind);
  return replacement ? `isNull(${text}, ${replacement})` : text;
}
const TEXT_BOOLEAN_TRUTHY_LITERALS = ["TRUE", "true", "y"];
function emitTextAsBooleanOperand(expr, ctx, negate) {
  const fieldType = resolveFieldType(expr, ctx);
  if (!fieldType || fieldType.kind !== "text") return null;
  const literals = TEXT_BOOLEAN_TRUTHY_LITERALS.map((l) => JSON.stringify(l)).join(", ");
  const inExpr = `${emit(expr, ctx)} in [${literals}]`;
  return negate ? `not (${inExpr})` : inExpr;
}
function inferArgumentType(node) {
  if (node.type === "literal" && node.kind === "string") return { kind: "text", nullable: false };
  if (node.type === "literal" && node.kind === "number") return { kind: "number", nullable: false };
  return { kind: "text", nullable: true };
}
function mergeArgumentTypes(a, b) {
  if (a.kind !== b.kind) return { kind: "text", nullable: true };
  return { kind: a.kind, nullable: a.nullable || b.nullable };
}
function renderArgumentType(t) {
  return t.nullable ? `${t.kind}?` : t.kind;
}
function walkExprForCalls(node, fnName, sink) {
  if (node.type === "call") {
    if (node.name === fnName) sink.push(node.args);
    node.args.forEach((a) => walkExprForCalls(a, fnName, sink));
    return;
  }
  switch (node.type) {
    case "literal":
    case "identifier":
      return;
    case "member":
      walkExprForCalls(node.object, fnName, sink);
      return;
    case "unary":
      walkExprForCalls(node.operand, fnName, sink);
      return;
    case "binary":
      walkExprForCalls(node.left, fnName, sink);
      walkExprForCalls(node.right, fnName, sink);
      return;
    case "where":
    case "anyAliasedWhere":
      walkExprForCalls(node.source, fnName, sink);
      walkExprForCalls(node.condition, fnName, sink);
      return;
    case "select":
      node.fields.forEach((f) => walkExprForCalls(f.expr, fnName, sink));
      walkExprForCalls(node.source, fnName, sink);
      (node.orderBy || []).forEach((o) => walkExprForCalls(o.expr, fnName, sink));
      return;
    case "record":
    case "mapAs":
    case "with":
      if ("source" in node) walkExprForCalls(node.source, fnName, sink);
      node.fields.forEach((f) => walkExprForCalls(f.expr, fnName, sink));
      return;
    case "case":
      node.branches.forEach((b) => {
        walkExprForCalls(b.cond, fnName, sink);
        walkExprForCalls(b.result, fnName, sink);
      });
      walkExprForCalls(node.elseResult, fnName, sink);
      return;
    case "functionLiteral":
      return;
    default:
      return;
  }
}
function walkStatementsForCalls(statements, fnName, sink) {
  statements.forEach((s) => {
    switch (s.type) {
      case "if":
        s.branches.forEach((b) => {
          walkExprForCalls(b.cond, fnName, sink);
          walkStatementsForCalls(b.body, fnName, sink);
        });
        if (s.elseBody) walkStatementsForCalls(s.elseBody, fnName, sink);
        return;
      case "for":
        walkExprForCalls(s.source, fnName, sink);
        walkStatementsForCalls(s.body, fnName, sink);
        return;
      case "while":
        walkExprForCalls(s.cond, fnName, sink);
        walkStatementsForCalls(s.body, fnName, sink);
        return;
      case "let":
      case "set":
        walkExprForCalls(s.expr, fnName, sink);
        return;
      case "return":
        if (s.expr) walkExprForCalls(s.expr, fnName, sink);
        return;
      default:
        return;
    }
  });
}
function findFirstReturnExpr(statements) {
  for (const s of statements) {
    if (s.type === "return") return s.expr;
    if (s.type === "if") {
      for (const b of s.branches) {
        const found = findFirstReturnExpr(b.body);
        if (found) return found;
      }
      if (s.elseBody) {
        const found = findFirstReturnExpr(s.elseBody);
        if (found) return found;
      }
    }
    if (s.type === "for" || s.type === "while") {
      const found = findFirstReturnExpr(s.body);
      if (found) return found;
    }
  }
  return null;
}
function isBareIdentifierNamed(expr, name) {
  return expr.type === "identifier" && expr.name === name;
}
function exprUsesIdentifierAsBoolean(expr, name) {
  switch (expr.type) {
    case "binary":
      if ((expr.op === "or" || expr.op === "and") && (isBareIdentifierNamed(expr.left, name) || isBareIdentifierNamed(expr.right, name))) return true;
      return exprUsesIdentifierAsBoolean(expr.left, name) || exprUsesIdentifierAsBoolean(expr.right, name);
    case "unary":
      if (expr.op === "not" && isBareIdentifierNamed(expr.operand, name)) return true;
      return exprUsesIdentifierAsBoolean(expr.operand, name);
    case "member":
      return exprUsesIdentifierAsBoolean(expr.object, name);
    case "call":
      return expr.args.some((a) => exprUsesIdentifierAsBoolean(a, name));
    case "in":
      return exprUsesIdentifierAsBoolean(expr.left, name) || expr.values.some((v) => exprUsesIdentifierAsBoolean(v, name));
    case "where":
    case "anyAliasedWhere":
      return exprUsesIdentifierAsBoolean(expr.source, name) || exprUsesIdentifierAsBoolean(expr.condition, name);
    case "select":
      return exprUsesIdentifierAsBoolean(expr.source, name) || expr.fields.some((f) => exprUsesIdentifierAsBoolean(f.expr, name)) || (expr.orderBy || []).some((o) => exprUsesIdentifierAsBoolean(o.expr, name));
    case "record":
    case "mapAs":
    case "with":
      return expr.fields.some((f) => exprUsesIdentifierAsBoolean(f.expr, name));
    case "case":
      return expr.branches.some((b) => exprUsesIdentifierAsBoolean(b.cond, name) || exprUsesIdentifierAsBoolean(b.result, name)) || exprUsesIdentifierAsBoolean(expr.elseResult, name);
    default:
      return false;
  }
}
function exprUsesIdentifierAsBareCaseCondition(expr, name) {
  switch (expr.type) {
    case "case":
      return expr.branches.some((b) => isBareIdentifierNamed(b.cond, name) || exprUsesIdentifierAsBareCaseCondition(b.cond, name) || exprUsesIdentifierAsBareCaseCondition(b.result, name)) || exprUsesIdentifierAsBareCaseCondition(expr.elseResult, name);
    case "binary":
      return exprUsesIdentifierAsBareCaseCondition(expr.left, name) || exprUsesIdentifierAsBareCaseCondition(expr.right, name);
    case "unary":
      return exprUsesIdentifierAsBareCaseCondition(expr.operand, name);
    case "member":
      return exprUsesIdentifierAsBareCaseCondition(expr.object, name);
    case "call":
      return expr.args.some((a) => exprUsesIdentifierAsBareCaseCondition(a, name));
    case "in":
      return exprUsesIdentifierAsBareCaseCondition(expr.left, name) || expr.values.some((v) => exprUsesIdentifierAsBareCaseCondition(v, name));
    case "where":
    case "anyAliasedWhere":
      return exprUsesIdentifierAsBareCaseCondition(expr.source, name) || exprUsesIdentifierAsBareCaseCondition(expr.condition, name);
    case "select":
      return exprUsesIdentifierAsBareCaseCondition(expr.source, name) || expr.fields.some((f) => exprUsesIdentifierAsBareCaseCondition(f.expr, name)) || (expr.orderBy || []).some((o) => exprUsesIdentifierAsBareCaseCondition(o.expr, name));
    case "record":
    case "mapAs":
    case "with":
      return expr.fields.some((f) => exprUsesIdentifierAsBareCaseCondition(f.expr, name));
    default:
      return false;
  }
}
function statementsUseIdentifierAsBareCaseCondition(statements, name) {
  return statements.some((s) => {
    switch (s.type) {
      case "if":
        return s.branches.some((b) => exprUsesIdentifierAsBareCaseCondition(b.cond, name) || statementsUseIdentifierAsBareCaseCondition(b.body, name)) || (s.elseBody ? statementsUseIdentifierAsBareCaseCondition(s.elseBody, name) : false);
      case "while":
        return exprUsesIdentifierAsBareCaseCondition(s.cond, name) || statementsUseIdentifierAsBareCaseCondition(s.body, name);
      case "for":
        return exprUsesIdentifierAsBareCaseCondition(s.source, name) || statementsUseIdentifierAsBareCaseCondition(s.body, name);
      case "let":
      case "set":
        return exprUsesIdentifierAsBareCaseCondition(s.expr, name);
      case "return":
        return s.expr ? exprUsesIdentifierAsBareCaseCondition(s.expr, name) : false;
      default:
        return false;
    }
  });
}
function exprUsesIdentifierAsTextOrNumber(expr, name) {
  switch (expr.type) {
    case "binary": {
      if ((expr.op === "&" || expr.op === "+" || expr.op === "-" || expr.op === "*" || expr.op === "/") && (isBareIdentifierNamed(expr.left, name) || isBareIdentifierNamed(expr.right, name))) return true;
      return exprUsesIdentifierAsTextOrNumber(expr.left, name) || exprUsesIdentifierAsTextOrNumber(expr.right, name);
    }
    case "unary":
      return exprUsesIdentifierAsTextOrNumber(expr.operand, name);
    case "member":
      return exprUsesIdentifierAsTextOrNumber(expr.object, name);
    case "call":
      return expr.args.some((a) => exprUsesIdentifierAsTextOrNumber(a, name));
    case "in":
      return exprUsesIdentifierAsTextOrNumber(expr.left, name) || expr.values.some((v) => exprUsesIdentifierAsTextOrNumber(v, name));
    case "where":
    case "anyAliasedWhere":
      return exprUsesIdentifierAsTextOrNumber(expr.source, name) || exprUsesIdentifierAsTextOrNumber(expr.condition, name);
    case "select":
      return exprUsesIdentifierAsTextOrNumber(expr.source, name) || expr.fields.some((f) => exprUsesIdentifierAsTextOrNumber(f.expr, name)) || (expr.orderBy || []).some((o) => exprUsesIdentifierAsTextOrNumber(o.expr, name));
    case "record":
    case "mapAs":
    case "with":
      return expr.fields.some((f) => exprUsesIdentifierAsTextOrNumber(f.expr, name));
    case "case":
      return expr.branches.some((b) => exprUsesIdentifierAsTextOrNumber(b.cond, name) || exprUsesIdentifierAsTextOrNumber(b.result, name)) || exprUsesIdentifierAsTextOrNumber(expr.elseResult, name);
    default:
      return false;
  }
}
function statementsUseIdentifierAsTextOrNumber(statements, name) {
  return statements.some((s) => {
    switch (s.type) {
      case "if":
        return s.branches.some((b) => exprUsesIdentifierAsTextOrNumber(b.cond, name) || statementsUseIdentifierAsTextOrNumber(b.body, name)) || (s.elseBody ? statementsUseIdentifierAsTextOrNumber(s.elseBody, name) : false);
      case "while":
        return exprUsesIdentifierAsTextOrNumber(s.cond, name) || statementsUseIdentifierAsTextOrNumber(s.body, name);
      case "for":
        return exprUsesIdentifierAsTextOrNumber(s.source, name) || statementsUseIdentifierAsTextOrNumber(s.body, name);
      case "let":
      case "set":
        return exprUsesIdentifierAsTextOrNumber(s.expr, name);
      case "return":
        return s.expr ? exprUsesIdentifierAsTextOrNumber(s.expr, name) : false;
      default:
        return false;
    }
  });
}
function statementsUseIdentifierAsBoolean(statements, name) {
  return statements.some((s) => {
    switch (s.type) {
      case "if":
        return s.branches.some((b) => isBareIdentifierNamed(b.cond, name) || exprUsesIdentifierAsBoolean(b.cond, name) || statementsUseIdentifierAsBoolean(b.body, name)) || (s.elseBody ? statementsUseIdentifierAsBoolean(s.elseBody, name) : false);
      case "while":
        return isBareIdentifierNamed(s.cond, name) || exprUsesIdentifierAsBoolean(s.cond, name) || statementsUseIdentifierAsBoolean(s.body, name);
      case "for":
        return exprUsesIdentifierAsBoolean(s.source, name) || statementsUseIdentifierAsBoolean(s.body, name);
      case "let":
      case "set":
        return exprUsesIdentifierAsBoolean(s.expr, name);
      case "return":
        return s.expr ? exprUsesIdentifierAsBoolean(s.expr, name) : false;
      default:
        return false;
    }
  });
}
function inferLocalFunctionSignature(fnName, params, body, allStatements) {
  const callSites = [];
  walkStatementsForCalls(allStatements, fnName, callSites);
  const bodyStatements = body.kind === "block" ? body.statements : null;
  const hasMultiBranchDispatch = !!(bodyStatements && bodyStatements.some((s) => s.type === "if" && s.branches.length > 1));
  const paramTypesText = params.map((param, i) => {
    const usedAsBoolean = bodyStatements && statementsUseIdentifierAsBoolean(bodyStatements, param) || body.kind === "expr" && exprUsesIdentifierAsBoolean(body.expr, param);
    if (usedAsBoolean) return "boolean";
    const usedAsBareCaseCondition = !hasMultiBranchDispatch && (bodyStatements && statementsUseIdentifierAsBareCaseCondition(bodyStatements, param) || body.kind === "expr" && exprUsesIdentifierAsBareCaseCondition(body.expr, param));
    if (usedAsBareCaseCondition) {
      const usedAsTextOrNumber = bodyStatements && statementsUseIdentifierAsTextOrNumber(bodyStatements, param) || body.kind === "expr" && exprUsesIdentifierAsTextOrNumber(body.expr, param);
      if (!usedAsTextOrNumber) return "boolean";
    }
    let merged = null;
    for (const args of callSites) {
      const arg = args[i];
      if (!arg) continue;
      const t = inferArgumentType(arg);
      merged = merged ? mergeArgumentTypes(merged, t) : t;
    }
    if (!merged) return "any";
    return renderArgumentType(merged);
  });
  let returnTypeText = null;
  const returnExpr = body.kind === "expr" ? body.expr : findFirstReturnExpr(body.statements);
  if (returnExpr && returnExpr.type === "record") {
    const paramIndexByName = new Map(params.map((p, i) => [p, i]));
    const fieldTypes = returnExpr.fields.map((f) => {
      const paramIdx = f.expr.type === "identifier" && !f.expr.name.includes(".") ? paramIndexByName.get(f.expr.name) : void 0;
      return `${f.name}: ${paramIdx !== void 0 ? paramTypesText[paramIdx] : "any"}`;
    });
    returnTypeText = `{${fieldTypes.join(", ")}}`;
  } else if (body.kind === "block") {
    returnTypeText = "any";
  }
  return { paramTypesText, returnTypeText };
}
function collectLocalFunctionSignatures(statements) {
  const result = /* @__PURE__ */ new Map();
  statements.forEach((s) => {
    if (s.type === "let" && s.expr.type === "functionLiteral") {
      result.set(s.name, inferLocalFunctionSignature(s.name, s.expr.params, s.expr.body, statements));
    }
  });
  return result;
}
function localFunctionParamKind(name, index, ctx) {
  const raw = ctx && ctx.localFunctionSignatures ? ctx.localFunctionSignatures.get(name)?.paramTypesText[index] : void 0;
  if (!raw) return void 0;
  const base = raw.replace(/\?$/, "").trim();
  return base === "text" ? "text" : base === "number" ? "number" : void 0;
}
function emitLocalFunctionDeclaration(name, expr, ctx) {
  const sig = ctx && ctx.localFunctionSignatures ? ctx.localFunctionSignatures.get(name) : void 0;
  const paramTypesText = sig ? sig.paramTypesText : expr.params.map(() => "text?");
  const paramsText = expr.params.map((p, i) => `${p}: ${paramTypesText[i] ?? "text?"}`).join(", ");
  const bodyCtx = Object.assign({}, ctx, {
    protectedNames: /* @__PURE__ */ new Set([...ctx && ctx.protectedNames ? ctx.protectedNames : [], ...expr.params])
  });
  if (expr.body.kind === "expr") {
    return `function ${name}(${paramsText}) => ${emit(expr.body.expr, bodyCtx)};`;
  }
  const returnTypeText = sig && sig.returnTypeText ? sig.returnTypeText : "any";
  const bodyStatements = expr.params.reduce((stmts, p) => renameReassignedParamForward(stmts, p), expr.body.statements);
  return `function ${name}(${paramsText}): ${returnTypeText} {
${indentBlock(emitStatements(bodyStatements, bodyCtx))}
}`;
}
function emitStatement(node, ctx) {
  switch (node.type) {
    case "if": {
      const hoisted = [];
      const branches = node.branches.map((b) => ({ cond: hoistNestedMapAs(b.cond, hoisted, false), body: b.body }));
      const parts = branches.map(
        (b, idx) => `${idx === 0 ? "if" : "else if"} ${emit(b.cond, ctx)} {
${indentBlock(emitStatements(b.body, ctx))}
}`
      );
      let text = parts.join(" ");
      if (node.elseBody) text += ` else {
${indentBlock(emitStatements(node.elseBody, ctx))}
}`;
      return hoisted.length > 0 ? `${emitStatements(hoisted, ctx)}
${text}` : text;
    }
    case "for": {
      const hoisted = [];
      const source = hoistNestedMapAs(node.source, hoisted, false);
      const sourceKey = schemaLookupKeyOf(source);
      const rowSchema = sourceKey && ctx && ctx.schemaLookup ? ctx.schemaLookup(sourceKey) : null;
      const innerCtx = Object.assign({}, ctx, { rowSchema, rowSchemaIsForLoopVar: true });
      const text = `for ${node.varName} in ${emit(source, ctx)} {
${indentBlock(emitStatements(node.body, innerCtx))}
}`;
      return hoisted.length > 0 ? `${emitStatements(hoisted, ctx)}
${text}` : text;
    }
    case "while": {
      const hoisted = [];
      const cond = hoistNestedMapAs(node.cond, hoisted, false);
      const text = `while ${emit(cond, ctx)} {
${indentBlock(emitStatements(node.body, ctx))}
}`;
      return hoisted.length > 0 ? `${emitStatements(hoisted, ctx)}
${text}` : text;
    }
    case "let": {
      const hoisted = [];
      const expr = hoistNestedMapAs(node.expr, hoisted, true);
      const isTableCall = expr.type === "call" && expr.name.toLowerCase() === "table";
      const columnNames = isTableCall && expr.type === "call" ? expr.args.map((a) => a.type === "identifier" ? a.name : null) : null;
      if (ctx && ctx.localSchemas && !isTableCall) {
        const resolved = resolveAssignedRowSchema(expr, ctx);
        if (resolved) ctx.localSchemas.set(node.name, resolved);
      }
      if (expr.type === "functionLiteral") {
        const text2 = emitLocalFunctionDeclaration(node.name, expr, ctx);
        return hoisted.length > 0 ? `${emitStatements(hoisted, ctx)}
${text2}` : text2;
      }
      const typeAnnotation = node.declaredType ? `: ${node.declaredType}` : "";
      const joinRewrite = tryRewriteJoinSelect(expr, ctx);
      const text = joinRewrite ? `${joinRewrite.preLines.length > 0 ? joinRewrite.preLines.join("\n") + "\n" : ""}let ${node.name}${typeAnnotation} = ${joinRewrite.finalExprText};` : columnNames && columnNames.every((c) => !!c) ? buildTableDeclaration(node.name, columnNames, ctx && ctx.tableColumnTypesFromUsage ? ctx.tableColumnTypesFromUsage.get(node.name) ?? null : null) : `let ${node.name}${typeAnnotation} = ${emitScalarWithNullableWrap(expr, ctx)};`;
      return hoisted.length > 0 ? `${emitStatements(hoisted, ctx)}
${text}` : text;
    }
    case "set": {
      const hoisted = [];
      const expr = hoistNestedMapAs(node.expr, hoisted, true);
      if (expr.type === "functionLiteral") {
        const text2 = emitLocalFunctionDeclaration(node.name, expr, ctx);
        return hoisted.length > 0 ? `${emitStatements(hoisted, ctx)}
${text2}` : text2;
      }
      const text = `set ${node.name} = ${emitScalarWithNullableWrap(expr, ctx)};`;
      return hoisted.length > 0 ? `${emitStatements(hoisted, ctx)}
${text}` : text;
    }
    case "return": {
      if (!node.expr) return "return;";
      const hoisted = [];
      const expr = hoistNestedMapAs(node.expr, hoisted, true);
      const joinRewrite = tryRewriteJoinSelect(expr, ctx);
      const text = joinRewrite ? `${joinRewrite.preLines.length > 0 ? joinRewrite.preLines.join("\n") + "\n" : ""}return ${joinRewrite.finalExprText};` : `return ${emit(expr, ctx)};`;
      return hoisted.length > 0 ? `${emitStatements(hoisted, ctx)}
${text}` : text;
    }
    case "break":
      return "break;";
    case "continue":
      return "continue;";
    case "raw":
      return node.originalText;
    case "noop":
      return "";
    default:
      throw new Error(`FlowClassicScript: unknown statement AST node type '${node.type}'`);
  }
}
function emitStatements(nodes, ctx) {
  return nodes.map((n) => emitStatement(n, ctx)).filter((text) => text !== "").join("\n");
}
const ROW_PRESERVING_UNWRAP_FUNCTIONS = /* @__PURE__ */ new Set(["firstornull", "firstordefault", "first", "lastornull", "lastordefault", "last", "eval"]);
function resolveAssignedRowSchema(expr, ctx) {
  if (!ctx || !ctx.schemaLookup) return null;
  if (expr.type === "identifier" && !expr.name.includes(".")) return ctx.schemaLookup(expr.name);
  if (expr.type === "where" && expr.source.type === "identifier") return ctx.schemaLookup(expr.source.name);
  if (expr.type === "select") return inferSelectRowSchema(expr, ctx);
  if (expr.type === "call" && expr.args.length === 1) {
    const { name } = resolveFunctionName(expr.name);
    if (ROW_PRESERVING_UNWRAP_FUNCTIONS.has(name.toLowerCase())) return resolveAssignedRowSchema(expr.args[0], ctx);
  }
  return null;
}
function matchAliasedField(node, leftAlias, rightAlias) {
  if (node.type !== "identifier" || !node.name.includes(".")) return null;
  const dot = node.name.indexOf(".");
  const prefix = node.name.slice(0, dot);
  const field = node.name.slice(dot + 1);
  if (prefix === leftAlias) return { side: "left", field };
  if (prefix === rightAlias) return { side: "right", field };
  return null;
}
function isExplicitlySelectableFieldName(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
function computeJoinFieldPlan(join, ctx) {
  if (!ctx.schemaLookup) return null;
  const leftVarName = schemaLookupKeyOf(join.left);
  const rightVarName = schemaLookupKeyOf(join.right);
  const leftSchema = leftVarName ? ctx.schemaLookup(leftVarName) : null;
  const rightSchema = rightVarName ? ctx.schemaLookup(rightVarName) : null;
  if (!leftVarName || !rightVarName || !leftSchema || !rightSchema) return null;
  const leftFields = [...leftSchema.keys()].filter(isExplicitlySelectableFieldName);
  const rightFields = [...rightSchema.keys()].filter(isExplicitlySelectableFieldName);
  const leftFieldSet = new Set(leftFields);
  return {
    leftVarName,
    rightVarName,
    leftSchema,
    rightSchema,
    leftFields,
    rightFields,
    rightOutputName: (field) => leftFieldSet.has(field) ? `${rightVarName}${field}` : field
  };
}
function computeJoinResultSchema(join, ctx) {
  const plan = computeJoinFieldPlan(join, ctx);
  if (!plan) return null;
  const result = /* @__PURE__ */ new Map();
  plan.leftFields.forEach((f) => result.set(f, plan.leftSchema.get(f)));
  plan.rightFields.forEach((f) => result.set(plan.rightOutputName(f), plan.rightSchema.get(f)));
  return result;
}
function inferSelectRowSchema(node, ctx) {
  if (!ctx || !ctx.schemaLookup) return null;
  const isWildcard = node.fields.length === 1 && node.fields[0].expr.type === "identifier" && node.fields[0].expr.name === "*" && !node.fields[0].alias;
  if (isWildcard) {
    if (node.source.type === "innerJoin") return computeJoinResultSchema(node.source, ctx);
    const sourceKey = schemaLookupKeyOf(node.source);
    return sourceKey ? ctx.schemaLookup(sourceKey) : null;
  }
  const fromSourceKey = node.source.type === "identifier" ? schemaLookupKeyOf(node.source) : null;
  const fromSchema = fromSourceKey ? ctx.schemaLookup(fromSourceKey) : null;
  const result = /* @__PURE__ */ new Map();
  node.fields.forEach((f) => {
    let fieldName = null;
    let fieldType = null;
    if (f.expr.type === "identifier" && f.expr.name.includes(".")) {
      const lastDot = f.expr.name.lastIndexOf(".");
      const objectName = f.expr.name.slice(0, lastDot);
      fieldName = f.expr.name.slice(lastDot + 1);
      const objectSchema = ctx.schemaLookup(objectName);
      fieldType = objectSchema ? objectSchema.get(fieldName) : null;
    } else if (f.expr.type === "identifier") {
      fieldName = f.expr.name;
      fieldType = fromSchema ? fromSchema.get(fieldName) : null;
    }
    if (fieldType && fieldName) result.set(f.alias || fieldName, fieldType);
  });
  return result.size > 0 ? result : null;
}
function tryRewriteJoinSelect(expr, ctx) {
  if (expr.type !== "select" || expr.source.type !== "innerJoin") return null;
  const join = expr.source;
  const isWildcard = expr.fields.length === 1 && expr.fields[0].expr.type === "identifier" && expr.fields[0].expr.name === "*" && !expr.fields[0].alias;
  if (!isWildcard) return null;
  if (!ctx || !ctx.schemaLookup) return null;
  const leftKeyFields = [];
  const rightKeyFields = [];
  for (const cond of join.conditions) {
    if (cond.type !== "binary" || cond.op !== "=") return null;
    const l = matchAliasedField(cond.left, join.leftAlias, join.rightAlias);
    const r = matchAliasedField(cond.right, join.leftAlias, join.rightAlias);
    if (!l || !r || l.side === r.side) return null;
    if (l.side === "left") {
      leftKeyFields.push(l.field);
      rightKeyFields.push(r.field);
    } else {
      leftKeyFields.push(r.field);
      rightKeyFields.push(l.field);
    }
  }
  if (leftKeyFields.length === 0) return null;
  const plan = computeJoinFieldPlan(join, ctx);
  if (!plan) return null;
  const { leftVarName, rightVarName, leftFields, rightFields, rightOutputName } = plan;
  const leftSourceText = emit(join.left, ctx);
  const rightSourceText = emit(join.right, ctx);
  const needsCompositeKey = join.conditions.length > 1;
  const leftRefName = needsCompositeKey ? `${leftVarName}InclKey` : leftVarName;
  const rightRefName = needsCompositeKey ? `${rightVarName}InclKey` : rightVarName;
  const preLines = [];
  if (needsCompositeKey) {
    const leftKeyExpr = leftKeyFields.join(' & "|" & ');
    const rightKeyExpr = rightKeyFields.join(' & "|" & ');
    preLines.push(`let ${leftRefName} = select *,
    ${leftKeyExpr} as JoinKey
    from ${leftSourceText};`);
    preLines.push(`let ${rightRefName} = select *,
    ${rightKeyExpr} as JoinKey
    from ${rightSourceText};`);
  }
  const leftFieldsText = leftFields.map((f) => `${leftRefName}.${f}`);
  const rightFieldsText = rightFields.map((f) => {
    const ref = `${rightRefName}.${f}`;
    const outputName = rightOutputName(f);
    return outputName === f ? ref : `${ref} as ${outputName}`;
  });
  const allFieldsText = [...leftFieldsText, ...rightFieldsText].join(",\n    ");
  const joinText = needsCompositeKey ? `${leftRefName} as a inner join ${rightRefName} as b on a.JoinKey = b.JoinKey` : `${leftSourceText} as ${join.leftAlias} inner join ${rightSourceText} as ${join.rightAlias} on ${join.leftAlias}.${leftKeyFields[0]} = ${join.rightAlias}.${rightKeyFields[0]}`;
  return { preLines, finalExprText: `select ${allFieldsText}
    from ${joinText}` };
}
function unwrapBracedExpression(text) {
  const trimmed = String(text ?? "").trim();
  const braced = trimmed.match(/^\{([\s\S]*)\}$/);
  return braced ? braced[1] : trimmed;
}
function translateExpression(classicExpressionText, ctx) {
  return emit(parseExpression(classicExpressionText), ctx);
}
function translateMappingExpression(mappingExpressionText, ctx) {
  const trimmed = String(mappingExpressionText || "").trim();
  const braced = trimmed.match(/^\{([\s\S]*)\}$/);
  const node = parseExpression(braced ? braced[1] : trimmed);
  const text = emit(node, ctx);
  return enumFieldTypeOf(node, ctx) ? `${text}.name` : text;
}
function translateMappingTemplate(mappingText, ctx) {
  const trimmed = String(mappingText || "").trim();
  const parts = splitTemplate(trimmed);
  if (!parts || parts.length === 1 && "expr" in parts[0]) return translateMappingExpression(trimmed, ctx);
  return parts.map((p) => {
    if ("literal" in p) return JSON.stringify(p.literal);
    const expr = translateMappingExpression(p.expr, ctx);
    return /^[A-Za-z_][\w.]*$/.test(expr) ? expr : `(${expr})`;
  }).join(" & ");
}
function translateAssignmentTemplate(classicExpressionText, ctx) {
  const trimmed = String(classicExpressionText || "").trim();
  const braced = trimmed.match(/^\{([\s\S]*)\}$/);
  const translated = translateExpression(braced ? braced[1] : trimmed, ctx);
  return braced ? `{${translated}}` : translated;
}
function translateOrRaw(rawText, translate) {
  try {
    return translate();
  } catch (e) {
    return rawText;
  }
}
function translateControlField(raw, mode, ctx) {
  const rawText = String(raw ?? "");
  if (mode === "template") {
    return translateOrRaw(rawText, () => translateAssignmentTemplate(rawText, ctx));
  }
  return translateOrRaw(rawText, () => translateExpression(unwrapBracedExpression(rawText), ctx));
}
function hoistMapAsForAssignmentValue(classicComputedExpressionText, ctx) {
  const node = parseExpression(classicComputedExpressionText);
  const hoisted = [];
  const rebuilt = hoistNestedMapAs(node, hoisted, true);
  return {
    expr: emit(rebuilt, ctx),
    hoistedLines: hoisted.map((s) => emitStatement(s, ctx))
  };
}
function collectWarnings(statements, warnings) {
  for (const s of statements) {
    if (s.type === "raw") {
      warnings.push(s.errorMessage);
    } else if (s.type === "if") {
      for (const branch of s.branches) collectWarnings(branch.body, warnings);
      if (s.elseBody) collectWarnings(s.elseBody, warnings);
    } else if (s.type === "for" || s.type === "while") {
      collectWarnings(s.body, warnings);
    }
  }
}
function translateScript(classicScriptText, ctx) {
  mapAsTempCounter = 0;
  const text = String(classicScriptText || "");
  const tokens = tokenize(text);
  const parser = createParser(tokens, text);
  const statements = parser.parseProgram();
  const warnings = [];
  collectWarnings(statements, warnings);
  const localSchemas = /* @__PURE__ */ new Map();
  const localFunctionSignatures = collectLocalFunctionSignatures(statements);
  const scalarVarKinds = /* @__PURE__ */ new Map();
  const scriptCtx = Object.assign({}, ctx, {
    localSchemas,
    localFunctionSignatures,
    scalarVarKinds,
    schemaLookup: (key) => localSchemas.get(key) ?? (ctx && ctx.schemaLookup ? ctx.schemaLookup(key) : null)
  });
  const finalStatements = annotateTopLevelLetKindTransitions(statements, scriptCtx);
  scriptCtx.tableColumnTypesFromUsage = inferTableColumnTypesForTopLevelTables(finalStatements, scriptCtx);
  const body = emitStatements(finalStatements, scriptCtx);
  const openLine = usesSeqModule(body) ? "open Seq;\n" : "";
  return { script: `${openLine}${body}`, warnings };
}
function inferScriptReturnRowSchema(classicScriptText, ctx) {
  const savedCounter = mapAsTempCounter;
  try {
    const text = String(classicScriptText || "");
    const tokens = tokenize(text);
    const parser = createParser(tokens, text);
    const statements = parser.parseProgram();
    const localSchemas = /* @__PURE__ */ new Map();
    const scriptCtx = Object.assign({}, ctx, {
      localSchemas,
      schemaLookup: (key) => localSchemas.get(key) ?? (ctx.schemaLookup ? ctx.schemaLookup(key) : null)
    });
    emitStatements(statements, scriptCtx);
    const lastReturn = [...statements].reverse().find((s) => s.type === "return");
    if (!lastReturn || !lastReturn.expr) return null;
    return resolveAssignedRowSchema(lastReturn.expr, scriptCtx);
  } catch {
    return null;
  } finally {
    mapAsTempCounter = savedCounter;
  }
}
function extractMapAsShapes(classicScriptText) {
  const text = String(classicScriptText || "");
  let statements;
  try {
    const tokens = tokenize(text);
    statements = createParser(tokens, text).parseProgram();
  } catch (e) {
    return [];
  }
  const shapes = [];
  statements.forEach((s) => {
    if ((s.type === "let" || s.type === "set") && s.expr && s.expr.type === "mapAs") {
      shapes.push({ kind: "named", name: s.name, fields: s.expr.fields.map((f) => f.name) });
    } else if (s.type === "return" && s.expr && s.expr.type === "record") {
      s.expr.fields.forEach((f) => {
        if (f.expr && f.expr.type === "mapAs") {
          shapes.push({ kind: "returnField", field: f.name, fields: f.expr.fields.map((mf) => mf.name) });
        }
      });
    }
  });
  return shapes;
}
export {
  CONNECT_BUILTINS,
  SINGLE_ROW_PICK_FUNCTIONS,
  buildTableDeclaration,
  buildTypedFieldsText,
  extractMapAsShapes,
  flattenConcatChain,
  hoistMapAsForAssignmentValue,
  inferDottedFieldKindsFromScriptUsage,
  inferScriptReturnRowSchema,
  matchTableCall,
  parseExpression,
  requiredEnumOpens,
  resolveFunctionName,
  schemaLookupKeyOf,
  tokenize,
  translateAssignmentTemplate,
  translateControlField,
  translateExpression,
  translateMappingExpression,
  translateMappingTemplate,
  translateOrRaw,
  translateScript,
  unwrapBracedExpression,
  unwrapToSourceIdentifier,
  usesSeqModule
};

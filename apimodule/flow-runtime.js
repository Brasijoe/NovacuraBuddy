/* ============================================================
   Flow Runtime — the fixed Flowscript every generated REST module
   starts with. Names and shapes follow Connect's own OData modules
   (Header, HandleHeaders, MergeHeaders, addBasePath, GetResponse…,
   fromTextFunction, enumMapping, recordMappingFunction,
   renamerFunction) so a Flow developer recognises them.

   The REST part is new: a list GET is a Queryable whose
   translation compiles a `where` into a small JSON tree —
     {"f":"status"}                      a field
     {"v":"sold"}                        a literal
     {"op":"eq","a":<node>,"b":<node>}   an operator (and/or/eq/neq/gt/ge/lt/le/like/in/notin/dot/upper)
   — and the rows function splits it: `=` / `in` on a declared
   query parameter, reachable from the root through `and` only,
   goes to the API as `?name=value`; everything else is tested on
   the returned rows. A condition sent to the API is never tested
   again in memory (`where limit = 10` would otherwise drop every
   row, as rows have no `limit` field).
   ============================================================ */
(function (global) {
  const RUNTIME = String.raw`
type RestQueryTranslation = {
    iden: text -> text,
    num:  number -> text,
    bool: boolean -> text,
    txt:  text -> text,
    parens: text -> text,
    conj: (text, text) -> text,
    disj: (text, text) -> text,
    eq: (text, text) -> text,
    neq: (text, text) -> text,
    gt: (text, text) -> text,
    ge: (text, text) -> text,
    lt: (text, text) -> text,
    le: (text, text) -> text,
    dot: (text, text) -> text,
    func_upper: text* -> text,
    rec: { } -> text,
    like: (text, text) -> text,
    in: (text, text*) -> text,
    notin: (text, text*) -> text,
    agg_sum: true
}

type Header = {
    Name: text,
    Value: text
};

type RestParam = {
    name: text,
    value: text?
};

type Mapping = any -> any;

type Enum<TNamespace, TName> = { enumerationNamespace: TNamespace, name: TName }

private function whenNotNull(f: any -> any) =>
    x => case when x = null then null else f(x) end;

// Create an enum mapping record
private function enumMapping(label, mapping: Mapping) => { label, mapping: whenNotNull(mapping) };

// Create a memoized "find mapping" function from a list of enum mappings
private function mappingFinderFunction(mappings: { label, mapping: Mapping }*) =>
    lookup >> Seq.map(_, m => m.mapping) >> firstOrDefault(_, identity)
        given {
            lookup = mappings.toLookup(m => m.label)
        };

private function recordMappingFunction(mappings: { label, mapping: Mapping }*) =>
    uncurry(finder) given { finder = memoize(mappingFinderFunction(mappings)) };

private function fromTextFunction(values: { enumerationNamespace: text, name: text }*, enumerationName: text, name: text) {
    let value = firstOrNull(values as v where v.name = name);
    if value != null:
        return value;
    error ${"`"}Could not convert {name} to the corresponding {enumerationName} enumeration value.${"`"};
}

// Given a set of selections in the form {name, alias}, create a function which renames a field if needed.
private function renamerFunction(selects: {name, alias}*): text -> text {
    if not selects.exists(s => s.alias != null) {
        return identity;
    }

    return (label) => isNull(selects.filter(s => s.name == label).firstOrNull().alias, label);
}

/* ---------- HTTP ---------- */

private function HandleHeaders(headers: Header* = []): {} {
    let localHeaders = headers;
    if (not headers.exists(h => h.Name == "Content-Type")):
        localHeaders = localHeaders & [new Header { Name: "Content-Type", Value: "application/json" }];
    return Record.fromMembers(localHeaders.map(h => Record.getMembers(h)).map(x => { label:str(x.value[0]), value: x.value[1] }))
}

/** Merges required headers with user-provided headers. Required headers take precedence — duplicates by name are removed, keeping the required value. */
private function MergeHeaders(required: Header*, userHeaders: Header*): Header* =>
    (required & userHeaders).distinctBy(h => h.Name);

private function HandleFailedRequest(response: { statusCode: number, reasonPhrase: text, headers: { name: text, values: text* }*, contents: text}) {
    error ${"`"}HTTP {response.statusCode} {response.reasonPhrase}: {left(isNull(response.contents, ""), 1000)}${"`"};
}

private function HandleHTTPResponse(response: { statusCode: number, reasonPhrase: text, headers: { name: text, values: text* }*, contents: text}): text =>
     case when response.statusCode >= 200 and response.statusCode < 300 then response.contents
          else HandleFailedRequest(response) end;

private function addBasePath(url): text {
    if basePath = '':
        return case when url.left(1) = '/' then url.mid(1, len(url) - 1) else url end;
    if url.left(1) = '/':
        return ${"`"}{basePath}{url}${"`"};
    else:
        return ${"`"}{basePath}/{url}${"`"};
}

/** If no Content-Type header is specified, the Content-Type will be passed as application/json. */
private function GetResponse(url: text, headers: Header* = []): text =>
    HandleHTTPResponse(HTTP.getText(addBasePath(url), HandleHeaders(headers)));

/** If no Content-Type header is specified, the Content-Type will be passed as application/json. */
private function PostResponse(url: text, body: text, headers: Header* = []): text =>
    HandleHTTPResponse(HTTP.postText(addBasePath(url), HandleHeaders(headers), body));

/** If no Content-Type header is specified, the Content-Type will be passed as application/json. */
private function PatchResponse(url: text, body: text, headers: Header* = []): text =>
    HandleHTTPResponse(HTTP.patchText(addBasePath(url), HandleHeaders(headers), body));

/** If no Content-Type header is specified, the Content-Type will be passed as application/json. */
private function PutResponse(url: text, body: text, headers: Header* = []): text =>
    HandleHTTPResponse(HTTP.putText(addBasePath(url), HandleHeaders(headers), body));

/** If no Content-Type header is specified, the Content-Type will be passed as application/json. */
private function DeleteResponse(url: text, headers: Header* = []): number {
    let response = HTTP.delete(addBasePath(url), HandleHeaders(headers))
    return case when response.statusCode >= 200 and response.statusCode < 300 then response.statusCode
           else error ${"`"}HTTP {response.statusCode} {response.reasonPhrase}${"`"} end;
}

private function HandleHTTPResponseBinary(response: { statusCode: number, reasonPhrase: text, headers: { name: text, values: text* }*, contents: binary}): binary | text {
    if (response.statusCode == 202 or response.statusCode == 204):
        return response.statusCode;

    return case when response.statusCode >= 200 and response.statusCode < 300 then response.contents
           else error ${"`"}HTTP {response.statusCode} {response.reasonPhrase}${"`"} end;
}

private function PostResponseBinary(url: text, body: binary, headers: Header* = []): binary | text =>
    HandleHTTPResponseBinary(HTTP.postBinary(addBasePath(url), HandleHeaders(headers), body));

private function PatchResponseBinary(url: text, body: binary, headers: Header* = []): binary | text =>
    HandleHTTPResponseBinary(HTTP.patchBinary(addBasePath(url), HandleHeaders(headers), body));

private function PutResponseBinary(url: text, body: binary, headers: Header* = []): binary | text =>
    HandleHTTPResponseBinary(HTTP.putBinary(addBasePath(url), HandleHeaders(headers), body));

/* ---------- Parameters and bodies ---------- */

// A parameter value as the API expects it in a URL: enum values by name, booleans lower-case.
private function restText(value: unknown): text? =>
    case when value = null then null
         when value is { name: text } then value.name
         when value is boolean then lower(str(value))
         else str(value) end;

private function restPath(value: unknown): text => urlEncode(isNull(restText(value), ''));

private function restQueryString(params: RestParam*): text {
    let parts = params.filter(p => p.value != null).map(p => urlEncode(p.name) & '=' & urlEncode(isNull(p.value, ''))).eval();
    return case when parts.any() then '?' & parts.join('&') else '' end;
}

private function restHeaders(values: { Name: text, Value: text? }*): Header* =>
    values.filter(h => h.Value != null).map(h => new Header { Name: h.Name, Value: isNull(h.Value, '') }).eval();

// Typed enum values back to their plain text, nested records and sequences included.
private function restRemap(value: unknown): unknown {
    if (value is { enumerationNamespace: text, name: text }) {
        return value.name;
    }
    if (value is {}*) {
        return value.map(restRemap).eval();
    }
    if (value is {}) {
        return Record.fromMembers(Record.getMembers(value).map(m => { label: m.label, value: restRemap(m.value) }));
    }
    return value;
}

private function restJsonBody(input: unknown): text => JSON.serialize(restRemap(input));

private function restFormBody(input: {}): text =>
    Record.getMembers(restRemap(input)).filter(m => m.value != null).map(m => urlEncode(m.label) & '=' & urlEncode(isNull(restText(m.value), ''))).join('&');

/* ---------- Queryable: where -> query parameters + in-memory test ---------- */

private function restOp(op: text, a: text, b: text): text => '{"op":"' & op & '","a":' & a & ',"b":' & b & '}';

private function restTranslation(): RestQueryTranslation {
    return {
        iden: name => '{"f":' & JSON.serialize(name) & '}',
        num:  n => '{"v":' & str(n) & '}',
        bool: b => '{"v":' & (case when b then 'true' else 'false' end) & '}',
        txt:  t => '{"v":' & JSON.serialize(t) & '}',
        arr:  (xs: text*) => xs,
        parens: x => x,
        null: () => '{"v":null}',
        conj: (x, y) => restOp('and', x, y),
        disj: (x, y) => restOp('or', x, y),
        eq:   (x, y) => restOp('eq', x, y),
        neq:  (x, y) => restOp('neq', x, y),
        gt:   (x, y) => restOp('gt', x, y),
        ge:   (x, y) => restOp('ge', x, y),
        lt:   (x, y) => restOp('lt', x, y),
        le:   (x, y) => restOp('le', x, y),
        dot:  (x, y) => restOp('dot', x, y),
        like: (x, y) => restOp('like', x, y),
        in:   (x, ys) => restOp('in', x, '[' & ys.join(',') & ']'),
        notin: (x, ys) => restOp('notin', x, '[' & ys.join(',') & ']'),
        func_upper: xs => restOp('upper', xs[0], 'null'),
        func_Date: (xs: text*) => xs[0],
        func_date: (xs: text*) => xs[0],
        rec: r => case when r is { enumerationNamespace: text, name: text } then '{"v":' & JSON.serialize(r.name) & '}' else '{"v":null}' end,
        agg_sum: true
    };
}

private function restGet(node: unknown, label: text): unknown =>
    case when node is {} then Record.getValue(node, label, null) else null end;

private function restOpOf(node: unknown): text => isNull(restText(restGet(node, 'op')), '');

// A field name as the Queryable hands it over: compiled ({"f":"x"}) in a where, plain in order by / select.
private function restFieldName(name: text): text =>
    case when name.left(5) = '{"f":' then JSON.deserialize<{ f: text }>(name).f else name end;

private function restFilter(q: Queryable.QuerySpec<text>): unknown =>
    case when q.filter = null then null else JSON.deserialize<{}>(q.filter) end;

// The declared query parameter an and-reachable condition can be sent as, or null.
private function restParamName(node: unknown, queryParams: text*): text? {
    let op = restOpOf(node);
    if op != 'eq' and op != 'in' {
        return null;
    }
    let field = restGet(restGet(node, 'a'), 'f');
    if field = null or not (restText(field) in queryParams) {
        return null;
    }
    if op = 'eq' and (restGet(restGet(node, 'b'), 'f') != null or restGet(restGet(node, 'b'), 'op') != null) {
        return null;
    }
    return restText(field);
}

private function restParams(node: unknown, queryParams: text*): RestParam* {
    if node = null {
        return [];
    }
    if restOpOf(node) = 'and' {
        return restParams(restGet(node, 'a'), queryParams) & restParams(restGet(node, 'b'), queryParams);
    }
    let name = restParamName(node, queryParams);
    if name = null {
        return [];
    }
    if restOpOf(node) = 'eq' {
        return [new RestParam { name: isNull(name, ''), value: restText(restGet(restGet(node, 'b'), 'v')) }];
    }
    return unsafeCast<{}*>(restGet(node, 'b')).map(v => new RestParam { name: isNull(name, ''), value: restText(restGet(v, 'v')) }).eval();
}

private function restValueOf(node: unknown, row: {}): unknown {
    let field = restGet(node, 'f');
    if field != null {
        return Record.getValue(row, isNull(restText(field), ''), null);
    }
    let op = restOpOf(node);
    if op = 'dot' {
        let parent = restValueOf(restGet(node, 'a'), row);
        let child = restGet(restGet(node, 'b'), 'f');
        return case when parent is {} and child != null then Record.getValue(parent, isNull(restText(child), ''), null) else null end;
    }
    if op = 'upper' {
        return upper(isNull(restText(restValueOf(restGet(node, 'a'), row)), ''));
    }
    return restGet(node, 'v');
}

// -1 / 0 / 1; numbers numerically, everything else as text; null sorts first.
private function restCompare(left: unknown, right: unknown): number {
    let l = restText(left);
    let r = restText(right);
    if l = null or r = null {
        return case when l = null and r = null then 0 when l = null then -1 else 1 end;
    }
    if isNumber(l) and isNumber(r) {
        return case when val(l) < val(r) then -1 when val(l) > val(r) then 1 else 0 end;
    }
    if l = r {
        return 0;
    }
    return case when [l, r].orderBy(x => x).first() = l then -1 else 1 end;
}

// SQL LIKE (% and _) as a whole-text regular expression.
private function restLike(value: text?, pattern: text?): boolean =>
    regexMatch(isNull(value, ''), '^' & isNull(pattern, '').regexReplace(@"[.*+?^${'$'}{}()|\[\]\\]", @"${"\\"}${'$'}0").replace('%', '.*').replace('_', '.') & '${'$'}');

private function restTest(node: unknown, row: {}, queryParams: text*, top: boolean): boolean {
    if node = null {
        return true;
    }
    let op = restOpOf(node);
    if op = 'and' {
        return restTest(restGet(node, 'a'), row, queryParams, top) and restTest(restGet(node, 'b'), row, queryParams, top);
    }
    if op = 'or' {
        return restTest(restGet(node, 'a'), row, queryParams, false) or restTest(restGet(node, 'b'), row, queryParams, false);
    }
    if top and restParamName(node, queryParams) != null {
        return true;
    }
    let left = restValueOf(restGet(node, 'a'), row);
    if op = 'in' or op = 'notin' {
        let found = unsafeCast<{}*>(restGet(node, 'b')).exists(v => restCompare(left, restValueOf(v, row)) = 0);
        return case when op = 'in' then found else not found end;
    }
    let right = restValueOf(restGet(node, 'b'), row);
    if op = 'like' {
        return restLike(restText(left), restText(right));
    }
    let c = restCompare(left, right);
    return case when op = 'eq' then c = 0
                when op = 'neq' then c != 0
                when op = 'gt' then c > 0
                when op = 'ge' then c >= 0
                when op = 'lt' then c < 0
                when op = 'le' then c <= 0
                else error ${"`"}The operator '{op}' is not supported on REST data sources.${"`"} end;
}

private function restKeep(rows: {}*, filter: unknown, queryParams: text*): {}* =>
    rows.filter(r => restTest(filter, r, queryParams, true));

private function restOrder(rows: {}*, q: Queryable.QuerySpec<text>): {}* {
    let result = rows;
    for o in q.orderBy.reverse() {
        let field = restFieldName(o.field);
        set result = case when o.descending then result.orderByDescending(r => Record.getValue(r, field, null))
                          else result.orderBy(r => Record.getValue(r, field, null)) end;
    }
    return result;
}

// order by (on the raw rows), then typed enum values, then select / aliases.
private function restShape(rows: {}*, q: Queryable.QuerySpec<text>, mapRow: {} -> {}): {}* {
    if q.groupBy.any() {
        error "group by and aggregates are not supported on REST data sources; select the rows and group them in memory instead.";
    }
    let names = q.selections.map(restFieldName).filter(s => not (left(s, 1) == "@")).eval();
    let renamer = memoize(renamerFunction(q.selection));
    return restOrder(rows, q)
        .map(mapRow)
        .map(r => case when names.any() then Record.fromMembers(Record.getMembers(r).filter(m => m.label in names)) else r end)
        .map(r => Record.mapLabels(r, renamer))
        .eval();
}
`.trim();

  /** The module source up to the generated part: base path, `open Seq;` and the runtime above. */
  function runtimePreamble(basePath) {
    const quoted = String(basePath || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return `let basePath = '${quoted}';\n\nopen Seq;\n\n${RUNTIME}\n`;
  }

  const api = { runtimePreamble, RUNTIME };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.ApiFlowRuntime = api;
  }
})(typeof window !== "undefined" ? window : globalThis);

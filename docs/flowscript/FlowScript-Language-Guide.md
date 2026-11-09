# FlowScript

## FlowScript Language Quick Guide (for LLM code generation)

This language is a small, expression-friendly PL with structural typing.\
It looks TypeScript-like, but is **not JavaScript** and includes SQL-like forms (`case when ...`, `and/or`, etc.).

### 1) Core model

* **Immutable values by default**; variable rebinding uses `set x = ...` (or sometimes plain `x = ...`).
* Structural types (records/unions), optional nullability, generics.
* First-class functions, recursion, higher-order functions, lambdas.
* Sequences are common (`T*`).

### 2) Basic syntax

* Variable declaration:
  * `let x = 1`
* Rebinding:
  * `set x = 2`
* Return:
  * `return expr`
* Comments:
  * `// line comment`
  * `/* block comment */`
  * `/** doc comment */` (no additional syntax inside)
* Expression-level bindings:
  * x + y given { x = 1, y = 2 }

### 3) Primitive and composite types

* Primitives:
  * `number`, `text`, `boolean`, `null`
* Sequences:
  * `number*` = sequence of numbers
  * `number**` = sequence of sequence of numbers
* Records:
  * `{ x: number, name: text }`
* Unions:
  * `type Term = Num | Var | Op`
* Nullable:
  * `number?` and value `null`
* Generics:
  * `function id<T>(x: T): T => x`

### 4) Functions

#### Standard function

```
function square(x: number): number {
    return x * x;
}
```

#### Expression-bodied

```
function square(x: number) => x * x;
```

#### Method-style via `self`

```
function square(self x: number) => x * x;
return 8.square();   // also callable as square(8)
```

#### Function types

* `T -> U` (single arg)
* `(A, B) -> C` (multi-arg)

#### Lambdas

* `x => x + 1`
* `x => y => x + y`

### 5) Control flow

#### If / else

Two forms are valid:

Block form:

```
if cond { ... }
else if other { ... }
else { ... }
```

Single-statement (`:`) form:

```
if cond:
    return 1
else:
    return 2
```

#### While / For

```
while cond { ... }

for x in xs {
    ...
}
```

Loop control:

* `break`
* `continue`
* `return` exits enclosing function/program

### 6) Pattern-like branching expressions (`case`)

```
case when cond1 then expr1
     when cond2 then expr2
     else exprElse
end
```

### 7) Operators and expressions

* Arithmetic: `+ - * / mod`
* Comparisons: `=`, `!=`, `>`, `<`, etc. (`==` also appears in tests)
* Boolean: `and`, `or`, `not`
* Text/sequence concatenation: `&`
* Membership: `x in xs`
* Type test: `value is SomeType`

### 8) Data/type declarations

```
type Operator = "+" | "-" | "*" | "/"
type Num = { ty: "number", value: number }
type Var = { ty: "variable", name: text }
type Op  = { ty: "op", lhs: Term, rhs: Term, operator: Operator }
type Term = Num | Var | Op
```

Record update:

```
scope with { y: 1 }
```

### 9) Modules and visibility

* Import/open module:
  * `open Seq;`
* Private bindings in module:
  * `private let f = ...`

### 10) Sequence/text idioms

* Literals: `[1, 2, 3]`, `'hello'`, `"hello"`
* Common sequence ops (requires opening Seq module):\
  `map`, `filter`, `collect`, `fold`, `sum`, `count`, `any`, `first`, `skip`, `prepend`, `append`, `join`, `indexed`, `zip`, `range`
* Partial application:
  * `myFunction(_, 1)`
* Composition:
  * `f >> g`

### 11) Built-in functions

* Text and regex:
  * `upper(input)`, `lower(input)`, `len(input)`, `left(input, count)`, `right(input, count)`, `mid(text, index, count)`, `trim(input)`, `inStr(source, lookFor)`, `replace(input, search, replacement)`, `split(text, delimiter)`, `join(seq, separator)`, `regexMatch(input, pattern)`, `regexMatches(input, pattern)`, `regexReplace(input, pattern, replacement)`
* Number/date/format:
  * `val(input)`, `isNumber(input)`, `ceil(input)`, `floor(input)`, `round(x)`, `pow(base, exponent)`, `min(a, b)`, `max(a, b)`, `random(min, max)`, `chr(input)`, `rgb(red, green, blue)`, `now()`, `date(input)`, `toDate(input, format)`, `format(input, pattern)`, `formatLocale(input, pattern, locale)`
* Null/default helpers:
  * `isNull(value, replacement)`, `isNullOrEmpty(value, replacement)`
* Sequence helpers:
  * `count(sequence)`, `any(seq)`, `first(seq)`, `firstOrNull(seq)`, `firstOrDefault(seq, default)`, `firstOrEmpty(seq)` (deprecated; use `firstOrNull`), `last(seq)`, `lastOrNull(seq)`, `lastOrDefault(seq, default)`, `lastOrEmpty(seq)` (deprecated), `range(start, count)`, `take(seq, count)`, `skip(seq, count)`, `sum(seq)`, `empty(seq)`, `flatten(seq)`, `eval(seq)`
* Encoding/binary:
  * `urlEncode(input)`, `urlDecode(input)`, `encodeText(input, encoding: 'utf-8' | 'utf-16')`, `decodeText(data, encoding: 'utf-8' | 'utf-16')`, `base64Encode(data)`, `base64Decode(base64)`
* Functional/utilities:
  * `guid()`, `hash(value)`

### 12) Error and side-effect statements

* Throw script error:
  * `error 'message'`
* Assertion (currently no-op in runtime tests):
  * `assert condition`
* Evaluate expression for effects:
  * `do someCall(...)`
* Generators:
  * `yield x` inside loops/functions; `yield from xs` yields more than one value.

### 13) Conventions to generate valid code

1. Prefer `if/else` + braces unless concise single-line form is clearly needed.
2. Use `and/or/not` instead of `&&/||/!`.
3. Use `&` for text concatenation.
4. Use `T*` for sequences and `T?` for nullable results.
5. Use names that do not shadow built-in function names like `count`, `sum`.
6. Prefer functional style (map/filter/collect) over loops.

### 14) Minimal template

```
open Seq;

type Item = { name: text, value: number };

function render(self items: Item*): text {
    if not items.any():
        return 'empty';

    return items.map(i => i.name & ': ' & str(i.value)).join(', ');
}

let data = [
    { name: 'a', value: 1 },
    { name: 'b', value: 2 }
];

return data.render();
```

### 15) HTTP module

Use `HTTP.request(url, options)` for HTTP calls. The options arg is optional.

#### Request options

```
type RequestOptions = {
    optional method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
    optional headers: Record<text>,
    optional body: text | binary | MultipartBody | null,
    optional continueOnError: boolean,
    optional authParameters: OpenIDConnectParameters
}
```

#### Response

```
type Response = {
    statusCode: number,
    reasonPhrase: text,
    headers: { name: text, values: text* }*,
    ok: boolean,
    asText: () -> text,
    asBinary: () -> binary,
    close: () -> null
}
```

#### OpenID Connect auth

```
type OpenIDConnectParameters = {
    clientId: text,
    authority: text,
    scope: text,
    optional name: text,
    optional responseType: text,
    optional responseMode: text,
    optional additionalEndpointBaseAddresses: text*,
    optional validateIssuer: boolean,
    optional validateAudience: boolean,
    optional validateLifetime: boolean,
    optional validateEndpoints: boolean,
    optional requireHttpsMetadata: boolean,
    optional privateSession: boolean,
    optional prefillUserEmail: boolean,
    optional additionalParameters: Record<text>
}
```

#### Examples

```
// Simple GET
let response = HTTP.request('https://api.example.com/data');
let text = response.asText();

// POST with JSON body
let response = HTTP.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"key": "value"}'
});

// Handle errors manually
let response = HTTP.request(url, { continueOnError: true });
if not response.ok:
    error `Request failed: {response.statusCode}`;
```

### 16) JSON module

```
type Data = {foo: number}
let data = '{"foo": 1}'

return JSON.deserialize<Data>(data);
```

```
return JSON.serialize({foo: 1});
```

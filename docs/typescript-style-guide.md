# TypeScript style guide

Adopts [Google's TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) for this repo.
This page is the condensed, agent-facing form of it — the parts that are actually decidable while writing
a line of code — so an agent doesn't have to re-fetch or re-derive the source guide each session. When this
page and the source guide disagree, the source guide wins; file a correction here.

**Applies to new code and to any file touched from this point forward. It is not a retrofit** — do not
reformat or rewrite untouched lines in a file just to bring them into line with this guide. A file may
legitimately show an older style next to new Google-style code until it's next touched as a whole; that's
expected, not a defect.

---

## 1. Formatting

Prettier is configured at the repo root (`.prettierrc.json`) to exactly these numbers — run `npm run format`
(or `npx prettier --write <file>`) on anything you touch rather than matching them by hand. It is not wired
into a pre-commit hook; `npm run format:check` globs only the repo's own source trees. The numbers, for when a
formatter isn't at hand:

- **2-space indentation**, no tabs.
- **120-column soft limit** (widened from Google's default 80). Wrap past it; exceptions for things that
  can't be split (long URLs/paths, a single unbreakable identifier).
- **Semicolons on every statement.** Never rely on ASI.
- **Single quotes** for strings (`'like this'`), not double quotes. Use a template literal instead of
  escaping an embedded `'`.
- **Template literals** (backticks) over string concatenation, especially with more than one interpolated
  value.
- **Trailing commas** in multiline array/object/parameter literals.
- **K&R braces**: opening brace on the same line, `} else {` on one line.
- Control-flow statements (`if`, `for`, `while`, `do`) always use a braced block — **except** an `if` whose
  entire body fits on the same line, which may drop the braces: `if (x) x.doFoo();`.
- One blank line between logical groups inside a function body; none at the very start or end of the body.
- One blank line around class methods and around the constructor; no blank lines required (or discouraged)
  around a class's own opening/closing braces.
- No space after `...` in rest/spread: `function f(...args: number[])`.
- Attach `*` to the keyword: `function* foo()`, `yield* iter` — not `function *foo()`.

## 2. Naming

| Case | Used for |
|---|---|
| `UpperCamelCase` | class, interface, type alias, enum, decorator, type parameter, TSX component function |
| `lowerCamelCase` | variable, parameter, function, method, property, module alias |
| `CONSTANT_CASE` | module-level constants and enum *values* only — not locals, not fields re-created per instance |
| never | `#privateField` syntax, `_leading`/`trailing_` underscores, `opt_` prefixes, `IFoo`/`FooInterface` |

- Treat acronyms as ordinary words: `loadHttpUrl`, not `loadHTTPURL` (exception: a platform name forces it,
  e.g. `XMLHttpRequest`).
- Descriptive names; no single-letter/abbreviated names except in a scope of ~10 lines or fewer.
- A value that's `CONSTANT_CASE` must live at module scope (or be a `static readonly` on a module-level
  class). Anything instantiated more than once per process lifetime — a local in a function, a field on a
  per-instance class — is `lowerCamelCase` even if effectively constant for that instance.

## 3. Language features

- **`const` by default, `let` when reassigned. Never `var`.** One variable per declaration (no `let a = 1, b = 2;`).
- **No default exports.** Always named exports. Don't create a "namespace" class of static
  members — export the functions/constants directly.
- **No `export let`** for mutable state exposed outside a module — export a getter function instead.
- **Arrow functions**, not `function` expressions, for anything assigned to a variable or passed as a
  callback. Function *declarations* (`function foo() {}`) are fine and preferred for top-level named
  functions. `function` expressions survive only for the rare case of needing to dynamically rebind `this`,
  and for generators (no arrow-generator syntax).
- Arrow function used only for a side effect (not its return value) needs a block body:
  `p.then(v => { console.log(v); })`, not `p.then(v => console.log(v))` — the concise-body form leaks
  whatever the expression returns.
- Classes generally shouldn't hold arrow-function *properties* (they silently pre-bind `this`, confusing
  callers) — the one legitimate case is an event handler that needs to be uninstalled later and so needs a
  stable bound reference.
- `===`/`!==` only. The lone exception: `== null` / `!= null` to catch both `null` and `undefined` in one
  check.
- `for (const x of arr)` to iterate array values. `for...in` only over plain dict-style objects, and even
  there prefer `Object.keys/values/entries`. Never `for...in` over an array.
- Only throw `Error` (or a subclass), always via `new Error(...)`. Never throw a bare string/value. Assume
  anything caught is an `Error`; if an API is known to throw something else, say so in a comment at the
  catch site.
- `switch` always has a `default` (last, even if empty); every non-empty case ends in `break`/`return`/throw
  — no accidental fallthrough.
- No `#privateField` class syntax — use the `private` keyword. No private *static* methods — prefer a
  plain, non-exported function in the same file. Never reference `this` in a static context.
- Mark a property `readonly` if nothing outside the constructor ever reassigns it. Google prefers parameter
  properties over hand-plumbed constructor assignment, but **`erasableSyntaxOnly` forbids them here; see
  below.**
- Never `eval`, `Function('...')`, `with`, `debugger` in shipped code, or hand-rolled prototype/mixin
  manipulation — use `class`.
- Type/non-null assertions (`x as T`, `y!`) are a last resort, not a convenience — prefer an actual runtime
  check. If one is genuinely safe, say why in a comment. Always `as`, never `<T>x`. A cast that isn't a
  narrowing/widening of the same type goes through `unknown`: `(x as unknown as Foo)`.
- `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`: don't. Fix the type, or narrow with a real check.

### `erasableSyntaxOnly`: three of Google's rules do not apply here

`erasableSyntaxOnly: true` is set in `tsconfig.json`, because Node runs the TypeScript directly by stripping
types rather than compiling. The option permits only syntax that *disappears* when the types are stripped, so
anything that emits code of its own is a compile error:

| Not available | Because | What to write instead |
|---|---|---|
| Parameter properties | emits an assignment | declare the field, assign it in the constructor body |
| `enum` (and `const enum`) | emits an object | a `const` object plus a union type, or a string-literal union |
| `import x = require(...)`, `namespace` | emit a binding | named `import` and plain modules |

The compiler says `error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled`, which is the
string to search for when a build refuses a line that Google's guide told you to write. Reach for the replacement
rather than working around the error silently.

The naming table's `enum` rows in section 2 are unreachable in practice here; they still describe how to name one
if you are writing code somewhere the option is not set.

## 4. Type system

- Let inference do its job for trivial cases (`const n = 3;`, not `const n: number = 3;`); annotate when a
  generic would otherwise collapse to `unknown` (`const s = new Set<string>();`) or when the inferred type
  materially helps a reader.
- **Prefer `interface` over a `type` alias** for anything shaped like an object. Reach for `type` for
  unions, tuples, and mapped/conditional types — not as the default way to describe an object's shape.
- **Avoid `any`.** Reach for a real type, or `unknown` plus a narrowing check, before `any`. If `any` is
  genuinely the right call (a test mock, an untyped third-party shape), say why in a comment next to it.
- Prefer `T[]` / `readonly T[]` over `Array<T>` / `ReadonlyArray<T>` for simple element types; use the
  longer generic form only when the element type itself needs it to stay readable
  (`Array<string|number>`).
- Prefer an optional property (`milk?: Whole|LowFat`) over a `|undefined` union member on the same field.
- A type alias itself should not include `|null`/`|undefined` in the union — add that at the point of use,
  not baked into the alias.
- Prefer `Map`/`Set` over an object used as an associative array; when a string-keyed object is genuinely
  wanted, give the index signature a descriptive key name: `{[fileName: string]: number}`, not
  `{[key: string]: number}`.
- Reach for `Record<K, V>` when the value type is known and the keys form a defined set, rather than an
  index signature.
- Never `String`/`Boolean`/`Number` as constructors (`new Boolean(false)` is truthy!). The lowercase
  primitive types only; `String(x)`/`Boolean(x)`/`Number(x)` *without* `new` are fine for coercion.
- Avoid `{}` as a type — it accepts almost anything and blocks property access on what it holds. Use
  `unknown` for a genuinely opaque value, `Record<string, T>` for a dict, or `object` to mean
  "non-primitive, no assumptions about shape."
- Two related string/number values returned together: a tuple (`[string, string]`) is fine for an
  unlabelled pair; once there are more than two or they need names, an inline object return type
  (`{host: string, port: number}`) reads better than a tuple.

## 5. Comments

- `/** ... */` JSDoc for anything a *caller* of the code should read (exported functions/classes/types);
  `//` for implementation notes aimed at someone reading the source.
- Multi-line ordinary comments are stacked `//` lines, never an asterisk-boxed `/* ... */` block.
- JSDoc tags (`@param`, `@returns`, ...) each start their own line.
- UK/Canadian spelling (colour, centre, behaviour, ...) — see AGENTS.md; applies to prose everywhere in the
  repo, not just comments, and is not a retrofit of existing text.

## 6. Imports/exports

- Named imports/exports only — no default export, no `namespace Foo {}`, no `/// <reference>`, no
  `import x = require(...)`.
- Prefer relative imports within this repo.
- Only export what's actually used from outside the module; keep the exported surface minimal.

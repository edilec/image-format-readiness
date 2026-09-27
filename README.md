# Image Format Readiness

Inspect one exported HTML file and the local images it references. The checker reports where dimensions, aspect ratio, format policy, alternative text, loading declarations, or byte budgets need attention. It is offline, has zero dependencies, and never edits an image or HTML source.

## Quick start

Node 22 or newer:

```sh
node examples/run-clean.mjs
node examples/run-failing.mjs  # exits 1 by design
node bin/image-format-readiness.mjs --root ./site-export --html ./site-export/index.html --matrix ./site-export/browser-matrix.json --json
```

The CLI requires `--root`, `--html`, and `--matrix`. `--report FILE` is optional and must name a destination under the real root. Stdout always contains the JSON report and a safe report file receives identical bytes. `--json` suppresses the short human status on stderr. The library exports `TOOL_ID`, `RULE_SEVERITY`, `checkImageReadiness`, and `exitCodeFor` from `src/index.mjs`.

The matrix is a supplied, pinned policy export: `schemaVersion: "1"`, a visible `matrixId`, and 1–16 unique browser/version rows containing unique subsets of `png`, `jpeg`, `gif`, and `webp`. `examples/matrix.json` is a demonstration policy, **not** a claim about current browser support. No browser or host is contacted.

For a visual walkthrough of the checked-in clean and failing fixtures, see the [Edilec worked example](https://edilec.com/open-source/image-format-readiness/). It also explains what this offline check cannot prove.

## Rules

| Rule | Severity | Meaning |
| --- | --- | --- |
| `image-byte-budget-exceeded` | error | A unique local image has more bytes than `maxImageBytes`. |
| `total-byte-budget-exceeded` | error | Unique local files together exceed `maxTotalBytes`. |
| `intrinsic-dimensions-undeclared` | error | An image reference lacks either HTML `width` or `height`. |
| `aspect-ratio-mismatch` | error | Declared dimensions have a different ratio from the header dimensions. |
| `alt-undeclared` | error | The `alt` attribute is absent; `alt=""` is an accepted decorative declaration. |
| `loading-undeclared` | info | Neither `loading="eager"` nor `loading="lazy"` was declared. |
| `format-not-in-matrix` | error | The observed header format is absent from a pinned browser row. |

Incomplete evidence uses a separate warning diagnostic, never a clean verdict: unreadable or malformed files, unsupported image headers, ambiguous HTML, unsupported `src` forms, out-of-root links, missing images, and exceeded processing limits. A document with no image references is `no-images` incomplete. The report's `images` array records only bounded root-relative path labels, header format/dimensions/bytes, and safe attribute declarations; it never prints alternative text or page prose. A local path is not rejected merely for exceeding the label length: labels over 160 UTF-16 units show a short prefix, original length, and SHA-256 of the full UTF-16 path to distinguish similar names. Findings are sorted by UTF-16 code units.

## Limits and exit codes

Defaults: 64 KiB matrix, 1 MiB HTML, 500 image references, 256 KiB inspected header per image, 500 findings, 30,000 ms cooperative analysis timeout, 250,000 bytes per unique image, and 2,000,000 unique bytes total. Budgets are inclusive: exactly N is allowed, N+1 is not. The library accepts positive-integer overrides in `limits` and an injected `now` function for deterministic timeout tests. Elapsed runtime may vary with machine load; the clock never selects evidence or changes a completed report.

| Exit | stdout | Meaning |
| --- | --- | --- |
| 0 | `status: pass` report | Complete evidence and no error finding. |
| 1 | `status: fail` report | Complete evidence proves a rule violation. |
| 2 | empty for invalid configuration; otherwise `status: incomplete` report | Invalid matrix/options or missing/ambiguous input, timeout, or unsafe report destination. |

`--report` refuses a destination symlink, an escaping symlinked parent, direct or hard-link aliases of inputs, and dangling input symlinks (including multi-hop) that would become the report. Inputs include the HTML, matrix, and every local image path the scanner reasons about, even if it could not read it. Refusal does not overwrite an original and does not claim success.

## Supported evidence and non-goals

The bounded HTML subset reads ordinary `<img>` start tags and skips comments, script/style bodies, and title/textarea text. It does not implement HTML5 error recovery or responsive source selection: `<picture>`, `<source>`, `srcset`, templates, `noscript`, iframes, malformed/duplicate attributes, ampersand/percent-encoded or query/fragment-bearing sources, remote/data sources, and unsupported loading values are incomplete. An unsupported loading value appears as `unknown` in image evidence rather than being copied into the report. Relative image paths resolve from the HTML file's directory; root-relative paths resolve from the declared root. It confines symlinks under that real root before reading. PNG, GIF, JPEG, and WebP *headers* supply format and positive dimensions; this is not a full decode or image integrity check. It does not optimize images, rewrite a page, fetch remote media, or assert live browser compatibility.

Run `npm run check` for syntax and tests. The test suite exercises ordinary good input first, then all documented rules, both sides of the declared limits, ambiguous evidence, path confinement, and guarded output.

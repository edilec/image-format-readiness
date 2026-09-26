# Image Format Readiness Implementation Plan

## Goal

Build a zero-dependency offline checker for one HTML export and its local images, with pinned format policy and guarded optional report writing. Follow the approved design in `../specs/2026-09-20-image-format-readiness-design.md`.

## Files

- `src/index.mjs`: public library, validation, bounded scanner, image metadata, findings, timeout, report envelope.
- `src/json.mjs`: strict JSON reader with duplicate-key and depth detection for the matrix.
- `src/write-guard.mjs`: current catalog destination guard including dangling input aliases.
- `bin/image-format-readiness.mjs`: CLI, option parsing, exit shapes, stdout/report byte equality.
- `test/image-format-readiness.test.mjs`: library and CLI contracts using synthetic binary fixtures in temporary roots.
- `examples/run-clean.mjs`, `examples/run-failing.mjs`, `examples/matrix.json`: reproducible offline examples.
- `README.md`, `package.json`: contract and scripts.

## TDD sequence

1. Write named passing ordinary-image library/CLI tests using an in-test PNG header. Run and observe red import/behavior. Implement minimal good path, report envelope, CLI and clean example; run green.
2. Add failing oversize and missing intrinsic dimensions cases, then byte N/N+1, ratio equality/mismatch, alt and loading, unique-file total budget. Run red before each rule implementation. Confirm correct-image controls stay pass.
3. Add bounded HTML/source/parser cases (comments/script, unsupported forms, outside-root symlink, missing/unreadable file) and metadata cases for PNG/JPEG/GIF/WebP. Keep ambiguity incomplete, not a failure finding. Test each threshold at N and N+1.
4. Add strict pinned matrix validation, duplicate-key/depth rejection, format-policy evidence, deterministic UTF-16 ordering and untrusted output sanitization. Exercise no-image and timeout N/N+1 with injected clock.
5. Add optional report-output CLI tests first: safe new/existing byte-equal writes; destination symlink, escaping parent, hardlink, direct path, one/two-hop dangling image input aliases, and distinct missing-image control. Copy current guard and integrate full named input set; ensure refusal exits 2/incomplete without damaging input.
6. Write README and runnable examples. For each README guarantee, remove or alter the corresponding production branch temporarily, run its named test to observe failure, restore, and record the mutation result. Run `npm run check`, examples, direct CLI failure probes, raw-control scan, `git diff --check`; commit local coherent milestones.

## Commit checkpoints

Commit good path/rules, incomplete/limits, guard/CLI, and documentation/tests separately after fresh relevant verification. Do not change central ledger or receipts.

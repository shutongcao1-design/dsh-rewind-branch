# Changelog

## 0.1.0 — 2026-10-27

First open-source release.

- Adds one action under every finished turn: **Rewind to before this prompt** —
  preview the affected files, confirm, restore them, then continue in a new
  branch session. The original session is left untouched.
- Content-addressed pre/post snapshots for `write`, `edit`, `str_replace_editor`
  and `multi_edit`; restoring does not require a Git repository.
- Conflict detection: files changed outside the captured window are skipped and
  listed, never overwritten.
- Safety backup of the current content under `<data>/safety/<timestamp>/` before
  every restore, plus a TOCTOU re-validation right before writing.
- Running sessions refuse to rewind; the first turn of a session has no
  checkpoint.
- Same-origin HTTP routes guarded by `connection.requestRejection`
  (fail-closed 403); no network calls.

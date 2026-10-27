# dsh-rewind-branch

Rewind a turn of a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) session and continue in a new branch — with the files that turn changed restored. The session you came from is left exactly as it was.

English | [中文](README.zh.md)

## What it does

Every finished turn gets one action under the assistant reply: **Rewind to before this prompt**.

Clicking it:

1. asks the Host for a plan — which files that turn changed, which were created, which now conflict, and what risks the turn carries;
2. after you confirm, restores those files to their state **before the prompt**, backing up the current content first;
3. forks the conversation at that message boundary into a **new branch session** and switches to it.

Nothing is deleted from the original session: its log, messages and continuation stay untouched. The new branch keeps the conversation up to the message before the rewind point.

## Why branch instead of in-place rewind

An in-place rewind truncates the current conversation. Branching keeps the original as evidence and makes the rewind reversible: the old session is still there to compare against or to continue.

File restoration does **not** require Git. The Host captures the pre-write bytes of DSH's file-tool targets into a content-addressed store, so a workspace without a repository (or with unrelated uncommitted changes) is restored file by file instead of by resetting a repository.

## Install

Requires DeepSeek Harness **0.2.1-rc.3 or newer** (declared in `dsh.engines`). No dependencies, no build step, plain JavaScript.

Install from GitHub:

```bash
dsh plugin --profile <profile> add "git+https://github.com/shutongcao1-design/dsh-rewind-branch.git"
```

`dsh plugin` installs the package and selects the bundle in the same operation. **Restart DSH after installing** (a full quit, not just a page refresh) so the Host half starts and the turn-tail action reaches the client.

This plugin is not published to npm; install it from this repository.

## Usage

1. Let an agent turn finish — the session must be idle.
2. Under that turn's reply, click **Rewind to before this prompt**.
3. Review the plan: files to restore, files to delete, conflicts, warnings.
4. Click **Confirm** — the files are restored and a new branch session opens.

Notes:

- The first turn of a session has no earlier checkpoint and cannot be rewound.
- A running turn refuses to rewind (`session-running`); wait for it to finish.
- Turns that ran before the plugin was installed, or while it was disabled, have no snapshots.

## What is captured

Captured (pre-write bytes and a post-write snapshot, per file):

- `write`, `edit`, `str_replace_editor`, `multi_edit` — the tools that write files through DSH.

Not captured:

- `bash`, `pwsh`, terminal tools, `run_code` and other shell/code executors. If such a tool ran in the selected turn, the preview shows a warning and the files it changed are not restored; captured files are still restored.
- Symlinks, directories and files larger than 4 MiB are skipped.
- File mode bits, ACLs, hard links and submodule contents are not restored.

## Conflicts and safety

- The Host compares the current file with the latest post-write snapshot. If they differ (you edited it by hand, or a shell changed it), the file is **skipped and listed as a conflict** — never overwritten.
- The current content is backed up to `<data>/safety/<timestamp>/` (`manifest.json` plus one `.bin` per file) before any write.
- The plan is re-validated right before writing (TOCTOU); a file changed while the confirmation dialog was open is skipped instead of overwritten.
- Writes go through a temporary file followed by rename, so a partially written file never replaces a good one.

## Data

- Journal and content-addressed blobs live under `<DSH_HOME>/dsh-rewind-branch/` (`journal.jsonl`, `blobs/`, `safety/`).
- On desktop builds whose Host does not inherit `DSH_HOME`, they fall back to a `data/` directory next to this package.
- The journal is append-only and rotates at 64 MB (`journal.1.jsonl`). Delete the directory to drop all checkpoint history; `safety/` backups are plain files you can copy out first.

## Security

- The three HTTP routes (`/preview`, `/rewind`, `/client.js`) are same-origin only: each one runs `connection.requestRejection` and fails closed with 403 when the request is not the profile's own authenticated page.
- The plugin makes no network calls. It stores bytes locally and forks sessions through the Host's `sessions` service.
- Restores happen inside the Host process on your explicit click and only touch absolute paths recorded in the journal for the selected turn.

## Compatibility and limits

- DSH Web client and the DSH Desktop shell (any deployment that serves the Web GUI).
- Workspaces do not need Git; Git's index, HEAD, refs and commits are never changed. If the turn committed, the commit stays and the preview warns you.
- Only files changed by DSH file tools are restored; changes made by shell/terminal/code-runner tools are reported and left alone.
- The rewind boundary is an existing session event (`turn/start.seq - 1`), so the first turn cannot be rewound.

## Development

```bash
node --test test/     # unit tests: plan building, restore execution, TOCTOU, safety backup, manifest
npm run check         # syntax check for every runtime file
```

Layout:

| File | Role |
|---|---|
| `index.js` | Host half: capture, plan routes, restore |
| `client.js` | Browser half: turn-tail action, preview panel, fork + switch |
| `lib/store.js` | Content-addressed blobs + append-only journal |
| `lib/plan.js` | Pure plan computation + plan execution (unit tested) |
| `test/` | Unit tests and manifest checks |

No build step: the runtime files are plain ESM plus one browser script.

## License

MIT. See [LICENSE](LICENSE).

# Chef PDF: Hợp đồng giao tiếp (Contracts)

> **Nguồn sự thật** cho giao tiếp giữa 3 phần: lõi Python (`core/`), Electron main/preload (`apps/desktop/`) và giao diện (`apps/ui/`).
> Kiểu TypeScript tương ứng nằm ở `packages/contracts/src/` (`rpc.ts`, `bridge.ts`). **Sửa file này thì sửa luôn kiểu TS, và ngược lại.**
> Viết bằng tiếng Anh vì đây là tài liệu kỹ thuật dùng trực tiếp khi code.

## 1. Process model

```
Renderer (apps/ui)  --window.chef (preload)-->  Main (apps/desktop)  --JSON-RPC over stdio-->  Core (core/)
```

- The renderer never touches the filesystem or the core directly. It only uses `window.chef` (`ChefBridge` in `bridge.ts`).
- Main forwards `chef.rpc(method, params)` to the core unchanged and forwards every core notification to the renderer as a `ChefEvent { type: 'rpc', name, payload }`.

## 2. Core sidecar launch

| Mode | Command |
|---|---|
| Dev | `uv run --project core python -m chef_core --data-dir <dir>` (run from repo root) |
| Packaged | `<resources>/core/chef-core[.exe] --data-dir <dir>` (PyInstaller onedir) |
| Override | env `CHEF_CORE_CMD` (full command line, `--data-dir` is appended) |

- `<dir>` = Electron `app.getPath('userData')`. The core uses `<dir>/sessions/` and `<dir>/cache/`.
- On start the core writes nothing to stdout until it is ready, then answers `system.ping`.
- **stdout is reserved for JSON-RPC.** All logs go to **stderr** (main writes them to `userData/logs/core.log`).
- Main restarts the core if it exits unexpectedly and emits `core-status` events (`starting`, `ready`, `crashed`, `restarting`).

## 3. Framing

- JSON-RPC 2.0, **one JSON object per line** (UTF-8, `\n` terminated), in both directions.
- Requests have `id` (main uses incrementing integers). Notifications have no `id`.
- Errors use `{ code, message, data: { kind, detail? } }`. `kind` is one of `ErrorKinds` in `rpc.ts`.
  - JSON-RPC codes: `-32700` parse error and `-32600` invalid request (`kind: INVALID_PARAMS`), `-32601` method not found (`kind: OP_NOT_FOUND`), `-32602` invalid params (`kind: INVALID_PARAMS`), `-32000` application error (all other kinds, incl. unknown `opId` in `ops.run` → `OP_NOT_FOUND`, request aborted by shutdown → `CANCELLED`).
  - `jobs.cancel` on an unknown or already finished job returns `null` (no error).
- Large binary data never goes through stdio. Pass file paths instead.
- **Renderer side:** `chef.rpc()` rejects with a plain object `{ name: 'RpcError', code, message, data: { kind, detail? } }` (not an `Error`, because contextBridge strips custom properties from `Error`). If the core is down, in-flight requests reject with `kind: 'INTERNAL'`.
- `system.shutdown` can only be called by main; from the renderer it is rejected with `INVALID_PARAMS`.

## 4. Methods

All signatures are in `RpcMethods` (`rpc.ts`).

| Method | Notes |
|---|---|
| `system.ping` | Health check. |
| `system.shutdown` | Graceful exit (main calls it on app quit). |
| `ops.list` | Registered operations with JSON Schema of their params. |
| `ops.run` | Validates params, starts a job, returns `{ jobId }` immediately. Then `job.progress`* followed by exactly one of `job.finished` / `job.failed` / `job.cancelled`. `sessionId` is required unless the op is `standalone`. |
| `jobs.cancel` | Cooperative cancel; the job ends with `job.cancelled`. |
| `session.open` | Opens a file into a new session. Encrypted file without password → error `PASSWORD_REQUIRED`; wrong password → `PASSWORD_INVALID`. |
| `session.create` | Empty session (used before inserting pages / images into a new doc). |
| `session.close` | Deletes the session directory. |
| `session.state` / `session.info` | Current state / document properties (B7). |
| `session.undo` / `session.redo` | Move between revisions. `changedPages` = `'all'`. |
| `session.save` | Writes the current revision to `path` (or back to the source path) atomically: write temp file in the same dir, fsync, then rename. Returns the new state (`dirty: false`) plus `warnings: string[]`. |

### Session storage

```
<data-dir>/sessions/<sessionId>/
  meta.json        { sourcePath, openedAt, password? (never written), signed, revision }
  rev-0000.pdf     working copy at open time (always UNENCRYPTED)
  rev-0001.pdf ...
  journal.jsonl    one line per op: { rev, opId, params, at }
```

- Revision files are **always unencrypted** so pdf.js can read them without a password. The password stays in memory only.
- On `session.save` of a document that was opened encrypted, the core re-encrypts with AES-256 using the opened password as the user password (owner password = same). The state result includes a warning if the original owner password could not be preserved.
- Undo history: keep at most 50 revisions; older ones are dropped (rev-0000 is always kept).
- A session whose `meta.json` exists at startup without a clean close marker is a crash-recovery candidate (A9, later milestone).

## 5. Viewer file access

- The renderer loads revision files via `chef.files.toUrl(absPath)`, which returns `chef-file://f/<encodeURIComponent(absPath)>`.
- Main registers the `chef-file` protocol and **only** serves files that are (a) inside `<data-dir>/sessions` or `<data-dir>/cache`, or (b) paths returned by `files.openDialog` / passed by the OS in this app run. Anything else → 403.
- pdf.js must be configured with `isEvalSupported: false` and scripting disabled.

## 6. Operations

- Op ids are `group.action`. Params are pydantic models in the core; `ops.list` returns their JSON Schema. The core also generates TypeScript interfaces into `packages/contracts/src/generated/ops.ts` (`python -m chef_core.codegen`).
- Page indices are **0-based**.
- Every op result returns the new `SessionState` and `changedPages`. Standalone ops run without a session return `state: null`, `changedPages: []`.
- **Signed documents:** when the opened file already contains a signed signature field, `SessionState.signed` is `true` and ops that rewrite the document (rotate, delete, duplicate, reorder, insert*) fail with `BLOCKED_BY_SIGNATURE`. Read-only/export ops (extract, split, merge) are allowed. The UI must explain this and suggest saving a copy first (a "remove signatures" op comes in a later milestone).
- After `system.shutdown` the core deletes all session directories. On a bare stdin EOF (main crashed) sessions are left on disk as crash-recovery candidates (A9).

### v0.1 operations

| Op id | Session? | Params | Result notes |
|---|---|---|---|
| `page.rotate` | yes | `{ pages: number[], angle: 90 \| 180 \| 270 }` (relative, clockwise) | `changedPages = pages` |
| `page.delete` | yes | `{ pages: number[] }` (cannot delete all pages → `INVALID_PARAMS`) | `'all'` |
| `page.duplicate` | yes | `{ pages: number[] }` (each copy inserted right after its source) | `'all'` |
| `page.reorder` | yes | `{ order: number[] }` (full permutation of current indices: new page i = old page `order[i]`) | `'all'` |
| `page.extract` | yes | `{ pages: number[], outputPath: string }` (document unchanged) | `outputs = [outputPath]` |
| `page.insertBlank` | yes | `{ at: number, count: number, width?: number, height?: number }` (size defaults to the page before `at`, or A4) | `'all'` |
| `page.insertFromFile` | yes | `{ at: number, path: string, password?: string, pages?: number[] }` | `'all'` |
| `page.insertImages` | yes | `{ at: number, images: ({ path: string } \| { dataUrl: string })[], pageSize: 'image' \| 'a4' \| 'letter', margin: number }` (margin in pt; respects EXIF rotation) | `'all'` |
| `file.merge` | **standalone** | `{ inputs: { path: string, password?: string, pages?: number[] }[], outputPath: string, bookmarksFromFilenames: boolean }` | `outputs = [outputPath]` |
| `file.split` | yes | `{ mode: 'ranges' \| 'everyN' \| 'bookmarks' \| 'maxSize' \| 'oddEven', ranges?: string, n?: number, maxBytes?: number, outputDir: string, nameTemplate?: string }` | `outputs` = files written |

- `ranges` uses 1-based human syntax, e.g. `"1-3,5,7-9"`; each comma group becomes one output file. `"7-"` means page 7 to the end; reversed groups like `"3-1"` are allowed.
- `nameTemplate` variables: `{name}` (source file name without extension), `{index}` (1-based, zero-padded to the number of digits of the total), `{start}`, `{end}` (1-based pages). Default `"{name}_{index}"`.
- `maxSize` splits greedily by pages so that each file stays at or under `maxBytes` (a single page bigger than the limit becomes its own file + warning).

## 7. Settings

- Stored by main in `<userData>/settings.json` (`Settings` in `bridge.ts`, `version: 1`).
- `recentFiles` keeps the 20 most recent, newest first, de-duplicated by path.
- `settings.set(patch)` merges **shallowly**: each top-level key replaces the whole value (e.g. `prefs` is replaced, not deep-merged). Unknown keys or invalid values reject the call.
- Production UI is served from `chef-app://ui/` (so the UI build must use relative asset paths, Vite `base: './'`). CSP: `script-src 'self' 'wasm-unsafe-eval'`, no inline scripts, no `eval`.

## 8. Conventions

- UI strings: i18next keys, Vietnamese default (`vi`), English fallback (`en`). No hard-coded user-facing strings.
- Never log document content, passwords or PINs.

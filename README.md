# Fast File Picker

**English** | [简体中文](README.zh-CN.md)

A fast, indexed file picker for VS Code, built for **very large codebases** such as
[AOSP](https://source.android.com/) — where the built-in Quick Open gets slow.

It indexes every file in your workspace once, then answers searches from an
in-memory trigram index, so results appear as you type even with hundreds of
thousands of files.

## Features

- **Indexed search** — a persisted per-workspace file index plus a trigram /
  acronym / directory index; no directory walk on each keystroke.
- **Smart query syntax** — file name, path, CamelCase acronyms, extension
  filters, exclusions and fuzzy matching (see [Search syntax](#search-syntax)).
- **Ranked results** — exact name, prefix, acronym, substring, path and fuzzy
  matches are ranked in that order; recently opened files win ties.
- **Recently opened files** — shown when the picker is empty.
- **Multiple workspace folders** — searches every root of a multi-root workspace.
- **Quick exclusions** — right-click a folder in the Explorer to exclude it and
  re-index immediately.
- **`compile_commands.json` support** — C/C++ compile databases are used as an
  extra source of file paths.

## Quick start

1. Install the extension.
2. Run **FilePicker: Build Search Database** once
   (`Ctrl+Shift+P` → type `FilePicker`).
   This can take a few seconds on a large project — progress is shown in the
   notification area.
3. Press `Ctrl+P` (`Cmd+P` on macOS) and start typing.
   `Enter` opens the file, `Esc` closes the picker.

<img src="https://raw.githubusercontent.com/wwm0609/quickfilepicker/master/how-to-use-fast-file-picker.gif" width="720" alt="Using Fast File Picker">

> The extension binds `Ctrl+P` / `Cmd+P` to its own picker. To keep VS Code's
> built-in Quick Open on that shortcut, reassign **FilePicker: Search Files** in
> *Keyboard Shortcuts* (`Ctrl+K Ctrl+S`).

## Commands

| Command | Description |
| --- | --- |
| **FilePicker: Search Files** | Open the picker (`Ctrl+P` / `Cmd+P`). |
| **FilePicker: Build Search Database** | Re-scan the workspace and rebuild the index. |
| **FilePicker: exclude dirs** | Exclude the selected folder(s); also available from the Explorer context menu. |
| **FilePicker: cancel exclude dirs** | Re-index a previously excluded folder. |

## Search syntax

A query is split on whitespace into terms. **All positive terms must match**
(AND semantics) — `foo bar` finds `barfoo.c` and `foo/bar.c`, but not `foo.c`.

| Query | Meaning |
| --- | --- |
| `name` | Base name substring, or a CamelCase acronym prefix: `ams` → `ActivityManagerService.java`. Also matches a directory segment prefix: `framework` → files under `frameworks/`. |
| `src/foo` | Any term containing `/` is matched against the full path. A leading `./` is ignored. |
| `foo bar` | AND: every term must match. |
| `.java` | Extension filter (when other terms are present), e.g. `ams .java`. |
| `!test` | Exclude files matching `test`. A lone `!.ext` excludes that extension, e.g. `!test !.java`. |
| `actmgr` | No strict match? Terms fall back to scored fuzzy subsequence matching: `actmgr` → `ActivityManagerService.java`. |

Results are ranked **exact name > name prefix > acronym > name substring >
path match > fuzzy**, with recent files winning ties inside a rank.

Typing a path that actually exists (e.g. `src/main.ts`) opens it directly —
handy for whole-path muscle memory.

## Configuration

All settings live under **Settings → Extensions → FilePicker**.

| Setting | Default | Description |
| --- | --- | --- |
| `FilePicker.excludeDirs` | `""` | Directories not to index. `:`-separated entries may be `"${workspace}/out"`, an absolute path, or a bare name matched anywhere (`out`). Hidden directories and `.git`, `.repo`, `.vscode` are always skipped. |
| `FilePicker.excludeFileTypes` | `""` | File types not to index, `:`-separated, e.g. `.png:.jpg:.mp4`. Hidden files are always skipped. |
| `FilePicker.showDebugLog` | `"None"` | Log level: `None`, `Verbose`, `Debug`, `Info`, `Warning`, `Error`. |

Example:

```json
{
  "FilePicker.excludeDirs": "${workspace}/out:${workspace}/build:/mnt/shared/generated",
  "FilePicker.excludeFileTypes": ".png:.jpg:.mp4"
}
```

> **Rebuild the database after changing either exclude setting** — the two
> settings only take effect during indexing.

You can also exclude a folder without editing settings: right-click it in the
Explorer and choose **FilePicker: exclude dirs**. It is removed from the index
immediately, and **FilePicker: cancel exclude dirs** adds it back.

<img src="https://raw.githubusercontent.com/wwm0609/quickfilepicker/master/exclude_dirs.png" width="600" alt="Excluding directories from the Explorer context menu">

## How it works

```
Ctrl+P ──► pattern compiler ──► trigram candidates ──► ranked matches ──► Quick Pick
                                   (index)              (search.ts)
```

- **Database** — a plain-text, one-path-per-line file per workspace at
  `~/.q_file_picker/<encoded-workspace>/file_index.db`. It is written
  atomically and never lives inside your repository.
- **Indexes** — trigram postings over base names, an acronym bucket index for
  CamelCase names, and a directory-segment index for path terms. All are
  `Uint32Array`-backed to keep memory low (≈15–20 MB for 310k files).
- **Persistent cache** — the index is serialized to `trigram_index.cache` and
  keyed by a hash of the path list, so extension-host restarts skip the rebuild.
- **Responsive** — typing is debounced by 80 ms, in-flight searches are
  cancelled as soon as the input changes, and the first matches are displayed
  while the rest of the search continues.

## Known limitations

- **The index is not watched.** After large changes (many files added, renamed
  or deleted), run **FilePicker: Build Search Database** again.
- Hidden files and directories are never indexed.
- Very broad queries return the first 300 ranked matches; narrow the query to
  see more.

## Development

Requirements: Node.js 18+, VS Code 1.75+.

```bash
npm install
npm run compile    # or: npm run watch
npm test           # compiles and runs the pure-logic self tests
npm run package    # builds a .vsix with vsce
```

Press `F5` in VS Code to launch an Extension Development Host with the
extension loaded.

### Code structure

The code is layered so the search logic is testable without VS Code:

```
src/
  extension.ts          activation and command wiring
  quickOpen.ts          Quick Pick UI only
  search.ts             pattern compilation, matching and ranked search (pure logic)
  trigramIndex.ts       trigram + acronym + directory index (pure logic)
  indexedFile.ts        index entry type and name/acronym helpers (pure logic)
  fileIndexing.ts       build / load / persist the per-workspace database
  settings.ts           excludeDirs / excludeFileTypes handling
  paths.ts              workspace helpers and database file locations
  recentFileHistory.ts  LRU of recently opened files
  logger.ts             leveled logging
  test/selftest.ts      unit tests for the pure modules (npm test)
```

## Feedback

Found a bug or have an idea? Open an issue at
[github.com/wwm0609/quickfilepicker](https://github.com/wwm0609/quickfilepicker/issues).

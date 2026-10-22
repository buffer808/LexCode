---
name: lexcode-sync
description: Sync the current project's TASKS.md into its LexCode board record (status changes, new tasks, renames, removed tasks get archived). Use when the user says "sync tasks", "sync TASKS.md to LexCode", "update LexCode from tasks", "/lexcode-sync", or after editing TASKS.md in a project tracked by the LexCode VS Code extension.
---

# LexCode sync

Pushes TASKS.md edits into the LexCode board (`board.json`) using the extension's own parser, so the result matches the extension's **Sync from TASKS.md** command exactly. Never edit `board.json` by hand.

## Steps

1. Locate the CLI (newest installed extension in any VS Code-family editor: VS Code, Devin, VSCodium, Cursor, …):

   ```sh
   LEX=$(ls -td ~/.*/extensions/lex.lex-code-*/out/cli.js 2>/dev/null | head -1)
   ```

   Empty → tell the user the LexCode extension (0.0.3+) isn't installed, stop.

2. Preview, from the project root (or pass the project path as the first argument):

   ```sh
   node "$LEX" sync --dry-run
   ```

   Output lines are `added|updated|archived<TAB>title`. Show them as a short table. "in sync" → say so, stop.
   Errors: "not a LexCode project" → the folder isn't added to LexCode (Board → `+`). "board.json not found" → set `LEXCODE_BOARD` to the file path.

3. Ask the user to confirm. Point out every `archived` row: those stories were removed from TASKS.md and will be hidden on the board (recoverable via "Show archived").

4. On yes: `node "$LEX" sync`. Report the counts. The board refreshes itself.

## Rules the sync follows

- Source: if the project has `.lexcode/import.md` (written by **Review with Claude** on import), that file is the manifest: only its stories are synced, each taking its current checkbox from the original line its `<!-- src: file:line -->` points to. TASKS.md items Claude weeded out are not re-added. The header line of the output shows which file was used. New tasks added to TASKS.md after the review are not picked up; to bring them in, re-run **Import Tasks from TASKS.md** → Review with Claude. Without import.md, TASKS.md is read directly.

- Match by title (case-insensitive), else by the story's recorded `file:line` (so renamed lines still match).
- `[x]` / struck / "done" → `done`; `[~]` → `doing` (a board `review` stays `review`); `[ ]` → `todo`.
- Epic/sprint follow the nearest `## Epic: X` / `## Sprint N` heading; missing ones are created.
- Stories created on the board (not imported from markdown) are never touched or archived.
- Status changes are also written back to the checkbox, same as in the extension.

# LexCode

Agile project manager for concurrent projects with Claude Code sessions — a VS Code extension.

![Mockup](docs/mockup.png)

## Why "LexCode"?

It started as **"let's code"**, said out loud more times a day than anyone would admit: at the start of every sprint, every new story, every fresh Claude session. Juggling three projects at once, the phrase got shorter each time — *let's code… lets-code… lex-code* — until it was just one word muttered at the terminal.

When the tool that kept all those projects, sprints and sessions in one place needed a name, there was only one candidate. LexCode is what "let's code" sounds like when you've already said it a hundred times today and still mean it.

## Install

```sh
npm install
npm run compile
npx @vscode/vsce package
code --install-extension lex-code-0.0.3.vsix
```

Or press F5 in VS Code to try it in an Extension Development Host.

### Manual install (after compile)

Once `npx @vscode/vsce package` has produced `lex-code-0.0.3.vsix` in the project root:

1. Open the **Extensions** view (`Cmd+Shift+X` / `Ctrl+Shift+X`).
2. Click the **`…`** (Views and More Actions) menu at the top of the view.
3. Choose **Install from VSIX…**.
4. Select `lex-code-0.0.3.vsix` and reload the window when prompted.

Alternatively, run **Extensions: Install from VSIX…** from the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).

### Install in Devin

Devin's editor is VS Code-based, so it installs the same `.vsix`:

1. Build the package as above (or copy `lex-code-0.0.3.vsix` into the Devin workspace).
2. In Devin's editor, open the **Extensions** view → **`…`** menu → **Install from VSIX…**, and pick the file.
   - Or from Devin's terminal: `code --install-extension lex-code-0.0.3.vsix`
3. Reload the window; the **LexCode** icon appears in the activity bar.

Background runs and the sparkle action need the `claude` CLI available in Devin's environment (set `lexCode.claudePath` if it isn't on `PATH`).

## Usage

Open the **LexCode** icon in the activity bar to see the **Board** view.

1. **Add a project** — click `+` in the Board title bar and pick one or more folders. Each is tracked separately. If the folder has a `TASKS.md`, LexCode offers to import it (see [Import tasks](#import-tasks-from-tasksmd)).
2. **Plan work** — hover a project for inline actions:
   - **New Epic** groups related stories.
   - **New Sprint** creates a sprint; **Start Sprint** (play icon) makes it active.
   - **New Story** adds a story (title, points, description, epic, sprint). Stories without a sprint sit in the backlog.
3. **Track progress** — on a story, use **Set Status** (`todo` → `doing` → `review` → `done`) and **Edit Story**. Right-click to delete stories, sprints, or epics.
4. **Work with Claude** — click the sparkle icon on a story to open a Claude Code session seeded with the story as the prompt. Session IDs are saved on the story so you can resume later.
   - Background runs use `claude --bg`; you get a notification when a run changes state or is blocked waiting for approval, and can attach to it in a terminal.
5. **Dashboard** — click the dashboard icon in the Board title bar for a kanban view across all projects:
   - Filter each project by sprint and epic, add stories inline, and drag cards between `todo` / `doing` / `review` / `done`.
   - Cards show epic, points, attachments, linked sessions, and a **⚠ approve** badge when a background run is waiting on you; **Claude ▶** starts a session, **Claude ↻** resumes one.
   - Click a card to open the story dialog: edit fields, paste or drop image attachments, see files Claude edited, and manage sessions — **Attach**, **Run in background** (with a per-run permission mode), **Unlink**, or link an existing session.
6. **Open projects** — open one project, or all of them, as workspace folders from the title bar or a project's inline actions.

### Import tasks from TASKS.md

Run **Import Tasks from TASKS.md** (or the dashboard's **Import tasks** button). LexCode finds the shallowest `TASKS.md` in the project and parses it:

- `## Epic: X`, `## Sprint 3`, `## Backlog` headings set context; list items under them (or checkbox items anywhere) become stories. Indented items join the story's description.
- `- [x]`, `~~struck~~`, ✅ or words like *done* / *archived* mark closed work, which is skipped. `[~]` / `[/]` means doing.
- Local links to other `.md` files are followed (except *archive* / *done* files).

You then choose **Review with Claude** — Claude checks the tasks against the code with you and writes the keepers to `.lexcode/import.md`, after which the picker opens — or **Pick manually**. Duplicates are skipped.

### Sync from TASKS.md

After import, keep editing TASKS.md and run **Sync from TASKS.md** (project context menu) to push the changes to the board: ticked items become `done`, `[~]` becomes `doing`, new items are added, renamed lines are matched by position, and items removed from the markdown are archived. Stories created on the board are never touched.

If the project was imported with **Review with Claude**, sync reads `.lexcode/import.md` instead and checks each story's original line (via its `src` comment), so work Claude weeded out isn't re-added. Items added to TASKS.md after the review need another review import.

The same sync runs headless, for Claude Code or scripts:

```sh
node ~/.vscode/extensions/lex.lex-code-0.0.3/out/cli.js sync [projectPath] [--dry-run]
```

It finds `board.json` in your editor's global storage (override with `LEXCODE_BOARD`).

#### Claude Code skill

[skills/lexcode-sync](skills/lexcode-sync/SKILL.md) previews the sync, asks you to confirm, then applies it. Install it once for every project:

```sh
mkdir -p ~/.claude/skills/lexcode-sync && cp skills/lexcode-sync/SKILL.md ~/.claude/skills/lexcode-sync/
```

Then say "sync tasks to LexCode" or run `/lexcode-sync` in any tracked project.

All commands are also available from the Command Palette under `LexCode:`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `lexCode.claudeLauncher` | `auto` | `auto`: use the Claude Code extension if installed, else the CLI. `cli`: always run `claude` in a terminal. |
| `lexCode.backgroundPermissionMode` | `manual` | Permission mode for background runs: `manual`, `acceptEdits`, `plan`, `auto`, `bypassPermissions` (dangerous). |
| `lexCode.tasksScanSkip` | `node_modules`, `.git`, `out`, `dist`, … | Folder names skipped when searching for `TASKS.md`. Empty list scans everything. |
| `lexCode.claudePath` | _(auto)_ | Path to the `claude` CLI. |

## Data

The board is stored as `board.json` in the extension's global storage; story attachments live beside it in `attachments/<storyId>/`.

## Develop

```sh
npm run watch   # rebuild on change
npm test        # compile + node:test
```

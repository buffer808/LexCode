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
code --install-extension lex-code-0.0.4.vsix
```

Or press F5 in VS Code to try it in an Extension Development Host.

### Manual install (after compile)

Once `npx @vscode/vsce package` has produced `lex-code-0.0.4.vsix` in the project root:

1. Open the **Extensions** view (`Cmd+Shift+X` / `Ctrl+Shift+X`).
2. Click the **`…`** (Views and More Actions) menu at the top of the view.
3. Choose **Install from VSIX…**.
4. Select `lex-code-0.0.4.vsix` and reload the window when prompted.

Alternatively, run **Extensions: Install from VSIX…** from the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).

### Install in Devin

Devin's editor is VS Code-based, so it installs the same `.vsix`:

1. Build the package as above (or copy `lex-code-0.0.4.vsix` into the Devin workspace).
2. In Devin's editor, open the **Extensions** view → **`…`** menu → **Install from VSIX…**, and pick the file.
   - Or from Devin's terminal: `code --install-extension lex-code-0.0.4.vsix`
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

After import, keep editing TASKS.md and run **Sync from TASKS.md** (project context menu) to push the changes to the board: ticked items become `done`, `[~]` becomes `doing`, new items are added, renamed lines are matched by position, and items removed from the markdown are archived. Stories created on the board are never touched. Pick an epic to sync only that epic (`--epic` on the CLI).

If the project was imported with **Review with Claude**, sync reads `.lexcode/import.md` instead and checks each story's original line (via its `src` comment), so work Claude weeded out isn't re-added. Items added to TASKS.md after the review need another review import.

The same sync runs headless, for Claude Code or scripts:

```sh
node ~/.vscode/extensions/lex.lex-code-0.0.4/out/cli.js sync [projectPath] [--dry-run] [--epic <name>]
```

It finds `board.json` in your editor's global storage (override with `LEXCODE_BOARD`).

#### Claude Code skill

[skills/lexcode-sync](skills/lexcode-sync/SKILL.md) previews the sync, asks you to confirm, then applies it. Install it once for every project:

```sh
mkdir -p ~/.claude/skills/lexcode-sync && cp skills/lexcode-sync/SKILL.md ~/.claude/skills/lexcode-sync/
```

Then say "sync tasks to LexCode" or run `/lexcode-sync` in any tracked project.

All commands are also available from the Command Palette under `LexCode:`.

### Software factory (preview)

Adding an epic starts an automated planning pipeline. It runs in the background with `claude --bg`, read-only in plan mode:

1. **Plan:** an orchestrator breaks the epic into sprints and stories, with dependencies and parallel-safe flags.
2. **Revalidate:** the plan is checked against the code. Existing code is reused, dependencies are confirmed, and affected files are listed.
3. **Security check:** findings are rated low, medium or high per sprint.
4. **Your approval:** the epic strip on the dashboard (or a notification) offers **View plan**, **Approve plan**, **Request changes** (sent back to the orchestrator) and **Reject**. Approving adds the sprints and stories to the board in TODO.

After approval, set the number of **Builders** and click **▶ Start build**. LexCode then:

1. Creates the epic branch, `lexcode/<epic>-<id>`, from the branch you were on. It is checked out in its own worktree under `.lexcode/worktrees/`, so your checkout is never switched.
2. Starts sprints once their dependencies are merged. *Parallel-safe* sprints run side by side, up to the builder count, each on its own branch and worktree. A sequential sprint always runs alone.
3. Works through each sprint's stories one at a time:
   - A **builder** session implements the story and commits it. It runs in the builder mode chosen for the epic.
   - A read-only **reviewer** checks the story's diff.
   - A failed review goes back to the same builder session, with the issues to fix. After `maxReviewAttempts` failures the story stops and waits for you: **Retry**, **Take over** (attach) or **Skip**.
4. Runs a **sprint review** on the whole sprint's diff once its stories are done. A failure becomes a fix session, followed by another review.
5. Merges the sprint into the epic branch automatically, unless the merge is critical. It is critical when:
   - the reviewer flagged it,
   - it changes a file matching `sensitivePaths`,
   - the plan has a medium or high security finding for that sprint, or
   - it conflicts with the epic branch.

   Critical merges wait for **Approve merge**, or **Send back** with a note for a fix session.
6. Asks to **Create PR** when every sprint is merged. This pushes the epic branch and runs `gh pr create` against the target branch.

Use **⏸ Pause** to stop new sessions from starting; running ones finish. Background runs that need a permission approval show **⚠ Approve…**.

- **Creating a factory epic:** use **+ Epic** on the dashboard or **LexCode: New Epic**. You choose:
  - the builder mode: *Accept edits* or *Full auto*;
  - the PR target branch;
  - the agent for each role;
  - optionally, the model and effort for each role.
- **Existing epics:** run **Run Software Factory on Epic** from an epic's context menu.
- **Your own agents:** agents in the project's (or your) `.claude/agents/` are used for matching roles, matched by name: *orchestrator/planner/architect/lead*, *validator/analyst*, *security/audit*, *review/qa*, *builder/developer/engineer*. Every other agent is offered to each session as a subagent to delegate to. To map agents explicitly, add `.lexcode/factory.json` to the project:

  ```json
  { "roles": { "orchestrator": "tech-lead", "reviewer": "code-reviewer" } }
  ```

  LexCode's own prompts (`agents/` in this extension) cover any role left unmapped.
- **Models:** planning stages default to Opus at high effort.
- **Requirements:**
  - The project must be a git repository.
  - Claude Code must trust the folder: run `claude` there once.
  - Creating PRs needs the GitHub CLI (`gh`), logged in.
- **Where plans are stored:** `.lexcode/epics/<epicId>/plan.{json,md}`. `.lexcode/` is added to `.git/info/exclude`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `lexCode.claudeLauncher` | `auto` | `auto`: use the Claude Code extension if installed, else the CLI. `cli`: always run `claude` in a terminal. |
| `lexCode.backgroundPermissionMode` | `manual` | Permission mode for background runs: `manual`, `acceptEdits`, `plan`, `auto`, `bypassPermissions` (dangerous). |
| `lexCode.tasksScanSkip` | `node_modules`, `.git`, `out`, `dist`, … | Folder names skipped when searching for `TASKS.md`. Empty list scans everything. |
| `lexCode.claudePath` | _(auto)_ | Path to the `claude` CLI. |
| `lexCode.factory.autoStart` | `true` | New epics start the software factory. Off: **New Epic** only creates the epic. |
| `lexCode.factory.builderPermissionMode` | `acceptEdits` | Builder mode preselected for new factory epics: `acceptEdits` or `auto` (Full auto). |
| `lexCode.factory.targetBranch` | `main` | Default PR target branch. |
| `lexCode.factory.models` | planner: `opus` / `high` | Model and effort for each role (`planner`, `builder`, `reviewer`). A project agent's own frontmatter `model` overrides this setting; a model picked for the epic overrides both. |
| `lexCode.factory.defaultWorkers` | `1` | Builders preselected when starting a build (max 8). |
| `lexCode.factory.maxReviewAttempts` | `3` | Review failures per story or sprint before the factory asks you to step in. |
| `lexCode.factory.sensitivePaths` | auth, migrations, CI, `package.json`, lockfiles, `.env`, `Dockerfile` | Gitignore-style globs. A sprint that changes a matching file waits for your approval before it merges. |

## Data

The board is stored as `board.json` in the extension's global storage; story attachments live beside it in `attachments/<storyId>/`.

## Develop

```sh
npm run watch   # rebuild on change
npm test        # compile + node:test
```

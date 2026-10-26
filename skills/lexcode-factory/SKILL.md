---
name: lexcode-factory
description: Start a LexCode software-factory epic in the current project from a title and description. Use when the user says "/lexcode-factory <epic>", "lexcode factory …", "run the factory on …", "make a factory epic for …", or asks to hand a feature to the LexCode factory.
---

# LexCode factory

Creates a factory epic in this project and starts planning. Nothing is built until the user approves the plan in VS Code, `lexcode ui` or `lexcode` (the TUI).

Two ways in, both need LexCode 0.0.5 or newer:
- **Editor link** (`vscode://`, `devin://`, …): the extension asks the usual factory questions (builder mode, target branch, models) with the description prefilled, then opens its dashboard.
- **CLI** (`lexcode epic new`): works in any terminal. You ask the questions in chat instead.

## Steps

1. Split the arguments into:
   - **title**: short epic name (first line or first clause, under ~60 chars);
   - **description**: everything else: goal, constraints, acceptance criteria. If the user gave only a title, write a description from the conversation so far and show it to them before going on.

2. Find what's installed:

   ```sh
   EXT=$(ls -td ~/.*/extensions/lex.lex-code-* 2>/dev/null | head -1); echo "ext=$EXT"
   env | grep -qE '^(TERM_PROGRAM=vscode|VSCODE_|DEVIN_)' && echo editor=yes || echo editor=no
   command -v lexcode >/dev/null && echo "cli=lexcode $(lexcode --version)"
   ```

   The extension's version is the end of its folder name (`lex.lex-code-0.0.5` → 0.0.5).

3. Pick one path:
   - **A. Editor link**: `editor=yes` and the extension is 0.0.5 or newer.
   - **B. CLI**: otherwise, when `lexcode --version` is 0.0.5 or newer, or else the extension is 0.0.5 or newer (then the CLI is `node "$EXT/out/cli.js"`).
   - **Neither**: tell the user to install LexCode (`npm install -g github:buffer808/LexCode` for the CLI, or the VS Code extension) and stop. An older version: say which one is installed and that 0.0.5 is needed.

### A. Editor link

Pick the URI scheme from the extension folder: `~/.devin/` → `devin`, `~/.vscode/` → `vscode`, `~/.vscode-insiders/` → `vscode-insiders`, `~/.cursor/` → `cursor`, `~/.vscode-oss/` → `vscodium`. Other folder → ask the user which editor's URL scheme to use.

Open the link from the project root (any subfolder of a tracked project works):

```sh
SCHEME=vscode TITLE='…' DESC='…' python3 -c 'import os, json, base64; print(os.environ["SCHEME"] + "://lex.lex-code/factory?" + base64.urlsafe_b64encode(json.dumps({"path": os.getcwd(), "title": os.environ["TITLE"], "description": os.environ["DESC"]}).encode()).decode().rstrip("="))' | xargs open
```

On Linux use `xdg-open` instead of `open`. Tell the user to finish the prompts in the editor window. If it reports the folder "is not a LexCode project", they add it from the Board (`+`) first.

### B. CLI

1. Ask the user, in one message:
   - **builder mode**: accept edits (default: builders pause for shell approvals) or full auto (builders run unattended). Use full auto only if they say so explicitly.
   - **target branch** for the PR (default `main`).
2. Show the title, description, mode and branch, and go ahead once they agree.
3. Run it from the project root. The input goes as JSON on stdin through a quoted heredoc, so nothing in it is ever parsed by the shell. Build the JSON with correct escaping (`"` → `\"`, newlines → `\n`):

   ```sh
   lexcode epic new --from - --json <<'LEXCODE_EPIC'
   {"title": "…", "description": "…", "builderMode": "acceptEdits", "targetBranch": "main"}
   LEXCODE_EPIC
   ```

   `builderMode` is `"acceptEdits"` or `"auto"`. Use `node "$EXT/out/cli.js"` in place of `lexcode` if that's the CLI you found.
4. Report the result: the epic id and branch from the JSON, and that the plan will wait for approval in VS Code, `lexcode ui` or `lexcode`. Planning carries on in the background after the command exits, but the epic only reaches the plan gate while one of those apps is running.

On exit code 1, pass the message on as printed. For "is not a LexCode project", suggest adding the folder (`lexcode` then `A`, or the Board's `+`). If `error` is set in the JSON, the epic exists but planning didn't start: the user fixes the cause (often Claude's folder trust prompt) and presses Retry on the epic.

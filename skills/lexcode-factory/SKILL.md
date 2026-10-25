---
name: lexcode-factory
description: Start a LexCode software-factory epic in the current project from a title and description. Use when the user says "/lexcode-factory <epic>", "lexcode factory …", "run the factory on …", "make a factory epic for …", or asks to hand a feature to the LexCode factory.
---

# LexCode factory

Opens an editor link (`vscode://`, `devin://`, …) that the LexCode extension (0.0.5+) handles: it creates the epic in this project and walks the user through the usual factory prompts (builder mode, target branch, models) with the description prefilled, then opens the LexCode dashboard. Nothing runs until the user confirms those prompts and approves the plan.

## Steps

1. Split the arguments into:
   - **title**: short epic name (first line or first clause, under ~60 chars);
   - **description**: everything else: goal, constraints, acceptance criteria. If the user gave only a title, write a description from the conversation so far and show it to them before going on.

2. Pick the URI scheme from the editor the extension is installed in:

   ```sh
   ls -td ~/.*/extensions/lex.lex-code-* 2>/dev/null | head -1
   ```

   `~/.devin/` → `devin`, `~/.vscode/` → `vscode`, `~/.vscode-insiders/` → `vscode-insiders`, `~/.cursor/` → `cursor`, `~/.vscode-oss/` → `vscodium`. Empty → tell the user the LexCode extension isn't installed, stop. Other folder → ask the user which editor's URL scheme to use.

3. Open the link, from the project root (any subfolder of a tracked project works):

   ```sh
   SCHEME=vscode TITLE='…' DESC='…' python3 -c 'import os, json, base64; print(os.environ["SCHEME"] + "://lex.lex-code/factory?" + base64.urlsafe_b64encode(json.dumps({"path": os.getcwd(), "title": os.environ["TITLE"], "description": os.environ["DESC"]}).encode()).decode().rstrip("="))' | xargs open
   ```

   On Linux use `xdg-open` instead of `open`.

4. Tell the user to finish the prompts in the editor window. If it reports the folder "is not a LexCode project", they add it from the Board (`+`) first.

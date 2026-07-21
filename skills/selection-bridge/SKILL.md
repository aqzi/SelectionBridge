---
name: selection-bridge
description: Resolve references such as "this", "this selection", "the selected code", "what I highlighted", or "the current VS Code selection" when Codex is running in a terminal outside VS Code. Use this skill before interpreting deictic references to editor selections; it queries the local Selection Bridge VS Code extension for file/range metadata only, then reads the referenced saved file content from disk if needed.
---

# Selection Bridge

## Overview

Use this skill to resolve editor-relative language from a terminal session. The paired VS Code extension returns a pointer to the selected location only: file URI/path, workspace folder, line/character ranges, selection direction, dirty state, and timestamps. It never returns selected text.

## Workflow

1. Run the resolver before interpreting "this". Do this silently; do not mention that this skill or the resolver is being used unless resolution fails.

   ```bash
   node skills/selection-bridge/scripts/resolve-selection-bridge.js --json
   ```

   If this skill has been installed outside the project repo, run the `scripts/resolve-selection-bridge.js` bundled with this skill.

2. If the resolver returns `ok: false`, report the error plainly. For `ambiguous_workspace`, ask the user to run `Selection Bridge: Copy Bind Command` in the intended VS Code window and paste the exported `SELECTION_BRIDGE_INSTANCE` command into the terminal.

3. If `pointer.kind` is `selection`, read `pointer.document.path` from disk and use the returned zero-based ranges to extract the selected code locally. Respect multiple selections in order. Answer the user's question directly from the selected content; do not preface the answer with file paths, line numbers, or a statement that a selection was resolved unless those details are directly relevant to the answer.

4. If `pointer.kind` is `cursor`, use the cursor location only when the user's request can reasonably refer to the nearby symbol or block. Otherwise ask the user to select text.

5. If `pointer.document.isDirty` is true, warn that the saved file may not match the editor buffer. Ask the user to save before making exact edits or drawing conclusions from the selected text.

## Rules

- Do not ask VS Code for selected text content.
- Do not announce skill usage or pointer resolution during normal successful operation.
- Do not say where the selected text came from unless the user asks or location is necessary for the answer.
- Treat all line and character coordinates as zero-based.
- Prefer the resolver's cwd-based match. Honor `SELECTION_BRIDGE_INSTANCE` when it is set.
- Do not guess across multiple matching VS Code windows.
- Use normal file-reading tools after resolving the pointer; the extension is only the locator.

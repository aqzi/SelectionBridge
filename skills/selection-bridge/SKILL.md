---
name: selection-bridge
description: Resolve references such as "this", "this selection", "the selected code", "what I highlighted", or "the current VS Code selection" when Codex is running in a terminal beside a local or remote VS Code workspace. Use this skill before interpreting deictic references to editor selections; it queries the co-located Selection Bridge VS Code extension for file/range metadata only, then reads the referenced saved file content from disk if needed.
---

# Selection Bridge

## Overview

Use this skill to resolve editor-relative language from a terminal session. The paired VS Code extension returns a pointer to the selected location only: file URI/path, workspace folder, line/character ranges, selection direction, dirty state, and timestamps. It never returns selected text. For a remote workspace, run the agent and install this skill in the same remote execution environment and user account as the workspace extension. A terminal opened from that remote VS Code window is the reliable default.

## Workflow

1. Run the resolver before interpreting "this". Do this silently; do not mention that this skill or the resolver is being used unless resolution fails.

   ```bash
   node skills/selection-bridge/scripts/resolve-selection-bridge.js --json
   ```

   If this skill has been installed outside the project repo, run the `scripts/resolve-selection-bridge.js` bundled with this skill.

2. If running the resolver is blocked or fails because the execution tool lacks permission, do not show that first failure to the user. Request permission through the tool's permission mechanism, then rerun the exact same resolver command. If the retry succeeds, continue silently. If the user denies permission, say only that permission is required to run Selection Bridge.

3. For any other `ok: false` result, report `error.message` followed by `error.recovery` exactly when recovery is present. Do not add a generic troubleshooting checklist or invent alternative recovery steps. If an approved retry still returns `connection_permission_denied`, report its permission-specific message and recovery exactly.

4. If `pointer.kind` is `selection`, read `pointer.document.path` from disk and use the returned zero-based ranges to extract the selected code locally. Respect multiple selections in order. Answer the user's question directly from the selected content; do not preface the answer with file paths, line numbers, or a statement that a selection was resolved unless those details are directly relevant to the answer.

5. If `pointer.kind` is `cursor`, use the cursor location only when the user's request can reasonably refer to the nearby symbol or block. Otherwise ask the user to select text.

6. Treat pointer and file validation failures as resolver failures; the resolver provides the exact recovery instruction.

## Rules

- Do not ask VS Code for selected text content.
- Do not announce skill usage or pointer resolution during normal successful operation.
- Do not say where the selected text came from unless the user asks or location is necessary for the answer.
- Treat all line and character coordinates as zero-based.
- Prefer the resolver's cwd-based match. Honor `SELECTION_BRIDGE_INSTANCE` when it is set.
- Do not guess across multiple matching VS Code windows.
- Treat `pointer.document.path` and workspace folder paths as paths in the extension host's execution environment. A remote agent in the same environment can read them directly.
- Use normal file-reading tools after resolving the pointer; the extension is only the locator.

# Selection Bridge

Selection Bridge connects your current VS Code selection to terminal-based agents without making you copy and paste its contents into the terminal. Copying content into a prompt makes the agent process that content before it can start working and gives it only the snippet you copied.

With Selection Bridge, you can refer to "this selection" and the agent immediately receives a lightweight pointer to the correct file and range. It can read the saved content directly from your workspace together with the surrounding context it needs. The extension exposes only location metadata, not the selected text itself, and works with a companion agent skill.

## Install the Agent Skill

The VS Code extension provides the selection location, while the companion skill teaches your terminal agent how to retrieve and use it. Start the installer with:

```bash
npx skills add aqzi/SelectionBridge
```

Follow the installer's questions to choose the skill, supported agents, and installation scope. Start a new agent session after installation. The skill is compatible with agents supported by [`npx skills`](https://github.com/vercel-labs/skills).

For a remote workspace, run this installer in that remote environment and install the skill for the remote user. A skill installed only on your local machine is not visible to an agent running remotely.

## Use Selection Bridge

Select code in a saved file in VS Code, then ask your terminal agent about "this selection", "the selected code", or another equivalent reference. The skill resolves the pointer, reads the selected range from disk, and can inspect the surrounding file when more context is useful.

Selection Bridge intentionally does not transmit the selected text. Save the file first when you want the agent to see recent edits. The pointer reports when the active document contains unsaved changes.

The extension provides these commands through the Command Palette:

- `Selection Bridge: Show Current Pointer` shows the current pointer metadata.
- `Selection Bridge: Copy Bind Command` copies an instance binding for ambiguous multi-window setups.
- `Selection Bridge: Reset Instance Id` creates and copies a new instance binding.

## Development

```bash
npm install
npm run compile
npm test
```

Run the extension from VS Code with the Extension Development Host, or launch it manually:

```bash
code --extensionDevelopmentPath="$(pwd)"
```

For local use, symlink the extension and skill into their standard user locations:

```bash
npm run install:local
```

Then reload VS Code.

With the extension running, resolve the current selection from a terminal in the same workspace:

```bash
node skills/selection-bridge/scripts/resolve-selection-bridge.js
```

For ambiguous multi-window setups, run `Selection Bridge: Copy Bind Command` in the target VS Code window and paste the copied `export SELECTION_BRIDGE_INSTANCE=...` command into the agent terminal.

## Remote Workspaces

Selection Bridge runs as a workspace extension. In a remote VS Code window, the extension server, registry, workspace paths, and terminal agent therefore run on the remote side together. No tunnel or path mapping is needed.

For remote selection resolution, all of these must be true:

- Selection Bridge appears as installed and enabled on the remote side of the target VS Code window.
- The skill is installed for the same remote user that runs the terminal agent.
- The agent runs in the same remote execution environment and user account as the extension, with its current directory inside the opened workspace. Starting it from that window's terminal guarantees this in the usual setup.
- The selected file is saved.

The resolver reports one failure and one targeted recovery. Common remote failures are:

| Failure | Exact fix |
| --- | --- |
| The agent treats “this selection” as ordinary text and no Selection Bridge failure appears | In the remote VS Code terminal, run `npx skills add aqzi/SelectionBridge`, install it for that remote user, restart the agent session, and invoke `$selection-bridge` once if implicit activation is still missing. |
| `remote_extension_not_running` | In the target remote VS Code window, install Selection Bridge on the remote side, run `Developer: Reload Window`, and start a new agent session from that window's terminal. |
| `remote_extension_wrong_host` or `remote_document_path_unavailable` | Update the remote copy of Selection Bridge, confirm it is listed under the remote host rather than only locally, and reload the window. |
| `no_matching_workspace` | Run the exact `cd` command returned by the resolver, or open the terminal's current directory as the VS Code workspace. |
| `remote_file_not_visible` | Run the returned `test -f ...` command in a new terminal from the target remote window. Start the agent there if it succeeds; restore or save the file if it fails. |
| `connection_refused_after_retry` or `connection_timeout_after_retry` | Reload the target VS Code window. If it persists, start the agent in a new terminal from that remote window so it shares the extension host's loopback network. |

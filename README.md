# Selection Bridge

Selection Bridge is a local VS Code extension and Codex skill bridge for terminal-based agents. It exposes where text is selected in VS Code, not the selected text itself.

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

For day-to-day local use, symlink both the extension and skill into the standard user locations:

```bash
npm run install:local
```

Then reload VS Code.

With the extension running, resolve the current selection from a terminal in the same workspace:

```bash
node skills/selection-bridge/scripts/resolve-selection-bridge.js
```

For ambiguous multi-window setups, run `Selection Bridge: Copy Bind Command` in the target VS Code window and paste the copied `export SELECTION_BRIDGE_INSTANCE=...` command into the Ghostty terminal.

## Chat Terminal Button

Selection Bridge adds `Selection Bridge: Open Chat Terminal` to the editor title toolbar. By default it launches Ghostty for the current workspace folder and exports `SELECTION_BRIDGE_INSTANCE` inside the new shell.

Configure startup commands in VS Code settings:

```json
{
  "selectionBridge.chatTerminal.startupCommands": ["codex"]
}
```

Use `["claude"]` instead if that is your preferred agent. Leave the array empty to open a bound shell without starting an agent.

For a terminal-side selector instead of one fixed startup command:

```json
{
  "selectionBridge.chatTerminal.selector.enabled": true,
  "selectionBridge.chatTerminal.selector.models": [
    { "label": "Codex", "command": "codex" },
    { "label": "Claude", "command": "claude" }
  ],
  "selectionBridge.chatTerminal.selector.tmuxDefault": false,
  "selectionBridge.chatTerminal.selector.tmuxSessionName": "codex"
}
```

The selector shows the configured chatbot/model commands plus a built-in `None` option. After that it asks whether to run the selected command inside tmux. When the selector is enabled, `selectionBridge.chatTerminal.startupCommands` are ignored.

The default macOS launcher is equivalent to:

```bash
open -na Ghostty --args --working-directory=<workspace> --command=<startup shell>
```

Override `selectionBridge.chatTerminal.executable` and `selectionBridge.chatTerminal.args` to use another terminal. Argument templates support `${workspaceFolder}`, `${workspaceFolderBasename}`, `${selectionBridgeInstance}`, and `${startupCommand}`.

## Devcontainers

Selection Bridge runs as a local VS Code UI extension, so it can still launch Ghostty from a devcontainer window. It automatically tries to infer the host checkout path from VS Code's devcontainer remote URI. If that cannot be inferred, configure a local mapping so Ghostty/Codex can read the selected file from the host checkout.

Fallback for a single-root devcontainer workspace:

```json
{
  "selectionBridge.devcontainer.localWorkspaceFolder": "/Users/me/src/my-project"
}
```

For multi-root or custom mounts:

```json
{
  "selectionBridge.pathMappings": [
    {
      "remotePrefix": "/workspaces/my-project",
      "localPrefix": "/Users/me/src/my-project"
    }
  ]
}
```

To run Codex inside the devcontainer from the Ghostty button, configure a startup command like:

```json
{
  "selectionBridge.chatTerminal.startupCommands": [
    "bash ./scripts/devcontainer-exec.sh \"$PWD\" zsh -lc \"export SELECTION_BRIDGE_HOST=host.docker.internal SELECTION_BRIDGE_PORT=$SELECTION_BRIDGE_PORT SELECTION_BRIDGE_TOKEN=$SELECTION_BRIDGE_TOKEN SELECTION_BRIDGE_INSTANCE=$SELECTION_BRIDGE_INSTANCE; codex\""
  ]
}
```

To open a selector that can run Codex or Claude inside the devcontainer, optionally inside tmux:

```json
{
  "selectionBridge.chatTerminal.selector.enabled": true,
  "selectionBridge.chatTerminal.selector.tmuxDefault": true,
  "selectionBridge.chatTerminal.selector.tmuxSessionName": "codex",
  "selectionBridge.chatTerminal.selector.noneCommand": "bash ./scripts/devcontainer-exec.sh \"$PWD\" zsh -lc \"export SELECTION_BRIDGE_HOST=host.docker.internal SELECTION_BRIDGE_PORT=$SELECTION_BRIDGE_PORT SELECTION_BRIDGE_TOKEN=$SELECTION_BRIDGE_TOKEN SELECTION_BRIDGE_INSTANCE=$SELECTION_BRIDGE_INSTANCE; exec zsh -i\"",
  "selectionBridge.chatTerminal.selector.models": [
    {
      "label": "Codex",
      "command": "bash ./scripts/devcontainer-exec.sh \"$PWD\" zsh -lc \"export SELECTION_BRIDGE_HOST=host.docker.internal SELECTION_BRIDGE_PORT=$SELECTION_BRIDGE_PORT SELECTION_BRIDGE_TOKEN=$SELECTION_BRIDGE_TOKEN SELECTION_BRIDGE_INSTANCE=$SELECTION_BRIDGE_INSTANCE; codex; exec zsh -i\""
    },
    {
      "label": "Claude",
      "command": "bash ./scripts/devcontainer-exec.sh \"$PWD\" zsh -lc \"export SELECTION_BRIDGE_HOST=host.docker.internal SELECTION_BRIDGE_PORT=$SELECTION_BRIDGE_PORT SELECTION_BRIDGE_TOKEN=$SELECTION_BRIDGE_TOKEN SELECTION_BRIDGE_INSTANCE=$SELECTION_BRIDGE_INSTANCE; claude; exec zsh -i\""
    }
  ]
}
```

When tmux is selected, Selection Bridge uses the configured session name. If that session already exists and a chatbot/model was selected, it opens a new tmux window for the selected command and then attaches to the session. If `None` was selected, it just attaches to the existing session or opens a new shell session.

When Codex runs inside the container, the resolver uses `SELECTION_BRIDGE_HOST`, `SELECTION_BRIDGE_PORT`, and `SELECTION_BRIDGE_TOKEN` instead of the host registry file. On Docker Desktop for macOS, `host.docker.internal` reaches the VS Code-side bridge.

`scripts/devcontainer-exec.sh` uses a global `devcontainer` command when available. If it is not installed, it falls back to the Dev Containers CLI bundled inside the VS Code Dev Containers extension.
# SelectionBridge

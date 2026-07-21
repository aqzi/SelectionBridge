import * as path from 'node:path';

export interface ChatTerminalConfig {
  executable?: string;
  args?: readonly string[];
  startupCommands?: readonly string[];
  selector?: ChatTerminalSelectorConfig;
  shell?: string;
  keepOpen?: boolean;
  extraEnv?: Record<string, string>;
}

export interface ChatTerminalSelectorConfig {
  enabled?: boolean;
  models?: readonly ChatTerminalModelOption[];
  noneLabel?: string;
  noneCommand?: string;
  tmuxDefault?: boolean;
  tmuxSessionName?: string;
}

export interface ChatTerminalModelOption {
  label: string;
  command: string;
}

export interface BuildChatTerminalLaunchOptions {
  config: ChatTerminalConfig;
  workspaceFolder: string;
  workspaceName?: string;
  instanceId: string;
  port: number;
  token: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

export interface ChatTerminalLaunch {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  startupCommand: string;
}

interface PlaceholderValues {
  workspaceFolder: string;
  workspaceFolderBasename: string;
  selectionBridgeInstance: string;
  selectionBridgeHost: string;
  selectionBridgeContainerHost: string;
  selectionBridgePort: string;
  selectionBridgeToken: string;
  startupCommand: string;
}

const PLACEHOLDER_PATTERN = /\$\{([A-Za-z0-9_]+)\}/g;

export function buildChatTerminalLaunch(options: BuildChatTerminalLaunchOptions): ChatTerminalLaunch {
  const shell = options.config.shell?.trim() || options.env.SHELL || defaultShell(options.platform);
  const startupCommand = buildStartupCommand({
    shell,
    instanceId: options.instanceId,
    port: options.port,
    token: options.token,
    startupCommands: options.config.startupCommands || [],
    selector: options.config.selector,
    keepOpen: options.config.keepOpen ?? true
  });
  const placeholders: PlaceholderValues = {
    workspaceFolder: options.workspaceFolder,
    workspaceFolderBasename: options.workspaceName || path.basename(options.workspaceFolder),
    selectionBridgeInstance: options.instanceId,
    selectionBridgeHost: '127.0.0.1',
    selectionBridgeContainerHost: 'host.docker.internal',
    selectionBridgePort: String(options.port),
    selectionBridgeToken: options.token,
    startupCommand
  };
  const executable =
    options.config.executable?.trim() || defaultExecutable(options.platform);
  const args =
    options.config.args && options.config.args.length > 0
      ? options.config.args.map((arg) => interpolate(arg, placeholders))
      : defaultArgs(options.platform, placeholders);

  return {
    executable: interpolate(executable, placeholders),
    args,
    cwd: options.workspaceFolder,
    env: {
      SELECTION_BRIDGE_INSTANCE: options.instanceId,
      SELECTION_BRIDGE_HOST: '127.0.0.1',
      SELECTION_BRIDGE_CONTAINER_HOST: 'host.docker.internal',
      SELECTION_BRIDGE_PORT: String(options.port),
      SELECTION_BRIDGE_TOKEN: options.token,
      ...(options.config.extraEnv || {})
    },
    startupCommand
  };
}

export function buildStartupCommand(options: {
  shell: string;
  instanceId: string;
  port: number;
  token: string;
  startupCommands: readonly string[];
  selector?: ChatTerminalSelectorConfig;
  keepOpen: boolean;
}): string {
  const scriptLines = [
    ...devcontainerFunctionLines(),
    `export SELECTION_BRIDGE_INSTANCE=${shellQuote(options.instanceId)}`,
    `export SELECTION_BRIDGE_HOST=${shellQuote('127.0.0.1')}`,
    `export SELECTION_BRIDGE_CONTAINER_HOST=${shellQuote('host.docker.internal')}`,
    `export SELECTION_BRIDGE_PORT=${shellQuote(String(options.port))}`,
    `export SELECTION_BRIDGE_TOKEN=${shellQuote(options.token)}`,
    ...(options.selector?.enabled
      ? selectorScriptLines(options.selector)
      : options.startupCommands)
  ];

  if (options.keepOpen) {
    scriptLines.push(`exec ${shellQuote(options.shell)} -i`);
  }

  return `${shellQuote(options.shell)} -lc ${shellQuote(scriptLines.join('\n'))}`;
}

function selectorScriptLines(selector: ChatTerminalSelectorConfig): string[] {
  const models = normalizeModelOptions(selector.models || defaultModelOptions());
  const noneLabel = normalizeMenuLabel(selector.noneLabel || 'None');
  const noneCommand = selector.noneCommand?.trim() || '';
  const tmuxSessionName = selector.tmuxSessionName?.trim() || 'codex';
  const tmuxDefault = selector.tmuxDefault ?? false;
  const prompt = tmuxDefault ? 'Use tmux? [Y/n]: ' : 'Use tmux? [y/N]: ';
  const tmuxChoiceLines = tmuxDefault
    ? [
        '    n|N|no|NO|No) selection_bridge_use_tmux=0 ;;',
        '    *) selection_bridge_use_tmux=1 ;;'
      ]
    : [
        '    y|Y|yes|YES|Yes) selection_bridge_use_tmux=1 ;;',
        '    *) selection_bridge_use_tmux=0 ;;'
      ];

  return [
    'selection_bridge_select_chatbot() {',
    '  local selection_bridge_choice',
    '  local selection_bridge_command',
    '  while :; do',
    "    printf '\\nSelection Bridge\\n'",
    "    printf 'Choose chatbot/model:\\n'",
    ...models.map((model, index) => {
      return `    printf '  ${index + 1}) %s\\n' ${shellQuote(model.label)}`;
    }),
    `    printf '  0) %s\\n' ${shellQuote(noneLabel)}`,
    "    printf 'Choice: '",
    '    IFS= read -r selection_bridge_choice',
    '    case "$selection_bridge_choice" in',
    ...models.map((model, index) => {
      return `      ${index + 1}) selection_bridge_command=${shellQuote(model.command)}; break ;;`;
    }),
    `      0|"") selection_bridge_command=${shellQuote(noneCommand)}; break ;;`,
    "      *) printf 'Invalid selection.\\n' ;;",
    '    esac',
    '  done',
    '  local selection_bridge_use_tmux',
    `  printf ${shellQuote(prompt)}`,
    '  IFS= read -r selection_bridge_use_tmux',
    '  case "$selection_bridge_use_tmux" in',
    ...tmuxChoiceLines,
    '  esac',
    '  if [ "$selection_bridge_use_tmux" = "1" ]; then',
    '    if ! command -v tmux >/dev/null 2>&1; then',
    "      printf 'tmux is not installed; running without tmux.\\n' >&2",
    '      if [ -n "$selection_bridge_command" ]; then',
    '        eval "$selection_bridge_command"',
    '      fi',
    '      return $?',
    '    fi',
    `    local selection_bridge_tmux_session=${shellQuote(tmuxSessionName)}`,
    '    if tmux has-session -t "$selection_bridge_tmux_session" 2>/dev/null; then',
    '      if [ -n "$selection_bridge_command" ]; then',
    '        tmux new-window -t "$selection_bridge_tmux_session" "$selection_bridge_command; exec \\"${SHELL:-/bin/sh}\\" -i"',
    '      fi',
    '      exec tmux attach-session -t "$selection_bridge_tmux_session"',
    '    fi',
    '    if [ -n "$selection_bridge_command" ]; then',
    '      exec tmux new-session -s "$selection_bridge_tmux_session" "$selection_bridge_command; exec \\"${SHELL:-/bin/sh}\\" -i"',
    '    fi',
    '    exec tmux new-session -s "$selection_bridge_tmux_session"',
    '  fi',
    '  if [ -n "$selection_bridge_command" ]; then',
    '    eval "$selection_bridge_command"',
    '  fi',
    '}',
    'selection_bridge_select_chatbot'
  ];
}

function defaultModelOptions(): ChatTerminalModelOption[] {
  return [
    { label: 'Codex', command: 'codex' },
    { label: 'Claude', command: 'claude' }
  ];
}

function normalizeModelOptions(models: readonly ChatTerminalModelOption[]): ChatTerminalModelOption[] {
  const normalized = models
    .map((model) => ({
      label: normalizeMenuLabel(model.label),
      command: typeof model.command === 'string' ? model.command.trim() : ''
    }))
    .filter((model) => model.label && model.command);

  return normalized.length > 0 ? normalized : defaultModelOptions();
}

function normalizeMenuLabel(label: string): string {
  return String(label || '').replace(/\s+/g, ' ').trim();
}

function devcontainerFunctionLines(): string[] {
  return [
    'devcontainer() {',
    '  if command -v devcontainer >/dev/null 2>&1; then',
    '    command devcontainer "$@"',
    '    return $?',
    '  fi',
    '  local cli',
    '  cli="$(find "$HOME/.vscode/extensions" "$HOME/.vscode-insiders/extensions" "$HOME/.cursor/extensions" -path \'*/ms-vscode-remote.remote-containers-*/dist/spec-node/devContainersSpecCLI.js\' -print 2>/dev/null | sort | tail -n 1)"',
    '  if [ -n "$cli" ]; then',
    '    node "$cli" "$@"',
    '    return $?',
    '  fi',
    '  echo "devcontainer command not found. Install @devcontainers/cli or the VS Code Dev Containers extension." >&2',
    '  return 127',
    '}'
  ];
}

export function interpolate(template: string, values: PlaceholderValues): string {
  return template.replace(PLACEHOLDER_PATTERN, (match, key: keyof PlaceholderValues) => {
    return key in values ? values[key] : match;
  });
}

function defaultExecutable(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'open' : 'ghostty';
}

function defaultArgs(platform: NodeJS.Platform, values: PlaceholderValues): string[] {
  const ghosttyArgs = [
    `--working-directory=${values.workspaceFolder}`,
    `--title=Selection Bridge: ${values.workspaceFolderBasename}`,
    `--command=${values.startupCommand}`
  ];

  return platform === 'darwin' ? ['-na', 'Ghostty', '--args', ...ghosttyArgs] : ghosttyArgs;
}

function defaultShell(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return 'pwsh';
  }

  return '/bin/zsh';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

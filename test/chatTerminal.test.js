'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildChatTerminalLaunch,
  buildStartupCommand,
  interpolate
} = require('../out/chatTerminal.js');

test('builds the default macOS Ghostty launch command', () => {
  const launch = buildChatTerminalLaunch({
    config: {
      startupCommands: ['codex'],
      shell: '/bin/zsh'
    },
    workspaceFolder: '/Users/me/project',
    workspaceName: 'project',
    instanceId: 'abc-123',
    port: 4321,
    token: 'secret-token',
    platform: 'darwin',
    env: {}
  });

  assert.equal(launch.executable, 'open');
  assert.deepEqual(launch.args.slice(0, 3), ['-na', 'Ghostty', '--args']);
  assert.ok(launch.args.includes('--window-save-state=never'));
  assert.ok(launch.args.includes('--working-directory=/Users/me/project'));
  assert.ok(launch.args.includes('--title=Selection Bridge: project'));
  assert.match(launch.args.find((arg) => arg.startsWith('--command=')), /codex/);
  assert.match(launch.startupCommand, /SELECTION_BRIDGE_INSTANCE/);
  assert.match(launch.startupCommand, /devcontainer\(\)/);
  assert.match(launch.startupCommand, /abc-123/);
  assert.equal(launch.env.SELECTION_BRIDGE_PORT, '4321');
  assert.equal(launch.env.SELECTION_BRIDGE_TOKEN, 'secret-token');
  assert.equal(launch.env.SELECTION_BRIDGE_CONTAINER_HOST, 'host.docker.internal');
});

test('builds the default non-macOS Ghostty launch command', () => {
  const launch = buildChatTerminalLaunch({
    config: {
      startupCommands: [],
      shell: '/bin/bash'
    },
    workspaceFolder: '/work/app',
    workspaceName: 'app',
    instanceId: 'instance-id',
    port: 4321,
    token: 'secret-token',
    platform: 'linux',
    env: {}
  });

  assert.equal(launch.executable, 'ghostty');
  assert.deepEqual(launch.args.slice(0, 2), [
    '--working-directory=/work/app',
    '--title=Selection Bridge: app'
  ]);
  assert.match(launch.args[2], /^--command=/);
  assert.match(launch.args[2], /exec '\\''\/bin\/bash'\\'' -i/);
});

test('supports custom executable and argument templates', () => {
  const launch = buildChatTerminalLaunch({
    config: {
      executable: '/usr/local/bin/custom-terminal',
      args: ['--cwd', '${workspaceFolder}', '--run', '${startupCommand}', '--id', '${selectionBridgeInstance}'],
      startupCommands: ['claude'],
      shell: '/bin/zsh'
    },
    workspaceFolder: '/tmp/workspace',
    workspaceName: 'workspace',
    instanceId: 'custom-id',
    port: 5555,
    token: 'custom-token',
    platform: 'darwin',
    env: {}
  });

  assert.equal(launch.executable, '/usr/local/bin/custom-terminal');
  assert.equal(launch.args[1], '/tmp/workspace');
  assert.equal(launch.args[5], 'custom-id');
  assert.match(launch.args[3], /claude/);
});

test('quotes startup commands safely', () => {
  const command = buildStartupCommand({
    shell: '/bin/zsh',
    instanceId: "id'withquote",
    port: 4321,
    token: "token'withquote",
    startupCommands: ["echo 'hello'"],
    keepOpen: false
  });

  assert.match(command, /^'\/bin\/zsh' -lc /);
  assert.match(command, /SELECTION_BRIDGE_INSTANCE/);
  assert.match(command, /withquote/);
  assert.match(command, /SELECTION_BRIDGE_PORT/);
  assert.match(command, /SELECTION_BRIDGE_TOKEN/);
  assert.match(command, /Dev Containers extension/);
  assert.match(command, /echo/);
  assert.match(command, /hello/);
});

test('runs the configured startup commands directly and in order', () => {
  const command = buildStartupCommand({
    shell: '/bin/zsh',
    instanceId: 'instance-id',
    port: 4321,
    token: 'secret-token',
    startupCommands: ['echo first', 'echo second'],
    keepOpen: false
  });

  assert.ok(command.indexOf('echo first') < command.indexOf('echo second'));
  assert.doesNotMatch(command, /Choose chatbot\/model/);
  assert.doesNotMatch(command, /tmux/);
});

test('leaves unknown placeholders unchanged', () => {
  const value = interpolate('${workspaceFolder}:${unknown}', {
    workspaceFolder: '/work',
    workspaceFolderBasename: 'work',
    selectionBridgeInstance: 'id',
    selectionBridgeHost: '127.0.0.1',
    selectionBridgeContainerHost: 'host.docker.internal',
    selectionBridgePort: '4321',
    selectionBridgeToken: 'token',
    startupCommand: 'cmd'
  });

  assert.equal(value, '/work:${unknown}');
});

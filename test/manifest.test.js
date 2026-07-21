'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const manifest = require('../package.json');
const devcontainer = require('../.devcontainer/devcontainer.json');

test('shows the chat terminal toolbar button by default', () => {
  const setting =
    manifest.contributes.configuration.properties[
      'selectionBridge.chatTerminal.button.enabled'
    ];
  const menu = manifest.contributes.menus['editor/title'].find(
    (item) => item.command === 'selectionBridge.openChatTerminal'
  );

  assert.equal(setting.type, 'boolean');
  assert.equal(setting.default, true);
  assert.equal(menu.when, 'config.selectionBridge.chatTerminal.button.enabled');
});

test('uses direct startup commands in the devcontainer without a selector', () => {
  const settings = devcontainer.customizations.vscode.settings;
  const selectorSettings = Object.keys(settings).filter((key) =>
    key.startsWith('selectionBridge.chatTerminal.selector')
  );
  const startupCommands = settings['selectionBridge.chatTerminal.startupCommands'];

  assert.deepEqual(selectorSettings, []);
  assert.equal(startupCommands.length, 1);
  assert.match(startupCommands[0], /tmux new-session -A/);
  assert.doesNotMatch(startupCommands[0], /-s codex/);
  assert.match(startupCommands[0], /devcontainer-exec\.sh/);
  assert.match(startupCommands[0], /codex/);
});

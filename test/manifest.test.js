'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const manifest = require('../package.json');

test('contributes only the public Selection Bridge commands', () => {
  assert.deepEqual(
    manifest.contributes.commands.map((item) => item.command),
    [
      'selectionBridge.showCurrentPointer',
      'selectionBridge.copyBindCommand',
      'selectionBridge.resetInstanceId'
    ]
  );
  assert.equal(manifest.contributes.menus, undefined);
});

test('does not contribute configuration settings', () => {
  assert.equal(manifest.contributes.configuration, undefined);
});

test('does not publish private workflow files', () => {
  assert.equal(manifest.private, false);
  assert.equal(manifest.files.includes('private'), false);
  assert.equal(manifest.files.includes('scripts'), false);
  assert.equal(manifest.files.includes('out'), false);
});

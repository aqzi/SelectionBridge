'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  isPathInside,
  loadInstances,
  parseArgs,
  resolvePointer,
  sanitizeInstance,
  selectInstance
} = require('../skills/selection-bridge/scripts/resolve-selection-bridge.js');

test('matches a cwd inside a workspace folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-bridge-'));
  const project = path.join(root, 'project');
  const source = path.join(project, 'src');
  fs.mkdirSync(source, { recursive: true });

  assert.equal(isPathInside(project, source), true);
  assert.equal(isPathInside(source, project), false);
});

test('selects the instance whose workspace contains cwd', () => {
  const cwd = '/work/app/src';
  const result = selectInstance(
    [
      instance('one', ['/work/other']),
      instance('two', ['/work/app'])
    ],
    { cwd }
  );

  assert.equal(result.ok, true);
  assert.equal(result.instance.id, 'two');
  assert.equal(result.selectedBy, 'cwd');
});

test('returns ambiguity when multiple instances match cwd', () => {
  const result = selectInstance(
    [
      instance('one', ['/work/app']),
      instance('two', ['/work/app'])
    ],
    { cwd: '/work/app/src' }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ambiguous_workspace');
});

test('explicit instance id overrides cwd matching', () => {
  const result = selectInstance(
    [
      instance('one', ['/work/app']),
      instance('two', ['/work/other'])
    ],
    {
      cwd: '/work/app/src',
      instanceId: 'two'
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.instance.id, 'two');
  assert.equal(result.selectedBy, 'instance');
});

test('loadInstances filters stale entries and malformed JSON', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-bridge-home-'));
  const instancesDir = path.join(home, 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });

  fs.writeFileSync(
    path.join(instancesDir, 'fresh.json'),
    JSON.stringify({
      ...instance('fresh', ['/work/app']),
      updatedAt: '2026-07-20T10:00:00.000Z'
    })
  );
  fs.writeFileSync(
    path.join(instancesDir, 'stale.json'),
    JSON.stringify({
      ...instance('stale', ['/work/app']),
      updatedAt: '2026-07-20T09:00:00.000Z'
    })
  );
  fs.writeFileSync(path.join(instancesDir, 'broken.json'), '{not json');

  const loaded = loadInstances({
    home,
    now: Date.parse('2026-07-20T10:00:10.000Z'),
    staleMs: 30_000
  });

  assert.deepEqual(
    loaded.map((entry) => entry.id),
    ['fresh']
  );
});

test('sanitizeInstance removes token and registry file', () => {
  const safe = sanitizeInstance({
    ...instance('one', ['/work/app']),
    token: 'secret',
    registryFile: '/tmp/one.json'
  });

  assert.equal('token' in safe, false);
  assert.equal('registryFile' in safe, false);
});

test('parseArgs reports missing values as invalid arguments', () => {
  const result = parseArgs(['resolve', '--cwd']);

  assert.equal(result.ok, false);
  assert.equal(result.payload.error.code, 'invalid_argument');
  assert.match(result.payload.error.message, /--cwd requires a value/);
});

test('resolvePointer queries the selected instance and returns pointer metadata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-bridge-home-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(root, 'instances'), { recursive: true });
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });

  const pointer = {
    kind: 'selection',
    capturedAt: '2026-07-20T10:00:00.000Z',
    document: { path: path.join(project, 'src', 'file.ts'), isDirty: false },
    selections: []
  };

  fs.writeFileSync(
    path.join(root, 'instances', 'one.json'),
    JSON.stringify({
      ...instance('one', [project]),
      port: 9876,
      updatedAt: '2026-07-20T10:00:00.000Z'
    })
  );

  const result = await resolvePointer({
    home: root,
    cwd: path.join(project, 'src'),
    now: Date.parse('2026-07-20T10:00:01.000Z'),
    requestPointer: async (selectedInstance, options) => {
      assert.equal(selectedInstance.id, 'one');
      assert.equal(selectedInstance.token, 'token');
      assert.deepEqual(options, { timeoutMs: undefined });
      return { ok: true, pointer };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.selectedBy, 'cwd');
  assert.equal(result.instance.id, 'one');
  assert.equal('token' in result.instance, false);
  assert.deepEqual(result.pointer, pointer);
});

function instance(id, workspacePaths) {
  return {
    schemaVersion: 1,
    id,
    port: 1234,
    token: 'token',
    pid: 100,
    workspaceName: id,
    workspaceFolders: workspacePaths.map((workspacePath, index) => ({
      name: path.basename(workspacePath),
      uri: `file://${workspacePath}`,
      path: workspacePath,
      index
    })),
    lastPointerKind: 'selection',
    lastSelectionCapturedAt: '2026-07-20T10:00:00.000Z',
    createdAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-07-20T10:00:00.000Z'
  };
}

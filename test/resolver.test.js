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
  const { project } = createProject();
  const source = path.join(project, 'src');

  assert.equal(isPathInside(project, source), true);
  assert.equal(isPathInside(source, project), false);
});

test('reports exactly how to activate the extension when no live instance exists', () => {
  const result = selectInstance([], { cwd: '/work/app' });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'extension_not_running');
  assert.match(result.error.recovery, /Show Current Pointer/);
  assert.match(result.error.recovery, /install or enable/);
});

test('selects the instance whose workspace contains cwd', () => {
  const result = selectInstance(
    [instance('one', ['/work/other']), instance('two', ['/work/app'])],
    { cwd: '/work/app/src' }
  );

  assert.equal(result.ok, true);
  assert.equal(result.instance.id, 'two');
  assert.equal(result.selectedBy, 'cwd');
});

test('reports the terminal and available workspace when cwd does not match', () => {
  const result = selectInstance([instance('one', ['/work/other'])], {
    cwd: '/work/app/src'
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'no_matching_workspace');
  assert.match(result.error.message, /\/work\/app\/src/);
  assert.match(result.error.recovery, /cd '\/work\/other'/);
});

test('returns an actionable ambiguity response when multiple instances match cwd', () => {
  const result = selectInstance(
    [instance('one', ['/work/app']), instance('two', ['/work/app'])],
    { cwd: '/work/app/src' }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ambiguous_workspace');
  assert.match(result.error.recovery, /Copy Bind Command/);
});

test('explicit instance id overrides cwd matching', () => {
  const result = selectInstance(
    [instance('one', ['/work/app']), instance('two', ['/work/other'])],
    { cwd: '/work/app/src', instanceId: 'two' }
  );

  assert.equal(result.ok, true);
  assert.equal(result.instance.id, 'two');
  assert.equal(result.selectedBy, 'instance');
});

test('automatically recovers a stale binding when exactly one cwd match exists', () => {
  const result = selectInstance([instance('new', ['/work/app'])], {
    cwd: '/work/app/src',
    env: { SELECTION_BRIDGE_INSTANCE: 'stale' }
  });

  assert.equal(result.ok, true);
  assert.equal(result.instance.id, 'new');
  assert.equal(result.selectedBy, 'cwd_fallback');
  assert.deepEqual(result.recoveredBinding, {
    staleInstanceId: 'stale',
    instanceId: 'new'
  });
});

test('requires a fresh binding when a stale binding has multiple cwd matches', () => {
  const result = selectInstance(
    [instance('one', ['/work/app']), instance('two', ['/work/app'])],
    {
      cwd: '/work/app/src',
      env: { SELECTION_BRIDGE_INSTANCE: 'stale' }
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ambiguous_workspace_after_stale_binding');
  assert.match(result.error.recovery, /Copy Bind Command/);
});

test('explains how to remove a stale binding when no cwd match exists', () => {
  const result = selectInstance([instance('other', ['/work/other'])], {
    cwd: '/work/app',
    env: { SELECTION_BRIDGE_INSTANCE: 'stale' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'stale_binding_no_matching_workspace');
  assert.match(result.error.recovery, /unset SELECTION_BRIDGE_INSTANCE/);
  assert.match(result.error.recovery, /cd '\/work\/other'/);
});

test('reports unsupported remote workspaces specifically', () => {
  const result = selectInstance([remoteInstance('remote')], { cwd: '/workspaces/app' });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unsupported_remote_workspace');
  assert.match(result.error.recovery, /host checkout locally/);
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

  assert.deepEqual(loaded.map((entry) => entry.id), ['fresh']);
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

test('resolvePointer queries the selected instance and returns readable pointer metadata', async () => {
  const { project, file } = createProject();
  const pointer = selectedPointer(file);

  const result = await resolvePointer({
    cwd: path.join(project, 'src'),
    loadInstances: () => [instance('one', [project])],
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

test('automatically reloads the registry and retries an authentication race', async () => {
  const { project, file } = createProject();
  const oldInstance = instance('old', [project]);
  const newInstance = { ...instance('new', [project]), token: 'new-token' };
  let loadCount = 0;
  let requestCount = 0;

  const result = await resolvePointer({
    cwd: project,
    env: { SELECTION_BRIDGE_INSTANCE: 'old' },
    loadInstances: () => (loadCount++ === 0 ? [oldInstance] : [newInstance]),
    requestPointer: async (selectedInstance) => {
      requestCount += 1;
      if (requestCount === 1) {
        throw requestError('authentication_failed', 'Old token');
      }
      assert.equal(selectedInstance.id, 'new');
      assert.equal(selectedInstance.token, 'new-token');
      return { ok: true, pointer: selectedPointer(file) };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(requestCount, 2);
  assert.equal(result.selectedBy, 'cwd_fallback');
  assert.equal(result.recoveredBinding.staleInstanceId, 'old');
});

test('reports authentication failure only after the automatic retry also fails', async () => {
  const { project } = createProject();
  let requestCount = 0;

  const result = await resolvePointer({
    cwd: project,
    loadInstances: () => [instance('one', [project])],
    requestPointer: async () => {
      requestCount += 1;
      throw requestError('authentication_failed', 'Bad token');
    }
  });

  assert.equal(requestCount, 2);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'authentication_failed_after_retry');
  assert.match(result.error.recovery, /Reset Instance Id/);
});

test('reports connection refusal only after an automatic retry', async () => {
  const { project } = createProject();
  let requestCount = 0;

  const result = await resolvePointer({
    cwd: project,
    loadInstances: () => [instance('one', [project])],
    requestPointer: async () => {
      requestCount += 1;
      throw requestError('ECONNREFUSED', 'Connection refused');
    }
  });

  assert.equal(requestCount, 2);
  assert.equal(result.error.code, 'connection_refused_after_retry');
  assert.match(result.error.recovery, /Developer: Reload Window/);
});

test('reports timeout only after an automatic retry', async () => {
  const { project } = createProject();
  let requestCount = 0;

  const result = await resolvePointer({
    cwd: project,
    timeoutMs: 250,
    loadInstances: () => [instance('one', [project])],
    requestPointer: async () => {
      requestCount += 1;
      throw requestError('request_timeout', 'Timed out', { timeoutMs: 250 });
    }
  });

  assert.equal(requestCount, 2);
  assert.equal(result.error.code, 'connection_timeout_after_retry');
  assert.match(result.error.message, /250ms/);
});

test('reports incompatible pointer responses with a matching-version recovery', async () => {
  const { project } = createProject();

  const result = await resolvePointer({
    cwd: project,
    loadInstances: () => [instance('one', [project])],
    requestPointer: async () => ({ ok: true })
  });

  assert.equal(result.error.code, 'protocol_mismatch');
  assert.match(result.error.recovery, /matching versions/);
});

test('reports the exact action when VS Code has no active editor', async () => {
  const { project } = createProject();

  const result = await resolvePointer({
    cwd: project,
    loadInstances: () => [instance('one', [project])],
    requestPointer: async () => ({
      ok: true,
      pointer: { kind: 'none', capturedAt: new Date().toISOString(), selections: [] }
    })
  });

  assert.equal(result.error.code, 'no_active_editor');
  assert.match(result.error.recovery, /Focus the intended saved file/);
});

test('asks the user to save an untitled document before retrying', async () => {
  const { project } = createProject();

  const result = await resolvePointer({
    cwd: project,
    loadInstances: () => [instance('one', [project])],
    requestPointer: async () => ({
      ok: true,
      pointer: {
        kind: 'selection',
        document: {
          uri: 'untitled:Untitled-1',
          scheme: 'untitled',
          isUntitled: true,
          isDirty: true
        },
        selections: []
      }
    })
  });

  assert.equal(result.error.code, 'untitled_document');
  assert.match(result.error.recovery, /Save the document/);
});

test('reports remote selected documents as unsupported', async () => {
  const { project } = createProject();

  const result = await resolvePointer({
    cwd: project,
    loadInstances: () => [instance('one', [project])],
    requestPointer: async () => ({
      ok: true,
      pointer: {
        kind: 'selection',
        document: {
          uri: 'vscode-remote://ssh-remote/workspaces/app/file.ts',
          scheme: 'vscode-remote',
          isDirty: false
        },
        selections: []
      }
    })
  });

  assert.equal(result.error.code, 'unsupported_remote_workspace');
  assert.match(result.error.recovery, /host checkout locally/);
});

test('reports unsaved selected files with an exact save instruction', async () => {
  const { project, file } = createProject();

  const result = await resolvePointer({
    cwd: project,
    loadInstances: () => [instance('one', [project])],
    requestPointer: async () => ({
      ok: true,
      pointer: selectedPointer(file, { isDirty: true })
    })
  });

  assert.equal(result.error.code, 'document_dirty');
  assert.match(result.error.recovery, new RegExp(escapeRegex(file)));
});

test('reports when the selected file no longer exists', async () => {
  const { project } = createProject();
  const missingFile = path.join(project, 'src', 'missing.ts');

  const result = await resolvePointer({
    cwd: project,
    loadInstances: () => [instance('one', [project])],
    requestPointer: async () => ({ ok: true, pointer: selectedPointer(missingFile) })
  });

  assert.equal(result.error.code, 'selected_file_missing');
  assert.match(result.error.recovery, /Restore or save/);
});

test('reports when the terminal cannot read the selected file', async () => {
  const { project, file } = createProject();
  const denied = Object.assign(new Error('Permission denied'), { code: 'EACCES' });

  const result = await resolvePointer({
    cwd: project,
    loadInstances: () => [instance('one', [project])],
    requestPointer: async () => ({ ok: true, pointer: selectedPointer(file) }),
    fileSystem: {
      constants: fs.constants,
      accessSync: () => {
        throw denied;
      },
      statSync: fs.statSync
    }
  });

  assert.equal(result.error.code, 'selected_file_unreadable');
  assert.match(result.error.recovery, /read access/);
});

function createProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-bridge-'));
  const project = path.join(root, 'project');
  const source = path.join(project, 'src');
  const file = path.join(source, 'file.ts');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(file, 'const selected = true;\n');
  return { root, project, source, file };
}

function selectedPointer(file, documentOverrides = {}) {
  return {
    kind: 'selection',
    capturedAt: '2026-07-20T10:00:00.000Z',
    document: {
      uri: `file://${file}`,
      scheme: 'file',
      path: file,
      isDirty: false,
      ...documentOverrides
    },
    selections: []
  };
}

function requestError(code, message, details = undefined) {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

function remoteInstance(id) {
  return {
    ...instance(id, []),
    workspaceFolders: [
      {
        name: 'app',
        uri: 'vscode-remote://dev-container/workspaces/app',
        index: 0
      }
    ]
  };
}

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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

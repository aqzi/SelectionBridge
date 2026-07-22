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
  const result = selectInstance([], { cwd: '/work/app', env: {} });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'extension_not_running');
  assert.match(result.error.recovery, /Show Current Pointer/);
  assert.match(result.error.recovery, /install or enable/);
});

test('tells a remote terminal to install the extension in the remote window', () => {
  const result = selectInstance([], {
    cwd: '/work/app',
    env: { SSH_CONNECTION: 'client server', HOME: '/home/agent', USER: 'agent' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'remote_extension_not_running');
  assert.match(result.error.recovery, /button beginning with "Install in"/);
  assert.match(result.error.recovery, /terminal opened from that same VS Code window/);
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

test('reports a remote extension that is old or running in the wrong host', () => {
  const result = selectInstance([remoteInstance('remote')], { cwd: '/workspaces/app' });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'remote_extension_wrong_host');
  assert.match(result.error.recovery, /installed on the remote side/);
});

test('matches a remote workspace using its execution-local path', () => {
  const result = selectInstance(
    [remoteInstance('remote', '/workspaces/app')],
    { cwd: '/workspaces/app/src' }
  );

  assert.equal(result.ok, true);
  assert.equal(result.instance.id, 'remote');
  assert.equal(result.selectedBy, 'cwd');
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

test('sanitizeInstance removes legacy tokens and the registry file path', () => {
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

test('resolvePointer returns the pointer embedded in the selected registry entry', async () => {
  const { project, file } = createProject();
  const pointer = selectedPointer(file);

  const result = await resolvePointer({
    cwd: path.join(project, 'src'),
    loadInstances: () => [instance('one', [project], pointer)]
  });

  assert.equal(result.ok, true);
  assert.equal(result.selectedBy, 'cwd');
  assert.equal(result.instance.id, 'one');
  assert.equal('token' in result.instance, false);
  assert.deepEqual(result.pointer, pointer);
});

test('reports an outdated extension when the registry entry has no pointer', async () => {
  const { project } = createProject();
  const legacy = instance('legacy', [project]);
  delete legacy.pointer;
  legacy.port = 1234;
  legacy.token = 'token';

  const result = await resolvePointer({
    cwd: project,
    loadInstances: () => [legacy]
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'extension_outdated');
  assert.match(result.error.recovery, /Update the Selection Bridge extension/);
  assert.match(result.error.recovery, /Developer: Reload Window/);
  assert.doesNotMatch(JSON.stringify(result), /"token"/);
});

test('reports the exact action when VS Code has no active editor', async () => {
  const { project } = createProject();

  const result = await resolvePointer({
    cwd: project,
    loadInstances: () => [
      instance('one', [project], {
        kind: 'none',
        capturedAt: '2026-07-20T10:00:00.000Z',
        selections: []
      })
    ]
  });

  assert.equal(result.error.code, 'no_active_editor');
  assert.match(result.error.recovery, /Focus the intended saved file/);
});

test('asks the user to save an untitled document before retrying', async () => {
  const { project } = createProject();

  const result = await resolvePointer({
    cwd: project,
    loadInstances: () => [
      instance('one', [project], {
        kind: 'selection',
        document: {
          uri: 'untitled:Untitled-1',
          scheme: 'untitled',
          isUntitled: true,
          isDirty: true
        },
        selections: []
      })
    ]
  });

  assert.equal(result.error.code, 'untitled_document');
  assert.match(result.error.recovery, /Save the document/);
});

test('accepts a readable selected document from a remote workspace', async () => {
  const { project, file } = createProject();

  const result = await resolvePointer({
    cwd: project,
    loadInstances: () => [
      remoteInstance('remote', project, selectedPointer(file, {
        uri: `vscode-remote://ssh-remote${file}`,
        scheme: 'vscode-remote'
      }))
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.pointer.document.path, file);
});

test('reports an outdated remote pointer that has no execution path', async () => {
  const { project } = createProject();

  const result = await resolvePointer({
    cwd: project,
    loadInstances: () => [
      instance('one', [project], {
        kind: 'selection',
        document: {
          uri: 'vscode-remote://ssh-remote/workspaces/app/file.ts',
          scheme: 'vscode-remote',
          isDirty: false
        },
        selections: []
      })
    ]
  });

  assert.equal(result.error.code, 'remote_document_path_unavailable');
  assert.match(result.error.recovery, /installed on the remote side/);
});

test('reports when the selected remote file is not visible to this terminal', async () => {
  const { project } = createProject();
  const missingFile = path.join(project, 'src', 'missing.ts');

  const result = await resolvePointer({
    cwd: project,
    loadInstances: () => [
      remoteInstance('remote', project, selectedPointer(missingFile, {
        uri: `vscode-remote://ssh-remote${missingFile}`,
        scheme: 'vscode-remote'
      }))
    ]
  });

  assert.equal(result.error.code, 'remote_file_not_visible');
  assert.match(result.error.recovery, /test -f/);
  assert.match(result.error.recovery, /different environment/);
});

test('reports unsaved selected files with an exact save instruction', async () => {
  const { project, file } = createProject();

  const result = await resolvePointer({
    cwd: project,
    loadInstances: () => [instance('one', [project], selectedPointer(file, { isDirty: true }))]
  });

  assert.equal(result.error.code, 'document_dirty');
  assert.match(result.error.recovery, new RegExp(escapeRegex(file)));
});

test('reports when the selected file no longer exists', async () => {
  const { project } = createProject();
  const missingFile = path.join(project, 'src', 'missing.ts');

  const result = await resolvePointer({
    cwd: project,
    loadInstances: () => [instance('one', [project], selectedPointer(missingFile))]
  });

  assert.equal(result.error.code, 'selected_file_missing');
  assert.match(result.error.recovery, /Restore or save/);
});

test('reports when the terminal cannot read the selected file', async () => {
  const { project, file } = createProject();
  const denied = Object.assign(new Error('Permission denied'), { code: 'EACCES' });

  const result = await resolvePointer({
    cwd: project,
    loadInstances: () => [instance('one', [project], selectedPointer(file))],
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

function remoteInstance(id, workspacePath = undefined, pointer = undefined) {
  return {
    ...instance(id, [], pointer),
    workspaceFolders: [
      {
        name: 'app',
        uri: `vscode-remote://remote${workspacePath || '/workspaces/app'}`,
        ...(workspacePath ? { path: workspacePath } : {}),
        index: 0
      }
    ],
    execution: {
      hostname: 'remote',
      home: '/home/agent',
      platform: 'linux',
      extensionHostKind: 'workspace',
      vscodeRemoteName: 'remote'
    }
  };
}

function instance(id, workspacePaths, pointer = undefined) {
  return {
    schemaVersion: 2,
    id,
    pid: 100,
    workspaceName: id,
    workspaceFolders: workspacePaths.map((workspacePath, index) => ({
      name: path.basename(workspacePath),
      uri: `file://${workspacePath}`,
      path: workspacePath,
      index
    })),
    pointer: pointer || {
      kind: 'cursor',
      capturedAt: '2026-07-20T10:00:00.000Z',
      selections: []
    },
    createdAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-07-20T10:00:00.000Z'
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildEffectivePathMappings,
  expandLocalPath,
  inferDevcontainerHostPathFromAuthority,
  mapRemotePath,
  normalizeRemotePath
} = require('../out/pathMapping.js');

test('builds a single-workspace devcontainer mapping from localWorkspaceFolder', () => {
  const mappings = buildEffectivePathMappings({
    configuredMappings: [],
    localWorkspaceFolder: '~/src/app',
    remoteWorkspaceFolders: ['/workspaces/app'],
    env: { HOME: '/Users/me' }
  });

  assert.deepEqual(mappings, [
    {
      remotePrefix: '/workspaces/app',
      localPrefix: '/Users/me/src/app',
      source: 'localWorkspaceFolder'
    }
  ]);
});

test('does not guess localWorkspaceFolder for multiple remote workspace folders', () => {
  const mappings = buildEffectivePathMappings({
    configuredMappings: [],
    localWorkspaceFolder: '/Users/me/src/app',
    remoteWorkspaceFolders: ['/workspaces/app', '/workspaces/lib'],
    env: { HOME: '/Users/me' }
  });

  assert.deepEqual(mappings, []);
});

test('maps remote document paths to local paths using the longest prefix', () => {
  const mapped = mapRemotePath('/workspaces/app/packages/web/src/index.ts', [
    { remotePrefix: '/workspaces/app', localPrefix: '/Users/me/app' },
    { remotePrefix: '/workspaces/app/packages/web', localPrefix: '/Users/me/web' }
  ]);

  assert.equal(mapped.localPath, '/Users/me/web/src/index.ts');
  assert.equal(mapped.remotePath, '/workspaces/app/packages/web/src/index.ts');
});

test('normalizes remote paths and expands local environment placeholders', () => {
  assert.equal(normalizeRemotePath('workspaces\\app\\src'), '/workspaces/app/src');
  assert.equal(expandLocalPath('$PROJECTS/app', { PROJECTS: '/Users/me/projects' }), '/Users/me/projects/app');
});

test('infers host path from devcontainer authority JSON payload', () => {
  const payload = JSON.stringify({
    hostPath: '/Users/me/src/app',
    localDocker: true,
    configFile: {
      fsPath: '/Users/me/src/app/.devcontainer/devcontainer.json'
    }
  });
  const authority = `dev-container+${Buffer.from(payload, 'utf8').toString('hex')}`;

  assert.equal(inferDevcontainerHostPathFromAuthority(authority), '/Users/me/src/app');
});

test('infers host path from raw devcontainer authority payload', () => {
  const authority = `dev-container+${Buffer.from('/Users/me/src/app', 'utf8').toString('hex')}`;

  assert.equal(inferDevcontainerHostPathFromAuthority(authority), '/Users/me/src/app');
});

test('uses inferred host path when configured localWorkspaceFolder is the unexpanded placeholder', () => {
  const mappings = buildEffectivePathMappings({
    configuredMappings: [],
    localWorkspaceFolder: '${localWorkspaceFolder}',
    inferredLocalWorkspaceFolder: '/Users/me/src/app',
    remoteWorkspaceFolders: ['/workspaces/app'],
    env: { HOME: '/Users/me' }
  });

  assert.deepEqual(mappings, [
    {
      remotePrefix: '/workspaces/app',
      localPrefix: '/Users/me/src/app',
      source: 'localWorkspaceFolder'
    }
  ]);
});

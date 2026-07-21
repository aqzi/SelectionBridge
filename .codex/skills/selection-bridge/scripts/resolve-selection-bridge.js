#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 1_000;

function getPointerHome(env = process.env) {
  return env.SELECTION_BRIDGE_HOME || env.THIS_POINTER_HOME || path.join(os.homedir(), '.selection-bridge');
}

function getInstancesDir(options = {}) {
  return options.instancesDir || path.join(options.home || getPointerHome(options.env), 'instances');
}

function loadInstances(options = {}) {
  const instancesDir = getInstancesDir(options);
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

  if (!fs.existsSync(instancesDir)) {
    return [];
  }

  return fs
    .readdirSync(instancesDir)
    .filter((fileName) => fileName.endsWith('.json'))
    .flatMap((fileName) => {
      const filePath = path.join(instancesDir, fileName);
      try {
        const entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const updatedAt = Date.parse(entry.updatedAt);
        if (!Number.isFinite(updatedAt) || now - updatedAt > staleMs) {
          return [];
        }

        return [{ ...entry, registryFile: filePath }];
      } catch {
        return [];
      }
    });
}

function selectInstance(instances, options = {}) {
  const directInstance = getDirectInstanceFromEnv(options.env || process.env);
  if (directInstance.ok) {
    return { ok: true, selectedBy: 'env', instance: directInstance.instance };
  }
  if (directInstance.error) {
    return directInstance;
  }

  const explicitInstanceId =
    options.instanceId || options.env?.SELECTION_BRIDGE_INSTANCE || options.env?.THIS_POINTER_INSTANCE;

  if (explicitInstanceId) {
    const exactMatch = instances.find((instance) => instance.id === explicitInstanceId);
    if (!exactMatch) {
      return failure('instance_not_found', `No active Selection Bridge instance matches ${explicitInstanceId}.`, {
        instanceId: explicitInstanceId,
        activeInstances: instances.map(summarizeInstance)
      });
    }

    return { ok: true, selectedBy: 'instance', instance: exactMatch };
  }

  const cwd = normalizePath(options.cwd || process.cwd());
  const matches = instances
    .map((instance) => ({
      instance,
      matchingWorkspaceFolders: (instance.workspaceFolders || []).filter((folder) => {
        return getWorkspaceFolderLocalPaths(folder).some((folderPath) => isPathInside(folderPath, cwd));
      })
    }))
    .filter((match) => match.matchingWorkspaceFolders.length > 0);

  if (matches.length === 0) {
    return failure('no_matching_workspace', 'No active VS Code window has a workspace folder containing this terminal cwd.', {
      cwd,
      activeInstances: instances.map(summarizeInstance)
    });
  }

  if (matches.length > 1) {
    return failure('ambiguous_workspace', 'Multiple VS Code windows match this terminal cwd. Use Selection Bridge: Copy Bind Command in the intended VS Code window.', {
      cwd,
      matches: matches.map((match) => ({
        ...summarizeInstance(match.instance),
        matchingWorkspaceFolders: match.matchingWorkspaceFolders
      }))
    });
  }

  return {
    ok: true,
    selectedBy: 'cwd',
    instance: matches[0].instance
  };
}

function requestPointer(instance, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        ...(instance.host ? { hostname: instance.host } : {}),
        port: instance.port,
        path: '/pointer',
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${instance.token}`,
          accept: 'application/json'
        }
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            reject(new Error(`Selection Bridge server returned non-JSON response with status ${response.statusCode}.`));
            return;
          }

          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(parsed?.error?.message || `Selection Bridge server returned status ${response.statusCode}.`));
            return;
          }

          resolve(parsed);
        });
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error(`Timed out after ${timeoutMs}ms while querying Selection Bridge instance ${instance.id}.`));
    });
    request.on('error', reject);
    request.end();
  });
}

async function resolvePointer(options = {}) {
  const env = options.env || process.env;
  const cwd = normalizePath(options.cwd || process.cwd());
  const instances = loadInstances({
    env,
    home: options.home,
    instancesDir: options.instancesDir,
    staleMs: options.staleMs,
    now: options.now
  });
  const selection = selectInstance(instances, {
    env,
    cwd,
    instanceId: options.instanceId
  });

  if (!selection.ok) {
    return selection;
  }

  try {
    const pointerRequester = options.requestPointer || requestPointer;
    const response = await pointerRequester(selection.instance, { timeoutMs: options.timeoutMs });
    const responseInstance = {
      ...selection.instance,
      ...(response.instance || {}),
      token: selection.instance.token,
      host: selection.instance.host
    };
    return {
      ok: true,
      selectedBy: selection.selectedBy,
      cwd,
      instance: sanitizeInstance(responseInstance),
      pointer: applyPointerPathMappings(response.pointer, responseInstance, { cwd })
    };
  } catch (error) {
    return failure('query_failed', error instanceof Error ? error.message : String(error), {
      instance: summarizeInstance(selection.instance)
    });
  }
}

async function main(argv = process.argv.slice(2), io = process) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    writeJson(io.stderr, parsed.payload, true);
    return 2;
  }

  const options = parsed.options;
  if (options.help) {
    io.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (options.command === 'list') {
    const instances = loadInstances({
      env: process.env,
      home: options.home,
      staleMs: options.staleMs
    }).map(sanitizeInstance);
    writeJson(io.stdout, { ok: true, instances }, options.pretty);
    return 0;
  }

  const result = await resolvePointer({
    env: process.env,
    cwd: options.cwd || process.cwd(),
    home: options.home,
    instanceId: options.instanceId,
    staleMs: options.staleMs,
    timeoutMs: options.timeoutMs
  });
  writeJson(result.ok ? io.stdout : io.stderr, result, options.pretty);
  return result.ok ? 0 : 1;
}

function parseArgs(argv) {
  const options = {
    command: 'resolve',
    pretty: true
  };

  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) {
    options.command = args.shift();
  }

  if (!['resolve', 'list'].includes(options.command)) {
    return { ok: false, payload: failure('invalid_command', `Unknown command: ${options.command}`, { usage: usage() }) };
  }

  try {
    while (args.length > 0) {
      const arg = args.shift();
      switch (arg) {
        case '--cwd':
          options.cwd = requireValue(arg, args);
          break;
        case '--home':
          options.home = requireValue(arg, args);
          break;
        case '--instance':
          options.instanceId = requireValue(arg, args);
          break;
        case '--stale-ms':
          options.staleMs = parsePositiveInteger(arg, requireValue(arg, args));
          break;
        case '--timeout-ms':
          options.timeoutMs = parsePositiveInteger(arg, requireValue(arg, args));
          break;
        case '--json':
          options.pretty = false;
          break;
        case '--pretty':
          options.pretty = true;
          break;
        case '--help':
        case '-h':
          options.help = true;
          break;
        default:
          return { ok: false, payload: failure('invalid_argument', `Unknown argument: ${arg}`, { usage: usage() }) };
      }
    }
  } catch (error) {
    return {
      ok: false,
      payload: failure('invalid_argument', error instanceof Error ? error.message : String(error), { usage: usage() })
    };
  }

  return { ok: true, options };
}

function requireValue(flag, args) {
  const value = args.shift();
  if (!value || value.startsWith('-')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(flag, value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return parsed;
}

function normalizePath(inputPath) {
  const resolved = path.resolve(inputPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isPathInside(parentPath, childPath) {
  const normalizedParent = normalizePath(parentPath);
  const normalizedChild = normalizePath(childPath);
  const parent = normalizeForPlatform(normalizedParent);
  const child = normalizeForPlatform(normalizedChild);

  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

function getWorkspaceFolderLocalPaths(folder) {
  return [folder.path, folder.localPath, folder.mappedPath].filter(Boolean);
}

function getDirectInstanceFromEnv(env) {
  const portValue = env.SELECTION_BRIDGE_PORT || env.THIS_POINTER_PORT;
  const token = env.SELECTION_BRIDGE_TOKEN || env.THIS_POINTER_TOKEN;

  if (!portValue && !token) {
    return { ok: false };
  }

  if (!portValue || !token) {
    return failure('invalid_direct_connection', 'Both SELECTION_BRIDGE_PORT and SELECTION_BRIDGE_TOKEN are required for direct connection mode.');
  }

  const port = Number.parseInt(portValue, 10);
  if (!Number.isFinite(port) || port <= 0) {
    return failure('invalid_direct_connection', `Invalid SELECTION_BRIDGE_PORT: ${portValue}`);
  }

  return {
    ok: true,
    instance: {
      schemaVersion: 1,
      id: env.SELECTION_BRIDGE_INSTANCE || env.THIS_POINTER_INSTANCE || 'direct',
      host: env.SELECTION_BRIDGE_HOST || env.THIS_POINTER_HOST || '127.0.0.1',
      port,
      token,
      workspaceFolders: [],
      pathMappings: []
    }
  };
}

function applyPointerPathMappings(pointer, instance, options = {}) {
  if (!pointer?.document) {
    return pointer;
  }

  const pathMappings = instance.pathMappings || [];
  const preferRemotePath = shouldPreferRemotePath(options.cwd, pathMappings);
  const documentRemotePath = getDocumentRemotePath(pointer.document);
  const mappedDocument = mapRemotePath(documentRemotePath, pathMappings);
  const workspaceRemotePath = pointer.document.workspaceFolder?.remotePath;
  const mappedWorkspace = mapRemotePath(workspaceRemotePath, pathMappings);

  return {
    ...pointer,
    document: {
      ...pointer.document,
      ...(mappedDocument
        ? {
            path: preferRemotePath ? mappedDocument.remotePath : mappedDocument.localPath,
            localPath: mappedDocument.localPath,
            remotePath: mappedDocument.remotePath
          }
        : preferRemotePath && pointer.document.remotePath
          ? { path: pointer.document.remotePath }
          : {}),
      ...(pointer.document.localPath && preferRemotePath && pointer.document.remotePath
        ? { path: pointer.document.remotePath }
        : {}),
      ...(pointer.document.workspaceFolder && mappedWorkspace
        ? {
            workspaceFolder: {
              ...pointer.document.workspaceFolder,
              path: preferRemotePath ? mappedWorkspace.remotePath : mappedWorkspace.localPath,
              localPath: mappedWorkspace.localPath,
              remotePath: mappedWorkspace.remotePath
            }
          }
        : {})
    }
  };
}

function shouldPreferRemotePath(cwd, pathMappings) {
  if (!cwd) {
    return false;
  }

  return pathMappings.some((mapping) => {
    return mapping.remotePrefix && isRemotePathInside(mapping.remotePrefix, normalizeRemotePath(cwd));
  });
}

function getDocumentRemotePath(document) {
  if (document.remotePath) {
    return document.remotePath;
  }

  if (document.scheme && document.scheme !== 'file' && document.fileName) {
    return document.fileName;
  }

  if (!document.uri) {
    return undefined;
  }

  try {
    const parsed = new URL(document.uri);
    return decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }
}

function mapRemotePath(remotePath, pathMappings) {
  if (!remotePath) {
    return undefined;
  }

  const normalizedRemotePath = normalizeRemotePath(remotePath);
  const mapping = [...pathMappings]
    .filter((candidate) => candidate.remotePrefix && candidate.localPrefix)
    .sort((left, right) => right.remotePrefix.length - left.remotePrefix.length)
    .find((candidate) => isRemotePathInside(candidate.remotePrefix, normalizedRemotePath));

  if (!mapping) {
    return undefined;
  }

  const remotePrefix = stripTrailingSlash(normalizeRemotePath(mapping.remotePrefix));
  const relativePath = normalizedRemotePath === remotePrefix ? '' : normalizedRemotePath.slice(remotePrefix.length + 1);
  return {
    remotePath: normalizedRemotePath,
    localPath: relativePath ? path.join(mapping.localPrefix, ...relativePath.split('/')) : mapping.localPrefix,
    mapping
  };
}

function normalizeRemotePath(remotePath) {
  const normalized = path.posix.normalize(remotePath.replaceAll('\\', '/'));
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function isRemotePathInside(parentPath, childPath) {
  const parent = stripTrailingSlash(normalizeRemotePath(parentPath));
  const child = stripTrailingSlash(normalizeRemotePath(childPath));
  return child === parent || child.startsWith(`${parent}/`);
}

function stripTrailingSlash(inputPath) {
  return inputPath.length > 1 ? inputPath.replace(/\/+$/, '') : inputPath;
}

function normalizeForPlatform(inputPath) {
  return process.platform === 'win32' ? inputPath.toLowerCase() : inputPath;
}

function sanitizeInstance(instance) {
  const { token, registryFile, ...safeInstance } = instance;
  return safeInstance;
}

function summarizeInstance(instance) {
  const safe = sanitizeInstance(instance);
  return {
    id: safe.id,
    workspaceName: safe.workspaceName,
    workspaceFolders: safe.workspaceFolders || [],
    activeDocumentPath: safe.activeDocumentPath,
    lastPointerKind: safe.lastPointerKind,
    lastSelectionCapturedAt: safe.lastSelectionCapturedAt,
    updatedAt: safe.updatedAt
  };
}

function failure(code, message, details = undefined) {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {})
    }
  };
}

function writeJson(stream, payload, pretty) {
  stream.write(`${JSON.stringify(payload, null, pretty ? 2 : 0)}\n`);
}

function usage() {
  return [
    'Usage: selection-bridge [resolve|list] [options]',
    '',
    'Options:',
    '  --cwd <path>          Resolve by this terminal cwd instead of process.cwd()',
    '  --instance <id>       Resolve an explicit VS Code instance id',
    '  --home <path>         Override SELECTION_BRIDGE_HOME for testing',
    '  --stale-ms <ms>       Ignore registry entries older than this age',
    '  --timeout-ms <ms>     HTTP timeout when querying a VS Code instance',
    '  --json               Emit compact JSON',
    '  --pretty             Emit pretty JSON',
    '  -h, --help           Show this help'
  ].join('\n');
}

module.exports = {
  DEFAULT_STALE_MS,
  DEFAULT_TIMEOUT_MS,
  getPointerHome,
  getInstancesDir,
  loadInstances,
  selectInstance,
  requestPointer,
  resolvePointer,
  parseArgs,
  normalizePath,
  isPathInside,
  applyPointerPathMappings,
  getDirectInstanceFromEnv,
  mapRemotePath,
  sanitizeInstance,
  summarizeInstance,
  main
};

if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify(failure('unexpected_error', message), null, 2));
      process.exitCode = 1;
    });
}

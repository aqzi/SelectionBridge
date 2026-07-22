#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_STALE_MS = 30_000;

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
  const cwd = normalizePath(options.cwd || process.cwd());
  const env = options.env || process.env;
  const explicitInstanceId =
    options.instanceId || env.SELECTION_BRIDGE_INSTANCE || env.THIS_POINTER_INSTANCE;
  const matches = findWorkspaceMatches(instances, cwd);

  if (instances.length === 0) {
    if (isLikelyRemoteTerminal(env)) {
      return failure(
        'remote_extension_not_running',
        'This terminal appears to be remote, but no Selection Bridge extension is running in the same remote environment.',
        {
          cwd,
          terminal: summarizeTerminalEnvironment(env),
          ...(explicitInstanceId ? { staleInstanceId: explicitInstanceId } : {})
        },
        'In the target remote VS Code window, open Extensions, find "Selection Bridge", and click the button beginning with "Install in" for that remote. Run "Developer: Reload Window" from the Command Palette, then start a new agent session in a terminal opened from that same VS Code window.'
      );
    }

    return failure(
      'extension_not_running',
      'No running Selection Bridge extension was found in this terminal environment.',
      { cwd, ...(explicitInstanceId ? { staleInstanceId: explicitInstanceId } : {}) },
      'In the intended VS Code window, run "Selection Bridge: Show Current Pointer". If that window is remote, open its integrated terminal, run `npx skills add aqzi/SelectionBridge` there, and start a new agent session there. If the command is missing, install or enable Selection Bridge in that VS Code window.'
    );
  }

  if (explicitInstanceId) {
    const exactMatch = instances.find((instance) => instance.id === explicitInstanceId);
    if (exactMatch) {
      return { ok: true, selectedBy: 'instance', instance: exactMatch };
    }

    if (matches.length === 1) {
      return {
        ok: true,
        selectedBy: 'cwd_fallback',
        instance: matches[0].instance,
        recoveredBinding: {
          staleInstanceId: explicitInstanceId,
          instanceId: matches[0].instance.id
        }
      };
    }

    if (matches.length > 1) {
      return failure(
        'ambiguous_workspace_after_stale_binding',
        `The bound VS Code instance ${explicitInstanceId} is no longer running, and multiple active windows match ${cwd}.`,
        {
          cwd,
          staleInstanceId: explicitInstanceId,
          matches: summarizeMatches(matches)
        },
        'Run "Selection Bridge: Copy Bind Command" in the intended VS Code window, then paste and run the copied command in this terminal.'
      );
    }

    const remoteFailure = remoteWorkspacePathFailure(instances, cwd);
    if (remoteFailure) {
      return remoteFailure;
    }

    return failure(
      'stale_binding_no_matching_workspace',
      `The bound VS Code instance ${explicitInstanceId} is no longer running, and no active VS Code workspace contains ${cwd}.`,
      {
        cwd,
        staleInstanceId: explicitInstanceId,
        activeInstances: instances.map(summarizeInstance)
      },
      `${workspaceMismatchRecovery(cwd, instances)} To stop using the stale binding, run: unset SELECTION_BRIDGE_INSTANCE.`
    );
  }

  if (matches.length === 0) {
    const remoteFailure = remoteWorkspacePathFailure(instances, cwd);
    if (remoteFailure) {
      return remoteFailure;
    }

    return failure(
      'no_matching_workspace',
      `This terminal is in ${cwd}, but no active VS Code workspace contains that directory.`,
      {
        cwd,
        activeInstances: instances.map(summarizeInstance)
      },
      workspaceMismatchRecovery(cwd, instances)
    );
  }

  if (matches.length > 1) {
    return failure(
      'ambiguous_workspace',
      `Multiple VS Code windows contain ${cwd}.`,
      {
        cwd,
        matches: summarizeMatches(matches)
      },
      'Run "Selection Bridge: Copy Bind Command" in the intended VS Code window, then paste and run the copied command in this terminal.'
    );
  }

  return {
    ok: true,
    selectedBy: 'cwd',
    instance: matches[0].instance
  };
}

function findWorkspaceMatches(instances, cwd) {
  return instances
    .map((instance) => ({
      instance,
      matchingWorkspaceFolders: (instance.workspaceFolders || []).filter((folder) => {
        return folder.path && isPathInside(folder.path, cwd);
      })
    }))
    .filter((match) => match.matchingWorkspaceFolders.length > 0);
}

function summarizeMatches(matches) {
  return matches.map((match) => ({
    ...summarizeInstance(match.instance),
    matchingWorkspaceFolders: match.matchingWorkspaceFolders
  }));
}

function remoteWorkspacePathFailure(instances, cwd) {
  const remoteInstances = instances.filter((instance) => {
    const folders = instance.workspaceFolders || [];
    return folders.length > 0 && folders.every((folder) => !folder.path && isRemoteUri(folder.uri));
  });

  if (remoteInstances.length === 0 || remoteInstances.length !== instances.length) {
    return undefined;
  }

  return failure(
    'remote_extension_wrong_host',
    'Selection Bridge found a remote VS Code workspace, but the extension did not provide a filesystem path from the remote extension host.',
    { cwd, activeInstances: remoteInstances.map(summarizeInstance) },
    'Update Selection Bridge in the target remote VS Code window, make sure it is installed on the remote side rather than only locally, and run "Developer: Reload Window" from the Command Palette. Then start a new agent session in that window\'s integrated terminal.'
  );
}

function isRemoteUri(uri) {
  return typeof uri === 'string' && !uri.startsWith('file:');
}

function isLikelyRemoteTerminal(env) {
  return Boolean(
    env.SSH_CONNECTION ||
      env.SSH_CLIENT ||
      env.SSH_TTY ||
      env.VSCODE_AGENT_FOLDER ||
      env.CODESPACES ||
      env.WSL_DISTRO_NAME
  );
}

function summarizeTerminalEnvironment(env) {
  const indicators = [
    'SSH_CONNECTION',
    'SSH_CLIENT',
    'SSH_TTY',
    'VSCODE_AGENT_FOLDER',
    'CODESPACES',
    'WSL_DISTRO_NAME'
  ].filter((name) => Boolean(env[name]));

  return {
    home: env.HOME || os.homedir(),
    ...(env.USER || env.USERNAME ? { user: env.USER || env.USERNAME } : {}),
    remoteIndicators: indicators
  };
}

function workspaceMismatchRecovery(cwd, instances) {
  const workspacePaths = [...new Set(
    instances.flatMap((instance) =>
      (instance.workspaceFolders || []).map((folder) => folder.path).filter(Boolean)
    )
  )];

  if (workspacePaths.length === 0) {
    return `Open ${quoteForMessage(cwd)} as a VS Code workspace, then repeat the request.`;
  }

  const commands = workspacePaths
    .map((workspacePath) => `\`cd ${shellQuote(workspacePath)}\``)
    .join(' or ');
  return `Open ${quoteForMessage(cwd)} as a VS Code workspace, or move this terminal into an active workspace by running: ${commands}.`;
}

async function resolvePointer(options = {}) {
  const env = options.env || process.env;
  const cwd = normalizePath(options.cwd || process.cwd());
  const loadOptions = {
    env,
    home: options.home,
    instancesDir: options.instancesDir,
    staleMs: options.staleMs,
    now: options.now
  };
  const load = options.loadInstances || loadInstances;

  let instances;
  try {
    instances = load(loadOptions);
  } catch (error) {
    return registryReadFailure(error, loadOptions);
  }

  const selection = selectInstance(instances, {
    env,
    cwd,
    instanceId: options.instanceId
  });

  if (!selection.ok) {
    return selection;
  }

  const instance = selection.instance;
  const pointer = instance.pointer;
  if (!pointer || typeof pointer !== 'object') {
    const instanceName = instance.workspaceName || instance.id;
    return failure(
      'extension_outdated',
      `The Selection Bridge extension in ${quoteForMessage(instanceName)} is an older version that does not publish pointer metadata to the registry.`,
      { instance: summarizeInstance(instance) },
      'Update the Selection Bridge extension in that VS Code window, run "Developer: Reload Window" from the Command Palette, and then repeat the request.'
    );
  }

  const pointerFailure = validatePointer(pointer, options.fileSystem || fs);
  if (pointerFailure) {
    return pointerFailure;
  }

  return {
    ok: true,
    selectedBy: selection.selectedBy,
    ...(selection.recoveredBinding ? { recoveredBinding: selection.recoveredBinding } : {}),
    cwd,
    instance: sanitizeInstance(instance),
    pointer
  };
}

function registryReadFailure(error, options) {
  const instancesDir = getInstancesDir(options);
  return failure(
    'registry_unreadable',
    `The Selection Bridge registry at ${instancesDir} could not be read: ${errorMessage(error)}`,
    { instancesDir },
    `Ensure the current terminal user can read ${instancesDir}, then repeat the request.`
  );
}

function validatePointer(pointer, fileSystem) {
  if (pointer.kind === 'none') {
    return failure(
      'no_active_editor',
      'VS Code has no active text editor.',
      undefined,
      'Focus the intended saved file in VS Code, select the relevant code, and then repeat the request.'
    );
  }

  if (!pointer.document) {
    return failure(
      'protocol_mismatch',
      'The Selection Bridge extension published pointer metadata without a document.',
      { pointerKind: pointer.kind },
      'Install matching versions of the Selection Bridge extension and skill, reload VS Code, and then repeat the request.'
    );
  }

  const document = pointer.document;
  if (document.isUntitled || document.scheme === 'untitled') {
    return failure(
      'untitled_document',
      'The active VS Code document has not been saved to disk.',
      { uri: document.uri },
      'Save the document to the current workspace, select the relevant code, and then repeat the request.'
    );
  }

  if (!document.path) {
    if (isRemoteDocument(document)) {
      return failure(
        'remote_document_path_unavailable',
        'The remote Selection Bridge extension did not provide a filesystem path for the selected document.',
        { uri: document.uri, scheme: document.scheme },
        'Update Selection Bridge in the target remote VS Code window, make sure it is installed on the remote side, and run "Developer: Reload Window" from the Command Palette. Then repeat the request from that window\'s integrated terminal.'
      );
    }

    return failure(
      'unsupported_document_scheme',
      `Selection Bridge cannot read the active document scheme ${quoteForMessage(document.scheme || 'unknown')} from disk.`,
      { uri: document.uri, scheme: document.scheme },
      'Focus a saved file in a local or remote VS Code workspace, select the relevant code, and then repeat the request.'
    );
  }

  if (document.isDirty) {
    return failure(
      'document_dirty',
      `The selected file ${quoteForMessage(document.path)} has unsaved changes.`,
      { path: document.path },
      `Save ${quoteForMessage(document.path)} in VS Code, then repeat the request so the on-disk content matches the editor.`
    );
  }

  try {
    fileSystem.accessSync(document.path, fileSystem.constants?.R_OK ?? fs.constants.R_OK);
    const stats = fileSystem.statSync(document.path);
    if (!stats.isFile()) {
      return failure(
        'selected_path_not_file',
        `The selected path ${quoteForMessage(document.path)} is not a regular file.`,
        { path: document.path },
        'Focus a saved file in VS Code, select the relevant code, and then repeat the request.'
      );
    }
  } catch (error) {
    const systemCode = error?.code;
    if (systemCode === 'ENOENT') {
      if (isRemoteDocument(document)) {
        return failure(
          'remote_file_not_visible',
          `The terminal cannot see the remote selected file ${quoteForMessage(document.path)}.`,
          { path: document.path, uri: document.uri },
          `Open a new terminal from the target remote VS Code window and run: \`test -f ${shellQuote(document.path)}\`. If it succeeds, start a new agent session in that terminal because the current agent is in a different environment. If it fails, restore or save ${quoteForMessage(document.path)} in VS Code.`
        );
      }

      return failure(
        'selected_file_missing',
        `The selected file ${quoteForMessage(document.path)} no longer exists on disk.`,
        { path: document.path },
        `Restore or save ${quoteForMessage(document.path)} in VS Code, then repeat the request.`
      );
    }

    return failure(
      'selected_file_unreadable',
      `The terminal cannot read the selected file ${quoteForMessage(document.path)}: ${errorMessage(error)}`,
      { path: document.path, ...(systemCode ? { systemCode } : {}) },
      `Grant the current terminal user read access to ${quoteForMessage(document.path)}, then repeat the request.`
    );
  }

  return undefined;
}

function isRemoteDocument(document) {
  return document.scheme === 'vscode-remote' ||
    (typeof document.uri === 'string' && document.uri.startsWith('vscode-remote:'));
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
    staleMs: options.staleMs
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

function normalizeForPlatform(inputPath) {
  return process.platform === 'win32' ? inputPath.toLowerCase() : inputPath;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function quoteForMessage(value) {
  return JSON.stringify(String(value));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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
    activeDocumentPath: safe.pointer?.document?.path,
    lastPointerKind: safe.pointer?.kind,
    lastSelectionCapturedAt: safe.pointer?.capturedAt,
    execution: safe.execution,
    updatedAt: safe.updatedAt
  };
}

function failure(code, message, details = undefined, recovery = undefined) {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(recovery ? { recovery } : {}),
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
    '  --json               Emit compact JSON',
    '  --pretty             Emit pretty JSON',
    '  -h, --help           Show this help'
  ].join('\n');
}

module.exports = {
  DEFAULT_STALE_MS,
  getPointerHome,
  getInstancesDir,
  loadInstances,
  selectInstance,
  resolvePointer,
  parseArgs,
  normalizePath,
  isPathInside,
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

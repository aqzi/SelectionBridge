import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { buildChatTerminalLaunch, type ChatTerminalConfig } from './chatTerminal';
import {
  buildEffectivePathMappings,
  inferDevcontainerHostPathFromAuthority,
  mapRemotePath,
  type PathMapping
} from './pathMapping';
import { createPointerSnapshot, type PointerSnapshot } from './pointer';
import {
  cleanupStaleRegistryFiles,
  REGISTRY_SCHEMA_VERSION,
  RegistryWriter,
  type RegistryEntry,
  type RegistryWorkspaceFolder
} from './registry';
import { startPointerServer, type PointerServer } from './server';

const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_REGISTRY_MAX_AGE_MS = 60_000;

interface RuntimeState {
  instanceId: string;
  token: string;
  createdAt: string;
  port: number;
  pointer: PointerSnapshot;
  registryWriter: RegistryWriter;
  server: PointerServer;
  output: vscode.OutputChannel;
  heartbeat: NodeJS.Timeout;
}

interface PathMappingConfig {
  pathMappings: readonly Partial<PathMapping>[];
  localWorkspaceFolder: string;
}

let runtime: RuntimeState | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  cleanupStaleRegistryFiles(STALE_REGISTRY_MAX_AGE_MS);

  const instanceId = crypto.randomUUID();
  const token = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const output = vscode.window.createOutputChannel('Selection Bridge');
  const registryWriter = new RegistryWriter(instanceId);
  const initialPointer = snapshotActiveEditor();

  const server = await startPointerServer({
    getToken: () => requireRuntime().token,
    getInstance: () => buildRegistryEntry(requireRuntime()),
    getPointer: () => requireRuntime().pointer
  });

  runtime = {
    instanceId,
    token,
    createdAt,
    port: server.port,
    pointer: initialPointer,
    registryWriter,
    server,
    output,
    heartbeat: setInterval(() => writeRegistry(), HEARTBEAT_INTERVAL_MS)
  };

  writeRegistry();

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updatePointer(editor);
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === vscode.window.activeTextEditor) {
        updatePointer(event.textEditor);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (vscode.window.activeTextEditor?.document === event.document) {
        updatePointer(vscode.window.activeTextEditor);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (vscode.window.activeTextEditor?.document === document) {
        updatePointer(vscode.window.activeTextEditor);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      writeRegistry();
    }),
    vscode.commands.registerCommand('selectionBridge.showCurrentPointer', showCurrentPointer),
    vscode.commands.registerCommand('selectionBridge.copyBindCommand', copyBindCommand),
    vscode.commands.registerCommand('selectionBridge.resetInstanceId', resetInstanceId),
    vscode.commands.registerCommand('selectionBridge.openChatTerminal', openChatTerminal),
    {
      dispose: () => {
        void deactivate();
      }
    }
  );
}

export async function deactivate(): Promise<void> {
  if (!runtime) {
    return;
  }

  const current = runtime;
  runtime = undefined;

  clearInterval(current.heartbeat);
  current.registryWriter.dispose();
  current.output.dispose();
  await current.server.dispose();
}

function updatePointer(editor: vscode.TextEditor | undefined): void {
  requireRuntime().pointer = applyPathMappingsToPointer(
    createPointerSnapshot(editor, getWorkspaceFolder(editor?.document.uri)),
    getEffectivePathMappings()
  );
  writeRegistry();
}

function snapshotActiveEditor(): PointerSnapshot {
  const editor = vscode.window.activeTextEditor;
  return applyPathMappingsToPointer(
    createPointerSnapshot(editor, getWorkspaceFolder(editor?.document.uri)),
    getEffectivePathMappings()
  );
}

function getWorkspaceFolder(uri: vscode.Uri | undefined): vscode.WorkspaceFolder | undefined {
  if (!uri) {
    return undefined;
  }

  return vscode.workspace.getWorkspaceFolder(uri);
}

function writeRegistry(): void {
  const current = runtime;
  if (!current) {
    return;
  }

  current.registryWriter.write(buildRegistryEntry(current));
}

function buildRegistryEntry(current: RuntimeState): RegistryEntry {
  const activeDocument = current.pointer.document;
  const vscodeEnv = vscode.env as typeof vscode.env & { sessionId?: string };
  const effectivePathMappings = getEffectivePathMappings();

  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    id: current.instanceId,
    port: current.port,
    token: current.token,
    pid: process.pid,
    ...(vscode.workspace.name ? { workspaceName: vscode.workspace.name } : {}),
    workspaceFolders: serializeWorkspaceFolders(effectivePathMappings),
    pathMappings: effectivePathMappings,
    ...(vscode.env.remoteName ? { remoteName: vscode.env.remoteName } : {}),
    ...(activeDocument?.uri ? { activeDocumentUri: activeDocument.uri } : {}),
    ...(activeDocument?.path ? { activeDocumentPath: activeDocument.path } : {}),
    ...(activeDocument?.remotePath ? { activeDocumentRemotePath: activeDocument.remotePath } : {}),
    ...(activeDocument?.localPath ? { activeDocumentLocalPath: activeDocument.localPath } : {}),
    lastPointerKind: current.pointer.kind,
    lastSelectionCapturedAt: current.pointer.capturedAt,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
    ...(vscodeEnv.sessionId ? { vscodeSessionId: vscodeEnv.sessionId } : {})
  };
}

function serializeWorkspaceFolders(pathMappings: readonly PathMapping[]): RegistryWorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders || []).map((folder) => ({
    name: folder.name,
    uri: folder.uri.toString(),
    ...(folder.uri.scheme === 'file' ? { path: folder.uri.fsPath } : {}),
    ...(folder.uri.scheme !== 'file' ? { remotePath: folder.uri.path } : {}),
    ...mappedWorkspaceFolderPaths(folder.uri, pathMappings),
    index: folder.index
  }));
}

function mappedWorkspaceFolderPaths(
  uri: vscode.Uri,
  pathMappings: readonly PathMapping[]
): Pick<RegistryWorkspaceFolder, 'localPath' | 'mappedPath'> {
  if (uri.scheme === 'file') {
    return {
      localPath: uri.fsPath,
      mappedPath: uri.fsPath
    };
  }

  const mapped = mapRemotePath(uri.path, pathMappings);
  return mapped ? { localPath: mapped.localPath, mappedPath: mapped.localPath } : {};
}

async function showCurrentPointer(): Promise<void> {
  const current = requireRuntime();
  const payload = {
    ok: true,
    instance: removeToken(buildRegistryEntry(current)),
    pointer: current.pointer
  };

  current.output.clear();
  current.output.appendLine(JSON.stringify(payload, null, 2));
  current.output.show(true);
}

async function copyBindCommand(): Promise<void> {
  const command = `export SELECTION_BRIDGE_INSTANCE=${requireRuntime().instanceId}`;
  await vscode.env.clipboard.writeText(command);
  vscode.window.showInformationMessage('Copied Selection Bridge bind command.');
}

async function resetInstanceId(): Promise<void> {
  const current = requireRuntime();
  current.registryWriter.dispose();
  current.instanceId = crypto.randomUUID();
  current.token = crypto.randomUUID();
  current.createdAt = new Date().toISOString();
  current.registryWriter = new RegistryWriter(current.instanceId);
  writeRegistry();

  const command = `export SELECTION_BRIDGE_INSTANCE=${current.instanceId}`;
  await vscode.env.clipboard.writeText(command);
  vscode.window.showInformationMessage('Reset Selection Bridge instance id and copied the new bind command.');
}

async function openChatTerminal(resource?: vscode.Uri): Promise<void> {
  const current = requireRuntime();
  const workspace = resolveLaunchWorkspace(resource, getEffectivePathMappings());

  if (!workspace) {
    vscode.window.showErrorMessage(
      'Selection Bridge could not find a local workspace folder for this editor. For devcontainers, set selectionBridge.devcontainer.localWorkspaceFolder or selectionBridge.pathMappings.'
    );
    return;
  }

  const config = readChatTerminalConfig();
  const launch = buildChatTerminalLaunch({
    config,
    workspaceFolder: workspace.path,
    workspaceName: workspace.name,
    instanceId: current.instanceId,
    port: current.port,
    token: current.token,
    platform: process.platform,
    env: process.env
  });

  current.output.appendLine(`Launching chat terminal: ${launch.executable} ${launch.args.join(' ')}`);

  try {
    const child = spawn(launch.executable, launch.args, {
      cwd: launch.cwd,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ...launch.env
      }
    });

    child.once('error', (error) => {
      vscode.window.showErrorMessage(`Selection Bridge failed to launch terminal: ${error.message}`);
    });
    child.unref();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Selection Bridge failed to launch terminal: ${message}`);
  }
}

function readChatTerminalConfig(): ChatTerminalConfig {
  const config = vscode.workspace.getConfiguration('selectionBridge.chatTerminal');

  return {
    executable: config.get<string>('executable', ''),
    args: config.get<string[]>('args', []),
    startupCommands: config.get<string[]>('startupCommands', []),
    tmuxSessionName: config.get<string>('tmuxSessionName', ''),
    shell: config.get<string>('shell', ''),
    keepOpen: config.get<boolean>('keepOpen', true),
    extraEnv: config.get<Record<string, string>>('extraEnv', {})
  };
}

function resolveLaunchWorkspace(
  resource: vscode.Uri | undefined,
  pathMappings: readonly PathMapping[]
): { path: string; name: string } | undefined {
  const candidateUri = resource || vscode.window.activeTextEditor?.document.uri;
  const workspaceFolder = candidateUri ? vscode.workspace.getWorkspaceFolder(candidateUri) : undefined;

  if (workspaceFolder?.uri.scheme === 'file') {
    return { path: workspaceFolder.uri.fsPath, name: workspaceFolder.name };
  }

  if (workspaceFolder && workspaceFolder.uri.scheme !== 'file') {
    const mapped = mapRemotePath(workspaceFolder.uri.path, pathMappings);
    if (mapped) {
      return { path: mapped.localPath, name: workspaceFolder.name };
    }
  }

  const workspaceFolders = vscode.workspace.workspaceFolders?.filter((folder) => folder.uri.scheme === 'file') || [];
  if (workspaceFolders.length === 1) {
    return { path: workspaceFolders[0].uri.fsPath, name: workspaceFolders[0].name };
  }

  if (candidateUri?.scheme === 'file') {
    const filePath = candidateUri.fsPath;
    return { path: path.dirname(filePath), name: path.basename(path.dirname(filePath)) };
  }

  return undefined;
}

function getEffectivePathMappings(): PathMapping[] {
  const config = readPathMappingConfig();
  const remoteWorkspaceFolders = (vscode.workspace.workspaceFolders || []).filter((folder) => folder.uri.scheme !== 'file');
  const inferredLocalWorkspaceFolder = inferLocalWorkspaceFolder(remoteWorkspaceFolders.map((folder) => folder.uri.authority));

  return buildEffectivePathMappings({
    configuredMappings: config.pathMappings,
    localWorkspaceFolder: config.localWorkspaceFolder,
    inferredLocalWorkspaceFolder,
    remoteWorkspaceFolders: remoteWorkspaceFolders.map((folder) => folder.uri.path),
    env: process.env
  });
}

function inferLocalWorkspaceFolder(remoteAuthorities: readonly string[]): string | undefined {
  const inferred = new Set(
    remoteAuthorities
      .map((authority) => inferDevcontainerHostPathFromAuthority(authority))
      .filter((hostPath): hostPath is string => Boolean(hostPath))
  );

  return inferred.size === 1 ? [...inferred][0] : undefined;
}

function readPathMappingConfig(): PathMappingConfig {
  const rootConfig = vscode.workspace.getConfiguration('selectionBridge');
  const devcontainerConfig = vscode.workspace.getConfiguration('selectionBridge.devcontainer');

  return {
    pathMappings: rootConfig.get<Partial<PathMapping>[]>('pathMappings', []),
    localWorkspaceFolder: devcontainerConfig.get<string>('localWorkspaceFolder', '')
  };
}

function applyPathMappingsToPointer(pointer: PointerSnapshot, pathMappings: readonly PathMapping[]): PointerSnapshot {
  if (!pointer.document) {
    return pointer;
  }

  const documentRemotePath = pointer.document.remotePath || (pointer.document.scheme !== 'file' ? pointer.document.fileName : undefined);
  const mappedDocument = mapRemotePath(documentRemotePath, pathMappings);
  const workspaceRemotePath = pointer.document.workspaceFolder?.remotePath;
  const mappedWorkspace = mapRemotePath(workspaceRemotePath, pathMappings);

  return {
    ...pointer,
    document: {
      ...pointer.document,
      ...(mappedDocument
        ? {
            path: mappedDocument.localPath,
            localPath: mappedDocument.localPath,
            remotePath: mappedDocument.remotePath
          }
        : {}),
      ...(pointer.document.workspaceFolder && mappedWorkspace
        ? {
            workspaceFolder: {
              ...pointer.document.workspaceFolder,
              path: mappedWorkspace.localPath,
              localPath: mappedWorkspace.localPath,
              remotePath: mappedWorkspace.remotePath
            }
          }
        : {})
    }
  };
}

function requireRuntime(): RuntimeState {
  if (!runtime) {
    throw new Error('Selection Bridge runtime is not active.');
  }

  return runtime;
}

function removeToken(entry: RegistryEntry): Omit<RegistryEntry, 'token'> {
  const { token: _token, ...safeEntry } = entry;
  return safeEntry;
}

import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import {
  createPointerSnapshot,
  getExecutionFileSystemPath,
  serializeWorkspaceFolder,
  type PointerSnapshot
} from './pointer';
import {
  cleanupStaleRegistryFiles,
  REGISTRY_SCHEMA_VERSION,
  RegistryWriter,
  type RegistryEntry,
  type RegistryWorkspaceFolder
} from './registry';

const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_REGISTRY_MAX_AGE_MS = 60_000;
const POINTER_WRITE_COALESCE_MS = 100;

interface RuntimeState {
  instanceId: string;
  createdAt: string;
  pointer: PointerSnapshot;
  registryWriter: RegistryWriter;
  output: vscode.OutputChannel;
  heartbeat: NodeJS.Timeout;
  pointerWriteTimer?: NodeJS.Timeout;
  extensionHostKind: 'ui' | 'workspace';
}

export interface SelectionBridgeContext {
  workspace: {
    path: string;
    name: string;
  };
  instanceId: string;
}

export interface SelectionBridgeApi {
  version: 2;
  getContext(resource?: vscode.Uri): SelectionBridgeContext | undefined;
}

let runtime: RuntimeState | undefined;

export function activate(context: vscode.ExtensionContext): SelectionBridgeApi {
  cleanupStaleRegistryFiles(STALE_REGISTRY_MAX_AGE_MS);

  const instanceId = crypto.randomUUID();

  runtime = {
    instanceId,
    createdAt: new Date().toISOString(),
    pointer: snapshotActiveEditor(),
    registryWriter: new RegistryWriter(instanceId),
    output: vscode.window.createOutputChannel('Selection Bridge'),
    extensionHostKind:
      context.extension.extensionKind === vscode.ExtensionKind.Workspace ? 'workspace' : 'ui',
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
    {
      dispose: () => {
        deactivate();
      }
    }
  );

  return {
    version: 2,
    getContext
  };
}

export function deactivate(): void {
  if (!runtime) {
    return;
  }

  const current = runtime;
  runtime = undefined;

  clearInterval(current.heartbeat);
  if (current.pointerWriteTimer) {
    clearTimeout(current.pointerWriteTimer);
  }
  current.registryWriter.dispose();
  current.output.dispose();
}

function updatePointer(editor: vscode.TextEditor | undefined): void {
  const current = requireRuntime();
  current.pointer = createPointerSnapshot(editor, getWorkspaceFolder(editor?.document.uri));
  schedulePointerWrite(current);
}

/**
 * Selection events fire on every cursor movement; coalesce bursts into a
 * single registry write so the on-disk pointer trails the editor by at most
 * POINTER_WRITE_COALESCE_MS.
 */
function schedulePointerWrite(current: RuntimeState): void {
  if (current.pointerWriteTimer) {
    return;
  }

  current.pointerWriteTimer = setTimeout(() => {
    current.pointerWriteTimer = undefined;
    writeRegistry();
  }, POINTER_WRITE_COALESCE_MS);
}

function snapshotActiveEditor(): PointerSnapshot {
  const editor = vscode.window.activeTextEditor;
  return createPointerSnapshot(editor, getWorkspaceFolder(editor?.document.uri));
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
  const vscodeEnv = vscode.env as typeof vscode.env & { sessionId?: string };

  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    id: current.instanceId,
    pid: process.pid,
    ...(vscode.workspace.name ? { workspaceName: vscode.workspace.name } : {}),
    workspaceFolders: serializeWorkspaceFolders(),
    pointer: current.pointer,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
    ...(vscodeEnv.sessionId ? { vscodeSessionId: vscodeEnv.sessionId } : {}),
    execution: {
      hostname: os.hostname(),
      home: os.homedir(),
      platform: process.platform,
      extensionHostKind: current.extensionHostKind,
      ...(vscode.env.remoteName ? { vscodeRemoteName: vscode.env.remoteName } : {})
    }
  };
}

function serializeWorkspaceFolders(): RegistryWorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders || []).map(serializeWorkspaceFolder);
}

async function showCurrentPointer(): Promise<void> {
  const current = requireRuntime();
  const payload = {
    ok: true,
    instance: buildRegistryEntry(current)
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
  current.createdAt = new Date().toISOString();
  current.registryWriter = new RegistryWriter(current.instanceId);
  writeRegistry();

  const command = `export SELECTION_BRIDGE_INSTANCE=${current.instanceId}`;
  await vscode.env.clipboard.writeText(command);
  vscode.window.showInformationMessage('Reset Selection Bridge instance id and copied the new bind command.');
}

function getContext(resource?: vscode.Uri): SelectionBridgeContext | undefined {
  const current = requireRuntime();
  const workspace = resolveLaunchWorkspace(resource);

  if (!workspace) {
    return undefined;
  }

  return {
    workspace,
    instanceId: current.instanceId
  };
}

function resolveLaunchWorkspace(resource: vscode.Uri | undefined): { path: string; name: string } | undefined {
  const candidateUri = resource || vscode.window.activeTextEditor?.document.uri;
  const workspaceFolder = candidateUri ? vscode.workspace.getWorkspaceFolder(candidateUri) : undefined;
  const workspacePath = workspaceFolder
    ? getExecutionFileSystemPath(workspaceFolder.uri)
    : undefined;

  if (workspaceFolder && workspacePath) {
    return { path: workspacePath, name: workspaceFolder.name };
  }

  const workspaceFolders = (vscode.workspace.workspaceFolders || []).flatMap((folder) => {
    const folderPath = getExecutionFileSystemPath(folder.uri);
    return folderPath ? [{ folder, path: folderPath }] : [];
  });
  if (workspaceFolders.length === 1) {
    return { path: workspaceFolders[0].path, name: workspaceFolders[0].folder.name };
  }

  const candidatePath = candidateUri ? getExecutionFileSystemPath(candidateUri) : undefined;
  if (candidatePath) {
    const filePath = candidatePath;
    return { path: path.dirname(filePath), name: path.basename(path.dirname(filePath)) };
  }

  return undefined;
}

function requireRuntime(): RuntimeState {
  if (!runtime) {
    throw new Error('Selection Bridge runtime is not active.');
  }

  return runtime;
}

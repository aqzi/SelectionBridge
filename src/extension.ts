import * as crypto from 'node:crypto';
import * as path from 'node:path';

import * as vscode from 'vscode';

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

export interface SelectionBridgeContext {
  workspace: {
    path: string;
    name: string;
  };
  bridge: {
    instanceId: string;
    host: string;
    port: number;
    token: string;
  };
}

export interface SelectionBridgeApi {
  version: 1;
  getContext(resource?: vscode.Uri): SelectionBridgeContext | undefined;
}

let runtime: RuntimeState | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<SelectionBridgeApi> {
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
    {
      dispose: () => {
        void deactivate();
      }
    }
  );

  return {
    version: 1,
    getContext
  };
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
  requireRuntime().pointer = createPointerSnapshot(
    editor,
    getWorkspaceFolder(editor?.document.uri)
  );
  writeRegistry();
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
  const activeDocument = current.pointer.document;
  const vscodeEnv = vscode.env as typeof vscode.env & { sessionId?: string };

  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    id: current.instanceId,
    port: current.port,
    token: current.token,
    pid: process.pid,
    ...(vscode.workspace.name ? { workspaceName: vscode.workspace.name } : {}),
    workspaceFolders: serializeWorkspaceFolders(),
    ...(activeDocument?.uri ? { activeDocumentUri: activeDocument.uri } : {}),
    ...(activeDocument?.path ? { activeDocumentPath: activeDocument.path } : {}),
    lastPointerKind: current.pointer.kind,
    lastSelectionCapturedAt: current.pointer.capturedAt,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
    ...(vscodeEnv.sessionId ? { vscodeSessionId: vscodeEnv.sessionId } : {})
  };
}

function serializeWorkspaceFolders(): RegistryWorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders || []).map((folder) => ({
    name: folder.name,
    uri: folder.uri.toString(),
    ...(folder.uri.scheme === 'file' ? { path: folder.uri.fsPath } : {}),
    index: folder.index
  }));
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

function getContext(resource?: vscode.Uri): SelectionBridgeContext | undefined {
  const current = requireRuntime();
  const workspace = resolveLaunchWorkspace(resource);

  if (!workspace) {
    return undefined;
  }

  return {
    workspace,
    bridge: {
      instanceId: current.instanceId,
      host: '127.0.0.1',
      port: current.port,
      token: current.token
    }
  };
}

function resolveLaunchWorkspace(resource: vscode.Uri | undefined): { path: string; name: string } | undefined {
  const candidateUri = resource || vscode.window.activeTextEditor?.document.uri;
  const workspaceFolder = candidateUri ? vscode.workspace.getWorkspaceFolder(candidateUri) : undefined;

  if (workspaceFolder?.uri.scheme === 'file') {
    return { path: workspaceFolder.uri.fsPath, name: workspaceFolder.name };
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

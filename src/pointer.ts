import type * as vscode from 'vscode';

export interface SerializedPosition {
  line: number;
  character: number;
}

export interface SerializedSelection {
  anchor: SerializedPosition;
  active: SerializedPosition;
  start: SerializedPosition;
  end: SerializedPosition;
  isEmpty: boolean;
  isReversed: boolean;
  lineSpan: number;
  singleLineCharacterSpan?: number;
}

export interface SerializedDocument {
  uri: string;
  scheme: string;
  path?: string;
  remotePath?: string;
  localPath?: string;
  fileName: string;
  languageId: string;
  version: number;
  isDirty: boolean;
  isUntitled: boolean;
  lineCount: number;
  workspaceFolder?: {
    name: string;
    uri: string;
    path?: string;
    remotePath?: string;
    localPath?: string;
    index: number;
  };
}

export interface PointerSnapshot {
  kind: 'none' | 'cursor' | 'selection';
  capturedAt: string;
  document?: SerializedDocument;
  primarySelection?: SerializedSelection;
  selections: SerializedSelection[];
}

type PositionLike = Pick<vscode.Position, 'line' | 'character'>;

type UriLike = Pick<vscode.Uri, 'scheme' | 'toString'> & {
  fsPath?: string;
  path?: string;
};

type TextDocumentLike = Pick<
  vscode.TextDocument,
  'uri' | 'fileName' | 'languageId' | 'version' | 'isDirty' | 'isUntitled' | 'lineCount'
> & {
  uri: UriLike;
};

type WorkspaceFolderLike = Pick<vscode.WorkspaceFolder, 'name' | 'index'> & {
  uri: UriLike;
};

type SelectionLike = Pick<vscode.Selection, 'anchor' | 'active' | 'start' | 'end'> & {
  anchor: PositionLike;
  active: PositionLike;
  start: PositionLike;
  end: PositionLike;
};

type TextEditorLike = Pick<vscode.TextEditor, 'document' | 'selection' | 'selections'> & {
  document: TextDocumentLike;
  selection: SelectionLike;
  selections: readonly SelectionLike[];
};

export function serializePosition(position: PositionLike): SerializedPosition {
  return {
    line: position.line,
    character: position.character
  };
}

export function comparePositions(left: PositionLike, right: PositionLike): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }

  return left.character - right.character;
}

export function serializeSelection(selection: SelectionLike): SerializedSelection {
  const start = serializePosition(selection.start);
  const end = serializePosition(selection.end);
  const isEmpty = start.line === end.line && start.character === end.character;
  const lineSpan = end.line - start.line + 1;
  const isSingleLine = start.line === end.line;

  return {
    anchor: serializePosition(selection.anchor),
    active: serializePosition(selection.active),
    start,
    end,
    isEmpty,
    isReversed: comparePositions(selection.anchor, selection.active) > 0,
    lineSpan,
    ...(isSingleLine ? { singleLineCharacterSpan: end.character - start.character } : {})
  };
}

export function serializeDocument(
  document: TextDocumentLike,
  workspaceFolder: WorkspaceFolderLike | undefined
): SerializedDocument {
  const documentPath = document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
  const documentRemotePath = document.uri.scheme !== 'file' ? document.uri.path : undefined;

  return {
    uri: document.uri.toString(),
    scheme: document.uri.scheme,
    ...(documentPath ? { path: documentPath } : {}),
    ...(documentRemotePath ? { remotePath: documentRemotePath } : {}),
    fileName: document.fileName,
    languageId: document.languageId,
    version: document.version,
    isDirty: document.isDirty,
    isUntitled: document.isUntitled,
    lineCount: document.lineCount,
    ...(workspaceFolder
      ? {
          workspaceFolder: {
            name: workspaceFolder.name,
            uri: workspaceFolder.uri.toString(),
            ...(workspaceFolder.uri.scheme === 'file' && workspaceFolder.uri.fsPath
              ? { path: workspaceFolder.uri.fsPath }
              : {}),
            ...(workspaceFolder.uri.scheme !== 'file' && workspaceFolder.uri.path
              ? { remotePath: workspaceFolder.uri.path }
              : {}),
            index: workspaceFolder.index
          }
        }
      : {})
  };
}

export function createPointerSnapshot(
  editor: TextEditorLike | undefined,
  workspaceFolder: WorkspaceFolderLike | undefined,
  capturedAt = new Date().toISOString()
): PointerSnapshot {
  if (!editor) {
    return {
      kind: 'none',
      capturedAt,
      selections: []
    };
  }

  const selections = (editor.selections.length > 0 ? editor.selections : [editor.selection]).map(serializeSelection);
  const primarySelection = selections[0];
  const hasSelection = selections.some((selection) => !selection.isEmpty);

  return {
    kind: hasSelection ? 'selection' : 'cursor',
    capturedAt,
    document: serializeDocument(editor.document, workspaceFolder),
    primarySelection,
    selections
  };
}

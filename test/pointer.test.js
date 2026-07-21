'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createPointerSnapshot, serializeSelection } = require('../out/pointer.js');

test('serializes a forward single-line selection without content', () => {
  const selection = serializeSelection({
    anchor: { line: 3, character: 2 },
    active: { line: 3, character: 8 },
    start: { line: 3, character: 2 },
    end: { line: 3, character: 8 }
  });

  assert.deepEqual(selection, {
    anchor: { line: 3, character: 2 },
    active: { line: 3, character: 8 },
    start: { line: 3, character: 2 },
    end: { line: 3, character: 8 },
    isEmpty: false,
    isReversed: false,
    lineSpan: 1,
    singleLineCharacterSpan: 6
  });
});

test('serializes a reversed multi-line selection', () => {
  const selection = serializeSelection({
    anchor: { line: 9, character: 4 },
    active: { line: 7, character: 1 },
    start: { line: 7, character: 1 },
    end: { line: 9, character: 4 }
  });

  assert.equal(selection.isReversed, true);
  assert.equal(selection.lineSpan, 3);
  assert.equal(selection.singleLineCharacterSpan, undefined);
});

test('creates cursor snapshot for empty selections', () => {
  const snapshot = createPointerSnapshot(
    {
      document: fakeDocument('/workspace/app/src/file.ts'),
      selection: emptySelection(2, 4),
      selections: [emptySelection(2, 4)]
    },
    fakeWorkspaceFolder('/workspace/app'),
    '2026-07-20T10:00:00.000Z'
  );

  assert.equal(snapshot.kind, 'cursor');
  assert.equal(snapshot.document.path, '/workspace/app/src/file.ts');
  assert.equal(snapshot.document.workspaceFolder.path, '/workspace/app');
  assert.equal(snapshot.selections.length, 1);
});

test('creates selection snapshot for multiple selections', () => {
  const snapshot = createPointerSnapshot(
    {
      document: fakeDocument('/workspace/app/src/file.ts'),
      selection: rangeSelection(1, 0, 1, 4),
      selections: [rangeSelection(1, 0, 1, 4), rangeSelection(5, 2, 6, 3)]
    },
    fakeWorkspaceFolder('/workspace/app'),
    '2026-07-20T10:00:00.000Z'
  );

  assert.equal(snapshot.kind, 'selection');
  assert.equal(snapshot.selections.length, 2);
  assert.equal(snapshot.primarySelection.singleLineCharacterSpan, 4);
});

function fakeDocument(filePath) {
  return {
    uri: {
      scheme: 'file',
      fsPath: filePath,
      toString: () => `file://${filePath}`
    },
    fileName: filePath,
    languageId: 'typescript',
    version: 12,
    isDirty: false,
    isUntitled: false,
    lineCount: 20
  };
}

function fakeWorkspaceFolder(folderPath) {
  return {
    name: 'app',
    index: 0,
    uri: {
      scheme: 'file',
      fsPath: folderPath,
      toString: () => `file://${folderPath}`
    }
  };
}

function emptySelection(line, character) {
  return rangeSelection(line, character, line, character);
}

function rangeSelection(startLine, startCharacter, endLine, endCharacter) {
  return {
    anchor: { line: startLine, character: startCharacter },
    active: { line: endLine, character: endCharacter },
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter }
  };
}

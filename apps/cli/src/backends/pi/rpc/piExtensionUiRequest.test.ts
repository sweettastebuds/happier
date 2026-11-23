import { describe, expect, it } from 'vitest';

import {
  buildPiExtensionUiResponse,
  buildPiToolApprovalInput,
  parsePiBlockingExtensionUiRequest,
  parsePiExtensionUiCancel,
  parsePiToolApprovalSelect,
} from './piExtensionUiRequest';

function select(title: string, options: string[]) {
  const request = parsePiBlockingExtensionUiRequest({ type: 'extension_ui_request', id: 'r1', method: 'select', title, options });
  if (!request) throw new Error('select did not parse');
  return request;
}

describe('omp tool approval select', () => {
  it('reads the command from the bash approval prompt so the permission identity is per call', () => {
    const approval = parsePiToolApprovalSelect(select(
      'Allow tool: bash\nReason: needed\nCommand: ls -la\nmore',
      ['Approve', 'Approve bash for this session', 'Deny'],
    ))!;
    expect(approval.toolName).toBe('bash');
    expect(buildPiToolApprovalInput(approval)).toMatchObject({ command: 'ls -la\nmore' });
  });

  it('reads the target path from write and edit approval prompts', () => {
    const write = parsePiToolApprovalSelect(select('Allow tool: write\nPath: /a/b.txt\nContent:\nx', ['Approve', 'Deny']))!;
    expect(buildPiToolApprovalInput(write)).toMatchObject({ path: '/a/b.txt' });
    const edit = parsePiToolApprovalSelect(select('Allow tool: edit\nFile: /a/c.ts', ['Approve', 'Deny']))!;
    expect(buildPiToolApprovalInput(edit)).toMatchObject({ path: '/a/c.ts' });
  });

  it('reports whether omp offered a session option', () => {
    expect(parsePiToolApprovalSelect(select('Allow tool: bash\nCommand: ls', ['Approve', 'Approve bash for this session', 'Deny']))!.sessionGrantOffered).toBe(true);
    expect(parsePiToolApprovalSelect(select('Allow tool: bash\nCommand: ls', ['Approve', 'Deny']))!.sessionGrantOffered).toBe(false);
  });

  it('keeps a non-approval select that merely ends in Deny as a question', () => {
    expect(parsePiToolApprovalSelect(select('What should happen to the file?', ['Keep', 'Deny']))).toBeNull();
  });
});

describe('omp cancel frames', () => {
  it('extracts the targeted dialog id and ignores other frames', () => {
    expect(parsePiExtensionUiCancel({ type: 'extension_ui_request', id: 'c1', method: 'cancel', targetId: 'r1' })).toBe('r1');
    expect(parsePiExtensionUiCancel({ type: 'extension_ui_request', id: 'c1', method: 'select', targetId: 'r1' })).toBeNull();
    expect(parsePiExtensionUiCancel({ type: 'extension_ui_request', id: 'c1', method: 'cancel' })).toBeNull();
  });
});

describe('omp ask answers', () => {
  const request = parsePiBlockingExtensionUiRequest({
    type: 'extension_ui_request', id: 'a1', method: 'ask', questions: [
      { id: 'single', question: 'One?', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'multi', question: 'Many?', multi: true, options: [{ label: 'X' }, { label: 'Y' }] },
    ],
  })!;

  it('never sends duplicate labels, and clamps single-select to one answer', () => {
    const response = buildPiExtensionUiResponse(request, {
      decision: 'approved',
      answers: { 'One?': ['A', 'B', 'typed'], 'Many?': ['X', 'X', 'Y'] },
    });
    expect(response.answers).toEqual([
      { id: 'single', selectedOptions: ['A'] },
      { id: 'multi', selectedOptions: ['X', 'Y'] },
    ]);
  });

  it('keeps custom text alone for single-select when no option was chosen', () => {
    const response = buildPiExtensionUiResponse(request, {
      decision: 'approved',
      answers: { 'One?': ['typed'], 'Many?': ['X'] },
    });
    expect(response.answers?.[0]).toEqual({ id: 'single', selectedOptions: [], customInput: 'typed' });
  });
});

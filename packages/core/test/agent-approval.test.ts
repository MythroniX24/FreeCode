/**
 * Approval policy.
 *
 * The rules encoded here are the difference between an agent that can be left
 * running and one that cannot: read-only work is free, changes are gated by the
 * mode, a `deny` from the command policy is absolute, and an unattended run
 * refuses rather than assumes consent.
 */

import { describe, expect, it } from 'vitest';

import {
  ApprovalManager,
  assessToolCall,
  callSignature,
  allowingApprover,
  denyingApprover,
} from '../src/agent/approval.js';
import { withDefaults } from '../src/config/schema.js';
import { nullLogger } from '../src/util/logger.js';
import type { AgentTool, Approver } from '../src/agent/types.js';
import type { ApprovalMode } from '../src/config/schema.js';

function tool(overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    name: 'edit_file',
    description: 'test',
    parameters: {},
    mutating: true,
    executesCode: false,
    run: async () => ({ content: '', isError: false }),
    ...overrides,
  };
}

function approvalConfig(mode: ApprovalMode, overrides: Record<string, unknown> = {}) {
  return { ...withDefaults({ approval: { mode, ...overrides } }).approval };
}

const CALL = { id: 'c1', name: 'edit_file', argumentsJson: '{}' };

describe('assessToolCall', () => {
  it('fast-paths a read-only tool regardless of mode', () => {
    const readOnly = tool({ mutating: false });
    for (const mode of ['read-only', 'ask', 'auto-safe', 'yolo'] as const) {
      const verdict = assessToolCall({
        tool: readOnly,
        approval: approvalConfig(mode),
        autoApproveReadOnly: true,
      });
      expect(verdict.kind).toBe('allow');
    }
  });

  it('asks before a mutation in read-only and ask modes', () => {
    for (const mode of ['read-only', 'ask'] as const) {
      const verdict = assessToolCall({
        tool: tool(),
        approval: approvalConfig(mode),
        autoApproveReadOnly: true,
      });
      expect(verdict.kind).toBe('ask');
    }
  });

  it('auto-safe allows a plain mutation but asks about an unrecognised command', () => {
    const safe = approvalConfig('auto-safe');
    expect(assessToolCall({ tool: tool(), approval: safe, autoApproveReadOnly: true }).kind).toBe(
      'allow',
    );
    expect(
      assessToolCall({
        tool: tool({ executesCode: true }),
        approval: safe,
        autoApproveReadOnly: true,
        commandVerdict: 'ask',
      }).kind,
    ).toBe('ask');
  });

  it('never lets yolo override a command-policy denial', () => {
    const verdict = assessToolCall({
      tool: tool({ executesCode: true }),
      approval: approvalConfig('yolo'),
      autoApproveReadOnly: true,
      commandVerdict: 'deny',
    });
    expect(verdict.kind).toBe('deny');
  });

  it('lets a plainly read-only command ride the fast path even in ask mode', () => {
    const verdict = assessToolCall({
      tool: tool({ executesCode: true }),
      approval: approvalConfig('ask'),
      autoApproveReadOnly: true,
      commandVerdict: 'allow',
    });
    expect(verdict.kind).toBe('allow');
  });
});

describe('callSignature', () => {
  it('is independent of argument key order', () => {
    const a = callSignature({ id: 'x', name: 'edit_file', argumentsJson: '' }, { a: 1, b: 2 });
    const b = callSignature({ id: 'y', name: 'edit_file', argumentsJson: '' }, { b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it('differs when the tool differs', () => {
    const a = callSignature({ id: 'x', name: 'edit_file', argumentsJson: '' }, { p: 1 });
    const b = callSignature({ id: 'x', name: 'write_file', argumentsJson: '' }, { p: 1 });
    expect(a).not.toBe(b);
  });
});

describe('ApprovalManager', () => {
  const config = approvalConfig('ask');

  it('does not consult the approver for a fast-pathed call', async () => {
    let asked = false;
    const approver: Approver = {
      interactive: true,
      request: async () => {
        asked = true;
        return 'allow-once';
      },
    };
    const manager = new ApprovalManager(approver, config, nullLogger());
    const decision = await manager.authorize({
      call: CALL,
      tool: tool(),
      args: {},
      gate: { kind: 'allow', reason: 'read-only' },
    });
    expect(decision.allowed).toBe(true);
    expect(asked).toBe(false);
  });

  it('refuses an ask when the run cannot prompt and non-interactive approval is off', async () => {
    const manager = new ApprovalManager(denyingApprover, config, nullLogger());
    const decision = await manager.authorize({
      call: CALL,
      tool: tool(),
      args: {},
      gate: { kind: 'ask', reason: 'changes the workspace' },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('cannot prompt');
  });

  it('remembers an allow-session decision for an identical call', async () => {
    let asks = 0;
    const approver: Approver = {
      interactive: true,
      request: async () => {
        asks += 1;
        return 'allow-session';
      },
    };
    const manager = new ApprovalManager(approver, config, nullLogger());
    const first = await manager.authorize({
      call: CALL,
      tool: tool(),
      args: { path: 'a.ts' },
      gate: { kind: 'ask', reason: 'r' },
    });
    const second = await manager.authorize({
      call: { ...CALL, id: 'c2' },
      tool: tool(),
      args: { path: 'a.ts' },
      gate: { kind: 'ask', reason: 'r' },
    });
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    // Asked once; the second was served from memory.
    expect(asks).toBe(1);
    expect(manager.rememberedCount).toBe(1);
  });

  it('does not remember a plain allow-once', async () => {
    const manager = new ApprovalManager(allowingApprover, config, nullLogger());
    await manager.authorize({
      call: CALL,
      tool: tool(),
      args: {},
      gate: { kind: 'ask', reason: 'r' },
    });
    expect(manager.rememberedCount).toBe(0);
  });

  it('reports a denial without throwing', async () => {
    const approver: Approver = { interactive: true, request: async () => 'deny' };
    const manager = new ApprovalManager(approver, config, nullLogger());
    const decision = await manager.authorize({
      call: CALL,
      tool: tool(),
      args: {},
      gate: { kind: 'ask', reason: 'r' },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('denied');
  });
});

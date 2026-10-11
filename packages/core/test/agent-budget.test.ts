/**
 * Budget accounting.
 *
 * The properties under test are exactly the ones that decide whether a run
 * stops and what the user is told: iteration and tool-call ceilings, the
 * distinction between "usage not reported" and "usage is zero", and the
 * wall-clock deadline.
 */

import { describe, expect, it } from 'vitest';

import { Budget, describeStopReason } from '../src/agent/budget.js';
import { withDefaults } from '../src/config/schema.js';

function agentConfig(overrides: Record<string, unknown> = {}) {
  return withDefaults({ agent: overrides }).agent;
}

describe('Budget', () => {
  it('stops at the iteration ceiling', () => {
    const budget = new Budget(agentConfig({ maxIterations: 2 }));
    expect(budget.exhausted()).toBeUndefined();
    budget.beginIteration();
    expect(budget.exhausted()).toBeUndefined();
    budget.beginIteration();
    expect(budget.exhausted()).toBe('budget_iterations');
  });

  it('stops at the tool-call ceiling', () => {
    const budget = new Budget(agentConfig({ maxToolCalls: 3 }));
    for (let i = 0; i < 3; i += 1) budget.recordToolCall();
    expect(budget.exhausted()).toBe('budget_tool_calls');
  });

  it('does not enforce a token ceiling until the provider reports usage', () => {
    const budget = new Budget(agentConfig({ maxTokensPerSession: 1000 }));
    // No usage at all: the budget must not claim the limit was reached, because
    // it has nothing to base that claim on.
    expect(budget.exhausted()).toBeUndefined();
    budget.addUsage({ inputTokens: 900, outputTokens: 200 });
    expect(budget.exhausted()).toBe('budget_tokens');
  });

  it('accumulates input and output separately across turns', () => {
    const budget = new Budget(agentConfig());
    budget.addUsage({ inputTokens: 10, outputTokens: 5 });
    budget.addUsage({ inputTokens: 20, outputTokens: 7 });
    expect(budget.totalTokens).toBe(42);
    expect(budget.snapshot().usageReported).toBe(true);
  });

  it('treats an absent usage report as unknown, not zero', () => {
    const budget = new Budget(agentConfig());
    budget.addUsage(undefined);
    expect(budget.snapshot().usageReported).toBe(false);
    expect(budget.totalTokens).toBe(0);
  });

  it('stops once the wall-clock deadline has passed', () => {
    const start = 1_000_000;
    const budget = new Budget(agentConfig({ maxSessionDurationMs: 10_000 }), start);
    expect(budget.exhausted(start + 5_000)).toBeUndefined();
    expect(budget.exhausted(start + 10_000)).toBe('budget_time');
  });

  it('preserves optional cached and reasoning token counts', () => {
    const budget = new Budget(agentConfig());
    budget.addUsage({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 3, reasoningTokens: 2 });
    budget.addUsage({ inputTokens: 1, outputTokens: 1, cachedInputTokens: 4 });
    expect(budget.usage.cachedInputTokens).toBe(7);
    expect(budget.usage.reasoningTokens).toBe(2);
  });

  it('snapshots consumption against limits for display', () => {
    const budget = new Budget(agentConfig({ maxIterations: 5, maxToolCalls: 9 }), 0);
    budget.beginIteration();
    budget.recordToolCall();
    const snapshot = budget.snapshot(2_000);
    expect(snapshot.iterations).toBe(1);
    expect(snapshot.maxIterations).toBe(5);
    expect(snapshot.toolCalls).toBe(1);
    expect(snapshot.maxToolCalls).toBe(9);
    expect(snapshot.elapsedMs).toBe(2_000);
  });
});

describe('describeStopReason', () => {
  it('explains every stop reason in a sentence', () => {
    for (const reason of [
      'end_turn',
      'max_tokens',
      'content_filter',
      'unknown',
      'budget_iterations',
      'budget_tool_calls',
      'budget_tokens',
      'budget_time',
      'repeated_calls',
      'aborted',
    ] as const) {
      const text = describeStopReason(reason);
      expect(text.length).toBeGreaterThan(0);
      // A reason must never leak the raw enum token to the user.
      expect(text).not.toBe(reason);
    }
  });
});

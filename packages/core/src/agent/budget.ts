/**
 * Session budgets.
 *
 * Every limit that can end a run lives here, in one object with one `check()`,
 * rather than as scattered comparisons in the loop. Three reasons:
 *
 *  - **A run must be able to explain why it stopped.** `check()` returns the
 *    specific `AgentStopReason`, so the terminal can say "stopped: tool-call
 *    budget (200 of 200)" instead of a bare "done". A limit the user cannot see
 *    firing is indistinguishable from a bug.
 *
 *  - **Wall-clock is checked, not awaited.** A session budget measured by a
 *    timer that aborts mid-stream turns a clean stop into a stack trace; instead
 *    the deadline is tested at the loop's own checkpoints and the loop exits
 *    between steps, leaving the transcript coherent.
 *
 *  - **Unknown usage counts as unknown, never as zero.** A provider that omits
 *    token counts must not make the budget appear untouched; `addUsage` tracks
 *    whether any usage was ever reported, and `check()` will not claim a token
 *    budget was exceeded on the strength of fabricated numbers.
 */

import type { TokenUsage } from '../providers/types.js';
import type { AgentConfig } from '../config/schema.js';
import type { AgentStopReason } from './types.js';

/** What the loop has consumed so far. */
export interface BudgetState {
  readonly iterations: number;
  readonly toolCalls: number;
  readonly usage: TokenUsage;
  /** Whether any provider reported usage. Drives whether token budget is enforced. */
  readonly usageReported: boolean;
  readonly startedAtMs: number;
}

/** A snapshot of consumption against limits, for display and assertions. */
export interface BudgetSnapshot {
  readonly iterations: number;
  readonly maxIterations: number;
  readonly toolCalls: number;
  readonly maxToolCalls: number;
  readonly totalTokens: number;
  readonly maxTokens: number;
  readonly elapsedMs: number;
  readonly maxDurationMs: number;
  readonly usageReported: boolean;
}

const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * Tracks consumption and reports which limit, if any, has been reached.
 *
 * Not internally synchronised: the loop drives it from a single async flow, so
 * there is no concurrent writer to guard against.
 */
export class Budget {
  readonly #config: AgentConfig;
  readonly #startedAtMs: number;
  #iterations = 0;
  #toolCalls = 0;
  #usage: TokenUsage = EMPTY_USAGE;
  #usageReported = false;

  constructor(config: AgentConfig, nowMs: number = Date.now()) {
    this.#config = config;
    this.#startedAtMs = nowMs;
  }

  /** Record the start of a model turn. */
  beginIteration(): void {
    this.#iterations += 1;
  }

  /** Record one executed tool call. */
  recordToolCall(): void {
    this.#toolCalls += 1;
  }

  /**
   * Fold a provider's usage report into the running total.
   *
   * Absent counts are treated as unknown, not zero: a provider that reports
   * output but not input must not silently zero the input total.
   */
  addUsage(usage: TokenUsage | undefined): void {
    if (usage === undefined) return;
    this.#usageReported = true;
    this.#usage = {
      inputTokens: this.#usage.inputTokens + usage.inputTokens,
      outputTokens: this.#usage.outputTokens + usage.outputTokens,
      ...optionalSum('cachedInputTokens', this.#usage, usage),
      ...optionalSum('reasoningTokens', this.#usage, usage),
    };
  }

  /** Total tokens billed against the session, input plus output. */
  get totalTokens(): number {
    return this.#usage.inputTokens + this.#usage.outputTokens;
  }

  get iterations(): number {
    return this.#iterations;
  }

  get toolCalls(): number {
    return this.#toolCalls;
  }

  get usage(): TokenUsage {
    return this.#usage;
  }

  /**
   * The limit that has been reached, or `undefined` when the run may continue.
   *
   * Order matters for the message the user sees: iteration and tool-call limits
   * are the deliberate stops, so they are reported before the time limit.
   */
  exhausted(nowMs: number = Date.now()): AgentStopReason | undefined {
    if (this.#iterations >= this.#config.maxIterations) return 'budget_iterations';
    if (this.#toolCalls >= this.#config.maxToolCalls) return 'budget_tool_calls';
    if (this.#usageReported && this.totalTokens >= this.#config.maxTokensPerSession) {
      return 'budget_tokens';
    }
    if (nowMs - this.#startedAtMs >= this.#config.maxSessionDurationMs) return 'budget_time';
    return undefined;
  }

  /** Whether the wall-clock deadline has passed. Checked before starting work. */
  get timedOut(): boolean {
    return Date.now() - this.#startedAtMs >= this.#config.maxSessionDurationMs;
  }

  snapshot(nowMs: number = Date.now()): BudgetSnapshot {
    return {
      iterations: this.#iterations,
      maxIterations: this.#config.maxIterations,
      toolCalls: this.#toolCalls,
      maxToolCalls: this.#config.maxToolCalls,
      totalTokens: this.totalTokens,
      maxTokens: this.#config.maxTokensPerSession,
      elapsedMs: nowMs - this.#startedAtMs,
      maxDurationMs: this.#config.maxSessionDurationMs,
      usageReported: this.#usageReported,
    };
  }
}

/** Sum an optional token field, preserving `undefined` when both sides lack it. */
function optionalSum(
  key: 'cachedInputTokens' | 'reasoningTokens',
  left: TokenUsage,
  right: TokenUsage,
): Partial<TokenUsage> {
  const a = left[key];
  const b = right[key];
  if (a === undefined && b === undefined) return {};
  return { [key]: (a ?? 0) + (b ?? 0) };
}

/** A human-readable sentence explaining a stop reason, for the terminal. */
export function describeStopReason(reason: AgentStopReason): string {
  switch (reason) {
    case 'end_turn':
      return 'finished';
    case 'tool_use':
      return 'finished (pending tool call)';
    case 'max_tokens':
      return 'the model hit its output-token limit';
    case 'stop_sequence':
      return 'the model emitted a stop sequence';
    case 'content_filter':
      return 'the provider filtered the response';
    case 'error':
      return 'the provider reported an error';
    case 'unknown':
      return 'the model stopped for an unrecognised reason';
    case 'budget_iterations':
      return 'the iteration budget was reached';
    case 'budget_tool_calls':
      return 'the tool-call budget was reached';
    case 'budget_tokens':
      return 'the session token budget was reached';
    case 'budget_time':
      return 'the session time budget was reached';
    case 'repeated_calls':
      return 'the agent repeated the same tool call too many times';
    case 'aborted':
      return 'the run was interrupted';
  }
}

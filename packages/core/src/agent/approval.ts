/**
 * Approval gating.
 *
 * A tool call reaches the user only when policy says it must. The decision for
 * a *given* call is made here — by `assessToolCall` — and the interactive asking
 * is delegated to an `Approver` the caller supplies. Splitting the two is what
 * lets the same policy run under a terminal prompt, a `--yes` flag, and a test
 * with a scripted approver, without the policy branching on any of them.
 *
 * The rules, in order:
 *
 *  1. A **read-only** tool under `security.autoApproveReadOnly` runs unprompted.
 *  2. A tool that **executes code** (a shell command) always consults policy.
 *     `command-policy` may still return `allow` for a plainly read-only command,
 *     which `autoApproveReadOnly` then honours.
 *  3. A **mutating** tool is gated by `approval.mode`:
 *       - `yolo`   — run without asking.
 *       - `ask`    — ask unless an identical call was already allowed this session.
 *       - `deny`   — refuse; the model is told the policy forbade it.
 *  4. When `approval.allowNonInteractiveApproval` is false and there is no way
 *     to prompt, an `ask` becomes a refusal rather than a silent yes. A missing
 *     terminal must never be read as consent.
 */

import type { ApprovalConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import type { AgentTool, ApprovalDecision, ApprovalRequest, Approver } from './types.js';
import type { ToolCall } from '../providers/types.js';

/** The outcome of assessing a call before any prompting. */
export type GateVerdict =
  | { readonly kind: 'allow'; readonly reason: string }
  | { readonly kind: 'ask'; readonly reason: string }
  | { readonly kind: 'deny'; readonly reason: string };

/** True for a tool that only reads. */
function isReadOnly(tool: AgentTool): boolean {
  return !tool.mutating && !tool.executesCode;
}

/**
 * Decide whether a call may run, must be asked about, or is refused — before
 * the user is involved.
 *
 * `assessedCommand` is the command policy's verdict for a shell call, when the
 * tool provides one; it lets a plainly read-only command ride the read-only
 * fast path.
 */
export function assessToolCall(input: {
  readonly tool: AgentTool;
  readonly approval: ApprovalConfig;
  readonly autoApproveReadOnly: boolean;
  /** For `run_command`: the command policy's own verdict. */
  readonly commandVerdict?: 'allow' | 'ask' | 'deny';
}): GateVerdict {
  const { tool, approval, autoApproveReadOnly, commandVerdict } = input;

  // A `deny` from the command policy is absolute: no approval mode, including
  // `yolo`, softens it. That is what "refuses deny-tier operations outright"
  // means, and it is the only place a policy refusal cannot be overridden.
  if (tool.executesCode && commandVerdict === 'deny') {
    return { kind: 'deny', reason: 'the command policy refused this command' };
  }

  // Read-only work is fast-pathed first, at every mode.
  if (isReadOnly(tool) && autoApproveReadOnly) {
    return { kind: 'allow', reason: 'read-only tool, auto-approved' };
  }

  switch (approval.mode) {
    case 'read-only':
      // The most conservative mode: reads ride the fast path above; everything
      // that can change the workspace or run code is asked about.
      return { kind: 'ask', reason: 'this mode asks before any change' };

    case 'ask':
      // A command the policy already blessed as plainly read-only needs no
      // prompt even here — asking to run `ls` would train the user to approve
      // without reading.
      if (tool.executesCode && commandVerdict === 'allow' && autoApproveReadOnly) {
        return { kind: 'allow', reason: 'read-only command, auto-approved' };
      }
      return { kind: 'ask', reason: 'this tool changes the workspace' };

    case 'auto-safe':
      // Autonomous on confined file edits (which are checkpointed and cannot
      // touch write-protected files); careful only about shell, where the
      // command policy's `ask` means destructive or unrecognised.
      if (tool.executesCode && commandVerdict !== 'allow') {
        return { kind: 'ask', reason: 'the command is destructive or unrecognised' };
      }
      return { kind: 'allow', reason: 'auto-safe mode permits this operation' };

    case 'yolo':
      return { kind: 'allow', reason: 'approval mode is yolo' };
  }
}

/**
 * Detects identical repeated approvals so `rememberSessionDecisions` can apply.
 *
 * The key is the tool name plus a canonical rendering of its arguments. Object
 * key order is normalised so the same logical call hashes identically however
 * the model ordered its JSON.
 */
export function callSignature(call: ToolCall, args: unknown): string {
  return `${call.name}:${canonicalJson(args)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Coordinates gating and session-scoped memory of decisions. */
export class ApprovalManager {
  readonly #approver: Approver;
  readonly #config: ApprovalConfig;
  readonly #log: Logger;
  readonly #remembered = new Set<string>();

  constructor(approver: Approver, config: ApprovalConfig, log: Logger) {
    this.#approver = approver;
    this.#config = config;
    this.#log = log;
  }

  /**
   * Resolve a call to a final decision.
   *
   * Returns `true` when the call may proceed. A refusal is not an error: the
   * caller turns it into a tool result telling the model the action was denied,
   * which the model can route around.
   */
  async authorize(input: {
    readonly call: ToolCall;
    readonly tool: AgentTool;
    readonly args: Readonly<Record<string, unknown>>;
    readonly gate: GateVerdict;
    readonly preview?: string;
  }): Promise<{ readonly allowed: boolean; readonly reason: string }> {
    const { call, tool, args, gate, preview } = input;

    if (gate.kind === 'allow') return { allowed: true, reason: gate.reason };
    if (gate.kind === 'deny') return { allowed: false, reason: gate.reason };

    // gate.kind === 'ask'
    const signature = callSignature(call, args);
    if (this.#config.rememberSessionDecisions && this.#remembered.has(signature)) {
      return { allowed: true, reason: 'previously approved this session' };
    }

    if (!this.#config.allowNonInteractiveApproval && !this.#approver.interactive) {
      // An approver that cannot reach a human cannot obtain consent; refusing is
      // the only safe reading of an unanswered question.
      return { allowed: false, reason: 'approval required, but this run cannot prompt' };
    }

    const request: ApprovalRequest = {
      call,
      tool,
      args,
      reason: gate.reason,
      ...(preview === undefined ? {} : { preview }),
    };
    const decision: ApprovalDecision = await this.#approver.request(request);

    if (decision === 'deny') {
      this.#log.debug('approval denied', { tool: tool.name });
      return { allowed: false, reason: 'the user denied this action' };
    }
    if (decision === 'allow-session' && this.#config.rememberSessionDecisions) {
      this.#remembered.add(signature);
    }
    return { allowed: true, reason: 'approved by the user' };
  }

  /** Number of session-remembered approvals, for tests and diagnostics. */
  get rememberedCount(): number {
    return this.#remembered.size;
  }
}

/**
 * An approver that always refuses.
 *
 * The correct default for a non-interactive caller that has not opted in via
 * `allowNonInteractiveApproval`: it makes "no one is watching" a refusal rather
 * than an accidental approval.
 */
export const denyingApprover: Approver = {
  interactive: false,
  request: async () => 'deny',
};

/** An approver that always allows — for `--yes` and tests. */
export const allowingApprover: Approver = {
  interactive: false,
  request: async () => 'allow-once',
};

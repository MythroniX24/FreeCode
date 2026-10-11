/**
 * The agent's shared vocabulary.
 *
 * These types sit between the tools and the loop, and between the loop and
 * whatever is rendering it (the CLI today, the gateway later). Three decisions
 * are load-bearing:
 *
 *  - **The loop emits `AgentEvent`s rather than printing.** Every byte a user
 *    sees is an event the caller chose to render, so the same loop drives an
 *    interactive terminal, a JSON stream, and a test with no terminal at all.
 *    A loop that wrote to stdout could not be tested for what it *decided* to do.
 *
 *  - **A tool result is data, never an exception.** A denied path, a non-zero
 *    exit, a timeout — all are `ToolResult`s handed back to the model to reason
 *    about. Only a defect (a bug in a tool) throws. This is what lets the agent
 *    recover from `cat` on a file that does not exist instead of the session
 *    dying on it.
 *
 *  - **Budgets are explicit and checked at declared points**, not sprinkled as
 *    `if (tokens > limit)` in the loop body. See `budget.ts`.
 */

import type {
  ChatMessage,
  StreamEvent,
  ToolCall,
  TokenUsage,
  StopReason,
} from '../providers/types.js';
import type { AgentConfig, ApprovalConfig, SecurityConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tool results
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The outcome of running one tool.
 *
 * `content` is what the model sees. `display` is what a human sees, when the
 * two should differ (a diff for an edit, a path list for a directory read).
 * Keeping them separate is why `edit_file` can return a terse confirmation to
 * the model while the terminal shows a full diff.
 */
export interface ToolResult {
  /** Text handed back to the model as the tool message. */
  readonly content: string;
  /** Whether the tool failed. Rendered to the model, not thrown. */
  readonly isError: boolean;
  /** Optional richer rendition for the terminal (never sent to the model). */
  readonly display?: ToolDisplay;
  /** Files this call touched, for checkpointing and change summaries. */
  readonly changedPaths?: readonly string[];
  /** Bytes of output produced, for the transcript and budget accounting. */
  readonly bytes?: number;
}

/** A renderable summary of a tool's effect, for the terminal. */
export type ToolDisplay =
  | { readonly kind: 'diff'; readonly path: string; readonly diff: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'paths'; readonly paths: readonly string[] }
  | { readonly kind: 'command'; readonly command: string; readonly exitCode: number };

/** The minimal per-call facts a tool receives. */
export interface ToolInvocation {
  /** The tool call as the model produced it. */
  readonly call: ToolCall;
  /** Parsed arguments. Parsing happened once, at this boundary. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

/** A tool the agent can run. */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments. */
  readonly parameters: Readonly<Record<string, unknown>>;
  /**
   * Whether this tool can change the workspace.
   *
   * Drives checkpointing and approval: a read-only tool never creates a
   * checkpoint and (under `autoApproveReadOnly`) never prompts.
   */
  readonly mutating: boolean;
  /**
   * Whether this tool can run arbitrary code. Such calls are always surfaced to
   * the approval layer regardless of other settings.
   */
  readonly executesCode: boolean;
  run(invocation: ToolInvocation): Promise<ToolResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the loop reports.
 *
 * A caller renders these; it never receives the raw provider stream. This is
 * the seam that keeps terminal concerns out of the loop.
 */
export type AgentEvent =
  | { readonly type: 'iteration'; readonly index: number; readonly max: number }
  | { readonly type: 'assistant_text'; readonly delta: string }
  | { readonly type: 'assistant_reasoning'; readonly delta: string }
  | { readonly type: 'assistant_message'; readonly text: string }
  | { readonly type: 'tool_call'; readonly call: ToolCall; readonly arguments: unknown }
  | {
      readonly type: 'tool_result';
      readonly call: ToolCall;
      readonly result: ToolResult;
      readonly durationMs: number;
    }
  | {
      readonly type: 'approval_request';
      readonly call: ToolCall;
      readonly reason: string;
    }
  | { readonly type: 'usage'; readonly usage: TokenUsage; readonly total: TokenUsage }
  | { readonly type: 'checkpoint'; readonly id: string; readonly paths: readonly string[] }
  | { readonly type: 'notice'; readonly level: 'info' | 'warn'; readonly message: string }
  | { readonly type: 'stopped'; readonly reason: StopReason; readonly message: string }
  | { readonly type: 'error'; readonly error: Error };

/** Consumes events. May be async; the loop awaits it, so rendering stays ordered. */
export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;

// ─────────────────────────────────────────────────────────────────────────────
// Approval
// ─────────────────────────────────────────────────────────────────────────────

/** A request put to the user before a tool runs. */
export interface ApprovalRequest {
  readonly call: ToolCall;
  readonly tool: AgentTool;
  readonly args: Readonly<Record<string, unknown>>;
  /** Why approval is being sought, in the user's terms. */
  readonly reason: string;
  /** A short preview of what will happen (the command, the diff, the paths). */
  readonly preview?: string;
}

/**
 * The user's answer. `allow-session` means "yes, and stop asking about this
 * identical request for the rest of the session" — the mechanism behind
 * `approval.rememberSessionDecisions`.
 */
export type ApprovalDecision = 'allow-once' | 'allow-session' | 'deny';

/** Decides whether a tool call may proceed. */
export interface Approver {
  /**
   * Whether this approver can actually reach a human.
   *
   * A non-interactive caller (no TTY, a scripted run) sets this false. Policy
   * reads it so that "nobody can be asked" becomes a refusal rather than an
   * accidental yes — unless `approval.allowNonInteractiveApproval` explicitly
   * opted into unattended operation.
   */
  readonly interactive: boolean;
  request(input: ApprovalRequest): Promise<ApprovalDecision>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session result
// ─────────────────────────────────────────────────────────────────────────────

/** Why the loop ended, beyond the provider's own stop reason. */
export type AgentStopReason =
  | StopReason
  | 'budget_iterations'
  | 'budget_tool_calls'
  | 'budget_tokens'
  | 'budget_time'
  | 'repeated_calls'
  | 'aborted';

/** The final state of a run. */
export interface AgentRunResult {
  /** The model's last assistant text, if any. */
  readonly text: string;
  readonly stopReason: AgentStopReason;
  readonly usage: TokenUsage;
  readonly iterations: number;
  readonly toolCalls: number;
  /** Workspace paths mutated during the run. */
  readonly changedPaths: readonly string[];
  /** A terse, human-readable summary of how it ended. */
  readonly message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies & options
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the loop needs, injected so tests never touch the network. */
export interface AgentDeps {
  /** Sends a chat request. A provider today; a router in a later phase. */
  readonly chat: (request: {
    readonly messages: readonly ChatMessage[];
    readonly tools: readonly AgentTool[];
    readonly signal: AbortSignal;
  }) => AsyncGenerator<StreamEvent, void, undefined>;
  /** The tools available this run. */
  readonly tools: readonly AgentTool[];
  readonly config: AgentConfig;
  readonly security: SecurityConfig;
  readonly approval: ApprovalConfig;
  readonly logger: Logger;
  readonly emit: AgentEventSink;
  readonly approver: Approver;
  /** Optional checkpoint manager. Absent when checkpointing is disabled. */
  readonly checkpoints?: CheckpointManager;
}

/** Runtime knobs for one run, separate from persistent config. */
export interface AgentRunOptions {
  /** The user's request. */
  readonly prompt: string;
  /** A system prompt assembled by the caller (identity, tool guidance). */
  readonly systemPrompt?: string;
  /** Workspace context appended to the system prompt, when enabled. */
  readonly workspaceContext?: string;
  /** Prior turns, for a continuing session. */
  readonly history?: readonly ChatMessage[];
  readonly model: string;
  readonly signal?: AbortSignal;
  /** Overrides the configured temperature for this run. */
  readonly temperature?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Checkpoints
// ─────────────────────────────────────────────────────────────────────────────

/** A point the workspace can be returned to. */
export interface Checkpoint {
  readonly id: string;
  /** ISO-8601 creation time. */
  readonly createdAt: string;
  /** Paths captured at creation. */
  readonly paths: readonly string[];
  /** Free-form label, e.g. "before edit_file src/a.ts". */
  readonly label: string;
}

/** Captures and restores workspace state. */
export interface CheckpointManager {
  create(label: string, paths: readonly string[]): Promise<Checkpoint | undefined>;
  restore(id: string): Promise<readonly string[]>;
  list(): Promise<readonly Checkpoint[]>;
  /** The most recent checkpoint, for `undo`. */
  latest(): Promise<Checkpoint | undefined>;
}

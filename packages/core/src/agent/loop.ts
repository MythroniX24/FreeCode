/**
 * The agent loop.
 *
 * One turn is: send the conversation to the provider, stream the reply, and if
 * it asked for tools, run them and go again. The loop owns *sequencing and
 * policy*, not I/O: it emits `AgentEvent`s and the caller renders them.
 *
 * The properties this file is responsible for:
 *
 *  - **Budgets end the run cleanly between steps.** Limits are checked at the
 *    top of each iteration and after each tool batch, never mid-stream, so the
 *    transcript always ends on a coherent turn.
 *
 *  - **A failing tool does not fail the run.** A denied path, a refused
 *    approval, a non-zero exit — each becomes a tool result the model can read
 *    and react to. Only an exception from *our own code* propagates.
 *
 *  - **Tool arguments are parsed exactly once**, here, at the boundary. A
 *    malformed argument string is reported back to the model as a tool error
 *    rather than thrown: models emit bad JSON, and the retry usually fixes it.
 *
 *  - **A repeated identical call stops the loop.** A model that calls the same
 *    tool with the same arguments `repeatedCallThreshold` times is looping, and
 *    burning tokens to watch it is not helping anyone.
 */

import { InterruptedError, toFreecodeError } from '../errors.js';
import { ToolCallAccumulator } from '../providers/sse.js';
import type { ChatMessage, StopReason, TokenUsage, ToolCall } from '../providers/types.js';
import { ApprovalManager, assessToolCall } from './approval.js';
import { Budget, describeStopReason } from './budget.js';
import type {
  AgentDeps,
  AgentRunOptions,
  AgentRunResult,
  AgentStopReason,
  AgentTool,
  ToolResult,
} from './types.js';

/** Consecutive identical calls are counted against this many distinct signatures. */
const MAX_TRACKED_SIGNATURES = 64;

export async function runAgent(deps: AgentDeps, options: AgentRunOptions): Promise<AgentRunResult> {
  const { config, approval, logger, emit } = deps;
  const budget = new Budget(config);

  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  const messages: ChatMessage[] = [...(options.history ?? [])];
  const system = composeSystem(options);
  if (system !== undefined) messages.unshift({ role: 'system', content: system });
  messages.push({ role: 'user', content: options.prompt });

  const approvals = new ApprovalManager(deps.approver, approval, logger);
  const repeatCounts = new Map<string, number>();
  const changedPaths = new Set<string>();
  let toolCallCount = 0;
  let lastText = '';

  try {
    for (;;) {
      const exhausted = budget.exhausted();
      if (exhausted !== undefined) {
        return finish(exhausted, budget, lastText, changedPaths, toolCallCount);
      }
      if (controller.signal.aborted) {
        return finish('aborted', budget, lastText, changedPaths, toolCallCount);
      }

      budget.beginIteration();
      await emit({ type: 'iteration', index: budget.iterations, max: config.maxIterations });

      const turn = await runModelTurn(deps, {
        messages,
        model: options.model,
        signal: controller.signal,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      });

      budget.addUsage(turn.usage);
      if (turn.usage !== undefined) {
        await emit({ type: 'usage', usage: turn.usage, total: budget.usage });
      }

      if (turn.text !== '') {
        lastText = turn.text;
        await emit({ type: 'assistant_message', text: turn.text });
      }

      // The assistant turn must be replayed verbatim before its tool results,
      // including the calls, or providers that validate turn structure reject
      // the follow-up request.
      messages.push(
        turn.toolCalls.length === 0
          ? { role: 'assistant', content: turn.text }
          : { role: 'assistant', content: turn.text, toolCalls: turn.toolCalls },
      );

      if (turn.toolCalls.length === 0) {
        const reason: AgentStopReason = turn.stopReason === 'error' ? 'error' : 'end_turn';
        return finish(reason, budget, lastText, changedPaths, toolCallCount);
      }

      // Checkpoint once for the whole batch, before any mutating call runs.
      const mutating = turn.toolCalls
        .map((call) => deps.tools.find((t) => t.name === call.name))
        .filter((t): t is AgentTool => t !== undefined && t.mutating);
      if (deps.checkpoints !== undefined && mutating.length > 0) {
        const preview = await collectTargets(mutating, turn.toolCalls);
        const checkpoint = await deps.checkpoints.create(
          `before ${mutating.map((t) => t.name).join(', ')}`,
          preview,
        );
        if (checkpoint !== undefined) {
          await emit({ type: 'checkpoint', id: checkpoint.id, paths: checkpoint.paths });
        }
      }

      for (const call of turn.toolCalls) {
        if (controller.signal.aborted) {
          return finish('aborted', budget, lastText, changedPaths, toolCallCount);
        }
        if (budget.exhausted() !== undefined) break;

        budget.recordToolCall();
        toolCallCount += 1;
        const result = await executeCall(deps, approvals, call, controller.signal, changedPaths);
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        });
      }

      const repeated = noteRepeat(turn.toolCalls, repeatCounts, config.repeatedCallThreshold);
      if (repeated !== undefined) {
        await emit({
          type: 'notice',
          level: 'warn',
          message: `the agent repeated the same call ${config.repeatedCallThreshold} times`,
        });
        return finish('repeated_calls', budget, lastText, changedPaths, toolCallCount);
      }
    }
  } catch (error) {
    if (error instanceof InterruptedError || controller.signal.aborted) {
      return finish('aborted', budget, lastText, changedPaths, toolCallCount);
    }
    const freecode = toFreecodeError(error);
    await emit({ type: 'error', error: freecode });
    return finish('error', budget, lastText, changedPaths, toolCallCount, freecode.message);
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}

interface ModelTurn {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly stopReason: StopReason;
  readonly usage: TokenUsage | undefined;
}

/** Send one request and reduce the stream to a single turn. */
async function runModelTurn(
  deps: AgentDeps,
  input: {
    readonly messages: readonly ChatMessage[];
    readonly model: string;
    readonly signal: AbortSignal;
    readonly temperature?: number;
  },
): Promise<ModelTurn> {
  const accumulator = new ToolCallAccumulator();
  let text = '';
  let usage: TokenUsage | undefined;
  let stopReason: StopReason = 'unknown';
  let streamError: Error | undefined;

  const stream = deps.chat({
    messages: input.messages,
    tools: deps.tools,
    signal: input.signal,
  });

  for await (const event of stream) {
    switch (event.type) {
      case 'text':
        text += event.delta;
        await deps.emit({ type: 'assistant_text', delta: event.delta });
        break;
      case 'reasoning':
        await deps.emit({ type: 'assistant_reasoning', delta: event.delta });
        break;
      case 'tool_call_start':
        accumulator.start(event.index, event.id, event.name);
        break;
      case 'tool_call_delta':
        accumulator.append(event.index, event.delta);
        break;
      case 'tool_call_end':
        accumulator.append(event.index, '');
        break;
      case 'usage':
        usage = event.usage;
        break;
      case 'done':
        stopReason = event.stopReason;
        if (event.usage !== undefined) usage = event.usage;
        break;
      case 'error':
        streamError = event.error;
        break;
      default:
        break;
    }
  }

  if (streamError !== undefined) throw streamError;

  const toolCalls: ToolCall[] = accumulator.all().map((c) => ({
    id: c.id,
    name: c.name,
    argumentsJson: c.argumentsJson,
  }));

  return { text, toolCalls, stopReason, usage };
}

/** Gate, approve, and run one tool call, turning every failure into a result. */
async function executeCall(
  deps: AgentDeps,
  approvals: ApprovalManager,
  call: ToolCall,
  signal: AbortSignal,
  changedPaths: Set<string>,
): Promise<ToolResult> {
  const tool = deps.tools.find((t) => t.name === call.name);
  if (tool === undefined) {
    return {
      content: `Unknown tool “${call.name}”. Available tools: ${deps.tools
        .map((t) => t.name)
        .join(', ')}.`,
      isError: true,
    };
  }

  const parsed = parseArguments(call.argumentsJson);
  if (!parsed.ok) {
    return {
      content: `The arguments for “${call.name}” were not valid JSON: ${parsed.error}. Re-send the call with well-formed arguments.`,
      isError: true,
    };
  }
  const args = parsed.value;
  await deps.emit({ type: 'tool_call', call, arguments: args });

  const gate = assessToolCall({
    tool,
    approval: deps.approval,
    autoApproveReadOnly: deps.security.autoApproveReadOnly,
  });
  const decision = await approvals.authorize({ call, tool, args, gate });
  if (!decision.allowed) {
    const result: ToolResult = {
      content: `Action not permitted: ${decision.reason}.`,
      isError: true,
    };
    await deps.emit({ type: 'tool_result', call, result, durationMs: 0 });
    return result;
  }

  const startedAt = Date.now();
  let result: ToolResult;
  try {
    result = await tool.run({ call, args, signal });
  } catch (error) {
    // A tool throwing is a defect, but it must not take down the session: the
    // model is told and can try another route.
    const message = toFreecodeError(error).message;
    deps.logger.warn('tool threw', { tool: tool.name, error: message });
    result = { content: `The tool “${tool.name}” failed unexpectedly: ${message}`, isError: true };
  }

  for (const changed of result.changedPaths ?? []) changedPaths.add(changed);
  await deps.emit({
    type: 'tool_result',
    call,
    result,
    durationMs: Date.now() - startedAt,
  });
  return result;
}

type ParsedArgs =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: string };

function parseArguments(json: string): ParsedArgs {
  const trimmed = json.trim();
  if (trimmed === '') return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'expected a JSON object' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Count identical calls; return the offending signature when the threshold trips. */
function noteRepeat(
  calls: readonly ToolCall[],
  counts: Map<string, number>,
  threshold: number,
): string | undefined {
  for (const call of calls) {
    const key = `${call.name}:${call.argumentsJson}`;
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    // Bound the map so a long session cannot grow it without limit.
    if (counts.size > MAX_TRACKED_SIGNATURES) {
      const oldest = counts.keys().next().value;
      if (oldest !== undefined) counts.delete(oldest);
    }
    if (next >= threshold) return key;
  }
  return undefined;
}

/** Gather the workspace paths a batch of mutating calls will touch. */
async function collectTargets(
  tools: readonly AgentTool[],
  calls: readonly ToolCall[],
): Promise<readonly string[]> {
  const paths = new Set<string>();
  for (const call of calls) {
    const tool = tools.find((t) => t.name === call.name);
    if (tool === undefined) continue;
    const parsed = parseArguments(call.argumentsJson);
    if (!parsed.ok) continue;
    const candidate = parsed.value['path'];
    if (typeof candidate === 'string') paths.add(candidate);
    const candidates = parsed.value['paths'];
    if (Array.isArray(candidates)) {
      for (const c of candidates) if (typeof c === 'string') paths.add(c);
    }
  }
  return [...paths];
}

function composeSystem(options: AgentRunOptions): string | undefined {
  const parts = [options.systemPrompt, options.workspaceContext].filter(
    (p): p is string => typeof p === 'string' && p !== '',
  );
  return parts.length === 0 ? undefined : parts.join('\n\n');
}

function finish(
  reason: AgentStopReason,
  budget: Budget,
  text: string,
  changedPaths: Set<string>,
  toolCalls: number,
  detail?: string,
): AgentRunResult {
  const base = describeStopReason(reason);
  return {
    text,
    stopReason: reason,
    usage: budget.usage,
    iterations: budget.iterations,
    toolCalls,
    changedPaths: [...changedPaths].sort(),
    message: detail === undefined ? base : `${base} — ${detail}`,
  };
}

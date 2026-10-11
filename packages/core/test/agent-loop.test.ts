/**
 * The agent loop, driven by a scripted provider.
 *
 * No network, no timing, no filesystem: the provider is a function that yields a
 * fixed sequence of events per turn. That makes the loop's *decisions* — when it
 * stops, what it feeds back, what it refuses — directly assertable, which is the
 * whole reason the loop emits events instead of printing.
 */

import { describe, expect, it } from 'vitest';

import { runAgent } from '../src/agent/loop.js';
import { allowingApprover, denyingApprover } from '../src/agent/approval.js';
import { withDefaults } from '../src/config/schema.js';
import { nullLogger } from '../src/util/logger.js';
import type { AgentDeps, AgentEvent, AgentTool } from '../src/agent/types.js';
import type { StreamEvent } from '../src/providers/types.js';

/** A tool whose result is fixed, for asserting what the loop fed back. */
function echoTool(
  name: string,
  result: { content: string; isError: boolean },
  opts: { mutating?: boolean } = {},
): AgentTool {
  return {
    name,
    description: 'test tool',
    parameters: { type: 'object', properties: {} },
    mutating: opts.mutating ?? false,
    executesCode: false,
    run: async () => result,
  };
}

/** Build a provider that replays `turns` in order, then ends. */
function scriptedProvider(turns: readonly (readonly StreamEvent[])[]): AgentDeps['chat'] {
  let index = 0;
  return async function* () {
    const turn = turns[index] ?? [];
    index += 1;
    for (const event of turn) yield event;
  };
}

function textTurn(
  text: string,
  usage?: { inputTokens: number; outputTokens: number },
): StreamEvent[] {
  return [
    { type: 'start', id: 'r1', model: 'm' },
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'end_turn', ...(usage === undefined ? {} : { usage }) },
  ];
}

function toolTurn(
  calls: readonly { id: string; name: string; args: string }[],
  usage?: { inputTokens: number; outputTokens: number },
): StreamEvent[] {
  const events: StreamEvent[] = [{ type: 'start', id: 'r1', model: 'm' }];
  calls.forEach((call, i) => {
    events.push({ type: 'tool_call_start', index: i, id: call.id, name: call.name });
    events.push({ type: 'tool_call_delta', index: i, delta: call.args });
    events.push({ type: 'tool_call_end', index: i, argumentsJson: call.args });
  });
  events.push({ type: 'done', stopReason: 'tool_use', ...(usage === undefined ? {} : { usage }) });
  return events;
}

function makeDeps(overrides: Partial<AgentDeps> = {}): { deps: AgentDeps; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const defaults = withDefaults({});
  const deps: AgentDeps = {
    chat: scriptedProvider([textTurn('done')]),
    tools: [],
    config: defaults.agent,
    security: defaults.security,
    approval: defaults.approval,
    logger: nullLogger(),
    emit: (event) => {
      events.push(event);
    },
    approver: allowingApprover,
    ...overrides,
  };
  return { deps, events };
}

describe('runAgent', () => {
  it('finishes on a plain text turn and returns the text', async () => {
    const { deps, events } = makeDeps({ chat: scriptedProvider([textTurn('hello there')]) });
    const result = await runAgent(deps, { prompt: 'hi', model: 'm' });
    expect(result.stopReason).toBe('end_turn');
    expect(result.text).toBe('hello there');
    expect(result.iterations).toBe(1);
    expect(events.some((e) => e.type === 'assistant_message' && e.text === 'hello there')).toBe(
      true,
    );
  });

  it('runs a tool call, feeds the result back, and continues', async () => {
    let sawToolMessage = false;
    const chat: AgentDeps['chat'] = async function* (request) {
      // On the second turn, the conversation must contain the tool result.
      if (request.messages.some((m) => m.role === 'tool')) sawToolMessage = true;
      yield* request.messages.some((m) => m.role === 'tool')
        ? textTurn('all done')
        : toolTurn([{ id: 't1', name: 'read_file', args: '{"path":"a.ts"}' }]);
    };
    const { deps } = makeDeps({
      chat,
      tools: [echoTool('read_file', { content: 'file contents', isError: false })],
    });
    const result = await runAgent(deps, { prompt: 'read a', model: 'm' });
    expect(result.text).toBe('all done');
    expect(result.toolCalls).toBe(1);
    expect(sawToolMessage).toBe(true);
  });

  it('reports a tool error to the model without throwing', async () => {
    const seen: string[] = [];
    const chat: AgentDeps['chat'] = async function* (request) {
      const tool = request.messages.find((m) => m.role === 'tool');
      if (tool !== undefined && 'content' in tool) seen.push(tool.content);
      yield* tool === undefined
        ? toolTurn([{ id: 't1', name: 'read_file', args: '{"path":"missing"}' }])
        : textTurn('ok');
    };
    const { deps } = makeDeps({
      chat,
      tools: [echoTool('read_file', { content: 'No such file: missing', isError: true })],
    });
    const result = await runAgent(deps, { prompt: 'read', model: 'm' });
    expect(result.stopReason).toBe('end_turn');
    expect(seen[0]).toContain('No such file');
  });

  it('reports malformed tool arguments back to the model instead of crashing', async () => {
    const seen: string[] = [];
    const chat: AgentDeps['chat'] = async function* (request) {
      const tool = request.messages.find((m) => m.role === 'tool');
      if (tool !== undefined && 'content' in tool) seen.push(tool.content);
      yield* tool === undefined
        ? toolTurn([{ id: 't1', name: 'read_file', args: '{not json' }])
        : textTurn('ok');
    };
    const { deps } = makeDeps({
      chat,
      tools: [echoTool('read_file', { content: 'unused', isError: false })],
    });
    const result = await runAgent(deps, { prompt: 'read', model: 'm' });
    expect(result.stopReason).toBe('end_turn');
    expect(seen[0]).toContain('not valid JSON');
  });

  it('turns an unknown tool into a result listing the available tools', async () => {
    let content = '';
    const chat: AgentDeps['chat'] = async function* (request) {
      const tool = request.messages.find((m) => m.role === 'tool');
      if (tool !== undefined && 'content' in tool) content = tool.content;
      yield* tool === undefined
        ? toolTurn([{ id: 't1', name: 'made_up', args: '{}' }])
        : textTurn('ok');
    };
    const { deps } = makeDeps({
      chat,
      tools: [echoTool('read_file', { content: '', isError: false })],
    });
    await runAgent(deps, { prompt: 'go', model: 'm' });
    expect(content).toContain('Unknown tool');
    expect(content).toContain('read_file');
  });

  it('refuses a gated call under a denying approver and tells the model', async () => {
    let content = '';
    const chat: AgentDeps['chat'] = async function* (request) {
      const tool = request.messages.find((m) => m.role === 'tool');
      if (tool !== undefined && 'content' in tool) content = tool.content;
      yield* tool === undefined
        ? toolTurn([{ id: 't1', name: 'write_file', args: '{"path":"a.ts","content":"x"}' }])
        : textTurn('stopped');
    };
    const ran = { count: 0 };
    const writeTool: AgentTool = {
      name: 'write_file',
      description: 'w',
      parameters: {},
      mutating: true,
      executesCode: false,
      run: async () => {
        ran.count += 1;
        return { content: 'wrote', isError: false };
      },
    };
    const { deps } = makeDeps({
      chat,
      tools: [writeTool],
      approver: denyingApprover,
      approval: withDefaults({ approval: { mode: 'ask', allowNonInteractiveApproval: false } })
        .approval,
    });
    const result = await runAgent(deps, { prompt: 'write', model: 'm' });
    expect(result.stopReason).toBe('end_turn');
    expect(ran.count).toBe(0); // The tool never ran.
    expect(content).toContain('not permitted');
  });

  it('stops when the iteration budget is exhausted', async () => {
    // A provider that always asks for a tool; the loop must still stop.
    const chat: AgentDeps['chat'] = async function* () {
      yield* toolTurn([{ id: 't', name: 'read_file', args: '{"path":"a"}' }]);
    };
    const { deps } = makeDeps({
      chat,
      tools: [echoTool('read_file', { content: 'x', isError: false })],
      config: withDefaults({ agent: { maxIterations: 3, repeatedCallThreshold: 20 } }).agent,
    });
    const result = await runAgent(deps, { prompt: 'loop', model: 'm' });
    expect(result.stopReason).toBe('budget_iterations');
    expect(result.iterations).toBe(3);
  });

  it('stops when the same call repeats past the threshold', async () => {
    const chat: AgentDeps['chat'] = async function* () {
      yield* toolTurn([{ id: 't', name: 'read_file', args: '{"path":"a"}' }]);
    };
    const { deps, events } = makeDeps({
      chat,
      tools: [echoTool('read_file', { content: 'x', isError: false })],
      config: withDefaults({
        agent: { maxIterations: 100, repeatedCallThreshold: 3 },
      }).agent,
    });
    const result = await runAgent(deps, { prompt: 'loop', model: 'm' });
    expect(result.stopReason).toBe('repeated_calls');
    expect(events.some((e) => e.type === 'notice' && e.level === 'warn')).toBe(true);
  });

  it('stops on the token budget once usage is reported', async () => {
    const chat: AgentDeps['chat'] = async function* () {
      yield* toolTurn([{ id: 't', name: 'read_file', args: '{"path":"a"}' }], {
        inputTokens: 5000,
        outputTokens: 1000,
      });
    };
    const { deps } = makeDeps({
      chat,
      tools: [echoTool('read_file', { content: 'x', isError: false })],
      config: withDefaults({
        agent: { maxTokensPerSession: 5000, maxIterations: 100, repeatedCallThreshold: 20 },
      }).agent,
    });
    const result = await runAgent(deps, { prompt: 'go', model: 'm' });
    expect(result.stopReason).toBe('budget_tokens');
  });

  it('stops cleanly when the signal is already aborted', async () => {
    const { deps } = makeDeps();
    const controller = new AbortController();
    controller.abort();
    const result = await runAgent(deps, { prompt: 'x', model: 'm', signal: controller.signal });
    expect(result.stopReason).toBe('aborted');
  });

  it('includes a system prompt and history before the user prompt', async () => {
    const roles: string[] = [];
    const chat: AgentDeps['chat'] = async function* (request) {
      for (const message of request.messages) roles.push(message.role);
      yield* textTurn('ok');
    };
    const { deps } = makeDeps({ chat });
    await runAgent(deps, {
      prompt: 'now',
      model: 'm',
      systemPrompt: 'you are helpful',
      history: [
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'reply' },
      ],
    });
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
  });
});

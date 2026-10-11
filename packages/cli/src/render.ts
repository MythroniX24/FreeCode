/**
 * Terminal rendering of agent events.
 *
 * The renderer owns every byte a user sees. It is deliberately the only place
 * that knows about colour, diff formatting, and the `output.*` config — the
 * agent loop emits structured events and knows nothing of any of it.
 *
 * Colour is applied through a tiny helper rather than a dependency: the rules
 * are "no colour when not a TTY, none when `NO_COLOR` is set, none when
 * `output.color` is `never`", and that is not worth a package. Whether stdout is
 * a TTY is captured at construction so tests can drive the renderer with a
 * buffer and assert on plain text.
 */

import { diffStats, formatDiff } from '@freecode/core';
import type { AgentEvent, AgentRunResult, OutputConfig, ToolResult } from '@freecode/core';

export interface RendererOptions {
  readonly output: OutputConfig;
  /** Where rendered text goes. Defaults to stdout. */
  readonly write: (chunk: string) => void;
  /** Whether to use colour. Defaults to stdout being a TTY. */
  readonly color?: boolean;
}

const ANSI = {
  reset: '[0m',
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  cyan: '[36m',
  bold: '[1m',
} as const;

export class AgentRenderer {
  readonly #write: (chunk: string) => void;
  readonly #color: boolean;
  readonly #output: OutputConfig;
  /** Whether an assistant text line is currently open (mid-stream). */
  #inText = false;

  constructor(options: RendererOptions) {
    this.#output = options.output;
    this.#write = options.write;
    this.#color =
      options.color ??
      (process.stdout.isTTY === true &&
        process.env['NO_COLOR'] === undefined &&
        options.output.color !== 'never');
  }

  render(event: AgentEvent): void {
    switch (event.type) {
      case 'iteration':
        this.#closeText();
        if (event.index > 1) this.#line(this.#paint('dim', `— step ${event.index}/${event.max} —`));
        break;

      case 'assistant_text':
        this.#write(event.delta);
        this.#inText = true;
        break;

      case 'assistant_reasoning':
        // Reasoning is off by default: it is long, and rarely what a user wants
        // to read. It is still emitted so a future `--show-reasoning` can use it.
        break;

      case 'assistant_message':
        this.#closeText();
        break;

      case 'tool_call':
        this.#closeText();
        this.#line(
          `${this.#paint('cyan', '▸')} ${this.#paint('bold', event.call.name)}${this.#summariseArgs(event.arguments)}`,
        );
        break;

      case 'tool_result':
        this.#renderToolResult(event.result, event.durationMs);
        break;

      case 'checkpoint':
        if (this.#output.showToolActivity) {
          this.#line(this.#paint('dim', `  ↳ checkpoint ${event.id}`));
        }
        break;

      case 'notice':
        this.#closeText();
        this.#line(this.#paint(event.level === 'warn' ? 'yellow' : 'dim', `  ${event.message}`));
        break;

      case 'usage':
        if (this.#output.showUsage) this.#renderUsage(event.usage, event.total);
        break;

      case 'error':
        this.#closeText();
        this.#line(this.#paint('red', `error: ${event.error.message}`));
        break;

      case 'stopped':
        this.#closeText();
        this.#line(this.#paint('dim', `stopped: ${event.message}`));
        break;

      default:
        break;
    }
  }

  /** Print the closing summary after the loop returns. */
  finish(result: AgentRunResult): void {
    this.#closeText();
    const parts = [`${result.iterations} step(s)`, `${result.toolCalls} tool call(s)`];
    if (result.usage.inputTokens + result.usage.outputTokens > 0) {
      parts.push(`${result.usage.inputTokens + result.usage.outputTokens} tokens`);
    }
    if (result.changedPaths.length > 0) parts.push(`${result.changedPaths.length} file(s) changed`);
    this.#line(this.#paint('dim', `• ${result.message} · ${parts.join(' · ')}`));
  }

  #renderToolResult(result: ToolResult, durationMs: number): void {
    const marker = result.isError ? this.#paint('red', '  ✗') : this.#paint('green', '  ✓');
    const display = result.display;

    if (display?.kind === 'diff' && this.#output.showDiffs) {
      const lines = display.diff.split('\n');
      this.#line(`${marker} ${this.#paint('dim', `${durationMs}ms`)}`);
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++'))
          this.#line(this.#paint('green', `  ${line}`));
        else if (line.startsWith('-') && !line.startsWith('---'))
          this.#line(this.#paint('red', `  ${line}`));
        else this.#line(this.#paint('dim', `  ${line}`));
      }
      return;
    }

    if (display?.kind === 'command' && this.#output.showToolActivity) {
      const status =
        display.exitCode === 0
          ? this.#paint('green', 'exit 0')
          : this.#paint('red', `exit ${display.exitCode}`);
      this.#line(`${marker} ${status} ${this.#paint('dim', `${durationMs}ms`)}`);
      return;
    }

    if (this.#output.showToolActivity) {
      this.#line(`${marker} ${this.#paint('dim', `${durationMs}ms`)}`);
    }
  }

  #renderUsage(
    usage: { inputTokens: number; outputTokens: number },
    total: { inputTokens: number; outputTokens: number },
  ): void {
    this.#line(
      this.#paint(
        'dim',
        `  tokens: in ${usage.inputTokens} out ${usage.outputTokens} · session ${total.inputTokens + total.outputTokens}`,
      ),
    );
  }

  /** A terse one-line summary of tool arguments, so the user sees what it will do. */
  #summariseArgs(args: unknown): string {
    if (args === null || typeof args !== 'object') return '';
    const record = args as Record<string, unknown>;
    const path = record['path'];
    if (typeof path === 'string') return ` ${this.#paint('dim', path)}`;
    const command = record['command'];
    if (typeof command === 'string') return ` ${this.#paint('dim', command)}`;
    const pattern = record['pattern'];
    if (typeof pattern === 'string') return ` ${this.#paint('dim', `/${pattern}/`)}`;
    return '';
  }

  /** Close an open assistant text line so the next label starts on its own line. */
  #closeText(): void {
    if (this.#inText) {
      this.#write('\n');
      this.#inText = false;
    }
  }

  #line(text: string): void {
    this.#write(`${text}\n`);
  }

  #paint(color: keyof typeof ANSI, text: string): string {
    if (!this.#color) return text;
    return `${ANSI[color]}${text}${ANSI.reset}`;
  }
}

/** Re-exported so a caller can build a diff preview without the renderer. */
export { formatDiff, diffStats };

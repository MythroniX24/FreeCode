/**
 * SSE framing tests.
 *
 * Streams are hostile input: they arrive split at arbitrary byte offsets, end
 * without warning, and carry keepalives interleaved with payloads. A parser that
 * only works when each chunk happens to be one whole event looks fine against a
 * hand-written fixture and corrupts real responses.
 */

import { describe, expect, it } from 'vitest';

import {
  SSE_DONE,
  SseParser,
  ToolCallAccumulator,
  decodeEventData,
  isDoneEvent,
  parseEventBlock,
  readSseEvents,
} from '../src/providers/sse.js';

const encoder = new TextEncoder();

/** Feed a parser a list of chunks, then flush. */
function parseAll(chunks: readonly string[]): string[] {
  const parser = new SseParser();
  const out: string[] = [];
  for (const chunk of chunks) {
    for (const event of parser.push(chunk)) out.push(event.data);
  }
  for (const event of parser.flush()) out.push(event.data);
  return out;
}

describe('event framing', () => {
  it('parses a simple data event', () => {
    expect(parseAll(['data: hello\n\n'])).toEqual(['hello']);
  });

  it('parses several events in one chunk', () => {
    expect(parseAll(['data: one\n\ndata: two\n\n'])).toEqual(['one', 'two']);
  });

  it('strips exactly one leading space after the colon', () => {
    // The space is framing, not content; two spaces means the value starts with one.
    expect(parseEventBlock('data:  x')?.data).toBe(' x');
    expect(parseEventBlock('data:x')?.data).toBe('x');
  });

  it('accepts a bare field name as an empty value', () => {
    // `data` with no colon is a valid empty-data line; the block is non-empty
    // because a data line exists, so it is not treated as a keepalive.
    expect(parseEventBlock('data')?.data).toBe('');
  });
});

describe('chunk boundaries', () => {
  it('reassembles an event split across chunks', () => {
    expect(parseAll(['data: he', 'llo\n', '\n'])).toEqual(['hello']);
  });

  it('reassembles an event split mid-line at every position', () => {
    // Exhaustive: every single split point of a two-event stream must work.
    const stream = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
    for (let i = 0; i <= stream.length; i += 1) {
      expect(parseAll([stream.slice(0, i), stream.slice(i)]), `split at ${i}`).toEqual([
        '{"a":1}',
        '{"b":2}',
      ]);
    }
  });

  it('holds a partial multi-byte character across a byte boundary', () => {
    // "café" — the é is two bytes. Splitting between them must not produce U+FFFD,
    // which is the classic streaming-corruption bug.
    const bytes = encoder.encode('data: café\n\n');
    const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of é

    const parser = new SseParser();
    const events = [
      ...parser.pushBytes(bytes.slice(0, cut)),
      ...parser.pushBytes(bytes.slice(cut)),
    ];
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('café');
    expect(events[0]?.data).not.toContain('�');
  });

  it('handles an emoji split across chunks', () => {
    const bytes = encoder.encode('data: 🎉\n\n');
    // Cut inside the 4-byte sequence.
    const parser = new SseParser();
    const events = [...parser.pushBytes(bytes.slice(0, 8)), ...parser.pushBytes(bytes.slice(8))];
    expect(events[0]?.data).toBe('🎉');
  });

  it('accepts CRLF terminators', () => {
    expect(parseAll(['data: one\r\n\r\ndata: two\r\n\r\n'])).toEqual(['one', 'two']);
  });

  it('does not treat a CRLF terminator as two boundaries', () => {
    expect(parseAll(['data: x\r\n\r\n'])).toEqual(['x']);
  });
});

describe('multi-line data', () => {
  it('joins several data lines with a newline', () => {
    // Providers that pretty-print JSON send one data line per source line.
    const event = parseEventBlock('data: {\ndata: "a": 1\ndata: }');
    expect(event?.data).toBe('{\n"a": 1\n}');
  });

  it('round-trips pretty-printed JSON through the parser', () => {
    const payload = JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }, null, 2);
    const wire = `${payload
      .split('\n')
      .map((line) => `data: ${line}`)
      .join('\n')}\n\n`;
    const [event] = parseAll([wire]);
    expect(JSON.parse(event!)).toEqual({ choices: [{ delta: { content: 'hi' } }] });
  });
});

describe('comments and keepalives', () => {
  it('ignores a comment-only block', () => {
    // `: ping` is the keepalive several providers send during long tool calls.
    expect(parseAll([': ping\n\n'])).toEqual([]);
  });

  it('ignores a comment line inside a data block', () => {
    expect(parseEventBlock(': keepalive\ndata: real')?.data).toBe('real');
  });

  it('yields nothing for a block with no data line', () => {
    expect(parseEventBlock('event: message')).toBeUndefined();
    expect(parseEventBlock('')).toBeUndefined();
  });

  it('ignores interleaved keepalives without disturbing payloads', () => {
    expect(parseAll([': ping\n\ndata: a\n\n: ping\n\ndata: b\n\n'])).toEqual(['a', 'b']);
  });
});

describe('named events and ids', () => {
  it('captures the event name', () => {
    const event = parseEventBlock('event: content_block_delta\ndata: {}');
    expect(event?.event).toBe('content_block_delta');
    expect(event?.data).toBe('{}');
  });

  it('captures the id', () => {
    expect(parseEventBlock('id: 42\ndata: x')?.id).toBe('42');
  });

  it('omits absent fields rather than setting them undefined', () => {
    const event = parseEventBlock('data: x');
    expect(event).not.toHaveProperty('event');
    expect(event).not.toHaveProperty('id');
  });
});

describe('truncated streams', () => {
  it('delivers a final event that never got its blank line', () => {
    // The socket closed right after the last chunk. Dropping this event would
    // silently truncate the model's output.
    expect(parseAll(['data: last'])).toEqual(['last']);
  });

  it('delivers a trailing event after complete ones', () => {
    expect(parseAll(['data: a\n\ndata: b'])).toEqual(['a', 'b']);
  });

  it('flushes nothing for a trailing blank', () => {
    const parser = new SseParser();
    parser.push('data: a\n\n');
    expect(parser.flush()).toEqual([]);
  });

  it('flushes nothing for whitespace only', () => {
    const parser = new SseParser();
    parser.push('\n\n   ');
    expect(parser.flush()).toEqual([]);
  });
});

describe('done sentinel', () => {
  it('recognises [DONE]', () => {
    expect(isDoneEvent({ data: SSE_DONE })).toBe(true);
    expect(isDoneEvent({ data: ' [DONE] ' })).toBe(true);
    expect(isDoneEvent({ data: '{"x":1}' })).toBe(false);
  });

  it('decodes a data payload', () => {
    expect(decodeEventData({ data: '{"a":1}' })).toEqual({ data: { a: 1 } });
  });

  it('returns undefined for the sentinel rather than throwing', () => {
    expect(decodeEventData({ data: SSE_DONE })).toBeUndefined();
  });

  it('returns undefined for empty data', () => {
    expect(decodeEventData({ data: '  ' })).toBeUndefined();
  });

  it('reports malformed JSON as an error result rather than throwing', () => {
    // A single unparseable chunk must not abort a half-delivered response.
    const result = decodeEventData({ data: '{"a":' });
    expect(result).toBeDefined();
    expect('error' in result!).toBe(true);
  });
});

describe('reset', () => {
  it('discards buffered state', () => {
    const parser = new SseParser();
    parser.push('data: partial');
    parser.reset();
    expect(parser.flush()).toEqual([]);
  });
});

describe('readSseEvents', () => {
  /** Build a ReadableStream from a list of byte chunks. */
  function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
    let index = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index]!);
        index += 1;
      },
    });
  }

  it('yields every event from a multi-chunk body', async () => {
    const body = streamOf([encoder.encode('data: a\n\ndata: '), encoder.encode('b\n\n')]);
    const seen: string[] = [];
    for await (const event of readSseEvents(body)) seen.push(event.data);
    expect(seen).toEqual(['a', 'b']);
  });

  it('yields a trailing event with no terminator', async () => {
    const body = streamOf([encoder.encode('data: tail')]);
    const seen: string[] = [];
    for await (const event of readSseEvents(body)) seen.push(event.data);
    expect(seen).toEqual(['tail']);
  });

  it('throws when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));
    const body = streamOf([encoder.encode('data: a\n\n')]);
    await expect(
      (async () => {
        for await (const _event of readSseEvents(body, { signal: controller.signal })) {
          // Drain.
        }
      })(),
    ).rejects.toThrow('user cancelled');
  });

  it('reports a stalled stream rather than hanging', async () => {
    // A body that produces one event and then never closes: without an idle
    // bound the loop would wait forever while the terminal appears frozen.
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) controller.enqueue(encoder.encode('data: a\n\n'));
        // Otherwise: never enqueue and never close.
      },
    });

    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const event of readSseEvents(body, { idleTimeoutMs: 50, label: 'test' })) {
          seen.push(event.data);
        }
      })(),
    ).rejects.toThrow(/stalled/);
    // The event delivered before the stall must still have been yielded.
    expect(seen).toEqual(['a']);
  });

  it('enforces a total timeout across a slow but never-idle stream', async () => {
    // Each chunk arrives inside the idle window, so only the total bound can
    // stop it — this is the case an idle-only implementation would miss.
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 20));
        controller.enqueue(encoder.encode('data: x\n\n'));
      },
    });

    await expect(
      (async () => {
        for await (const _event of readSseEvents(body, {
          idleTimeoutMs: 0,
          totalTimeoutMs: 60,
          label: 'test',
        })) {
          // Drain.
        }
      })(),
    ).rejects.toThrow(/total timeout/);
  });
});

describe('ToolCallAccumulator', () => {
  it('accumulates fragments for one call', () => {
    const acc = new ToolCallAccumulator();
    acc.start(0, 'call_1', 'read_file');
    acc.append(0, '{"path":');
    acc.append(0, '"a.ts"}');
    expect(acc.get(0)).toEqual({
      id: 'call_1',
      name: 'read_file',
      argumentsJson: '{"path":"a.ts"}',
    });
  });

  it('tracks parallel calls by index', () => {
    const acc = new ToolCallAccumulator();
    acc.start(0, 'c0', 'read_file');
    acc.start(1, 'c1', 'list_files');
    acc.append(0, '{"a":1}');
    acc.append(1, '{"b":2}');
    expect(acc.all()).toEqual([
      { id: 'c0', name: 'read_file', argumentsJson: '{"a":1}' },
      { id: 'c1', name: 'list_files', argumentsJson: '{"b":2}' },
    ]);
  });

  it('keeps the first id when a later fragment sends an empty one', () => {
    // Providers repeat the fragment for an in-progress call with empty id/name
    // fields rather than omitting them; overwriting would erase the real id.
    const acc = new ToolCallAccumulator();
    acc.start(0, 'real-id', 'real-name');
    acc.start(0, '', '');
    expect(acc.get(0)?.id).toBe('real-id');
    expect(acc.get(0)?.name).toBe('real-name');
  });

  it('creates an entry for a delta with no preceding start', () => {
    // Some servers omit the start fragment entirely.
    const acc = new ToolCallAccumulator();
    acc.append(2, '{"x":1}');
    expect(acc.get(2)?.argumentsJson).toBe('{"x":1}');
  });

  it('preserves arrival order regardless of index numbering', () => {
    const acc = new ToolCallAccumulator();
    acc.start(3, 'c3', 'third');
    acc.start(1, 'c1', 'first');
    expect(acc.all().map((c) => c.id)).toEqual(['c3', 'c1']);
  });

  it('reports the number of calls and clears', () => {
    const acc = new ToolCallAccumulator();
    acc.start(0, 'a', 'x');
    acc.start(1, 'b', 'y');
    expect(acc.size).toBe(2);
    acc.clear();
    expect(acc.size).toBe(0);
    expect(acc.all()).toEqual([]);
  });
});

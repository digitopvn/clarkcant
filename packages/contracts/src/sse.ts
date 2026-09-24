/**
 * Server-Sent Events, split the same way by every reader of the node's streams: the web client, the WebSocket that
 * relays a stream as frames, and the CLI.
 */

/** One frame of a server-sent event stream. */
export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Split one chunk of an event stream into complete frames, keeping the incomplete tail.
 *
 * Incremental by design: a chunk boundary can fall anywhere, including in the middle of the event
 * name or of a multi-byte character, so a parser that only understands whole frames would drop text
 * at exactly the sizes nobody tests with.
 *
 * Comment frames — the ones a server sends to keep a connection alive — carry no data and are
 * dropped. Returning them would mean every keep-alive arrived at the caller as an empty event.
 */
export function parseSseChunk(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = buffer;
  for (;;) {
    // The frame separator is the transport's to choose, so both spellings are accepted.
    const separator = /\r?\n\r?\n/.exec(rest);
    if (separator === null) break;
    const frame = rest.slice(0, separator.index);
    rest = rest.slice(separator.index + separator[0].length);
    const parsed = parseSseFrame(frame);
    if (parsed !== undefined) events.push(parsed);
  }
  return { events, rest };
}

function parseSseFrame(frame: string): SseEvent | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    // A line starting with a colon is a comment, and an empty line inside a frame is padding.
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // One optional space after the colon belongs to the format, not to the value.
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length === 0 ? undefined : { event, data: data.join("\n") };
}

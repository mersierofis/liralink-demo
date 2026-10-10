// Confirm/cancel feedback reaches the model only as a server-generated <system_event> block.
// The merchant must not be able to type one, so the tag is stripped from everything they send.

const TAG = /<\s*\/?\s*system[\s_-]*event[^>]*>/gi;

export function stripSystemEventTags(text: string): string {
  let out = text;
  let prev: string;
  do {
    prev = out;
    out = out.replace(TAG, '');
  } while (out !== prev); // "<system_<system_event>event>" collapses until stable
  return out;
}

export const systemEvent = (text: string): string =>
  `<system_event>${stripSystemEventTags(text)}</system_event>`;

const MAX_LENGTH = 4096;

/** Tags whose open/close state is tracked across chunk boundaries. */
const TRACKED_TAGS = new Set([
  "b",
  "i",
  "u",
  "s",
  "code",
  "pre",
  "blockquote",
  "a",
]);

interface OpenTag {
  name: string;
  /** Attribute string, e.g. `href="https://example.com"` */
  attrs: string;
}

function openTagStr(tag: OpenTag): string {
  return tag.attrs ? `<${tag.name} ${tag.attrs}>` : `<${tag.name}>`;
}

function stackCloseStr(stack: readonly OpenTag[]): string {
  return [...stack]
    .reverse()
    .map((t) => `</${t.name}>`)
    .join("");
}

function stackOpenStr(stack: readonly OpenTag[]): string {
  return stack.map(openTagStr).join("");
}

/**
 * Split an HTML string into chunks of at most `maxLength` characters.
 *
 * When a chunk boundary falls inside open HTML tags, the chunk is closed
 * with the appropriate closing tags and the next chunk is reopened with the
 * matching opening tags, preserving attributes (e.g. href on <a>).
 *
 * Split preference order: newline → space → forced.
 */
export function chunkMessage(
  html: string,
  maxLength: number = MAX_LENGTH,
): string[] {
  const chunks: string[] = [];
  const stack: OpenTag[] = [];
  let current = "";

  /** Close open tags, push chunk, reopen tags for next chunk. */
  function flush(): void {
    const close = stackCloseStr(stack);
    const chunk = current + close;
    if (chunk.trim().length > 0) {
      chunks.push(chunk);
    }
    current = stackOpenStr(stack);
  }

  /**
   * Returns true if adding `addition` to current, with `futureStack` as the
   * resulting open-tag state, would still fit within maxLength.
   */
  function fitsInCurrent(addition: string, futureStack: OpenTag[]): boolean {
    const close = stackCloseStr(futureStack);
    return current.length + addition.length + close.length <= maxLength;
  }

  // Tokenise: either an HTML tag (<tag ...> or </tag>) or a run of text.
  const TOKEN_RE = /<\/?[a-zA-Z][^>]*>|[^<]+/g;
  const tokens = html.match(TOKEN_RE) ?? [];

  for (const token of tokens) {
    // ── Text token ──────────────────────────────────────────────────────────
    if (!token.startsWith("<")) {
      let remaining = token;

      while (remaining.length > 0) {
        const close = stackCloseStr(stack);
        const available = maxLength - current.length - close.length;

        if (remaining.length <= available) {
          current += remaining;
          break;
        }

        if (available <= 0) {
          flush();
          // Safety: if the tag prefix alone fills maxLength, bail out.
          const newAvail =
            maxLength - current.length - stackCloseStr(stack).length;
          if (newAvail <= 0) break;
          continue;
        }

        // Find the best split point within the available window.
        const sub = remaining.slice(0, available);
        let splitAt = available;

        const nl = sub.lastIndexOf("\n");
        if (nl > 0) {
          splitAt = nl + 1; // include the newline in this chunk
        } else {
          const sp = sub.lastIndexOf(" ");
          if (sp > 0) {
            splitAt = sp + 1; // include the space in this chunk
          }
          // else: forced split at `available`
        }

        current += remaining.slice(0, splitAt);
        remaining = remaining.slice(splitAt);
        flush();
      }
      continue;
    }

    // ── HTML tag token ───────────────────────────────────────────────────────
    const isClose = token.startsWith("</");
    const nameMatch = token.match(/<\/?(\w+)/);
    if (!nameMatch) continue;

    const name = nameMatch[1].toLowerCase();
    const tracked = TRACKED_TAGS.has(name);

    if (isClose) {
      // Locate the last matching open tag in the stack.
      let stackIdx = -1;
      for (let j = stack.length - 1; j >= 0; j--) {
        if (stack[j].name === name) {
          stackIdx = j;
          break;
        }
      }

      // Compute what the stack will look like after closing this tag.
      const futureStack: OpenTag[] =
        tracked && stackIdx !== -1
          ? [
              ...stack.slice(0, stackIdx),
              ...stack.slice(stackIdx + 1),
            ]
          : [...stack];

      if (!fitsInCurrent(token, futureStack)) {
        flush();
      }

      current += token;

      if (tracked && stackIdx !== -1) {
        stack.splice(stackIdx, 1);
      }
    } else {
      // Opening tag — extract attribute string for tracked tags.
      const attrsMatch = token.match(/^<\w+((?:\s+[^>]*)?)>/);
      const attrs = attrsMatch ? attrsMatch[1].trim() : "";

      const futureStack: OpenTag[] = tracked
        ? [...stack, { name, attrs }]
        : [...stack];

      if (!fitsInCurrent(token, futureStack)) {
        flush();
      }

      current += token;

      if (tracked) {
        stack.push({ name, attrs });
      }
    }
  }

  // Flush any remaining content.
  const close = stackCloseStr(stack);
  const final = current + close;
  if (final.trim().length > 0) {
    chunks.push(final);
  }

  return chunks.filter((c) => c.trim().length > 0);
}

/**
 * Escape HTML special characters for Telegram HTML parse mode.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert Markdown text to Telegram-safe HTML.
 *
 * Supported output tags: <b>, <i>, <u>, <s>, <code>, <pre>,
 * <a href="...">, <blockquote>
 *
 * Strategy:
 *  1. Extract fenced/inline code blocks into placeholders
 *  2. Escape HTML entities in remaining text
 *  3. Convert Markdown inline formatting
 *  4. Convert headers
 *  5. Collect adjacent blockquote lines
 *  6. Restore code placeholders as <pre>/<code>
 */
export function markdownToTelegramHtml(md: string): string {
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // Step 1a: Extract fenced code blocks (``` lang \n code \n ```)
  let text = md.replace(
    /```([^\n]*)\n([\s\S]*?)```/g,
    (_match, _lang: string, code: string) => {
      const idx = codeBlocks.length;
      codeBlocks.push(code);
      return `\x00CODEBLOCK_${idx}\x00`;
    },
  );

  // Step 1b: Extract inline code (` code `)
  text = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `\x00INLINE_${idx}\x00`;
  });

  // Step 2: Escape HTML entities in the remaining text
  text = escapeHtml(text);

  // Step 3: Convert Markdown inline formatting

  // Bold: **text**
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic: *text* (single asterisk, content must not contain * or newline)
  text = text.replace(/\*([^*\n]+)\*/g, "<i>$1</i>");

  // Strikethrough: ~~text~~
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links: [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Step 4: Headers (# through ######) → <b>header text</b>
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Step 5: Blockquotes
  // After HTML escaping, ">" at the start of a line becomes "&gt;".
  // Collect adjacent blockquote lines into a single <blockquote> element.
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("&gt; ") || lines[i] === "&gt;") {
      const blockLines: string[] = [];
      while (
        i < lines.length &&
        (lines[i].startsWith("&gt; ") || lines[i] === "&gt;")
      ) {
        blockLines.push(lines[i].replace(/^&gt;[ ]?/, ""));
        i++;
      }
      result.push(`<blockquote>${blockLines.join("\n")}</blockquote>`);
    } else {
      result.push(lines[i]);
      i++;
    }
  }
  text = result.join("\n");

  // Step 6: Restore code placeholders with properly escaped content

  // Fenced code blocks → <pre>
  text = text.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_match, idx: string) => {
    const raw = codeBlocks[parseInt(idx, 10)] ?? "";
    // Trim trailing newline that the regex capture group includes
    const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    return `<pre>${escapeHtml(normalized)}</pre>`;
  });

  // Inline code → <code>
  text = text.replace(/\x00INLINE_(\d+)\x00/g, (_match, idx: string) => {
    const raw = inlineCodes[parseInt(idx, 10)] ?? "";
    return `<code>${escapeHtml(raw)}</code>`;
  });

  return text;
}

/**
 * Remove all HTML tags from a string and decode basic HTML entities.
 */
export function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

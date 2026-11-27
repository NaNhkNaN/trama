// The program in a model's reply, where the reply was to be a program and
// nothing else: what stands in its fences, where it is fenced. For the
// runner, where it asks its agent for a program — and for a program that
// asks its agent for one (it has this with `ctx` and the rest).

/** A line of a reply that could be the edge of a fenced block: three or more backticks. */
interface Fence {
  /** Where its backticks start, where its line does, and where the next line does. */
  at: number;
  line: number;
  next: number;
  ticks: number;
  /** It could open a block: nothing follows it on its line but a word for what the block holds. */
  opens: boolean;
  /** It could close one: nothing stands before it on its line. */
  closes: boolean;
}

const NAMED = /[\w.+#-]*\s*\n/y;

/** The fences of a text, in the order they stand in. */
function fencesOf(text: string): Fence[] {
  const fences: Fence[] = [];
  for (const run of text.matchAll(/`{3,}/g)) {
    const at = run.index, ticks = run[0].length;
    const line = text.lastIndexOf("\n", at - 1) + 1;
    const newline = text.indexOf("\n", at);
    NAMED.lastIndex = at + ticks;
    const opens = NAMED.test(text);
    const closes = text.slice(line, at).trim() === "";
    if (opens || closes) fences.push({ at, line, next: newline === -1 ? text.length : newline + 1, ticks, opens, closes });
  }
  return fences;
}

/**
 * A reader of the comments of `text` from `from` on, to be asked of one
 * fence after another, in order, whether it stands in one — and so is the
 * program's own text: a program may show how it is used, between fences, in
 * a comment.
 *
 * Only a comment that begins its line is one here (as a comment that holds
 * lines of its own does): `src/*.ts` in a sentence, or in a command, opens
 * nothing. Nothing else of the language is read — a string or a template
 * literal cannot hold a line of backticks anyway.
 */
function commentsFrom(text: string, from: number): { holds(fence: Fence): boolean; open(): boolean } {
  const marks = /^[ \t]*\/\*|\*\//gm;
  let at = from, open = false;
  const readTo = (end: number) => {
    marks.lastIndex = at;
    for (let mark; (mark = marks.exec(text)) !== null && mark.index < end; ) open = mark[0] !== "*/";
    at = end;
    return open;
  };
  return {
    holds: (fence) => readTo(fence.at) || /^[ \t]*\/\//.test(text.slice(fence.line, fence.at)),
    open: () => readTo(text.length),
  };
}

/**
 * The program in an LLM reply that was asked to contain nothing else: the last
 * fenced block if there is one (models add explanations, or show a "before"
 * first), otherwise the whole text.
 *
 * A program may hold fences of its own, in a comment. So a reply in which
 * every fence stands in a comment was not fenced at all; and a block ends at
 * the first closing fence, of backticks enough, that does not stand in a
 * comment of the block — or, if there is none such (the block is no program,
 * its comment never ends, it was opened with more backticks than it is
 * closed with), at the first closing fence there is.
 *
 * What this still takes wrongly, where the plain reading would not: a line
 * that begins as a comment begins — among the words, or in another block:
 * `/*.log` in a list of files to ignore, a snippet cut off inside a comment —
 * when what ends a comment comes only further on, past a fence. Then the
 * fences between are taken for a program's own, and the reply comes out
 * whole, or as two blocks and the words between them. It is not a program,
 * and the validation that follows says so.
 */
export function stripCodeFences(text: string): string {
  const reply = text.trim();
  const fences = fencesOf(reply);
  const whole = commentsFrom(reply, 0);
  if (fences.every((fence) => whole.holds(fence)) && !whole.open()) return reply;

  let last: string | undefined;
  for (let from = 0; ; ) {
    const opener = fences.find((fence) => fence.opens && fence.at >= from);
    if (!opener) break;
    const closers = fences.filter((fence) => fence.at >= opener.next && fence.closes);
    const inBlock = commentsFrom(reply, opener.next);
    const closer = closers.find((fence) => fence.ticks >= opener.ticks && !inBlock.holds(fence)) ?? closers[0];
    if (closer) last = reply.slice(opener.next, closer.line).trim();
    from = (closer ?? opener).at + (closer ?? opener).ticks;
  }
  return last ?? reply;
}

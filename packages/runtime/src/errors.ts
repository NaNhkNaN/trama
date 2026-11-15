/** What went wrong, in words: an error's message, and anything else that was thrown as it reads. */
export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

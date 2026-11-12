/**
 * Run `fn` once if `signal` is already aborted or when it aborts, and return
 * a cleanup function that detaches the listener.
 */
export function onAbort(signal: AbortSignal | undefined, fn: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    fn();
    return () => {};
  }
  signal.addEventListener("abort", fn, { once: true });
  return () => signal.removeEventListener("abort", fn);
}

/**
 * Reject as soon as `signal` is aborted, whether or not `work` itself notices.
 * What `work` goes on to do after that is no longer waited for.
 */
export function rejectOnAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const off = onAbort(signal, () => reject(new Error("Aborted")));
    work.then(
      value => { off(); resolve(value); },
      err => { off(); reject(err); },
    );
  });
}

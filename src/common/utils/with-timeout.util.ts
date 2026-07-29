/**
 * Races `promise` against a timeout so a slow dependency (e.g. Redis during an
 * outage) can't hold a caller open indefinitely. Rejects with an Error whose
 * message identifies the timed-out operation, distinct from the underlying
 * promise's own rejection reason.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

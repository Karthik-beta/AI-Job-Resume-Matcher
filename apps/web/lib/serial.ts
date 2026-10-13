// Runs tasks one at a time, in the order they were queued. A task starts once the previous one
// settled, whether it resolved or threw; each caller still gets its own task's result or error.
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };
}

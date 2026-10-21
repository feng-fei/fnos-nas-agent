/**
 * Serialize persistence writes without allowing one failed operation to poison
 * the queue. Each caller still receives the result (or error) of its own work.
 */
export function createSerialWriteQueue() {
  let tail = Promise.resolve();
  return function enqueue(work) {
    if (typeof work !== "function") throw new TypeError("work must be a function");
    const current = tail.then(work, work);
    tail = current.then(() => undefined, () => undefined);
    return current;
  };
}

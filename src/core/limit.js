/**
 * Gioi han so task chay song song (thay cho p-limit, khong can dependency).
 */

/**
 * @param {number} concurrency
 * @returns {<T>(fn: () => Promise<T>) => Promise<T>}
 */
export function createLimiter(concurrency) {
  const max = Math.max(1, Math.floor(concurrency) || 1);
  let active = 0;
  /** @type {Array<() => void>} */
  const queue = [];

  const next = () => {
    if (active >= max) return;
    const run = queue.shift();
    if (run) {
      active += 1;
      run();
    }
  };

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });
  };
}

/**
 * Chay cac task song song co gioi han, luon tra ve ket qua dang settled.
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} concurrency
 * @returns {Promise<Array<{status: 'fulfilled', value: T} | {status: 'rejected', reason: unknown}>>}
 */
export async function mapSettledLimit(tasks, concurrency) {
  const limit = createLimiter(concurrency);
  return Promise.all(
    tasks.map((t) =>
      limit(t).then(
        (value) => /** @type {const} */ ({ status: 'fulfilled', value }),
        (reason) => /** @type {const} */ ({ status: 'rejected', reason }),
      ),
    ),
  );
}

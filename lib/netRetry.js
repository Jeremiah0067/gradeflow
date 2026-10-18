// Retry helper for weak or dropping internet.
// - Waits while the phone is offline (the wait does not use up a retry).
// - Retries only failures that are likely to pass on a second try (network drops, timeouts, busy server).
// - Does NOT retry real refusals such as "not allowed" or "file too large", which would never succeed.

export class StoppedError extends Error {
  constructor() {
    super('Stopped.');
    this.stopped = true;
  }
}

export function statusOf(err) {
  const n = Number(err?.status ?? err?.statusCode ?? err?.originalError?.status);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const RETRY_STATUSES = [408, 425, 429, 500, 502, 503, 504];
const NETWORK_WORDS = /failed to fetch|networkerror|network request|network error|load failed|timed? ?out|timeout|aborted|econn|socket|fetch failed|connection/i;

export function isTransient(err) {
  if (!err || err.stopped) return false;
  const status = statusOf(err);
  if (status !== null) return RETRY_STATUSES.includes(status);
  return err.name === 'TypeError' || NETWORK_WORDS.test(String(err.message || err));
}

const defaultIsOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves when the phone is back online, or when the caller asks to stop.
function defaultWaitOnline(shouldStop) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve();
    const done = () => {
      window.removeEventListener('online', done);
      clearInterval(timer);
      resolve();
    };
    const timer = setInterval(() => {
      if (shouldStop() || defaultIsOnline()) done();
    }, 1000);
    window.addEventListener('online', done);
  });
}

export async function withRetry(
  fn,
  { attempts = 5, baseMs = 1000, isOnline = defaultIsOnline, waitOnline = defaultWaitOnline, sleep = defaultSleep, shouldStop = () => false, onRetry } = {}
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (shouldStop()) throw new StoppedError();
    if (!isOnline()) {
      await waitOnline(shouldStop);
      if (shouldStop()) throw new StoppedError();
    }
    try {
      return await fn(attempt);
    } catch (err) {
      if (!isTransient(err) || attempt === attempts) throw err;
      const delay = baseMs * 3 ** (attempt - 1); // 1s, 3s, 9s, 27s
      if (onRetry) onRetry({ attempt, delay, error: err });
      await sleep(delay);
    }
  }
}

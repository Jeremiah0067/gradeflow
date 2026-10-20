// Runs the "grade all" queue. Pure logic, no screen and no network, so it can be tested on its own.
//
// When the AI service says it is busy ("rate limited"), a script is NOT a failure:
//  - it goes back to the front of the queue,
//  - every worker waits for as long as the service asked,
//  - then only ONE script at a time is in flight until a few go through cleanly, so we stop hammering the service.
// If the service says the whole day's allowance is used, the run stops and the rest stay queued.

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runGradingQueue({
  ids,
  callGrade,
  concurrency = 3,
  sleep = defaultSleep,
  now = Date.now,
  shouldStop = () => false,
  onProgress = () => {},
  onPause = () => {},
  maxLimitRetries = 8,
  calmAfter = 4,
}) {
  const queue = [...ids];
  const limitHits = {};
  const s = { done: 0, failed: 0, skipped: 0, escalated: 0, problems: [], limitMessage: '' };
  let pauseUntil = 0;
  let limited = false;
  let calmStreak = 0;
  let stopAll = false;
  let pauseShown = false;
  let inFlight = 0;

  async function worker() {
    while (queue.length > 0 && !shouldStop() && !stopAll) {
      const wait = pauseUntil - now();
      if (wait > 0) {
        pauseShown = true;
        onPause(Math.ceil(wait / 1000));
        await sleep(Math.min(wait, 1000));
        continue;
      }
      if (pauseShown) {
        pauseShown = false;
        onPause(0);
      }
      // After a limit, a worker starts a script only when no other script is being marked.
      // (This cannot get stuck: with nothing in flight, any worker may go.)
      if (limited && inFlight > 0) {
        await sleep(300);
        continue;
      }

      const id = queue.shift();
      inFlight += 1;
      try {
        const r = await callGrade(id);

        if (r.rateLimited) {
          limitHits[id] = (limitHits[id] || 0) + 1;
          if (r.dailyLimit) {
            queue.unshift(id); // nothing was lost; it stays queued for another day
            s.limitMessage = r.error;
            stopAll = true;
            continue;
          }
          if (limitHits[id] > maxLimitRetries) {
            s.failed += 1;
            s.problems.push(r.error);
            s.done += 1;
            onProgress({ ...s });
            continue;
          }
          queue.unshift(id);
          limited = true;
          calmStreak = 0;
          pauseUntil = Math.max(pauseUntil, now() + ((r.retryAfterSec || 30) + 2) * 1000);
          continue;
        }

        if (r.budgetReached) {
          s.skipped += 1;
          s.limitMessage = r.error;
          stopAll = true;
        } else if (r.ok === false) {
          s.failed += 1;
          s.problems.push(r.error);
        } else if (r.skipped) {
          s.skipped += 1;
        } else {
          if (r.escalated) s.escalated += 1;
          calmStreak += 1;
          if (calmStreak >= calmAfter) limited = false;
        }
      } catch (err) {
        s.failed += 1;
        s.problems.push(err.message);
      } finally {
        inFlight -= 1;
      }
      s.done += 1;
      onProgress({ ...s });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));
  return { ...s, remaining: queue.length, stopped: shouldStop() || stopAll };
}

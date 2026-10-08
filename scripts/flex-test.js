// Measures whether Google's half-price "Flex" tier is practical for GradeFlow.
//
// Why this exists: Flex costs 50% less than standard, but Google says its speed is variable and it can be
// refused when busy. GradeFlow grades one script per request, and your Vercel plan limits how long a request
// may run (the grading route is set to 60 seconds). If Flex often takes longer than that, it would fail
// or waste money, so we measure first instead of guessing.
//
// It makes a few SMALL requests (a fraction of a cent in total) with the standard tier and the flex tier,
// and prints how long each took. It never touches your database or your app.
//
// Run it from the repo root:
//   node --env-file=.env.local scripts/flex-test.mjs
// Optional: pick a model, and send a real script photo so the test looks like real grading:
//   node --env-file=.env.local scripts/flex-test.mjs gemini-3.6-flash ./some-script-photo.jpg
// Optional: how many requests per tier (default 3):  FLEX_TEST_RUNS=5

import { readFileSync } from 'node:fs';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY is not set. Run with: node --env-file=.env.local scripts/flex-test.mjs');
  process.exit(1);
}

const model = process.argv[2] || process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const imagePath = process.argv[3];
const runs = Math.max(1, Number(process.env.FLEX_TEST_RUNS) || 3);
const TIMEOUT_MS = 5 * 60 * 1000;
const VERCEL_LIMIT_SECONDS = 60; // keep in step with maxDuration in app/api/marking/grade-paper/route.js

const parts = [];
if (imagePath) {
  parts.push({ text: 'Read the handwriting in this photo and reply with a one-sentence summary of what it says.' });
  parts.push({ inline_data: { mime_type: imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg', data: readFileSync(imagePath).toString('base64') } });
} else {
  parts.push({ text: 'Reply with the single word OK.' });
}

const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

async function runOnce(tier) {
  const body = { contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: 400 } };
  if (tier === 'flex') body.service_tier = 'flex';

  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    return {
      tier,
      seconds: (Date.now() - started) / 1000,
      status: res.status,
      inTokens: data.usageMetadata?.promptTokenCount ?? null,
      outTokens: (data.usageMetadata?.candidatesTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0),
      error: res.ok ? null : data?.error?.message || `HTTP ${res.status}`,
    };
  } catch (err) {
    return { tier, seconds: (Date.now() - started) / 1000, status: 0, inTokens: null, outTokens: null, error: err.name === 'TimeoutError' ? 'timed out after 5 minutes' : err.message };
  }
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : null);

console.log(`Model: ${model}${imagePath ? `, with photo ${imagePath}` : ', text-only test'}, ${runs} request(s) per tier\n`);
const results = { standard: [], flex: [] };
for (let i = 0; i < runs; i++) {
  for (const tier of ['standard', 'flex']) {
    const r = await runOnce(tier);
    results[tier].push(r);
    console.log(
      `${tier.padEnd(8)} #${i + 1}  ${r.error ? 'FAILED' : 'ok    '}  ${r.seconds.toFixed(1).padStart(6)}s  tokens in/out: ${r.inTokens ?? '-'}/${r.outTokens ?? '-'}${r.error ? `  (${r.error})` : ''}`
    );
  }
}

const summarize = (tier) => {
  const ok = results[tier].filter((r) => !r.error);
  return { ok: ok.length, failed: results[tier].length - ok.length, medianSeconds: median(ok.map((r) => r.seconds)), maxSeconds: ok.length ? Math.max(...ok.map((r) => r.seconds)) : null };
};
const std = summarize('standard');
const flex = summarize('flex');

console.log('\n--- Summary ---');
console.log(`standard: ${std.ok} ok, ${std.failed} failed, median ${std.medianSeconds?.toFixed(1) ?? '-'}s`);
console.log(`flex:     ${flex.ok} ok, ${flex.failed} failed, median ${flex.medianSeconds?.toFixed(1) ?? '-'}s, slowest ${flex.maxSeconds?.toFixed(1) ?? '-'}s`);

console.log('\n--- What this means ---');
if (flex.ok === 0) {
  console.log('Flex did not work at all for this model and key. Do not use it. Send me the error lines above.');
} else if (flex.failed > 0) {
  console.log('Some Flex requests were refused or failed. That is expected when Google is busy. If you use Flex, GradeFlow must fall back to the standard tier for those scripts.');
}
if (flex.ok > 0 && flex.maxSeconds <= VERCEL_LIMIT_SECONDS * 0.6) {
  console.log(`Flex answered in under ${Math.round(VERCEL_LIMIT_SECONDS * 0.6)}s here, which fits inside the ${VERCEL_LIMIT_SECONDS}s grading limit with room to spare. It may be worth adding.`);
} else if (flex.ok > 0) {
  console.log(`Flex was slow enough (${flex.maxSeconds.toFixed(0)}s) to be risky against the ${VERCEL_LIMIT_SECONDS}s grading limit. A request that outruns the limit can be lost after Google has already charged for it. Only add Flex if your Vercel plan allows a longer limit, and test again with a real script photo.`);
}
console.log('Remember: one run is a snapshot. Speed changes through the day, so test at the time of day teachers will really grade.');

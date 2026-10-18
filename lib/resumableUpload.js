// Uploads one script (all its photos) in a way that survives a weak connection.
//
// - Photos go to storage FIRST. The script record is created only after every photo is safe,
//   so a drop mid-way never leaves a half-made script that blocks the student.
// - Each photo is retried on its own, and a photo that already arrived is never sent twice,
//   even across a refresh (the caller saves which photos are done).
// - Safe to run again for the same script: it picks up where it stopped.

import { withRetry, statusOf } from './netRetry';

function toError(err, fallback = 'Upload failed.') {
  if (err instanceof Error) return err;
  const e = new Error(err?.message || fallback);
  const status = statusOf(err);
  if (status !== null) e.status = status;
  if (err?.code) e.code = err.code;
  return e;
}

const isDuplicate = (err) => statusOf(err) === 409 || /already exists|duplicate/i.test(String(err?.message || ''));

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export async function uploadScript({ supabase, bucket, userId, examId, draft, retry = {}, onPaperId, onPageDone, onProgress, shouldStop }) {
  const opts = { shouldStop, ...retry };
  const paperId = draft.paperId || newId();
  if (!draft.paperId && onPaperId) onPaperId(paperId);

  const done = new Set(draft.doneIds || []);
  const rows = [];

  for (let i = 0; i < draft.pages.length; i++) {
    const page = draft.pages[i];
    // The file name uses the photo's own id, so reordering or removing photos can never mix them up.
    const path = `${userId}/${examId}/${paperId}/${page.id}.jpg`;
    rows.push({ paper_id: paperId, page_no: i + 1, storage_path: path, mime_type: 'image/jpeg' });

    if (!done.has(page.id)) {
      await withRetry(async () => {
        const { error } = await supabase.storage.from(bucket).upload(path, page.blob, { contentType: 'image/jpeg', upsert: false });
        if (error && !isDuplicate(error)) throw toError(error);
      }, opts);
      done.add(page.id);
      if (onPageDone) onPageDone(page.id);
    }
    if (onProgress) onProgress({ page: i + 1, pages: draft.pages.length });
  }

  // Every photo is safe. Now create the script, with an id chosen here so a retry finds the same one.
  await withRetry(async () => {
    const { error } = await supabase
      .from('exam_papers')
      .insert({ id: paperId, exam_id: examId, student_id: draft.studentId || null, status: 'uploaded' });
    if (!error) return;
    if (error.code === '23505') {
      const { data: existing, error: lookupErr } = await supabase.from('exam_papers').select('id').eq('id', paperId).maybeSingle();
      if (lookupErr) throw toError(lookupErr);
      if (existing) return; // an earlier attempt already created it
      const e = new Error('That student already has a script uploaded.');
      e.status = 409; // a real refusal, so it is not retried
      throw e;
    }
    throw toError(error);
  }, opts);

  try {
    await withRetry(async () => {
      const { error } = await supabase.from('exam_paper_pages').upsert(rows, { onConflict: 'paper_id,page_no', ignoreDuplicates: true });
      if (error) throw toError(error);
    }, opts);
  } catch (err) {
    // A script without its page records is useless. Remove it if we can; the photos stay for the next try.
    try {
      await supabase.from('exam_papers').delete().eq('id', paperId);
    } catch {
      // nothing more to do
    }
    throw err;
  }
  return { paperId };
}

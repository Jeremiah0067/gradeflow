// Reads an uploaded question paper (and optional marking scheme) and returns the questions.
//
// The teacher's browser uploads the files to private storage first, then calls this with the file paths.
// (Sending big PDFs inside the request itself can hit hosting size limits.)
// The files are deleted afterwards, whether or not reading succeeded.

import { callGemini, logUsage } from './gradeExamPaper';
import { buildExtractPrompt, fileKind, IMPORT_MAX_FILES, IMPORT_MAX_BYTES } from './questionImport';
import { parseAiJson } from './examGrading';
import { resolveModels } from './gradingModels';
import { estimateCostUsd } from './geminiPricing';

const BUCKET = 'exam-papers';
const MIME_BY_EXT = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const MAX_OUTPUT = 16000;

function checkPaths(paths, label, userId) {
  if (!Array.isArray(paths)) throw new Error(`${label} files are missing.`);
  if (paths.length > IMPORT_MAX_FILES) throw new Error(`Please upload at most ${IMPORT_MAX_FILES} files for the ${label.toLowerCase()}.`);
  const prefix = `${userId}/imports/`;
  paths.forEach((p) => {
    if (typeof p !== 'string' || !p.startsWith(prefix) || p.includes('..')) throw new Error('One of the files is not allowed.');
    const ext = p.split('.').pop().toLowerCase();
    if (!MIME_BY_EXT[ext]) throw new Error('Only PDF files and photos (JPG, PNG) can be read.');
  });
}

// userClient: the teacher's own supabase client (so storage and ownership rules apply to them).
// serviceClient: only needed to log the cost when `examId` is given.
export async function extractQuestionsFromFiles({ userClient, serviceClient, apiKey, userId, examId, paperPaths, schemePaths = [] }) {
  checkPaths(paperPaths, 'Question paper', userId);
  checkPaths(schemePaths, 'Marking scheme', userId);
  if (paperPaths.length === 0) throw new Error('Upload the question paper first.');

  const allPaths = [...paperPaths, ...schemePaths];
  try {
    if (examId) {
      const { data: owned } = await userClient.from('exams').select('id').eq('id', examId).maybeSingle();
      if (!owned) throw new Error('Marking job not found.');
    }

    const load = async (paths) =>
      Promise.all(
        paths.map(async (path) => {
          const { data: blob, error } = await userClient.storage.from(BUCKET).download(path);
          if (error || !blob) throw new Error(`Could not read an uploaded file: ${error?.message || 'unknown error'}`);
          if (blob.size > IMPORT_MAX_BYTES) throw new Error('A file is too large. Please keep each file under 12 MB.');
          const ext = path.split('.').pop().toLowerCase();
          return { mime_type: MIME_BY_EXT[ext], data: Buffer.from(await blob.arrayBuffer()).toString('base64') };
        })
      );

    const [paperFiles, schemeFiles] = await Promise.all([load(paperPaths), load(schemePaths)]);

    const parts = [{ text: buildExtractPrompt({ hasScheme: schemeFiles.length > 0 }) }, { text: 'QUESTION PAPER (pages in order):' }];
    paperFiles.forEach((f) => parts.push({ inline_data: f }));
    if (schemeFiles.length > 0) {
      parts.push({ text: 'MARKING SCHEME (pages in order):' });
      schemeFiles.forEach((f) => parts.push({ inline_data: f }));
    }

    // Reading a paper happens once per exam, so use the main model for the best accuracy
    const { primary: model } = resolveModels('standard', process.env);
    const result = await callGemini(apiKey, model, parts, { maxOutputTokens: MAX_OUTPUT });

    const costUsd = estimateCostUsd({
      model,
      inputTokens: result.usage.promptTokenCount,
      outputTokens: result.usage.candidatesTokenCount,
      thoughtTokens: result.usage.thoughtsTokenCount,
    });
    if (examId && serviceClient) {
      await logUsage(serviceClient, { examId, paperId: null, model, usage: result.usage, pageCount: null });
    }

    if (result.blockReason) throw new Error(`The AI declined to read this document (${result.blockReason}).`);
    if (!result.text) throw new Error('The AI returned no text.');
    if (result.finishReason === 'MAX_TOKENS') throw new Error('The paper is too long to read in one go. Try uploading half of it at a time.');

    return { raw: parseAiJson(result.text), costUsd, model };
  } finally {
    // The teacher's files are only needed for this one reading
    await userClient.storage.from(BUCKET).remove(allPaths).catch(() => {});
  }
}

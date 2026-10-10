'use client';

import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { compressImage } from '../../lib/imageCompress';
import { blankQuestion, isBlankQuestion, totalMarks } from '../../lib/questionForm';
import { fileKind, normalizeExtraction, applyImport, IMPORT_MAX_FILES, IMPORT_MAX_BYTES } from '../../lib/questionImport';
import { formatUsd } from '../../lib/estimateCost';
import { Icon } from '../icons';
import { Dropzone, FileList as FileListView } from '../ui/FilePicker';

const BUCKET = 'exam-papers';

const FLAG_MESSAGE = {
  label: 'This label was renamed because it was repeated. Please check it.',
  question_text: 'This was hard to read. Please check the wording.',
  max_marks: 'The marks were not clearly shown. Please enter them.',
  question_type: 'Not sure if this is written or objective. Please check.',
  answer_key: 'This needs the correct answer. Please enter it.',
};

// The whole "questions and marking scheme" section, used when creating AND editing a marking job.
//   questions / setQuestions: the form cards (see lib/questionForm.js)
//   examId: set when editing an existing job (so the reading cost is recorded against it)
//   onMeta: called with { title, subject } found in an imported document
export default function QuestionsEditor({ questions, setQuestions, examId = null, onMeta, heading = 'Questions and marking scheme' }) {
  const [paperFiles, setPaperFiles] = useState([]);
  const [schemeFiles, setSchemeFiles] = useState([]);
  const [reading, setReading] = useState(false);
  const [importError, setImportError] = useState('');
  const [importInfo, setImportInfo] = useState(null); // { count, notes, statedTotal, cost }

  const total = totalMarks(questions);

  // ---------- editing the cards ----------
  function updateQuestion(key, field, value) {
    setQuestions((prev) =>
      prev.map((q) =>
        q.key === key ? { ...q, [field]: value, uncertain: q.uncertain.filter((f) => f !== field) } : q
      )
    );
  }

  function addQuestion() {
    setQuestions((prev) => [...prev, blankQuestion(prev.length + 1)]);
  }

  function removeQuestion(q) {
    if (questions.length === 1) return;
    if (q.id && !confirm('Removing this question also removes the marks already given for it, when you save. Remove it?')) return;
    setQuestions((prev) => prev.filter((x) => x.key !== q.key));
  }

  // ---------- importing from documents ----------
  function addFiles(setter, current, fileList) {
    setImportError('');
    const incoming = Array.from(fileList || []);
    for (const f of incoming) {
      const kind = fileKind(f.name, f.type);
      if (kind === 'word') {
        setImportError('Word files cannot be read yet. In Word, choose File > Save as > PDF, then upload the PDF.');
        return;
      }
      if (kind === 'other') {
        setImportError(`"${f.name}" is not a PDF or a photo.`);
        return;
      }
      if (f.size > IMPORT_MAX_BYTES * (kind === 'image' ? 2 : 1)) {
        setImportError(`"${f.name}" is too large. Please keep each file under 12 MB.`);
        return;
      }
    }
    if (current.length + incoming.length > IMPORT_MAX_FILES) {
      setImportError(`You can add at most ${IMPORT_MAX_FILES} files here.`);
      return;
    }
    setter([...current, ...incoming]);
  }

  async function uploadAll(files, slot, userId, batchId) {
    const paths = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const isImage = fileKind(f.name, f.type) === 'image';
      const blob = isImage ? await compressImage(f) : f;
      const ext = isImage ? 'jpg' : 'pdf';
      const path = `${userId}/imports/${batchId}/${slot}-${i}.${ext}`;
      const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
        contentType: isImage ? 'image/jpeg' : 'application/pdf',
        upsert: false,
      });
      if (error) throw new Error(error.message);
      paths.push(path);
    }
    return paths;
  }

  async function handleRead() {
    setImportError('');
    setImportInfo(null);
    if (paperFiles.length === 0) {
      setImportError('Add the question paper first.');
      return;
    }

    setReading(true);
    const uploaded = [];
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const session = sessionData?.session;
      if (!session) throw new Error('Please log in again.');

      const batchId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
      const paperPaths = await uploadAll(paperFiles, 'paper', session.user.id, batchId);
      uploaded.push(...paperPaths);
      const schemePaths = await uploadAll(schemeFiles, 'scheme', session.user.id, batchId);
      uploaded.push(...schemePaths);

      const res = await fetch('/api/marking/extract-questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ paperPaths, schemePaths, examId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Could not read the document (${res.status}).`);

      const extraction = normalizeExtraction(data.raw);
      if (extraction.questions.length === 0) {
        throw new Error('No questions were found in that document. Check that the photos are clear and the right way up.');
      }

      // The server deletes the files after reading, so they are no longer ours to clean up
      uploaded.length = 0;

      const hasWork = questions.some((q) => q.id || !isBlankQuestion(q));
      let mode = 'replace';
      if (hasWork) {
        mode = confirm(
          'You already have questions here.\n\nPress OK to REPLACE them with the ones read from the document.\nPress Cancel to ADD the new ones after them.'
        )
          ? 'replace'
          : 'append';
      }
      setQuestions(applyImport(questions, extraction.questions, mode));
      onMeta?.({ title: extraction.title, subject: extraction.subject });
      setImportInfo({
        count: extraction.questions.length,
        notes: extraction.notes,
        statedTotal: extraction.statedTotal,
        cost: data.costUsd,
      });
      setPaperFiles([]);
      setSchemeFiles([]);
    } catch (err) {
      setImportError(err.message);
      // Remove anything we uploaded but the server never got to delete
      if (uploaded.length > 0) await supabase.storage.from(BUCKET).remove(uploaded).catch(() => {});
    }
    setReading(false);
  }

  const unsure = (q, field) => (q.uncertain.includes(field) ? 'is-unsure' : undefined);

  return (
    <div className="surface">
      <h2>{heading}</h2>
      <p className="section-note">Add each question and what a full-marks answer looks like. Or let the AI read them from your question paper.</p>

      {/* ---------- read from a document ---------- */}
      <div className="import-box">
        <h3>Read the questions from a document</h3>
        <p className="section-note" style={{ marginBottom: 'var(--s-3)' }}>
          Upload the question paper as a PDF or photos. You can also add the marking scheme (memo) so it fills in the answers. You will
          check everything before it is saved.
        </p>

        <label style={{ marginTop: 0 }}>Question paper</label>
        <Dropzone
          title="Choose the question paper"
          hint="PDF or photos. Word files: save as PDF first."
          accept=".pdf,application/pdf,image/*"
          disabled={reading}
          onFiles={(files) => addFiles(setPaperFiles, paperFiles, files)}
        />
        <FileListView files={paperFiles} disabled={reading} onRemove={(i) => setPaperFiles(paperFiles.filter((_, j) => j !== i))} />

        <label>
          Marking scheme or memo <span className="hint" style={{ display: 'inline' }}>(optional)</span>
        </label>
        <Dropzone
          title="Choose the marking scheme"
          hint="PDF or photos"
          accept=".pdf,application/pdf,image/*"
          icon="file"
          disabled={reading}
          onFiles={(files) => addFiles(setSchemeFiles, schemeFiles, files)}
        />
        <FileListView files={schemeFiles} disabled={reading} onRemove={(i) => setSchemeFiles(schemeFiles.filter((_, j) => j !== i))} />

        <div style={{ marginTop: 'var(--s-4)' }}>
          <button type="button" disabled={reading || paperFiles.length === 0} onClick={handleRead}>
            {reading ? 'Reading... this can take up to a minute' : 'Read the questions'}
          </button>
        </div>

        {importError && (
          <p className="alert alert-error" role="alert" style={{ marginTop: 'var(--s-4)', marginBottom: 0 }}>
            {importError}
          </p>
        )}

        {importInfo && (
          <div style={{ marginTop: 'var(--s-4)' }}>
            <p className="alert alert-ok" role="status">
              <span>
                <strong>Found {importInfo.count} {importInfo.count === 1 ? 'question' : 'questions'}.</strong> Please check every one below before
                you save{importInfo.cost ? ` (reading cost about ${formatUsd(importInfo.cost)})` : ''}.
              </span>
            </p>
            {importInfo.notes && (
              <p className="alert alert-warn"><span><strong>Note from the AI.</strong> {importInfo.notes}</span></p>
            )}
            {importInfo.statedTotal !== null && importInfo.statedTotal !== total && (
              <p className="alert alert-warn" style={{ marginBottom: 0 }}>
                <span>
                  The paper says it is out of {importInfo.statedTotal} marks, but these questions add up to {total}. A question may be
                  missing or a mark may be wrong.
                </span>
              </p>
            )}
          </div>
        )}
      </div>

      {/* ---------- the questions ---------- */}
      {questions.map((q, i) => (
        <div key={q.key} className="qcard">
          <div className="qcard-top">
            <div>
              <label htmlFor={`label-${q.key}`}>Label</label>
              <input id={`label-${q.key}`} className={unsure(q, 'label')} value={q.label} onChange={(e) => updateQuestion(q.key, 'label', e.target.value)} />
            </div>
            <div>
              <label htmlFor={`marks-${q.key}`}>Marks</label>
              <input
                id={`marks-${q.key}`}
                className={unsure(q, 'max_marks')}
                type="number"
                min="0"
                step="0.5"
                value={q.max_marks}
                onChange={(e) => updateQuestion(q.key, 'max_marks', e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`type-${q.key}`}>Type</label>
              <select id={`type-${q.key}`} className={unsure(q, 'question_type')} value={q.question_type} onChange={(e) => updateQuestion(q.key, 'question_type', e.target.value)}>
                <option value="written">Written (the AI marks it)</option>
                <option value="objective">Objective (one fixed answer)</option>
              </select>
            </div>
            <button type="button" className="btn-quiet btn-sm is-danger" style={{ color: 'var(--ink-3)' }} disabled={questions.length === 1} onClick={() => removeQuestion(q)}>
              Remove
            </button>
          </div>

          {q.uncertain
            .filter((f) => f !== 'answer_key')
            .map((f) => (
              <p key={f} className="unsure-note">{FLAG_MESSAGE[f]}</p>
            ))}

          <label htmlFor={`text-${q.key}`}>Question {i + 1}</label>
          <textarea
            id={`text-${q.key}`}
            className={unsure(q, 'question_text')}
            rows={2}
            value={q.question_text}
            onChange={(e) => updateQuestion(q.key, 'question_text', e.target.value)}
            placeholder="Type the question as it appears on the paper"
          />
          {q.mentionsFigure && (
            <p className="unsure-note">
              This question refers to a figure, graph or table. The AI cannot see the question paper when it marks, so describe it in the
              question text.
            </p>
          )}

          {q.question_type === 'objective' ? (
            <>
              <label htmlFor={`key-${q.key}`}>Correct answer</label>
              <input
                id={`key-${q.key}`}
                className={unsure(q, 'answer_key')}
                value={q.answer_key}
                onChange={(e) => updateQuestion(q.key, 'answer_key', e.target.value)}
                placeholder="e.g. B, or 42. Use | for alternatives, like B|C"
              />
              {q.uncertain.includes('answer_key') && <p className="unsure-note">{FLAG_MESSAGE.answer_key}</p>}
            </>
          ) : (
            <>
              <label htmlFor={`guide-${q.key}`}>
                What a full-marks answer contains <span className="hint" style={{ display: 'inline' }}>(optional, but it helps the AI mark like you)</span>
              </label>
              <textarea
                id={`guide-${q.key}`}
                rows={2}
                value={q.marking_guide}
                onChange={(e) => updateQuestion(q.key, 'marking_guide', e.target.value)}
                placeholder="Key points, steps, or the expected answer. e.g. 1 mark for the formula, 2 for the working, 1 for the final answer."
              />
            </>
          )}
        </div>
      ))}

      <div className="total-line">
        <button type="button" className="btn-secondary" onClick={addQuestion}>
          <Icon name="plus" size={18} />
          Add a question
        </button>
        <p className="section-note num" style={{ margin: 0 }}>
          Total <strong style={{ color: 'var(--ink)', fontSize: '1.0625rem' }}>{total}</strong> marks
        </p>
      </div>
    </div>
  );
}

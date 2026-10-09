'use client';

import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { compressImage } from '../../lib/imageCompress';
import { blankQuestion, isBlankQuestion, totalMarks } from '../../lib/questionForm';
import { fileKind, normalizeExtraction, applyImport, IMPORT_MAX_FILES, IMPORT_MAX_BYTES } from '../../lib/questionImport';
import { formatUsd } from '../../lib/estimateCost';

const BUCKET = 'exam-papers';
const smallBtn = { width: 'auto', margin: 0, padding: '6px 14px', fontSize: 13 };
const warnBorder = { borderColor: 'var(--gf-warning-text)' };

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
export default function QuestionsEditor({ questions, setQuestions, examId = null, onMeta, heading = '2. Questions and marking scheme' }) {
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

  const fileList = (files, setter) =>
    files.length > 0 && (
      <div style={{ margin: '6px 0' }}>
        {files.map((f, i) => (
          <div key={`${f.name}-${i}`} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, margin: '3px 0' }}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
            <button
              type="button"
              className="btn-secondary"
              style={{ ...smallBtn, padding: '2px 10px' }}
              disabled={reading}
              onClick={() => setter(files.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    );

  return (
    <div className="surface">
      <p className="section-heading">{heading}</p>

      {/* ---------- import panel ---------- */}
      <div style={{ background: 'var(--gf-bg)', border: '1px dashed var(--gf-border)', borderRadius: 8, padding: 14, marginBottom: 16 }}>
        <p className="assignment-row-title" style={{ marginBottom: 4 }}>Read the questions from a document</p>
        <p className="assignment-row-meta" style={{ margin: '0 0 10px 0' }}>
          Upload the question paper as a PDF or photos, and the AI fills in the questions below. You can also upload the marking
          scheme (memo) so it fills in the answers. Always check the result before saving.
        </p>

        <label style={{ marginTop: 0 }}>Question paper (PDF or photos)</label>
        <input
          type="file"
          accept=".pdf,application/pdf,image/*"
          multiple
          disabled={reading}
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = '';
            addFiles(setPaperFiles, paperFiles, files);
          }}
        />
        {fileList(paperFiles, setPaperFiles)}

        <label>Marking scheme or memo (optional)</label>
        <input
          type="file"
          accept=".pdf,application/pdf,image/*"
          multiple
          disabled={reading}
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = '';
            addFiles(setSchemeFiles, schemeFiles, files);
          }}
        />
        {fileList(schemeFiles, setSchemeFiles)}

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
          <button type="button" style={{ width: 'auto', margin: 0 }} disabled={reading || paperFiles.length === 0} onClick={handleRead}>
            {reading ? 'Reading... this can take up to a minute' : 'Read the questions'}
          </button>
          <span className="assignment-row-meta">Word files: save them as PDF first.</span>
        </div>

        {importError && <p className="error-text" style={{ marginBottom: 0 }}>{importError}</p>}

        {importInfo && (
          <div style={{ marginTop: 12, fontSize: 13 }}>
            <p style={{ margin: 0, color: 'var(--gf-success-text)' }}>
              Found {importInfo.count} question{importInfo.count === 1 ? '' : 's'}. Please check every one below before you save
              {importInfo.cost ? ` (reading cost about ${formatUsd(importInfo.cost)})` : ''}.
            </p>
            {importInfo.notes && (
              <p style={{ margin: '6px 0 0 0', color: 'var(--gf-warning-text)' }}>Note from the AI: {importInfo.notes}</p>
            )}
            {importInfo.statedTotal !== null && importInfo.statedTotal !== total && (
              <p style={{ margin: '6px 0 0 0', color: 'var(--gf-warning-text)' }}>
                The paper says it is out of {importInfo.statedTotal} marks, but these questions add up to {total}. A question may be
                missing or a mark may be wrong.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ---------- the question cards ---------- */}
      {questions.map((q, i) => (
        <div key={q.key} style={{ border: '1px solid var(--gf-border)', borderRadius: 8, padding: 14, marginBottom: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '90px 110px 1fr auto', gap: 12, alignItems: 'end' }}>
            <div>
              <label style={{ marginTop: 0 }}>Label</label>
              <input
                value={q.label}
                style={q.uncertain.includes('label') ? warnBorder : undefined}
                onChange={(e) => updateQuestion(q.key, 'label', e.target.value)}
              />
            </div>
            <div>
              <label style={{ marginTop: 0 }}>Marks</label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={q.max_marks}
                style={q.uncertain.includes('max_marks') ? warnBorder : undefined}
                onChange={(e) => updateQuestion(q.key, 'max_marks', e.target.value)}
              />
            </div>
            <div>
              <label style={{ marginTop: 0 }}>Type</label>
              <select
                value={q.question_type}
                style={q.uncertain.includes('question_type') ? warnBorder : undefined}
                onChange={(e) => updateQuestion(q.key, 'question_type', e.target.value)}
              >
                <option value="written">Written (AI marks it)</option>
                <option value="objective">Objective (fixed answer)</option>
              </select>
            </div>
            <button
              type="button"
              className="btn-danger"
              style={smallBtn}
              disabled={questions.length === 1}
              onClick={() => removeQuestion(q)}
            >
              Remove
            </button>
          </div>

          {q.uncertain
            .filter((f) => f !== 'answer_key')
            .map((f) => (
              <p key={f} style={{ color: 'var(--gf-warning-text)', fontSize: 12, margin: '6px 0 0 0' }}>
                {FLAG_MESSAGE[f]}
              </p>
            ))}

          <label>Question {i + 1} text</label>
          <textarea
            rows={2}
            value={q.question_text}
            style={q.uncertain.includes('question_text') ? warnBorder : undefined}
            onChange={(e) => updateQuestion(q.key, 'question_text', e.target.value)}
            placeholder="Type the question as it appears on the paper"
          />
          {q.mentionsFigure && (
            <p style={{ color: 'var(--gf-warning-text)', fontSize: 12, margin: '4px 0 0 0' }}>
              This question refers to a figure, graph or table. The AI cannot see the question paper when it marks, so describe
              it in the question text.
            </p>
          )}

          {q.question_type === 'objective' ? (
            <>
              <label>Correct answer</label>
              <input
                value={q.answer_key}
                style={q.uncertain.includes('answer_key') ? warnBorder : undefined}
                onChange={(e) => updateQuestion(q.key, 'answer_key', e.target.value)}
                placeholder="e.g. B, or 42. Use | for alternatives, like B|C"
              />
              {q.uncertain.includes('answer_key') && (
                <p style={{ color: 'var(--gf-warning-text)', fontSize: 12, margin: '4px 0 0 0' }}>{FLAG_MESSAGE.answer_key}</p>
              )}
            </>
          ) : (
            <>
              <label>What a full-marks answer should contain (optional but recommended)</label>
              <textarea
                rows={2}
                value={q.marking_guide}
                onChange={(e) => updateQuestion(q.key, 'marking_guide', e.target.value)}
                placeholder="Key points, steps, or the expected answer. e.g. 1 mark for the formula, 2 marks for the working, 1 mark for the final answer."
              />
            </>
          )}
        </div>
      ))}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button type="button" className="btn-secondary" style={smallBtn} onClick={addQuestion}>
          + Add question
        </button>
        <p className="assignment-row-meta" style={{ margin: 0 }}>
          Total: <strong>{total}</strong> marks
        </p>
      </div>
    </div>
  );
}

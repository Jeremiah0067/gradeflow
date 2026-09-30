const LOW_CONFIDENCE_THRESHOLD = 0.6;
const MAX_ATTEMPTS = 3;

async function callGemini(apiKey, parts) {
  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || res.statusText);
  const textPart = data.candidates?.[0]?.content?.parts?.find((p) => p.text);
  if (!textPart) throw new Error('No text returned from Gemini.');
  return JSON.parse(textPart.text.replace(/```json|```/g, '').trim());
}

export async function gradeSubmission(supabase, apiKey, submission) {
  const nextAttempt = (submission.grading_attempts || 0) + 1;

  try {
    const { data: assignment } = await supabase
      .from('assignments')
      .select('*, rubric_criteria(*)')
      .eq('id', submission.assignment_id)
      .single();

    if (!assignment) throw new Error('Assignment not found for this submission.');

    const rubricList = (assignment.rubric_criteria || [])
      .map((c, i) => `${i + 1}. ${c.label}${c.description ? ` - ${c.description}` : ''} (max ${c.max_points} pts, id: ${c.id})`)
      .join('\n');

    let transcript = null;

    if (assignment.type === 'handwritten') {
      const path = submission.raw_content?.image_path;
      const { data: fileData, error: dlError } = await supabase.storage.from('submissions').download(path);
      if (dlError) throw new Error(`Could not download submitted image: ${dlError.message}`);

      const buffer = Buffer.from(await fileData.arrayBuffer());
      const imageBase64 = buffer.toString('base64');
      const mimeType = submission.raw_content?.mime_type || 'image/jpeg';

      const transcribePrompt = `Transcribe the handwritten text in this image exactly as written.
If illegible, write [illegible]. Respond ONLY with JSON: { "transcript": "...", "confidence": 0-1 }`;

      const transcribed = await callGemini(apiKey, [
        { inline_data: { mime_type: mimeType, data: imageBase64 } },
        { text: transcribePrompt },
      ]);
      transcript = transcribed.transcript;

      await supabase.from('submission_transcripts').insert({
        submission_id: submission.id,
        transcript_text: transcript,
        confidence_score: transcribed.confidence,
      });

      if (typeof transcribed.confidence !== 'number' || transcribed.confidence < LOW_CONFIDENCE_THRESHOLD) {
        await supabase
          .from('submissions')
          .update({ status: 'flagged', grading_attempts: nextAttempt, last_attempt_at: new Date().toISOString() })
          .eq('id', submission.id);
        return { outcome: 'flagged_low_confidence' };
      }
    } else {
      transcript = submission.raw_content?.text;
      if (!transcript) throw new Error('No text found in this submission to grade.');
    }

    const gradePrompt = `You are grading a student's answer and writing feedback directly TO the student.

Rubric:
${rubricList || 'No rubric set. Score out of 100.'}

Student's answer:
"""
${transcript}
"""

For each criterion, write feedback speaking directly to the student in second person ("you"),
warm and encouraging even when pointing out what's missing. Do not restate the criterion's
definition back at them like a checklist item - instead:
- If they got it right, briefly say what they did well and why it worked
- If they got it partly right, acknowledge what's there, then tell them specifically what to
  add or fix to earn full points next time
- If they missed it entirely, tell them plainly what's missing and give one concrete tip for
  how to include it
Keep each one to 1-2 sentences, specific to what THEY actually wrote, not generic.

Also give a confidence score (0-1) for each criterion - how confident you are that the score
you awarded is correct, given how clear-cut the evidence in the answer was.

Respond ONLY with JSON: { "criteria": [{ "id": "...", "awarded": number, "confidence": 0-1, "reasoning": "feedback written directly to the student" }] }`;

    const graded = await callGemini(apiKey, [{ text: gradePrompt }]);

    if (!graded.criteria || graded.criteria.length === 0) {
      throw new Error('Gemini returned no criteria scores.');
    }

    await supabase.from('rubric_scores').delete().eq('submission_id', submission.id);

    const scoreRows = graded.criteria.map((c) => ({
      submission_id: submission.id,
      criterion_id: c.id,
      ai_awarded_points: c.awarded,
      ai_confidence: c.confidence,
      ai_reasoning: c.reasoning,
    }));

    await supabase.from('rubric_scores').insert(scoreRows);

    await supabase
      .from('submissions')
      .update({
        status: 'needs_teacher_approval',
        grading_attempts: nextAttempt,
        last_attempt_at: new Date().toISOString(),
      })
      .eq('id', submission.id);

    return { outcome: 'graded' };
  } catch (err) {
    await supabase.from('grading_errors').insert({
      submission_id: submission.id,
      attempt_number: nextAttempt,
      error_message: err.message || String(err),
    });

    const finalStatus = nextAttempt >= MAX_ATTEMPTS ? 'flagged' : 'pending_ai_review';

    await supabase
      .from('submissions')
      .update({
        status: finalStatus,
        grading_attempts: nextAttempt,
        last_attempt_at: new Date().toISOString(),
      })
      .eq('id', submission.id);

    return { outcome: 'error', error: err.message, willRetry: finalStatus === 'pending_ai_review' };
  }
}

export { MAX_ATTEMPTS };

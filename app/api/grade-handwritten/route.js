import { createClient } from '@supabase/supabase-js';

function getSupabaseForRequest(req) {
  const authHeader = req.headers.get('authorization') || '';
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
}

const LOW_CONFIDENCE_THRESHOLD = 0.6;

export async function POST(req) {
  try {
    const { assignmentId, mimeType, imageBase64 } = await req.json();

    if (!assignmentId || !mimeType || !imageBase64) {
      return Response.json({ error: 'assignmentId, mimeType, and imageBase64 are required.' }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return Response.json({ error: 'Server is missing GEMINI_API_KEY.' }, { status: 500 });
    }

    const supabase = getSupabaseForRequest(req);

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return Response.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    const { data: submission, error: submissionError } = await supabase
      .from('submissions')
      .insert({
        assignment_id: assignmentId,
        student_id: user.id,
        status: 'grading',
        raw_content: { note: 'handwritten submission, see submission_transcripts for text' },
      })
      .select()
      .single();

    if (submissionError) {
      return Response.json({ error: submissionError.message }, { status: 500 });
    }

    const transcribePrompt = `Transcribe the handwritten text in this image exactly as written.
If a word or phrase is illegible, write [illegible] in its place rather than guessing.
Respond ONLY with valid JSON, no markdown fences, in this exact shape:
{ "transcript": "<the transcribed text>", "confidence": <number between 0 and 1, your confidence that the transcript is accurate> }`;

    const transcribeResponse = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ inline_data: { mime_type: mimeType, data: imageBase64 } }, { text: transcribePrompt }],
            },
          ],
          generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
        }),
      }
    );

    const transcribeData = await transcribeResponse.json();

    if (!transcribeResponse.ok) {
      await supabase.from('submissions').update({ status: 'flagged' }).eq('id', submission.id);
      return Response.json(
        { error: `Gemini API error (transcribe): ${transcribeData?.error?.message || transcribeResponse.statusText}` },
        { status: transcribeResponse.status }
      );
    }

    const transcribeCandidate = transcribeData.candidates && transcribeData.candidates[0];
    const transcribeTextPart = transcribeCandidate?.content?.parts?.find((p) => p.text);

    if (!transcribeTextPart) {
      await supabase.from('submissions').update({ status: 'flagged' }).eq('id', submission.id);
      return Response.json({ error: 'No transcription returned from Gemini.' }, { status: 500 });
    }

    let transcribeParsed;
    try {
      const cleaned = transcribeTextPart.text.replace(/```json|```/g, '').trim();
      transcribeParsed = JSON.parse(cleaned);
    } catch (e) {
      await supabase.from('submissions').update({ status: 'flagged' }).eq('id', submission.id);
      return Response.json({ error: 'Could not parse transcription response.' }, { status: 500 });
    }

    const { transcript, confidence } = transcribeParsed;

    await supabase.from('submission_transcripts').insert({
      submission_id: submission.id,
      transcript_text: transcript,
      confidence_score: confidence,
    });

    if (typeof confidence !== 'number' || confidence < LOW_CONFIDENCE_THRESHOLD) {
      await supabase.from('submissions').update({ status: 'flagged' }).eq('id', submission.id);
      return Response.json({
        submissionId: submission.id,
        transcript,
        confidence,
        flagged: true,
        message: 'Handwriting confidence was low. This submission needs manual teacher review before grading.',
      });
    }

    const { data: criteria, error: criteriaError } = await supabase
      .from('rubric_criteria')
      .select('*')
      .eq('assignment_id', assignmentId)
      .order('sort_order', { ascending: true });

    if (criteriaError) {
      return Response.json({ error: criteriaError.message }, { status: 500 });
    }

    const rubricList = (criteria || [])
      .map((c, i) => `${i + 1}. ${c.label} (max ${c.max_points} points, id: ${c.id})`)
      .join('\n');

    const gradePrompt = `You are grading a student's handwritten answer, already transcribed to text below,
against a rubric. Some words may be marked [illegible] - use your best judgement and don't penalize
harshly for genuinely illegible words, but do grade based on what's actually legible and present.

Rubric:
${rubricList || 'No rubric criteria were set for this assignment. Give an overall assessment out of 100.'}

Transcribed answer:
"""
${transcript}
"""

Respond ONLY with valid JSON, no markdown fences, in this exact shape:
{
  "criteria": [
    { "id": "<criterion id from the rubric above>", "awarded": <number>, "reasoning": "<one sentence>" }
  ]
}`;

    const gradeResponse = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: gradePrompt }] }],
          generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
        }),
      }
    );

    const gradeData = await gradeResponse.json();

    if (!gradeResponse.ok) {
      await supabase.from('submissions').update({ status: 'flagged' }).eq('id', submission.id);
      return Response.json(
        { error: `Gemini API error (grade): ${gradeData?.error?.message || gradeResponse.statusText}` },
        { status: gradeResponse.status }
      );
    }

    const gradeCandidate = gradeData.candidates && gradeData.candidates[0];
    const gradeTextPart = gradeCandidate?.content?.parts?.find((p) => p.text);

    if (!gradeTextPart) {
      await supabase.from('submissions').update({ status: 'flagged' }).eq('id', submission.id);
      return Response.json({ error: 'No grading response returned from Gemini.' }, { status: 500 });
    }

    let gradeParsed;
    try {
      const cleaned = gradeTextPart.text.replace(/```json|```/g, '').trim();
      gradeParsed = JSON.parse(cleaned);
    } catch (e) {
      await supabase.from('submissions').update({ status: 'flagged' }).eq('id', submission.id);
      return Response.json({ error: 'Could not parse grading response.' }, { status: 500 });
    }

    const scoreRows = (gradeParsed.criteria || []).map((c) => ({
      submission_id: submission.id,
      criterion_id: c.id,
      ai_awarded_points: c.awarded,
      ai_reasoning: c.reasoning,
    }));

    if (scoreRows.length > 0) {
      const { error: scoreError } = await supabase.from('rubric_scores').insert(scoreRows);
      if (scoreError) {
        return Response.json({ error: scoreError.message }, { status: 500 });
      }
    }

    await supabase.from('submissions').update({ status: 'graded' }).eq('id', submission.id);

    return Response.json({ submissionId: submission.id, transcript, confidence, scores: gradeParsed.criteria });
  } catch (err) {
    return Response.json({ error: `Server error: ${err.message}` }, { status: 500 });
  }
}

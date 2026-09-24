import { createClient } from '@supabase/supabase-js';

function getSupabaseForRequest(req) {
  const authHeader = req.headers.get('authorization') || '';
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
}

export async function POST(req) {
  try {
    const { assignmentId, answerText } = await req.json();

    if (!assignmentId || !answerText) {
      return Response.json({ error: 'assignmentId and answerText are required.' }, { status: 400 });
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

    const { data: criteria, error: criteriaError } = await supabase
      .from('rubric_criteria')
      .select('*')
      .eq('assignment_id', assignmentId)
      .order('sort_order', { ascending: true });

    if (criteriaError) {
      return Response.json({ error: criteriaError.message }, { status: 500 });
    }

    const { data: submission, error: submissionError } = await supabase
      .from('submissions')
      .insert({
        assignment_id: assignmentId,
        student_id: user.id,
        status: 'grading',
        raw_content: { text: answerText },
      })
      .select()
      .single();

    if (submissionError) {
      return Response.json({ error: submissionError.message }, { status: 500 });
    }

    const rubricList = (criteria || [])
      .map((c, i) => `${i + 1}. ${c.label} (max ${c.max_points} points, id: ${c.id})`)
      .join('\n');

    const prompt = `You are grading a student's written answer against a rubric.

Rubric:
${rubricList || 'No rubric criteria were set for this assignment. Give an overall assessment out of 100.'}

Student's answer:
"""
${answerText}
"""

Respond ONLY with valid JSON in this exact shape, no markdown fences, no extra text:
{
  "criteria": [
    { "id": "<criterion id from the rubric above>", "awarded": <number>, "reasoning": "<one sentence>" }
  ]
}`;

    const geminiResponse = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
        }),
      }
    );

    const geminiData = await geminiResponse.json();

    if (!geminiResponse.ok) {
      await supabase.from('submissions').update({ status: 'flagged' }).eq('id', submission.id);
      return Response.json(
        { error: `Gemini API error: ${geminiData?.error?.message || geminiResponse.statusText}` },
        { status: geminiResponse.status }
      );
    }

    const candidate = geminiData.candidates && geminiData.candidates[0];
    const textPart = candidate?.content?.parts?.find((p) => p.text);

    if (!textPart) {
      await supabase.from('submissions').update({ status: 'flagged' }).eq('id', submission.id);
      return Response.json({ error: 'No text returned from Gemini.' }, { status: 500 });
    }

    let parsed;
    try {
      const cleaned = textPart.text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      await supabase.from('submissions').update({ status: 'flagged' }).eq('id', submission.id);
      return Response.json({ error: 'Could not parse grading response. Submission flagged for manual review.' }, { status: 500 });
    }

    const scoreRows = (parsed.criteria || []).map((c) => ({
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

    return Response.json({ submissionId: submission.id, scores: parsed.criteria });
  } catch (err) {
    return Response.json({ error: `Server error: ${err.message}` }, { status: 500 });
  }
}

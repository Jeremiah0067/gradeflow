import { createClient } from '@supabase/supabase-js';

function getServiceSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const LOW_CONFIDENCE_THRESHOLD = 0.6;

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

// Supabase webhook payload shape: { type: 'INSERT', table: 'submissions', record: {...} }
export async function POST(req) {
  const supabase = getServiceSupabase();
  const apiKey = process.env.GEMINI_API_KEY;

  try {
    const payload = await req.json();
    const submission = payload.record;

    if (!submission || submission.status !== 'pending_ai_review') {
      return Response.json({ skipped: true });
    }

    const { data: assignment } = await supabase
      .from('assignments')
      .select('*, rubric_criteria(*)')
      .eq('id', submission.assignment_id)
      .single();

    const rubricList = (assignment.rubric_criteria || [])
      .map((c, i) => `${i + 1}. ${c.label}${c.description ? ` - ${c.description}` : ''} (max ${c.max_points} pts, id: ${c.id})`)
      .join('\n');

    let transcript = null;
    let confidence = 1;

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
      confidence = transcribed.confidence;

      await supabase.from('submission_transcripts').insert({
        submission_id: submission.id,
        transcript_text: transcript,
        confidence_score: confidence,
      });

      if (typeof confidence !== 'number' || confidence < LOW_CONFIDENCE_THRESHOLD) {
        await supabase.from('submissions').update({ status: 'flagged' }).eq('id', submission.id);
        return Response.json({ flagged: true });
      }
    } else {
      transcript = submission.raw_content?.text;
    }

    const gradePrompt = `Grade this student answer against the rubric below.
Rubric:
${rubricList || 'No rubric set. Score out of 100.'}

Answer:
"""
${transcript}
"""

Respond ONLY with JSON: { "criteria": [{ "id": "...", "awarded": number, "reasoning": "one sentence" }] }`;

    const graded = await callGemini(apiKey, [{ text: gradePrompt }]);

    const scoreRows = (graded.criteria || []).map((c) => ({
      submission_id: submission.id,
      criterion_id: c.id,
      ai_awarded_points: c.awarded,
      ai_reasoning: c.reasoning,
    }));

    if (scoreRows.length > 0) {
      await supabase.from('rubric_scores').insert(scoreRows);
    }

    await supabase.from('submissions').update({ status: 'needs_teacher_approval' }).eq('id', submission.id);

    return Response.json({ processed: true });
  } catch (err) {
    try {
      const payload = await req.clone().json();
      if (payload?.record?.id) {
        await supabase.from('submissions').update({ status: 'flagged' }).eq('id', payload.record.id);
      }
    } catch (_) {}
    return Response.json({ error: err.message }, { status: 500 });
  }
}

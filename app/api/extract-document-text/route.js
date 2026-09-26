import { createClient } from '@supabase/supabase-js';

function getSupabaseForRequest(req) {
  const authHeader = req.headers.get('authorization') || '';
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
}

export async function POST(req) {
  try {
    const { mimeType, fileBase64 } = await req.json();

    if (!mimeType || !fileBase64) {
      return Response.json({ error: 'mimeType and fileBase64 are required.' }, { status: 400 });
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

    const prompt = `Extract the assignment or classwork text from this document exactly as written.
Return only the extracted text, with no commentary, no markdown formatting, and no added headers.
If the document contains a title and instructions, include both, in order.`;

    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ inline_data: { mime_type: mimeType, data: fileBase64 } }, { text: prompt }],
            },
          ],
          generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return Response.json(
        { error: `Gemini API error: ${data?.error?.message || response.statusText}` },
        { status: response.status }
      );
    }

    const candidate = data.candidates && data.candidates[0];
    const textPart = candidate?.content?.parts?.find((p) => p.text);

    if (!textPart) {
      return Response.json({ error: 'No text could be extracted from this document.' }, { status: 500 });
    }

    return Response.json({ extractedText: textPart.text.trim() });
  } catch (err) {
    return Response.json({ error: `Server error: ${err.message}` }, { status: 500 });
  }
}

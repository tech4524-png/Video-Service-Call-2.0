export const runtime = 'nodejs';
export const maxDuration = 60; // שניות — נתמך ב-Vercel Hobby עד 60

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const GEMINI_MODEL = 'gemini-2.5-flash';
const OPENAI_MODEL = 'gpt-4o';

export async function POST(req) {
  try {
    const geminiKey = process.env.GEMINI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!geminiKey) return jsonError('חסר GEMINI_API_KEY במשתני הסביבה', 500);
    if (!openaiKey) return jsonError('חסר OPENAI_API_KEY במשתני הסביבה', 500);

    const form = await req.formData();
    const video = form.get('video');
    const machineId = String(form.get('machineId') || 'unknown');
    const lang = String(form.get('lang') || 'he');
    if (!video || typeof video.arrayBuffer !== 'function') {
      return jsonError('לא התקבל קובץ וידאו', 400);
    }

    const bytes = Buffer.from(await video.arrayBuffer());
    const mimeType = video.type || 'video/mp4';

    // 1) העלאת הווידאו ל-Gemini Files API (resumable upload)
    const fileUri = await uploadToGemini(geminiKey, bytes, mimeType);

    // 2) ניתוח הווידאו עם Gemini
    const geminiAnalysis = await analyzeWithGemini(geminiKey, fileUri, mimeType, lang);

    // 3) בניית קריאת שירות מובנית עם GPT-4o
    const { serviceCall, serviceCallRaw } = await structureWithOpenAI(openaiKey, geminiAnalysis, machineId);

    return Response.json({ geminiAnalysis, serviceCall, serviceCallRaw, machineId });
  } catch (err) {
    console.error('analyze error:', err);
    return jsonError(String(err.message || err), 500);
  }
}

function jsonError(message, status) {
  return Response.json({ error: message }, { status });
}

async function uploadToGemini(key, bytes, mimeType) {
  // שלב 1: פתיחת session להעלאה
  const startRes = await fetch(`${GEMINI_BASE}/upload/v1beta/files?key=${key}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: `service-call-${Date.now()}` } }),
  });
  if (!startRes.ok) throw new Error(`Gemini upload start failed: ${startRes.status} ${await startRes.text()}`);
  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini לא החזיר כתובת העלאה');

  // שלב 2: העלאת הבייטים
  const upRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
      'Content-Length': String(bytes.length),
    },
    body: bytes,
  });
  if (!upRes.ok) throw new Error(`Gemini upload failed: ${upRes.status} ${await upRes.text()}`);
  const fileInfo = await upRes.json();
  const name = fileInfo.file?.name;
  let state = fileInfo.file?.state;
  let uri = fileInfo.file?.uri;

  // שלב 3: המתנה לעיבוד הקובץ
  const deadline = Date.now() + 45_000;
  while (state === 'PROCESSING' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(`${GEMINI_BASE}/v1beta/${name}?key=${key}`);
    if (!poll.ok) throw new Error(`Gemini file poll failed: ${poll.status}`);
    const info = await poll.json();
    state = info.state;
    uri = info.uri || uri;
  }
  if (state !== 'ACTIVE') throw new Error(`הקובץ לא מוכן לניתוח (state=${state})`);
  return uri;
}

async function analyzeWithGemini(key, fileUri, mimeType, lang) {
  const langNote = lang === 'ru'
    ? 'The worker likely speaks Russian.'
    : 'The worker likely speaks Hebrew.';

  const prompt = `You are analyzing a short video recorded by a factory floor worker reporting a machine fault (service call).
${langNote} The speech may also be in Hebrew, Russian, Arabic or English — detect automatically.

Analyze the video carefully and report in HEBREW:
1. תמלול מלא של הדיבור (ואם הדיבור לא בעברית — גם תרגום לעברית).
2. מה רואים בווידאו: איזה ציוד/מכונה, מה מצולם, סימנים ויזואליים לתקלה (נזילה, שבר, עשן, חלק תקוע, תצוגת שגיאה וכו').
3. צלילים חריגים אם יש (רעש, חריקה, התראה).
4. מהי התקלה המדווחת, לפי שילוב הדיבור והתמונה.
5. רמת ודאות שלך והאם חסר מידע חשוב.

Write clearly in Hebrew, with short section headings.`;

  const res = await fetch(`${GEMINI_BASE}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { file_data: { file_uri: fileUri, mime_type: mimeType } },
          { text: prompt },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini analysis failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('\n');
  if (!text) throw new Error('Gemini לא החזיר ניתוח');
  return text;
}

async function structureWithOpenAI(key, geminiAnalysis, machineId) {
  const sys = `אתה מערכת לפתיחת קריאות שירות במפעל ייצור (Motorad). תקבל ניתוח של סרטון שצולם על ידי עובד ליד מכונה.
עליך להפיק טיוטת קריאת שירות מובנית בעברית, כ-JSON בלבד, במבנה הבא:
{
  "מספר_מכונה": string,
  "כותרת_קריאה": string (עד 10 מילים),
  "תיאור_התקלה": string (תיאור מלא וברור),
  "קטגוריה": string (מכני / חשמלי / הידראולי / פנאומטי / בקרה-תוכנה / אחר),
  "דחיפות": string (נמוכה / בינונית / גבוהה / קריטית — האם המכונה מושבתת?),
  "מכונה_מושבתת": boolean,
  "סיכון_בטיחותי": boolean,
  "פעולות_שבוצעו_על_ידי_העובד": string,
  "מידע_חסר": [string] (שאלות שכדאי לשאול את העובד),
  "רמת_ודאות": string (גבוהה / בינונית / נמוכה)
}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `מספר מכונה (מתוך QR): ${machineId}\n\nניתוח הסרטון:\n${geminiAnalysis}` },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || '';
  let serviceCall = null;
  try { serviceCall = JSON.parse(raw); } catch { /* נחזיר raw */ }
  return { serviceCall, serviceCallRaw: raw };
}

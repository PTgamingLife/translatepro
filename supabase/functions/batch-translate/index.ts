const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

const languages = {
  zh: { english: "Chinese", whisper: "zh" },
  en: { english: "English", whisper: "en" },
  vi: { english: "Vietnamese", whisper: "vi" },
  th: { english: "Thai", whisper: "th" },
  id: { english: "Indonesian", whisper: "id" }
} as const;

type LanguageCode = keyof typeof languages;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

    const url = new URL(req.url);
    const source = languageCode(url.searchParams.get("source") || "zh");
    const target = languageCode(url.searchParams.get("target") || "en");
    if (source === target) throw new Error("Source and target languages must be different");

    const audio = await req.arrayBuffer();
    if (!audio.byteLength) throw new Error("No audio body received");

    const contentType = req.headers.get("content-type") || "audio/webm";
    const transcript = await transcribe(apiKey, audio, contentType, source);
    const translation = await translate(apiKey, transcript, source, target);

    return json({ source, target, transcript, translation });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Translation failed" }, 500);
  }
});

function languageCode(value: string): LanguageCode {
  if (value in languages) return value as LanguageCode;
  throw new Error(`Unsupported language: ${value}`);
}

async function transcribe(apiKey: string, audio: ArrayBuffer, contentType: string, source: LanguageCode) {
  const form = new FormData();
  const extension = contentType.includes("mp4") ? "mp4" : contentType.includes("ogg") ? "ogg" : "webm";
  form.append("file", new Blob([audio], { type: contentType }), `recording.${extension}`);
  form.append("model", Deno.env.get("OPENAI_TRANSCRIBE_MODEL") || "gpt-4o-transcribe");
  form.append("response_format", "json");
  form.append("language", languages[source].whisper);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Transcription failed");
  return String(data.text || "").trim();
}

async function translate(apiKey: string, transcript: string, source: LanguageCode, target: LanguageCode) {
  if (!transcript) return "";

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: Deno.env.get("OPENAI_TRANSLATE_MODEL") || "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "You are a professional live interpreter. Translate the user's full transcript into the target language. Preserve meaning, context, tone, numbers, names, and intent. Return only the translated text."
        },
        {
          role: "user",
          content: `Source language: ${languages[source].english}\nTarget language: ${languages[target].english}\n\nTranscript:\n${transcript}`
        }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Translation failed");
  return extractOutputText(data).trim();
}

function extractOutputText(data: { output_text?: string; output?: unknown[] }) {
  if (typeof data.output_text === "string") return data.output_text;

  const chunks: string[] = [];
  for (const item of data.output || []) {
    if (!item || typeof item !== "object" || !("content" in item)) continue;
    const content = (item as { content?: unknown[] }).content || [];
    for (const part of content) {
      if (part && typeof part === "object" && "text" in part) {
        chunks.push(String((part as { text: unknown }).text));
      }
    }
  }
  return chunks.join("\n");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders
  });
}

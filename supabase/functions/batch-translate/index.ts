const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

const languages = {
  zh: { english: "Traditional Chinese (Taiwan)", whisper: "zh" },
  en: { english: "English", whisper: "en" },
  vi: { english: "Vietnamese", whisper: "vi" },
  th: { english: "Thai", whisper: "th" },
  id: { english: "Indonesian", whisper: "id" }
} as const;

const modeConfig = {
  fast: {
    transcribeModel: "gpt-4o-mini-transcribe",
    translateModel: "gpt-4.1-mini"
  },
  accurate: {
    transcribeModel: "gpt-4o-transcribe",
    translateModel: "gpt-4.1"
  }
} as const;

type LanguageCode = keyof typeof languages;
type TranslateMode = keyof typeof modeConfig;

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
    const mode = translateMode(url.searchParams.get("mode") || "accurate");
    if (source === target) throw new Error("Source and target languages must be different");

    const audio = await req.arrayBuffer();
    if (!audio.byteLength) throw new Error("No audio body received");

    const startedAt = Date.now();
    const contentType = req.headers.get("content-type") || "audio/webm";
    const transcript = await transcribe(apiKey, audio, contentType, source, mode);
    const translation = await translate(apiKey, transcript, source, target, mode);

    return json({
      source,
      target,
      mode,
      elapsedMs: Date.now() - startedAt,
      transcript,
      translation
    });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Translation failed" }, 500);
  }
});

function languageCode(value: string): LanguageCode {
  if (value in languages) return value as LanguageCode;
  throw new Error(`Unsupported language: ${value}`);
}

function translateMode(value: string): TranslateMode {
  return value === "fast" ? "fast" : "accurate";
}

async function transcribe(
  apiKey: string,
  audio: ArrayBuffer,
  contentType: string,
  source: LanguageCode,
  mode: TranslateMode
) {
  const configuredModel =
    mode === "fast" ? Deno.env.get("OPENAI_FAST_TRANSCRIBE_MODEL") : Deno.env.get("OPENAI_TRANSCRIBE_MODEL");
  const form = new FormData();
  const extension = contentType.includes("mp4") ? "mp4" : contentType.includes("ogg") ? "ogg" : "webm";
  form.append("file", new Blob([audio], { type: contentType }), `recording.${extension}`);
  form.append("model", configuredModel || modeConfig[mode].transcribeModel);
  form.append("response_format", "json");
  form.append("language", languages[source].whisper);
  form.append("prompt", transcriptionPrompt(source));

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Transcription failed");
  return String(data.text || "").trim();
}

async function translate(
  apiKey: string,
  transcript: string,
  source: LanguageCode,
  target: LanguageCode,
  mode: TranslateMode
) {
  if (!transcript) return "";

  const configuredModel =
    mode === "fast" ? Deno.env.get("OPENAI_FAST_TRANSLATE_MODEL") : Deno.env.get("OPENAI_TRANSLATE_MODEL");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: configuredModel || modeConfig[mode].translateModel,
      input: [
        {
          role: "system",
          content: translationInstructions(target, mode)
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

function transcriptionPrompt(source: LanguageCode) {
  if (source === "zh") {
    return "請使用繁體中文（台灣用字）轉錄，不要使用簡體中文。";
  }
  return "Transcribe accurately. Preserve names, numbers, and spoken meaning.";
}

function translationInstructions(target: LanguageCode, mode: TranslateMode) {
  const quality =
    mode === "fast"
      ? "Prioritize speed while preserving the main meaning."
      : "Prioritize accuracy, context consistency, terminology, names, numbers, and tone.";
  const traditionalChineseRule =
    target === "zh"
      ? "The target is Traditional Chinese for Taiwan. Use only Traditional Chinese characters. Do not use Simplified Chinese."
      : "";

  return [
    "You are a professional live interpreter.",
    quality,
    "Translate the full transcript into the target language.",
    "Do not summarize. Do not add commentary. Return only the translated text.",
    traditionalChineseRule
  ]
    .filter(Boolean)
    .join(" ");
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

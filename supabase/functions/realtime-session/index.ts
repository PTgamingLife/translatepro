const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

const languages = {
  zh: { label: "Traditional Chinese (Taiwan)", code: "zh" },
  en: { label: "English", code: "en" },
  vi: { label: "Vietnamese", code: "vi" },
  th: { label: "Thai", code: "th" },
  id: { label: "Indonesian", code: "id" }
} as const;

type LanguageCode = keyof typeof languages;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

    const body = await req.json().catch(() => ({}));
    const source = languageCode(body.source || "zh");
    const target = languageCode(body.target || "en");
    if (source === target) throw new Error("Source and target languages must be different");

    const model = Deno.env.get("OPENAI_REALTIME_MODEL") || "gpt-realtime";
    const payload = {
      session: {
        type: "realtime",
        model,
        instructions: realtimeInstructions(source, target),
        output_modalities: ["text"],
        audio: {
          input: {
            transcription: {
              model: Deno.env.get("OPENAI_REALTIME_TRANSCRIBE_MODEL") || "gpt-4o-mini-transcribe",
              language: languages[source].code
            },
            turn_detection: {
              type: "server_vad",
              silence_duration_ms: 520
            }
          }
        }
      }
    };

    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "Could not create realtime session");

    return json({
      client_secret: data.client_secret?.value || data.value || data.client_secret,
      expires_at: data.expires_at || data.client_secret?.expires_at,
      model
    });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Realtime session failed" }, 500);
  }
});

function languageCode(value: string): LanguageCode {
  if (value in languages) return value as LanguageCode;
  throw new Error(`Unsupported language: ${value}`);
}

function realtimeInstructions(source: LanguageCode, target: LanguageCode) {
  const traditionalChineseRule =
    target === "zh"
      ? "The target is Traditional Chinese for Taiwan. Use only Traditional Chinese characters. Do not use Simplified Chinese."
      : "";

  return [
    "You are a professional realtime interpreter.",
    `Translate spoken ${languages[source].label} into ${languages[target].label}.`,
    "Return only the translated meaning. Do not answer, explain, summarize, or add commentary.",
    "Preserve names, numbers, dates, tone, and intent.",
    traditionalChineseRule
  ]
    .filter(Boolean)
    .join(" ");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders
  });
}

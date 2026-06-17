import http from "node:http";
import os from "node:os";
import { readFile, stat } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);
const maxPortAttempts = Number(process.env.PORT_RETRY_COUNT || 20);
const realtimeModel = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const modeConfig = {
  fast: {
    transcribeModel: "gpt-4o-mini-transcribe",
    translateModel: "gpt-4.1-mini"
  },
  accurate: {
    transcribeModel: "gpt-4o-transcribe",
    translateModel: "gpt-4.1"
  }
};

loadLocalEnv();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"]
]);

function loadLocalEnv() {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(__dirname, name);
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, model: realtimeModel });
      }

      if (req.method === "POST" && url.pathname === "/api/realtime-session") {
        const body = await readJson(req);
        return createRealtimeSession(res, body);
      }

      if (req.method === "POST" && url.pathname === "/api/batch-translate") {
        return batchTranslateRecording(req, res, url);
      }

      if (req.method === "GET") {
        return serveStatic(res, url.pathname);
      }

      json(res, 405, { error: "Method not allowed" });
    } catch (error) {
      console.error(error);
      json(res, 500, { error: "Internal server error" });
    }
  });
}

async function createRealtimeSession(res, body) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return json(res, 500, { error: "OPENAI_API_KEY is not configured." });
    }

    const source = normalizeLanguage(body.source);
    const target = normalizeLanguage(body.target);
    if (!source || !target) {
      return json(res, 400, { error: "Missing source or target language." });
    }
    if (source.code === target.code) {
      return json(res, 400, { error: "Source and target languages must be different." });
    }

    const payload = {
      model: realtimeModel,
      instructions: realtimeInstructions(source, target),
      modalities: ["text"],
      input_audio_transcription: {
        model: process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
        language: source.realtimeCode
      },
      turn_detection: {
        type: "server_vad",
        silence_duration_ms: 520
      }
    };

    const result = await postOpenAI("/v1/realtime/client_secrets", payload);
    json(res, 200, {
      client_secret: result.client_secret?.value || result.value || result.client_secret,
      expires_at: result.expires_at || result.client_secret?.expires_at,
      model: realtimeModel
    });
  } catch (error) {
    console.error(error);
    json(res, error.status || 502, {
      error: error.message || "Could not create realtime session."
    });
  }
}

async function batchTranslateRecording(req, res, url) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return json(res, 500, { error: "OPENAI_API_KEY is not configured." });
    }

    const source = normalizeLanguage(url.searchParams.get("source"));
    const target = normalizeLanguage(url.searchParams.get("target"));
    const mode = normalizeMode(url.searchParams.get("mode"));
    if (!source || !target) {
      return json(res, 400, { error: "Missing source or target language." });
    }

    const audioBuffer = await readRawBody(req);
    if (!audioBuffer.length) {
      return json(res, 400, { error: "No audio was uploaded." });
    }

    const contentType = req.headers["content-type"] || "audio/webm";
    const extension = extensionForAudioType(contentType);
    const startedAt = Date.now();
    const transcript = await transcribeAudio(audioBuffer, contentType, extension, source, mode);
    const translation = await translateTranscript(transcript, source, target, mode);

    json(res, 200, {
      source: source.label,
      target: target.label,
      mode,
      elapsedMs: Date.now() - startedAt,
      transcript,
      translation
    });
  } catch (error) {
    console.error(error);
    json(res, error.status || 502, {
      error: error.message || "Batch translation failed."
    });
  }
}

async function postOpenAI(pathname, payload) {
  const response = await fetch(`https://api.openai.com${pathname}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data.error?.message || `OpenAI request failed: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function transcribeAudio(audioBuffer, contentType, extension, source, mode) {
  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: contentType });
  const configuredModel = mode === "fast" ? process.env.OPENAI_FAST_TRANSCRIBE_MODEL : process.env.OPENAI_TRANSCRIBE_MODEL;
  form.append("file", blob, `recording.${extension}`);
  form.append("model", configuredModel || modeConfig[mode].transcribeModel);
  form.append("response_format", "json");
  form.append("language", source.realtimeCode);
  form.append("prompt", transcriptionPrompt(source));

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: form
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data.error?.message || `Transcription failed: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data.text || "";
}

async function translateTranscript(transcript, source, target, mode) {
  if (!transcript.trim()) return "";

  const configuredModel = mode === "fast" ? process.env.OPENAI_FAST_TRANSLATE_MODEL : process.env.OPENAI_TRANSLATE_MODEL;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: configuredModel || modeConfig[mode].translateModel,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: translationInstructions(source, target, mode)
            }
          ]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: transcript }]
        }
      ]
    })
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data.error?.message || `Translation failed: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data.output_text || extractResponseText(data);
}

function extractResponseText(data) {
  return (data.output || [])
    .flatMap((item) => item.content || [])
    .map((part) => part.text || "")
    .filter(Boolean)
    .join("\n");
}

function extensionForAudioType(contentType) {
  if (contentType.includes("mp4")) return "mp4";
  if (contentType.includes("mpeg")) return "mp3";
  if (contentType.includes("ogg")) return "ogg";
  if (contentType.includes("wav")) return "wav";
  return "webm";
}

function transcriptionPrompt(source) {
  if (source.code === "zh") {
    return "請使用繁體中文（台灣用字）轉錄，不要使用簡體中文。";
  }
  return "Transcribe accurately. Preserve names, numbers, and spoken meaning.";
}

function translationInstructions(source, target, mode) {
  const quality = mode === "fast"
    ? "Prioritize speed while preserving the main meaning."
    : "Prioritize accuracy, context consistency, terminology, names, numbers, and tone.";
  const traditionalChineseRule = target.code === "zh"
    ? "The target is Traditional Chinese for Taiwan. Use only Traditional Chinese characters. Do not use Simplified Chinese."
    : "";

  return [
    "You are a professional interpreter.",
    `Translate the full ${source.label} transcript into ${target.label}.`,
    quality,
    "Preserve meaning across the whole recording, including context from earlier and later sentences.",
    "Do not summarize. Do not add commentary. Output only the translated text.",
    traditionalChineseRule
  ].filter(Boolean).join(" ");
}

function realtimeInstructions(source, target) {
  const traditionalChineseRule = target.code === "zh"
    ? "The target is Traditional Chinese for Taiwan. Use only Traditional Chinese characters. Do not use Simplified Chinese."
    : "";

  return [
    "You are a professional realtime interpreter.",
    `Translate spoken ${source.label} into ${target.label}.`,
    "Return only the translated meaning. Do not answer, explain, summarize, or add commentary.",
    "Preserve names, numbers, dates, tone, and intent.",
    traditionalChineseRule
  ].filter(Boolean).join(" ");
}

function normalizeMode(mode) {
  return mode === "fast" ? "fast" : "accurate";
}

function normalizeLanguage(language) {
  const languages = {
    zh: { code: "zh", label: "Traditional Chinese (Taiwan)", realtimeCode: "zh" },
    en: { code: "en", label: "English", realtimeCode: "en" },
    vi: { code: "vi", label: "Vietnamese", realtimeCode: "vi" },
    th: { code: "th", label: "Thai", realtimeCode: "th" },
    id: { code: "id", label: "Indonesian", realtimeCode: "id" }
  };
  return languages[language];
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) {
    return json(res, 403, { error: "Forbidden" });
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    res.writeHead(200, {
      "Content-Type": mimeTypes.get(path.extname(filePath)) || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    createReadStream(filePath).pipe(res);
  } catch {
    const html = await readFile(path.join(publicDir, "index.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function listenWithFallback(targetPort, attempt) {
  const server = createServer();

  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attempt < maxPortAttempts) {
      const nextPort = targetPort + 1;
      console.warn(`Port ${targetPort} is already in use. Trying ${nextPort}...`);
      listenWithFallback(nextPort, attempt + 1);
      return;
    }

    console.error(error);
    process.exit(1);
  });

  server.listen(targetPort, () => {
    console.log(`TranslatePro Hybrid Interpreter running at http://localhost:${targetPort}`);
    for (const address of getLanAddresses()) {
      console.log(`LAN URL: http://${address}:${targetPort}`);
    }
    console.log("iPhone microphone access needs HTTPS. Use GitHub Pages or an HTTPS tunnel for phone testing.");
  });
}

function getLanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
}

listenWithFallback(port, 0);

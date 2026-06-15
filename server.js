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
const realtimeModel = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-translate";

loadLocalEnv();

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

    if (req.method === "POST" && url.pathname === "/api/realtime-sdp") {
      const body = await readJson(req);
      return exchangeRealtimeSdp(res, body);
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

    const instructions = [
      "You are a professional live interpreter.",
      `Translate spoken ${source.label} into ${target.label}.`,
      "Return only the translated meaning. Preserve names, numbers, dates, and tone.",
      "Do not answer questions, add commentary, or explain the translation."
    ].join(" ");

    const modernPayload = {
      session: {
        type: "realtime",
        model: realtimeModel,
        instructions,
        output_modalities: ["text"],
        audio: {
          input: {
            transcription: {
              model: "gpt-realtime-whisper",
              language: source.realtimeCode
            },
            turn_detection: {
              type: "server_vad",
              silence_duration_ms: 650
            }
          }
        }
      }
    };

    const fallbackPayload = {
      session: {
        type: "realtime",
        model: realtimeModel,
        instructions,
        modalities: ["text"],
        input_audio_transcription: {
          model: "gpt-realtime-whisper",
          language: source.realtimeCode
        },
        turn_detection: {
          type: "server_vad",
          silence_duration_ms: 650
        }
      }
    };

    const result = await postOpenAI("/v1/realtime/client_secrets", modernPayload)
      .catch(async (firstError) => {
        const fallback = await postOpenAI("/v1/realtime/client_secrets", fallbackPayload)
          .catch(() => null);
        if (fallback) return fallback;
        throw firstError;
      });

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

async function exchangeRealtimeSdp(res, body) {
  const clientSecret = typeof body.client_secret === "string" ? body.client_secret : "";
  const sdp = typeof body.sdp === "string" ? body.sdp : "";
  const model = typeof body.model === "string" ? body.model : realtimeModel;

  if (!clientSecret || !sdp) {
    return json(res, 400, { error: "Missing client_secret or sdp." });
  }

  const endpoints = [
    `/v1/realtime?model=${encodeURIComponent(model)}`,
    `/v1/realtime/calls?model=${encodeURIComponent(model)}`
  ];

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const answer = await postOpenAISdp(endpoint, clientSecret, sdp);
      res.writeHead(200, { "Content-Type": "application/sdp" });
      res.end(answer);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  json(res, lastError?.status || 502, {
    error: lastError?.message || "Realtime SDP exchange failed."
  });
}

async function batchTranslateRecording(req, res, url) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return json(res, 500, { error: "OPENAI_API_KEY is not configured." });
    }

    const source = normalizeLanguage(url.searchParams.get("source"));
    const target = normalizeLanguage(url.searchParams.get("target"));
    if (!source || !target) {
      return json(res, 400, { error: "Missing source or target language." });
    }

    const audioBuffer = await readRawBody(req);
    if (!audioBuffer.length) {
      return json(res, 400, { error: "No audio was uploaded." });
    }

    const contentType = req.headers["content-type"] || "audio/webm";
    const extension = extensionForAudioType(contentType);
    const transcript = await transcribeAudio(audioBuffer, contentType, extension, source);
    const translation = await translateTranscript(transcript, source, target);

    json(res, 200, {
      source: source.label,
      target: target.label,
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
      "Content-Type": "application/json",
      "OpenAI-Beta": "realtime=v1"
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

async function postOpenAISdp(pathname, clientSecret, sdp) {
  const response = await fetch(`https://api.openai.com${pathname}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      "Content-Type": "application/sdp"
    },
    body: sdp
  });

  const text = await response.text();
  if (!response.ok) {
    let message = `OpenAI SDP request failed: ${response.status}`;
    try {
      const data = JSON.parse(text);
      message = data.error?.message || message;
    } catch {
      if (text) message = text;
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return text;
}

async function transcribeAudio(audioBuffer, contentType, extension, source) {
  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: contentType });
  form.append("file", blob, `recording.${extension}`);
  form.append("model", process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe");
  form.append("response_format", "json");
  form.append("language", source.realtimeCode);

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

async function translateTranscript(transcript, source, target) {
  if (!transcript.trim()) return "";

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_TRANSLATE_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: [
                "You are a professional interpreter.",
                `Translate the full ${source.label} transcript into ${target.label}.`,
                "Preserve meaning across the whole recording, including context from earlier and later sentences.",
                "Do not summarize. Do not add commentary. Output only the translated text."
              ].join(" ")
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

function normalizeLanguage(language) {
  const languages = {
    zh: { label: "Chinese", realtimeCode: "zh" },
    en: { label: "English", realtimeCode: "en" },
    vi: { label: "Vietnamese", realtimeCode: "vi" },
    th: { label: "Thai", realtimeCode: "th" },
    id: { label: "Indonesian", realtimeCode: "id" }
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

listenWithFallback(port, 0);

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
    console.log(`TranslatePro Realtime Interpreter running at http://localhost:${targetPort}`);
    for (const address of getLanAddresses()) {
      console.log(`LAN URL: http://${address}:${targetPort}`);
    }
    console.log("iPhone microphone access needs HTTPS. Use a deployed HTTPS URL or an HTTPS tunnel for real phone testing.");
  });
}

function getLanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
}

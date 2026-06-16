const languages = [
  { code: "zh", label: "繁體中文", english: "Traditional Chinese (Taiwan)", speech: "zh-TW" },
  { code: "en", label: "English", english: "English", speech: "en-US" },
  { code: "vi", label: "Tiếng Việt", english: "Vietnamese", speech: "vi-VN" },
  { code: "th", label: "ไทย", english: "Thai", speech: "th-TH" },
  { code: "id", label: "Bahasa Indonesia", english: "Indonesian", speech: "id-ID" }
];

const placeholders = {
  zh: {
    source: "按「上方說話」或「下方說話」開始即時翻譯。",
    translation: "繁體中文翻譯會顯示在這裡。",
    inactive: "等待另一方說話。"
  },
  en: {
    source: "Press a speak button to start live translation.",
    translation: "English translation will appear here.",
    inactive: "Waiting for the other side to speak."
  },
  vi: {
    source: "Bấm nút nói để bắt đầu dịch trực tiếp.",
    translation: "Bản dịch tiếng Việt sẽ hiển thị ở đây.",
    inactive: "Đang chờ phía bên kia nói."
  },
  th: {
    source: "กดปุ่มพูดเพื่อเริ่มแปลแบบสด",
    translation: "คำแปลภาษาไทยจะแสดงที่นี่",
    inactive: "กำลังรออีกฝ่ายพูด"
  },
  id: {
    source: "Tekan tombol bicara untuk mulai menerjemahkan langsung.",
    translation: "Terjemahan bahasa Indonesia akan muncul di sini.",
    inactive: "Menunggu pihak lain berbicara."
  }
};

const els = {
  topLanguage: document.querySelector("#topLanguage"),
  bottomLanguage: document.querySelector("#bottomLanguage"),
  topOriginal: document.querySelector("#topOriginal"),
  bottomOriginal: document.querySelector("#bottomOriginal"),
  topTranslation: document.querySelector("#topTranslation"),
  bottomTranslation: document.querySelector("#bottomTranslation"),
  topStatus: document.querySelector("#topStatus"),
  bottomStatus: document.querySelector("#bottomStatus"),
  topSpeakButton: document.querySelector("#topSpeakButton"),
  bottomSpeakButton: document.querySelector("#bottomSpeakButton"),
  stopButton: document.querySelector("#stopButton"),
  exportButton: document.querySelector("#exportButton"),
  speakToggle: document.querySelector("#speakToggle"),
  voiceSelect: document.querySelector("#voiceSelect"),
  swapButton: document.querySelector("#swapButton"),
  mobileNotice: document.querySelector("#mobileNotice"),
  dismissNotice: document.querySelector("#dismissNotice"),
  setupNotice: document.querySelector("#setupNotice"),
  setupForm: document.querySelector("#setupForm"),
  projectRefInput: document.querySelector("#projectRefInput")
};

let recorder = null;
let mediaStream = null;
let audioChunks = [];
let peerConnection = null;
let dataChannel = null;
let activeSide = null;
let activeDirection = "bottom-to-top";
let realtimeText = "";
let log = [];

init();

function init() {
  fillLanguageSelect(els.topLanguage, "en");
  fillLanguageSelect(els.bottomLanguage, "zh");
  registerServiceWorker();
  setupBackendConfig();
  showMobileNoticeIfNeeded();
  resetText();

  els.topSpeakButton.addEventListener("click", () => startSpeaking("top"));
  els.bottomSpeakButton.addEventListener("click", () => startSpeaking("bottom"));
  els.stopButton.addEventListener("click", stopAndCorrect);
  els.exportButton.addEventListener("click", exportText);
  els.swapButton.addEventListener("click", swapLanguages);
  els.topLanguage.addEventListener("change", resetText);
  els.bottomLanguage.addEventListener("change", resetText);
  els.dismissNotice?.addEventListener("click", () => {
    localStorage.setItem("translatepro-mobile-notice-dismissed", "1");
    els.mobileNotice.hidden = true;
  });
}

function fillLanguageSelect(select, defaultValue) {
  select.innerHTML = "";
  for (const language of languages) {
    const option = document.createElement("option");
    option.value = language.code;
    option.textContent = language.label;
    option.selected = language.code === defaultValue;
    select.append(option);
  }
}

async function startSpeaking(side) {
  if (activeSide === side && recorder?.state === "recording") return;

  try {
    if (recorder?.state === "recording") {
      await stopCurrentSession({ correct: false });
    }

    assertBackendReady();
    assertAudioReady();
    activeSide = side;
    activeDirection = side === "top" ? "top-to-bottom" : "bottom-to-top";
    realtimeText = "";
    audioChunks = [];
    setLiveState("realtime", side);
    setSourceText("正在聆聽，並即時翻譯...");
    setTargetText("即時翻譯啟動中...");

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    startMediaRecorder(mediaStream);
    await startRealtime(mediaStream, sourceLanguage(), targetLanguage());
    setTargetText("請開始說話，即時翻譯會顯示在這裡。");
  } catch (error) {
    console.error(error);
    await stopCurrentSession({ correct: false });
    setLiveState("idle");
    alert(formatStartError(error));
  }
}

function startMediaRecorder(stream) {
  recorder = new MediaRecorder(stream, mediaRecorderOptions());
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data?.size) audioChunks.push(event.data);
  });
  recorder.start();
}

async function startRealtime(stream, source, target) {
  const session = await createRealtimeSession(source, target);
  const clientSecret = session.client_secret;
  const model = session.model || "gpt-realtime";
  if (!clientSecret) throw new Error("Realtime session 沒有回傳 client secret。");

  peerConnection = new RTCPeerConnection();
  dataChannel = peerConnection.createDataChannel("oai-events");
  dataChannel.addEventListener("message", handleRealtimeMessage);

  for (const track of stream.getAudioTracks()) {
    peerConnection.addTrack(track, stream);
  }

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  const response = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      "Content-Type": "application/sdp"
    },
    body: offer.sdp
  });

  const answer = await response.text();
  if (!response.ok) throw new Error(answer || "Realtime SDP 連線失敗。");
  await peerConnection.setRemoteDescription({ type: "answer", sdp: answer });
}

async function createRealtimeSession(source, target) {
  const response = await fetch(realtimeSessionUrl(), {
    method: "POST",
    headers: edgeHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ source, target })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Realtime session 建立失敗。");
  return data;
}

function handleRealtimeMessage(event) {
  let data = null;
  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }

  const delta = data.delta || data.text || "";
  if (["response.text.delta", "response.output_text.delta", "response.audio_transcript.delta"].includes(data.type) && delta) {
    realtimeText += delta;
    setTargetText(`即時翻譯：\n${realtimeText}`);
  }

  if (data.type === "conversation.item.input_audio_transcription.completed" && data.transcript) {
    setSourceText(data.transcript);
  }

  if (data.type === "response.done" && realtimeText.trim()) {
    pushLog("即時翻譯", realtimeText.trim());
    els.exportButton.disabled = false;
  }
}

async function stopAndCorrect() {
  if (!recorder || recorder.state !== "recording") return;
  await stopCurrentSession({ correct: true });
}

async function stopCurrentSession({ correct }) {
  const source = sourceLanguage();
  const target = targetLanguage();
  const mimeType = recorder?.mimeType || audioChunks[0]?.type || "audio/webm";

  closeRealtime();

  if (recorder && recorder.state === "recording") {
    await new Promise((resolve) => {
      recorder.addEventListener("stop", resolve, { once: true });
      recorder.stop();
    });
  }

  const chunks = [...audioChunks];
  stopTracks();
  recorder = null;
  audioChunks = [];
  activeSide = null;

  if (!correct) {
    setLiveState("idle");
    return;
  }

  try {
    setLiveState("correcting");
    setTargetText("正在用完整錄音修正翻譯...");
    const audioBlob = new Blob(chunks, { type: mimeType });
    if (!audioBlob.size) throw new Error("沒有收到錄音，請確認麥克風權限後再試一次。");
    const data = await requestCorrection(audioBlob, mimeType, source, target);
    applyCorrectionResult(data, target);
    setLiveState("idle", null, "已修正");
  } catch (error) {
    console.error(error);
    alert(error.message || "修正翻譯失敗");
    setLiveState("idle", null, "修正失敗");
  }
}

async function requestCorrection(audioBlob, mimeType, source, target) {
  const response = await fetch(batchTranslateUrl(source, target, "accurate"), {
    method: "POST",
    headers: edgeHeaders({ "Content-Type": mimeType }),
    body: audioBlob
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "修正翻譯失敗");
  return data;
}

function applyCorrectionResult(data, target) {
  const transcript = data.transcript || "沒有轉錄出文字。";
  const translation = data.translation || "沒有翻譯結果。";
  setSourceText(transcript);
  setTargetText(`修正翻譯：\n${translation}`);
  pushLog("完整轉錄", transcript);
  pushLog("修正翻譯", translation);
  els.exportButton.disabled = log.length === 0;

  if (els.speakToggle.checked && data.translation) {
    speakTranslatedText(data.translation, target);
  }
}

function closeRealtime() {
  dataChannel?.close();
  peerConnection?.close();
  dataChannel = null;
  peerConnection = null;
}

function stopTracks() {
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
}

function sourceLanguage() {
  return activeSide === "top" ? els.topLanguage.value : els.bottomLanguage.value;
}

function targetLanguage() {
  return activeSide === "top" ? els.bottomLanguage.value : els.topLanguage.value;
}

function setSourceText(text) {
  const element = activeSide === "top" ? els.topOriginal : els.bottomOriginal;
  setPlaceholder(element, text);
}

function setTargetText(text) {
  const element = activeSide === "top" ? els.bottomTranslation : els.topTranslation;
  setPlaceholder(element, text);
}

function batchTranslateUrl(source, target, mode) {
  const query = `source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}&mode=${encodeURIComponent(mode)}`;
  const edgeUrl = configuredEdgeFunctionBaseUrl("batch-translate");
  if (edgeUrl) return `${edgeUrl}?${query}`;
  if (isLocalBackend()) return `/api/batch-translate?${query}`;
  throw new Error("請先設定 Supabase Project Ref，GitHub Pages 需要透過 Edge Function 翻譯。");
}

function realtimeSessionUrl() {
  const edgeUrl = configuredEdgeFunctionBaseUrl("realtime-session");
  if (edgeUrl) return edgeUrl;
  if (isLocalBackend()) return "/api/realtime-session";
  throw new Error("請先設定 Supabase Project Ref，才能建立 Realtime session。");
}

function configuredEdgeFunctionBaseUrl(functionName) {
  const config = window.TRANSLATEPRO_CONFIG || {};
  const directUrl = config[`${functionName}Url`];
  if (directUrl) return directUrl.replace(/\/$/, "");

  const projectRef = config.supabaseProjectRef || localStorage.getItem("translatepro-project-ref");
  if (!projectRef) return "";
  return `https://${projectRef}.supabase.co/functions/v1/${functionName}`;
}

function edgeHeaders(baseHeaders = {}) {
  const config = window.TRANSLATEPRO_CONFIG || {};
  const anonKey = config.supabaseAnonKey || localStorage.getItem("translatepro-anon-key");
  if (!anonKey || isLocalBackend()) return baseHeaders;
  return {
    ...baseHeaders,
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`
  };
}

function setupBackendConfig() {
  const config = window.TRANSLATEPRO_CONFIG || {};
  const storedRef = localStorage.getItem("translatepro-project-ref") || "";
  const configured = Boolean(config.supabaseProjectRef || storedRef);

  if (els.projectRefInput) {
    els.projectRefInput.value = storedRef || config.supabaseProjectRef || "";
  }

  if (els.setupNotice) {
    els.setupNotice.hidden = isLocalBackend() || configured;
  }

  els.setupForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = els.projectRefInput.value.trim();
    if (!value) return;
    localStorage.setItem("translatepro-project-ref", value);
    els.setupNotice.hidden = true;
  });
}

function assertBackendReady() {
  if (isLocalBackend()) return;
  if (configuredEdgeFunctionBaseUrl("batch-translate") && configuredEdgeFunctionBaseUrl("realtime-session")) return;
  els.setupNotice.hidden = false;
  throw new Error("請先輸入 Supabase Project Ref，才能從 GitHub Pages 使用翻譯。");
}

function isLocalBackend() {
  return ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
}

function mediaRecorderOptions() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type));
  return mimeType ? { mimeType } : {};
}

function assertAudioReady() {
  if (!window.isSecureContext) {
    throw new Error("iPhone 需要 HTTPS 才能使用麥克風。請用 GitHub Pages、Supabase 或 https tunnel 開啟。");
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !window.RTCPeerConnection) {
    throw new Error("這個瀏覽器不支援即時錄音翻譯。請使用新版 iPhone Safari/Chrome 或桌面瀏覽器。");
  }
}

function setLiveState(state, side = null, statusText = null) {
  const isBusy = state !== "idle";
  document.body.classList.toggle("is-live", isBusy);
  els.topSpeakButton.disabled = state === "correcting";
  els.bottomSpeakButton.disabled = state === "correcting";
  els.stopButton.disabled = state !== "realtime";
  els.topSpeakButton.classList.toggle("primary", side !== "bottom");
  els.bottomSpeakButton.classList.toggle("primary", side !== "top");

  const text =
    statusText ||
    (state === "realtime" ? (side === "top" ? "上方說話中" : "下方說話中") : state === "correcting" ? "修正中" : "待機");
  els.topStatus.textContent = text;
  els.bottomStatus.textContent = text;
}

function resetText() {
  if (recorder?.state === "recording") return;
  const topText = placeholders[els.topLanguage.value] || placeholders.en;
  const bottomText = placeholders[els.bottomLanguage.value] || placeholders.en;
  setPlaceholder(els.topOriginal, topText.source);
  setPlaceholder(els.topTranslation, topText.translation);
  setPlaceholder(els.bottomOriginal, bottomText.source);
  setPlaceholder(els.bottomTranslation, bottomText.translation);
  setLiveState("idle");
}

function setPlaceholder(element, text) {
  element.dataset.placeholder = text;
  element.textContent = text;
}

function speakTranslatedText(text, targetCode) {
  if (!("speechSynthesis" in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = languageOf(targetCode).speech;
  utterance.rate = voiceRate(els.voiceSelect.value);
  utterance.pitch = voicePitch(els.voiceSelect.value);
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function voiceRate(voice) {
  return voice === "verse" ? 1.04 : voice === "ash" ? 0.92 : 0.98;
}

function voicePitch(voice) {
  return voice === "shimmer" ? 1.12 : voice === "ash" ? 0.88 : 1;
}

function pushLog(kind, text) {
  if (!text.trim()) return;
  log.push({
    at: new Date().toISOString(),
    direction: activeDirection,
    kind,
    text: text.trim()
  });
}

function exportText() {
  const lines = [
    "TranslatePro Hybrid Interpreter Export",
    `Exported: ${new Date().toLocaleString()}`,
    `Top: ${labelOf(els.topLanguage.value)}`,
    `Bottom: ${labelOf(els.bottomLanguage.value)}`,
    "",
    ...log.map((entry) => `[${entry.at}] ${entry.direction} ${entry.kind}\n${entry.text}\n`)
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `translatepro-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function swapLanguages() {
  const top = els.topLanguage.value;
  els.topLanguage.value = els.bottomLanguage.value;
  els.bottomLanguage.value = top;
  resetText();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./service-worker.js").catch((error) => {
    console.warn("Service worker registration failed", error);
  });
}

function showMobileNoticeIfNeeded() {
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const dismissed = localStorage.getItem("translatepro-mobile-notice-dismissed") === "1";
  if (!els.mobileNotice || dismissed || !isMobile) return;
  els.mobileNotice.hidden = false;
}

function formatStartError(error) {
  if (error?.name === "NotAllowedError") return "麥克風權限被拒絕。請允許此網站使用麥克風。";
  if (error?.name === "NotFoundError") return "找不到可用的麥克風，請確認裝置或耳機麥克風是否正常。";
  return error?.message || "即時翻譯啟動失敗";
}

function labelOf(code) {
  return languageOf(code).label;
}

function languageOf(code) {
  return languages.find((language) => language.code === code) || languages[0];
}

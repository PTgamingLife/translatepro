const languages = [
  { code: "zh", label: "中文", english: "Chinese", speech: "zh-TW" },
  { code: "en", label: "English", english: "English", speech: "en-US" },
  { code: "vi", label: "Tiếng Việt", english: "Vietnamese", speech: "vi-VN" },
  { code: "th", label: "ไทย", english: "Thai", speech: "th-TH" },
  { code: "id", label: "Bahasa Indonesia", english: "Indonesian", speech: "id-ID" }
];

const placeholders = {
  zh: {
    sourceTop: "按下開始後錄音；按結束後會一次轉錄完整中文。",
    sourceBottom: "按下開始後錄音；按結束後會一次轉錄完整中文。",
    translation: "中文翻譯會顯示在這裡。",
    inactive: "目前不是翻譯輸出區。"
  },
  en: {
    sourceTop: "Recording starts after Start; full English transcript appears after End.",
    sourceBottom: "Recording starts after Start; full English transcript appears after End.",
    translation: "English translation will appear here.",
    inactive: "This side is not the current translation output."
  },
  vi: {
    sourceTop: "Bấm bắt đầu để ghi âm; bản ghi tiếng Việt sẽ hiển thị sau khi kết thúc.",
    sourceBottom: "Bấm bắt đầu để ghi âm; bản ghi tiếng Việt sẽ hiển thị sau khi kết thúc.",
    translation: "Bản dịch tiếng Việt sẽ hiển thị ở đây.",
    inactive: "Khu vực này hiện không phải là kết quả dịch."
  },
  th: {
    sourceTop: "กดเริ่มเพื่อบันทึกเสียง ข้อความภาษาไทยจะแสดงหลังจากกดจบ",
    sourceBottom: "กดเริ่มเพื่อบันทึกเสียง ข้อความภาษาไทยจะแสดงหลังจากกดจบ",
    translation: "คำแปลภาษาไทยจะแสดงที่นี่",
    inactive: "ส่วนนี้ไม่ใช่พื้นที่แสดงผลคำแปลในขณะนี้"
  },
  id: {
    sourceTop: "Tekan mulai untuk merekam; transkrip lengkap muncul setelah selesai.",
    sourceBottom: "Tekan mulai untuk merekam; transkrip lengkap muncul setelah selesai.",
    translation: "Terjemahan bahasa Indonesia akan muncul di sini.",
    inactive: "Sisi ini bukan area hasil terjemahan saat ini."
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
  startButton: document.querySelector("#startButton"),
  stopButton: document.querySelector("#stopButton"),
  exportButton: document.querySelector("#exportButton"),
  speakToggle: document.querySelector("#speakToggle"),
  voiceSelect: document.querySelector("#voiceSelect"),
  directionSelect: document.querySelector("#directionSelect"),
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
let activeDirection = "bottom-to-top";
let log = [];

init();

function init() {
  fillLanguageSelect(els.topLanguage, "en");
  fillLanguageSelect(els.bottomLanguage, "zh");
  registerServiceWorker();
  setupBackendConfig();
  showMobileNoticeIfNeeded();
  resetText();

  els.startButton.addEventListener("click", startRecording);
  els.stopButton.addEventListener("click", stopRecording);
  els.exportButton.addEventListener("click", exportText);
  els.swapButton.addEventListener("click", swapLanguages);
  els.topLanguage.addEventListener("change", resetText);
  els.bottomLanguage.addEventListener("change", resetText);
  els.directionSelect.addEventListener("change", resetText);
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

async function startRecording() {
  if (recorder?.state === "recording") return;

  try {
    assertBackendReady();
    assertAudioReady();
    resetText();
    log = [];
    audioChunks = [];
    activeDirection = els.directionSelect.value;
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    recorder = new MediaRecorder(mediaStream, mediaRecorderOptions());
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) audioChunks.push(event.data);
    });
    recorder.addEventListener("stop", translateRecording);
    recorder.start();
    setLiveState(true, "錄音中");
    setSourceText("錄音中...請完整說完後再按結束並翻譯。");
  } catch (error) {
    console.error(error);
    cleanupRecording();
    setLiveState(false, "待機");
    alert(formatStartError(error));
  }
}

function stopRecording() {
  if (!recorder || recorder.state !== "recording") return;
  setLiveState(true, "處理中");
  recorder.stop();
}

async function translateRecording() {
  try {
    const source = activeDirection === "bottom-to-top" ? els.bottomLanguage.value : els.topLanguage.value;
    const target = activeDirection === "bottom-to-top" ? els.topLanguage.value : els.bottomLanguage.value;
    const mimeType = recorder.mimeType || audioChunks[0]?.type || "audio/webm";
    const audioBlob = new Blob(audioChunks, { type: mimeType });

    if (!audioBlob.size) throw new Error("沒有收到錄音，請確認麥克風權限後再試一次。");

    setSourceText("錄音完成，正在轉成文字並翻譯...");
    const response = await fetch(batchTranslateUrl(source, target), {
      method: "POST",
      headers: { "Content-Type": mimeType },
      body: audioBlob
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "翻譯服務失敗");

    setSourceText(data.transcript || "沒有轉錄出文字。");
    setTargetText(data.translation || "沒有翻譯結果。");
    pushLog("transcript", data.transcript || "");
    pushLog("translation", data.translation || "");

    if (els.speakToggle.checked && data.translation) {
      speakTranslatedText(data.translation, target);
    }
    els.exportButton.disabled = log.length === 0;
    setLiveState(false, "已結束");
  } catch (error) {
    console.error(error);
    alert(error.message || "翻譯服務失敗");
    setLiveState(false, "失敗");
  } finally {
    cleanupRecording();
  }
}

function batchTranslateUrl(source, target) {
  const query = `source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`;
  const edgeUrl = configuredEdgeFunctionUrl();
  if (edgeUrl) return `${edgeUrl}?${query}`;
  if (isLocalBackend()) return `/api/batch-translate?${query}`;
  throw new Error("請先設定 Supabase Project Ref，GitHub Pages 需要透過 Edge Function 翻譯。");
}

function configuredEdgeFunctionUrl() {
  const config = window.TRANSLATEPRO_CONFIG || {};
  const directUrl = config.edgeFunctionUrl || localStorage.getItem("translatepro-edge-url");
  if (directUrl) return directUrl.replace(/\/$/, "");

  const projectRef = config.supabaseProjectRef || localStorage.getItem("translatepro-project-ref");
  if (!projectRef) return "";
  return `https://${projectRef}.supabase.co/functions/v1/batch-translate`;
}

function setupBackendConfig() {
  const config = window.TRANSLATEPRO_CONFIG || {};
  const storedRef = localStorage.getItem("translatepro-project-ref") || "";
  const storedUrl = localStorage.getItem("translatepro-edge-url") || "";
  const configured = Boolean(config.supabaseProjectRef || config.edgeFunctionUrl || storedRef || storedUrl);

  if (els.projectRefInput) {
    els.projectRefInput.value = storedRef || config.supabaseProjectRef || config.edgeFunctionUrl || storedUrl || "";
  }

  if (els.setupNotice) {
    els.setupNotice.hidden = isLocalBackend() || configured;
  }

  els.setupForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = els.projectRefInput.value.trim();
    if (!value) return;

    if (value.startsWith("https://")) {
      localStorage.setItem("translatepro-edge-url", value);
      localStorage.removeItem("translatepro-project-ref");
    } else {
      localStorage.setItem("translatepro-project-ref", value);
      localStorage.removeItem("translatepro-edge-url");
    }
    els.setupNotice.hidden = true;
  });
}

function assertBackendReady() {
  if (isLocalBackend()) return;
  if (configuredEdgeFunctionUrl()) return;
  els.setupNotice.hidden = false;
  throw new Error("請先輸入 Supabase Project Ref，才能從 GitHub Pages 使用翻譯。");
}

function isLocalBackend() {
  return ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
}

function mediaRecorderOptions() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus"
  ];
  const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type));
  return mimeType ? { mimeType } : {};
}

function cleanupRecording() {
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  recorder = null;
  audioChunks = [];
}

function assertAudioReady() {
  if (!window.isSecureContext) {
    throw new Error("iPhone 需要 HTTPS 才能使用麥克風。請用 GitHub Pages、Supabase 或 https tunnel 開啟。");
  }

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error("這個瀏覽器不支援錄音。請使用 iPhone Safari/Chrome 或新版桌面瀏覽器。");
  }
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
  if (error?.name === "NotAllowedError") {
    return "麥克風權限被拒絕。請到瀏覽器或 iPhone 設定中允許此網站使用麥克風。";
  }
  if (error?.name === "NotFoundError") {
    return "找不到可用的麥克風，請確認裝置或耳機麥克風是否正常。";
  }
  return error?.message || "錄音啟動失敗";
}

function setSourceText(text) {
  const element = activeDirection === "bottom-to-top" ? els.bottomOriginal : els.topOriginal;
  setPlaceholder(element, text);
}

function setTargetText(text) {
  const element = activeDirection === "bottom-to-top" ? els.topTranslation : els.bottomTranslation;
  setPlaceholder(element, text);
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

function setLiveState(isBusy, text) {
  const isRecording = text === "錄音中";
  document.body.classList.toggle("is-live", isBusy);
  els.topStatus.textContent = text;
  els.bottomStatus.textContent = text;
  els.startButton.disabled = isBusy;
  els.stopButton.disabled = !isRecording;
}

function resetText() {
  const topCode = els.topLanguage.value;
  const bottomCode = els.bottomLanguage.value;
  const topText = placeholders[topCode] || placeholders.en;
  const bottomText = placeholders[bottomCode] || placeholders.en;
  const isBottomToTop = els.directionSelect.value === "bottom-to-top";

  setPlaceholder(els.topOriginal, isBottomToTop ? topText.inactive : topText.sourceTop);
  setPlaceholder(els.bottomOriginal, isBottomToTop ? bottomText.sourceBottom : bottomText.inactive);
  setPlaceholder(els.topTranslation, isBottomToTop ? topText.translation : topText.inactive);
  setPlaceholder(els.bottomTranslation, isBottomToTop ? bottomText.inactive : bottomText.translation);
}

function setPlaceholder(element, text) {
  element.dataset.placeholder = text;
  element.textContent = text;
}

function exportText() {
  const lines = [
    "TranslatePro Batch Interpreter Export",
    `Exported: ${new Date().toLocaleString()}`,
    `Top: ${labelOf(els.topLanguage.value)}`,
    `Bottom: ${labelOf(els.bottomLanguage.value)}`,
    `Direction: ${els.directionSelect.value}`,
    "",
    ...log.map((entry) => `[${entry.at}] ${entry.kind}\n${entry.text}\n`)
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

function labelOf(code) {
  return languageOf(code).label;
}

function languageOf(code) {
  return languages.find((language) => language.code === code) || languages[1];
}

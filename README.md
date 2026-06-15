# TranslatePro Realtime Interpreter

即時雙向口譯網頁 App。畫面上下分區，上方倒置給對面使用者閱讀，下方正向顯示本端語言。後端使用 OpenAI Realtime API 建立短期 client secret，瀏覽器透過 WebRTC 串流麥克風音訊。

## Run

```powershell
npm start
```

開啟 `http://localhost:3000`。

如果 `3000` 已被占用，程式會自動嘗試下一個 port，請以終端機顯示的網址為準。

## iPhone / Mobile

這個專案已做成手機可用的 PWA：

- iPhone Safari 或 Chrome 可直接開啟網頁使用。
- Safari 可用「分享」->「加入主畫面」變成像 App 一樣開啟。
- 版面支援直向手機、安全區、44px 以上觸控按鈕。

重要限制：手機麥克風需要安全來源。若要在 iPhone 上按「開始」使用麥克風，網址必須是 HTTPS。

可用方式：

1. 部署到支援 HTTPS 的服務，例如 Vercel、Render、Railway、Fly.io。
2. 本機測試時用 HTTPS tunnel，例如 ngrok 或 localtunnel，把終端機顯示的本機 port 對外成 HTTPS。

範例：

```powershell
npm start
npx localtunnel --port 3001
```

把 localtunnel 顯示的 `https://...` 網址用 iPhone 打開。

## Environment

`.env.local` 需要：

```env
OPENAI_API_KEY=...
```

## Voice Recommendations

- `alloy`: 中性、穩定，適合正式口譯，預設推薦。
- `coral`: 溫暖、清楚，適合客服與商務對話。
- `verse`: 表情較明顯，適合導覽、主持。
- `shimmer`: 明亮清晰，適合短句提醒。
- `ash`: 沉穩低調，適合會議。

## Notes

- `gpt-realtime-translate` 用於即時翻譯。
- `gpt-realtime-whisper` 用於即時語音轉文字。
- 結束後可匯出 `.txt` 對話紀錄。
- Supabase 目前未啟用；若要雲端保存，可在 `server.js` 增加上傳 endpoint。

# TranslatePro Batch Interpreter

手機可用的雙向口譯網頁 App。畫面分成上下兩個語言區塊，上方區塊 180 度旋轉，方便面對面使用。按「開始錄音」後只錄音，按「結束並翻譯」後才把完整錄音一次交給 AI 轉錄與翻譯，讓上下文更連貫。

支援語言：

- 中文
- English
- Tiếng Việt
- ไทย
- Bahasa Indonesia

## Local Run

```powershell
npm start
```

本機預設網址：

```text
http://localhost:3000
```

如果 3000 已被占用，伺服器會自動改用下一個可用 port。

## Environment

本機開發請建立 `.env.local`：

```env
OPENAI_API_KEY=...
```

不要把 API key 放進 GitHub Pages 或任何前端檔案。

## GitHub Pages

這個 repo 已加入 GitHub Pages workflow：

```text
.github/workflows/pages.yml
```

推到 `main` 後，GitHub Actions 會部署 `public/`。Pages 網址通常會是：

```text
https://ptgaminglife.github.io/translatepro/
```

若第一次啟用 Pages，請到 GitHub repo：

```text
Settings -> Pages -> Build and deployment -> Source -> GitHub Actions
```

## Supabase Edge Function

GitHub Pages 只能放靜態前端，OpenAI API key 應放在 Supabase Edge Function Secrets。

部署步驟：

```powershell
supabase login
supabase link --project-ref <你的 Supabase Project Ref>
supabase secrets set OPENAI_API_KEY=<你的 OpenAI API key>
supabase functions deploy batch-translate --no-verify-jwt
```

`--no-verify-jwt` 是為了讓 GitHub Pages 打開後可直接呼叫此 Function。正式公開使用前，建議再加上用量限制、驗證或網域限制。

## Configure Frontend

有兩種方式設定 Supabase：

1. 編輯 `public/config.js`：

```js
window.TRANSLATEPRO_CONFIG = {
  supabaseProjectRef: "你的 Supabase Project Ref"
};
```

2. 或直接打開 GitHub Pages，第一次使用時在畫面下方輸入 Project Ref。

前端會呼叫：

```text
https://<project-ref>.supabase.co/functions/v1/batch-translate
```

## iPhone / Mobile

iPhone 麥克風需要 HTTPS。請使用 GitHub Pages 或其他 HTTPS 網址開啟，不要用區網 IP 的 `http://`。

可加入主畫面：

```text
Safari -> 分享 -> 加入主畫面
```

## Voice Recommendations

- `alloy`: 推薦，中性穩定，適合一般口譯。
- `coral`: 友善明亮，適合服務情境。
- `verse`: 自然敘述，適合較長句子。
- `shimmer`: 輕快清楚，適合提示與短句。
- `ash`: 低沉穩重，適合正式說明。

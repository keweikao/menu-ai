# Menu AI Backend 技術文件

---

## 專案簡介

一個基於 Node.js + Slack Bolt 的智慧菜單優化 Slack Bot，結合 Google Cloud Vision OCR 與 Gemini AI，協助餐廳將傳統菜單轉換為高效的線上點餐菜單，並提供多輪互動、菜單優化建議、Excel 匯出功能。

---

## 架構總覽

- **語言/框架**：Node.js (CommonJS)
- **API**：
  - Google Cloud Vision OCR
  - Gemini 1.5 Pro
  - Slack Bolt (Socket Mode)
- **資料庫**：PostgreSQL
- **部署平台**：Zeabur
- **Package Manager**：npm
- **匯出格式**：Excel (.xlsx)

---

## 主要功能

### 1. 上傳菜單檔案

- 支援圖片 (JPG, PNG, HEIC)、PDF、CSV、純文字
- 圖片/PDF 會自動進行 OCR 文字辨識
- CSV/文字直接讀取內容

### 2. 收集背景資訊

- Bot 會在 Slack 討論串中詢問以下**必填**資訊：
  - 餐廳類型與風格 (例如：台式早午餐、健康餐盒、義式小館等)
  - 主要目標客群 (例如：學生、上班族、家庭、健身人士等)
  - 希望主打品項 (請提供 5-8 項)
  - 希望提升銷量品項 (請提供 5-8 項)
  - 目前客單價範圍 (選填)
  - 使用的點餐平台限制 (選填)

### 3. 主要分析 Prompt

- 嚴格根據你提供的 Prompt，產出 Markdown 格式的優化建議
- **不會自行新增菜單中未出現的品項**
- 內容包含：
  - 菜單分類架構
  - 主打推薦區
  - 套餐組合
  - 單品優化
  - 飲品專區
  - 加購選項
  - 策略總結

### 4. 多輪對話

- 使用者可在討論串中繼續提問
- Bot 會根據完整歷史紀錄與菜單內容，持續優化建議

### 5. 指令

- **`統整建議`**：請 Gemini 根據目前所有對話紀錄，產出最新版本的 Markdown 優化建議
- **`提供 excel`** 或 **`提供 csv`**：請 Gemini 產出 JSON，轉換成 Excel 檔案並上傳

### 6. 匯出 Excel

- 只保留有加價的標籤
- 商品名稱自動移除 emoji
- 稅別固定 `"TX"`
- 稅率固定 `"0.05"`

---

## 技術細節

### Slack Bot

- 使用 `@slack/bolt` Socket Mode
- 監聽 `app_mention` 事件觸發流程
- 監聽 `message` 事件處理多輪對話、指令
- 會將每次對話存入 PostgreSQL

### Google Cloud Vision OCR

- 支援圖片與 PDF 文字辨識
- 使用 `GOOGLE_CREDENTIALS` JSON 金鑰初始化
- OCR 結果存入資料庫

### Gemini 1.5 Pro

- 使用 `callGemini()` 函式呼叫
- 傳入完整歷史紀錄 (`geminiHistory`)
- 使用者提供的 Prompt 會被嚴格遵守
- 產出 Markdown 或 JSON 格式

### 資料庫結構

- `menus`：儲存菜單檔案資訊
- `conversations`：
  - `menu_id`
  - `slack_channel_id`
  - `slack_thread_ts`
  - `status` (`pending_info`、`active`)
- `messages`：
  - `conversation_id`
  - `sender` (`user` 或 `ai`)
  - `content`
  - `created_at`

---

## 部署注意事項

- **Package Manager**：請設定為 `npm`
- **Install Command**：`npm install`
- **Start Command**：`node server.js` 或 `npm start`
- **Node 版本**：建議 18+
- **環境變數**：
  - `DATABASE_URL`
  - `GOOGLE_CREDENTIALS`
  - `GEMINI_API_KEY`
  - `SLACK_BOT_TOKEN`
  - `SLACK_APP_TOKEN`

---

## 常見問題

- **Push 被 GitHub 阻擋**：
  - 因為敏感金鑰洩漏，請用 `git filter-repo` 清除歷史
  - 或刪除 repo 重新建立
- **Zeabur 偵測錯誤 Package Manager**：
  - 手動設定為 `npm`
- **Zeabur 部署失敗**：
  - 檢查 `server.js` 是否有 `<final_file_content>` 或 `IMPORTANT:` 等非 JS 內容
  - 確認啟動指令正確
- **Gemini 忽略歷史紀錄**：
  - 已加入完整歷史紀錄傳遞
  - 可用 `console.log` 追蹤

---

## 未來優化建議

- 支援多語言
- 增加菜單圖片自動分類
- 自動辨識高毛利品項
- 整合更多 POS 或點餐平台
- 增加管理後台介面
- 增加權限控管

---

## 作者

- 由 AI 協助產生，持續優化中
- 任何問題請聯繫專案負責人 Stephen

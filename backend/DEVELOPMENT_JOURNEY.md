# Menu AI Backend - 開發歷程記錄

這份文件記錄了 `menu-ai-backend` Slack Bot 從概念到實現的主要開發過程、遇到的挑戰以及最終的解決方案。

## 1. 初始目標與概念 (已廢棄)

專案最初的目標是建立一個**網頁介面**，讓業務可以上傳菜單檔案 (CSV 或圖片)，並透過 AI 分析提供優化建議。當時規劃了簡單的前後端架構 (React + Node/Express)。

## 2. 轉向 Slack Bot 整合

根據使用者需求，專案目標轉變為將核心功能整合進 **Slack Bot**，讓使用者可以直接在熟悉的 Slack 環境中完成所有操作。

**主要考量：**
- 提升易用性，減少使用者切換工具的麻煩。
- 利用 Slack 的檔案上傳、訊息通知、討論串等功能。

## 3. 核心功能開發

### a. Slack Bot 框架

- 選用 **`@slack/bolt`** 框架。
- 採用 **Socket Mode** 連接，簡化部署和本地開發，無需公開 URL。
- 設定必要的 Bot Token Scopes (`app_mentions:read`, `chat:write`, `files:read`, `files:write` 等) 和 Event Subscriptions (`app_mention`, `message.channels` 等)。

### b. 檔案處理與 OCR

- **檔案上傳觸發**：最終流程改為監聽 `app_mention` 事件，並檢查訊息是否**同時附加檔案**。
- **檔案下載**：使用 `axios` 搭配 Bot Token 從 Slack 下載檔案到伺服器暫存 (`uploads/` 目錄)。
- **OCR 整合**：
    - 引入 **`@google-cloud/vision`**。
    - 針對圖片 (`image/*`) 和 PDF (`application/pdf`) 檔案，呼叫 Vision API 進行文字辨識。
    - CSV/TXT 檔案則直接讀取文字內容。
    - 使用 `GOOGLE_CREDENTIALS` 環境變數進行驗證。

### c. Gemini AI 整合

- **主要分析 Prompt**：根據使用者最新需求，設計了詳細的 Prompt，包含角色設定、核心任務、輸入資訊、輸出格式要求 (Markdown)，並強調**僅根據提供內容優化、不新增品項、不使用 emoji**。
- **Excel 匯出 Prompt**：設計了另一個 Prompt，明確要求 Gemini 根據對話歷史和菜單，輸出**嚴格符合指定欄位的 JSON 格式**資料，以便後續轉換。
- **API 呼叫**：使用 `axios` 呼叫 Gemini API (`gemini-1.5-pro` 或更新版本)，並傳遞對話歷史 (`history`)。

### d. 資料庫與狀態管理

- **資料庫**：使用 PostgreSQL (透過 Zeabur 服務)。
- **資料表**：
    - `menus`: 儲存上傳的菜單檔案路徑與名稱。
    - `conversations`: 記錄每次 Slack 互動的對話 ID、對應的菜單 ID、Slack 頻道 ID、討論串時間戳 (`slack_thread_ts`)，以及**狀態 (`status`)** (`pending_info`, `active`)。
    - `messages`: 儲存使用者 (`user`) 和 AI (`ai`) 的對話紀錄，關聯 `conversation_id`。
- **狀態流程**：
    1.  `app_mention` + 檔案 -> 建立 `menus` 和 `conversations` 紀錄 (status='pending_info') -> Bot 詢問背景資訊。
    2.  使用者在討論串回覆 -> 找到 `pending_info` 的 conversation -> 結合菜單內容與背景資訊呼叫 Gemini (主要分析 Prompt) -> 儲存訊息 -> 更新 conversation status='active' -> 回覆 Markdown 建議。
    3.  使用者在 `active` 討論串回覆 -> 讀取歷史 -> 呼叫 Gemini -> 儲存訊息 -> 回覆。
    4.  使用者在 `active` 討論串輸入 `統整建議` -> 讀取歷史 -> 呼叫 Gemini (Markdown 摘要 Prompt) -> 回覆 Markdown。
    5.  使用者在 `active` 討論串輸入 `提供 excel` -> 讀取歷史 -> 呼叫 Gemini (JSON 輸出 Prompt) -> 解析 JSON -> 產生 Excel -> 上傳 Excel。

### e. Excel 匯出客製化

- **套件**：使用 `exceljs`。
- **資料來源**：解析 Gemini 針對 Excel 指令回傳的 JSON 資料。
- **格式調整**：
    - 只保留包含 `(+數字)` 的標籤。
    - 商品名稱移除 emoji。
    - 稅別固定為 "TX"。
    - 稅率固定為 "0.05"。
- **檔案上傳**：使用 `@slack/bolt` 的 `client.files.uploadV2` 上傳 `.xlsx` 檔案。

## 4. 功能微調與迭代 (Iterative Refinements)

在核心功能開發完成後，根據使用者的回饋進行了多次調整：

- **Slack 互動流程**：
    - 最初嘗試監聽 `file_shared` 事件，但發現難以取得使用者互動的上下文。
    - 改為監聽 `app_mention`，並假設使用者會「先上傳檔案，再提及 Bot」。
    - 最終優化為監聽 `app_mention`，並直接處理**訊息中附加的檔案**，同時要求使用者在討論串中提供背景資訊，流程更為順暢。
- **背景資訊問題**：
    - Bot 詢問的問題內容經過多次修改，從一開始較簡略，到後來根據使用者提供的詳細 Prompt 調整，最終確定為包含「餐廳類型與風格」、「主要目標客群」、「希望主打品項」、「希望提昇銷量商品」、「目前客單價範圍」、「使用的點餐平台限制」的版本。
- **主要分析 Prompt**：
    - 根據使用者回饋，多次調整 Prompt 內容，加入更明確的指示，例如：
        - 強調**僅能**根據提供的菜單和資訊優化，**不可新增品項**。
        - 要求**嚴格遵守**指定的 Markdown 輸出結構。
        - 要求**不要使用 emoji**。
- **匯出功能**：
    - 最初設計為匯出 CSV，後根據需求改為匯出 **Excel (.xlsx)** 檔案，並引入 `exceljs` 套件。
    - 新增「**統整建議**」指令，用於在 Slack 中直接輸出**最新**的 Markdown 格式建議，不匯出檔案。
    - 針對 Excel 匯出內容進行微調：
        - **標籤欄位**：加入邏輯，只保留包含 `(+數字)` 的加價標籤。
        - **商品名稱**：加入 `removeEmojis` 函式，移除名稱中的 emoji。
        - **稅務欄位**：固定填入 `TX` 和 `0.05`。
    - 調整要求 Gemini 產出 Excel 資料的 Prompt，明確要求輸出 **JSON 格式**，並指定欄位名稱，以提高 `generateExcelBuffer` 函式解析的成功率。

## 5. 開發與部署挑戰及解決方案

### a. 模組系統問題 (ESM vs CommonJS)

- **問題**：專案最初使用 ES Module (`import`)，但在 Zeabur 部署時，部分 CommonJS 套件 (如 `pg`, `@slack/bolt`) 的載入方式出現問題，導致 `Named export ... not found` 或 `SyntaxError: Unexpected token '<'` 等錯誤。
- **解決方案**：將整個後端專案**轉換為 CommonJS (`require`)** 格式。
    - 移除 `package.json` 中的 `"type": "module"`。
    - 將所有 `import` 改為 `require`。

### b. Git 歷史紀錄包含敏感金鑰

- **問題**：開發過程中不慎將 Google Cloud Service Account 的 `.json` 金鑰檔案 commit 到 Git 歷史紀錄中。即使後續加入 `.gitignore` 並修正最新 commit，GitHub Push Protection 仍會掃描歷史紀錄並阻止推送。
- **解決方案**：
    - **方法一 (推薦但複雜)**：使用 `git filter-repo` 或 BFG Repo-Cleaner 等工具**重寫 Git 歷史紀錄**，徹底移除敏感檔案。
    - **方法二 (使用者選擇)**：**刪除本地和遠端 (GitHub) 的儲存庫，重新建立一個乾淨的儲存庫**，只 commit 不含敏感資訊的最終程式碼。

### c. Zeabur 部署環境問題

- **問題**：即使確認本地和 GitHub 程式碼正確，Zeabur 部署後仍出現 `SyntaxError: Unexpected token '<'`，懷疑是 Zeabur 的建置快取或環境問題。
- **嘗試的解決方案**：
    - **修改 `package.json`**：試圖觸發 Zeabur 的完整重新建置 (但似乎無效)。
    - **檢查 Zeabur 設定**：確認 Package Manager 為 `npm`，Start Command 為 `node server.js`。
    - **簡化程式碼測試**：暫時註解大部分程式碼，確認最小可行版本能部署成功，證明問題在程式碼內部。
    - **最終解決**：轉換為 CommonJS 似乎解決了潛在的模組載入衝突，以及後續發現是自動化工具寫入錯誤內容導致檔案損毀。

### d. 自動化工具不穩定

- **問題**：在開發過程中，使用 AI 助理的 `write_to_file` 和 `replace_in_file` 工具修改 `server.js` 時，**頻繁發生檔案損毀或修改失敗**的情況，導致需要反覆修正或手動介入。
- **解決方案**：在工具不穩定時，改為**手動複製貼上**完整的程式碼，以確保檔案內容的正確性，再進行 commit 和 push。

## 6. 最終狀態

目前的 `menu-ai-backend` 專案是一個功能完整的 Slack Bot，使用 CommonJS，整合了 OCR、Gemini AI，並能根據使用者提供的目標進行菜單優化，支援多輪對話、Markdown 摘要和 Excel 匯出。部署在 Zeabur 上，使用 npm 管理套件。

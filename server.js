require('dotenv').config();
const axios = require('axios');
const pg = require('pg');
const { Pool } = pg;
const fs = require('fs/promises');
const path = require('path');
const vision = require('@google-cloud/vision');
const { App: BoltApp, LogLevel } = require('@slack/bolt');
const Papa = require('papaparse');
const ExcelJS = require('exceljs'); // Import exceljs

// --- Basic Setup ---
// dotenv is configured at the top

// --- Slack Bolt App Initialization ---
const boltApp = new BoltApp({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

console.log("Slack Bolt App initialized.");

const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdir(UPLOAD_DIR, { recursive: true }).catch(console.error);

// --- Database Setup ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// --- Vision AI Client Setup ---
let visionClient;
try {
    let clientOptions = {};
    if (process.env.GOOGLE_CREDENTIALS) {
        console.log("Found GOOGLE_CREDENTIALS env var. Initializing Vision client with provided credentials.");
        try {
            const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
            clientOptions = { credentials };
        } catch (parseError) {
            console.error("!!! ERROR PARSING GOOGLE_CREDENTIALS JSON !!!", parseError);
        }
    } else {
        console.log("GOOGLE_CREDENTIALS env var not found. Initializing Vision client using default ADC.");
    }
    visionClient = new vision.ImageAnnotatorClient(clientOptions);
    console.log("Google Cloud Vision AI Client initialization attempted.");
} catch (visionError) {
    console.error("!!! FAILED TO INITIALIZE GOOGLE CLOUD VISION AI CLIENT !!!", visionError);
}

// --- Helper Functions ---
function sanitizeStringForDB(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\0/g, '');
}

// Function to remove common emojis (add more ranges if needed)
function removeEmojis(text) {
    if (typeof text !== 'string') return text;
    // Basic emoji ranges + specific star emoji
    return text.replace(/([\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA70}-\u{1FAFF}]|[\u{E0020}-\u{E007F}]|[\u{2B50}])\s*/gu, '').trim();
}


// --- Gemini API Helper ---
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`;

async function callGemini(prompt, history = []) {
  const validHistory = Array.isArray(history) ? history : [];
  const contents = [ ...validHistory, { role: "user", parts: [{ text: prompt }] } ];
  try {
    console.log(`Calling Gemini with ${contents.length} content parts. Prompt length: ${prompt?.length || 0}`);
    const response = await axios.post(GEMINI_API_URL, { contents });
    console.log("Gemini response received successfully.");
    const candidates = response.data.candidates;
    if (candidates && candidates.length > 0 && candidates[0].content && candidates[0].content.parts) {
        const responseText = candidates[0].content.parts.map(part => part.text).join('\n');
        console.log(`Gemini raw response text length: ${responseText.length}`);
        return sanitizeStringForDB(responseText);
    } else {
        const finishReason = candidates?.[0]?.finishReason;
        const safetyRatings = candidates?.[0]?.safetyRatings;
        console.error("Unexpected Gemini response structure or content blocked.");
        if (finishReason) console.error("Finish Reason:", finishReason);
        if (safetyRatings) console.error("Safety Ratings:", JSON.stringify(safetyRatings));
        throw new Error(`Failed to parse Gemini response. Finish Reason: ${finishReason || 'Unknown'}`);
    }
  } catch (error) {
    console.error('Error calling Gemini API:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
    const apiError = error.response?.data?.error;
    if (apiError) { throw new Error(`Gemini API Error: ${apiError.message} (Code: ${apiError.code})`); }
    throw new Error('Gemini API call failed');
  }
}

// --- OCR Helper ---
async function performOcr(filePath) {
    if (!visionClient) { throw new Error("Vision AI Client not available."); }
    console.log(`Performing OCR on file: ${filePath}`);
    try {
        const [result] = await visionClient.textDetection(filePath);
        const detections = result.textAnnotations;
        if (detections && detections.length > 0) {
            const fullText = detections[0].description;
            console.log(`OCR successful. Detected text length: ${fullText?.length || 0}`);
            return sanitizeStringForDB(fullText || '');
        } else {
            console.log("OCR completed, but no text detected.");
            return '';
        }
    } catch (ocrError) {
        console.error('Error performing OCR:', ocrError);
        if (ocrError.code === 7 || ocrError.message.includes('permission')) {
             console.error("!!! OCR FAILED - LIKELY PERMISSION ISSUE !!!");
        }
        throw new Error('OCR process failed');
    }
}

// --- Excel Generation Helper ---
async function generateExcelBuffer(structuredText) {
    console.log("Attempting to generate Excel from structured data...");
    let data = [];
    const maxTags = 12;

    try {
        const jsonMatch = structuredText.match(/```json\s*([\s\S]*?)\s*```|(\[[\s\S]*\])/);
        if (jsonMatch) {
            const jsonString = jsonMatch[1] || jsonMatch[2];
            data = JSON.parse(jsonString);
            console.log("Successfully parsed JSON data from Gemini response.");
            data = data.map(item => {
                const row = {
                    '商品名稱(半型字)': removeEmojis(item['商品名稱(半型字)'] || item['Item'] || item['品項'] || ''),
                    '價格': item['價格'] || item['Price'] || '',
                    '稅別(TX應稅,TF稅率)': 'TX', // Hardcoded
                    '稅率': '0.05', // Hardcoded
                };
                const pricedTags = [];
                for (let i = 1; i <= maxTags; i++) {
                    const tag = item[`標籤${i}`] || item[`Tag${i}`] || '';
                    if (/\(\+\d+\)/.test(tag)) { // Keep only tags with (+Number)
                        pricedTags.push(tag);
                    }
                }
                for (let i = 0; i < maxTags; i++) {
                    row[`標籤${i + 1}`] = pricedTags[i] || '';
                }
                return row;
            });
        } else {
             console.log("No JSON array found in response.");
             throw new Error("Not JSON");
        }
    } catch (e) {
        console.error("Failed to parse JSON or process data for Excel:", e.message);
        return null; // Return null if parsing fails
    }

     if (data.length === 0) {
         console.warn("No data parsed. Cannot generate Excel.");
         return null;
     }

    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('優化建議');
        const headers = [
            '商品名稱(半型字)', '價格', '稅別(TX應稅,TF稅率)', '稅率',
            ...Array.from({ length: maxTags }, (_, i) => `標籤${i + 1}`)
        ];
        worksheet.columns = headers.map(header => ({ header: header, key: header, width: 20 }));
        worksheet.addRows(data);
        console.log("Excel structure created.");
        const buffer = await workbook.xlsx.writeBuffer();
        console.log("Excel buffer generated successfully.");
        return buffer;
    } catch (excelError) {
        console.error("Error generating Excel buffer:", excelError);
        return null;
    }
}

// --- Slack Event Handlers ---

// Process uploaded file and create pending conversation
async function processAndStoreFile(client, fileId, channelId, threadTs, userId) {
    console.log(`Processing file ${fileId} for user ${userId} in channel ${channelId}, thread ${threadTs}`);
    let fileInfo;
    let downloadedFilePath = '';
    let menuId;

    try {
        fileInfo = await client.files.info({ file: fileId });
        console.log(`File info: ${fileInfo.file.name}, Type: ${fileInfo.file.mimetype}`);
        const supportedMimeTypes = ['image/', 'application/pdf', 'text/', 'application/csv'];
        if (!supportedMimeTypes.some(type => fileInfo.file.mimetype.startsWith(type))) {
            throw new Error(`不支援的檔案類型: ${fileInfo.file.mimetype}`);
        }
        if (!fileInfo.file.url_private_download) throw new Error("無法取得檔案下載連結。");

        const downloadResponse = await axios({
            method: 'get', url: fileInfo.file.url_private_download, responseType: 'arraybuffer',
            headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` }
        });
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const localFilename = `slack-${uniqueSuffix}${path.extname(fileInfo.file.name)}`;
        downloadedFilePath = path.join(UPLOAD_DIR, localFilename);
        await fs.writeFile(downloadedFilePath, downloadResponse.data);
        console.log(`File downloaded to ${downloadedFilePath}`);

        const dbClient = await pool.connect();
        try {
            await dbClient.query('BEGIN');
            const menuRes = await dbClient.query(
              'INSERT INTO menus (filename, filepath) VALUES ($1, $2) RETURNING id',
              [sanitizeStringForDB(fileInfo.file.name), sanitizeStringForDB(downloadedFilePath)]
            );
            menuId = menuRes.rows[0].id;
            await dbClient.query(
              'INSERT INTO conversations (menu_id, slack_channel_id, slack_thread_ts, status) VALUES ($1, $2, $3, $4)',
              [menuId, channelId, threadTs, 'pending_info']
            );
            await dbClient.query('COMMIT');
            console.log(`Menu ${menuId} and pending conversation created for thread ${threadTs}`);
            return menuId;
        } catch (dbError) {
            await dbClient.query('ROLLBACK');
            throw dbError;
        } finally {
            dbClient.release();
        }
    } catch (error) {
        console.error(`Error processing file ${fileId}:`, error);
        try {
            await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `處理檔案 "${fileInfo?.file?.name || fileId}" 時發生錯誤： ${error.message}` });
        } catch (slackError) {
            console.error("Failed to send error message to Slack:", slackError);
        }
        if (downloadedFilePath) {
            await fs.unlink(downloadedFilePath).catch(err => console.error(`Failed to delete temp file ${downloadedFilePath}:`, err));
        }
        return null;
    }
}

// Listen for mentions of the bot
boltApp.event('app_mention', async ({ event, client, say, logger }) => {
  logger.info(`Received app_mention event from user ${event.user} in channel ${event.channel}`);
  const threadTs = event.ts;

  if (event.files && event.files.length > 0) {
      const file = event.files[0];
      logger.info(`Mention included file: ${file.id} (${file.name})`);
      // Updated questions based on user feedback
      await say({ text: `收到菜單檔案 "${file.name}"！\n為了提供更精準的建議，請在這則訊息的討論串 (Thread) 中回覆以下資訊：\n\n-   **餐廳類型與風格**：(例如：台式早午餐、義式小館、日式拉麵...)\n-   **主要目標客群**：(例如：學生、上班族、家庭...)\n-   **(必填) 希望主打品項 (請提供 5-8 項)**：[請列出您想重點推廣的商品，這些將是菜單優化的 絕對核心]\n-   **(必填) 希望提昇銷量商品 (請提供 5-8 項)**：[請列出您想增加銷量的商品，這些是設計套餐、加購選項時的 重點考量]\n-   **目前客單價範圍**：`, thread_ts: threadTs });
      processAndStoreFile(client, file.id, event.channel, threadTs, event.user).catch(error => {
          logger.error("Error in background file processing:", error);
      });
  } else {
      logger.warn("Mention received without file.");
      await say({ text: `你好 <@${event.user}>！請 @我 並「同時附加」你的菜單檔案 (圖片/PDF/文字檔) 來開始分析。`, thread_ts: threadTs });
  }
});

// Listen for messages (primarily for collecting info and follow-ups)
boltApp.message(async ({ message, client, logger }) => {
    if (message.subtype === 'bot_message' || message.subtype === 'message_changed' || !message.text) return;

    const threadTs = message.thread_ts;
    const channelId = message.channel;
    const userId = message.user;
    const userMessageText = sanitizeStringForDB(message.text);

    if (threadTs) {
        logger.info(`Received threaded message from user ${userId} in thread ${threadTs}`);
        const dbClient = await pool.connect();
        try {
            const convRes = await dbClient.query(
                'SELECT id, menu_id, status FROM conversations WHERE slack_channel_id = $1 AND slack_thread_ts = $2',
                [channelId, threadTs]
            );

            if (convRes.rows.length > 0) {
                const conversation = convRes.rows[0];
                const conversationId = conversation.id;
                const menuId = conversation.menu_id;
                const status = conversation.status;

                // --- State 1: Waiting for Background Info ---
                if (status === 'pending_info') {
                    logger.info(`Processing background info for conversation ${conversationId}`);
                    const backgroundInfo = userMessageText;
                    if (!menuId) throw new Error('Menu ID missing for pending conversation.');

                    const menuRes = await dbClient.query('SELECT filepath FROM menus WHERE id = $1', [menuId]);
                    if (menuRes.rows.length === 0) throw new Error('Menu file record not found.');
                    const menuFilePath = menuRes.rows[0].filepath;
                    let menuContent = '';
                     try {
                         const fileExt = path.extname(menuFilePath).toLowerCase();
                         if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.pdf'].includes(fileExt)) {
                              menuContent = await performOcr(menuFilePath);
                         } else {
                              const rawMenuContent = await fs.readFile(menuFilePath, 'utf-8');
                              menuContent = sanitizeStringForDB(rawMenuContent);
                         }
                     } catch (readError) { throw new Error("無法讀取先前上傳的菜單檔案內容。"); }

                    // Updated Main Analysis Prompt
                    const newPrompt = `
# 角色 (Persona)
你是一位頂尖的餐飲顧問，專長是分析實體菜單，並將其轉化為高效的線上/掃碼點餐菜單。你尤其擅長以達成客戶指定的「主打品項」與「待提升銷量品項」推廣目標為核心策略，來設計菜單結構、套餐組合與追加銷售機制，並在此基礎上追求平均客單價 (AOV) 與訂單轉換率的最大化。你的輸出風格精煉、結構化，直接呈現優化方案。

# 核心任務 (Core Task)
接收我提供的菜單檔案 (或其他形式的菜單內容) 以及關鍵營運目標 (指定的 5-8 項主打品項 與 5-8 項待提升銷量品項)，進行專業分析。你的首要任務是產出一份以達成這些指定品項銷售目標為最高優先級的優化線上菜單建議，並**嚴格按照下方指定的「輸出格式與結構」**呈現。

# 關鍵輸入資訊 (Critical Inputs)

菜單檔案/內容：[請在此處告知 AI 菜單檔案已提供或將提供]
餐廳背景資訊 (盡可能提供)：
餐廳類型與風格：(例如：台式早午餐、義式小館、日式拉麵...)
主要目標客群：(例如：學生、上班族、家庭...)
(必填) 希望主打品項 (請提供 5-8 項)：[請列出您想重點推廣的商品，這些將是菜單優化的 絕對核心]
(必填) 希望提昇銷量商品 (請提供 5-8 項)：[請列出您想增加銷量的商品，這些是設計套餐、加購選項時的 重點考量]
(選填) 目前客單價範圍：
(選填) 使用的點餐平台限制：

# 輸出格式與結構要求 (Mandatory Output Format & Structure)
請**嚴格依照**以下 Markdown 格式與內容要求，直接產出以推廣目標品項為核心設計的優化方案：

---

## 1. 優化後的菜單分類架構（Menu Structure）

請根據實際菜單內容與指定目標品項，設計最合適的分類方式。分類應：
- 以線上點餐用戶的操作體驗為核心，分類清晰、邏輯直覺
- 命名具備行動誘導性（如：「立即推薦」「快速飽足」「人氣搭配」等）
- 若某些品項無法歸類進主分類，請設計「促購分類」或「加購區」提升曝光與搭配可能性
- 可依需要設計子分類（如：熱飲/冷飲、麵/飯類）

---

## 2. 主打推薦區（Featured Items with Embedded Upsells）

請設計一區作為首頁主打區塊，展示所有指定主打品項。每個品項請包含：
- 建議價格
- 是否建議搭配圖片 (若建議，請標註 [圖片])
- 品項簡短描述（可突顯口感、特色、人氣、限量、組合推薦）
- 搭配加購/升級選項（如：「推薦搭配豆乳紅茶折 10 元」、「可加購起司片 +15 元」）

---

## 3. 套餐組合設計（Bundles / Combos with Add-ons）

請設計 2–3 組具明確策略目的的套餐，包含：
- 套餐名稱與價格
- 組合內容（至少包含 1 項主打品項 + 1 項待提升品項）
- 加價或升級選項（如：飲品升級、份量放大）
- 套餐設計目的說明（如：引導搭配、提高冷門品項曝光）

---

## 4. 單品呈現優化（Item-Level Optimization）

針對所有指定主打與待提升品項，請提出：
- 是否建議搭配圖片 (若建議，請標註 [圖片])
- 行銷文案（15–25 字內，具吸引力）
- 可搭配的加購選項（如：「+ 溫泉蛋」、「+ 湯品」）
- 是否可設計為其他商品的加價升級版本

---

## 5. 飲品專區設計（Drinks Optimization）

請優化飲品專區，具備以下設計思維：
- 強化分類邏輯（如：冷熱分開、套餐推薦）
- 飲品升級方案（如：「+25 升級泰奶」、「點套餐可加購氣泡飲 30 元」）
- 若飲品為目標品項，設計曝光策略（如：搭配出現、結帳推薦）

---

## 6. 優化邏輯與策略總結（Strategy Summary）

請以表格方式整理整體設計策略邏輯：

| 優化策略             | 背後邏輯與心理誘因 |
|----------------------|------------------|
| 主打品項推薦設計     | 利用視覺與順序影響提升曝光與首選率 |
| 套餐組合帶入冷門品項 | 透過熱門商品引流，提升整體接受度 |
| 單品加購機制         | 喚起「可惜感」與加值感，帶動額外消費 |
| 飲品升級設計         | 引導價格比較與視覺誘因，提升飲品客單價 |
| 分類結構清晰化       | 降低點餐障礙與時間成本，提升整體轉換率 |

---

### 💡 備註
所有內容應具備實際操作可行性，建議以線上點餐系統如 inline、ezOrder、iCHEF 等使用情境作為思考依據。**請勿在輸出中使用任何 emoji**。
---
以下是菜單內容：
${menuContent}
`;
                    const sanitizedPrompt = sanitizeStringForDB(newPrompt);

                    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "收到您的餐廳資訊，正在產生優化建議..." });
                    const geminiResponseText = await callGemini(sanitizedPrompt);

                    await dbClient.query('BEGIN');
                    await dbClient.query('INSERT INTO messages (conversation_id, sender, content) VALUES ($1, $2, $3)', [conversationId, 'user', backgroundInfo]);
                    await dbClient.query('INSERT INTO messages (conversation_id, sender, content) VALUES ($1, $2, $3)', [conversationId, 'ai', geminiResponseText]);
                    await dbClient.query('UPDATE conversations SET status = $1 WHERE id = $2', ['active', conversationId]);
                    await dbClient.query('COMMIT');

                    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: geminiResponseText });
                    console.log(`Posted initial analysis after receiving info to thread ${threadTs}`);

                // --- State 2: Active Conversation or Excel Request ---
                } else if (status === 'active' || status === null) {
                    // Check for "提供 excel" command (or csv for backward compatibility)
                    if (userMessageText.toLowerCase().includes('提供 csv') || userMessageText.toLowerCase().includes('提供 excel')) {
                        logger.info(`Excel export command detected for thread ${threadTs}`);
                        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "收到 Excel 匯出指令，正在彙整報告並產生檔案..." });

                        const finalizationPromptText = `
請根據以下所有對話紀錄與原始菜單內容，彙整一份最終的、完整的菜單優化建議報告。
請**不要**包含任何開頭的問候語或結尾的總結。
請**嚴格**按照以下 JSON 格式輸出一個包含所有建議品項的陣列，每個品項包含 '商品名稱(半型字)', '價格', '標籤1', '標籤2', ..., '標籤12' 這些鍵。如果某個標籤不存在，請留空字串。價格請只包含數字。**商品名稱請勿包含任何 emoji**。

輸出範例：
\`\`\`json
[
  {
    "商品名稱(半型字)": "主打和牛漢堡",
    "價格": "350",
    "標籤1": "加起司(+30)",
    "標籤2": "加培根(+40)",
    "標籤3": "", "標籤4": "", "標籤5": "", "標籤6": "", "標籤7": "", "標籤8": "", "標籤9": "", "標籤10": "", "標籤11": "", "標籤12": ""
  },
  {
    "商品名稱(半型字)": "經典凱薩沙拉",
    "價格": "180",
    "標籤1": "加雞胸肉(+50)",
    "標籤2": "", "標籤3": "", "標籤4": "", "標籤5": "", "標籤6": "", "標籤7": "", "標籤8": "", "標籤9": "", "標籤10": "", "標籤11": "", "標籤12": ""
  }
]
\`\`\`
`;

                        if (!menuId) throw new Error('Menu ID not found for this conversation.');
                        const menuRes = await dbClient.query('SELECT filepath, filename FROM menus WHERE id = $1', [menuId]);
                        if (menuRes.rows.length === 0) throw new Error('Menu file record not found during finalize.');

                        const menuFilePath = menuRes.rows[0].filepath;
                        const originalFilenameBase = path.parse(menuRes.rows[0].filename).name;
                        let menuContent = '';
                        try {
                            const fileExt = path.extname(menuFilePath).toLowerCase();
                            if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.pdf'].includes(fileExt)) {
                                 menuContent = await performOcr(menuFilePath);
                            } else {
                                 const rawMenuContent = await fs.readFile(menuFilePath, 'utf-8');
                                 menuContent = sanitizeStringForDB(rawMenuContent);
                            }
                        } catch (readError) { console.error(`Finalize - Error getting menu content:`, readError); }

                        const historyRes = await dbClient.query('SELECT sender, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC', [conversationId]);
                        const geminiHistory = historyRes.rows.map(row => ({ role: row.sender === 'ai' ? 'model' : 'user', parts: [{ text: row.content }] }));
                        const finalPromptForGemini = sanitizeStringForDB(`${finalizationPromptText}\n\n原始菜單內容:\n${menuContent}`);
                        const structuredDataText = await callGemini(finalPromptForGemini, geminiHistory);

                        console.log("Raw structured data text from Gemini:", structuredDataText);
                        const excelBuffer = await generateExcelBuffer(structuredDataText);

                        if (excelBuffer) {
                            await client.files.uploadV2({
                                channel_id: channelId,
                                thread_ts: threadTs,
                                file: excelBuffer,
                                filename: `${originalFilenameBase}_優化建議.xlsx`,
                                initial_comment: `這是根據討論彙整的菜單優化建議 Excel 檔案。`,
                            });
                            console.log(`Uploaded Excel report to thread ${threadTs}`);
                        } else {
                             await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `產生 Excel 檔案時發生錯誤，請查看後端日誌。 Gemini 回傳的原始資料為：\n\`\`\`\n${structuredDataText}\n\`\`\`` });
                        }
                        return;
                    }

                    // --- Process as regular chat message ---
                    await dbClient.query('BEGIN');
                    const historyRes = await dbClient.query('SELECT sender, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC', [conversationId]);
                    const geminiHistory = historyRes.rows.map(row => ({ role: row.sender === 'ai' ? 'model' : 'user', parts: [{ text: row.content }] }));
                    await dbClient.query('INSERT INTO messages (conversation_id, sender, content) VALUES ($1, $2, $3)', [conversationId, 'user', userMessageText]);
                    const geminiResponseText = await callGemini(userMessageText, geminiHistory);
                    await dbClient.query('INSERT INTO messages (conversation_id, sender, content) VALUES ($1, $2, $3)', [conversationId, 'ai', geminiResponseText]);
                    await dbClient.query('COMMIT');

                    await client.chat.postMessage({
                        channel: channelId,
                        thread_ts: threadTs,
                        text: geminiResponseText
                    });
                    console.log(`Replied in thread ${threadTs}`);

                } else {
                     logger.warn(`Conversation ${conversationId} has unexpected status: ${status}`);
                     console.log(`Conversation ${conversationId} has unexpected status: ${status}`);
                }

            } else {
                logger.warn(`Received message in thread ${threadTs}, but no matching conversation found in DB.`);
                console.log(`Received message in thread ${threadTs}, but no matching conversation found in DB.`);
            }
        } catch (error) {
            logger.error(`Error processing threaded message in ${threadTs}:`, error);
            console.error(`Error processing threaded message in ${threadTs}:`, error);
            try { await dbClient.query('ROLLBACK'); } catch (rbError) { console.error('Rollback failed:', rbError); }
            try {
                 await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `處理你的訊息時發生錯誤: ${error.message}` });
            } catch (slackError) {
                 console.error("Failed to send error message to Slack thread:", slackError);
            }
        } finally {
            dbClient.release();
        }
    }
});


// --- Global Error Handling for Bolt ---
boltApp.error(async ({ error, logger }) => {
  logger.error("Slack Bolt Error:", error);
  console.error("Slack Bolt Error:", error);
});

// --- Start Server (Bolt App) ---
(async () => {
  try {
    await initializeDbSchema();
    const port = process.env.PORT || 3000;
    await boltApp.start(port);
    console.log(`⚡️ Slack Bolt app is running on port ${port} (using Socket Mode)!`);
  } catch (error) {
    console.error('Failed to start Slack Bolt app:', error);
    process.exit(1);
  }
})();


// --- DB Schema Initialization ---
async function initializeDbSchema() {
  const client = await pool.connect();
  try {
     await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        google_id VARCHAR(255) UNIQUE,
        email VARCHAR(255) UNIQUE NOT NULL,
        display_name VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
     `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS menus (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        filepath VARCHAR(1024) NOT NULL,
        uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        menu_id INTEGER REFERENCES menus(id) ON DELETE SET NULL,
        slack_channel_id VARCHAR(50),
        slack_thread_ts VARCHAR(50),
        status VARCHAR(50) DEFAULT 'active', -- Added status column
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // Add Slack columns and status column robustly
    await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS slack_channel_id VARCHAR(50);`);
    await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS slack_thread_ts VARCHAR(50);`);
    await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';`); // Add status if not exists

    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
        sender VARCHAR(10) NOT NULL CHECK (sender IN ('user', 'ai')),
        content TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_conversations_slack ON conversations (slack_channel_id, slack_thread_ts);`);

    console.log('Database schema initialized/updated successfully.');
  } catch (err) {
    console.error('Error initializing/updating database schema:', err);
  } finally {
    client.release();
  }
}


IMPORTANT: For any future changes to this file, use the final_file_content shown above as your reference. This content reflects the current state of the file, including any auto-formatting (e.g., if you used single quotes but the formatter converted them to double quotes). Always base your SEARCH/REPLACE operations on this final version to ensure accuracy.

<environment_details>
# VSCode Visible Files
menu-ai-backend/server.js

# VSCode Open Tabs
menu-ai-backend/server.js
menu-ai-backend/package.json
menu-ai-backend/.gitignore

# Current Time
4/10/2025, 1:52:38 AM (Asia/Taipei, UTC+8:00)
# Context Window Usage
560,000 / 1,048.576K tokens used (53%)

# Current Mode
ACT MODE
</environment_details>

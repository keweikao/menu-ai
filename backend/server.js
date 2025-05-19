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
// const puppeteer = require('puppeteer'); // Removed for PDF generation
const { marked } = require('marked'); // Keep for potential Markdown parsing help? Or remove if not used. Let's keep for now.
const docx = require('docx'); // Added for DOCX generation
const { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel, AlignmentType } = docx;

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
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-thinking-exp-01-21:generateContent?key=${process.env.GEMINI_API_KEY}`; // Updated model name

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

// --- DOCX Generation Helper ---
async function generateDocxReportBuffer(markdownContent, restaurantName, logger) {
    logger.info(`[generateDocxReportBuffer] Called to generate DOCX for ${restaurantName}`);
    try {
        const docChildren = [];

        // Attempt to add logo if available
        const logoPath = path.join(__dirname, 'assets', 'ichef_logo.png');
        try {
            const logoBuffer = await fs.readFile(logoPath);
            logger.info("Logo file read for DOCX.");
            docChildren.push(new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                    new ImageRun({
                        data: logoBuffer,
                        transformation: { width: 100, height: 50 },
                    }),
                ],
            }));
            docChildren.push(new Paragraph(" ")); // Space after logo
        } catch (imgErr) {
            logger.warn(`DOCX: Could not load or add logo: ${imgErr.message}`);
        }

        const lines = (markdownContent || "").split('\n');
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith('# ')) {
                docChildren.push(new Paragraph({ text: trimmedLine.substring(2).trim(), heading: HeadingLevel.HEADING_1 }));
            } else if (trimmedLine.startsWith('## ')) {
                docChildren.push(new Paragraph({ text: trimmedLine.substring(3).trim(), heading: HeadingLevel.HEADING_2 }));
            } else if (trimmedLine.startsWith('### ')) {
                docChildren.push(new Paragraph({ text: trimmedLine.substring(4).trim(), heading: HeadingLevel.HEADING_3 }));
            } else if (trimmedLine.startsWith('#### ')) {
                docChildren.push(new Paragraph({ text: trimmedLine.substring(5).trim(), heading: HeadingLevel.HEADING_4 }));
            } else if (trimmedLine === '---') {
                docChildren.push(new Paragraph({ text: '___________________________________', alignment: AlignmentType.CENTER })); // Visual separator
            } else if (trimmedLine.startsWith('* ')) {
                docChildren.push(new Paragraph({ text: trimmedLine.substring(2).trim(), bullet: { level: 0 } }));
            } else if (trimmedLine.match(/^\d+\.\s/)) {
                 docChildren.push(new Paragraph({ text: trimmedLine.replace(/^\d+\.\s/, '').trim(), numbering: { reference: "default-numbering", level: 0 } }));
            } else if (trimmedLine === '') {
                docChildren.push(new Paragraph(" ")); // Preserve empty lines as spacing
            }
            else {
                const parts = [];
                parts.push(new TextRun(line));
                docChildren.push(new Paragraph({ children: parts }));
            }
        }
        
        const doc = new Document({
            numbering: {
                config: [
                    {
                        reference: "default-numbering",
                        levels: [
                            {
                                level: 0,
                                format: "decimal",
                                text: "%1.",
                                alignment: AlignmentType.START,
                                style: { paragraph: { indent: { left: 720, hanging: 360 } } },
                            },
                        ],
                    },
                ],
            },
            sections: [{
                properties: {},
                children: docChildren,
            }],
        });

        logger.info("DOCX Document object created. Calling Packer.toBuffer...");
        const buffer = await Packer.toBuffer(doc);
        logger.info("DOCX buffer generated successfully.");
        return buffer;
    } catch (docxError) {
        logger.error("Error generating DOCX report with Packer.toBuffer:", docxError);
        return null;
    }
}

async function generateAndSendFinalReport(client, channelId, threadTs, conversationId, dbClient, logger) {
    logger.info(`[generateAndSendFinalReport] Called for conv ${conversationId} (Using external prompt template)`);
    try {
        logger.info(`Starting final report generation for conversation ${conversationId}`);
        const convDetailsRes = await dbClient.query(
            'SELECT menu_id, report_coach_name, report_end_date, report_restaurant_name, target_aov, target_audience FROM conversations WHERE id = $1',
            [conversationId]
        );

        if (convDetailsRes.rows.length === 0) {
            throw new Error("Conversation details not found for report generation.");
        }
        const details = convDetailsRes.rows[0];
        const { menu_id: menuId, report_coach_name: coachName, report_end_date: endDate, report_restaurant_name: restaurantName, target_aov: targetAOV, target_audience: targetAudience } = details;

        if (!menuId || !coachName || !endDate || !restaurantName) {
            throw new Error("Missing critical information for report generation (menuId, coachName, endDate, or restaurantName).");
        }
        
        const menuRes = await dbClient.query('SELECT filepath, filename FROM menus WHERE id = $1', [menuId]);
        if (menuRes.rows.length === 0) throw new Error('Menu file record not found for report.');
        const menuFilePath = menuRes.rows[0].filepath;
        const originalMenuFilename = menuRes.rows[0].filename;
        let menuContentForPrompt = '';
        try {
            const fileExt = path.extname(menuFilePath).toLowerCase();
            if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.pdf'].includes(fileExt)) {
                 menuContentForPrompt = await performOcr(menuFilePath);
            } else {
                 const rawMenuContent = await fs.readFile(menuFilePath, 'utf-8');
                 menuContentForPrompt = sanitizeStringForDB(rawMenuContent);
            }
        } catch (readError) { 
            logger.error(`Report Gen - Error getting menu content: ${readError.message}`);
            // menuContentForPrompt will remain '' which is handled later
        }

        const historyRes = await dbClient.query('SELECT sender, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC', [conversationId]);
        const historyRows = historyRes.rows;
        
        let finalOptimizedMenuMarkdown = '';
        let lastTongZhengIndex = -1;

        for (let i = historyRows.length - 1; i >= 0; i--) {
            if (historyRows[i].sender === 'user' && historyRows[i].content.toLowerCase().includes('統整建議')) {
                lastTongZhengIndex = i;
                break;
            }
        }

        if (lastTongZhengIndex !== -1 && lastTongZhengIndex + 1 < historyRows.length) {
            const aiResponseToTongZheng = historyRows[lastTongZhengIndex + 1];
            if (aiResponseToTongZheng.sender === 'ai') {
                finalOptimizedMenuMarkdown = aiResponseToTongZheng.content;
                logger.info(`[generateAndSendFinalReport] Found '統整建議' response for report section 2. Length: ${finalOptimizedMenuMarkdown.length}`);
            }
        }

        if (!finalOptimizedMenuMarkdown) {
            let lastAiMessageIndex = -1;
            for (let i = historyRows.length - 1; i >= 0; i--) {
                if (historyRows[i].sender === 'ai') {
                    lastAiMessageIndex = i;
                    break;
                }
            }
            if (lastAiMessageIndex !== -1) {
                 finalOptimizedMenuMarkdown = historyRows[lastAiMessageIndex].content;
                 logger.info(`[generateAndSendFinalReport] Using last AI message (index ${lastAiMessageIndex}) for section 2. Length: ${finalOptimizedMenuMarkdown.length}`);
            }
        }
        
        if (finalOptimizedMenuMarkdown) {
            let lines = finalOptimizedMenuMarkdown.split('\n');
            let newLines = [];
            let inTableToRemove = false;
            const tableTitleIndicator = "🎯 **核心邏輯與優化重點";
        
            for (const line of lines) {
                if (line.includes(tableTitleIndicator)) {
                    inTableToRemove = true; 
                    continue; 
                }
                if (inTableToRemove) {
                    if (line.trim().startsWith('|')) {
                        continue;
                    } else if (line.trim() === '---' && newLines.length > 0 && newLines[newLines.length-1].trim().startsWith('|')) {
                        continue;
                    }
                    else {
                        inTableToRemove = false; 
                    }
                }
                if (!inTableToRemove) {
                    newLines.push(line);
                }
            }
            finalOptimizedMenuMarkdown = newLines.join('\n').trim();
            finalOptimizedMenuMarkdown = finalOptimizedMenuMarkdown.replace(/📸/g, '(建議附照片)');
            logger.info(`[generateAndSendFinalReport] Processed finalOptimizedMenuMarkdown for DOCX: Removed optimization table and replaced photo icons.`);
        }

        let section2Content; 
        if (finalOptimizedMenuMarkdown && finalOptimizedMenuMarkdown.trim() !== '') {
            section2Content = finalOptimizedMenuMarkdown;
        } else {
            logger.warn(`[generateAndSendFinalReport] finalOptimizedMenuMarkdown is empty or not found. Using fallback for section2Content for ${restaurantName}.`);
            section2Content = `[AI請注意：此處應填入根據對話歷史記錄和原始菜單分析得出的最終優化菜單建議。內容應為完整的 Markdown 格式菜單結構，包含所有主打推薦、套餐、分類品項等。請確保這是使用者最終同意的版本。原始菜單檔名：${originalMenuFilename}，部分內容：${(menuContentForPrompt || '').substring(0, 500)}...]`;
        }

        let reportPromptTemplateString = '';
        try {
            reportPromptTemplateString = await fs.readFile(path.join(__dirname, 'report_prompt_template.txt'), 'utf-8');
        } catch (templateReadError) {
            logger.error(`[generateAndSendFinalReport] CRITICAL ERROR: Could not read report_prompt_template.txt: ${templateReadError.message}`);
            throw new Error(`無法讀取報告模板檔案 (${templateReadError.message})，請聯繫管理員。`);
        }

        let newFinalReportPrompt = reportPromptTemplateString;
        newFinalReportPrompt = newFinalReportPrompt.replace(/{{restaurantName}}/g, String(restaurantName || '[未提供餐廳名稱]'));
        newFinalReportPrompt = newFinalReportPrompt.replace(/{{coachName}}/g, String(coachName || '[未提供教練名稱]'));
        newFinalReportPrompt = newFinalReportPrompt.replace(/{{endDate}}/g, String(endDate || '[未提供結案日期]'));
        newFinalReportPrompt = newFinalReportPrompt.replace(/{{targetAOV}}/g, String(targetAOV || '[未提供目標客單價]'));
        newFinalReportPrompt = newFinalReportPrompt.replace(/{{targetAudience}}/g, String(targetAudience || '[未提供目標客群]'));
        newFinalReportPrompt = newFinalReportPrompt.replace(/{{originalMenuFilename}}/g, String(originalMenuFilename || '[未提供原始檔名]'));
        const menuContentForPromptSafe = String(menuContentForPrompt || '');
        newFinalReportPrompt = newFinalReportPrompt.replace(/{{menuContentForPromptShort}}/g, menuContentForPromptSafe.substring(0, 300) || '[無原始菜單摘要]');
        newFinalReportPrompt = newFinalReportPrompt.replace(/{{section2Content}}/g, String(section2Content || '[最終優化菜單內容未提供]'));
        
        logger.info(`Calling Gemini with new report generation prompt for conversation ${conversationId}. Prompt length: ${newFinalReportPrompt.length}`);
        const markdownReportContent = await callGemini(sanitizeStringForDB(newFinalReportPrompt), []); 
        
        const markdownMatch = markdownReportContent.match(/```markdown\s*([\s\S]*?)\s*```/);
        let finalMarkdown = markdownReportContent.trim(); 
        if (markdownMatch && markdownMatch[1]) { 
            finalMarkdown = markdownMatch[1].trim();
            logger.info("[generateAndSendFinalReport] Extracted content from ```markdown block.");
        } else {
             logger.warn("[generateAndSendFinalReport] Gemini response did not contain ```markdown blocks. Using the whole response for DOCX conversion.");
        }
        logger.info(`[generateAndSendFinalReport] Markdown for DOCX (length: ${finalMarkdown.length}) generated for conv ${conversationId}`);

        logger.info(`Generating DOCX for conversation ${conversationId}`);
        const docxBuffer = await generateDocxReportBuffer(finalMarkdown, restaurantName, logger);

        if (docxBuffer) {
            logger.info(`[generateAndSendFinalReport] DOCX buffer generated (size: ${docxBuffer?.byteLength}) for conv ${conversationId}. Proceeding to upload.`);
            await client.files.uploadV2({
                channel_id: channelId,
                thread_ts: threadTs,
                file: docxBuffer,
                filename: `${restaurantName}_結案報告.docx`,
                initial_comment: `這是為「${restaurantName}」產生的 Word 格式結案報告。`,
            });
            await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `已成功為「${restaurantName}」產生 Word 格式結案報告並上傳。` });
        } else {
            throw new Error("DOCX buffer generation failed.");
        }

    } catch (error) {
        logger.error(`Error in generateAndSendFinalReport for conv ${conversationId}:`, error);
        try {
            await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `產生結案報告時發生錯誤：${error.message}` });
        } catch (slackErr) {
            logger.error("Failed to send error message to Slack during report generation failure:", slackErr);
        }
    } finally {
        try {
            await dbClient.query('UPDATE conversations SET status = $1 WHERE id = $2', ['active', conversationId]);
            logger.info(`Reverted conversation ${conversationId} status to active after report attempt.`);
        } catch (dbUpdateError) {
            logger.error(`Failed to revert status for conversation ${conversationId}:`, dbUpdateError);
        }
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
      await say({ text: `收到菜單檔案 "${file.name}"！\n為了提供更精準的建議，請在這則訊息的討論串 (Thread) 中回覆以下**必填資訊**：\n\n1.  **餐廳類型與風格**：(例如：台式早午餐、健康餐盒、義式小館等)\n2.  **主要目標客群**：(例如：學生、上班族、家庭、健身人士等)\n3.  **希望主打品項 (3-5 項)**：[請列出您想策略性運用、來自不同價格帶的主打商品。這些是提升客單價的重要槓桿。]\n4.  **目標客單價**：[請提供您希望達到的平均顧客訂單金額。]\n\n⚠️ 請提供**所有四項資訊**後，我才會進行優化建議。`, thread_ts: threadTs });
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
                    const backgroundInfo = userMessageText; // Raw background info from user
                    if (!menuId) throw new Error('Menu ID missing for pending conversation.');

                    // Attempt to parse target_aov and target_audience from backgroundInfo
                    // This is a simple parsing attempt; more robust parsing might be needed.
                    let targetAOV = null;
                    let targetAudience = null;
                    const aovMatch = backgroundInfo.match(/目標客單價(?:：|:)\s*([^\n]+)/i);
                    if (aovMatch && aovMatch[1]) targetAOV = aovMatch[1].trim();
                    const audienceMatch = backgroundInfo.match(/主要目標客群(?:：|:)\s*([^\n]+)/i);
                    if (audienceMatch && audienceMatch[1]) targetAudience = audienceMatch[1].trim();

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

                    // Use the latest prompt provided by the user
                    const newPrompt = `
# 角色 (Persona)
你是一位頂尖的餐飲顧問，專長是分析實體菜單，並將其轉化為高效的線上/掃碼點餐菜單。你尤其擅長以達成客戶指定的「主打品項」與「待提升銷量品項」推廣目標為核心策略，來設計菜單結構、套餐組合與追加銷售機制，並在此基礎上追求平均客單價 (AOV) 與訂單轉換率的最大化。你的輸出風格精煉、結構化，直接呈現優化方案。

# 核心任務 (Core Task)
接收我提供的菜單檔案 (或其他形式的菜單內容) 以及關鍵營運目標 (指定的 5-8 項主打品項 與 5-8 項待提升銷量品項)，進行專業分析。你的首要任務是產出一份以達成這些指定品項銷售目標為最高優先級的優化線上菜單建議，並**嚴格按照下方指定的「輸出格式與結構」**呈現。

# 關鍵輸入資訊 (Critical Inputs)

菜單檔案/內容：[請在此處告知 AI 菜單檔案已提供或將提供]
餐廳背景資訊 (盡可能提供)：
${backgroundInfo}

# 輸出格式與結構要求 (Mandatory Output Format & Structure)

請務必、務必、務必遵循以下 Markdown 格式與內容要求，直接產出以推廣目標品項為核心設計的優化方案：

Markdown

太好了！我已經仔細研究過你提供的 [菜單來源] 以及您設定的關鍵營運目標：重點主打 [提及1-2個核心主打品項例子] 並提升 [提及1-2個待提升銷量品項例子] 的銷量。為了達成這個核心目標，並同時優化線上點餐體驗、提升客單價與轉換率，我建議將菜單**圍繞這些目標品項**進行以下重設：

✅ **優化後的線上菜單架構建議（以 Markdown 呈現）**

🍽 **主打推薦區（聚焦主打 | 📸建議搭配圖片）**
* [*希望主打品項1*] 📸 - $[建議價格]
    * 理由簡述：[**首要說明此設計如何最大化這個主打品項的吸引力、點擊率與價值感**，例如：放在首位、使用最佳圖片、強調獨特賣點等]
* [*希望主打品項2*] 📸 - $[建議價格]
    * 理由簡述：[同上，說明如何聚焦推廣此品項]
* [繼續列出 3-5 個主打推薦，**必須優先包含所有「希望主打品項」**，說明如何強化它們的曝光與吸引力]

📦 **超值套餐（策略組合 | 帶動銷量）**

🧑‍🍳 **[套餐名稱一]** $[價格範圍或固定價]
    * • [套餐內容描述，**思考如何將「主打」或「待提升銷量」品項巧妙組合進來，作為套餐亮點或核心**]
    * • [套餐內容描述]
    * • [套餐內容描述]
    * 🔹 [簡述此套餐的策略目的，**明確說明它如何有助於銷售「哪個目標品項」**，例如：透過與熱門商品搭配，帶動「XX待提升品項」銷量]

👩‍❤️‍👨 **[套餐名稱二]** $[價格範圍或固定價]
    * • [套餐內容描述，**同上，策略性地納入目標品項**]
    * • [套餐內容描述]
    * • [套餐內容描述]
    * 🔹 [簡述此套餐的策略目的，**明確說明它如何有助於銷售「哪個目標品項」**]

[根據目標品項的特性設計 2-3 種套餐，**核心目的在於提升目標品項的銷售機會**]

🍞 **主餐類（分類引導 | 🌟標註目標）**

**【[新分類名稱一]】**
    * • [品項名稱] [📸 若建議圖片] – $[價格] [**若為「主打」或「待提升銷量」品項，必須標註 🌟**]
    * • [品項名稱] [📸 若建議圖片] – $[價格] [**若為目標品項，標註 🌟**]
    * [列出該分類下的主要品項]

**【[新分類名稱二]】**
    * • [品項名稱] [📸 若建議圖片] – $[價格] [**若為目標品項，標註 🌟**]
    * • [品項名稱] [📸 若建議圖片] – $[價格] [**若為目標品項，標註 🌟**]
    * [列出該分類下的主要品項]

[繼續列出其他主餐分類，確保所有目標品項都被清晰標註]

🥟 **小點加購區（追加機會 | 🌟標註目標）**
* [品項名稱] - $[價格] [**若為目標品項，標註 🌟**]
* [品項名稱] - $[價格]
* [列出主要小點]
* 📌 **建議設計**：[**提出追加銷售建議，核心思考如何增加「待提升銷量」小點的購買機會**，例如：購買任一主餐即可以 $YY 加購「XX目標小點」]

🍹 **飲品專區（升級誘因 | 🌟標註目標）**
* [品項名稱] – $[價格] [**若為目標品項，標註 🌟**]
* [品項名稱] – $[價格]
* [列出主要飲品]
* 📌 **飲品區可設立「升級價差提示」**：[**提出飲品升級策略，思考如何引導顧客選擇「目標飲品」**，例如：✅ 套餐飲品 +$ZZ 即可升級「XX目標飲品」]

🧩 **加購選項建議（整合追加 | 提升目標品項）**
* [說明應用情境]
    * • [+XX] [加購項目]
    * • [+XX] [加購項目，**思考是否能將「待提升銷量」的品項設計成吸引人的加購選項**]
* [提出 1-2 種加購建議，**優先考慮如何透過加購帶動目標品項**]

🎯 **核心邏輯與優化重點（以目標品項銷售為導向）**
| 優化面向           | 策略邏輯 (如何達成目標品項銷售)                                    |
| ------------------ | ------------------------------------------------------------------ |
| **目標品項整合** | **說明如何在菜單各處 (推薦/套餐/分類/加購) 策略性地置入與凸顯目標品項** |
| 主打推薦聚焦       | 強調如何運用版位、視覺、描述最大化「主打品項」的吸引力與轉化        |
| 套餐策略組合       | 解釋套餐設計如何巧妙搭配，創造購買「目標品項」的理由或優惠感        |
| 追加銷售引導       | 說明如何利用加購、升級機制，增加「待提升銷量品項」的曝光與購買機會 |
| 分類與視覺標註 (🌟) | 強調清晰分類與特殊標註，如何幫助顧客快速找到並關注目標品項        |
---
以下是菜單內容：
${menuContent}
`;
                    const sanitizedPrompt = sanitizeStringForDB(newPrompt);

                    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "收到您的餐廳資訊，正在產生優化建議..." });
                    const geminiResponseText = await callGemini(sanitizedPrompt);

                    await dbClient.query('BEGIN');
                    await dbClient.query('INSERT INTO messages (conversation_id, sender, content) VALUES ($1, $2, $3)', [conversationId, 'user', backgroundInfo]); // Store raw background info
                    await dbClient.query('INSERT INTO messages (conversation_id, sender, content) VALUES ($1, $2, $3)', [conversationId, 'ai', geminiResponseText]);
                    await dbClient.query(
                        'UPDATE conversations SET status = $1, target_aov = $2, target_audience = $3 WHERE id = $4',
                        ['active', targetAOV, targetAudience, conversationId]
                    );
                    await dbClient.query('COMMIT');

                    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: geminiResponseText });
                    console.log(`Posted initial analysis after receiving info to thread ${threadTs}`);

                // --- State 2: Active Conversation, Summary Request, or Excel Request ---
                } else if (status === 'active' || status === null) {
                    // Check for "統整建議" command
                    if (userMessageText.toLowerCase().includes('統整建議')) {
                        logger.info(`Summary command detected for thread ${threadTs}`);
                        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "收到統整指令，正在整理最新建議..." });

                        // --- Start Summary Logic ---
                        const summaryPromptText = `
請根據以下所有對話紀錄與原始菜單內容，彙整一份最新版本的菜單優化建議報告。
請**嚴格依照**我們一開始討論的 Markdown 格式與結構要求輸出，包含所有區塊 (主打推薦、套餐、分類、小點、飲品、加購、策略總結等)。
請確保這是根據最新討論結果調整後的版本。**請勿在輸出中使用任何 emoji**。
`;
                        if (!menuId) throw new Error('Menu ID not found for this conversation.');
                        const menuRes = await dbClient.query('SELECT filepath FROM menus WHERE id = $1', [menuId]);
                        if (menuRes.rows.length === 0) throw new Error('Menu file record not found during summary.');

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
                        } catch (readError) { console.error(`Summary - Error getting menu content:`, readError); }

                        const historyRes = await dbClient.query('SELECT sender, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC', [conversationId]);
                        // Exclude the summary request itself from history sent to Gemini
                        const geminiHistory = historyRes.rows.filter(row => !(row.sender === 'user' && row.content.toLowerCase().includes('統整建議')))
                                                    .map(row => ({ role: row.sender === 'ai' ? 'model' : 'user', parts: [{ text: row.content }] }));

                        const finalPromptForGemini = sanitizeStringForDB(`${summaryPromptText}\n\n原始菜單內容:\n${menuContent}`);
                        const summaryResponseText = await callGemini(finalPromptForGemini, geminiHistory);

                        // Post the summary back to the thread
                        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: summaryResponseText });
                        console.log(`Posted summary report to thread ${threadTs}`);
                        // --- End Summary Logic ---
                        return; // Stop processing after handling summary command
                    }
                    // Check for "提供 excel" command (or csv for backward compatibility)
                    else if (userMessageText.toLowerCase().includes('提供 csv') || userMessageText.toLowerCase().includes('提供 excel')) {
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
                    // Check for "產出結案報告" (Generate Closing Report) command
                    else if (userMessageText.toLowerCase().includes('產出結案報告')) {
                        logger.info(`Closing report command detected for thread ${threadTs}`);
                        if (!menuId) {
                            await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "錯誤：找不到相關的菜單資訊，無法產生結案報告。" });
                            return;
                        }
                        // Always ask for coach name first, restaurant name will be asked later.
                        await dbClient.query(
                            'UPDATE conversations SET status = $1 WHERE id = $2',
                            ['pending_report_coach_name', conversationId]
                        );
                        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "好的，我們來準備結案報告。\n請問您的全名是？" });
                        return;
                    }

                    // --- Process as regular chat message ---
                    console.log(`Looking up history for conversationId: ${conversationId}`); // Log conversation ID
                    const historyRes = await dbClient.query('SELECT sender, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC', [conversationId]);
                    const geminiHistory = historyRes.rows.map(row => ({ role: row.sender === 'ai' ? 'model' : 'user', parts: [{ text: row.content }] }));
                    console.log(`Retrieved history length: ${geminiHistory.length}`); // Log history length
                    // console.log("Gemini History being sent:", JSON.stringify(geminiHistory)); // Optional: Log full history if needed (can be long)
                    await dbClient.query('BEGIN');
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

                } else if (status === 'pending_report_coach_name') {
                    logger.info(`Received coach name for report: ${userMessageText}`);
                    await dbClient.query(
                        'UPDATE conversations SET status = $1, report_coach_name = $2 WHERE id = $3',
                        ['pending_report_end_date', userMessageText, conversationId]
                    );
                    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "感謝您！\n請問本次專案的結案日期（格式：YYYY/MM/DD）是？" });
                
                } else if (status === 'pending_report_end_date') {
                    logger.info(`Received end date for report: ${userMessageText}`);
                    // Basic validation for YYYY/MM/DD, can be improved
                    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(userMessageText)) {
                        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "日期格式不正確，請使用 YYYY/MM/DD 格式，例如：2024/01/15。" });
                        return;
                    }
                    await dbClient.query(
                        'UPDATE conversations SET report_end_date = $1 WHERE id = $2',
                        [userMessageText, conversationId]
                    );
                    // After getting end date, always ask for restaurant name
                    await dbClient.query(
                        'UPDATE conversations SET status = $1 WHERE id = $2',
                        ['pending_report_restaurant_name', conversationId]
                    );
                    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "感謝您！\n請問這次結案報告是關於哪間餐廳的？" });
                    return; // Return after asking
                
                } else if (status === 'pending_report_restaurant_name') {
                    logger.info(`Received restaurant name for report: ${userMessageText}`);
                    await dbClient.query(
                        'UPDATE conversations SET status = $1, report_restaurant_name = $2 WHERE id = $3',
                        ['generating_report', userMessageText, conversationId]
                    );
                    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `感謝您提供所有資訊！正在為「${userMessageText}」產生結案報告...` });

                    // Trigger actual report generation (async)
                    logger.info(`[DEBUG] About to call generateAndSendFinalReport for conv ${conversationId} (after getting all report info)`);
                    try {
                        const reportPromise = generateAndSendFinalReport(client, channelId, threadTs, conversationId, dbClient, logger);
                        logger.info(`[DEBUG] Called generateAndSendFinalReport for conv ${conversationId} (no await, after getting all report info)`);
                        reportPromise.catch(promiseError => {
                            logger.error(`[DEBUG] ASYNC ERROR/UNHANDLED REJECTION from generateAndSendFinalReport for conv ${conversationId} (after getting all report info):`, promiseError);
                            client.chat.postMessage({
                                channel: channelId,
                                thread_ts: threadTs,
                                text: `[DEBUG] 報告產生函式非同步執行時發生嚴重錯誤: ${promiseError.message}`
                            }).catch(slackErr => logger.error("[DEBUG] Failed to send async error to slack during reportPromise.catch (after getting all report info)", slackErr));
                        });
                    } catch (syncCallError) {
                        logger.error(`[DEBUG] SYNC ERROR calling generateAndSendFinalReport for conv ${conversationId} (after getting all report info):`, syncCallError);
                        await client.chat.postMessage({
                            channel: channelId,
                            thread_ts: threadTs,
                            text: `[DEBUG] 呼叫報告產生函式時發生同步錯誤: ${syncCallError.message}`
                        });
                        await dbClient.query('UPDATE conversations SET status = $1 WHERE id = $2', ['active', conversationId]);
                    }
                    return; // Return after triggering report generation

                } else if (status === 'generating_report') {
                    logger.info(`Received message while report is generating for conversation ${conversationId}. Informing user to wait.`);
                    await client.chat.postMessage({
                        channel: channelId,
                        thread_ts: threadTs,
                        text: "目前正在為您產生結案報告中，請稍候片刻。完成後會通知您。"
                    });
                
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
        report_coach_name TEXT,
        report_end_date VARCHAR(10),
        report_restaurant_name TEXT,
        target_aov VARCHAR(255),
        target_audience TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // Add Slack columns and status column robustly
    await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS slack_channel_id VARCHAR(50);`);
    await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS slack_thread_ts VARCHAR(50);`);
    await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';`); // Add status if not exists
    await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS report_coach_name TEXT;`);
    await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS report_end_date VARCHAR(10);`);
    await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS report_restaurant_name TEXT;`);
    await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS target_aov VARCHAR(255);`);
    await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS target_audience TEXT;`);

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

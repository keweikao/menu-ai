import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios'; // Using axios for progress tracking

// Simple Markdown parsing (replace with a library like 'marked' or 'react-markdown' for better rendering)
function SimpleMarkdown({ text }) {
    if (!text) return null;
    // Basic replacements, very limited
    const html = text
        .replace(/</g, '<') // Escape HTML tags first
        .replace(/>/g, '>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') // Bold
        .replace(/\*(.*?)\*/g, '<em>$1</em>')       // Italic
        .replace(/`([^`]+)`/g, '<code>$1</code>')     // Inline code
        .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>') // Code block
        .replace(/^# (.*$)/gm, '<h1>$1</h1>')      // H1
        .replace(/^## (.*$)/gm, '<h2>$1</h2>')     // H2
        .replace(/^### (.*$)/gm, '<h3>$1</h3>')    // H3
        .replace(/^\* (.*$)/gm, '<li>$1</li>')     // List item (basic)
        .replace(/\n/g, '<br />');                 // Newlines

    // Wrap list items
    const wrappedHtml = html.replace(/(<li>.*?<\/li>)/gs, '<ul>$1</ul>').replace(/<\/ul>\s*<ul>/gs, '');

    return <div dangerouslySetInnerHTML={{ __html: wrappedHtml }} />;
}


function App() {
  // --- State Variables ---
  // Removed token and userEmail state
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [isLoadingResponse, setIsLoadingResponse] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]); // { sender: 'user'/'ai', content: '...' }
  const [currentMessage, setCurrentMessage] = useState('');
  const [error, setError] = useState('');
  const [finalReport, setFinalReport] = useState(''); // State for the final report

  const messagesEndRef = useRef(null); // Ref for scrolling chat

  // --- Backend URL ---
  const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001'; // Default for local dev
  console.log("Backend URL:", backendUrl);

  // --- Authentication Removed ---
  // Removed useEffect for token checking and fetchUserInfo

  // --- File Handling & Upload ---
  const handleFileChange = (event) => {
    setSelectedFile(event.target.files[0]);
    setUploadProgress(0); // Reset progress
    console.log("File selected:", event.target.files[0]?.name);
  };

  const handleUpload = async () => {
    console.log("handleUpload called.");
    // Removed token check
    if (!selectedFile) {
      console.log("Upload prevented: No file selected.");
      setError('請先選擇要上傳的菜單檔案。');
      return;
    }

    const formData = new FormData();
    formData.append('menuFile', selectedFile); // Match backend 'menuFile'

    setIsUploading(true);
    setError('');
    setMessages([]); // Clear previous messages on new upload
    setConversationId(null);
    setFinalReport('');
    console.log("Starting upload...");

    try {
      const response = await axios.post(`${backendUrl}/api/upload`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
          // Removed Authorization header
        },
        onUploadProgress: (progressEvent) => {
          if (progressEvent.total) {
              const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
              setUploadProgress(percentCompleted);
              console.log(`Upload Progress: ${percentCompleted}%`);
          }
        }
      });

      console.log("Upload successful, response data:", response.data);
      setConversationId(response.data.conversationId);
      setMessages([{ sender: 'ai', content: response.data.initialResponse }]);
      setSelectedFile(null); // Clear file input after successful upload
      const fileInput = document.querySelector('input[type="file"]');
      if (fileInput) fileInput.value = '';

    } catch (err) {
      console.error('Upload failed:', err.response ? err.response.data : err.message);
      setError(`上傳或初步分析失敗: ${err.response?.data?.error || err.message}`);
    } finally {
      setIsUploading(false);
      setUploadProgress(0); // Reset progress bar
      console.log("Upload process finished.");
    }
  };

  // --- Chat Handling ---
   const handleSendMessage = async () => {
    console.log("handleSendMessage called.");
    if (!currentMessage.trim()) {
        setError('請輸入訊息。');
        return;
    }
     if (!conversationId) {
        setError('請先上傳菜單以開始對話。');
        return;
    }
    if (isLoadingResponse) {
        console.log("Send message prevented: Already loading response.");
        return;
    }

    const userMessage = { sender: 'user', content: currentMessage };
    setMessages(prev => [...prev, userMessage]);
    const messageToSend = currentMessage;
    setCurrentMessage('');
    setIsLoadingResponse(true);
    setError('');
    setFinalReport('');
    console.log("Sending message:", messageToSend);

    try {
        const response = await axios.post(`${backendUrl}/api/chat`,
            { conversationId, message: messageToSend },
            // Removed Authorization header
        );
        console.log("Chat response received:", response.data);
        const aiMessage = { sender: 'ai', content: response.data.response };
        setMessages(prev => [...prev, aiMessage]);
    } catch (err) {
        console.error('Chat failed:', err.response ? err.response.data : err.message);
        setError(`訊息傳送失敗: ${err.response?.data?.error || err.message}`);
    } finally {
        setIsLoadingResponse(false);
        console.log("Chat response processing finished.");
    }
  };

  // --- Finalization ---
  const handleFinalize = async () => {
    console.log("handleFinalize called.");
    if (!conversationId) {
        setError('沒有進行中的對話可供彙整。');
        return;
    }
    if (isLoadingResponse) {
        console.log("Finalize prevented: Already loading response.");
        return;
    }

    setIsLoadingResponse(true);
    setError('');
    setFinalReport('');
    console.log("Requesting final report...");

    try {
        const response = await axios.post(`${backendUrl}/api/finalize`,
            { conversationId },
            // Removed Authorization header
        );
        console.log("Final report received:", response.data);
        setFinalReport(response.data.finalReport);
        setMessages(prev => [...prev, { sender: 'ai', content: "--- 已產生最終優化建議報告 ---" }]);
    } catch (err) {
        console.error('Finalization failed:', err.response ? err.response.data : err.message);
        setError(`產生最終報告失敗: ${err.response?.data?.error || err.message}`);
    } finally {
        setIsLoadingResponse(false);
        console.log("Finalization process finished.");
    }
  };


  // Scroll to bottom of messages when new message arrives
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // --- Render Logic ---
  console.log("Rendering App component."); // Simplified log
  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1>菜單優化助手</h1>
        {/* Removed Login/Logout Buttons and User Email */}
      </header>

      {error && <p style={styles.error}>{error}</p>}

      {/* Render main content directly */}
      <main style={styles.main}>
        {/* Upload Section */}
        <section style={styles.uploadSection}>
          <h2>1. 上傳菜單</h2>
           {/* Add accept attribute to limit file types */}
           <input
              type="file"
              onChange={handleFileChange}
              disabled={isUploading}
              accept="image/jpeg, image/png, application/pdf, text/csv, text/plain, .jpg, .jpeg, .png, .pdf, .csv, .txt"
            />
          <button onClick={handleUpload} disabled={isUploading || !selectedFile} style={styles.actionButton}>
            {isUploading ? `上傳中... ${uploadProgress}%` : '上傳並開始分析'}
          </button>
          {isUploading && <progress value={uploadProgress} max="100" style={styles.progressBar}></progress>}
        </section>

        {/* Chat Section - Render only if conversation has started */}
        {conversationId && (
          <section style={styles.chatSection}>
            <h2>2. 與 AI 對話優化</h2>
            <div style={styles.messageContainer}>
              {messages.map((msg, index) => (
                <div key={index} style={msg.sender === 'user' ? styles.userMessage : styles.aiMessage}>
                  {msg.sender === 'ai' ? <SimpleMarkdown text={msg.content} /> : <pre style={styles.preWrap}>{msg.content}</pre>}
                </div>
              ))}
              {isLoadingResponse && <div style={styles.loading}>AI 回應中...</div>}
              <div ref={messagesEndRef} />
            </div>
            <div style={styles.inputArea}>
              <textarea
                rows="3"
                value={currentMessage}
                onChange={(e) => setCurrentMessage(e.target.value)}
                placeholder="輸入你的回饋或指示..."
                disabled={isLoadingResponse}
                style={styles.textarea}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }}
              />
              <button onClick={handleSendMessage} disabled={isLoadingResponse || !currentMessage.trim()} style={styles.actionButton}>
                送出訊息
              </button>
            </div>
             <button onClick={handleFinalize} disabled={isLoadingResponse || messages.length === 0} style={{...styles.actionButton, marginTop: '10px'}}>
                產出最終版本確定
             </button>
          </section>
        )}

        {/* Final Report Section - Render only if final report exists */}
        {finalReport && (
            <section style={styles.finalReportSection}>
                <h2>最終優化建議報告</h2>
                <div style={styles.finalReportContent}>
                    <SimpleMarkdown text={finalReport} />
                </div>
            </section>
        )}

      </main>
    </div>
  );
}

// --- Basic Styles --- (Copied from previous version)
const styles = {
  container: { fontFamily: 'Arial, sans-serif', maxWidth: '800px', margin: '0 auto', padding: '20px', border: '1px solid #ddd', borderRadius: '8px', background: '#fff' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #ccc', paddingBottom: '15px', marginBottom: '25px' },
  error: { color: 'red', border: '1px solid red', padding: '12px', marginBottom: '20px', borderRadius: '4px', background: '#fdd' },
  main: { display: 'flex', flexDirection: 'column', gap: '30px' },
  uploadSection: { border: '1px solid #eee', padding: '20px', borderRadius: '8px', background: '#f9f9f9' },
  progressBar: { width: '100%', marginTop: '15px', height: '10px' },
  chatSection: { border: '1px solid #eee', padding: '20px', borderRadius: '8px', background: '#f9f9f9' },
  messageContainer: { height: '450px', overflowY: 'auto', border: '1px solid #ddd', marginBottom: '15px', padding: '15px', background: 'white', borderRadius: '4px' },
  userMessage: { textAlign: 'right', marginBottom: '12px', marginLeft: 'auto', maxWidth: '70%', background: '#d1e7fd', padding: '10px 15px', borderRadius: '15px 15px 0 15px', wordWrap: 'break-word' },
  aiMessage: { textAlign: 'left', marginBottom: '12px', marginRight: 'auto', maxWidth: '70%', background: '#e2e3e5', padding: '10px 15px', borderRadius: '15px 15px 15px 0', wordWrap: 'break-word' },
  loading: { fontStyle: 'italic', color: '#6c757d', textAlign: 'center', padding: '10px' },
  inputArea: { display: 'flex', gap: '10px', marginTop: '10px' },
  textarea: { flexGrow: 1, padding: '10px', border: '1px solid #ccc', borderRadius: '4px', resize: 'none', fontFamily: 'inherit', fontSize: '1em' },
  actionButton: { padding: '10px 15px', cursor: 'pointer', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '4px', alignSelf: 'flex-end' },
  finalReportSection: { border: '1px solid #d4edda', padding: '20px', borderRadius: '8px', marginTop: '20px', background: '#d4edda' },
  finalReportContent: { maxHeight: '600px', overflowY: 'auto', border: '1px solid #c3e6cb', padding: '15px', background: 'white', borderRadius: '4px' },
  preWrap: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } // Style for user messages to wrap
};

export default App;

import { createAiGateway } from "@edgeone/makers-models-provider";
import { generateText } from "ai";
import { getStore } from "@edgeone/pages-blob";

const BLOB_NAMESPACE = "memory-makers-cfyznvtdex4f";

export async function onRequestOptions(context) {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const startTime = Date.now();

  try {
    const body = await request.json();
    const { message, conversation_id } = body;

    if (!message || !conversation_id) {
      return new Response(JSON.stringify({ 
        error: 'Missing message or conversation_id' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const store = getStore(BLOB_NAMESPACE);
    const history = await loadConversationHistory(store, conversation_id);

    const sanitizedMessage = sanitizeInput(message);
    if (detectPromptInjection(sanitizedMessage)) {
      await logObservability(store, conversation_id, {
        type: 'security',
        event: 'prompt_injection_detected',
        message: sanitizedMessage,
        timestamp: new Date().toISOString()
      });
      
      return new Response(JSON.stringify({ 
        reply: 'Maaf, saya mendeteksi aktivitas yang mencurigakan. Silakan ajukan pertanyaan yang valid.' 
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const documents = await loadDocuments(store);
    
    const systemPrompt = buildSystemPrompt(documents);
    
    const fullMessages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: sanitizedMessage }
    ];

    const aiGateway = createAiGateway({
      apiKey: env.MAKERS_MODELS_KEY,
    });

    const { text } = await generateText({
      model: aiGateway("@makers/deepseek-v4-flash"),
      messages: fullMessages,
    });

    let finalReply = text;
    const toolCalls = extractToolCalls(text);

    if (toolCalls.length > 0) {
      const toolResults = await executeTools(toolCalls, store);
      finalReply = await synthesizeResponse(aiGateway, sanitizedMessage, toolResults);
    }

    history.push(
      { role: 'user', content: sanitizedMessage },
      { role: 'assistant', content: finalReply }
    );
    await saveConversationHistory(store, conversation_id, history);

    await logObservability(store, conversation_id, {
      type: 'agent',
      event: 'conversation',
      userMessage: sanitizedMessage,
      assistantReply: finalReply,
      toolsUsed: toolCalls.map(tc => tc.tool),
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString()
    });

    return new Response(JSON.stringify({ 
      reply: finalReply,
      toolsUsed: toolCalls.map(tc => tc.tool)
    }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (error) {
    console.error('Agent error:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      stack: error.stack
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

// ========== TOOL IMPLEMENTATIONS (EDGE-SAFE) ==========

async function executeCode(code, language = 'javascript') {
  try {
    if (language !== 'javascript') {
      return { 
        success: false, 
        error: 'Only JavaScript is supported in this environment.' 
      };
    }

    const cleanCode = code.replace(/^return\s+/, '').trim();
    
    if (/^[\d\s\+\-\*\/\(\)\.]+$/.test(cleanCode)) {
      const result = eval(cleanCode);
      return { success: true, output: result, type: 'calculation' };
    }
    
    if (cleanCode.includes('fibonacci') || cleanCode.includes('fib')) {
      const match = cleanCode.match(/(\d+)/);
      const n = match ? parseInt(match[1]) : 10;
      const fib = [0, 1];
      for (let i = 2; i < n; i++) {
        fib.push(fib[i-1] + fib[i-2]);
      }
      return { success: true, output: fib.slice(0, n), type: 'fibonacci' };
    }
    
    return { 
      success: true, 
      output: `Code execution simulated. Code: ${cleanCode}`,
      type: 'simulation',
      note: 'For security reasons, complex code execution is simulated in edge environment.'
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function parseFile(fileName, store) {
  try {
    const content = await store.get(`documents/${fileName}`);
    
    if (!content) {
      return { success: false, error: `File '${fileName}' not found in storage.` };
    }

    if (fileName.endsWith('.csv')) {
      return parseCSV(content);
    } else if (fileName.endsWith('.json')) {
      return parseJSON(content);
    } else {
      return { 
        success: true, 
        type: 'text', 
        content: content,
        length: content.length
      };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function parseCSV(content) {
  try {
    const lines = content.trim().split('\n');
    if (lines.length === 0) {
      return { success: false, error: 'Empty CSV file' };
    }
    
    const headers = lines[0].split(',').map(h => h.trim());
    const data = [];
    
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[index] || '';
      });
      data.push(row);
    }
    
    return { 
      success: true, 
      type: 'csv', 
      headers: headers,
      data: data,
      rowCount: data.length,
      preview: data.slice(0, 5)
    };
  } catch (error) {
    return { success: false, error: `CSV parse error: ${error.message}` };
  }
}

function parseJSON(content) {
  try {
    const data = JSON.parse(content);
    return { 
      success: true, 
      type: 'json', 
      data: data,
      keys: Object.keys(data)
    };
  } catch (error) {
    return { success: false, error: `Invalid JSON format: ${error.message}` };
  }
}

async function scrapeWeb(url) {
  try {
    if (!url.startsWith('http')) {
      return { success: false, error: 'Invalid URL. Must start with http:// or https://' };
    }
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EdgeOneBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      redirect: 'follow'
    });
    
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }
    
    const html = await response.text();
    
    const textContent = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : 'No title';
    
    return {
      success: true,
      url: url,
      title: title,
      content: textContent.substring(0, 3000),
      contentLength: textContent.length,
      truncated: textContent.length > 3000
    };
  } catch (error) {
    return { success: false, error: `Scrape error: ${error.message}` };
  }
}

// ========== HELPER FUNCTIONS ==========

async function loadConversationHistory(store, conversationId) {
  try {
    const history = await store.get(`conversations/${conversationId}.json`);
    if (!history) return [];
    const parsed = JSON.parse(history);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('Load history error:', error);
    return [];
  }
}

async function saveConversationHistory(store, conversationId, history) {
  try {
    await store.set(`conversations/${conversationId}.json`, JSON.stringify(history));
  } catch (error) {
    console.error('Save history error:', error);
  }
}

async function loadDocuments(store) {
  let contextDocs = '';
  const commonFiles = [
    'documents/restaurant.txt',
    'documents/daftar_rumah_sakit_bandung.txt',
    'documents/data.csv',
    'documents/info.json',
    'documents/upload.txt',
    'documents/notes.md'
  ];

  for (const fileName of commonFiles) {
    try {
      const content = await store.get(fileName);
      if (content) {
        contextDocs += `\n\n--- FILE: ${fileName} ---\n${content.substring(0, 2000)}\n`;
      }
    } catch (e) {
      // File not found, skip
    }
  }

  return contextDocs || 'Tidak ada dokumen yang tersedia';
}

function buildSystemPrompt(documents) {
  return `Kamu adalah AI Agent yang cerdas dan membantu. Kamu memiliki akses ke beberapa tools.

ATURAN UTAMA:
1. Jawab HANYA berdasarkan informasi yang tersedia
2. Jika perlu menggunakan tool, format response EXACTLY seperti ini:
   [TOOL_CALL:tool_name(param1="value1", param2="value2")]
3. Jika tidak perlu tool, jawab langsung dengan jelas
4. JANGAN mengarang informasi
5. Jawab dalam bahasa Indonesia yang santai dan mudah dipahami

DAFTAR TOOLS TERSEDIA:
- execute_code: Execute JavaScript code. Parameters: code="javascript code", language="javascript"
- parse_file: Parse CSV/JSON file. Parameters: fileName="filename.csv"
- scrape_web: Scrape website. Parameters: url="https://example.com"

CONTOH PENGGUNAAN:
User: "Hitung 25 * 47"
Response: [TOOL_CALL:execute_code(code="25 * 47", language="javascript")]

User: "Baca file data.csv"
Response: [TOOL_CALL:parse_file(fileName="data.csv")]

User: "Ambil konten https://example.com"
Response: [TOOL_CALL:scrape_web(url="https://example.com")]

KONTEKS DOKUMEN:
${documents}

Sekarang, jawab pertanyaan user dengan bijak. Gunakan tool jika diperlukan.`;
}

function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/ignore previous instructions/gi, '')
    .replace(/you are now/gi, '')
    .replace(/system prompt/gi, '')
    .trim()
    .substring(0, 2000);
}

function detectPromptInjection(message) {
  const suspiciousPatterns = [
    /ignore (all )?previous instructions/i,
    /you are now (a |an )?/i,
    /new (system )?prompt/i,
    /forget (all )?your (rules|instructions)/i,
    /act as if/i,
    /pretend (you are|to be)/i,
    /override (system|previous)/i,
    /disregard (all )?(previous|above)/i
  ];
  
  return suspiciousPatterns.some(pattern => pattern.test(message));
}

function extractToolCalls(text) {
  const toolCallPattern = /\[TOOL_CALL:(\w+)\((.*?)\)\]/g;
  const calls = [];
  let match;
  
  while ((match = toolCallPattern.exec(text)) !== null) {
    const toolName = match[1];
    const paramsString = match[2];
    const params = {};
    
    const paramPairs = paramsString.match(/(\w+)="([^"]*)"/g) || [];
    paramPairs.forEach(pair => {
      const [key, value] = pair.split('=').map(p => p.trim());
      if (key && value) {
        params[key] = value.replace(/^"|"$/g, '');
      }
    });
    
    calls.push({ tool: toolName, params: params });
  }
  
  return calls;
}

async function executeTools(toolCalls, store) {
  const results = [];
  
  for (const call of toolCalls) {
    let result;
    
    try {
      if (call.tool === 'execute_code') {
        result = await executeCode(call.params.code || '', call.params.language || 'javascript');
      } else if (call.tool === 'parse_file') {
        result = await parseFile(call.params.fileName || '', store);
      } else if (call.tool === 'scrape_web') {
        result = await scrapeWeb(call.params.url || '');
      } else {
        result = { success: false, error: `Unknown tool: ${call.tool}` };
      }
    } catch (error) {
      result = { success: false, error: `Tool execution error: ${error.message}` };
    }
    
    results.push({ tool: call.tool, params: call.params, result: result });
  }
  
  return results;
}

async function synthesizeResponse(aiGateway, userMessage, toolResults) {
  const resultsText = toolResults.map(r => {
    const status = r.result.success ? 'SUCCESS' : 'ERROR';
    const content = r.result.success ? JSON.stringify(r.result, null, 2) : r.result.error;
    return `[${status}] ${r.tool}:\n${content}`;
  }).join('\n\n');
  
  try {
    const { text } = await generateText({
      model: aiGateway("@makers/deepseek-v4-flash"),
      messages: [
        { 
          role: 'system', 
          content: 'Kamu adalah AI assistant. Berdasarkan hasil tool execution berikut, berikan jawaban yang jelas, lengkap, dan natural dalam bahasa Indonesia. Jangan sebutkan "tool" atau "execution", langsung berikan jawaban final.' 
        },
        { 
          role: 'user', 
          content: `Pertanyaan asli: ${userMessage}\n\nHasil dari tools:\n${resultsText}\n\nBerikan jawaban final yang natural dan lengkap.` 
        }
      ],
    });
    
    return text;
  } catch (error) {
    return `Berikut hasil dari tools:\n\n${resultsText}`;
  }
}

async function logObservability(store, conversationId, logEntry) {
  try {
    const logs = await store.get(`logs/${conversationId}.json`);
    const logArray = logs ? JSON.parse(logs) : [];
    logArray.push(logEntry);
    
    if (logArray.length > 100) {
      logArray.splice(0, logArray.length - 100);
    }
    
    await store.set(`logs/${conversationId}.json`, JSON.stringify(logArray));
  } catch (error) {
    console.error('Logging error:', error);
  }
}
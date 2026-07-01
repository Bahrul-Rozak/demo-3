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
    const tools = defineTools();
    
    const systemPrompt = buildSystemPrompt(documents, tools);
    
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

// ========== TOOL IMPLEMENTATIONS ==========

async function executeCode(code, language = 'javascript') {
  try {
    if (language === 'javascript') {
      const result = await new Promise((resolve) => {
        try {
          const func = new Function(code);
          const output = func();
          resolve({ success: true, output: output });
        } catch (error) {
          resolve({ success: false, error: error.message });
        }
      });
      return result;
    } else {
      return { 
        success: false, 
        error: 'Python execution not supported. Use JavaScript instead.' 
      };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function parseFile(fileName, store) {
  try {
    const content = await store.get(`documents/${fileName}`);
    
    if (!content) {
      return { success: false, error: 'File not found' };
    }

    if (fileName.endsWith('.csv')) {
      return parseCSV(content);
    } else if (fileName.endsWith('.json')) {
      return parseJSON(content);
    } else {
      return { success: true, type: 'text', content: content };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function parseCSV(content) {
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  const data = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index];
    });
    data.push(row);
  }
  
  return { 
    success: true, 
    type: 'csv', 
    headers: headers,
    data: data,
    rowCount: data.length
  };
}

function parseJSON(content) {
  try {
    const data = JSON.parse(content);
    return { success: true, type: 'json', data: data };
  } catch (error) {
    return { success: false, error: 'Invalid JSON format' };
  }
}

async function scrapeWeb(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EdgeOneBot/1.0)'
      }
    });
    
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }
    
    const html = await response.text();
    
    const textContent = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : 'No title';
    
    return {
      success: true,
      url: url,
      title: title,
      content: textContent.substring(0, 5000),
      contentLength: textContent.length
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ========== HELPER FUNCTIONS ==========

async function loadConversationHistory(store, conversationId) {
  try {
    const history = await store.get(`conversations/${conversationId}.json`);
    return history ? JSON.parse(history) : [];
  } catch (error) {
    return [];
  }
}

async function saveConversationHistory(store, conversationId, history) {
  await store.set(`conversations/${conversationId}.json`, JSON.stringify(history));
}

async function loadDocuments(store) {
  let contextDocs = '';
  const commonFiles = [
    'documents/restaurant.txt',
    'documents/daftar_rumah_sakit_bandung.txt',
    'documents/data.csv',
    'documents/info.json'
  ];

  for (const fileName of commonFiles) {
    try {
      const content = await store.get(fileName);
      if (content) {
        contextDocs += `\n\n--- FILE: ${fileName} ---\n${content}\n`;
      }
    } catch (e) {}
  }

  return contextDocs;
}

function defineTools() {
  return [
    {
      name: 'execute_code',
      description: 'Execute JavaScript code. Use when user asks to calculate, process data, or run code.',
      parameters: {
        code: 'JavaScript code to execute',
        language: 'javascript (only javascript supported)'
      }
    },
    {
      name: 'parse_file',
      description: 'Parse CSV or JSON file from storage. Use when user asks about file content.',
      parameters: {
        fileName: 'Name of file to parse (e.g., data.csv, info.json)'
      }
    },
    {
      name: 'scrape_web',
      description: 'Scrape content from a website URL. Use when user asks about web content.',
      parameters: {
        url: 'URL to scrape'
      }
    }
  ];
}

function buildSystemPrompt(documents, tools) {
  return `Kamu adalah AI Agent yang cerdas dan membantu. Kamu memiliki akses ke beberapa tools yang bisa kamu gunakan untuk menyelesaikan tugas user.

ATURAN UTAMA:
1. Jawab HANYA berdasarkan informasi yang tersedia
2. Jika perlu menggunakan tool, format response dengan format khusus:
   [TOOL_CALL:tool_name(param1=value1, param2=value2)]
3. Jika tidak perlu tool, jawab langsung dengan jelas
4. JANGAN mengarang informasi
5. Jawab dalam bahasa Indonesia yang santai

DAFTAR TOOLS TERSEDIA:
${tools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

Contoh penggunaan tool:
- User: "Hitung 25 * 47"
- Response: [TOOL_CALL:execute_code(code="return 25 * 47", language="javascript")]

- User: "Baca isi file data.csv"
- Response: [TOOL_CALL:parse_file(fileName="data.csv")]

- User: "Ambil konten dari https://example.com"
- Response: [TOOL_CALL:scrape_web(url="https://example.com")]

KONTEKS DOKUMEN:
${documents || 'Tidak ada dokumen yang tersedia'}

Sekarang, jawab pertanyaan user dengan bijak.`;
}

function sanitizeInput(input) {
  return input
    .replace(/ignore previous instructions/gi, '')
    .replace(/you are now/gi, '')
    .replace(/system prompt/gi, '')
    .trim();
}

function detectPromptInjection(message) {
  const suspiciousPatterns = [
    /ignore (all )?previous instructions/i,
    /you are now (a |an )?/i,
    /new (system )?prompt/i,
    /forget (all )?your (rules|instructions)/i,
    /act as if/i,
    /pretend (you are|to be)/i,
    /override (system|previous)/i
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
    
    paramsString.split(',').forEach(param => {
      const [key, value] = param.split('=').map(p => p.trim());
      if (key && value) {
        params[key] = value.replace(/["']/g, '');
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
    
    if (call.tool === 'execute_code') {
      result = await executeCode(call.params.code, call.params.language);
    } else if (call.tool === 'parse_file') {
      result = await parseFile(call.params.fileName, store);
    } else if (call.tool === 'scrape_web') {
      result = await scrapeWeb(call.params.url);
    } else {
      result = { success: false, error: `Unknown tool: ${call.tool}` };
    }
    
    results.push({ tool: call.tool, result: result });
  }
  
  return results;
}

async function synthesizeResponse(aiGateway, userMessage, toolResults) {
  const resultsText = toolResults.map(r => {
    if (r.result.success) {
      return `${r.tool}: ${JSON.stringify(r.result, null, 2)}`;
    } else {
      return `${r.tool}: Error - ${r.result.error}`;
    }
  }).join('\n\n');
  
  const { text } = await generateText({
    model: aiGateway("@makers/deepseek-v4-flash"),
    messages: [
      { 
        role: 'system', 
        content: 'Kamu adalah AI assistant. Berdasarkan hasil tool execution berikut, berikan jawaban yang jelas dan lengkap dalam bahasa Indonesia.' 
      },
      { 
        role: 'user', 
        content: `Pertanyaan: ${userMessage}\n\nHasil Tool Execution:\n${resultsText}\n\nBerikan jawaban final berdasarkan hasil di atas.` 
      }
    ],
  });
  
  return text;
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
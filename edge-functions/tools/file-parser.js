import { getStore } from "@edgeone/pages-blob";

export async function parseFile(fileName, blobNamespace) {
  try {
    const store = getStore(blobNamespace);
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
import { getStore } from "@edgeone/pages-blob";

const BLOB_NAMESPACE = "memory-makers-cfyznvtdex4f";

export async function onRequestPost(context) {
  const { request } = context;

  try {
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file) {
      return new Response(JSON.stringify({ error: 'No file uploaded' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const content = await file.text();
    const store = getStore(BLOB_NAMESPACE);
    const fileName = `documents/${file.name}`;
    
    await store.set(fileName, content);

    return new Response(JSON.stringify({ 
      success: true, 
      fileName: file.name,
      message: 'File uploaded successfully'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
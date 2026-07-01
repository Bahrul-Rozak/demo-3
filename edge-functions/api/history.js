import { getStore } from "@edgeone/pages-blob";

const BLOB_NAMESPACE = "memory-makers-cfyznvtdex4f";

export async function onRequestGet(context) {
  try {
    const { request } = context;
    const url = new URL(request.url);
    const conversationId = url.searchParams.get('conversation_id');
    
    if (!conversationId) {
      return new Response(JSON.stringify({ messages: [] }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const store = getStore(BLOB_NAMESPACE);
    const history = await store.get(`conversations/${conversationId}.json`);
    
    if (!history) {
      return new Response(JSON.stringify({ messages: [] }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(history, {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export async function onRequestDelete(context) {
  try {
    const { request } = context;
    const url = new URL(request.url);
    const conversationId = url.searchParams.get('conversation_id');
    
    if (!conversationId) {
      return new Response(JSON.stringify({ error: 'Missing conversation_id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const store = getStore(BLOB_NAMESPACE);
    await store.delete(`conversations/${conversationId}.json`);
    await store.delete(`logs/${conversationId}.json`);

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
import crypto from 'node:crypto';

// A minimal MCP client for the Streamable HTTP transport (MCP spec 2025-06-18
// and compatible). One JSON-RPC request per POST; the server answers with either
// JSON or an SSE stream (Content-Type text/event-stream), both of which carry
// the same `result` object. Sessions are optional — COROS runs stateless — so no
// session header is tracked.
//
// No SDK: this is ~100 lines against a documented protocol, and pulling in an
// official client library for three method calls would drag its own transport
// abstractions into a project that deliberately keeps dependencies near zero.

const PROTOCOL_VERSION = '2025-06-18';

export class McpError extends Error {
  constructor(message, { code = null, httpStatus = null } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Parse an SSE body into the JSON-RPC responses it contains. */
function parseSse(text) {
  const messages = [];
  let event = null;
  let data = [];

  const flush = () => {
    if (data.length) {
      try { messages.push(JSON.parse(data.join('\n'))); } catch { /* keep-alive noise */ }
    }
    event = null;
    data = [];
  };

  for (const line of text.split(/\r?\n/)) {
    if (line === '') { flush(); continue; }
    if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
    if (line.startsWith('data:')) { data.push(line.slice(5).trimStart()); continue; }
    // Comments (`: ping`) are ignored by falling through.
  }
  flush();
  return messages;
}

/**
 * One MCP session against a remote HTTP server.
 *
 * @param {string} url the MCP endpoint, e.g. https://mcp.coros.com/mcp
 * @param {() => string} getToken returns a bearer token; may be async
 */
export function createMcpClient(url, getToken, { fetchImpl = globalThis.fetch, timeoutMs = 60000 } = {}) {
  let nextId = 1;
  let initialized = false;

  async function rpc(method, params, { retryOnAuth = false } = {}) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        jsonrpc: '2.0', id: nextId++, method, params: params || {},
      }),
    });

    if (res.status === 401 && retryOnAuth) {
      // The token may have expired between the caller's refresh and this call;
      // the caller can refresh and retry once. Not automatic beyond that, so a
      // broken credential fails loudly instead of looping.
      const err = new McpError('Unauthorized', { httpStatus: 401 });
      err.retryable = true;
      throw err;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new McpError(`MCP ${method} failed: HTTP ${res.status} ${body.slice(0, 300)}`, {
        httpStatus: res.status,
      });
    }

    const contentType = res.headers.get('content-type') || '';
    let message;
    if (contentType.includes('text/event-stream')) {
      const sse = parseSse(await res.text());
      const reply = sse.find((m) => m && typeof m === 'object' && 'result' in m)
        || sse.find((m) => m && typeof m === 'object' && 'error' in m);
      if (!reply) throw new McpError(`MCP ${method}: empty SSE response`);
      message = reply;
    } else {
      message = await res.json().catch(() => {
        throw new McpError(`MCP ${method}: response was not JSON`);
      });
    }

    if (message.error) {
      throw new McpError(`MCP ${method}: ${message.error.message || JSON.stringify(message.error)}`, {
        code: message.error.code,
      });
    }
    return message.result;
  }

  /** The required handshake. Returns the server's declared capabilities. */
  async function initialize(clientInfo = { name: 'fitberg', version: '1.0.0' }) {
    const result = await rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo,
    });
    initialized = true;
    return result;
  }

  /** What tools the server offers, with their input schemas. */
  async function listTools() {
    if (!initialized) throw new McpError('initialize() must run before listTools()');
    const result = await rpc('tools/list');
    return result.tools || [];
  }

  /**
   * Call a tool. Returns the raw `content` array plus `isError`, normalising the
   * many shapes servers use for embedded files (see the COROS downloader for
   * the specifics of extracting FIT bytes).
   */
  async function callTool(name, args) {
    if (!initialized) throw new McpError('initialize() must run before callTool()');
    const result = await rpc('tools/call', { name, arguments: args || {} }, { retryOnAuth: true });
    return {
      content: result?.content || [],
      isError: Boolean(result?.isError),
      structuredContent: result?.structuredContent,
    };
  }

  return { initialize, listTools, callTool, rpc };
}

/** Convenience for tests and probes: a fresh stateless client. */
export function randomState() {
  return crypto.randomBytes(8).toString('hex');
}
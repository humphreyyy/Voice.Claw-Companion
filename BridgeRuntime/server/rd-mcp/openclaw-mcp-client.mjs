import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(__dirname, 'openclaw-mcp-server.mjs');

let persistentClient = null;
let persistentTransport = null;
let persistentConnecting = null;
let callQueue = Promise.resolve();

function parseTextJson(result) {
  const text = result?.content?.find?.((part) => part.type === 'text')?.text || '';
  try { return JSON.parse(text); } catch { return { rawText: text, parseError: 'tool returned non-JSON text' }; }
}

async function closePersistentMcpClient() {
  const client = persistentClient;
  const transport = persistentTransport;
  persistentClient = null;
  persistentTransport = null;
  persistentConnecting = null;
  await client?.close?.().catch(() => null);
  await transport?.close?.().catch(() => null);
}

async function getPersistentMcpClient() {
  if (persistentClient) return persistentClient;
  if (persistentConnecting) return persistentConnecting;

  persistentConnecting = (async () => {
    const client = new Client({ name: 'intercom-rd-local-mcp-client', version: '0.1.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_SCRIPT], env: process.env });
    await client.connect(transport);
    persistentClient = client;
    persistentTransport = transport;
    persistentConnecting = null;
    return client;
  })().catch(async (err) => {
    await closePersistentMcpClient();
    throw err;
  });

  return persistentConnecting;
}

async function callOpenClawMcpToolUnsafe(name, args = {}, { timeoutMs = 60000 } = {}) {
  const client = await getPersistentMcpClient();
  const startedAt = Date.now();
  const tools = await client.listTools({}, { timeout: timeoutMs });
  const listedTools = tools.tools.map((tool) => tool.name);
  if (!listedTools.includes(name)) {
    return {
      ok: false,
      protocol: 'mcp-stdio-persistent',
      sdk: '@modelcontextprotocol/sdk',
      tool: name,
      elapsedMs: Date.now() - startedAt,
      listedTools,
      error: `unsupported local MCP tool: ${name}`,
    };
  }
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  const parsed = parseTextJson(result);
  const response = {
    ok: !result.isError,
    protocol: 'mcp-stdio-persistent',
    sdk: '@modelcontextprotocol/sdk',
    tool: name,
    elapsedMs: Date.now() - startedAt,
    listedTools,
    result: parsed,
  };

  return response;
}

export async function callOpenClawMcpTool(name, args = {}, { timeoutMs = 60000 } = {}) {
  const run = callQueue.then(() => callOpenClawMcpToolUnsafe(name, args, { timeoutMs }));
  callQueue = run.catch(() => null);
  try {
    return await run;
  } catch (err) {
    await closePersistentMcpClient();
    return {
      ok: false,
      protocol: 'mcp-stdio-persistent',
      sdk: '@modelcontextprotocol/sdk',
      tool: name,
      error: err.message,
    };
  }
}

export async function callOpenClawMcpToolEphemeral(name, args = {}, { timeoutMs = 60000 } = {}) {
  const client = new Client({ name: 'intercom-rd-local-mcp-client', version: '0.1.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_SCRIPT], env: process.env });
  let connected = false;
  const startedAt = Date.now();
  try {
    await client.connect(transport);
    connected = true;
    const tools = await client.listTools({}, { timeout: timeoutMs });
    const listedTools = tools.tools.map((tool) => tool.name);
    if (!listedTools.includes(name)) {
      return {
        ok: false,
        protocol: 'mcp-stdio',
        sdk: '@modelcontextprotocol/sdk',
        tool: name,
        elapsedMs: Date.now() - startedAt,
        listedTools,
        error: `unsupported local MCP tool: ${name}`,
      };
    }
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    return {
      ok: !result.isError,
      protocol: 'mcp-stdio',
      sdk: '@modelcontextprotocol/sdk',
      tool: name,
      elapsedMs: Date.now() - startedAt,
      listedTools,
      result: parseTextJson(result),
    };
  } finally {
    if (connected) await client.close();
    await transport.close?.();
  }
}

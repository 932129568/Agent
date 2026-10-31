import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'harbor-test-mcp', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} } })
server.registerTool('echo', { description: '回显文本', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }))
server.registerTool('add', { description: '加法', inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }], structuredContent: { sum: a + b } }))
server.registerResource('greeting', 'memory://greeting', { description: '测试资源', mimeType: 'text/plain' }, async uri => ({ contents: [{ uri: uri.href, text: 'hello-from-mcp-resource', mimeType: 'text/plain' }] }))
await server.connect(new StdioServerTransport())

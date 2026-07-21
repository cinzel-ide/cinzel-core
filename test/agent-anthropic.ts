import { completeAnthropic } from '../src/core/anthropic';
import { AgentMessage, ToolSpec } from '../src/core/types';
const tools: ToolSpec[] = [{ name: 'read_file', description: 'lê', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
// conversa que exercita a serializacao: user -> assistant(tool_use) -> tool result (agrupado) -> continua
const msgs: AgentMessage[] = [
  { role: 'system', content: 'x' },
  { role: 'user', content: 'lê config.json' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_1', name: 'read_file', arguments: { path: 'config.json' } }] },
  { role: 'tool', toolCallId: 'toolu_1', name: 'read_file', content: '{"port":8080}' }
];
completeAnthropic(msgs, tools, { provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-falsa', model: 'claude-sonnet-4-20250514', maxTokens: 64 })
  .then(() => console.log('inesperado: passou com chave falsa'))
  .catch(e => {
    const is401 = /HTTP 401/.test(e.message), is400 = /HTTP 400/.test(e.message);
    console.log('ANTHROPIC_TOOLS_ESTRUTURA_OK=' + is401 + ' (401=estrutura+serializacao certas; 400=mal formado)');
    console.log('  erro:', e.message.slice(0, 150));
    process.exit(is400 ? 2 : 0);
  });

import { runAgent } from '../src/core/agent';
import { ToolSpec, ToolCall } from '../src/core/types';
const key = process.env.CINZEL_TEST_KEY!;
const tools: ToolSpec[] = [{
  name: 'read_file',
  description: 'Lê um ficheiro do projeto (caminho relativo).',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
}];
async function executeTool(call: ToolCall): Promise<string> {
  if (call.name === 'read_file') return '{ "port": 8080, "host": "localhost" }';
  return 'ERRO';
}
async function run(model: string): Promise<boolean> {
  let toolCalled = false;
  try {
    const final = await runAgent(
      [{ role: 'user', content: 'Lê o ficheiro config.json e diz-me só o valor de "port".' }],
      tools, { provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKey: key, model },
      { onToolCall: c => { toolCalled = true; console.log('  ['+model+'] chamou', c.name, JSON.stringify(c.arguments)); }, executeTool }
    );
    const ok = toolCalled && /8080/.test(final);
    console.log('  ['+model+'] chamou=' + toolCalled + ' resposta_8080=' + /8080/.test(final) + ' -> ' + (ok?'OK':'FALHOU'));
    if (ok) console.log('  ['+model+'] resposta:', final.replace(/\n/g,' ').slice(0,100));
    return ok;
  } catch (e: any) { console.log('  ['+model+'] erro:', e.message.slice(0,90)); return false; }
}
(async () => {
  for (const m of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3-32b']) {
    if (await run(m)) { console.log('\nLOOP_AGENTE_OK com ' + m); process.exit(0); }
  }
  console.log('\nnenhum modelo Groq completou o loop'); process.exit(2);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });

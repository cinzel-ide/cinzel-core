import { streamChat } from '../src/core/provider';
const groqKey = process.env.CINZEL_TEST_KEY!;

async function main() {
  // 1. dispatch -> openai (Groq), com chave real
  let openaiOut = '';
  await streamChat(
    [{ role: 'user', content: 'Diz apenas: pronto' }],
    { provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKey: groqKey, model: 'openai/gpt-oss-120b' },
    d => { openaiOut += d; }
  );
  console.log('OPENAI_DISPATCH_OK=' + (openaiOut.length > 0), '| resposta:', JSON.stringify(openaiOut.trim().slice(0,40)));

  // 2. dispatch -> anthropic, chave falsa: esperamos 401 (estrutura ok), nao 400
  let anthErr = '';
  try {
    await streamChat(
      [{ role: 'system', content: 'x' }, { role: 'user', content: 'oi' }],
      { provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-chave-falsa-de-teste', model: 'claude-sonnet-4-20250514', maxTokens: 16 },
      () => {}
    );
  } catch (e: any) { anthErr = e.message; }
  const is401 = /HTTP 401/.test(anthErr);
  const is400 = /HTTP 400/.test(anthErr);
  console.log('ANTHROPIC_ESTRUTURA_OK=' + is401 + ' (401=auth, estrutura certa; 400=pedido mal formado)');
  console.log('  erro anthropic:', anthErr.slice(0, 160));
  if (is400) process.exit(2);
}
main().catch(e => { console.error('ERRO INESPERADO:', e.message); process.exit(1); });

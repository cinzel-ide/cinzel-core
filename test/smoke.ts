import { streamChat } from '../src/core/provider';
const key = process.env.CINZEL_TEST_KEY!;
let out = '';
streamChat(
  [{ role: 'user', content: 'Diz "olá" e uma frase curta sobre TypeScript.' }],
  { baseUrl: 'https://api.groq.com/openai/v1', apiKey: key, model: 'openai/gpt-oss-120b' },
  d => { out += d; process.stdout.write(d); }
).then(() => {
  console.log('\n---\nDELTAS_RECEBIDOS=' + (out.length > 0));
  console.log('CHARS=' + out.length);
}).catch(e => { console.error('ERRO:', e.message); process.exit(1); });

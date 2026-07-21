import { streamChat } from '../src/core/provider';
const key = process.env.CINZEL_TEST_KEY!;
// simula o que o provider monta: contexto (ficheiro) + pergunta
const ctx = 'Ficheiro: utils.ts\n```typescript\nexport function slugify(s: string) {\n  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n}\n```';
let out = '';
streamChat(
  [
    { role: 'system', content: 'Responde em português de Portugal, conciso. Baseia-te no contexto dado.' },
    { role: 'user', content: ctx + '\n\n---\n\nO que faz a função slugify e o que devolve para "Olá, Mundo!"?' }
  ],
  { baseUrl: 'https://api.groq.com/openai/v1', apiKey: key, model: 'openai/gpt-oss-120b' },
  d => { out += d; }
).then(() => {
  console.log('RESPOSTA:\n' + out);
  const usouContexto = /slug|min[úu]scul|h[íi]fen|ola-mundo|olá-mundo/i.test(out);
  console.log('\n---\nUSOU_O_CONTEXTO=' + usouContexto);
}).catch(e => { console.error('ERRO:', e.message); process.exit(1); });

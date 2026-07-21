import { runAgent } from '../src/core/agent';
import { ToolSpec, ToolCall } from '../src/core/types';
const key = process.env.CINZEL_TEST_KEY!;

// os mesmos specs que a extensao usa (versao curta)
const tools: ToolSpec[] = [
  { name: 'search_text', description: 'Procura texto no workspace; usa para ver o que JÁ EXISTE.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'find_files', description: 'Encontra ficheiros por glob.', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'read_file', description: 'Lê um ficheiro.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'propose_plan', description: 'Apresenta um PLANO e pede aprovação ANTES de alterar código. Chama sempre que a tarefa modifica ficheiros.', parameters: { type: 'object', properties: { summary: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } }, risk: { type: 'string' } }, required: ['summary', 'steps', 'risk'] } },
  { name: 'write_file', description: 'Escreve um ficheiro (confirmado pelo utilizador).', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }
];

const seq: string[] = [];
async function executeTool(call: ToolCall): Promise<string> {
  seq.push(call.name);
  switch (call.name) {
    case 'find_files': return 'src/utils.ts';
    case 'read_file': return 'export function add(a, b) { return a + b; }';
    case 'search_text': return 'sem resultados para "greet"';
    case 'propose_plan': return 'APROVADO — prossegue com a implementação.';
    case 'write_file': return 'Escrito src/utils.ts (6 linhas).';
    default: return 'ok';
  }
}

const SYSTEM = 'És o Cinzel a fazer pair programming, com ferramentas que ALTERAM o projeto. REGRA: quando o utilizador pede para adicionar/criar/alterar código num ficheiro, mostrar o código em texto NÃO serve — o ficheiro só muda se usares write_file. Fluxo OBRIGATÓRIO para modificar: 1) investiga (search_text/find_files/read_file); 2) chama propose_plan e espera aprovação; 3) chama write_file com o conteúdo final. Não termines sem write_file quando a tarefa é modificar um ficheiro.';

(async () => {
  await runAgent(
    [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Adiciona uma função greet(nome) ao src/utils.ts que devolve "Olá, <nome>!".' }],
    tools, { provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKey: key, model: 'openai/gpt-oss-120b' },
    { executeTool, onText: t => console.log('  [modelo diz]:', t.replace(/\n/g,' ').slice(0,200)) }
  );
  console.log('sequência de ferramentas:', seq.join(' → '));
  const investigou = seq.some(t => ['search_text','find_files','read_file'].includes(t));
  const planeou = seq.includes('propose_plan');
  const implementou = seq.includes('write_file');
  const ordemOk = !implementou || (seq.indexOf('propose_plan') >= 0 && seq.indexOf('propose_plan') < seq.lastIndexOf('write_file'));
  console.log('INVESTIGOU=' + investigou, '| PLANEOU=' + planeou, '| IMPLEMENTOU=' + implementou, '| PLANO_ANTES_DE_ESCREVER=' + ordemOk);
  process.exit(investigou && planeou && ordemOk ? 0 : 2);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });

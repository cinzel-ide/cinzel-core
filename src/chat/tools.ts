import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { ToolCall, ToolSpec } from '../core/types';
import { getDiagnosticsText, DiagSeverityName, SEVERITY_NAMES } from './diagnostics';

/** Teto de leitura, para não estourar o orçamento de tokens. */
const MAX_READ_CHARS = 20_000;

/** Hash do conteúdo lido/escrito — usado pela guarda anti-perda-de-dados. */
function sha256(s: string): string {
    return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** As ferramentas apresentadas ao modelo. */
export const TOOL_SPECS: ToolSpec[] = [
    {
        name: 'read_file',
        description: 'Lê o conteúdo de um ficheiro do workspace. Caminho relativo à raiz do workspace.',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Caminho relativo, ex.: src/index.ts' } },
            required: ['path']
        }
    },
    {
        name: 'list_dir',
        description: 'Lista os ficheiros e pastas de um diretório do workspace.',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Caminho relativo; "." para a raiz.' } },
            required: ['path']
        }
    },
    {
        name: 'write_file',
        description: 'CRIA um ficheiro novo (ou reescreve por completo um ficheiro pequeno que já leste por inteiro). Para ALTERAR um ficheiro existente usa edit_file — o write_file de um ficheiro que só leste em excerto é recusado (apagaria o resto). O utilizador CONFIRMA antes de aplicar.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Caminho relativo.' },
                content: { type: 'string', description: 'Conteúdo completo do ficheiro.' }
            },
            required: ['path', 'content']
        }
    },
    {
        name: 'edit_file',
        description: 'Altera uma REGIÃO de um ficheiro existente: encontra old_string (texto EXATO do ficheiro atual) e substitui por new_string. É a forma segura de editar — não reescreve o ficheiro inteiro, por isso nunca apaga partes que não leste. Mantém old_string pequeno (3-5 linhas com contexto à volta) para o match ser único. Para CRIAR um ficheiro novo, usa write_file.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Caminho relativo ao ficheiro a editar.' },
                old_string: { type: 'string', description: 'Texto EXATO a localizar (espaços/indentação incluídos). Não vazio; não pode cobrir o ficheiro inteiro.' },
                new_string: { type: 'string', description: 'Texto de substituição. Vazio para apagar a região.' },
                replace_all: { type: 'boolean', description: 'Se true, substitui TODAS as ocorrências; por omissão false (exige match único).' }
            },
            required: ['path', 'old_string', 'new_string']
        }
    },
    {
        name: 'search_text',
        description: 'Procura texto/símbolos em todo o workspace. Usa para saber se algo JÁ EXISTE e onde é usado, antes de escrever código novo.',
        parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Texto ou símbolo a procurar.' } },
            required: ['query']
        }
    },
    {
        name: 'find_files',
        description: 'Encontra ficheiros por padrão glob (ex.: **/*.test.ts). Usa para mapear a estrutura do projeto.',
        parameters: {
            type: 'object',
            properties: { pattern: { type: 'string', description: 'Padrão glob, ex.: src/**/*.ts' } },
            required: ['pattern']
        }
    },
    {
        name: 'propose_plan',
        description: 'Apresenta um PLANO ao utilizador e pede aprovação ANTES de alterar código. Chama isto sempre que a tarefa vá modificar ficheiros. Só implementa depois de aprovado.',
        parameters: {
            type: 'object',
            properties: {
                summary: { type: 'string', description: 'Resumo do que vais fazer.' },
                steps: { type: 'array', description: 'Passos, por ordem.', items: { type: 'string' } },
                filesToCreate: { type: 'array', description: 'Ficheiros a criar.', items: { type: 'string' } },
                filesToEdit: { type: 'array', description: 'Ficheiros a editar.', items: { type: 'string' } },
                risk: { type: 'string', description: 'Risco: baixo / médio / alto, com uma frase.' }
            },
            required: ['summary', 'steps', 'risk']
        }
    },
    {
        name: 'get_diagnostics',
        description: 'Lê os problemas (erros/avisos do compilador, LSP e linter) já publicados no workspace. Sem "path" = workspace inteiro (inclui ficheiros não abertos). Usa para ver o quadro completo ANTES de corrigir e para VALIDAR DEPOIS de aplicar (com waitMs ~1500, porque o LSP re-diagnostica de forma assíncrona ao gravar).',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Caminho relativo a UM ficheiro; omite para o workspace inteiro.' },
                severities: { type: 'array', description: "Filtro de severidade; por defeito ['error','warning'].", items: { type: 'string', enum: ['error', 'warning', 'info', 'hint'] } },
                max: { type: 'number', description: 'Teto de diagnósticos (por defeito 40).' },
                waitMs: { type: 'number', description: 'Se >0 e com path, espera pela nova publicação do LSP (ou até waitMs) antes de ler. Usa ~1500 na validação pós-correção.' }
            },
            required: []
        }
    }
];

const MAX_SEARCH_FILES = 400;
const MAX_SEARCH_HITS = 40;

function workspaceRoot(): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        throw new Error('sem pasta de trabalho aberta — abre uma pasta primeiro.');
    }
    return folders[0].uri;
}

/** Resolve um caminho relativo, confinado ao workspace (rejeita escapes com ../). */
function resolveInWorkspace(rel: string): { uri: vscode.Uri; rel: string } {
    const root = workspaceRoot();
    const normalized = path.posix.normalize(rel.replace(/\\/g, '/')).replace(/^\/+/, '');
    if (normalized === '..' || normalized.startsWith('../')) {
        throw new Error('caminho fora do workspace não é permitido.');
    }
    const uri = vscode.Uri.joinPath(root, normalized);
    if (!uri.path.startsWith(root.path)) {
        throw new Error('caminho fora do workspace não é permitido.');
    }
    return { uri, rel: normalized };
}

async function exists(uri: vscode.Uri): Promise<boolean> {
    try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
}

/**
 * Aplica a escrita via WorkspaceEdit — a alteração entra na undo stack nativa,
 * por isso Ctrl+Z reverte de forma limpa (fs.writeFile não é undoable). Grava a
 * seguir para persistir no disco. Cai para fs.writeFile se o applyEdit falhar.
 */
async function applyWrite(uri: vscode.Uri, content: string): Promise<void> {
    try {
        const existed = await exists(uri);
        const edit = new vscode.WorkspaceEdit();
        if (!existed) {
            edit.createFile(uri, { ignoreIfExists: true });
            edit.insert(uri, new vscode.Position(0, 0), content);
        } else {
            const doc = await vscode.workspace.openTextDocument(uri);
            const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
            edit.replace(uri, fullRange, content);
        }
        const ok = await vscode.workspace.applyEdit(edit);
        if (!ok) { throw new Error('applyEdit devolveu false'); }
        const doc = await vscode.workspace.openTextDocument(uri);
        await doc.save();
    } catch {
        // Fallback: escrita direta ao disco (sem undo nativo, mas grava sempre).
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    }
}

/**
 * Cria um executor de ferramentas com estado POR CONVERSA. O estado (readState)
 * regista que ficheiros foram lidos POR INTEIRO nesta conversa (rel → sha256 do
 * conteúdo), para a guarda anti-perda-de-dados do write_file. A assinatura do
 * executor devolvido é idêntica a AgentHooks.executeTool — o núcleo não muda.
 */
export function createToolExecutor(): (call: ToolCall) => Promise<string> {
    const readState = new Map<string, string>();

    return async function executeTool(call: ToolCall): Promise<string> {
        const args = call.arguments;
        switch (call.name) {
            case 'read_file': {
                const { uri, rel } = resolveInWorkspace(String(args.path ?? ''));
                const data = await vscode.workspace.fs.readFile(uri);
                const text = Buffer.from(data).toString('utf8');
                const clipped = text.length > MAX_READ_CHARS;
                // Leitura por inteiro desbloqueia um write_file total; a truncada limpa o crédito.
                if (clipped) { readState.delete(rel); } else { readState.set(rel, sha256(text)); }
                return `# ${rel}${clipped ? ' (excerto)' : ''}\n${text.slice(0, MAX_READ_CHARS)}`;
            }
            case 'list_dir': {
                const { uri, rel } = resolveInWorkspace(String(args.path ?? '.'));
                const entries = await vscode.workspace.fs.readDirectory(uri);
                const lines = entries
                    .map(([name, type]) => (type === vscode.FileType.Directory ? `${name}/` : name))
                    .sort();
                return `# ${rel || '.'}\n${lines.join('\n')}`;
            }
            case 'write_file': {
                const { uri, rel } = resolveInWorkspace(String(args.path ?? ''));
                const content = String(args.content ?? '');
                // Guarda anti-perda: reescrever um ficheiro EXISTENTE só se foi lido por
                // inteiro nesta conversa E continua igual no disco. Criar novo é livre.
                if (await exists(uri)) {
                    const seen = readState.get(rel);
                    if (!seen) {
                        return `RECUSADO (guarda anti-perda): "${rel}" já existe e não foi lido por inteiro nesta conversa (só um excerto, ou nem foi lido). Reescrever tudo com write_file apagaria a parte que não viste. Usa edit_file para alterar só a região (old_string→new_string). Se tens mesmo de o reescrever por completo, lê-o primeiro por inteiro com read_file (só se couber em ${MAX_READ_CHARS} caracteres).`;
                    }
                    let cur: string | null = null;
                    try { cur = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); } catch { cur = null; }
                    if (cur === null || sha256(cur) !== seen) {
                        return `RECUSADO (guarda anti-perda): "${rel}" mudou no disco desde que o leste. Reescrevê-lo agora apagaria alterações que não viste. Relê-o com read_file, ou usa edit_file para mudar só a região.`;
                    }
                }
                const approved = await confirmWrite(rel, uri, content);
                if (!approved) {
                    return 'RECUSADO: o utilizador não aprovou a escrita.';
                }
                await applyWrite(uri, content);
                // Regista o conteúdo REAL no disco (o save pode normalizar BOM/EOL).
                try { readState.set(rel, sha256(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'))); }
                catch { readState.set(rel, sha256(content)); }
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, { preview: false });
                return `Escrito ${rel} (${content.split('\n').length} linhas).`;
            }
            case 'edit_file': {
                const res = await editFile(args);
                if (res.applied && res.rel) { readState.delete(res.rel); } // ainda não viste a cauda por inteiro
                return res.text;
            }
            case 'get_diagnostics': {
                const severities = Array.isArray(args.severities)
                    ? (args.severities as unknown[]).map(String).filter((s): s is DiagSeverityName => (SEVERITY_NAMES as string[]).includes(s))
                    : undefined;
                return getDiagnosticsText({
                    path: args.path != null ? String(args.path) : undefined,
                    severities: severities && severities.length ? severities : undefined,
                    max: typeof args.max === 'number' ? args.max : undefined,
                    waitMs: typeof args.waitMs === 'number' ? args.waitMs : undefined
                });
            }
            case 'search_text':
                return searchText(String(args.query ?? ''));
            case 'find_files': {
                const uris = await vscode.workspace.findFiles(String(args.pattern ?? '**/*'), '**/node_modules/**', 100);
                if (!uris.length) { return 'sem ficheiros'; }
                return uris.map(u => vscode.workspace.asRelativePath(u)).sort().join('\n');
            }
            case 'propose_plan':
                return proposePlan(args);
            default:
                return `ERRO: ferramenta desconhecida "${call.name}".`;
        }
    };
}

/**
 * Edição cirúrgica por search/replace EXATO. Lê o ficheiro INTEIRO do disco
 * (ignora o teto de 20k) e substitui só a região por deslocamento — a cauda que
 * o modelo nunca viu fica byte-a-byte intacta. Match exato apenas: nada de fuzzy.
 */
async function editFile(args: Record<string, unknown>): Promise<{ text: string; applied: boolean; rel?: string }> {
    const { uri, rel } = resolveInWorkspace(String(args.path ?? ''));
    const oldStr = String(args.old_string ?? '');
    const newStr = String(args.new_string ?? '');
    const replaceAll = args.replace_all === true;

    if (!(await exists(uri))) {
        return { text: `edit_file: "${rel}" não existe. Para criar um ficheiro novo usa write_file.`, applied: false };
    }
    const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    // O BOM é metadados de codificação — o save reaplica-o. Trabalhamos sem ele
    // para não o duplicar ao reescrever o conteúdo via WorkspaceEdit.
    const hasBom = raw.charCodeAt(0) === 0xFEFF;
    const body = hasBom ? raw.slice(1) : raw;

    if (oldStr === '') {
        return { text: 'edit_file: old_string vazio. Para inserir texto, inclui em old_string uma âncora que já exista no ficheiro e repete-a em new_string com o texto novo à volta.', applied: false };
    }
    if (oldStr === newStr) {
        return { text: 'edit_file: old_string e new_string são iguais — nada a alterar.', applied: false };
    }
    if (oldStr.trim() === body.trim()) {
        return { text: 'edit_file: old_string cobre o ficheiro inteiro. Para reescrever tudo, usa write_file (lê-o primeiro por inteiro com read_file). Se só queres mudar uma parte, reduz old_string à região exata.', applied: false };
    }

    let count = 0;
    for (let i = body.indexOf(oldStr); i !== -1; i = body.indexOf(oldStr, i + oldStr.length)) { count++; }
    if (count === 0) {
        const near = nearestLine(body, oldStr);
        const hint = near ? ` Linha mais parecida no ficheiro: "${near}".` : '';
        return { text: `edit_file: 0 correspondências para old_string em "${rel}". O texto tem de bater EXATAMENTE — espaços, indentação, aspas e comentários incluídos, e sem números de linha. Relê a região com read_file e copia o excerto literal com 3-5 linhas de contexto.${hint}`, applied: false };
    }
    if (count > 1 && !replaceAll) {
        return { text: `edit_file: ${count} correspondências para old_string em "${rel}". Acrescenta linhas de contexto à volta para o match ser único, ou passa replace_all:true para substituir as ${count}.`, applied: false };
    }

    // Splice por deslocamento na string original — os outros bytes (e EOL) ficam intactos.
    let newBody: string;
    if (replaceAll) {
        newBody = body.split(oldStr).join(newStr);
    } else {
        const idx = body.indexOf(oldStr);
        newBody = body.slice(0, idx) + newStr + body.slice(idx + oldStr.length);
    }

    const approved = await confirmWrite(rel, uri, newBody, 'edit');
    if (!approved) {
        return { text: 'RECUSADO: o utilizador não aprovou a edição.', applied: false };
    }
    await applyWrite(uri, newBody);
    const n = replaceAll ? count : 1;
    return { text: `Editado ${rel} (${n} ${n === 1 ? 'região substituída' : 'regiões substituídas'}).`, applied: true, rel };
}

/** Similaridade barata (Dice de bigramas) para sugerir a linha mais parecida em 0-matches. */
function similarity(a: string, b: string): number {
    if (a === b) { return 1; }
    if (a.length < 2 || b.length < 2) { return 0; }
    const grams = new Map<string, number>();
    for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); grams.set(g, (grams.get(g) ?? 0) + 1); }
    let inter = 0;
    for (let i = 0; i < b.length - 1; i++) {
        const g = b.slice(i, i + 2);
        const c = grams.get(g) ?? 0;
        if (c > 0) { grams.set(g, c - 1); inter++; }
    }
    return (2 * inter) / ((a.length - 1) + (b.length - 1));
}

/** A linha do ficheiro mais parecida com a 1ª linha não-vazia de old_string. */
function nearestLine(body: string, needle: string): string {
    const target = (needle.split('\n').find(l => l.trim().length > 0) ?? '').trim();
    if (!target) { return ''; }
    let best = '';
    let bestScore = 0;
    for (const line of body.split('\n')) {
        const t = line.trim();
        if (!t) { continue; }
        const score = similarity(t, target);
        if (score > bestScore) { bestScore = score; best = t; }
    }
    return bestScore >= 0.5 ? best.slice(0, 120) : '';
}

/** Procura texto no workspace (scan em JS, sem dependências; ignora node_modules). */
async function searchText(query: string): Promise<string> {
    const q = query.trim();
    if (!q) { return 'query vazia'; }
    const uris = await vscode.workspace.findFiles('**/*', '**/node_modules/**', MAX_SEARCH_FILES);
    const needle = q.toLowerCase();
    const hits: string[] = [];
    for (const uri of uris) {
        if (hits.length >= MAX_SEARCH_HITS) { break; }
        try {
            const data = await vscode.workspace.fs.readFile(uri);
            if (data.byteLength > 200_000) { continue; }
            const lines = Buffer.from(data).toString('utf8').split('\n');
            const rel = vscode.workspace.asRelativePath(uri);
            for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
                if (lines[i].toLowerCase().includes(needle)) {
                    hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
                }
            }
        } catch { /* binário/ilegível — ignora */ }
    }
    return hits.length ? hits.join('\n') : `sem resultados para "${q}"`;
}

/** Mostra o plano ao utilizador e pede aprovação. */
async function proposePlan(args: Record<string, unknown>): Promise<string> {
    const summary = String(args.summary ?? '');
    const steps = Array.isArray(args.steps) ? args.steps.map(String) : [];
    const create = Array.isArray(args.filesToCreate) ? args.filesToCreate.map(String) : [];
    const edit = Array.isArray(args.filesToEdit) ? args.filesToEdit.map(String) : [];
    const risk = String(args.risk ?? 'desconhecido');
    const detail = [
        summary, '',
        steps.length ? vscode.l10n.t('Steps:') + '\n' + steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n') : '',
        create.length ? vscode.l10n.t('Create: {0}', create.join(', ')) : '',
        edit.length ? vscode.l10n.t('Edit: {0}', edit.join(', ')) : '',
        vscode.l10n.t('Risk: {0}', risk)
    ].filter(Boolean).join('\n');
    const approve = vscode.l10n.t('Approve');
    const choice = await vscode.window.showInformationMessage(
        vscode.l10n.t('Cinzel plan — approve?'), { modal: true, detail }, approve
    );
    return choice === approve
        ? 'APROVADO — prossegue com a implementação.'
        : 'REJEITADO pelo utilizador — não implementes; pergunta o que queres ajustar.';
}

/** Confirmação humana antes de escrever. Oferece ver o diff primeiro. */
async function confirmWrite(rel: string, uri: vscode.Uri, content: string, mode: 'write' | 'edit' = 'write'): Promise<boolean> {
    const already = await exists(uri);
    const detail = content.split('\n').slice(0, 12).join('\n');
    const lines = content.split('\n').length;
    const apply = vscode.l10n.t('Apply');
    const viewDiff = vscode.l10n.t('View diff');
    for (; ;) {
        const message = mode === 'edit'
            ? vscode.l10n.t('The agent wants to edit a region of "{0}".', rel)
            : already
                ? vscode.l10n.t('The agent wants to replace "{0}" ({1} lines).', rel, lines)
                : vscode.l10n.t('The agent wants to create "{0}" ({1} lines).', rel, lines);
        const choice = await vscode.window.showWarningMessage(
            message, { modal: true, detail }, apply, viewDiff
        );
        if (choice === apply) { return true; }
        if (choice === viewDiff) { await showDiff(rel, uri, already, content); continue; }
        return false; // dismiss = recusa
    }
}

async function showDiff(rel: string, uri: vscode.Uri, already: boolean, content: string): Promise<void> {
    const tmp = vscode.Uri.file(path.join(os.tmpdir(), `cinzel-${Date.now()}-${path.basename(rel)}`));
    await vscode.workspace.fs.writeFile(tmp, Buffer.from(content, 'utf8'));
    let left = uri;
    if (!already) {
        const emptyTmp = vscode.Uri.file(path.join(os.tmpdir(), `cinzel-empty-${Date.now()}`));
        await vscode.workspace.fs.writeFile(emptyTmp, Buffer.from('', 'utf8'));
        left = emptyTmp;
    }
    await vscode.commands.executeCommand('vscode.diff', left, tmp, vscode.l10n.t('Cinzel: {0} (proposal)', rel));
}

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { ToolCall, ToolSpec } from '../core/types';

/** Teto de leitura, para não estourar o orçamento de tokens. */
const MAX_READ_CHARS = 20_000;

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
        description: 'Escreve (cria ou substitui) um ficheiro. O utilizador CONFIRMA antes de aplicar.',
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

/** Executa uma chamada de ferramenta e devolve o resultado (texto). */
export async function executeTool(call: ToolCall): Promise<string> {
    const args = call.arguments;
    switch (call.name) {
        case 'read_file': {
            const { uri, rel } = resolveInWorkspace(String(args.path ?? ''));
            const data = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(data).toString('utf8');
            const clipped = text.length > MAX_READ_CHARS;
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
            const approved = await confirmWrite(rel, uri, content);
            if (!approved) {
                return 'RECUSADO: o utilizador não aprovou a escrita.';
            }
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: false });
            return `Escrito ${rel} (${content.split('\n').length} linhas).`;
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
async function confirmWrite(rel: string, uri: vscode.Uri, content: string): Promise<boolean> {
    const already = await exists(uri);
    const detail = content.split('\n').slice(0, 12).join('\n');
    const lines = content.split('\n').length;
    const apply = vscode.l10n.t('Apply');
    const viewDiff = vscode.l10n.t('View diff');
    for (; ;) {
        const message = already
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

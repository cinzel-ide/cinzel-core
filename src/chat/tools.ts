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
    }
];

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
        default:
            return `ERRO: ferramenta desconhecida "${call.name}".`;
    }
}

/** Confirmação humana antes de escrever. Oferece ver o diff primeiro. */
async function confirmWrite(rel: string, uri: vscode.Uri, content: string): Promise<boolean> {
    const already = await exists(uri);
    const detail = content.split('\n').slice(0, 12).join('\n');
    for (; ;) {
        const choice = await vscode.window.showWarningMessage(
            `O agente quer ${already ? 'substituir' : 'criar'} "${rel}" (${content.split('\n').length} linhas).`,
            { modal: true, detail },
            'Aplicar', 'Ver diff'
        );
        if (choice === 'Aplicar') { return true; }
        if (choice === 'Ver diff') { await showDiff(rel, uri, already, content); continue; }
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
    await vscode.commands.executeCommand('vscode.diff', left, tmp, `Cinzel: ${rel} (proposta)`);
}

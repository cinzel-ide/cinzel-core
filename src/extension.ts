import * as vscode from 'vscode';
import { CinzelChatViewProvider } from './chat/chatViewProvider';
import { CinzelCompletionProvider } from './chat/completionProvider';
import { CinzelFixCodeActionProvider, SerializedDiag } from './chat/fixCodeActionProvider';

function severityLabel(sev: number): string {
    return sev === 0 ? 'erro' : sev === 1 ? 'aviso' : sev === 2 ? 'info' : 'dica';
}

/** Seed PT-PT para um único diagnóstico (vindo da lâmpada). */
function buildDiagSeed(rel: string, d: SerializedDiag, lineText?: string): string {
    const src = d.source ? `${d.source}${d.code ? `(${d.code})` : ''}` : (d.code ?? '');
    const lines = [
        `Corrige este problema no ficheiro ${rel}.`,
        `Local: ${rel}:${d.line + 1}:${d.character + 1}${src ? ` · ${src}` : ''}`,
        `Severidade: ${severityLabel(d.severity)}`,
        `Mensagem: ${d.message}`
    ];
    if (lineText && lineText.trim()) { lines.push(`Linha: ${lineText.trim().slice(0, 160)}`); }
    lines.push('Diagnostica a causa raiz e corrige seguindo a tua doutrina de correção.');
    return lines.join('\n');
}

export function activate(context: vscode.ExtensionContext): void {
    const provider = new CinzelChatViewProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CinzelChatViewProvider.viewType, provider),
        // Autocomplete inline (ghost text) em todos os ficheiros, via Ollama FIM.
        vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, new CinzelCompletionProvider()),
        // Lâmpada "✨ Corrigir com IA" em cada erro/aviso.
        vscode.languages.registerCodeActionsProvider(
            { pattern: '**' },
            new CinzelFixCodeActionProvider(),
            { providedCodeActionKinds: CinzelFixCodeActionProvider.providedCodeActionKinds }
        )
    );

    context.subscriptions.push(
        // A chave é por provider: guarda-a para o modelo atualmente ativo.
        vscode.commands.registerCommand('cinzel.setApiKey', () => provider.promptSetApiKey()),
        vscode.commands.registerCommand('cinzel.clearApiKey', () => provider.promptClearApiKey()),
        vscode.commands.registerCommand('cinzel.selectModel', () => provider.promptSelectModel()),
        vscode.commands.registerCommand('cinzel.chat.clear', () => provider.clear()),
        vscode.commands.registerCommand('cinzel.attachSelection', () => provider.attachActiveEditor('selection')),
        vscode.commands.registerCommand('cinzel.attachFile', () => provider.attachActiveEditor('file')),
        vscode.commands.registerCommand('cinzel.completion.toggle', async () => {
            const cfg = vscode.workspace.getConfiguration('cinzel');
            const next = !cfg.get<boolean>('completion.enabled', true);
            await cfg.update('completion.enabled', next, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                next ? vscode.l10n.t('Cinzel: autocomplete enabled.') : vscode.l10n.t('Cinzel: autocomplete disabled.')
            );
        }),
        // Disparado pela lâmpada: recebe (uri, diagnóstico serializado).
        // Não anexamos o ficheiro — a doutrina manda o agente lê-lo (read_file);
        // anexar aqui vazava/duplicava contexto para conversas seguintes.
        vscode.commands.registerCommand('cinzel.fixBug', async (uri: vscode.Uri, diag: SerializedDiag) => {
            let lineText: string | undefined;
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                if (diag.line < doc.lineCount) { lineText = doc.lineAt(diag.line).text; }
            } catch { /* ignora */ }
            await provider.runAgentTask(buildDiagSeed(vscode.workspace.asRelativePath(uri), diag, lineText));
        }),
        // "Corrigir problemas do ficheiro": junta todos os erros/avisos do ficheiro ativo.
        vscode.commands.registerCommand('cinzel.fixFileProblems', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage(vscode.l10n.t('Cinzel: no problems in this file to fix.'));
                return;
            }
            const diags = vscode.languages.getDiagnostics(editor.document.uri)
                .filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning);
            if (!diags.length) {
                vscode.window.showInformationMessage(vscode.l10n.t('Cinzel: no problems in this file to fix.'));
                return;
            }
            const rel = vscode.workspace.asRelativePath(editor.document.uri);
            const list = diags.slice(0, 20).map(d =>
                `- [${severityLabel(d.severity)}] ${d.range.start.line + 1}:${d.range.start.character + 1} · ${d.message.replace(/\s+/g, ' ').trim()}`
            ).join('\n');
            const seed = [
                `Corrige os problemas do ficheiro ${rel} (${diags.length} no total${diags.length > 20 ? ', mostro os primeiros 20' : ''}):`,
                list,
                'Usa get_diagnostics para o quadro completo, diagnostica a causa raiz e corrige seguindo a tua doutrina.'
            ].join('\n');
            await provider.runAgentTask(seed);
        })
    );
}

export function deactivate(): void {
    // nada a limpar — tudo em context.subscriptions
}

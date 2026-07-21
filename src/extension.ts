import * as vscode from 'vscode';
import { CinzelChatViewProvider } from './chat/chatViewProvider';
import { CinzelCompletionProvider } from './chat/completionProvider';

export function activate(context: vscode.ExtensionContext): void {
    const provider = new CinzelChatViewProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CinzelChatViewProvider.viewType, provider),
        // Autocomplete inline (ghost text) em todos os ficheiros, via Ollama FIM.
        vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, new CinzelCompletionProvider())
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
            vscode.window.showInformationMessage(`Cinzel: autocomplete ${next ? 'ligado' : 'desligado'}.`);
        })
    );
}

export function deactivate(): void {
    // nada a limpar — tudo em context.subscriptions
}

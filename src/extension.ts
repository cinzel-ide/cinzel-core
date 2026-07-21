import * as vscode from 'vscode';
import { CinzelChatViewProvider } from './chat/chatViewProvider';

export function activate(context: vscode.ExtensionContext): void {
    const provider = new CinzelChatViewProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CinzelChatViewProvider.viewType, provider)
    );

    context.subscriptions.push(
        // A chave é por provider: guarda-a para o modelo atualmente ativo.
        vscode.commands.registerCommand('cinzel.setApiKey', () => provider.promptSetApiKey()),
        vscode.commands.registerCommand('cinzel.clearApiKey', () => provider.promptClearApiKey()),
        vscode.commands.registerCommand('cinzel.selectModel', () => provider.promptSelectModel()),
        vscode.commands.registerCommand('cinzel.chat.clear', () => provider.clear()),
        vscode.commands.registerCommand('cinzel.attachSelection', () => provider.attachActiveEditor('selection')),
        vscode.commands.registerCommand('cinzel.attachFile', () => provider.attachActiveEditor('file'))
    );
}

export function deactivate(): void {
    // nada a limpar — tudo em context.subscriptions
}

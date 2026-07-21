import * as vscode from 'vscode';
import { CinzelChatViewProvider } from './chat/chatViewProvider';

const API_KEY_SECRET = 'cinzel.apiKey';

export function activate(context: vscode.ExtensionContext): void {
    const provider = new CinzelChatViewProvider(context.extensionUri, context.secrets);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CinzelChatViewProvider.viewType, provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cinzel.setApiKey', async () => {
            const key = await vscode.window.showInputBox({
                title: 'Chave de API do Cinzel',
                prompt: 'Groq / OpenAI / OpenRouter / … — guardada no keychain do sistema, nunca em texto simples.',
                password: true,
                ignoreFocusOut: true
            });
            if (key && key.trim()) {
                await context.secrets.store(API_KEY_SECRET, key.trim());
                vscode.window.showInformationMessage('Cinzel: chave guardada no keychain do sistema.');
            }
        }),
        vscode.commands.registerCommand('cinzel.clearApiKey', async () => {
            await context.secrets.delete(API_KEY_SECRET);
            vscode.window.showInformationMessage('Cinzel: chave removida.');
        }),
        vscode.commands.registerCommand('cinzel.chat.clear', () => provider.clear())
    );
}

export function deactivate(): void {
    // nada a limpar — tudo em context.subscriptions
}

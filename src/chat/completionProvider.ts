import * as vscode from 'vscode';
import { fimComplete } from '../core/completion';

const PREFIX_MAX = 2000;
const SUFFIX_MAX = 800;
/** Espera antes de pedir; digitar rápido cancela o pedido anterior (debounce natural). */
const DEBOUNCE_MS = 180;

/**
 * Ghost text enquanto escreves, via um modelo FIM local (Ollama).
 * Respeita o token de cancelamento: quando escreves de novo, o VS Code cancela
 * o pedido em curso e nós abortamos o fetch.
 */
export class CinzelCompletionProvider implements vscode.InlineCompletionItemProvider {

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | undefined> {
        const cfg = vscode.workspace.getConfiguration('cinzel');
        if (!cfg.get<boolean>('completion.enabled', true)) { return; }

        // debounce: se o utilizador continuar a escrever, este token é cancelado
        await delay(DEBOUNCE_MS);
        if (token.isCancellationRequested) { return; }

        const offset = document.offsetAt(position);
        const full = document.getText();
        const prefix = full.slice(Math.max(0, offset - PREFIX_MAX), offset);
        const suffix = full.slice(offset, offset + SUFFIX_MAX);
        if (!prefix.trim() && !suffix.trim()) { return; }

        const controller = new AbortController();
        const sub = token.onCancellationRequested(() => controller.abort());
        try {
            const text = await fimComplete(prefix, suffix, {
                host: cfg.get<string>('completion.ollamaHost', 'http://localhost:11434'),
                model: cfg.get<string>('completion.model', 'qwen2.5-coder:1.5b-base'),
                maxTokens: cfg.get<number>('completion.maxTokens', 128),
                signal: controller.signal
            });
            if (token.isCancellationRequested || !text) { return; }
            return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
        } catch {
            // Ollama em baixo, abort, etc. — silêncio: nunca estragar a escrita.
            return;
        } finally {
            sub.dispose();
        }
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

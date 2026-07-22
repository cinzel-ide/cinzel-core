import * as vscode from 'vscode';

/**
 * Diagnostic reduzido a um objeto serializável — atravessa a fronteira do
 * comando (structured clone) sem perder dados nem arrastar objetos vscode.
 */
export interface SerializedDiag {
    message: string;
    severity: number;
    line: number;
    character: number;
    endLine: number;
    endCharacter: number;
    source?: string;
    code?: string;
}

function codeToString(code: vscode.Diagnostic['code']): string | undefined {
    if (code === undefined || code === null) { return undefined; }
    if (typeof code === 'object') { return String((code as { value: string | number }).value ?? ''); }
    return String(code);
}

export function serializeDiag(d: vscode.Diagnostic): SerializedDiag {
    return {
        message: d.message,
        severity: d.severity,
        line: d.range.start.line,
        character: d.range.start.character,
        endLine: d.range.end.line,
        endCharacter: d.range.end.character,
        source: d.source,
        code: codeToString(d.code)
    };
}

/**
 * Oferece "✨ Corrigir com IA" em cada erro/aviso. Não aplica edições — apenas
 * dispara o comando cinzel.fixBug, que semeia o agente (plano → diff → confirmação).
 * Nenhum custo de IA acontece até ao clique.
 */
export class CinzelFixCodeActionProvider implements vscode.CodeActionProvider {

    static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

    provideCodeActions(
        doc: vscode.TextDocument,
        _range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];
        for (const diag of context.diagnostics) {
            if (diag.severity !== vscode.DiagnosticSeverity.Error && diag.severity !== vscode.DiagnosticSeverity.Warning) {
                continue;
            }
            const short = diag.message.replace(/\s+/g, ' ').trim().slice(0, 60);
            const title = vscode.l10n.t('✨ Fix with AI: {0}', short);
            const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
            action.diagnostics = [diag];
            action.isPreferred = false; // nunca aplicado em silêncio pelo Auto Fix
            action.command = { command: 'cinzel.fixBug', title, arguments: [doc.uri, serializeDiag(diag)] };
            actions.push(action);
        }
        return actions;
    }
}

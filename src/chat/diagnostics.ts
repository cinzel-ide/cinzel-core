import * as vscode from 'vscode';

/**
 * Backend da ferramenta get_diagnostics — os "olhos" do agente sobre os
 * problemas reais (erros/avisos do compilador, LSP e linter) que já estão
 * publicados como markers. Só leitura, tudo APIs stable. Sem terminal, sem tasks.
 */

export type DiagSeverityName = 'error' | 'warning' | 'info' | 'hint';
export const SEVERITY_NAMES: DiagSeverityName[] = ['error', 'warning', 'info', 'hint'];

const SEV_NAME: Record<number, DiagSeverityName> = { 0: 'error', 1: 'warning', 2: 'info', 3: 'hint' };
const SEV_PT: Record<DiagSeverityName, string> = { error: 'erro', warning: 'aviso', info: 'info', hint: 'dica' };

export interface DiagQuery {
    /** Caminho relativo a UM ficheiro; omitido = workspace inteiro. */
    path?: string;
    /** Filtro de severidade; por defeito error+warning. */
    severities?: DiagSeverityName[];
    /** Teto de diagnósticos devolvidos (por defeito 40). */
    max?: number;
    /** Se >0 e com path, espera pela republicação do LSP (ou até waitMs) antes de ler. */
    waitMs?: number;
}

/** Diagnostic.code pode ser string | number | { value, target } — normaliza. */
function codeToString(code: vscode.Diagnostic['code']): string {
    if (code === undefined || code === null) { return ''; }
    if (typeof code === 'object') { return String((code as { value: string | number }).value ?? ''); }
    return String(code);
}

function workspaceRoot(): vscode.Uri | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length ? folders[0].uri : undefined;
}

/** Resolve um caminho relativo confinado ao workspace (rejeita escapes com ../, mesmo embutidos). */
function resolveUri(rel: string): vscode.Uri {
    const root = workspaceRoot();
    if (!root) { throw new Error('sem pasta de trabalho aberta.'); }
    const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    const uri = vscode.Uri.joinPath(root, norm);
    // joinPath colapsa '..' embutidos — confirma que o resultado fica DENTRO da raiz.
    if (uri.path !== root.path && !uri.path.startsWith(root.path.replace(/\/?$/, '/'))) {
        throw new Error('caminho fora do workspace.');
    }
    return uri;
}

/**
 * Espera pela próxima republicação de diagnósticos deste ficheiro (o LSP
 * re-diagnostica de forma ASSÍNCRONA ao gravar) ou até waitMs — o que vier
 * primeiro. Evita ler markers rançosos logo após aplicar uma correção.
 */
function settle(uri: vscode.Uri, waitMs: number): Promise<void> {
    if (waitMs <= 0) { return Promise.resolve(); }
    return new Promise<void>(resolve => {
        let done = false;
        const finish = (): void => {
            if (done) { return; }
            done = true;
            sub.dispose();
            clearTimeout(timer);
            resolve();
        };
        const sub = vscode.languages.onDidChangeDiagnostics(e => {
            if (e.uris.some(u => u.toString() === uri.toString())) { finish(); }
        });
        const timer = setTimeout(finish, waitMs);
    });
}

/** Recolhe, filtra e formata os diagnósticos em texto legível para o modelo. */
export async function getDiagnosticsText(q: DiagQuery): Promise<string> {
    const severities = q.severities && q.severities.length ? q.severities : (['error', 'warning'] as DiagSeverityName[]);
    const sevSet = new Set(severities);
    const max = q.max && q.max > 0 ? q.max : 40;

    let targetUri: vscode.Uri | undefined;
    if (q.path && q.path.trim()) {
        targetUri = resolveUri(q.path.trim());
        await settle(targetUri, q.waitMs ?? 0);
    }

    const pairs: [vscode.Uri, readonly vscode.Diagnostic[]][] = targetUri
        ? [[targetUri, vscode.languages.getDiagnostics(targetUri)]]
        : vscode.languages.getDiagnostics();

    const counts: Record<DiagSeverityName, number> = { error: 0, warning: 0, info: 0, hint: 0 };
    let total = 0;
    const kept: [vscode.Uri, vscode.Diagnostic[]][] = [];
    for (const [uri, diags] of pairs) {
        const keep = diags.filter(d => sevSet.has(SEV_NAME[d.severity] ?? 'hint'));
        if (!keep.length) { continue; }
        for (const d of keep) { counts[SEV_NAME[d.severity] ?? 'hint']++; total++; }
        keep.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
        kept.push([uri, keep]);
    }
    kept.sort((a, b) => vscode.workspace.asRelativePath(a[0]).localeCompare(vscode.workspace.asRelativePath(b[0])));

    if (!total) { return 'Sem diagnósticos para os filtros indicados.'; }

    const headParts: string[] = [];
    if (counts.error) { headParts.push(`${counts.error} ${counts.error === 1 ? 'erro' : 'erros'}`); }
    if (counts.warning) { headParts.push(`${counts.warning} ${counts.warning === 1 ? 'aviso' : 'avisos'}`); }
    if (counts.info) { headParts.push(`${counts.info} info`); }
    if (counts.hint) { headParts.push(`${counts.hint} ${counts.hint === 1 ? 'dica' : 'dicas'}`); }

    const body: string[] = [];
    let shown = 0;
    let truncated = false;
    for (const [uri, diags] of kept) {
        if (shown >= max) { truncated = true; break; }
        let doc: vscode.TextDocument | undefined;
        try { doc = await vscode.workspace.openTextDocument(uri); } catch { doc = undefined; }
        body.push(`\n## ${vscode.workspace.asRelativePath(uri)}`);
        for (const d of diags) {
            if (shown >= max) { truncated = true; break; }
            shown++;
            const sev = SEV_PT[SEV_NAME[d.severity] ?? 'hint'];
            const ln = d.range.start.line + 1;
            const col = d.range.start.character + 1;
            const src = d.source ?? '';
            const code = codeToString(d.code);
            const meta = src && code ? ` · ${src}(${code})` : src ? ` · ${src}` : code ? ` · ${code}` : '';
            const msg = d.message.replace(/\s+/g, ' ').trim();
            body.push(`  [${sev}] ${ln}:${col}${meta} · ${msg}`);
            if (doc && d.range.start.line < doc.lineCount) {
                const lineText = doc.lineAt(d.range.start.line).text.trim().slice(0, 160);
                if (lineText) { body.push(`      ${ln} | ${lineText}`); }
            }
            for (const r of (d.relatedInformation ?? []).slice(0, 2)) {
                const rrel = vscode.workspace.asRelativePath(r.location.uri);
                const rln = r.location.range.start.line + 1;
                body.push(`      ↳ ${rrel}:${rln} — ${r.message.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
            }
        }
    }

    const header = `Diagnósticos: ${headParts.join(', ')} — ${shown} de ${total}${truncated ? ' (truncado)' : ''}`;
    return `${header}\n${body.join('\n').replace(/^\n/, '')}`;
}

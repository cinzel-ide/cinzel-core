/**
 * Autocomplete FIM (fill-in-the-middle) via Ollama. Editor-agnóstico.
 *
 * Usa `/api/generate` com `suffix` — a via nativa de FIM do Ollama para modelos
 * com capacidade `insert` (ex.: qwen2.5-coder:*-base). O modelo recebe o que
 * está ANTES e DEPOIS do cursor e devolve o MEIO. Modelos de chat (Claude, GPT)
 * não fazem isto — daí um modelo dedicado.
 */
export interface FimConfig {
    /** Host do Ollama, ex.: http://localhost:11434 */
    host: string;
    /** Modelo FIM, ex.: qwen2.5-coder:1.5b-base (tem de ter a build -base). */
    model: string;
    maxTokens?: number;
    signal?: AbortSignal;
}

export async function fimComplete(prefix: string, suffix: string, cfg: FimConfig): Promise<string> {
    const url = `${cfg.host.replace(/\/+$/, '')}/api/generate`;

    // Trava a sobre-geração: os modelos FIM tendem a reproduzir o que vem a
    // seguir ao cursor. Paramos quando o modelo começa a emitir a 1ª linha
    // não-vazia do suffix — evita duplicar `}`, chamadas extra, etc.
    const options: Record<string, unknown> = { num_predict: cfg.maxTokens ?? 128, temperature: 0.1 };
    const firstSuffixLine = suffix.split('\n').map(l => l.trim()).find(l => l.length > 0);
    if (firstSuffixLine) {
        options.stop = [firstSuffixLine];
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, prompt: prefix, suffix, stream: false, options }),
        signal: cfg.signal
    });
    if (!res.ok) {
        throw new Error(`Ollama HTTP ${res.status}`);
    }
    const json = await res.json() as { response?: string };
    return json.response ?? '';
}

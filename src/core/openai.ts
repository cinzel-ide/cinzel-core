import { ChatMessage, StreamConfig } from './types';

/**
 * Endpoint compatível com OpenAI (`/chat/completions`), em streaming.
 * Serve OpenAI, Groq, OpenRouter, DeepSeek, Ollama, LM Studio.
 *
 * `fetch` puro + parsing manual de SSE, de propósito: sem SDKs, vês o protocolo.
 * Modelos de raciocínio (gpt-oss) mandam `reasoning` à parte do `content`;
 * só lemos `content`, por isso mostramos a resposta final, sem o "pensamento".
 */
export async function streamOpenAI(
    messages: ChatMessage[],
    cfg: StreamConfig,
    onDelta: (text: string) => void
): Promise<void> {
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({ model: cfg.model, messages, stream: true }),
        signal: cfg.signal
    });

    if (!res.ok || !res.body) {
        throw new Error(await httpError(res));
    }

    await forEachSseData(res.body, payload => {
        if (payload === '[DONE]') { return true; }
        try {
            const json = JSON.parse(payload);
            const delta: string | undefined = json?.choices?.[0]?.delta?.content;
            if (delta) { onDelta(delta); }
        } catch {
            // linha ainda incompleta — ignora
        }
        return false;
    });
}

/** Lê o corpo SSE linha a linha e chama `onData` com cada payload `data:`. */
export async function forEachSseData(
    body: ReadableStream<Uint8Array>,
    onData: (payload: string) => boolean | void
): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (; ;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) { continue; }
            const stop = onData(line.slice(5).trim());
            if (stop === true) { return; }
        }
    }
}

export async function httpError(res: Response): Promise<string> {
    const detail = await res.text().catch(() => '');
    return `HTTP ${res.status} ${res.statusText}` + (detail ? ` — ${detail.slice(0, 400)}` : '');
}

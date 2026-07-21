// Núcleo editor-agnóstico do Cinzel. NADA aqui importa 'vscode' —
// é este o limite que mantém o motor de IA reutilizável fora do editor
// (o embrião do SDK). Ver src/chat/ para o adaptador ao VS Code.

export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
    role: Role;
    content: string;
}

export interface ProviderConfig {
    /** Endpoint compatível com OpenAI, ex.: https://api.groq.com/openai/v1 */
    baseUrl: string;
    /** Chave de API. Vem do SecretStorage do editor, nunca de um ficheiro. */
    apiKey: string;
    /** Id do modelo, ex.: openai/gpt-oss-120b */
    model: string;
    /** Cancelamento cooperativo. */
    signal?: AbortSignal;
}

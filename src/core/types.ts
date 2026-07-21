// Núcleo editor-agnóstico do Cinzel. NADA aqui importa 'vscode' —
// é este o limite que mantém o motor de IA reutilizável fora do editor
// (o embrião do SDK).

export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
    role: Role;
    content: string;
}

/** Famílias de API suportadas. Distintas porque os protocolos diferem. */
export type ProviderKind = 'openai' | 'anthropic';

/** Um modelo escolhível na UI. Editável em `cinzel.models`. */
export interface ModelSpec {
    /** Id único (para o seletor e para guardar o modelo ativo). */
    id: string;
    /** Rótulo no seletor. */
    label: string;
    provider: ProviderKind;
    /** Endpoint base; também identifica a chave no keychain. */
    baseUrl: string;
    /** Id do modelo enviado à API. */
    model: string;
    /** Obrigatório na Anthropic; ignorado nos compatíveis-OpenAI. */
    maxTokens?: number;
}

/** Configuração de um pedido de streaming, já resolvida (com chave). */
export interface StreamConfig {
    provider: ProviderKind;
    baseUrl: string;
    apiKey: string;
    model: string;
    maxTokens?: number;
    signal?: AbortSignal;
}

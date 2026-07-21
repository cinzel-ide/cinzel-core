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

// --- Agente / tool-calling ---

/** Esquema JSON dos parâmetros de uma ferramenta (subconjunto usado). */
export interface JsonSchema {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
}

/** Definição de uma ferramenta apresentada ao modelo. */
export interface ToolSpec {
    name: string;
    description: string;
    parameters: JsonSchema;
}

/** Um pedido de chamada de ferramenta feito pelo modelo. */
export interface ToolCall {
    id: string;
    name: string;
    /** Argumentos já parseados a partir do JSON do modelo. */
    arguments: Record<string, unknown>;
}

/**
 * Mensagem do agente — mais rica que ChatMessage: o assistente pode pedir
 * ferramentas, e há resultados de ferramentas. Cada provider serializa isto
 * ao seu formato (OpenAI vs Anthropic diferem bastante).
 */
export type AgentMessage =
    | { role: 'system'; content: string }
    | { role: 'user'; content: string }
    | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
    | { role: 'tool'; toolCallId: string; name: string; content: string };

/** Um turno do assistente: texto e/ou pedidos de ferramenta. */
export interface AgentTurn {
    text: string;
    toolCalls: ToolCall[];
}

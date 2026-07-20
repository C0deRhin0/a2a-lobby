export interface AgentLobbyClientOptions {
  baseUrl: string;
  bearerToken?: string;
  fetchImpl?: typeof fetch;
}

export interface LocalSessionMapping {
  localSessionId: string;
  lobbyId: string;
  taskId: string;
  mcpSessionId?: string;
  lastEventCursor?: string;
}

export class AgentLobbyClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly bearerToken: string | undefined;
  private readonly sessions = new Map<string, LocalSessionMapping>();

  constructor(options: AgentLobbyClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.bearerToken = options.bearerToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  mapLocalSession(localSessionId: string, lobbyId: string): LocalSessionMapping {
    const mapping = { localSessionId, lobbyId, taskId: lobbyId };
    this.sessions.set(localSessionId, mapping);
    return mapping;
  }

  getLocalSession(localSessionId: string): LocalSessionMapping | undefined {
    return this.sessions.get(localSessionId);
  }

  async a2a(method: string, params?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}/a2a`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params })
    });
    const payload = await response.json() as any;
    if (payload.error) throw new Error(`${payload.error.code}: ${payload.error.message}`);
    return payload.result;
  }

  async mcpTool(name: string, args: Record<string, unknown>, localSessionId = "default"): Promise<unknown> {
    const mapping = this.sessions.get(localSessionId) ?? this.mapLocalSession(localSessionId, String(args.lobbyId ?? "unmapped"));
    const response = await this.fetchImpl(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json", ...(mapping.mcpSessionId ? { "mcp-session-id": mapping.mcpSessionId } : {}) }),
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } })
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) mapping.mcpSessionId = sessionId;
    const payload = await response.json() as any;
    if (payload.error) throw new Error(`${payload.error.code}: ${payload.error.message}`);
    return payload.result.structuredContent;
  }

  async catchUpEvents(localSessionId: string): Promise<unknown[]> {
    const mapping = this.sessions.get(localSessionId);
    if (!mapping) throw new Error("unknown local session");
    const response = await this.fetchImpl(`${this.baseUrl}/v1/lobbies/${mapping.lobbyId}/events?from=${encodeURIComponent(mapping.lastEventCursor ?? "0")}`, { headers: this.headers() });
    const payload = await response.json() as any;
    mapping.lastEventCursor = payload.reconnect?.cursor ?? mapping.lastEventCursor;
    return payload.events ?? [];
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}), ...extra };
  }
}

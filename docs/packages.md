# Package Reference

Mitzo uses an npm workspace with three internal packages shared between server and frontend. All packages live in `packages/` and are referenced via workspace dependencies.

## @mitzo/protocol

Core protocol types, validation schemas, and shared constants. Zero runtime dependencies beyond `zod` for schema validation.

### Types

#### Message Types

The protocol defines three representations of messages at different lifecycle stages:

| Type               | Stage     | Blocks                        | Use Case                           |
| ------------------ | --------- | ----------------------------- | ---------------------------------- |
| `StreamingMessage` | In-flight | `Map<string, StreamingBlock>` | Active streaming in frontend       |
| `FinishedMessage`  | Persisted | `FinishedBlock[]`             | Completed messages for display     |
| `MessageSnapshot`  | Recovery  | `SnapshotBlock[]`             | Server-side state for reconnection |

```typescript
interface FinishedMessage {
  messageId: string;
  role: 'user' | 'assistant';
  blocks: FinishedBlock[];
  images?: ImageAttachment[];
  contextBlocks?: string[];
  timestamp: number;
}

interface FinishedBlock {
  blockId: string;
  blockType: BlockType;
  content: string; // text content or tool summary
  toolName?: string; // for tool_use blocks
  toolInput?: RawToolInput;
  result?: string; // tool result
  images?: ToolResultImage[];
  subagent?: FinishedSubagentState;
}
```

#### Block Types

```typescript
type BlockType = 'text' | 'thinking' | 'redacted_thinking' | 'tool_use';
```

#### Modes and Tiers

```typescript
type MitzoMode = 'ask' | 'agent' | 'auto';
type ToolTier = 'safe' | 'standard' | 'elevated' | 'unknown';
```

#### Session Types

```typescript
type SessionState =
  | 'CREATED'
  | 'STARTING'
  | 'ACTIVE'
  | 'DETACHED'
  | 'SUSPENDED'
  | 'CLOSING'
  | 'ENDED';
type SessionClosedBy = 'user' | 'auto' | 'abandoned';

interface Session {
  id: string;
  summary: string;
  lastModified: number;
  branch?: string;
  isActive: boolean;
  isAttached: boolean;
  totalTokens: number;
  numTurns: number;
  telosTaskId?: string;
  closedBy?: SessionClosedBy;
}
```

#### Permission Types

```typescript
interface PermissionRequest {
  permId: string;
  toolName: string;
  toolInput: RawToolInput;
  tier: ToolTier;
  title?: string;
  description?: string;
}
```

#### Agent Definition Types

```typescript
interface AgentDefinition {
  name: string;
  identity: AgentIdentity;
  provider: AgentProvider;
  context: AgentContextConfig;
  governance?: AgentGovernance;
  memory?: AgentMemoryConfig;
  output?: AgentOutput;
}

interface AgentProvider {
  default: string; // default model
  tiering?: {
    fast?: string;
    standard?: string;
    capable?: string;
  };
}
```

#### Subagent Types

```typescript
interface FinishedSubagentState {
  messageId: string;
  blocks: FinishedBlock[];
  summary?: string;
  usage?: SubagentUsage;
}

interface SubagentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}
```

### Schemas (Zod)

The protocol package exports Zod schemas for all WebSocket messages:

```typescript
// Client -> Server
HelloMessage; // { type: 'hello', protocolVersion: number }
ReconnectMessage; // { type: 'reconnect', sessions: [...] }
V2SendMessage; // { type: 'send', prompt, sessionId, ... }
V2InterruptMessage; // { type: 'interrupt', prompt, sessionId, ... }
V2StopMessage; // { type: 'stop', sessionId }
V2PermissionResponseMessage;
V2SetModeMessage;
WatchMessage;
UnwatchMessage;
SwitchSessionMessage;
SessionSuspendMessage;
SessionCloseMessage;

// Discriminated union
IncomingWsMessageV2; // Union of all client->server messages
```

### Functions

```typescript
// Tool summarization
getRawInput(toolName: string, toolInput: unknown): RawToolInput;
summarizeToolInput(toolName: string, toolInput: unknown): string;

// Language detection
languageFromPath(filePath: string): string;

// Content block parsing
extractToolResultText(result: unknown): string;
extractToolResultImages(result: unknown): RawToolResultImage[];
parseContentBlocks(blocks: unknown[]): FinishedBlock[];
```

### Constants

```typescript
TOOL_RESULT_MAX_CHARS: 50_000;
TOOL_SUMMARY_MAX_CHARS: 200;
RAW_INPUT_MAX_CHARS: 50_000;
NOTIFY_SNIPPET_MAX_CHARS: 150;
SESSION_PAGE_SIZE: 20;
SESSION_MESSAGES_LIMIT: 100;
MAX_OBSERVERS_PER_SESSION: 10;
CONTEXT_CEILING_TOKENS: 200_000;
```

### Event Store (Subexport)

Available via `@mitzo/protocol/event-store`:

```typescript
class EventStore {
  constructor(dbPath: string, logger?: EventStoreLogger);

  // Events
  append(sessionId: string, type: string, payload: unknown): number;
  getEventsAfter(sessionId: string, afterSeq: number, limit?: number): StoredEvent[];
  getSessionEvents(sessionId: string): StoredEvent[];

  // Sessions
  upsertSession(meta: Partial<SessionMeta>): void;
  getSession(sessionId: string): SessionMeta | null;
  listSessions(limit?: number): SessionMeta[];
  searchSessions(query: string, limit: number): SessionSearchResult[];

  // State management
  setSessionState(sessionId: string, newState: SessionState, opts?): void;
  recordUsage(sessionId: string, usage: object): void;
  getAttentionSessions(): SessionMeta[];
  incrementPromptCount(sessionId: string): number;
}
```

Peer dependency: `better-sqlite3`.

---

## @mitzo/harness

Server-side session management, permissions, and orchestration. This is the core server package that sits between the Express routes and the Agent SDK.

### Session Registry

Manages the lifecycle of SDK sessions:

```typescript
class SessionRegistry {
  register(clientId: string, transport: SessionTransport): ManagedSession;
  get(clientId: string): ManagedSession | undefined;
  list(attached?: boolean): ManagedSession[];

  // Snapshot management
  snapshot(clientId: string, sessionId: string): MessageSnapshot | null;
  updateSnapshot(clientId: string, snapshot: MessageSnapshot): void;

  // Observers
  addObserver(clientId: string, observer: SessionTransport): void;
  removeObserver(clientId: string, observer: SessionTransport): void;
  broadcast(sessionId: string, data: unknown, excludeClientId?: string): void;

  // Lifecycle
  detach(clientId: string): void;
  reattach(clientId: string, sessions: Array<...>, resumeSeq?: number): void;
  suspend(clientId: string): void;
  resume(clientId: string): void;
  scheduleCloseout(clientId: string): void;
}
```

Key constants:

```typescript
DETACHED_TTL_MS: 30_000; // 30s before detached session aborts
CLOSEOUT_LEAD_MS: 30_000; // Time given for graceful closeout
CLOSEOUT_TIMEOUT_MS: 5_000; // Hard timeout after closeout
PERMISSION_TIMEOUT_MS: 60_000; // 1 minute for permission responses
```

### Connection Registry

Manages the v2 single-multiplexed-WS model:

```typescript
class ConnectionRegistry {
  register(connectionId: string, transport: SessionTransport): void;
  get(connectionId: string): Connection | undefined;
  remove(connectionId: string): void;

  watch(connectionId: string, sessionId: string): void;
  unwatch(connectionId: string, sessionId: string): void;
  setActive(connectionId: string, sessionId: string | null): void;

  broadcast(sessionId: string, data: unknown): void;
  sync(connectionId: string, sessionId: string, fromSeq: number): void;
}
```

### Permission Handler

Builds the `canUseTool` callback for the Agent SDK:

```typescript
function buildPermissionHandler(
  clientId: string,
  registry: SessionRegistry,
  opts?: { notify?: boolean },
): (toolName: string, toolInput: unknown, context: ToolContext) => Promise<PermissionResult>;
```

The handler checks in order: skill policy -> worktree guard -> auto-allow -> allow-list -> user prompt.

### Tool Tiers

```typescript
function getToolTier(toolName: string): ToolTier;
function shouldAutoAllow(toolName: string, mode: MitzoMode): boolean;
function applyTierOverrides(overrides: Record<string, ToolTier>): void;
function getAllowedToolsForMode(mode: MitzoMode): Set<string>;
```

### Worktree Guard

```typescript
function checkWorktreePolicy(
  session: ManagedSession,
  toolName: string,
  toolInput: unknown,
  opts?: { logger?: Logger },
): Promise<string | null>; // returns violation message or null
```

### Model Providers

Multi-model abstraction supporting Anthropic (via Vertex) and Google (Gemini):

```typescript
interface ModelProvider {
  model: string;
  call(messages: ProviderMessage[], opts?: CallOptions): Promise<ProviderResponse>;
}

function createProvider(model: string): ModelProvider;
function createProviders(models: string[]): Map<string, ModelProvider>;
function calculateCost(model: string, usage: object): number;
```

### Reasoning Orchestrators

```typescript
// Deliberation: structured multi-agent debate
class DeliberationOrchestrator {
  run(context: string, callbacks?: object): Promise<DeliberationResult>;
}

// Fusion: parallel panel + judge synthesis
class FusionOrchestrator {
  run(context: string, callbacks?: object): Promise<FusionResult>;
}

// Config builders
function buildDeliberationConfig(options: object): DeliberationConfig;
function buildFusionConfig(options: object): FusionConfig;
```

### Notifications

```typescript
// ntfy
function sendPermissionNotification(opts: NotifyOpts): Promise<void>;
function isConfigured(): boolean;

// Pushover
function sendPermissionNotification(opts: PushoverOpts): Promise<void>;
function isConfigured(): boolean;
```

### Auto-Rename

```typescript
function shouldAutoRename(sessionMeta: SessionMeta): boolean;
function extractRecentPrompts(events: StoredEvent[]): string[];
function generateSessionName(prompts: string[]): Promise<string>;
```

### SSE Registry

```typescript
class SseRegistry {
  add(id: string, res: Response): void;
  remove(id: string): void;
  broadcast(event: string, data: unknown): void;
}
```

---

## @mitzo/client

Framework-agnostic frontend state management and transport. The core is a Zustand vanilla store; React hooks are available as an optional subexport.

### MitzoConnection

Single multiplexed WebSocket connection with automatic reconnection:

```typescript
class MitzoConnection {
  constructor(config: MitzoConnectionConfig);

  connect(): void;
  disconnect(): void;
  send(msg: object): boolean;
  onMessage(listener: (data: string) => void): void;
  isConnected(): boolean;
  getConnectionId(): string | null;

  // Sequence tracking for reconnection
  trackSeq(sessionId: string, seq: number): void;
  getLastSeq(sessionId: string): number;
  clearSession(sessionId: string): void;
  getTrackedSessions(): string[];

  // iOS background
  sendSuspend(): void;
}
```

Configuration:

```typescript
interface MitzoConnectionConfig {
  buildUrl(): string; // WebSocket URL builder
  createWebSocket(url: string): WebSocketLike;
  reconnectDelayMs?: number; // Default: 1000ms
  suspendUrl?: string; // POST endpoint for sendBeacon fallback
}
```

Features:

- Automatic hello/welcome handshake
- Reconnection with session replay via `reconnect` message
- Pending message queue (up to 100 messages during reconnect)
- Browser lifecycle listeners (online/offline, visibilitychange)
- Heartbeat for connection health
- `sendSuspend()` uses `sendBeacon()` for iOS background (falls back to WS)

### Zustand Store

The store has 12 state slices:

| Slice         | State             | Key Fields                                                           |
| ------------- | ----------------- | -------------------------------------------------------------------- |
| `sessions`    | Session list      | `list`, `current`, `meta`, `loading`                                 |
| `messages`    | Chat messages     | `messages`, `current` (streaming), `running`, `permission`, `branch` |
| `connection`  | Transport state   | `status`, `connectionId`, `error`                                    |
| `permissions` | Pending approvals | `pending` (Record by permId)                                         |
| `tasks`       | Task board        | `items`, `loopStatus`                                                |
| `workload`    | Workload items    | `items`                                                              |
| `inbox`       | Inbox items       | `items`                                                              |
| `calendar`    | Calendar events   | `events`, `sprints`                                                  |
| `todos`       | Todo items        | `items`                                                              |
| `config`      | Server config     | `contextBlocks`, `skills`, `mode`, `model`                           |
| `tokens`      | Token tracking    | `sessions` (per-session), `totals`, `ceiling`                        |
| `progress`    | Progress blocks   | `blocks` (by progressId)                                             |

#### Actions

```typescript
// Chat
sendMessage(text: string, opts?: SendMessageOptions): void;
interruptMessage(text: string, opts?: SendMessageOptions): void;
stopGeneration(): void;
respondToPermission(permId: string, decision: string): void;
setMode(mode: MitzoMode): void;

// Sessions
switchSession(id: string): Promise<void>;
newSession(): void;
closeSession(): void;
loadSessions(): Promise<void>;

// Tasks
loadTasks(): Promise<void>;
createTask(input: object): Promise<void>;
startLoop(goalId: string, specMode?: boolean): Promise<void>;
pauseLoop(): Promise<void>;
resumeLoop(): Promise<void>;
stopLoop(): Promise<void>;
approveTask(id: string): Promise<void>;
rejectTask(id: string, feedback?: string): Promise<void>;
```

### Protocol Parser

Converts raw server JSON into typed store actions:

```typescript
function parseServerMessage(msg: string, callbacks: ProtocolCallbacks): ParseResult;
```

Callbacks cover every server message type:

```typescript
interface ProtocolCallbacks {
  onMessageStart?(data: object): void;
  onBlockStart?(data: object): void;
  onBlockDelta?(data: object): void;
  onBlockEnd?(data: object): void;
  onToolResult?(data: object): void;
  onPermissionRequest?(data: object): void;
  onSessionActive?(data: object): void;
  onBootContext?(data: object): void;
  // ... and more
}
```

### API Client

REST client for non-realtime operations:

```typescript
class MitzoApiClient {
  constructor(baseUrl: string, transport: TransportAdapter, options?: object);

  auth(): Promise<AuthCheckResult>;
  getAppConfig(): Promise<AppConfig>;
  getVersion(): Promise<VersionInfo>;
  getGitInfo(): Promise<GitInfo>;
  listDir(path: string): Promise<FileEntry[]>;
  getCalendarData(): Promise<CalendarData>;
  listSessions(limit?: number): Promise<SessionMetaResponse[]>;
  getSessionMeta(sessionId: string): Promise<SessionMetaResponse>;
  searchSessions(query: string): Promise<SessionSearchResult[]>;
}
```

### SSE Connection (Fallback)

For environments where WebSocket is unavailable:

```typescript
class SseConnection {
  constructor(config: SseConnectionConfig);

  connect(): void;
  disconnect(): void;
  send(msg: object): void;
  isConnected(): boolean;
}
```

Uses `EventSource` for server->client and HTTP POST for client->server.

### React Hooks (Subexport)

Available via `@mitzo/client/hooks`:

```typescript
function useStore(): MitzoStoreState;
function useConnection(): ConnectionSlice;
function useMessages(): MessagesSlice;
function usePermission(): PermissionsSlice;
function useSessions(): SessionsSlice;
function useTokens(): TokensSlice;
```

Tree-shakeable -- only import what you use.

### Event Bus

Broadcast events across the application:

```typescript
class EventBus {
  listen(channel: string, listener: (data: unknown) => void): () => void;
  broadcast(channel: string, data: unknown): void;
  connect(): void;
  disconnect(): void;
}
```

Backed by `EventSource` for server-pushed events (SSE stream at `/api/events`).

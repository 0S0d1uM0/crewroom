import type { Operation, PermissionResult } from './permission-manager.js';
export interface Usage { [key: string]: number }
export interface TurnResult { status: 'completed' | 'failed' | 'quota' | 'cancelled'; usage?: Usage; error?: string; quota?: Record<string, unknown> }
export interface AdapterEvent { type: string; [key: string]: unknown }
export interface ToolDefinition { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, any>; required?: string[]; additionalProperties?: boolean } }
export interface ToolResult { text: string; isError?: boolean }
export interface ToolEndpoint { url: string; token: string }
// The platform's collaboration tools as one member sees them. A blocking tool holds its call open.
export interface ToolHost { definitions: ToolDefinition[]; call(name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult>; endpoint?: ToolEndpoint; authorize?(operation: Operation, signal?: AbortSignal): Promise<PermissionResult> }
export interface HarnessAdapter {
  permission?: { level(): import('./permission-manager.js').PermissionLevel; online(): boolean; request(operation: Operation, signal?: AbortSignal): Promise<PermissionResult> };
  readQuota?(): Promise<Record<string, any>>;
  tools?: ToolHost;
  // False for a harness that cannot take tools: its members are told to use the text blocks instead.
  supportsTools?: boolean;
  // How this harness presents tools to its model, when that is not obvious.
  toolHint?: string;
  // A harness that cannot hold a tool call open this long without the model polling. A member
  // blocked longer has its turn ended by the platform, and the next message starts a new one.
  maxBlockMs?: number;
  // Project rule files this harness loads by itself, so the platform does not repeat them.
  nativeProjectFiles?: string[];
  getSessionId?(): string | undefined;
  resume?(id: string, instructions: string): Promise<void>;
  start(instructions: string): Promise<void>;
  prompt(text: string): Promise<TurnResult>;
  steer(text: string): Promise<'steered' | 'idle' | 'unsupported'>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  onMessage: (text: string) => void;
  onEvent: (event: AdapterEvent) => void;
}
export interface PlatformEvent { type: string; at: string; [key: string]: unknown }

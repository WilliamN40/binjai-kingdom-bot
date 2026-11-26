import { claudeProvider } from './claude-provider.js';
import type { ProviderName, AgentOptions, LoopOptions, AgentResponse, AgentUsage, ModelInfo } from './types.js';

// Re-export types for consumers
export type { AgentUsage, AgentResponse, AgentOptions, LoopOptions, ModelInfo, ProviderName };

// Claude is the only provider. The chatId parameters are kept so the public
// API stays identical for existing callers.

// --- Public API (identical signatures to agent.ts) ---

export function getActiveProviderName(_chatId: number): ProviderName {
  return 'claude';
}

export async function setActiveProvider(_chatId: number, _provider: ProviderName): Promise<void> {
  // No-op: there is only one provider.
}

export function getAvailableProviders(): ProviderName[] {
  return ['claude'];
}

export async function sendToAgent(
  sessionKey: string,
  message: string,
  options?: AgentOptions
): Promise<AgentResponse> {
  return claudeProvider.sendToAgent(sessionKey, message, options);
}

export async function sendLoopToAgent(
  sessionKey: string,
  message: string,
  options?: LoopOptions
): Promise<AgentResponse> {
  return claudeProvider.sendLoopToAgent(sessionKey, message, options);
}

export function clearConversation(sessionKey: string): void {
  claudeProvider.clearConversation(sessionKey);
}

export function setModel(chatId: number, model: string): void {
  claudeProvider.setModel(chatId, model);
}

export function getModel(chatId: number): string {
  return claudeProvider.getModel(chatId);
}

export function clearModel(chatId: number): void {
  claudeProvider.clearModel(chatId);
}

export function getCachedUsage(sessionKey: string): AgentUsage | undefined {
  return claudeProvider.getCachedUsage(sessionKey);
}

export function isDangerousMode(): boolean {
  return claudeProvider.isDangerousMode();
}

export async function getAvailableModels(chatId: number): Promise<ModelInfo[]> {
  return claudeProvider.getAvailableModels(chatId);
}

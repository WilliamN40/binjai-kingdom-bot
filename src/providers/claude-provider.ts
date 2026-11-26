import {
  sendToAgent as claudeSendToAgent,
  sendLoopToAgent as claudeSendLoopToAgent,
  clearConversation as claudeClearConversation,
  setModel as claudeSetModel,
  getModel as claudeGetModel,
  clearModel as claudeClearModel,
  getCachedUsage as claudeGetCachedUsage,
  isDangerousMode as claudeIsDangerousMode,
} from '../claude/agent.js';
import type { Provider, AgentOptions, LoopOptions, AgentResponse, AgentUsage, ModelInfo } from './types.js';

const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', description: 'Default: strong and fast' },
  { id: 'claude-fable-5-2', label: 'Fable 5.2', description: 'Most capable, slower and pricier' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', description: 'Balanced' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', description: 'Fast & light' },
];

export const claudeProvider: Provider = {
  name: 'claude',

  sendToAgent(sessionKey: string, message: string, options?: AgentOptions): Promise<AgentResponse> {
    return claudeSendToAgent(sessionKey, message, options);
  },

  sendLoopToAgent(sessionKey: string, message: string, options?: LoopOptions): Promise<AgentResponse> {
    return claudeSendLoopToAgent(sessionKey, message, options);
  },

  clearConversation(sessionKey: string): void {
    claudeClearConversation(sessionKey);
  },

  setModel(chatId: number, model: string): void {
    claudeSetModel(chatId, model);
  },

  getModel(chatId: number): string {
    return claudeGetModel(chatId);
  },

  clearModel(chatId: number): void {
    claudeClearModel(chatId);
  },

  getCachedUsage(sessionKey: string): AgentUsage | undefined {
    return claudeGetCachedUsage(sessionKey);
  },

  isDangerousMode(): boolean {
    return claudeIsDangerousMode();
  },

  async getAvailableModels(): Promise<ModelInfo[]> {
    return CLAUDE_MODELS;
  },
};

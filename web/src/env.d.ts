/// <reference types="vite/client" />

interface SidecarAgentApi {
  sendMessage?: (message: string) => Promise<unknown> | void;
}

interface SidecarUiApi {
  toggleConversation?: (conversationId: string) => void;
  toggleAuxPane?: (opts: { tabType: string; uri: string }) => void;
}

interface SidecarBridge {
  conversationId?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  getWorkspaceUris?: () => Promise<string[]> | string[];
  agent?: SidecarAgentApi;
  ui?: SidecarUiApi;
}

declare global {
  interface Window {
    sidecar?: SidecarBridge;
  }
}

export {};

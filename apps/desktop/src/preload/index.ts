import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AppLogEvent,
  AppPreferences,
  ArtifactRun,
  ArtifactsListRequest,
  BtwAskRequest,
  BtwAskResult,
  BtwClearRequest,
  BtwEvent,
  ConversationExportRequest,
  ConversationExportResult,
  ConversationSearchRequest,
  ConversationSearchResult,
  ClaudeConversationResult,
  ClaudeSessionExistsRequest,
  ClaudeSessionEvent,
  ConversationLoadRequest,
  ConversationEvent,
  DesktopApi,
  PersistedThread,
  PromptSubmittedEvent,
  RemotePairedDevice,
  RemotePairingInfo,
  SavePastedImageRequest,
  SavePastedImageResult,
  SessionApprovalAnswer,
  SessionApprovalResult,
  SessionRuntimeEvent,
  SessionDataEvent,
  SessionExitEvent,
  SessionInputRequest,
  SessionInputResult,
  SessionResizeRequest,
  SessionStarredEvent,
  SessionStartRequest,
  SessionStartResult,
  SessionStartedEvent,
  SessionStopRequest,
  SessionTitleEvent,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalStartRequest,
  TerminalStartResult,
  UsageCostQuery,
  UsageCostReport,
  UsageProvider,
  UsageSnapshot,
  WorkspaceGitRequest,
  WorkspaceGitStatus,
} from "../shared/ipc";

const api: DesktopApi = {
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  savePastedImage: (request: SavePastedImageRequest) =>
    ipcRenderer.invoke("image:save-pasted", request) as Promise<SavePastedImageResult>,
  exportConversation: (request: ConversationExportRequest) =>
    ipcRenderer.invoke("export:conversation", request) as Promise<ConversationExportResult>,
  logEvent: (event: AppLogEvent) => ipcRenderer.invoke("app:log", event) as Promise<void>,
  setBadgeCount: (count: number) => ipcRenderer.invoke("app:set-badge", count) as Promise<void>,
  focusWindow: () => ipcRenderer.invoke("app:focus") as Promise<void>,
  selectDirectory: () => ipcRenderer.invoke("directory:select") as Promise<string | null>,
  ensureScratchWorkspace: () => ipcRenderer.invoke("directory:ensure-scratch") as Promise<string>,
  loadThreads: () => ipcRenderer.invoke("threads:load") as Promise<PersistedThread[]>,
  saveThreads: (threads: PersistedThread[]) => ipcRenderer.invoke("threads:save", threads) as Promise<void>,
  setSessionStarred: (event: SessionStarredEvent) =>
    ipcRenderer.invoke("session:set-starred", event) as Promise<void>,
  setSessionTitle: (event: SessionTitleEvent) => ipcRenderer.invoke("session:set-title", event) as Promise<void>,
  listSessions: () => ipcRenderer.invoke("session:list") as Promise<string[]>,
  claudeSessionExists: (request: ClaudeSessionExistsRequest) =>
    ipcRenderer.invoke("claude-session:exists", request) as Promise<boolean>,
  latestClaudeSession: (cwd: string) => ipcRenderer.invoke("claude-session:latest", cwd) as Promise<string | null>,
  loadConversation: (request: ConversationLoadRequest) =>
    ipcRenderer.invoke("conversation:load", request) as Promise<ClaudeConversationResult>,
  loadUsage: (provider?: UsageProvider) => ipcRenderer.invoke("usage:load", provider) as Promise<UsageSnapshot | null>,
  loadUsageCost: (query?: UsageCostQuery) => ipcRenderer.invoke("usage:cost", query) as Promise<UsageCostReport>,
  startSession: (request: SessionStartRequest) =>
    ipcRenderer.invoke("session:start", request) as Promise<SessionStartResult>,
  sendInput: (request: SessionInputRequest) => ipcRenderer.invoke("session:input", request) as Promise<SessionInputResult>,
  answerApproval: (answer: SessionApprovalAnswer) =>
    ipcRenderer.invoke("session:answer-approval", answer) as Promise<SessionApprovalResult>,
  resizeSession: (request: SessionResizeRequest) => ipcRenderer.invoke("session:resize", request) as Promise<void>,
  stopSession: (request: SessionStopRequest) => ipcRenderer.invoke("session:stop", request) as Promise<void>,
  startTerminal: (request: TerminalStartRequest) =>
    ipcRenderer.invoke("terminal:start", request) as Promise<TerminalStartResult>,
  terminalInput: (request: SessionInputRequest) => ipcRenderer.invoke("terminal:input", request) as Promise<void>,
  resizeTerminal: (request: SessionResizeRequest) => ipcRenderer.invoke("terminal:resize", request) as Promise<void>,
  stopTerminal: (request: SessionStopRequest) => ipcRenderer.invoke("terminal:stop", request) as Promise<void>,
  listTerminals: () => ipcRenderer.invoke("terminal:list") as Promise<string[]>,
  onTerminalData: (callback: (event: TerminalDataEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent) => callback(payload);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.removeListener("terminal:data", listener);
  },
  onTerminalExit: (callback: (event: TerminalExitEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalExitEvent) => callback(payload);
    ipcRenderer.on("terminal:exit", listener);
    return () => ipcRenderer.removeListener("terminal:exit", listener);
  },
  searchConversations: (request: ConversationSearchRequest) =>
    ipcRenderer.invoke("conversation:search", request) as Promise<ConversationSearchResult[]>,
  loadPreferences: () => ipcRenderer.invoke("app:load-preferences") as Promise<AppPreferences>,
  savePreferences: (preferences: Partial<AppPreferences>) =>
    ipcRenderer.invoke("app:save-preferences", preferences) as Promise<AppPreferences>,
  getRemotePairing: () => ipcRenderer.invoke("remote:get-pairing") as Promise<RemotePairingInfo>,
  refreshRemotePairing: () => ipcRenderer.invoke("remote:refresh-pairing") as Promise<RemotePairingInfo>,
  listRemotePairedDevices: () => ipcRenderer.invoke("remote:list-devices") as Promise<RemotePairedDevice[]>,
  revokeRemotePairedDevice: (mobileId: string) =>
    ipcRenderer.invoke("remote:revoke-device", mobileId) as Promise<RemotePairedDevice[]>,
  onRemotePairingChanged: (callback: (info: RemotePairingInfo) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: RemotePairingInfo) => callback(payload);
    ipcRenderer.on("remote:pairing", listener);
    return () => ipcRenderer.removeListener("remote:pairing", listener);
  },
  onPreferencesChanged: (callback: (preferences: AppPreferences) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AppPreferences) => callback(payload);
    ipcRenderer.on("app:preferences-changed", listener);
    return () => ipcRenderer.removeListener("app:preferences-changed", listener);
  },
  onQuickStart: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("app:quick-start", listener);
    return () => ipcRenderer.removeListener("app:quick-start", listener);
  },
  onSessionData: (callback: (event: SessionDataEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionDataEvent) => callback(payload);
    ipcRenderer.on("session:data", listener);
    return () => ipcRenderer.removeListener("session:data", listener);
  },
  onClaudeSession: (callback: (event: ClaudeSessionEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ClaudeSessionEvent) => callback(payload);
    ipcRenderer.on("session:claude-session", listener);
    return () => ipcRenderer.removeListener("session:claude-session", listener);
  },
  onSessionTitle: (callback: (event: SessionTitleEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionTitleEvent) => callback(payload);
    ipcRenderer.on("session:title", listener);
    return () => ipcRenderer.removeListener("session:title", listener);
  },
  onConversation: (callback: (event: ConversationEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ConversationEvent) => callback(payload);
    ipcRenderer.on("session:conversation", listener);
    return () => ipcRenderer.removeListener("session:conversation", listener);
  },
  onSessionRuntime: (callback: (event: SessionRuntimeEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionRuntimeEvent) => callback(payload);
    ipcRenderer.on("session:runtime", listener);
    return () => ipcRenderer.removeListener("session:runtime", listener);
  },
  onPromptSubmitted: (callback: (event: PromptSubmittedEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PromptSubmittedEvent) => callback(payload);
    ipcRenderer.on("session:prompt-submitted", listener);
    return () => ipcRenderer.removeListener("session:prompt-submitted", listener);
  },
  onSessionStarted: (callback: (event: SessionStartedEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionStartedEvent) => callback(payload);
    ipcRenderer.on("session:started", listener);
    return () => ipcRenderer.removeListener("session:started", listener);
  },
  onSessionStarred: (callback: (event: SessionStarredEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionStarredEvent) => callback(payload);
    ipcRenderer.on("remote:session-starred", listener);
    return () => ipcRenderer.removeListener("remote:session-starred", listener);
  },
  onSessionExit: (callback: (event: SessionExitEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionExitEvent) => callback(payload);
    ipcRenderer.on("session:exit", listener);
    return () => ipcRenderer.removeListener("session:exit", listener);
  },
  btwAsk: (request: BtwAskRequest) => ipcRenderer.invoke("btw:ask", request) as Promise<BtwAskResult>,
  btwClear: (request: BtwClearRequest) => ipcRenderer.invoke("btw:clear", request) as Promise<void>,
  onBtwData: (callback: (event: BtwEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: BtwEvent) => callback(payload);
    ipcRenderer.on("btw:data", listener);
    return () => ipcRenderer.removeListener("btw:data", listener);
  },
  listArtifacts: (request: ArtifactsListRequest) =>
    ipcRenderer.invoke("artifacts:list", request) as Promise<ArtifactRun[]>,
  revealPath: (targetPath: string) => ipcRenderer.invoke("path:reveal", targetPath) as Promise<boolean>,
  loadWorkspaceGit: (request: WorkspaceGitRequest) =>
    ipcRenderer.invoke("git:workspace-status", request) as Promise<WorkspaceGitStatus>,
};

contextBridge.exposeInMainWorld("claudeSections", api);

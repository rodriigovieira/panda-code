import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { WorkspaceBacklog } from "../shared/backlog";
import type { BrowserActivity, BrowserState } from "../shared/browser";
import type { DictationRendererEvent } from "../shared/dictation";
import type { PerfSample, PerfSnapshot } from "../shared/perf";
import type { MachineStats } from "../shared/machine-stats";
import type { WorkspaceSchedule } from "../shared/schedule";
import type {
  AppLogEvent,
  AppPreferences,
  ArtifactRun,
  ArtifactsListRequest,
  BacklogChangedEvent,
  BacklogMutation,
  BacklogMutationResult,
  BrowserAttachRequest,
  BrowserCaptureStageEvent,
  BrowserCaptureStageReadyRequest,
  BrowserNavigateRequest,
  BrowserOpenRequest,
  BrowserReportRequest,
  BrowserResolveNoteRequest,
  BrowserSetNoteHiddenRequest,
  BrowserTabRequest,
  ScheduleChangedEvent,
  ScheduleMutation,
  ScheduleMutationResult,
  BtwAskRequest,
  BtwAskResult,
  BtwClearRequest,
  BtwEvent,
  ConversationExportRequest,
  ConversationExportResult,
  ConversationSearchRequest,
  ConversationSearchResult,
  ClaudeConversationResult,
  CodexModel,
  GroqModel,
  ClaudeSessionExistsRequest,
  ClaudeSessionEvent,
  ConversationLoadRequest,
  ConversationEvent,
  DesktopApi,
  DictationStartRequest,
  EditorTarget,
  OpenInEditorRequest,
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
  SessionHibernatedEvent,
  SessionFileChanges,
  SessionFileChangesRequest,
  SessionInputRequest,
  SessionInputResult,
  SessionResizeRequest,
  SessionArchivedEvent,
  SessionRemotePromptEvent,
  SessionParentEvent,
  SessionStarredEvent,
  SessionStartRequest,
  SessionStartResult,
  SessionStartedEvent,
  SessionStopRequest,
  KillSectionCommandsRequest,
  KillSectionCommandsResult,
  SessionTitleEvent,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalStartRequest,
  TerminalStartResult,
  TextFileContents,
  TextFileRequest,
  TextFileWriteRequest,
  TextFileWriteResult,
  UsageCostQuery,
  UsageCostReport,
  UsageProvider,
  UsageSnapshot,
  WorkspaceGitFetchRequest,
  WorkspaceGitLog,
  WorkspaceGitLogRequest,
  WorkspaceGitRequest,
  WorkspaceGitStatus,
  WorkspaceGitTree,
  WorkspaceGitTreeRequest,
  WorkspaceWorkflowRuns,
  WorkspaceWorkflowRunsRequest,
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
  perfSnapshot: () => ipcRenderer.invoke("perf:snapshot") as Promise<PerfSnapshot>,
  perfReset: () => ipcRenderer.invoke("perf:reset") as Promise<void>,
  reportPerf: (samples: PerfSample[]) => ipcRenderer.invoke("perf:report", samples) as Promise<void>,
  loadThreads: () => ipcRenderer.invoke("threads:load") as Promise<PersistedThread[]>,
  saveThreads: (threads: PersistedThread[]) => ipcRenderer.invoke("threads:save", threads) as Promise<void>,
  setSessionStarred: (event: SessionStarredEvent) =>
    ipcRenderer.invoke("session:set-starred", event) as Promise<void>,
  setSessionArchived: (event: SessionArchivedEvent) =>
    ipcRenderer.invoke("session:set-archived", event) as Promise<void>,
  syncLocalArchivedThreads: (archivedIds: string[]) =>
    ipcRenderer.invoke("session:sync-local-archived", archivedIds) as Promise<void>,
  setSessionParent: (event: SessionParentEvent) =>
    ipcRenderer.invoke("session:set-parent", event) as Promise<void>,
  setSessionTitle: (event: SessionTitleEvent) => ipcRenderer.invoke("session:set-title", event) as Promise<void>,
  setUnsentDraftSessions: (ids: string[]) =>
    ipcRenderer.invoke("session:set-unsent-drafts", ids) as Promise<void>,
  listSessions: () => ipcRenderer.invoke("session:list") as Promise<string[]>,
  claudeSessionExists: (request: ClaudeSessionExistsRequest) =>
    ipcRenderer.invoke("claude-session:exists", request) as Promise<boolean>,
  latestClaudeSession: (cwd: string) => ipcRenderer.invoke("claude-session:latest", cwd) as Promise<string | null>,
  loadConversation: (request: ConversationLoadRequest) =>
    ipcRenderer.invoke("conversation:load", request) as Promise<ClaudeConversationResult>,
  loadUsage: (provider?: UsageProvider, force?: boolean) =>
    ipcRenderer.invoke("usage:load", provider, force) as Promise<UsageSnapshot | null>,
  listCodexModels: () => ipcRenderer.invoke("codex:models") as Promise<CodexModel[]>,
  getGroqApiKeyConfigured: () => ipcRenderer.invoke("groq:key-configured") as Promise<boolean>,
  setGroqApiKey: (apiKey: string) => ipcRenderer.invoke("groq:set-key", apiKey) as Promise<boolean>,
  listGroqModels: () => ipcRenderer.invoke("groq:models") as Promise<GroqModel[]>,
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
  // Browser bridge. Thin by design: main owns the tab list, so these carry
  // arguments one way and state comes back on the `browser:state` broadcast
  // rather than as return values. See `shared/browser.ts` for the model.
  browserState: () => ipcRenderer.invoke("browser:state") as Promise<BrowserState>,
  browserSetActiveThread: (threadId: string) => ipcRenderer.invoke("browser:active-thread", threadId) as Promise<void>,
  browserSetFloating: (on: boolean) => ipcRenderer.invoke("browser:set-floating", on) as Promise<void>,
  browserSetPanelVisible: (request: { threadId: string; visible: boolean }) =>
    ipcRenderer.invoke("browser:panel-visible", request) as Promise<void>,
  browserFocusThread: (threadId: string) => ipcRenderer.invoke("browser:focus-thread", threadId) as Promise<void>,
  onBrowserFocusThread: (callback: (event: { threadId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { threadId: string }) => callback(payload);
    ipcRenderer.on("browser:focus-thread", listener);
    return () => ipcRenderer.removeListener("browser:focus-thread", listener);
  },
  browserOpen: (request: BrowserOpenRequest) => ipcRenderer.invoke("browser:open", request) as Promise<{ ok: boolean; message: string }>,
  browserNavigate: (request: BrowserNavigateRequest) =>
    ipcRenderer.invoke("browser:navigate", request) as Promise<{ ok: boolean; message: string }>,
  browserCloseTab: (request: BrowserTabRequest) => ipcRenderer.invoke("browser:close", request) as Promise<{ ok: boolean; message: string }>,
  browserSelectTab: (request: BrowserTabRequest) => ipcRenderer.invoke("browser:select", request) as Promise<void>,
  browserBack: (request: BrowserTabRequest) => ipcRenderer.invoke("browser:back", request) as Promise<{ ok: boolean; message: string }>,
  browserForward: (request: BrowserTabRequest) =>
    ipcRenderer.invoke("browser:forward", request) as Promise<{ ok: boolean; message: string }>,
  browserReload: (request: BrowserTabRequest) => ipcRenderer.invoke("browser:reload", request) as Promise<{ ok: boolean; message: string }>,
  browserAttach: (request: BrowserAttachRequest) => ipcRenderer.invoke("browser:attach", request) as Promise<void>,
  browserReport: (request: BrowserReportRequest) => ipcRenderer.invoke("browser:report", request) as Promise<void>,
  browserCaptureStageReady: (request: BrowserCaptureStageReadyRequest) =>
    ipcRenderer.invoke("browser:capture-stage-ready", request) as Promise<void>,
  browserSetNoteHidden: (request: BrowserSetNoteHiddenRequest) =>
    ipcRenderer.invoke("browser:set-note-hidden", request) as Promise<boolean>,
  browserResolveNote: (request: BrowserResolveNoteRequest) =>
    ipcRenderer.invoke("browser:resolve-note", request) as Promise<{ ok: boolean; message?: string }>,
  browserActivity: (limit?: number) => ipcRenderer.invoke("browser:activity-list", limit) as Promise<BrowserActivity[]>,
  onBrowserActivity: (callback: (record: BrowserActivity) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: BrowserActivity) => callback(payload);
    ipcRenderer.on("browser:activity", listener);
    return () => ipcRenderer.removeListener("browser:activity", listener);
  },
  onBrowserState: (callback: (state: BrowserState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: BrowserState) => callback(payload);
    ipcRenderer.on("browser:state", listener);
    return () => ipcRenderer.removeListener("browser:state", listener);
  },
  onBrowserReveal: (callback: (event: { threadId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { threadId: string }) => callback(payload);
    ipcRenderer.on("browser:reveal", listener);
    return () => ipcRenderer.removeListener("browser:reveal", listener);
  },
  onBrowserCaptureStage: (callback: (event: BrowserCaptureStageEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: BrowserCaptureStageEvent) => callback(payload);
    ipcRenderer.on("browser:capture-stage", listener);
    return () => ipcRenderer.removeListener("browser:capture-stage", listener);
  },
  onBrowserCaptureRelease: (callback: (event: { requestId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { requestId: string }) => callback(payload);
    ipcRenderer.on("browser:capture-release", listener);
    return () => ipcRenderer.removeListener("browser:capture-release", listener);
  },
  searchConversations: (request: ConversationSearchRequest) =>
    ipcRenderer.invoke("conversation:search", request) as Promise<ConversationSearchResult[]>,
  loadPreferences: () => ipcRenderer.invoke("app:load-preferences") as Promise<AppPreferences>,
  savePreferences: (preferences: Partial<AppPreferences>) =>
    ipcRenderer.invoke("app:save-preferences", preferences) as Promise<AppPreferences>,
  getRemotePairing: () => ipcRenderer.invoke("remote:get-pairing") as Promise<RemotePairingInfo>,
  refreshRemotePairing: () => ipcRenderer.invoke("remote:refresh-pairing") as Promise<RemotePairingInfo>,
  listRemotePairedDevices: () => ipcRenderer.invoke("remote:list-devices") as Promise<RemotePairedDevice[]>,
  setRemoteMobileNotifications: (enabled: boolean) =>
    ipcRenderer.invoke("remote:set-mobile-notifications", enabled) as Promise<RemotePairedDevice[]>,
  setNotificationChannels: (sessionId, patch) => ipcRenderer.invoke("app:set-notification-channels", sessionId, patch),
  getSessionMobileNotifications: (sessionId: string) =>
    ipcRenderer.invoke("remote:get-session-mobile-notifications", sessionId),
  setSessionMobileNotifications: (sessionId: string, subscribed: boolean) =>
    ipcRenderer.invoke("remote:set-session-mobile-notifications", sessionId, subscribed),
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
  onAgentAttention: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload);
    ipcRenderer.on("agent:attention", listener);
    return () => ipcRenderer.removeListener("agent:attention", listener);
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
  onSessionArchived: (callback: (event: SessionArchivedEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionArchivedEvent) => callback(payload);
    ipcRenderer.on("remote:session-archived", listener);
    return () => ipcRenderer.removeListener("remote:session-archived", listener);
  },
  onSessionRemotePrompt: (callback: (event: SessionRemotePromptEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionRemotePromptEvent) => callback(payload);
    ipcRenderer.on("session:remote-prompt", listener);
    return () => ipcRenderer.removeListener("session:remote-prompt", listener);
  },
  onSessionExit: (callback: (event: SessionExitEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionExitEvent) => callback(payload);
    ipcRenderer.on("session:exit", listener);
    return () => ipcRenderer.removeListener("session:exit", listener);
  },
  onSessionHibernated: (callback: (event: SessionHibernatedEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionHibernatedEvent) => callback(payload);
    ipcRenderer.on("session:hibernated", listener);
    return () => ipcRenderer.removeListener("session:hibernated", listener);
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
  fetchWorkspaceGitRemotes: (request: WorkspaceGitFetchRequest) =>
    ipcRenderer.invoke("git:fetch-remotes", request) as Promise<WorkspaceGitStatus>,
  loadWorkspaceGitLog: (request: WorkspaceGitLogRequest) =>
    ipcRenderer.invoke("git:workspace-log", request) as Promise<WorkspaceGitLog>,
  loadWorkspaceWorkflowRuns: (request: WorkspaceWorkflowRunsRequest) =>
    ipcRenderer.invoke("git:workflow-runs", request) as Promise<WorkspaceWorkflowRuns>,
  loadWorkspaceTree: (request: WorkspaceGitTreeRequest) =>
    ipcRenderer.invoke("git:workspace-tree", request) as Promise<WorkspaceGitTree>,
  readTextFile: (request: TextFileRequest) => ipcRenderer.invoke("file:read-text", request) as Promise<TextFileContents>,
  writeTextFile: (request: TextFileWriteRequest) =>
    ipcRenderer.invoke("file:write-text", request) as Promise<TextFileWriteResult>,
  loadSessionFileChanges: (request: SessionFileChangesRequest) =>
    ipcRenderer.invoke("session:file-changes", request) as Promise<SessionFileChanges>,
  loadBacklog: (cwd: string) => ipcRenderer.invoke("backlog:load", cwd) as Promise<WorkspaceBacklog>,
  mutateBacklog: (mutation: BacklogMutation) =>
    ipcRenderer.invoke("backlog:mutate", mutation) as Promise<BacklogMutationResult>,
  onBacklogChanged: (callback: (event: BacklogChangedEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: BacklogChangedEvent) => callback(payload);
    ipcRenderer.on("backlog:changed", listener);
    return () => ipcRenderer.removeListener("backlog:changed", listener);
  },
  loadSchedule: (cwd: string) => ipcRenderer.invoke("schedule:load", cwd) as Promise<WorkspaceSchedule>,
  mutateSchedule: (mutation: ScheduleMutation) =>
    ipcRenderer.invoke("schedule:mutate", mutation) as Promise<ScheduleMutationResult>,
  onScheduleChanged: (callback: (event: ScheduleChangedEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ScheduleChangedEvent) => callback(payload);
    ipcRenderer.on("schedule:changed", listener);
    return () => ipcRenderer.removeListener("schedule:changed", listener);
  },
  loadMachineStats: (force?: boolean) => ipcRenderer.invoke("machine:stats", force) as Promise<MachineStats>,
  killSectionCommands: (request: KillSectionCommandsRequest) =>
    ipcRenderer.invoke("machine:kill-commands", request) as Promise<KillSectionCommandsResult>,
  listEditors: () => ipcRenderer.invoke("editor:list") as Promise<EditorTarget[]>,
  openInEditor: (request: OpenInEditorRequest) => ipcRenderer.invoke("editor:open", request) as Promise<boolean>,
  copyFileToClipboard: (path: string) => ipcRenderer.invoke("clipboard:copy-file", path) as Promise<boolean>,
  showAttachmentContextMenu: (path: string) => ipcRenderer.invoke("attachment:show-context-menu", path) as Promise<boolean>,
  dictationAvailable: () => ipcRenderer.invoke("dictation:available") as Promise<boolean>,
  prepareDictation: () => ipcRenderer.invoke("dictation:prepare") as Promise<void>,
  startDictation: (request: DictationStartRequest) =>
    ipcRenderer.invoke("dictation:start", request) as Promise<boolean>,
  stopDictation: () => ipcRenderer.invoke("dictation:stop") as Promise<void>,
  cancelDictation: () => ipcRenderer.invoke("dictation:cancel") as Promise<void>,
  restartDictation: () => ipcRenderer.invoke("dictation:restart") as Promise<void>,
  onDictation: (callback: (event: DictationRendererEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: DictationRendererEvent) => callback(payload);
    ipcRenderer.on("dictation:event", listener);
    return () => ipcRenderer.removeListener("dictation:event", listener);
  },
};

contextBridge.exposeInMainWorld("claudeSections", api);

export interface AppState {
  [key: string]: any;
  selectedId: string | null;
  /** 当前打开的工作空间（项目）id；为 null 时回到单会话视图。由工作空间窗口读写。 */
  activeWorkspaceId: string | null;
  /** 当前打开的任务 id（工作空间内的任务）；点击任务时设置。 */
  activeWorkspaceTaskId: string | null;
  sessions: any[];
  config: any;
  terminal: any;
  terminalSessionId: string | null;
  terminalOutput: string;
  terminalAutoFollow: boolean;
  currentView: string;
  currentMessages: any[];
  ws: WebSocket | null;
  wsConnected: boolean;
  chatStickToBottom: boolean;
  chatAutoFoldEnabled: boolean;
  chatAutoFoldSnapshot: { userIdx: number; assistantIdx: number } | null;
  chatProgrammaticScrollUntil: number;
  chatUnreadCount: number;
  chatUnreadStartIndex: number;
  chatInitialRenderDone: boolean;
  bootstrapping: boolean;
  loginChecked: boolean;
  isOnline: boolean;
}

interface WandNativeInterface {
  sendNotification(title: string, body: string, tag: string): void;
  setKeepScreenOn(on: boolean): void;
  startKeepAlive(): void;
  stopKeepAlive(): void;
  getPermission(): string;
  requestPermission(): void;
  openNotificationSettings?(): void;
  updateSessionProgress(sessionId: string, data: string): void;
  clearSessionProgress(sessionId: string): void;
  copyToClipboard(text: string): string;
  downloadUpdate(url: string, fileName?: string, source?: string): void;
  getNotificationSound(): string;
  isNotificationSoundEnabled?(): boolean;
  setNotificationSound(sound: string): void;
  setNotificationSoundEnabled?(enabled: boolean): void;
  getNotificationVolume(): number;
  setNotificationVolume(volume: number): void;
  getAvailableSounds(): string;
  previewSound(sound: string): void;
  isHapticEnabled(): boolean;
  setHapticEnabled(enabled: boolean): void;
  switchServer(url?: string): void;
  /** Android 原生壳（新版）：关闭 WebView 回到原生界面。旧版壳没有该方法。 */
  backToNative?(): void;
}

interface XTermLibInterface {
  Terminal: new (options?: any) => any;
  FitAddon: new () => any;
  Unicode11Addon: new () => any;
}

export interface SendError extends Error {
  errorCode?: string;
  httpStatus?: number;
  sessionId?: string;
  sessionStatus?: string;
}

declare global {
  var WandNative: WandNativeInterface;
  var XTermLib: XTermLibInterface;

  interface Window {
    __wandImeNative?: boolean;
    __wandIosNative?: boolean;
    __wandViewportHandlersBound?: boolean;
    showToast?: (msg: string, opts?: any) => void;
    wandAlert?: (msg: string, opts?: any) => void;
    QRCodeLib?: any;
    _onNativePermissionResult?: (result: string) => void;
    __toolGroupToggle?: (el: HTMLElement) => void;
    __historySummaryToggle?: (btn: HTMLElement) => void;
    __queueDelegated?: boolean;
    readonly visualViewport: VisualViewport | null;
  }
}

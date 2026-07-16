export interface AppState {
  [key: string]: any;
  selectedId: string | null;
  sessions: any[];
  config: any;
  terminal: any;
  terminalSessionId: string | null;
  terminalOutput: string;
  terminalOutputMarker: number;
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

export interface WandNativeInterface {
  sendNotification(title: string, body: string, tag: string): void;
  vibrate(pattern?: string): void;
  setKeepScreenOn(on: boolean): void;
  startKeepAlive(): void;
  stopKeepAlive(): void;
  getPermission(): string;
  requestPermission(): void;
  updateSessionProgress(sessionId: string, data: string): void;
  clearSessionProgress(sessionId: string): void;
  copyToClipboard(text: string): string;
  downloadUpdate(url: string, fileName?: string, source?: string): void;
  getAppIcon(): string;
  setAppIcon(name: string): void;
  getNotificationSound(): string;
  setNotificationSound(sound: string): void;
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

export interface WTermInstance {
  cols: number;
  rows: number;
  init?(): Promise<void>;
  write(data: string): void;
  destroy(): void;
  remeasure?(): void;
  resize?(cols: number, rows: number): void;
  onData?(cb: (data: string) => void): void;
  onResize?(cb: (info: { cols: number; rows: number }) => void): void;
}

export interface WTermLibInterface {
  WTerm: new (container: HTMLElement, options: any) => WTermInstance;
}

export interface SendError extends Error {
  errorCode?: string;
  httpStatus?: number;
  sessionId?: string;
  sessionStatus?: string;
}

declare global {
  var WandNative: WandNativeInterface;
  var WTermLib: WTermLibInterface;

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

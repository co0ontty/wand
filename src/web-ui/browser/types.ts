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
  chatUnreadCount: number;
  chatUnreadStartIndex: number;
  chatInitialRenderDone: boolean;
  modalOpen: boolean;
  bootstrapping: boolean;
  loginChecked: boolean;
  isOnline: boolean;
}

/**
 * 主进程 ↔ attach 客户端的控制平面 IPC 协议。
 *
 * 帧格式：单行 JSON，以 `\n` 分割。客户端按行读，服务端按行解析。
 * 不做长度前缀，因为单条 message 受 snapshot 大小限制，远低于 socket 缓冲区。
 */
export {};

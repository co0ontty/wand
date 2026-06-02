/**
 * Attach 模式 TUI：当本机已有 wand 主进程在跑时，新启动的 `wand web` 会进入此模式。
 *
 * 数据来源：通过 wand.sock IPC 拉 snapshot（每秒一次），渲染同一套 layout。
 * 日志面板：因为日志在主进程里，attach 端没法直接看；这里改成"活动流"——
 *   监听 snapshot 差分，把会话起止 / 总数变化打到 log 面板。
 */
import { PidInfo } from "../pidfile.js";
export interface AttachTuiDeps {
    pidInfo: PidInfo;
    configPath: string;
    /** 退出时调用。 */
    onExit: () => void | Promise<void>;
}
export interface AttachTuiHandle {
    stop(): Promise<void>;
}
export declare function startAttachTui(deps: AttachTuiDeps): AttachTuiHandle;

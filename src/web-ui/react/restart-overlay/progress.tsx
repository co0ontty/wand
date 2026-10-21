import { Progress } from "antd";
import * as React from "react";

export interface RestartProgressProps {
  percent: number;
}

/**
 * antd Progress 单独成块：进度条只在重启等待期出现，
 * Progress/rc-progress 的实现不必跟着首屏 runtime 一起下载。
 */
export function RestartProgress({ percent }: RestartProgressProps): React.ReactElement {
  return <Progress
    className="wand-restart-progress"
    percent={percent}
    showInfo={false}
    size="small"
    status="active"
    aria-label="等待服务重启进度"
  />;
}

import { Modal } from "antd";
import type { ComponentProps } from "react";

/**
 * antd Modal 单独成块：对话框只在用户真的打开时才出现，Modal/rc-dialog 的实现
 * 不必跟着首屏 runtime 一起下载。样式随模块一起到达，打开对话框时一并生效。
 */
export function WandDialogModal(props: ComponentProps<typeof Modal>): React.ReactElement {
  return <Modal {...props}/>;
}

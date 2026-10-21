import * as React from "react";
import { Alert, Button, Flex, Form, Input, Spin, Typography } from "antd";
import { WandBrandMark } from "../ui/brand-mark";
import { WandIcon } from "../ui/icons";
import { isWebLoginTicket } from "../../login-credential.js";

/** Credentials remain in the native input, consumed by the existing login handler. */
export function LoginForm({ checking, switchServer, visual, httpHref = "/" }: { checking: boolean; switchServer: boolean; visual?: React.ReactNode; httpHref?: string }): React.ReactElement {
  const [ticketCredential, setTicketCredential] = React.useState(false);
  const [passwordVisible, setPasswordVisible] = React.useState(false);
  return <main className="login-page">
    <div className="login-layout">
      <header className="login-brand"><WandBrandMark style={{ width: 36, height: 36 }}/><span>Wand</span></header>
      <section className="login-left" aria-labelledby="login-title">
        <Typography.Title id="login-title" level={1} className="login-title">你的 AI 工作台。<br/><span>随时接续。</span></Typography.Title>
        <Typography.Paragraph className="login-intro">连接本机的终端、AI 会话与工作区，<br className="login-desktop-break"/>在你需要的地方继续工作。</Typography.Paragraph>
        <div className="left-spacer">{visual}</div>
      </section>
      <section className="login-right" aria-labelledby="login-form-title" aria-busy={checking}>
        <div className="login-form-heading">
          <Typography.Title id="login-form-title" level={2}>{checking ? "正在恢复会话" : "欢迎回来"}</Typography.Title>
          <Typography.Paragraph type="secondary">{checking ? "正在检查本地登录会话，请稍候。" : "继续你的工作。"}</Typography.Paragraph>
        </div>
        {checking ? <div className="login-checking"><Spin aria-label="正在恢复会话"/></div>
          : <form id="login-form" autoComplete="on" noValidate><Flex vertical gap={20}>
            <input name="username" autoComplete="username" value="wand" readOnly tabIndex={-1} aria-hidden="true" style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}/>
            <div>
              <Form.Item label="访问密码" layout="vertical" htmlFor="password" style={{ margin: 0 }}>
                <Input.Password id="password" size="large" placeholder="输入访问密码" autoFocus autoComplete={ticketCredential ? "off" : "current-password"} visibilityToggle={{ visible: !ticketCredential && passwordVisible, onVisibleChange: visible => setPasswordVisible(!ticketCredential && visible) }} onChange={event => setTicketCredential(isWebLoginTicket(event.target.value))} aria-describedby="password-hint login-error" aria-invalid="false"/>
              </Form.Item>
              <Typography.Paragraph id="password-hint" type="secondary" className="login-password-hint">凭据只发送到本机 Wand 服务，不会保存在此页面。</Typography.Paragraph>
              <div className="login-feedback" aria-live="polite"><Typography.Paragraph id="login-error" type="danger" className="hidden" role="alert"/></div>
            </div>
            <Button id="login-button" type="primary" size="large" htmlType="button" block>进入控制台</Button>
            {switchServer && <Button id="login-switch-server-button" type="text" size="large" block>切换服务器</Button>}
            <Alert id="login-cert-hint" className="hidden" type="warning" showIcon title="证书不受信任，登录态无法保存"
              description={<><p>浏览器拒绝保存登录 Cookie。请改用 HTTP，或将本服务证书设为受信任后重试。</p>
                <Button id="login-cert-http-link" href={httpHref} rel="noopener">改用 HTTP 访问</Button></>}/>
          </Flex></form>}
      </section>
    </div>
  </main>;
}

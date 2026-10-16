import * as React from "react";
import { Alert, Button, Flex, Form, Input, Segmented, Spin, Typography } from "antd";
import type { InputRef } from "antd";
import { WandBrandMark, WandIcon } from "../ui";
import { clearLoginCredential } from "../../login-credential.js";

/** Credentials remain in the native input, consumed by the existing login handler. */
export function LoginForm({ checking, switchServer, visual, httpHref = "/", serverLabel }: { checking: boolean; switchServer: boolean; visual?: React.ReactNode; httpHref?: string; serverLabel?: string }): React.ReactElement {
  const [ticketMode, setTicketMode] = React.useState(false);
  const credential = React.useRef<InputRef>(null);
  return <main className="login-page">
    <div className="login-layout">
      <header className="login-brand"><WandBrandMark style={{ width: 36, height: 36 }}/><span>Wand</span></header>
      <section className="login-left" aria-labelledby="login-title">
        <Typography.Title id="login-title" level={1} className="login-title">你的 AI 工作台。<br/><span>随时接续。</span></Typography.Title>
        <Typography.Paragraph className="login-intro">连接本机的终端、AI 会话与工作区，<br className="login-desktop-break"/>在你需要的地方继续工作。</Typography.Paragraph>
        <div className="left-spacer">{visual}</div>
        <Typography.Text type="secondary" className="login-capabilities">终端 · AI 会话 · 工作区</Typography.Text>
      </section>
      <section className="login-right" aria-labelledby="login-form-title" aria-busy={checking}>
        <div className="login-form-heading">
          <Typography.Title id="login-form-title" level={2}>{checking ? "正在恢复会话" : "欢迎回来"}</Typography.Title>
          <Typography.Paragraph type="secondary">{checking ? "正在检查本地登录会话，请稍候。" : "使用访问密码或本机 CLI 一次性票据继续。"}</Typography.Paragraph>
        </div>
        {serverLabel && <Flex className="login-server" align="center" gap={12}>
          <WandIcon name="server" size={18}/><div><Typography.Text type="secondary">当前服务</Typography.Text><div className="login-server-address" title={serverLabel}>{serverLabel}</div></div>
        </Flex>}
        {checking ? <div className="login-checking"><Spin aria-label="正在恢复会话"/></div>
          : <form id="login-form" autoComplete="on" noValidate><Flex vertical gap={20}>
            <input name="username" autoComplete="username" value="wand" readOnly tabIndex={-1} aria-hidden="true" style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}/>
            <Segmented block aria-label="登录方式" options={[{ label: "访问密码", value: false }, { label: "一次性票据", value: true }]} value={ticketMode} onChange={value => {
              if (credential.current?.input) clearLoginCredential(credential.current.input);
              setTicketMode(Boolean(value));
            }}/>
            <div>
              <Form.Item label={ticketMode ? "一次性票据" : "访问密码"} layout="vertical" htmlFor="password" style={{ margin: 0 }}>
                <Input.Password ref={credential} id="password" data-login-kind={ticketMode ? "ticket" : "password"} size="large" placeholder={ticketMode ? "输入本机 CLI 签发的票据" : "输入访问密码"} autoComplete={ticketMode ? "off" : "current-password"} visibilityToggle={!ticketMode} aria-describedby="password-hint login-error" aria-invalid="false"/>
              </Form.Item>
              <Typography.Paragraph id="password-hint" type="secondary" className="login-password-hint">{ticketMode ? "60 秒单次有效；仅查看本员工当前会话。" : "密码由当前服务验证，不会保存在此页面。"}</Typography.Paragraph>
              <div className="login-feedback" aria-live="polite"><Typography.Paragraph id="login-error" type="danger" className="hidden" role="alert"/></div>
            </div>
            <Button id="login-button" type="primary" size="large" htmlType="button" block>进入控制台</Button>
            {switchServer && <Button id="login-switch-server-button" type="text" size="large" block>切换服务器</Button>}
            <Alert id="login-cert-hint" className="hidden" type="warning" showIcon title="证书不受信任，登录态无法保存"
              description={<><p>浏览器拒绝保存登录 Cookie。请改用 HTTP，或将本服务证书设为受信任后重试。</p>
                <Button id="login-cert-http-link" href={httpHref} rel="noopener">改用 HTTP 访问</Button></>}/>
          </Flex></form>}
        <Flex className="login-privacy" align="center" gap={7}><WandIcon name="lock" size={14}/><Typography.Text type="secondary">凭据只发送到当前 Wand 服务</Typography.Text></Flex>
      </section>
    </div>
  </main>;
}

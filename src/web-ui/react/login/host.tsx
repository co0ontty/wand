import * as React from "react";
import { Alert, Button, Card, Flex, Form, Input, Spin, Typography } from "antd";
import { WandBrandMark, WandIcon } from "../ui";

/** Credentials remain in the native input, consumed by the existing login handler. */
export function LoginForm({ checking, switchServer, visual, httpHref = "/" }: { checking: boolean; switchServer: boolean; visual?: React.ReactNode; httpHref?: string }): React.ReactElement {
  return <Flex className="login-page" align="center" justify="center" wrap gap={48} style={{ alignContent: "center" }}>
    <Flex vertical gap="middle" className="login-left" style={{ width: "min(560px, 100%)" }}>
      <Flex align="center" gap="middle"><WandBrandMark style={{ width: 40, height: 40 }}/><Typography.Title level={2} style={{ margin: 0 }}>Wand</Typography.Title></Flex>
      <Typography.Paragraph style={{ margin: 0 }}>连接到本机终端、会话和工作区。</Typography.Paragraph>
      <div className="left-spacer">{visual}</div>
      <Flex align="center" gap={6}><WandIcon name="lock" size={14}/><Typography.Text type="secondary">凭据只发送到当前 Wand 服务</Typography.Text></Flex>
    </Flex>
    <Card className="login-right" style={{ width: "min(380px, 100%)" }}>
      {checking ? <Flex vertical gap="middle" align="center"><Typography.Title level={2}>正在恢复会话</Typography.Title>
        <Spin aria-label="正在恢复会话"/><Typography.Paragraph>正在检查本地登录会话，请稍候。</Typography.Paragraph></Flex>
        : <form id="login-form" autoComplete="on" noValidate><Flex vertical gap="middle">
          <input name="username" autoComplete="username" value="wand" readOnly tabIndex={-1} aria-hidden="true" style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}/>
          <Typography.Title level={2} style={{ margin: 0 }}>欢迎回来</Typography.Title>
          <Typography.Paragraph style={{ margin: 0 }}>使用当前 Wand 服务的访问密码继续。</Typography.Paragraph>
          <Form.Item label="访问密码" layout="vertical" htmlFor="password" style={{ margin: 0 }}>
            <Input.Password id="password" placeholder="输入访问密码" autoComplete="current-password" aria-describedby="password-hint login-error" aria-invalid="false"/>
          </Form.Item>
          <Typography.Text id="password-hint" type="secondary">密码由当前服务验证，不会保存在此页面。</Typography.Text>
          <Typography.Paragraph id="login-error" type="danger" className="hidden" role="alert"/>
          <Alert id="login-cert-hint" className="hidden" type="warning" showIcon title="证书不受信任，登录态无法保存"
            description={<><p>浏览器拒绝保存登录 Cookie。请改用 HTTP，或将本服务证书设为受信任后重试。</p>
              <Button id="login-cert-http-link" href={httpHref} rel="noopener">改用 HTTP 访问</Button></>}/>
          <Button id="login-button" type="primary" htmlType="button" block>进入控制台</Button>
          {switchServer && <Button id="login-switch-server-button" type="text">切换服务器</Button>}
        </Flex></form>}
    </Card>
  </Flex>;
}

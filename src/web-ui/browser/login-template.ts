/**
 * 匿名登录页的 HTML 模板（原生实现，不依赖 React/AntD）。
 *
 * 单独成文件是为了让测试能直接断言标记，而不用加载登录入口的浏览器副作用。
 * 结构与 React 版 `src/web-ui/react/login/host.tsx` 保持一致：左侧品牌与插画，
 * 右侧密码表单。单机部署没有第二个服务可指，因此不再展示服务地址。
 */
export function renderLoginPageMarkup(brand: string, visual: string): string {
  return `<main class="login-page">
  <div class="login-layout">
    <header class="login-brand">${brand}<span>Wand</span></header>
    <section class="login-left" aria-labelledby="login-title">
      <h1 id="login-title" class="login-title">你的 AI 工作台。<br/><span>随时接续。</span></h1>
      <p class="login-intro">连接本机的终端、AI 会话与工作区，<br class="login-desktop-break"/>在你需要的地方继续工作。</p>
      <div class="left-spacer">${visual}</div>
    </section>
    <section class="login-right" aria-labelledby="login-form-title">
      <div class="login-form-heading">
        <h2 id="login-form-title">欢迎回来</h2>
        <p>继续你的工作。</p>
      </div>
      <form id="login-form" autocomplete="on" novalidate>
        <div>
          <label for="password">访问密码</label>
          <input id="password" type="password" size="large" autocomplete="current-password" autofocus
            placeholder="输入访问密码" aria-describedby="password-hint login-error"/>
          <p id="password-hint" class="login-password-hint">凭据只发送到本机 Wand 服务，不会保存在此页面。</p>
          <div class="login-feedback" aria-live="polite"><p id="login-error" class="hidden" role="alert"></p></div>
        </div>
        <button id="login-button" type="button" class="login-submit">进入控制台</button>
        <div id="login-cert-hint" class="hidden" role="alert">
          <p><strong>证书不受信任，登录态无法保存</strong></p>
          <p>浏览器拒绝保存登录 Cookie。请改用 HTTP，或将本服务证书设为受信任后重试。</p>
          <a id="login-cert-http-link" href="/" rel="noopener">改用 HTTP 访问</a>
        </div>
      </form>
    </section>
  </div>
</main>`;
}

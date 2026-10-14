import * as React from "react";
import { Alert, Flex, Spin } from "antd";
import { WandButton, WandDialogSurface } from "./ui";

interface FeatureStore<S> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): S;
}

/** Controllers stay eager; a view is fetched only on first use, then stays mounted
 * to preserve its existing draft/scroll lifecycle. React and stores are shared by ESM. */
export function deferredFeature<P extends object, S>(
  load: () => Promise<React.ComponentType<P>>,
  store: FeatureStore<S>,
  active: (snapshot: S, props: P) => boolean,
  options: { title: string; close(): void; page?: boolean; inline?: boolean; dismissable?: (props: P) => boolean;
    renderPending?: (status: React.ReactElement, props: P) => React.ReactElement },
): React.ComponentType<P> {
  let loaded: React.ComponentType<P> | null = null;
  let pending: Promise<React.ComponentType<P>> | null = null;
  function download() {
    if (loaded) return Promise.resolve(loaded);
    if (!pending) pending = load().then(component => {
      loaded = component;
      return component;
    }).catch((error: unknown) => { pending = null; throw error; });
    return pending;
  }
  return function DeferredFeature(props: P) {
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const enabled = active(snapshot, props);
    const dismissable = options.dismissable?.(props) !== false;
    const [Component, setComponent] = React.useState<React.ComponentType<P> | null>(() => loaded);
    const [error, setError] = React.useState("");
    const [attempt, setAttempt] = React.useState(0);
    const activated = React.useRef(false);
    if (enabled) activated.current = true;
    React.useEffect(() => {
      if (!enabled || Component) return;
      let alive = true;
      download().then(next => { if (alive) setComponent(() => next); }, () => {
        if (alive) setError("资源加载失败，请检查网络；服务更新后可能需要重新加载页面。");
      });
      return () => { alive = false; };
    }, [enabled, Component, attempt]);
    React.useEffect(() => {
      if (!enabled || Component || !options.page || !dismissable) return;
      const onKey = (event: KeyboardEvent) => {
        if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
        event.preventDefault();
        options.close();
      };
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, [enabled, Component, dismissable]);
    if (Component && activated.current) return <Component {...props}/>;
    if (!enabled) return null;
    const status = <Flex vertical gap="small" aria-busy={!error}>
      {error ? <>
        <Alert type="error" showIcon title={error}/>
        <Flex gap="small">
          <WandButton onClick={() => { setError(""); setAttempt(value => value + 1); }}>重试</WandButton>
          <WandButton onClick={() => window.location.reload()}>重新加载页面</WandButton>
        </Flex>
      </> : <Flex align="center" gap="small" role="status"><Spin/>正在加载{options.title}…</Flex>}
    </Flex>;
    if (options.renderPending) return options.renderPending(status, props);
    if (options.inline) return status;
    if (!options.page) return <WandDialogSurface open title={options.title}
      onOpenChange={open => { if (!open) options.close(); }}>{status}</WandDialogSurface>;
    return <Flex vertical gap="middle" component="section" aria-label={options.title}
      style={{ position: "absolute", inset: 0, zIndex: 8, background: "var(--bg-primary)", padding: "var(--wand-page-inset)", overflow: "auto" }}>
      <Flex align="center" gap="small">{dismissable ? <WandButton kind="soft" onClick={options.close}>返回</WandButton> : null}<h1>{options.title}</h1></Flex>
      {status}
    </Flex>;
  };
}

const componentStore = { subscribe: () => () => {}, getSnapshot: () => null };

/** Embedded views keep their existing parent surface/Portal and close protocol. */
export function deferredComponent<P extends object>(
  load: () => Promise<React.ComponentType<P>>,
  options: { title: string; renderPending?: (status: React.ReactElement, props: P) => React.ReactElement },
): React.ComponentType<P & { enabled?: boolean }> {
  return deferredFeature<P & { enabled?: boolean }, null>(
    () => load().then(Component => function LoadedComponent({ enabled: _enabled, ...props }) {
      return <Component {...props as P}/>;
    }), componentStore, (_snapshot, props) => props.enabled !== false,
    { ...options, inline: true, close: () => {} },
  );
}

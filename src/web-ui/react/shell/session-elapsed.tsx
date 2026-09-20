import * as React from "react";
import { formatElapsedShort } from "../../session-activity";

/** Mounted only while responding; a session key prevents sharing another turn's clock. */
export function SessionElapsed(): React.ReactElement {
  const [startedAt] = React.useState(() => Date.now());
  const [elapsed, setElapsed] = React.useState(0);
  React.useEffect(() => {
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <span className="session-status-elapsed">{formatElapsedShort(elapsed)}</span>;
}

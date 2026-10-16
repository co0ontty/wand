import * as React from "react";
import { createRoot } from "react-dom/client";
import { WandUiProvider } from "../../src/web-ui/react/theme";
import { installReactUiStyles } from "../../src/web-ui/react/styles";
import { ConversationNavigation } from "../../src/web-ui/react/conversations/sidebar";
import { ScheduledTasksPage } from "../../src/web-ui/react/scheduled-tasks/page";
import { installTaskBoardHistory, taskBoardController, taskBoardStore } from "../../src/web-ui/react/issues/task-board-controller";
installReactUiStyles(); installTaskBoardHistory();
(window as any).openedScheduledSessions = [];
function App() {
  const state = React.useSyncExternalStore(taskBoardStore.subscribe, taskBoardStore.getSnapshot);
  return <WandUiProvider><div className="fixture-shell"><ConversationNavigation activePage={state.page === "calendar" ? "calendar" : "schedules"} teamAttention={0} onNavigate={page => {
    if (page === "calendar" || page === "schedules") taskBoardController.open("", "", page);
  }}/><main><ScheduledTasksPage visible={state.open} view={state.page === "calendar" ? "calendar" : "list"} calendarMode={state.calendarRange}
    onCalendarModeChange={mode => taskBoardController.calendarRange(mode)} onBack={() => taskBoardController.close()}
    onOpenSession={id => (window as any).openedScheduledSessions.push(id)}/></main></div></WandUiProvider>;
}
createRoot(document.getElementById("root")!).render(<App/>);

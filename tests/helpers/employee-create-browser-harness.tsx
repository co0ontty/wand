// Development-only component harness: real EmployeeCreateForm in headless Chrome.
// Verifies the default single-input flow, the collapsible 高级配置, and in-place geometry.
import * as React from "react";
import { createRoot } from "react-dom/client";
import { EmployeeCreateForm } from "../../src/web-ui/react/agents/employee-create-form";
import { aiTeamsChunkStyles } from "../../src/web-ui/react/ai-teams/styles";
import { installReactUiStyles, installStyleSheet } from "../../src/web-ui/react/styles";

installReactUiStyles();
installStyleSheet("harness-employee-styles", aiTeamsChunkStyles);

const DRAFT = {
  name: "接口守夜人",
  duty: "守护线上接口稳定",
  prompt: "你是值守接口的工程师。",
  agent: { provider: "claude", model: "default", thinkingEffort: "off", mode: "default", kind: "structured" },
};

interface HarnessState {
  draftRequests: unknown[];
  createRequests: unknown[];
  saved: unknown[];
  cancelled: boolean;
}

const state: HarnessState = { draftRequests: [], createRequests: [], saved: [], cancelled: false };
(window as unknown as { employeeHarness: HarnessState }).employeeHarness = state;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.includes("/api/silicon-employees/draft")) {
    state.draftRequests.push(JSON.parse(String(init?.body ?? "{}")));
    return json({ draft: DRAFT });
  }
  if (url.includes("/api/silicon-employees")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    state.createRequests.push(body);
    return json({ ...body, id: "e_new", createdAt: "", updatedAt: "" }, 201);
  }
  return realFetch(input, init);
};

function Harness(): React.ReactElement {
  const [saves, setSaves] = React.useState(0);
  return (
    <div className="wand-employee-list" style={{ maxWidth: 720, margin: "24px auto", padding: 16 }}>
      <EmployeeCreateForm
        catalog={null}
        providerOptions={null}
        onSave={async (draft) => {
          state.saved.push(draft);
          setSaves((value) => value + 1);
        }}
        onCancel={() => {
          state.cancelled = true;
        }}
      />
      <p id="save-count">{saves}</p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);

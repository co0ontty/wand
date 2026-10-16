import { installStyleSheet } from "../styles.js";

/** Feature geometry only; fields, disclosure, switches, checkboxes and feedback remain Ant-owned. */
export function installEmployeeImStyles(): void {
  installStyleSheet("wand-employee-im", String.raw`
.employee-im{container:employee-im / inline-size;border-top:1px solid var(--border-subtle);padding-top:24px}
.employee-im-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}
.employee-im-heading h3{margin:0;font-size:16px;font-weight:600}
.employee-im-heading .employee-im-actions{display:flex;align-items:center;gap:8px;flex:none}
.employee-im-intro,.employee-im-footnote{color:var(--text-secondary);font-size:12px;line-height:1.6;margin:8px 0 16px}
.employee-im-subheading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:24px 0 8px}
.employee-im-subheading h4{font-size:13px;font-weight:600;margin:0}
.employee-im-summary{font-size:12px;color:var(--text-secondary);overflow-wrap:anywhere}
.employee-im-channels{border-bottom:1px solid var(--border-subtle)}
.employee-im-channel-label{display:flex;flex-direction:column;gap:4px;min-width:0}
.employee-im-channel-label strong{font-weight:500;font-size:14px}
.employee-im-channel-label small{display:block;font-size:12px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.employee-im-channel-body{display:flex;flex-direction:column;gap:16px;padding-bottom:8px}
.employee-im-credential-hint{font-size:12px;color:var(--text-secondary);margin:0;line-height:1.6}
.employee-im-test-row{display:flex;align-items:center;flex-wrap:wrap;gap:12px}
.employee-im-test-row>span{font-size:12px;color:var(--text-secondary)}
.employee-im-events{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.employee-im-event-groups{display:flex;flex-direction:column;gap:16px}
.employee-im-events fieldset{border:0;padding:0;margin:0;min-width:0}
.employee-im-events legend{color:var(--text-secondary);font-size:12px;padding:0;margin-bottom:4px}
.employee-im-events .wand-settings-library-grid{row-gap:0}
.employee-im-events .ant-checkbox-wrapper{display:flex;align-items:center;min-height:44px;margin:0}
.employee-im-events .ant-checkbox{flex:none}
.employee-im-empty{margin:8px 0;color:var(--text-secondary);font-size:12px}
@container employee-im (max-width:380px){.employee-im-heading{gap:8px}.employee-im-heading .employee-im-actions{gap:4px}.employee-im-intro{max-width:32em}}
`);
}

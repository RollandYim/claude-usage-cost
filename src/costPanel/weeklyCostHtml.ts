import type {
  WeeklyCostReport,
  WeeklyCostRow,
  WeeklyCostModelRow,
  WeeklyCostTotals,
  WeeklyCostGroup,
} from './weeklyCostReportBuilder';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function formatUSD(n: number): string {
  return `$${n.toFixed(2)}`;
}

function renderModelSubrow(mr: WeeklyCostModelRow): string {
  const dash = '&mdash;';
  const input = mr.tokensBreakdownKnown ? formatInt(mr.inputTokens) : dash;
  const output = mr.tokensBreakdownKnown ? formatInt(mr.outputTokens) : dash;
  const cc = mr.tokensBreakdownKnown ? formatInt(mr.cacheCreationTokens) : dash;
  const cr = mr.tokensBreakdownKnown ? formatInt(mr.cacheReadTokens) : dash;
  return (
    `<tr class="model">` +
    `<td class="date model-label">` +
    `<span class="model-indent">└</span>` +
    `<span class="model-name" title="${escapeHtml(mr.model)}">${escapeHtml(mr.shortLabel)}</span>` +
    `</td>` +
    `<td class="num">${input}</td>` +
    `<td class="num">${output}</td>` +
    `<td class="num">${cc}</td>` +
    `<td class="num">${cr}</td>` +
    `<td class="num">${formatInt(mr.totalTokens)}</td>` +
    `<td class="num">${formatUSD(mr.costUSD)}</td>` +
    `</tr>`
  );
}

function renderRow(row: WeeklyCostRow): string {
  const dayTr =
    `<tr class="day">` +
    `<td class="date">${escapeHtml(row.dateLocal)}</td>` +
    `<td class="num">${formatInt(row.inputTokens)}</td>` +
    `<td class="num">${formatInt(row.outputTokens)}</td>` +
    `<td class="num">${formatInt(row.cacheCreationTokens)}</td>` +
    `<td class="num">${formatInt(row.cacheReadTokens)}</td>` +
    `<td class="num">${formatInt(row.totalTokens)}</td>` +
    `<td class="num">${formatUSD(row.costUSD)}</td>` +
    `</tr>`;
  const modelTrs = row.byModel.map(renderModelSubrow).join('');
  return dayTr + modelTrs;
}

function renderTotalsRow(label: string, totals: WeeklyCostTotals, cls: string): string {
  return (
    `<tr class="${cls}">` +
    `<td class="date">${escapeHtml(label)}</td>` +
    `<td class="num">${formatInt(totals.inputTokens)}</td>` +
    `<td class="num">${formatInt(totals.outputTokens)}</td>` +
    `<td class="num">${formatInt(totals.cacheCreationTokens)}</td>` +
    `<td class="num">${formatInt(totals.cacheReadTokens)}</td>` +
    `<td class="num">${formatInt(totals.totalTokens)}</td>` +
    `<td class="num">${formatUSD(totals.costUSD)}</td>` +
    `</tr>`
  );
}

function renderGroup(group: WeeklyCostGroup, showTitle: boolean): string {
  const titleHtml = showTitle
    ? `<h2 class="group-title">${escapeHtml(group.label)}</h2>`
    : '';
  const rowsHtml = group.rows.map(renderRow).join('');
  const emptyNotice = group.rows.length === 0
    ? `<tr class="empty"><td colspan="7">No usage recorded.</td></tr>`
    : '';
  return `${titleHtml}<table>
    <thead>
      <tr>
        <th>Date</th>
        <th class="num">Input</th>
        <th class="num">Output</th>
        <th class="num">Cache Create</th>
        <th class="num">Cache Read</th>
        <th class="num">Total Tokens</th>
        <th class="num">Cost (USD)</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}${emptyNotice}
    </tbody>
    <tfoot>
      ${renderTotalsRow('Total', group.totals, 'total')}
    </tfoot>
  </table>`;
}

/**
 * Produces the full HTML document displayed by {@link WeeklyCostPanel}.
 *
 * No scripts are emitted; CSP forbids `script-src` entirely. All strings that
 * derive from external data (account email, dates) are HTML-escaped.
 */
export function renderWeeklyCostHtml(
  report: WeeklyCostReport,
  cspSource: string,
  nonce: string,
): string {
  const csp =
    `default-src 'none'; ` +
    `style-src 'unsafe-inline'; ` +
    `font-src ${cspSource}; ` +
    `img-src ${cspSource} data:;`;

  const emailLabel =
    report.accountEmail === null ? 'unknown' : escapeHtml(report.accountEmail);
  const generatedAtLabel = escapeHtml(
    new Date(report.generatedAt).toLocaleString(),
  );

  const notice = report.scanFailed
    ? `<p class="notice">Historical scan failed; showing only dates this extension tracked locally.</p>`
    : '';

  const rangeLabel = escapeHtml(report.rangeLabel);
  const showGroupTitles = report.mode === 'all' || report.groups.length > 1;

  let tablesHtml: string;
  if (report.groups.length === 0) {
    tablesHtml =
      `<p class="empty-msg">No usage recorded for the current account.</p>`;
  } else {
    tablesHtml = report.groups.map((g) => renderGroup(g, showGroupTitles)).join('');
  }

  const grandTotalHtml =
    report.groups.length > 1
      ? `<table class="grand-total-table">
    <tfoot>
      ${renderTotalsRow('Grand Total', report.grandTotals, 'grand-total')}
    </tfoot>
  </table>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="nonce" content="${escapeHtml(nonce)}">
  <title>Claude Weekly Cost</title>
  <style>
    body {
      font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      padding: 16px 20px;
      margin: 0;
    }
    header { margin-bottom: 12px; }
    h1 {
      font-size: 1.1em;
      margin: 0 0 4px 0;
      font-weight: 600;
    }
    h2.group-title {
      font-size: 0.95em;
      font-weight: 600;
      margin: 18px 0 6px 0;
      color: var(--vscode-foreground);
    }
    .meta {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
    }
    .range {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      margin-top: 2px;
    }
    .notice {
      background: var(--vscode-inputValidation-warningBackground, #6b5900);
      color: var(--vscode-inputValidation-warningForeground, #fff);
      padding: 6px 8px;
      border-left: 3px solid var(--vscode-inputValidation-warningBorder, #d6b100);
      margin: 8px 0;
      font-size: 0.85em;
    }
    .empty-msg {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      font-variant-numeric: tabular-nums;
      margin-bottom: 4px;
    }
    thead th {
      text-align: left;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      font-weight: 600;
    }
    tbody td, tfoot td {
      padding: 4px 10px;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
    }
    th.num, td.num { text-align: right; }
    td.date { white-space: nowrap; }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    tbody tr.empty td {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      text-align: center;
    }
    /* Per-model breakdown sub-rows. */
    tbody tr.model td {
      color: var(--vscode-descriptionForeground);
      font-size: 0.88em;
      border-bottom: 1px dashed var(--vscode-panel-border, #333);
      padding-top: 2px;
      padding-bottom: 2px;
    }
    tbody tr.model td.model-label {
      padding-left: 18px;
    }
    tbody tr.model .model-indent {
      display: inline-block;
      width: 1.2em;
      color: var(--vscode-descriptionForeground);
      opacity: 0.7;
    }
    tbody tr.model .model-name {
      font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
    }
    /* Give the day row a slightly heavier divider than the model rows under it. */
    tbody tr.day td {
      border-bottom: 1px solid var(--vscode-panel-border, #444);
    }
    tfoot tr.total td {
      font-weight: 700;
      border-top: 2px solid var(--vscode-panel-border, #666);
      border-bottom: none;
      padding-top: 6px;
    }
    table.grand-total-table {
      margin-top: 12px;
    }
    tfoot tr.grand-total td {
      font-weight: 700;
      border-top: 2px solid var(--vscode-focusBorder, var(--vscode-panel-border, #888));
      border-bottom: none;
      padding-top: 6px;
    }
  </style>
</head>
<body>
  <header>
    <h1>Claude Weekly Cost</h1>
    <div class="meta">Account: ${emailLabel} &middot; Generated ${generatedAtLabel}</div>
    <div class="range">Window: ${rangeLabel}</div>
  </header>
  ${notice}
  ${tablesHtml}
  ${grandTotalHtml}
</body>
</html>`;
}

/** Returns a 32-hex-char nonce. Not cryptographically strong; kept simple because CSP forbids script-src entirely. */
export function makeNonce(): string {
  let s = '';
  const chars = 'abcdef0123456789';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

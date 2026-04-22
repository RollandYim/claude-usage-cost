import { describe, it, expect } from 'vitest';
import { renderWeeklyCostHtml, makeNonce } from '../src/costPanel/weeklyCostHtml';
import type {
  WeeklyCostReport,
  WeeklyCostRow,
  WeeklyCostGroup,
  WeeklyCostTotals,
} from '../src/costPanel/weeklyCostReportBuilder';

function mkRow(date: string, i: number, o: number, cost: number): WeeklyCostRow {
  return {
    dateLocal: date,
    inputTokens: i,
    outputTokens: o,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: i + o,
    costUSD: cost,
    byModel: [],
  };
}

function sumRows(rows: WeeklyCostRow[]): WeeklyCostTotals {
  const t: WeeklyCostTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUSD: 0,
  };
  for (const r of rows) {
    t.inputTokens += r.inputTokens;
    t.outputTokens += r.outputTokens;
    t.cacheCreationTokens += r.cacheCreationTokens;
    t.cacheReadTokens += r.cacheReadTokens;
    t.totalTokens += r.totalTokens;
    t.costUSD += r.costUSD;
  }
  return t;
}

function mkGroup(label: string, rows: WeeklyCostRow[]): WeeklyCostGroup {
  return { label, rows, totals: sumRows(rows) };
}

function buildReport(overrides: Partial<WeeklyCostReport> = {}): WeeklyCostReport {
  // Default: range mode, last 7 days newest-first.
  const rows = [
    mkRow('2026-04-21', 16, 26, 0.07),
    mkRow('2026-04-20', 15, 25, 0.06),
    mkRow('2026-04-19', 14, 24, 0.05),
    mkRow('2026-04-18', 13, 23, 0.04),
    mkRow('2026-04-17', 12, 22, 0.03),
    mkRow('2026-04-16', 11, 21, 0.02),
    mkRow('2026-04-15', 10, 20, 0.01),
  ];
  const group = mkGroup('Last 7 days', rows);
  return {
    groups: [group],
    grandTotals: group.totals,
    accountUuid: 'acc-1',
    accountEmail: 'user@example.com',
    generatedAt: Date.UTC(2026, 3, 21, 12, 0, 0),
    scanFailed: false,
    mode: 'range',
    rangeLabel: 'Last 7 days',
    ...overrides,
  };
}

describe('renderWeeklyCostHtml — range mode', () => {
  it('emits one row per date in the report', () => {
    const html = renderWeeklyCostHtml(buildReport(), 'vscode-resource:', 'n1');
    for (const d of [
      '2026-04-15',
      '2026-04-16',
      '2026-04-17',
      '2026-04-18',
      '2026-04-19',
      '2026-04-20',
      '2026-04-21',
    ]) {
      expect(html).toContain(d);
    }
  });

  it('renders dates newest-first in the table body', () => {
    const html = renderWeeklyCostHtml(buildReport(), 'vscode-resource:', 'n1');
    const i21 = html.indexOf('2026-04-21');
    const i15 = html.indexOf('2026-04-15');
    expect(i21).toBeGreaterThanOrEqual(0);
    expect(i15).toBeGreaterThan(i21);
  });

  it('renders per-model sub-rows when `byModel` is populated, sorted descending by cost', () => {
    const row: WeeklyCostRow = {
      dateLocal: '2026-04-21',
      inputTokens: 300,
      outputTokens: 200,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 500,
      costUSD: 12.5,
      byModel: [
        {
          model: 'claude-opus-4-7',
          shortLabel: 'opus-4.7',
          inputTokens: 100,
          outputTokens: 100,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 200,
          costUSD: 10,
          tokensBreakdownKnown: true,
        },
        {
          model: 'claude-sonnet-4-6',
          shortLabel: 'sonnet-4.6',
          inputTokens: 200,
          outputTokens: 100,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 300,
          costUSD: 2.5,
          tokensBreakdownKnown: true,
        },
      ],
    };
    const report = buildReport({
      groups: [
        {
          label: 'Last 1 day',
          rows: [row],
          totals: {
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cacheCreationTokens: row.cacheCreationTokens,
            cacheReadTokens: row.cacheReadTokens,
            totalTokens: row.totalTokens,
            costUSD: row.costUSD,
          },
        },
      ],
      grandTotals: {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheCreationTokens: row.cacheCreationTokens,
        cacheReadTokens: row.cacheReadTokens,
        totalTokens: row.totalTokens,
        costUSD: row.costUSD,
      },
      rangeLabel: 'Last 1 day',
    });
    const html = renderWeeklyCostHtml(report, 'vscode-resource:', 'n1');

    // Both sub-rows should appear.
    expect(html).toContain('class="model"');
    expect(html).toContain('>opus-4.7<');
    expect(html).toContain('>sonnet-4.6<');
    // Full canonical name should appear in the `title` tooltip.
    expect(html).toContain('title="claude-opus-4-7"');
    // Highest-cost model is rendered before the lower-cost one.
    const iOpus = html.indexOf('>opus-4.7<');
    const iSonnet = html.indexOf('>sonnet-4.6<');
    expect(iOpus).toBeGreaterThan(-1);
    expect(iSonnet).toBeGreaterThan(iOpus);
    // Both sub-row costs render.
    expect(html).toContain('$10.00');
    expect(html).toContain('$2.50');
  });

  it('renders em-dash for token columns when a model row lacks breakdown (fallback path)', () => {
    const row: WeeklyCostRow = {
      dateLocal: '2026-04-21',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 500,
      costUSD: 12.5,
      byModel: [
        {
          model: 'claude-opus-4-7',
          shortLabel: 'opus-4.7',
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 500,
          costUSD: 12.5,
          tokensBreakdownKnown: false,
        },
      ],
    };
    const report = buildReport({
      groups: [
        {
          label: 'Last 1 day',
          rows: [row],
          totals: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 500,
            costUSD: 12.5,
          },
        },
      ],
      scanFailed: true,
    });
    const html = renderWeeklyCostHtml(report, 'vscode-resource:', 'n1');
    // Sub-row contains em-dashes for unknown per-category tokens.
    expect(html).toContain('class="model"');
    expect(html).toContain('&mdash;');
    // But the totalTokens and cost are still rendered.
    expect(html).toContain('>500<');
    expect(html).toContain('$12.50');
  });

  it('omits model sub-rows for empty-usage (zero) days', () => {
    // Default `buildReport` uses rows whose `byModel` is `[]`.
    const html = renderWeeklyCostHtml(buildReport(), 'vscode-resource:', 'n1');
    expect(html).not.toContain('class="model"');
  });

  it('renders a Total footer row', () => {
    const html = renderWeeklyCostHtml(buildReport(), 'vscode-resource:', 'n1');
    expect(html).toContain('<tr class="total">');
    expect(html).toContain('>Total<');
  });

  it('renders the 7 column headers', () => {
    const html = renderWeeklyCostHtml(buildReport(), 'vscode-resource:', 'n1');
    for (const h of [
      '<th>Date</th>',
      '<th class="num">Input</th>',
      '<th class="num">Output</th>',
      '<th class="num">Cache Create</th>',
      '<th class="num">Cache Read</th>',
      '<th class="num">Total Tokens</th>',
      '<th class="num">Cost (USD)</th>',
    ]) {
      expect(html).toContain(h);
    }
  });

  it('applies right-alignment CSS to numeric column headers', () => {
    const html = renderWeeklyCostHtml(buildReport(), 'vscode-resource:', 'n1');
    expect(html).toMatch(/th\.num\s*,\s*td\.num\s*\{\s*text-align:\s*right/);
  });

  it('does not render a group title when there is only one range group', () => {
    const html = renderWeeklyCostHtml(buildReport(), 'vscode-resource:', 'n1');
    expect(html).not.toContain('class="group-title"');
  });

  it('does not render a Grand Total row in single-group mode', () => {
    const html = renderWeeklyCostHtml(buildReport(), 'vscode-resource:', 'n1');
    expect(html).not.toContain('Grand Total');
  });

  it('displays the window label in the header', () => {
    const html = renderWeeklyCostHtml(
      buildReport({ rangeLabel: 'Last 3 days' }),
      'vscode-resource:',
      'n1',
    );
    expect(html).toContain('Last 3 days');
  });

  it('forbids script-src in the CSP meta tag', () => {
    const html = renderWeeklyCostHtml(buildReport(), 'vscode-resource:', 'n1');
    const cspMatch = html.match(/Content-Security-Policy"\s+content="([^"]+)"/);
    expect(cspMatch).not.toBeNull();
    const csp = cspMatch![1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/script-src/);
  });

  it('HTML-escapes the account email when it contains markup-like chars', () => {
    const html = renderWeeklyCostHtml(
      buildReport({ accountEmail: '<a>@x.com' }),
      'vscode-resource:',
      'n1',
    );
    expect(html).toContain('&lt;a&gt;@x.com');
    expect(html).not.toContain('<a>@x.com');
  });

  it('labels account as "unknown" when email is null', () => {
    const html = renderWeeklyCostHtml(
      buildReport({ accountEmail: null }),
      'vscode-resource:',
      'n1',
    );
    expect(html).toContain('Account: unknown');
  });

  it('renders the notice block when scanFailed is true', () => {
    const html = renderWeeklyCostHtml(
      buildReport({ scanFailed: true }),
      'vscode-resource:',
      'n1',
    );
    expect(html).toContain('class="notice"');
    expect(html).toContain('Historical scan failed');
  });

  it('omits the notice block when scanFailed is false', () => {
    const html = renderWeeklyCostHtml(buildReport(), 'vscode-resource:', 'n1');
    expect(html).not.toContain('class="notice"');
  });

  it('formats USD with two decimals and $ prefix', () => {
    const html = renderWeeklyCostHtml(buildReport(), 'vscode-resource:', 'n1');
    expect(html).toContain('$0.07');
    expect(html).toContain('$0.28');
  });

  it('embeds the cspSource in the font-src directive', () => {
    const html = renderWeeklyCostHtml(buildReport(), 'vscode-resource:foo', 'n1');
    expect(html).toContain('font-src vscode-resource:foo');
  });
});

describe('renderWeeklyCostHtml — all mode', () => {
  it('renders one table per month with month labels, newest-first', () => {
    const aprRows = [mkRow('2026-04-21', 40, 40, 0.4)];
    const marRows = [mkRow('2026-03-20', 30, 30, 0.3), mkRow('2026-03-05', 20, 20, 0.2)];
    const feb = [mkRow('2026-02-10', 10, 10, 0.1)];
    const groups = [mkGroup('2026-04', aprRows), mkGroup('2026-03', marRows), mkGroup('2026-02', feb)];
    const grand: WeeklyCostTotals = sumRows([...aprRows, ...marRows, ...feb]);
    const report: WeeklyCostReport = {
      groups,
      grandTotals: grand,
      accountUuid: 'acc-1',
      accountEmail: 'u@x.com',
      generatedAt: Date.UTC(2026, 3, 21, 12, 0, 0),
      scanFailed: false,
      mode: 'all',
      rangeLabel: 'All time',
    };
    const html = renderWeeklyCostHtml(report, 'vscode-resource:', 'n1');

    // Month headers present in newest-first order.
    const i04 = html.indexOf('>2026-04<');
    const i03 = html.indexOf('>2026-03<');
    const i02 = html.indexOf('>2026-02<');
    expect(i04).toBeGreaterThanOrEqual(0);
    expect(i03).toBeGreaterThan(i04);
    expect(i02).toBeGreaterThan(i03);

    // Each month contributes exactly one <table> plus the grand-total table.
    const tableCount = (html.match(/<table/g) ?? []).length;
    expect(tableCount).toBe(4); // 3 month tables + 1 grand-total table

    expect(html).toContain('class="group-title"');
    expect(html).toContain('Grand Total');
    expect(html).toContain('Window: All time');
  });

  it('renders an empty-message placeholder when there are no groups', () => {
    const report: WeeklyCostReport = {
      groups: [],
      grandTotals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        costUSD: 0,
      },
      accountUuid: 'acc-1',
      accountEmail: null,
      generatedAt: Date.UTC(2026, 3, 21, 12, 0, 0),
      scanFailed: false,
      mode: 'all',
      rangeLabel: 'All time',
    };
    const html = renderWeeklyCostHtml(report, 'vscode-resource:', 'n1');
    expect(html).toContain('class="empty-msg"');
    expect(html).not.toContain('Grand Total'); // no grand-total table when empty
  });
});

describe('makeNonce', () => {
  it('produces a 32-char lowercase hex string', () => {
    const nonce = makeNonce();
    expect(nonce).toMatch(/^[a-f0-9]{32}$/);
  });

  it('produces different values on consecutive calls', () => {
    const a = makeNonce();
    const b = makeNonce();
    expect(a).not.toBe(b);
  });
});

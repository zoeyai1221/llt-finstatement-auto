/* LLT dashboard core: QBO report parsing + burn/runway metrics. No DOM access. */
(function (root) {
  'use strict';

  var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
  var SECTION_KIND = { 'Income': 'revenue', 'Expenses': 'expense', 'Cost of Goods Sold': 'cogs', 'Other Income/Expense': 'other' };
  var IGNORE_HEADERS = { 'Ordinary Income/Expenses': 1, 'Gross Profit': 1, 'Net Ordinary Income': 1, 'Net Other Income': 1, 'Net Income': 1 };

  // account -> expense group (anything not listed falls into "Other")
  var EXPENSE_GROUPS = {
    'Payroll Expenditures': 'Payroll',
    'Communication/License': 'Software & licenses',
    'Dues & Subscriptions': 'Software & licenses',
    'Insurance': 'Insurance'
  };
  var GROUP_ORDER = ['Payroll', 'Software & licenses', 'Insurance', 'Other'];

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function ym(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  function monthStart(m) { var p = m.split('-'); return new Date(+p[0], +p[1] - 1, 1); }
  function monthEnd(m) { var p = m.split('-'); return new Date(+p[0], +p[1], 0); }
  function addMonths(m, n) { var p = m.split('-'); return ym(new Date(+p[0], +p[1] - 1 + n, 1)); }
  function monthRange(a, b) { var out = [], m = a; while (m <= b) { out.push(m); m = addMonths(m, 1); } return out; }
  function round2(x) { return Math.round(x * 100) / 100; }

  // "September 1, 2025-June 25, 2026" -> {start,end}
  function parseLongDate(s) {
    var m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s || '');
    if (!m) return null;
    var mo = MONTHS[m[1].toLowerCase()];
    if (mo === undefined) return null;
    return new Date(+m[3], mo, +m[2]);
  }
  function parsePeriod(s) {
    var parts = String(s || '').split(/\s*[-–—]\s*(?=[A-Za-z])/);
    if (parts.length < 2) return null;
    var a = parseLongDate(parts[0]), b = parseLongDate(parts[1]);
    return a && b ? { start: a, end: b } : null;
  }
  // "Cash Basis  Thursday, June 25, 2026 07:59 PM GMTZ"
  function parseStamp(s) {
    var d = parseLongDate(s);
    if (!d) return null;
    var t = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(s);
    if (t) { var h = +t[1] % 12 + (/pm/i.test(t[3]) ? 12 : 0); d.setHours(h, +t[2]); }
    return d;
  }
  function num(v) {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return null;
    var neg = /^\(.*\)$/.test(v.trim()) || /^-/.test(v.trim());
    var n = parseFloat(v.replace(/[^0-9.]/g, ''));
    return isNaN(n) ? null : (neg ? -n : n);
  }
  function cellText(v) { return v === null || v === undefined ? '' : String(v).trim(); }

  // PDF text lines -> sheet-like rows: "Wells Fargo 1,921.41" -> ["Wells Fargo", "1,921.41"]
  var AMOUNT = /^-?\(?-?\$?[\d,]+\.\d{2}\)?$/;
  function pdfLinesToRows(lines) {
    return lines.map(function (line) {
      var toks = String(line).trim().split(/\s+/), nums = [];
      while (toks.length > 1 && AMOUNT.test(toks[toks.length - 1])) nums.unshift(toks.pop());
      return [toks.join(' ')].concat(nums);
    });
  }

  /* ---------- report type detection ---------- */
  function detectReport(rows) {
    var head = rows.slice(0, 8).map(function (r) { return cellText(r && r[0]); }).join(' | ').toLowerCase();
    if (head.indexOf('statement of activity detail') >= 0) return 'activity';
    if (head.indexOf('statement of financial position') >= 0 || head.indexOf('balance sheet') >= 0) return 'position';
    if (head.indexOf('statement of activity') >= 0) return 'activity-summary';
    return 'unknown';
  }

  /* ---------- Statement of Activity Detail ---------- */
  function parseActivity(rows, fileName) {
    var warnings = [];
    var org = cellText(rows[0] && rows[0][0]);
    var period = null, stamp = null, headerIdx = -1;
    for (var i = 0; i < Math.min(rows.length, 10); i++) {
      var a0 = cellText(rows[i] && rows[i][0]);
      if (!period) period = parsePeriod(a0);
      if (rows[i] && cellText(rows[i][1]).toLowerCase() === 'transaction date') { headerIdx = i; break; }
    }
    if (headerIdx < 0) throw new Error('Could not find the "Transaction date" header row.');
    var hdr = rows[headerIdx].map(function (c) { return cellText(c).toLowerCase(); });
    var col = function (n, dflt) { var k = hdr.indexOf(n); return k >= 0 ? k : dflt; };
    var C = { date: 1, type: col('transaction type', 2), num: col('num', 3), name: col('name', 4), cls: col('class full name', 6), desc: col('description', 7), amount: col('amount', 9) };

    var basis = '';
    for (var j = rows.length - 1; j > headerIdx; j--) {
      var t = cellText(rows[j] && rows[j][0]);
      if (/^(cash|accrual) basis/i.test(t)) { stamp = parseStamp(t); basis = /^cash/i.test(t) ? 'cash' : 'accrual'; break; }
    }

    // accounts that have a "... with sub-accounts" total are parents: plain "Total for X" must not close them
    var withSub = {};
    rows.forEach(function (r) {
      var a = cellText(r && r[0]);
      var m = /^Total for (.*) with sub-accounts$/.exec(a);
      if (m) withSub[m[1]] = true;
    });

    var facts = [], stack = [], section = null, kind = null;
    var reported = {};
    for (var r = headerIdx + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var a = cellText(row[0]);
      var dateCell = cellText(row[C.date]);
      if (DATE_RE.test(dateCell)) {
        var amt = num(row[C.amount]);
        if (amt === null) { warnings.push('Row ' + (r + 1) + ': transaction without an amount was skipped.'); continue; }
        if (!kind) { warnings.push('Row ' + (r + 1) + ': transaction outside any section was skipped.'); continue; }
        var p = dateCell.split('/');
        var iso = p[2] + '-' + p[0] + '-' + p[1];
        facts.push({
          date: iso, month: p[2] + '-' + p[0], type: cellText(row[C.type]), kind: kind, section: section,
          account: stack[0] || '(none)', sub: stack.slice(1).join(' > '), name: cellText(row[C.name]),
          desc: cellText(row[C.desc]), amount: amt
        });
        continue;
      }
      if (!a) continue;
      if (/^Total for /.test(a)) {
        var nm = a.slice(10), isWith = false;
        if (/ with sub-accounts$/.test(nm)) { nm = nm.slice(0, -18); isWith = true; }
        var closes = isWith || !withSub[nm];
        if (closes && stack.indexOf(nm) >= 0) { while (stack.length && stack[stack.length - 1] !== nm) stack.pop(); stack.pop(); }
        if (nm === section) reported[kind] = num(row[C.amount]);
        continue;
      }
      if (a === 'Net Income') { reported.netIncome = num(row[C.amount]); continue; }
      if (a === 'Gross Profit') { reported.grossProfit = num(row[C.amount]); continue; }
      if (IGNORE_HEADERS[a]) continue;
      if (SECTION_KIND[a]) { section = a; kind = SECTION_KIND[a]; stack = []; continue; }
      if (/^(cash|accrual) basis/i.test(a)) continue;
      stack.push(a);
    }

    var sums = { revenue: 0, expense: 0, cogs: 0, other: 0 };
    facts.forEach(function (f) { sums[f.kind] += f.amount; });
    var netComputed = round2(sums.revenue - sums.cogs - sums.expense + sums.other);
    var checks = [];
    function chk(label, got, want) {
      if (want === null || want === undefined) return;
      checks.push({ label: label, computed: round2(got), reported: round2(want), ok: Math.abs(got - want) < 0.015 });
    }
    chk('Total income', sums.revenue, reported.revenue);
    chk('Total expenses', sums.expense, reported.expense);
    chk('Net income', netComputed, reported.netIncome);
    if (sums.other !== 0) warnings.push('Transactions found under "Other Income/Expense"; they are included in net cash flow but not in burn.');
    if (!/cash/.test(basis)) warnings.push('This export is not marked "Cash Basis". Use Cash Basis so figures match bank cash.');

    return {
      kind: 'activity', fileName: fileName, org: org, period: period, exportedAt: stamp, basis: basis,
      facts: facts, checks: checks, warnings: warnings, rowCount: facts.length
    };
  }

  /* ---------- Statement of Financial Position ---------- */
  function parsePosition(rows, fileName) {
    var warnings = [], asOf = null, cash = null, liabilities = null, accounts = [], restricted = false;
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i] || [];
      var label = cellText(cells[0]);
      if (!asOf && /^as of/i.test(label)) asOf = parseLongDate(label);
      if (/restricted/i.test(label)) restricted = true;
      var nums = cells.slice(1).map(num).filter(function (x) { return x !== null; });
      var val = nums.length ? nums[nums.length - 1] : null;
      if (/^Total for Bank Accounts$/i.test(label) && val !== null) cash = val;
      if (/^Total for Liabilities$/i.test(label) && val !== null) liabilities = val;
    }
    if (cash !== null) {
      var inBank = false;
      for (var k = 0; k < rows.length; k++) {
        var l2 = cellText(rows[k] && rows[k][0]);
        if (/^Bank Accounts$/i.test(l2)) { inBank = true; continue; }
        if (/^Total for Bank Accounts$/i.test(l2)) break;
        if (inBank && l2) {
          var ns = (rows[k] || []).slice(1).map(num).filter(function (x) { return x !== null; });
          if (ns.length) accounts.push({ name: l2, balance: ns[ns.length - 1] });
        }
      }
    } else {
      warnings.push('Could not find "Total for Bank Accounts". Enter the cash balance manually.');
    }
    if (!asOf) warnings.push('Could not read the "As of" date.');
    if (restricted) warnings.push('The report mentions restricted funds. Subtract any restricted cash before reading the runway.');
    return { kind: 'position', fileName: fileName, asOf: asOf, cash: cash, liabilities: liabilities, accounts: accounts, warnings: warnings };
  }

  /* ---------- merge several activity exports ---------- */
  // For each month, use the export that fully covers it; ties go to the most recent export.
  function mergeActivity(files) {
    var byMonth = {}, notes = [];
    files.forEach(function (f, idx) {
      var months = {};
      f.facts.forEach(function (x) { (months[x.month] = months[x.month] || []).push(x); });
      var span = f.period ? monthRange(ym(f.period.start), ym(f.period.end)) : Object.keys(months).sort();
      span.forEach(function (m) {
        var full = f.period ? (f.period.start <= monthStart(m) && f.period.end >= monthEnd(m)) : true;
        var score = [full ? 1 : 0, f.exportedAt ? +f.exportedAt : 0, idx];
        var cur = byMonth[m];
        if (!cur || cmp(score, cur.score) > 0) byMonth[m] = { score: score, file: f, rows: months[m] || [], full: full };
      });
    });
    function cmp(a, b) { for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1; } return 0; }
    var facts = [];
    Object.keys(byMonth).sort().forEach(function (m) { facts = facts.concat(byMonth[m].rows); });
    var dataStart = null, dataEnd = null;
    files.forEach(function (f) {
      if (!f.period) return;
      if (!dataStart || f.period.start < dataStart) dataStart = f.period.start;
      if (!dataEnd || f.period.end > dataEnd) dataEnd = f.period.end;
    });
    var months = Object.keys(byMonth).sort();
    for (var i = 1; i < months.length; i++) {
      if (addMonths(months[i - 1], 1) !== months[i]) notes.push('Gap in data between ' + months[i - 1] + ' and ' + months[i] + '.');
    }
    return { facts: facts, dataStart: dataStart, dataEnd: dataEnd, notes: notes, firstMonth: months[0], lastMonth: months[months.length - 1] };
  }

  /* ---------- metrics ---------- */
  function groupOf(account) { return EXPENSE_GROUPS[account] || 'Other'; }

  function computeMetrics(facts, opts) {
    // opts: asOf (Date), dataEnd (Date), cash (number|null), thresholds {yellow, red}
    var cutoff = opts.asOf || opts.dataEnd;
    if (opts.asOf && opts.dataEnd && opts.dataEnd < opts.asOf) cutoff = opts.dataEnd;
    var warnings = [];
    if (opts.asOf && opts.dataEnd && ymd(opts.asOf) !== ymd(opts.dataEnd)) {
      warnings.push('Balance sheet is as of ' + ymd(opts.asOf) + ' but the activity export ends ' + ymd(opts.dataEnd) + '. Re-export both as of the same month-end.');
    }
    var cutoffMonth = ym(cutoff);
    var lastFull = monthEnd(cutoffMonth) <= cutoff ? cutoffMonth : addMonths(cutoffMonth, -1);
    if (lastFull !== cutoffMonth) warnings.push(cutoffMonth + ' is incomplete (data through ' + ymd(cutoff) + ') and is excluded from burn and runway.');
    var first = facts.length ? facts.reduce(function (a, f) { return f.month < a ? f.month : a; }, facts[0].month) : lastFull;
    var months = monthRange(first, lastFull);

    var series = {};
    months.forEach(function (m) {
      series[m] = { month: m, revenue: 0, adjustments: 0, expense: 0, other: 0, groups: {}, accounts: {}, income: {} };
      GROUP_ORDER.forEach(function (g) { series[m].groups[g] = 0; });
    });
    facts.forEach(function (f) {
      var s = series[f.month];
      if (!s) return;
      if (f.kind === 'expense') {
        s.expense += f.amount; s.groups[groupOf(f.account)] += f.amount;
        s.accounts[f.account] = (s.accounts[f.account] || 0) + f.amount;
      } else if (f.kind === 'revenue') {
        s.revenue += f.amount; s.income[f.account] = (s.income[f.account] || 0) + f.amount;
      } else if (f.kind === 'cogs') {
        s.adjustments += -f.amount;
      } else { s.other += f.amount; }
    });
    var list = months.map(function (m) {
      var s = series[m];
      s.net = s.revenue + s.adjustments + s.other - s.expense;
      return s;
    });
    list.forEach(function (s, i) {
      [3, 6, 12].forEach(function (n) {
        if (i + 1 >= n) {
          var w = list.slice(i + 1 - n, i + 1);
          s['burn' + n] = w.reduce(function (a, x) { return a + x.expense; }, 0) / n;
        } else s['burn' + n] = null;
      });
    });

    var windows = {};
    [3, 6, 12].forEach(function (n) {
      if (list.length < n) { windows[n] = null; return; }
      var w = list.slice(-n);
      var burn = w.reduce(function (a, x) { return a + x.expense; }, 0) / n;
      var inflow = w.reduce(function (a, x) { return a + x.revenue + x.adjustments + x.other; }, 0) / n;
      windows[n] = {
        n: n, from: w[0].month, to: w[n - 1].month, burn: burn, inflow: inflow, net: inflow - burn,
        runway: opts.cash !== null && opts.cash !== undefined && burn > 0 ? opts.cash / burn : null
      };
    });
    var primaryN = windows[12] ? 12 : (windows[6] ? 6 : (windows[3] ? 3 : null));
    var th = opts.thresholds || { yellow: 6, red: 3 };
    var primary = primaryN ? windows[primaryN] : null;
    var status = null;
    if (primary && primary.runway !== null) status = primary.runway >= th.yellow ? 'good' : (primary.runway >= th.red ? 'warning' : 'critical');
    if (primaryN && primaryN < 12) warnings.push('Only ' + list.length + ' complete months of data: the runway uses a ' + primaryN + '-month window. Export 12 months for a steadier figure.');

    // composition over the primary window
    var comp = { expense: {}, revenue: {}, adjustments: 0 }, compMonths = primaryN ? list.slice(-primaryN) : [];
    compMonths.forEach(function (s) {
      Object.keys(s.accounts).forEach(function (k) { comp.expense[k] = (comp.expense[k] || 0) + s.accounts[k]; });
      Object.keys(s.income).forEach(function (k) { comp.revenue[k] = (comp.revenue[k] || 0) + s.income[k]; });
      comp.adjustments += s.adjustments;
    });

    return {
      lastMonth: lastFull, months: list, windows: windows, primaryN: primaryN, primary: primary, status: status,
      cash: opts.cash, thresholds: th, composition: comp, warnings: warnings
    };
  }

  function toCSV(facts, includeNames) {
    var cols = ['date', 'month', 'type', 'kind', 'section', 'account', 'sub', 'desc', 'amount'];
    if (includeNames) cols.splice(7, 0, 'name');
    var esc = function (v) { v = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return [cols.join(',')].concat(facts.map(function (f) { return cols.map(function (c) { return esc(f[c]); }).join(','); })).join('\n');
  }

  root.LLT = {
    detectReport: detectReport, pdfLinesToRows: pdfLinesToRows, parseActivity: parseActivity, parsePosition: parsePosition, mergeActivity: mergeActivity,
    computeMetrics: computeMetrics, toCSV: toCSV, GROUP_ORDER: GROUP_ORDER, groupOf: groupOf, ymd: ymd, addMonths: addMonths
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.LLT;
})(typeof window !== 'undefined' ? window : globalThis);

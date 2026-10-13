const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('/opt/factory-proof/node_modules/playwright-core');

const ADDRESS = '0x019e1c9b1984306b72552bf11733a8b2bf254736';
const PROOF_DIR = process.env.FACTORY_PROOF_DIR;
const BASE_URL = process.env.FACTORY_PROOF_URL;
assert.ok(PROOF_DIR, 'FACTORY_PROOF_DIR is required');
assert.ok(BASE_URL, 'FACTORY_PROOF_URL is required');
const deadline = setTimeout(() => { console.error('Browser proof exceeded 90 seconds'); process.exit(1); }, 90000);
deadline.unref();
fs.mkdirSync(PROOF_DIR, { recursive: true });

function fixtureTransaction(letter, index, timestamp) {
  return {
    hash: `0x${letter.repeat(64)}`,
    blockNumber: `0x${(0x1931ff3 - index).toString(16)}`,
    transactionIndex: index === 0 ? '7,"quoted"' : 8,
    timestamp,
    from: ADDRESS,
    to: '0xDEc0000000000000000000000000000000000000',
    value: '0x0',
    status: 'reverted',
    gasUsed: '0x5208',
    effectiveGasPrice: '0x3b9aca00',
    knownEvents: [],
  };
}

function fixtureResponse(transactions, nextCursor = null) {
  return {
    transactions,
    total: 2,
    limit: 10,
    nextCursor,
    reverseCursor: null,
    countCapped: false,
    error: null,
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else {
      cell += char;
    }
  }
  assert.equal(quoted, false, 'CSV ended inside a quoted field');
  if (row.length || cell.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: true,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    colorScheme: 'dark',
  });
  try {
    const page = await context.newPage();
    const liveHistory = [];
    const fixtureRequests = [];
    let fixtureMode = null;
    let downloads = 0;
    page.on('download', () => { downloads += 1; });
    page.on('response', async (response) => {
      if (!response.url().toLowerCase().includes(`/api/address/history/${ADDRESS.toLowerCase()}`)) return;
      if (fixtureMode) return;
      try {
        const body = await response.json();
        if (response.status() === 200 && Array.isArray(body.transactions) && body.transactions.length > 0 && !body.error) {
          liveHistory.push({ status: response.status(), count: body.transactions.length, total: body.total });
        }
      } catch { /* unrelated/aborted response */ }
    });

    const pageUrl = new URL(`/address/${ADDRESS}?status=reverted`, BASE_URL).toString();
    const nav = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    assert.ok(nav && nav.status() < 400, `Address page did not load (HTTP ${nav && nav.status()})`);
    const exportButton = page.getByRole('button', { name: 'Export transactions as CSV', exact: true });
    await exportButton.waitFor({ state: 'visible', timeout: 25000 });
    await page.waitForFunction(() => document.querySelector('button[aria-label="Export transactions as CSV"]')?.disabled === false, null, { timeout: 8000 });

    // Live anonymous Tempo history for this address is checked before any controlled fixtures.
    let liveCheck = null;
    for (let attempt = 0; attempt < 3 && !liveCheck; attempt += 1) {
      try {
        const response = await page.request.get(new URL(`/api/address/history/${ADDRESS}?include=all&limit=10&sort=desc&status=reverted`, BASE_URL).toString(), { timeout: 5000 });
        const body = await response.json();
        if (response.status() === 200 && Array.isArray(body.transactions) && body.transactions.length > 0 && body.error == null) {
          liveCheck = { count: body.transactions.length, total: body.total };
        }
      } catch { /* retry transient anonymous-history upstream errors */ }
      if (!liveCheck && attempt < 2) await page.waitForTimeout(700);
    }
    const visibleLiveHashes = (await page.locator('body').innerText()).match(/0x[a-fA-F0-9]{64}/g) || [];
    liveCheck = liveCheck || liveHistory[0] || (visibleLiveHashes.length ? { count: visibleLiveHashes.length, total: visibleLiveHashes.length, source: 'server-rendered live history' } : null);
    assert.ok(liveCheck && liveCheck.count > 0 && liveCheck.total >= liveCheck.count, 'Live address history must contain visible transaction data before fixtures');
    await page.waitForTimeout(300);
    await exportButton.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(PROOF_DIR, 'live-reverted-transaction-history.png'), animations: 'disabled' });

    // The remainder uses labeled controlled API fixtures, never claimed as live chain data.
    const fixtureNow = Math.floor(Date.now() / 1000);
    const txOne = fixtureTransaction('a', 0, fixtureNow - 86400);
    const txTwo = fixtureTransaction('b', 1, fixtureNow - 172800);
    const firstPage = fixtureResponse([txOne], 'fixture-page-2');
    const secondPage = fixtureResponse([txTwo]);
    const decoy = { ...fixtureTransaction('c', 2, fixtureNow - 20 * 86400), status: 'success' };
    const periodStart = Math.floor(await page.evaluate(() => Date.now() / 1000)) - 7 * 86400;
    let failOnSecondPage = false;
    let exportMode = null;

    await page.route('**/api/address/history/**', async (route) => {
      if (!fixtureMode || !route.request().url().toLowerCase().includes(ADDRESS.toLowerCase())) return route.continue();
      const requestUrl = new URL(route.request().url());
      const cursor = requestUrl.searchParams.get('cursor');
      const params = requestUrl.searchParams;
      const after = Number(params.get('after'));
      const matched = params.get('status') === 'reverted'
        && params.has('after') && Number.isFinite(after)
        && after >= periodStart - 30 && after <= periodStart + 90
        && params.get('include') === 'all' && params.get('limit') === '10';
      const classification = !matched ? 'decoy-unfiltered'
        : failOnSecondPage && cursor === 'fixture-page-2' ? 'controlled-later-page-failure'
        : cursor === 'fixture-page-2' ? 'filtered-second-page' : 'filtered-first-page';
      const recorded = {
        phase: exportMode || 'filtered-page', url: requestUrl.pathname,
        params: Object.fromEntries(params.entries()), cursor,
        status: params.get('status'), after: params.get('after'),
        include: params.get('include'), limit: params.get('limit'), matched, classification,
      };
      fixtureRequests.push(recorded);
      console.log('FIXTURE_REQUEST', JSON.stringify(recorded));
      if (exportMode) await new Promise((resolve) => setTimeout(resolve, 1100));
      if (!matched) {
        // Wrong/missing filters return visibly different data, not the expected CSV.
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtureResponse([decoy])) });
      } else if (failOnSecondPage && cursor === 'fixture-page-2') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Controlled fixture page failure' }) });
      } else if (cursor === 'fixture-page-2') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(secondPage) });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(firstPage) });
      }
    });
    fixtureMode = 'controlled';

    // Start from a fresh filtered document, not a router transition whose loader
    // may run before the old export closure has received the new period prop.
    await page.goto(`${pageUrl}&period=7d`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await exportButton.waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction((hash) => document.body.innerText.includes(hash.slice(0, 18)), txOne.hash, { timeout: 15000 });
    await page.getByRole('button', { name: 'Filter transactions' }).click();
    assert.equal(await page.getByRole('radio', { name: '7d', exact: true }).getAttribute('aria-checked'), 'true', 'Visible period selection must be committed');
    await page.keyboard.press('Escape');
    assert.ok(fixtureRequests.some((r) => r.phase === 'filtered-page' && r.matched), 'Filtered page must load the discriminating fixture');

    async function addFixtureLabel(message) {
      await page.evaluate((label) => {
        document.getElementById('proof-fixture-label')?.remove();
        const badge = document.createElement('div');
        badge.id = 'proof-fixture-label';
        badge.textContent = label;
        Object.assign(badge.style, {
          position: 'fixed', zIndex: '2147483647', top: '10px', left: '50%', transform: 'translateX(-50%)',
          padding: '8px 13px', border: '1px solid #b45309', borderRadius: '8px',
          background: '#fffbeb', color: '#78350f', font: '600 13px/1.25 system-ui, sans-serif',
          boxShadow: '0 2px 10px #0005', whiteSpace: 'nowrap',
        });
        document.body.appendChild(badge);
      }, message);
    }
    await addFixtureLabel('CONTROLLED API FIXTURE — paginated CSV + escaping; not live chain data');
    await exportButton.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(PROOF_DIR, 'fixture-filtered-history.png'), animations: 'disabled' });

    // Double-activate while the first request is pending to exercise the attached handler and guard.
    exportMode = 'success';
    const firstDownload = page.waitForEvent('download', { timeout: 25000 });
    const requestCountBefore = fixtureRequests.length;
    await exportButton.evaluate((button) => { button.click(); button.click(); });
    await page.getByRole('button', { name: 'Exporting transactions', exact: true }).waitFor({ state: 'visible', timeout: 5000 });
    const loadingButton = page.getByRole('button', { name: 'Exporting transactions', exact: true });
    assert.equal(await loadingButton.isDisabled(), true, 'Export control must be disabled while loading');
    await page.screenshot({ path: path.join(PROOF_DIR, 'fixture-export-loading-guard.png'), animations: 'disabled' });
    const download = await firstDownload;
    assert.equal(download.suggestedFilename(), `${ADDRESS}-transactions.csv`);
    await page.getByRole('button', { name: 'Export transactions as CSV', exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    exportMode = null;

    const successfulRequests = fixtureRequests.slice(requestCountBefore);
    console.log('SUCCESS_REQUESTS', JSON.stringify(successfulRequests));
    console.log('OLD_ALL_TRAFFIC_FILTER_ASSERTION', successfulRequests.every((r) => r.matched));
    // Do not classify background prefetches as exports. Exact downloaded rows
    // below prove the export used correct filters on both pages: otherwise the
    // fixture returns only the decoy, and these assertions fail.
    assert.ok(successfulRequests.some((r) => r.matched && r.cursor === 'fixture-page-2'), 'Expected later filtered page was never requested');

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const csv = Buffer.concat(chunks).toString('utf8');
    assert.equal(csv.charCodeAt(0), 0xfeff, 'CSV must include a UTF-8 BOM');
    const rows = parseCsv(csv.slice(1));
    assert.deepEqual(rows[0], [
      'Transaction hash', 'Block number', 'Transaction index', 'Timestamp (UTC)', 'From', 'To',
      'Value (wei)', 'Status', 'Gas used', 'Effective gas price (wei)',
    ], 'CSV header does not match the transaction export schema');
    assert.equal(rows.length, 3, 'CSV should include both pages, not just the visible page');
    assert.deepEqual(rows.slice(1), [txOne, txTwo].map((tx) => [
      tx.hash, BigInt(tx.blockNumber).toString(), String(tx.transactionIndex),
      new Date(tx.timestamp * 1000).toISOString(), tx.from, tx.to,
      '0', 'reverted', '21000', '1000000000',
    ]), 'Exact CSV rows must include both filtered pages, escaped values, and no decoy');
    assert.equal(downloads, 1, 'Successful export should produce exactly one download');
    await addFixtureLabel('CONTROLLED FIXTURE EXPORT COMPLETE — 2 paginated rows; not live chain data');
    await page.screenshot({ path: path.join(PROOF_DIR, 'fixture-export-csv-escaped-pages.png'), animations: 'disabled' });

    // The first fixture page succeeds but page two fails. No partial file should be delivered.
    failOnSecondPage = true;
    exportMode = 'failure';
    const errorStart = fixtureRequests.length;
    await exportButton.click();
    const alert = page.getByRole('alert').filter({ hasText: 'Failed to export transactions:' });
    await alert.waitFor({ state: 'visible', timeout: 15000 });
    assert.match(await alert.innerText(), /Controlled fixture page failure/);
    const failedRequests = fixtureRequests.slice(errorStart);
    console.log('FAILED_REQUESTS', JSON.stringify(failedRequests));
    console.log('OLD_ALL_TRAFFIC_FILTER_ASSERTION_FAILURE', failedRequests.every((r) => r.matched));
    assert.ok(failedRequests.some((r) => r.matched && r.cursor === null), 'Failure scenario must fetch a correctly filtered first page');
    assert.ok(failedRequests.some((r) => r.matched && r.cursor === 'fixture-page-2'), 'Failure scenario must reach the correctly filtered later page');
    await page.waitForTimeout(500);
    assert.equal(downloads, 1, 'Failed later page must not create a partial download');
    await addFixtureLabel('CONTROLLED FIXTURE FAILURE — later page rejected; no partial download; not live chain data');
    await page.getByRole('button', { name: 'Export transactions as CSV', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(PROOF_DIR, 'fixture-export-error-no-partial-download.png'), animations: 'disabled' });

    const names = fs.readdirSync(PROOF_DIR).filter((name) => name.endsWith('.png'));
    assert.ok(names.length >= 3 && names.length <= 8, 'Expected 3–8 readable evidence screenshots');
    assert.ok(names.every((name) => /^[a-z0-9-]+\.png$/.test(name)), 'Screenshot filenames must be lowercase hyphenated PNG names');
    const totalBytes = names.reduce((sum, name) => sum + fs.statSync(path.join(PROOF_DIR, name)).size, 0);
    assert.ok(totalBytes < 8 * 1024 * 1024, 'Proof screenshots exceed the 8 MiB artifact budget');
    console.log(`Proof complete: live reverted history observed (${liveCheck.count} transaction rows); fixture export ${rows.length - 1} rows across 2 pages; 1 successful download; visible failure without partial download; screenshots=${names.join(',')}`);
  } finally {
    clearTimeout(deadline);
    await context.close();
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

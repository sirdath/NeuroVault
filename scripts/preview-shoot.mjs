import puppeteer from 'puppeteer-core';
const SCRATCH = '/private/tmp/claude-501/-Users-dath-Documents-Dath-Serious-Projects--NeuroVault/b2b699cb-00fe-4afd-871b-aa49ea540b5c/scratchpad';
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
});
const page = await browser.newPage();
await page.setViewport({ width: 1198, height: 800 });
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) console.log('CONSOLE-ERR:', m.text().slice(0, 160)); });
await page.goto('http://localhost:1420/preview.html', { waitUntil: 'networkidle2' });
await new Promise(r => setTimeout(r, 3000));

const clickByText = async (text) => {
  const ok = await page.evaluate((t) => {
    const els = [...document.querySelectorAll('button, summary')];
    const el = els.find(b => (b.textContent || '').trim() === t);
    if (el) { el.click(); return true; }
    return false;
  }, text);
  if (!ok) console.log('NOT FOUND:', text);
  await new Promise(r => setTimeout(r, 600));
  return ok;
};
const shot = async (n) => { await page.screenshot({ path: `${SCRATCH}/mr-${n}.png` }); console.log('shot', n); };

await shot('1-needs');
await clickByText('Edit before approving');
await shot('2-edit');
await clickByText('Cancel');
await clickByText('Reject');
await shot('3-reject');
await clickByText('Cancel');
await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true));
await new Promise(r => setTimeout(r, 1000));
await shot('4-disclosures');
await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = false));
await clickByText('Activity');
await new Promise(r => setTimeout(r, 1500));
await shot('5-activity');
await clickByText('Learning report');
await new Promise(r => setTimeout(r, 1000));
await shot('6-learning');
await clickByText('Approved');
await new Promise(r => setTimeout(r, 800));
await shot('7-approved');
await browser.close();
console.log('DONE');

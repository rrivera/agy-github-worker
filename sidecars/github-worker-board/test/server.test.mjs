import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBrowserAppJs } from '../main.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const boardDir = join(__dirname, '..');

describe('Standalone Server Static Assets', () => {
  it('serves index.html, styles.css, and app.js with appropriate MIME types', async () => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(readFileSync(join(boardDir, 'index.html'), 'utf-8'));
        return;
      }
      if (url.pathname === '/styles.css') {
        res.writeHead(200, { 'Content-Type': 'text/css' });
        res.end(readFileSync(join(boardDir, 'styles.css'), 'utf-8'));
        return;
      }
      if (url.pathname === '/app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(getBrowserAppJs());
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const resHtml = await fetch(`${baseUrl}/`);
      assert.equal(resHtml.status, 200);
      assert.equal(resHtml.headers.get('content-type'), 'text/html; charset=utf-8');
      const htmlText = await resHtml.text();
      assert.match(htmlText, /<script src="\/app\.js"><\/script>/);
      assert.doesNotMatch(htmlText, /hide-done-checkbox/);
      assert.doesNotMatch(htmlText, /Hide Done/);

      const resCss = await fetch(`${baseUrl}/styles.css`);
      assert.equal(resCss.status, 200);
      assert.equal(resCss.headers.get('content-type'), 'text/css');

      const resJs = await fetch(`${baseUrl}/app.js`);
      assert.equal(resJs.status, 200);
      assert.equal(resJs.headers.get('content-type'), 'application/javascript');
      const jsText = await resJs.text();
      assert.match(jsText, /function escapeHtml/);
      assert.doesNotMatch(jsText, /^export\s+/m);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

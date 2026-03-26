import 'dotenv/config';
import express from 'express';
import { createRequestHandler } from '@react-router/express';
import https from 'node:https';
import http from 'node:http';

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const ALLOWED_HOST = 'courses.instructionalgraphics.org';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function videoProxy(req, res) {
  try {
    if (req.query.debug === '1') {
      return res.json({ ok: true, node: process.version, host: ALLOWED_HOST });
    }

    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).send('Missing ?url');

    let target;
    try { target = new URL(videoUrl); } catch {
      return res.status(400).send('Invalid URL');
    }
    if (target.hostname !== ALLOWED_HOST) {
      return res.status(403).send('Forbidden: ' + target.hostname);
    }

    const reqHeaders = {
      'User-Agent': BROWSER_UA,
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
      'Referer': 'https://' + ALLOWED_HOST + '/',
    };
    if (req.headers['range']) reqHeaders['Range'] = req.headers['range'];

    const lib = target.protocol === 'https:' ? https : http;
    const options = {
      hostname: target.hostname,
      port: target.port ? parseInt(target.port, 10) : (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'GET',
      headers: reqHeaders,
    };

    const proxyReq = lib.request(options, (proxyRes) => {
      const ct = (proxyRes.headers['content-type'] || '').toLowerCase();
      const isPlaylist = videoUrl.includes('.m3u8') || ct.includes('mpegurl');

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');

      if (isPlaylist) {
        let text = '';
        proxyRes.setEncoding('utf8');
        proxyRes.on('data', c => { text += c; });
        proxyRes.on('end', () => {
          const baseUrl = videoUrl.substring(0, videoUrl.lastIndexOf('/') + 1);
          const rewritten = text.split('\n').map(line => {
            const t = line.trim();
            if (!t) return line;
            if (t.startsWith('#EXT-X-KEY') && t.includes('URI="')) {
              return line.replace(/URI="([^"]+)"/, (_, uri) => {
                try {
                  const abs = new URL(uri, baseUrl).href;
                  if (new URL(abs).hostname === ALLOWED_HOST)
                    return 'URI="/api/video-proxy?url=' + encodeURIComponent(abs) + '"';
                } catch {}
                return _;
              });
            }
            if (t.startsWith('#')) return line;
            try {
              const abs = new URL(t, baseUrl).href;
              if (new URL(abs).hostname === ALLOWED_HOST)
                return '/api/video-proxy?url=' + encodeURIComponent(abs);
            } catch {}
            return line;
          }).join('\n');
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          res.setHeader('Cache-Control', 'no-cache');
          res.status(200).send(rewritten);
        });
        proxyRes.on('error', err => {
          if (!res.headersSent) res.status(502).send('Stream error: ' + err.message);
        });
      } else {
        res.status(proxyRes.statusCode || 200);
        ['content-type','content-length','content-range','accept-ranges'].forEach(h => {
          if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]);
        });
        if (!res.getHeader('content-type')) {
          if (videoUrl.endsWith('.ts')) res.setHeader('Content-Type', 'video/mp2t');
          else if (videoUrl.endsWith('.mp4')) res.setHeader('Content-Type', 'video/mp4');
        }
        proxyRes.pipe(res);
      }
    });

    proxyReq.setTimeout(20000, () => proxyReq.destroy(new Error('Timeout')));
    proxyReq.on('error', err => {
      console.error('[proxy] error:', err.message);
      if (!res.headersSent) res.status(502).send('Upstream error: ' + err.message);
    });
    proxyReq.end();

  } catch (err) {
    console.error('[proxy] crash:', err.message);
    if (!res.headersSent) res.status(500).send('Proxy error: ' + err.message);
  }
}

const app = express();
app.get('/api/video-proxy', videoProxy);
app.all('*', createRequestHandler({
  build: () => import('./build/server/index.js'),
  mode: process.env.NODE_ENV,
}));

const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => console.log('[server] port ' + port));

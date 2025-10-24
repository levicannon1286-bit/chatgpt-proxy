// netlify/functions/proxy.js
// Simple but robust HTML-rewriting proxy for Netlify Functions.
// Notes:
// - Optional API key: set PROXY_KEY env var in Netlify dashboard to require a key. 
// - Blocks obvious private/internal hosts.
// - Rewrites HTML links so pages work through the proxy.
// - Streams binary responses back as base64 (Netlify serverless requirement).

const { fetch } = require('undici');
const cheerio = require('cheerio');

const API_KEY = process.env.PROXY_KEY || null; // optional, set in Netlify site settings

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0 - 172.31.255.255
  /\.local$/i,
  /^0\./,
];

function isBlockedHost(hostname) {
  if (!hostname) return true;
  return BLOCKED_HOST_PATTERNS.some((rx) => rx.test(hostname));
}

function makeProxyUrl(target) {
  // returns the same function URL with the encoded target
  // when deployed to a custom domain this will still work because client calls relative path
  return `/.netlify/functions/proxy?url=${encodeURIComponent(target)}`;
}

function shouldRewriteAttr(val) {
  if (!val) return false;
  const v = val.trim().toLowerCase();
  return !(
    v.startsWith('data:') ||
    v.startsWith('javascript:') ||
    v.startsWith('mailto:') ||
    v.startsWith('#')
  );
}

function maybeRewriteUrl(attrValue, baseUrl) {
  try {
    if (!attrValue) return attrValue;
    if (!shouldRewriteAttr(attrValue)) return attrValue;
    const resolved = new URL(attrValue, baseUrl).href;
    return makeProxyUrl(resolved);
  } catch (e) {
    return attrValue;
  }
}

function isHtmlContentType(contentType) {
  if (!contentType) return false;
  return contentType.split(';')[0].trim().toLowerCase() === 'text/html';
}

exports.handler = async function (event) {
  try {
    // Basic CORS preflight handling for the frontend
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers': 'Content-Type,Authorization,X-Proxy-Key',
        },
        body: ''
      };
    }

    const qs = event.queryStringParameters || {};
    const target = qs.url || (event.body && JSON.parse(event.body).url);
    if (!target) {
      return { statusCode: 400, body: 'Missing url parameter' };
    }

    // Optional API key enforcement (header X-Proxy-Key or query key param)
    if (API_KEY) {
      const headerKey = (event.headers && (event.headers['x-proxy-key'] || event.headers['X-Proxy-Key'])) || '';
      const qsKey = qs.key || '';
      if (headerKey !== API_KEY && qsKey !== API_KEY) {
        return { statusCode: 401, body: 'Unauthorized: invalid proxy key' };
      }
    }

    // Validate target URL and block local/private hosts
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (err) {
      return { statusCode: 400, body: 'Invalid target URL' };
    }
    if (isBlockedHost(targetUrl.hostname)) {
      return { statusCode: 403, body: 'Forbidden host' };
    }

    // Prepare fetch options: copy most headers except Host and some hop-by-hop headers
    const incomingHeaders = Object.assign({}, event.headers || {});
    delete incomingHeaders['host'];
    delete incomingHeaders['Host'];
    // Optionally remove cookie headers to avoid leaking client cookies to remote
    // delete incomingHeaders['cookie'];

    // Compose body for non-GET methods
    let body = undefined;
    if (event.body && !['GET','HEAD'].includes(event.httpMethod)) {
      body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
    }

    // Forward the request
    const res = await fetch(target, {
      method: event.httpMethod || 'GET',
      headers: incomingHeaders,
      body,
      redirect: 'follow',
    });

    // Prepare response headers for Netlify return (filter hop-by-hop and security that break embedding)
    const outHeaders = {};
    for (const [k, v] of Object.entries(Object.fromEntries(res.headers))) {
      const key = k.toLowerCase();
      if (['content-security-policy','content-security-policy-report-only','x-frame-options','set-cookie','transfer-encoding'].includes(key)) {
        // skip these to avoid breaking proxied pages; note: cookies would require careful handling
        continue;
      }
      outHeaders[k] = v;
    }
    // Add CORS so our UI can call the function directly
    outHeaders['access-control-allow-origin'] = '*';
    outHeaders['access-control-expose-headers'] = Object.keys(outHeaders).join(',');

    const contentType = res.headers.get('content-type') || '';

    if (isHtmlContentType(contentType)) {
      const text = await res.text();
      const $ = cheerio.load(text, { decodeEntities: false });

      const attrs = [
        ['a', 'href'],
        ['link', 'href'],
        ['script', 'src'],
        ['img', 'src'],
        ['iframe', 'src'],
        ['form', 'action'],
        ['source', 'src'],
        ['video', 'src'],
        ['audio', 'src'],
      ];

      // Use the final resolved URL (res.url) as base for relative resolution when possible
      const baseUrl = res.url || target;

      for (const [sel, attr] of attrs) {
        $(sel).each((i, el) => {
          const $el = $(el);
          const val = $el.attr(attr);
          if (!val) return;
          const newVal = maybeRewriteUrl(val, baseUrl);
          $el.attr(attr, newVal);
        });
      }

      // Meta refresh
      $('meta[http-equiv]').each((i, el) => {
        const $el = $(el);
        const he = ($el.attr('http-equiv') || '').toLowerCase();
        if (he === 'refresh') {
          const content = $el.attr('content') || '';
          const parts = content.split(';');
          if (parts.length > 1) {
            const urlPart = parts.slice(1).join(';').replace(/^\s*url=/i, '');
            const newUrl = maybeRewriteUrl(urlPart, baseUrl);
            parts[1] = `url=${newUrl}`;
            $el.attr('content', parts.join(';'));
          }
        }
      });

      // small injection: add a banner linking to our proxy host for convenience (non-intrusive)
      $('body').prepend(`<div id="proxy-banner" style="position:fixed;left:12px;bottom:12px;z-index:999999;padding:8px 12px;background:rgba(0,0,0,0.65);color:white;border-radius:8px;font-family:Arial,Helvetica,sans-serif;font-size:13px;">
        proxied via proxy
      </div>`);

      const outHtml = $.html();

      outHeaders['content-type'] = 'text/html; charset=utf-8';
      return {
        statusCode: res.status,
        headers: outHeaders,
        body: outHtml
      };
    } else {
      // Binary (image, css, js, etc.) -> send base64
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (contentType) outHeaders['content-type'] = contentType;
      return {
        statusCode: res.status,
        headers: outHeaders,
        body: buffer.toString('base64'),
        isBase64Encoded: true
      };
    }
  } catch (err) {
    console.error('Proxy error', err);
    return {
      statusCode: 500,
      headers: { 'access-control-allow-origin': '*' },
      body: 'Proxy error: ' + String(err)
    };
  }
};

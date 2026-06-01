/**
 * 雲初馥 - 本地 API 代理服务器
 * 解决浏览器直接调用 AI API 的 CORS 跨域问题
 * 
 * 启动: node server.js
 * 访问: http://localhost:3210
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const vm = require('vm');

const PORT = 3210;
const IS_MAC = os.platform() === 'darwin';
const PYTHON_CMD = IS_MAC ? 'python3' : 'python';
const DEFAULT_SAVE_FOLDER = IS_MAC
  ? path.join(os.homedir(), 'Downloads', 'douyin_downloads')
  : 'D:\\douyin_downloads';

// ======== Douyin API encryption helpers (ported from douyin_download5.20) ========
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://www.douyin.com/';

// Load a_bogus.js for signature generation
let aBogusSandbox = null;
try {
  const aBogusCode = fs.readFileSync(path.join(__dirname, 'a_bogus.js'), 'utf-8');
  aBogusSandbox = vm.createContext({ generate_a_bogus: undefined });
  vm.runInContext(aBogusCode, aBogusSandbox);
  console.log('[Encrypt] a_bogus.js loaded successfully');
} catch(e) {
  console.error('[Encrypt] Failed to load a_bogus.js:', e.message);
}

// Load Douyin login cookies (from douyin_cookies.json)
let douyinCookies = {};
try {
  let cookieRaw = fs.readFileSync(path.join(__dirname, 'douyin_cookies.json'), 'utf-8');
  // Strip BOM if present
  if (cookieRaw.charCodeAt(0) === 0xFEFF) cookieRaw = cookieRaw.substring(1);
  const cookieData = JSON.parse(cookieRaw);
  douyinCookies = cookieData;
  console.log('[Douyin] Login cookies loaded, keys:', Object.keys(cookieData).length, 'has session:', !!cookieData.sessionid_ss);
} catch(e) {
  console.log('[Douyin] No login cookies file, will use anonymous mode:', e.message);
}

function generateDouyinCookieStr(ttwid, msToken) {
  const parts = [];
  if (ttwid) parts.push(`ttwid=${ttwid}`);
  if (msToken) parts.push(`msToken=${msToken}`);
  // Add login cookies
  for (const [k, v] of Object.entries(douyinCookies)) {
    if (v) parts.push(`${k}=${v}`);
  }
  return parts.join('; ');
}

function getABogus(queryString) {
  if (!aBogusSandbox || typeof aBogusSandbox.generate_a_bogus !== 'function') return '';
  return aBogusSandbox.generate_a_bogus(queryString, USER_AGENT);
}

// Get ttwid from bytedance
async function getTtwid() {
  try {
    const resp = await fetch('https://ttwid.bytedance.com/ttwid/union/register/', {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
      body: JSON.stringify({ region: 'cn', aid: 1768, needFid: false, service: 'www.ixigua.com', migrate_info: { ticket: '', source: 'node' }, cbUrlProtocol: 'https', union: true })
    });
    const setCookie = resp.headers.getSetCookie?.() || [];
    for (const c of setCookie) {
      const m = c.match(/ttwid=([^;]+)/);
      if (m) return m[1];
    }
  } catch(e) { console.log('[Encrypt] getTtwid error:', e.message); }
  return '';
}

// Generate fake msToken (random 107-char string)
function getFakeMsToken(size = 107) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: size }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Extract video ID from douyin URL
function extractDouyinVideoId(url) {
  // https://www.douyin.com/video/7362499785296720395
  let m = url.match(/\/video\/(\d+)/);
  if (m) return m[1];
  // https://www.douyin.com/note/7362499785296720395
  m = url.match(/\/note\/(\d+)/);
  if (m) return m[1];
  // /share/video/xxx
  m = url.match(/\/share\/video\/(\d+)/);
  if (m) return m[1];
  return null;
}

// MIME types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Douyin batch download tasks store
const douyinBatchTasks = {};

const server = http.createServer(async (req, res) => {
  // CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API proxy endpoint
  if (req.method === 'POST' && req.url === '/api/proxy') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { apiUrl, apiKey, model, messages, temperature, max_tokens } = JSON.parse(body);

        if (!apiUrl || !apiKey || !model) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '缺少必要参数: apiUrl, apiKey, model' }));
          return;
        }

        console.log(`[Proxy] → ${model} @ ${apiUrl.replace(/\/chat.*/, '...')}`);

        const resp = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: parseFloat(temperature) || 0.7,
            max_tokens: parseInt(max_tokens) || 4096
          })
        });

        const data = await resp.text();
        console.log(`[Proxy] ← ${resp.status} (${data.length} bytes)`);

        res.writeHead(resp.status, { 'Content-Type': 'application/json' });
        res.end(data);
      } catch (err) {
        console.error('[Proxy] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `代理请求失败: ${err.message}` }));
      }
    });
    return;
  }

  // Test connection endpoint
  if (req.method === 'POST' && req.url === '/api/test') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { apiUrl, apiKey, model } = JSON.parse(body);
        const resp = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: '请回复"连接成功"四个字' }],
            temperature: 0.1,
            max_tokens: 20
          })
        });

        const data = await resp.json();
        const reply = data.choices?.[0]?.message?.content || '无回复';

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: resp.ok, status: resp.status, reply }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Download video endpoint — proxies video stream to browser
  if (req.method === 'POST' && req.url === '/api/download-video') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { videoUrl, filename, platform } = JSON.parse(body);
        if (!videoUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '缺少 videoUrl 参数' }));
          return;
        }

        console.log(`[VideoDL] → ${platform || 'unknown'}: ${videoUrl.substring(0, 80)}...`);

        const headers = {
          'User-Agent': USER_AGENT,
          'Accept': 'video/*,*/*;q=0.8,*/*;q=0.1',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        };

        // 抖音需要 Referer + Cookie
        if (platform === 'douyin') {
          headers['Referer'] = REFERER;
          // Include login cookies for douyin CDN
          const cookieStr = generateDouyinCookieStr('', '');
          if (cookieStr) headers['Cookie'] = cookieStr;
        }
        // 视频号需要 Referer
        if (platform === 'sph') {
          headers['Referer'] = 'https://mp.weixin.qq.com/';
        }

        const resp = await fetch(videoUrl, { headers, redirect: 'follow' });

        if (!resp.ok) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `视频源返回 ${resp.status}` }));
          return;
        }

        const contentType = resp.headers.get('content-type') || 'video/mp4';
        const contentLength = resp.headers.get('content-length');
        const safeName = (filename || 'video').replace(/[\\/:*?"<>|]/g, '_');

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(safeName)}.mp4"`,
          'Access-Control-Expose-Headers': 'Content-Disposition',
          ...(contentLength ? { 'Content-Length': contentLength } : {})
        });

        // Stream the response
        const reader = resp.body;
        if (reader && typeof reader.pipe === 'function') {
          reader.pipe(res);
        } else if (reader) {
          const chunks = [];
          for await (const chunk of reader) {
            chunks.push(chunk);
          }
          res.end(Buffer.concat(chunks));
        } else {
          // Fallback: read entire body
          const buf = await resp.arrayBuffer();
          res.end(Buffer.from(buf));
        }

        console.log(`[VideoDL] ✓ ${safeName}.mp4`);
      } catch (err) {
        console.error('[VideoDL] Error:', err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `下载失败: ${err.message}` }));
        }
      }
    });
    return;
  }

  // Fetch article content endpoint
  if (req.method === 'POST' && req.url === '/api/fetch-article') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { url } = JSON.parse(body);
        if (!url) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '缺少 url 参数' }));
          return;
        }

        console.log(`[Fetch] → ${url}`);

        const resp = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
          }
        });

        if (!resp.ok) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `目标服务器返回 ${resp.status}` }));
          return;
        }

        const html = await resp.text();
        console.log(`[Fetch] ← ${resp.status} (${html.length} bytes)`);

        // Extract title
        let title = '';
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (titleMatch) {
          title = titleMatch[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').trim();
        }

        // Extract WeChat article content from js_content div
        let content = '';
        const contentMatch = html.match(/id="js_content"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<script/i) ||
                           html.match(/id="js_content"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i) ||
                           html.match(/id="js_content"[^>]*>([\s\S]*?)<\/div>/i) ||
                           html.match(/class="rich_media_content"[^>]*>([\s\S]*?)<\/div>/i) ||
                           html.match(/class="rich_media_area_primary"[^>]*>([\s\S]*?)<\/div>/i);

        if (contentMatch) {
          // Strip HTML tags, keep text
          content = contentMatch[1]
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n')
            .replace(/<\/div>/gi, '\n')
            .replace(/<\/li>/gi, '\n')
            .replace(/<img[^>]*>/gi, '[图片]')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ')
            .replace(/&#(\d+);/g, (m, code) => String.fromCharCode(parseInt(code)))
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        }

        // Fallback: try to extract from og:description meta tag
        if (!content) {
          const descMatch = html.match(/property="og:description"\s+content="([\s\S]*?)"/i) ||
                           html.match(/name="description"\s+content="([\s\S]*?)"/i);
          if (descMatch) {
            content = descMatch[1]
              .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
              .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
              .trim();
          }
        }

        // Fallback: try rich_media_meta title for WeChat
        if (!title || title === '微信公众号') {
          const metaTitle = html.match(/var msg_title\s*=\s*'([\s\S]*?)'/i) ||
                           html.match(/var msg_title\s*=\s*"([\s\S]*?)"/i);
          if (metaTitle) title = metaTitle[1].trim();
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          title: title || '未知标题',
          content: content || '',
          url,
          wordCount: content.length,
          fetched: !!content
        }));
      } catch (err) {
        console.error('[Fetch] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `抓取失败: ${err.message}` }));
      }
    });
    return;
  }

  // Fetch Xiaohongshu note endpoint
  if (req.method === 'POST' && req.url === '/api/fetch-xhs') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { url } = JSON.parse(body);
        if (!url) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '缺少 url 参数' }));
          return;
        }

        console.log(`[XHS] → ${url}`);

        // Follow redirects for xhslink.com short URLs
        let finalUrl = url;
        if (url.includes('xhslink.com')) {
          try {
            const redirectResp = await fetch(url, {
              redirect: 'follow',
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            finalUrl = redirectResp.url || url;
          } catch(e) { /* use original URL */ }
        }

        const resp = await fetch(finalUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
          }
        });

        if (!resp.ok) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `小红书服务器返回 ${resp.status}` }));
          return;
        }

        const html = await resp.text();
        console.log(`[XHS] ← ${resp.status} (${html.length} bytes)`);

        // Extract title
        let title = '';
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (titleMatch) {
          title = titleMatch[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/ - 小红书/g,'').trim();
        }

        // Extract note content from XHS page
        let content = '';
        let noteType = 'normal';
        let videoUrl = '';
        // Try SSR content first - look for note data in the initial state JSON
        // XHS embeds note data in window.__INITIAL_STATE__ or __INITIAL_SSR_DATA__
        const initialStateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*<\/script>/) ||
                                  html.match(/__INITIAL_SSR_DATA__\s*=\s*({[\s\S]*?})\s*<\/script>/);
        if (initialStateMatch) {
          try {
            // The state JSON may need replacements to be valid
            let stateJson = initialStateMatch[1]
              .replace(/undefined/g, 'null');
            const stateObj = JSON.parse(stateJson);
            // Navigate to note desc - multiple possible paths
            const noteData = stateObj?.note?.noteDetailMap?.[Object.keys(stateObj.note.noteDetailMap)[0]]?.note ||
                           stateObj?.note?.note ||
                           stateObj?.noteDetail;
            if (noteData) {
              content = (noteData.desc || noteData.note_desc || noteData.content || '').trim();
              // Also extract title if not found yet
              if (!title && noteData.title) title = noteData.title;
            }
            // Detect note type and extract video URL
            if (noteData) {
              if (noteData.type === 'video' || noteData.video) {
                noteType = 'video';
                const stream = noteData.video?.media?.stream;
                if (stream) {
                  for (const fmt of ['h264', 'h265', 'av1', 'h266']) {
                    if (stream[fmt]?.length) {
                      const firstStream = stream[fmt][0];
                      // XHS uses camelCase: masterUrl, backupUrls (not master_url, backup_urls)
                      videoUrl = firstStream.masterUrl || firstStream.master_url ||
                                firstStream.backupUrls?.[0] || firstStream.backup_urls?.[0] ||
                                firstStream.url || firstStream.src || '';
                      if (videoUrl) {
                        console.log(`[XHS] Video URL found (${fmt}): ${videoUrl.substring(0, 80)}...`);
                        break;
                      }
                    }
                  }
                }
                // Fallback: try direct video URL fields
                if (!videoUrl && noteData.video) {
                  videoUrl = noteData.video.consumer?.origin_video_key ||
                            noteData.video.url ||
                            noteData.video.media?.origin?.url ||
                            '';
                  if (videoUrl && !videoUrl.startsWith('http')) {
                    videoUrl = '';
                  }
                  if (videoUrl) console.log(`[XHS] Video URL from fallback: ${videoUrl.substring(0, 80)}...`);
                }
              }
            }
          } catch(e) {
            console.log('[XHS] Failed to parse initial state JSON:', e.message);
          }
        }

        // Fallback: try direct desc extraction with CJK content check
        if (!content) {
          const ssrMatch = html.match(/"desc"\s*:\s*"([\s\S]*?)"/) ||
                          html.match(/"note_desc"\s*:\s*"([\s\S]*?)"/);
          if (ssrMatch) {
            const raw = ssrMatch[1]
              .replace(/\\n/g, '\n')
              .replace(/\\u002F/g, '/')
              .replace(/\\u0026/g, '&')
              .replace(/\\+"/g, '"')
              .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
              .trim();
            // Only use if it contains CJK characters (real content, not CSS)
            if (/[\u4e00-\u9fff]/.test(raw)) {
              content = raw;
            }
          }
        }

        // Fallback: try DOM content
        if (!content) {
          const domMatch = html.match(/class="note-text[^"]*"[^>]*>([\s\S]*?)<\/div>/) ||
                          html.match(/id="detail-desc"[^>]*>([\s\S]*?)<\/div>/) ||
                          html.match(/class="desc[^"]*"[^>]*>([\s\S]*?)<\/span>/);
          if (domMatch) {
            content = domMatch[1]
              .replace(/<[^>]+>/g, '')
              .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
              .trim();
          }
        }

        // Extract tags/hashtags - XHS uses #tagname[话题]# format
        let tags = [];
        // Primary: match XHS topic format #标签名[话题]#
        const topicMatches = html.match(/#([^#"<>]+?)\[话题\]#/g);
        if (topicMatches) {
          tags = topicMatches.map(t => t.replace(/#|\[话题\]/g, '').trim()).filter(Boolean);
        }
        // Fallback: match #tag# only if it contains CJK characters (avoid CSS hex colors)
        if (!tags.length) {
          const tagMatches = html.match(/#([\u4e00-\u9fff][^#"<>]*?)#/g);
          if (tagMatches) {
            tags = tagMatches.map(t => t.replace(/#/g, '').trim()).filter(Boolean);
          }
        }
        // Fallback: try from content
        if (!tags.length && content) {
          const contentTagMatches = content.match(/#([^#\s]+?)#/g);
          if (contentTagMatches) {
            tags = contentTagMatches.map(t => t.replace(/#/g, '').trim()).filter(Boolean);
          }
        }

        // Extract from meta as last resort
        if (!title) {
          const metaTitle = html.match(/property="og:title"\s+content="([\s\S]*?)"/i);
          if (metaTitle) title = metaTitle[1].trim();
        }
        if (!content) {
          const metaDesc = html.match(/property="og:description"\s+content="([\s\S]*?)"/i) ||
                          html.match(/name="description"\s+content="([\s\S]*?)"/i);
          if (metaDesc) {
            content = metaDesc[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&nbsp;/g,' ').trim();
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          title: title || '未知标题',
          content: content || '',
          tags: tags,
          noteType,
          videoUrl,
          url,
          wordCount: content.length,
          fetched: !!content
        }));
      } catch (err) {
        console.error('[XHS] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `抓取失败: ${err.message}` }));
      }
    });
    return;
  }

  // [Douyin endpoint moved below - deduplicated]

  // [SPH endpoint moved below - deduplicated]

  // Download XHS video file endpoint
  if (req.method === 'POST' && req.url === '/api/download-xhs-video') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { videoUrl, filename } = JSON.parse(body);
        if (!videoUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '缺少 videoUrl 参数' }));
          return;
        }

        console.log(`[XHS-Download] → ${videoUrl.substring(0, 80)}...`);

        // Download video from XHS CDN with proper headers
        const videoResp = await fetch(videoUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://www.xiaohongshu.com/',
            'Accept': '*/*'
          }
        });

        if (!videoResp.ok) {
          throw new Error(`视频下载失败: HTTP ${videoResp.status}`);
        }

        const videoBuffer = Buffer.from(await videoResp.arrayBuffer());
        const sizeMB = (videoBuffer.length / 1024 / 1024).toFixed(1);
        console.log(`[XHS-Download] Video downloaded: ${sizeMB} MB`);

        // Determine content type from URL or default to mp4
        let contentType = 'video/mp4';
        if (videoUrl.includes('.mov')) contentType = 'video/quicktime';
        else if (videoUrl.includes('.webm')) contentType = 'video/webm';

        // Generate filename
        const safeName = (filename || 'xhs_video').replace(/[<>:"/\\|?*]/g, '_');
        const ext = videoUrl.match(/\.(mp4|mov|webm)/)?.[1] || 'mp4';

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(safeName + '.' + ext)}"`,
          'Content-Length': videoBuffer.length
        });
        res.end(videoBuffer);

      } catch (err) {
        console.error('[XHS-Download] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `视频下载失败: ${err.message}` }));
      }
    });
    return;
  }

  // Fetch XHS video transcript endpoint (video → audio → ASR)
  if (req.method === 'POST' && req.url === '/api/fetch-xhs-video-transcript') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      const tmpFiles = []; // Track temp files for cleanup
      try {
        const { url, dashscopeApiKey } = JSON.parse(body);
        if (!url) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '缺少 url 参数' }));
          return;
        }

        console.log(`[XHS-Video] → ${url}`);

        // Step 1: Check ffmpeg availability
        await new Promise((resolve, reject) => {
          exec('ffmpeg -version', { timeout: 5000 }, (err) => {
            if (err) reject(new Error('ffmpeg 未安装或不在 PATH 中。请安装 ffmpeg: https://ffmpeg.org/download.html'));
            else resolve();
          });
        });

        // Step 2: Fetch XHS page and extract video URL
        let finalUrl = url;
        if (url.includes('xhslink.com')) {
          try {
            const redirectResp = await fetch(url, {
              redirect: 'follow',
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            finalUrl = redirectResp.url || url;
          } catch(e) { /* use original URL */ }
        }

        const pageResp = await fetch(finalUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
          }
        });

        if (!pageResp.ok) {
          throw new Error(`小红书服务器返回 ${pageResp.status}`);
        }

        const html = await pageResp.text();
        console.log(`[XHS-Video] Page fetched: ${html.length} bytes`);

        // Extract video URL from __INITIAL_STATE__
        let videoUrl = '';
        const initialStateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*<\/script>/);
        if (initialStateMatch) {
          try {
            let stateJson = initialStateMatch[1].replace(/undefined/g, 'null');
            const stateObj = JSON.parse(stateJson);
            const noteData = stateObj?.note?.noteDetailMap?.[Object.keys(stateObj.note.noteDetailMap)[0]]?.note ||
                            stateObj?.note?.note;
            if (noteData?.video?.media?.stream) {
              const stream = noteData.video.media.stream;
              for (const fmt of ['h264', 'h265', 'av1']) {
                if (stream[fmt]?.length) {
                  videoUrl = stream[fmt][0].master_url || stream[fmt][0].backup_urls?.[0] || '';
                  if (videoUrl) break;
                }
              }
            }
          } catch(e) {
            console.log('[XHS-Video] Failed to parse initial state:', e.message);
          }
        }

        if (!videoUrl) {
          throw new Error('未找到视频下载链接，可能是图文笔记或页面结构已变更');
        }

        console.log(`[XHS-Video] Video URL: ${videoUrl.substring(0, 80)}...`);

        // Step 3: Download video
        const tmpDir = os.tmpdir();
        const tmpId = crypto.randomBytes(8).toString('hex');
        const videoPath = path.join(tmpDir, `xhs_video_${tmpId}.mp4`);
        const audioPath = path.join(tmpDir, `xhs_audio_${tmpId}.mp3`);
        tmpFiles.push(videoPath, audioPath);

        console.log(`[XHS-Video] Downloading video...`);
        const videoResp = await fetch(videoUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.xiaohongshu.com/'
          }
        });

        if (!videoResp.ok) {
          throw new Error(`视频下载失败: HTTP ${videoResp.status}`);
        }

        const videoBuffer = Buffer.from(await videoResp.arrayBuffer());
        fs.writeFileSync(videoPath, videoBuffer);
        console.log(`[XHS-Video] Video downloaded: ${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB`);

        // Step 4: Extract audio using ffmpeg
        console.log(`[XHS-Video] Extracting audio with ffmpeg...`);
        await new Promise((resolve, reject) => {
          exec(`ffmpeg -y -i "${videoPath}" -vn -acodec libmp3lame -b:a 64k "${audioPath}" 2>&1`,
            { timeout: 120000 },
            (err, stdout, stderr) => {
              if (err) reject(new Error(`ffmpeg 音频提取失败: ${err.message}`));
              else resolve();
            }
          );
        });

        // Check audio file
        const audioStats = fs.statSync(audioPath);
        if (audioStats.size < 1000) {
          throw new Error('提取的音频文件过小，可能提取失败');
        }
        console.log(`[XHS-Video] Audio extracted: ${(audioStats.size / 1024).toFixed(0)} KB`);

        // Step 5: ASR - try local faster-whisper first, fallback to DashScope
        let transcript = '';
        let asrMethod = '';

        // --- Try local ASR (faster-whisper on port 3211) ---
        try {
          console.log(`[XHS-Video] Trying local ASR (faster-whisper)...`);
          const localAsrResp = await fetch('http://localhost:3211/asr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio_path: audioPath }),
            signal: AbortSignal.timeout(300000) // 5 min timeout for first load
          });

          if (localAsrResp.ok) {
            const localAsrData = await localAsrResp.json();
            if (localAsrData.success && localAsrData.transcript) {
              transcript = localAsrData.transcript;
              asrMethod = 'local (faster-whisper)';
              console.log(`[XHS-Video] Local ASR success: ${transcript.length} chars`);
            }
          }
        } catch (e) {
          console.log(`[XHS-Video] Local ASR not available: ${e.message}`);
        }

        // --- Fallback: DashScope SenseVoice API ---
        if (!transcript && dashscopeApiKey) {
          console.log(`[XHS-Video] Falling back to DashScope ASR (sensevoice-v1)...`);
          const audioBase64 = fs.readFileSync(audioPath).toString('base64');
          const audioDataUri = `data:audio/mp3;base64,${audioBase64}`;

          const asrResp = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${dashscopeApiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'sensevoice-v1',
              input: {
                messages: [{
                  role: 'user',
                  content: [{ audio: audioDataUri }]
                }]
              },
              parameters: {}
            })
          });

          if (asrResp.ok) {
            const asrData = await asrResp.json();
            if (asrData.output?.choices?.[0]?.message?.content) {
              const content = asrData.output.choices[0].message.content;
              if (Array.isArray(content)) {
                transcript = content.filter(c => c.text).map(c => c.text).join('');
              } else if (typeof content === 'string') {
                transcript = content;
              }
            }
            asrMethod = 'cloud (DashScope sensevoice-v1)';
          } else {
            const errText = await asrResp.text();
            console.log(`[XHS-Video] DashScope ASR failed (${asrResp.status}): ${errText.substring(0, 200)}`);
          }
        }

        if (!transcript) {
          throw new Error('语音转写失败：本地 ASR 未启动，且 DashScope API 不可用。请启动 asr_server.py 或检查 DashScope 配额。');
        }

        console.log(`[XHS-Video] Transcript (${asrMethod}): ${transcript.length} chars`);

        // Step 6: Clean up temp files and return
        tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          transcript,
          asrMethod,
          videoUrl,
          audioSize: audioStats.size,
          videoSize: videoBuffer.length,
          success: true
        }));

      } catch (err) {
        console.error('[XHS-Video] Error:', err.message);
        // Clean up temp files on error
        tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `视频语音转写失败: ${err.message}` }));
      }
    });
    return;
  }

  // Fetch Douyin video/note endpoint — uses Web API + a_bogus signature
  if (req.method === 'POST' && req.url === '/api/fetch-douyin') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { url } = JSON.parse(body);
        if (!url) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '缺少 url 参数' }));
          return;
        }

        console.log(`[Douyin] → ${url}`);

        // Step 1: Resolve short URLs to get the real URL with video ID
        let finalUrl = url;
        let videoId = extractDouyinVideoId(url);

        if (!videoId && (url.includes('v.douyin.com') || url.includes('douyin.com/share'))) {
          try {
            const redirectResp = await fetch(url, {
              redirect: 'follow',
              headers: { 'User-Agent': USER_AGENT }
            });
            finalUrl = redirectResp.url || url;
            videoId = extractDouyinVideoId(finalUrl);
          } catch(e) { /* keep original URL */ }
        }

        if (!videoId) {
          // Fallback: try to extract from URL pattern directly
          const idMatch = url.match(/(\d{15,})/);
          if (idMatch) videoId = idMatch[1];
        }

        let title = '';
        let content = '';
        let noteType = 'video';
        let videoUrl = '';
        let author = '';
        let tags = [];

        // Step 2: Try Douyin Web Detail API (primary strategy)
        if (videoId) {
          console.log(`[Douyin] Using Web API for video ID: ${videoId}`);

          // 2a. Get ttwid and msToken
          const ttwid = await getTtwid();
          const msToken = getFakeMsToken();

          // 2b. Build API params
          const params = {
            device_platform: 'webapp',
            aid: '6383',
            channel: 'channel_pc_web',
            aweme_id: videoId,
            pc_client_type: '1',
            version_code: '170400',
            version_name: '17.4.0',
            cookie_enabled: 'true',
            platform: 'PC',
            downlink: '10',
          };
          if (msToken) params.msToken = msToken;

          // 2c. Generate a_bogus signature
          const queryString = new URLSearchParams(params).toString();
          const aBogus = getABogus(queryString);
          if (aBogus) params.a_bogus = aBogus;

          // 2d. Call the detail API
          try {
            const cookieStr = generateDouyinCookieStr(ttwid, msToken);
            const apiResp = await fetch('https://www.douyin.com/aweme/v1/web/aweme/detail/?' + new URLSearchParams(params).toString(), {
              headers: {
                'User-Agent': USER_AGENT,
                'Referer': REFERER,
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'zh-CN,zh;q=0.9',
                'Cookie': cookieStr
              }
            });

            const apiText = await apiResp.text();
            console.log(`[Douyin] API status: ${apiResp.status}, response: ${apiText.length} bytes`);

            if (apiText.length > 0) {
              try {
                const apiData = JSON.parse(apiText);
                const aweme = apiData?.aweme_detail;

                if (aweme) {
                  title = (aweme.desc || '').trim();
                  content = title; // For douyin, desc is both title and content
                  author = aweme.author?.nickname || '';

                  // Detect media type
                  if (aweme.images && aweme.images.length > 0) {
                    noteType = 'image';
                  } else if (aweme.video) {
                    noteType = 'video';
                    const video = aweme.video;

                    // Extract video URL from play_addr
                    const playAddr = video.play_addr || video.playAddr;
                    if (playAddr) {
                      if (Array.isArray(playAddr.url_list) && playAddr.url_list.length > 0) {
                        videoUrl = playAddr.url_list[0];
                      } else if (playAddr.url) {
                        videoUrl = playAddr.url;
                      }
                      if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
                    }

                    // Fallback: try bit_rate for higher quality
                    if (!videoUrl && video.bit_rate) {
                      const rates = Array.isArray(video.bit_rate) ? video.bit_rate : [];
                      if (rates.length) {
                        const best = rates.sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))[0];
                        const playUrl = best.play_addr || best.playAddr;
                        if (playUrl) {
                          videoUrl = Array.isArray(playUrl.url_list) ? playUrl.url_list[0] : (playUrl.url || '');
                          if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
                        }
                      }
                    }
                  }

                  // Extract tags from text_extra
                  if (aweme.text_extra) {
                    tags = aweme.text_extra
                      .filter(t => t.hashtag_name)
                      .map(t => t.hashtag_name)
                      .slice(0, 20);
                  }

                  console.log(`[Douyin] API success: title="${title.substring(0, 30)}" type=${noteType} videoUrl=${!!videoUrl}`);
                }
              } catch(e) {
                console.log('[Douyin] API JSON parse error:', e.message);
              }
            }
          } catch(e) {
            console.log('[Douyin] Web API error:', e.message);
          }
        }

        // Step 3: Fallback — try iesdouyin share page for meta tags (title/desc only)
        if (!content && videoId) {
          console.log('[Douyin] Fallback: trying iesdouyin share page');
          try {
            const shareResp = await fetch(`https://www.iesdouyin.com/share/video/${videoId}/`, {
              headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15', 'Accept': 'text/html' }
            });
            const shareHtml = await shareResp.text();

            // Meta description
            const metaDesc = shareHtml.match(/name="description"\s+content="([^"]+)"/i);
            if (metaDesc) {
              const raw = metaDesc[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
              if (/[\u4e00-\u9fff]/.test(raw) && raw.length > 5) {
                content = raw;
                if (!title) title = raw;
              }
            }

            // Meta title
            if (!title) {
              const metaTitle = shareHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
              if (metaTitle) title = metaTitle[1].replace(/ - 抖音/g, '').replace(/抖音/g, '').trim();
            }

            // Try _ROUTER_DATA for video info
            const routerMatch = shareHtml.match(/window\._ROUTER_DATA\s*=\s*({[\s\S]*?})\s*;?\s*<\/script>/);
            if (routerMatch) {
              try {
                const routerData = JSON.parse(routerMatch[1]);
                const pageData = routerData?.loaderData?.['video_(id)/page'];
                if (pageData) {
                  // The pageData might contain useful info in future API versions
                  console.log('[Douyin] ROUTER_DATA page keys:', Object.keys(pageData));
                }
              } catch(e) {}
            }

            // Extract tags from hashtags in content
            if (!tags.length) {
              const topicMatches = shareHtml.match(/#([^#"<>]+?)#/g);
              if (topicMatches) {
                tags = topicMatches.map(t => t.replace(/#/g, '').trim())
                  .filter(t => t && /[\u4e00-\u9fff]/.test(t)).slice(0, 20);
              }
            }

            console.log(`[Douyin] Fallback result: title="${title.substring(0, 30)}" content=${content.length}chars`);
          } catch(e) {
            console.log('[Douyin] Fallback share page error:', e.message);
          }
        }

        // If we still have nothing, try original web page fetch for meta tags
        if (!content && !title) {
          try {
            const webResp = await fetch(finalUrl, {
              headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html', 'Referer': REFERER }
            });
            const webHtml = await webResp.text();

            const metaTitle = webHtml.match(/property="og:title"\s+content="([\s\S]*?)"/i);
            if (metaTitle) title = metaTitle[1].trim();

            const metaDesc = webHtml.match(/property="og:description"\s+content="([\s\S]*?)"/i);
            if (metaDesc) {
              const raw = metaDesc[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
              if (/[\u4e00-\u9fff]/.test(raw)) content = raw;
            }
          } catch(e) {}
        }

        console.log(`[Douyin] Final: title="${(title || '').substring(0, 30)}" type=${noteType} video=${!!videoUrl} content=${content.length}chars`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          title: title || '未知标题',
          content: content || '',
          tags,
          noteType,
          videoUrl,
          author,
          url: finalUrl,
          wordCount: content.length,
          fetched: !!(content || title)
        }));
      } catch (err) {
        console.error('[Douyin] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `抖音抓取失败: ${err.message}` }));
      }
    });
    return;
  }

  // Fetch WeChat Channels (视频号) endpoint
  if (req.method === 'POST' && req.url === '/api/fetch-sph') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { url } = JSON.parse(body);
        if (!url) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '缺少 url 参数' }));
          return;
        }

        console.log(`[SPH] → ${url}`);

        const resp = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
          }
        });

        if (!resp.ok) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `服务器返回 ${resp.status}` }));
          return;
        }

        const html = await resp.text();
        console.log(`[SPH] ← ${resp.status} (${html.length} bytes)`);

        let title = '';
        let content = '';
        let noteType = 'video'; // 视频号默认为视频类型
        let videoUrl = '';
        let author = '';

        // Extract title
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (titleMatch) {
          title = titleMatch[1]
            .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
            .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
            .trim();
        }

        if (!title) {
          const metaTitle = html.match(/property="og:title"\s+content="([\s\S]*?)"/i);
          if (metaTitle) title = metaTitle[1].trim();
        }

        if (!title || title === '微信') {
          const msgTitle = html.match(/var msg_title\s*=\s*'([\s\S]*?)'/i) ||
                          html.match(/var msg_title\s*=\s*"([\s\S]*?)"/i);
          if (msgTitle) title = msgTitle[1].trim();
        }

        // Extract content/description
        const metaDesc = html.match(/property="og:description"\s+content="([\s\S]*?)"/i) ||
                        html.match(/name="description"\s+content="([\s\S]*?)"/i);
        if (metaDesc) {
          content = metaDesc[1]
            .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
            .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
            .trim();
        }

        // Fallback: try js_content div (same as WeChat articles)
        if (!content) {
          const contentMatch = html.match(/id="js_content"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i) ||
                             html.match(/class="rich_media_content"[^>]*>([\s\S]*?)<\/div>/i);
          if (contentMatch) {
            content = contentMatch[1]
              .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')
              .replace(/<[^>]+>/g, '')
              .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
              .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
              .replace(/\n{3,}/g, '\n\n').trim();
          }
        }

        // Fallback: desc from embedded data
        if (!content) {
          const descMatch = html.match(/"desc"\s*:\s*"([\s\S]*?)"/);
          if (descMatch) {
            const raw = descMatch[1]
              .replace(/\\n/g, '\n').replace(/&amp;/g,'&').replace(/&lt;/g,'<')
              .replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&nbsp;/g,' ').trim();
            if (/[\u4e00-\u9fff]/.test(raw)) content = raw;
          }
        }

        // Extract video URL from mpvideo or finder
        const mpvideoMatch = html.match(/data-mpvid="([^"]+)"/) ||
                            html.match(/mpvid\s*=\s*"([^"]+)"/) ||
                            html.match(/"mpvid"\s*:\s*"([^"]+)"/);
        if (mpvideoMatch) {
          videoUrl = mpvideoMatch[1];
          console.log(`[SPH] mpvid found: ${videoUrl}`);
        }

        // Try to find video src directly
        if (!videoUrl) {
          const videoSrcMatch = html.match(/<video[^>]+src="([^"]+)"/i) ||
                               html.match(/"video_url"\s*:\s*"([^"]+)"/i) ||
                               html.match(/"playUrl"\s*:\s*"([^"]+)"/i);
          if (videoSrcMatch) {
            videoUrl = videoSrcMatch[1];
            if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
          }
        }

        // Extract author
        const authorMatch = html.match(/class="profile_nickname"[^>]*>([\s\S]*?)<\/a>/i) ||
                           html.match(/"nickname"\s*:\s*"([\s\S]*?)"/i) ||
                           html.match(/var nickname\s*=\s*'([\s\S]*?)'/i);
        if (authorMatch) author = authorMatch[1].trim();

        // Extract tags
        let tags = [];
        const topicMatches = html.match(/#([^#"<>]+?)#/g);
        if (topicMatches) {
          tags = topicMatches
            .map(t => t.replace(/#/g, '').trim())
            .filter(t => t && /[\u4e00-\u9fff]/.test(t))
            .slice(0, 20);
        }

        console.log(`[SPH] Result: title="${title.substring(0,30)}" content=${content.length}chars video=${!!videoUrl}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          title: title || '未知标题',
          content: content || '',
          tags,
          noteType,
          videoUrl,
          author,
          url,
          wordCount: content.length,
          fetched: !!content
        }));
      } catch (err) {
        console.error('[SPH] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `视频号抓取失败: ${err.message}` }));
      }
    });
    return;
  }

  // === Local file upload endpoint ===
  if (req.method === 'POST' && req.url === '/api/upload-file') {
    const boundary = req.headers['content-type']?.split('boundary=')[1];
    if (!boundary) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid multipart request' }));
      return;
    }

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks);
        const boundaryStr = `--${boundary}`;
        const parts = [];
        let start = 0;

        // Parse multipart
        while (true) {
          const bStart = raw.indexOf(boundaryStr, start);
          if (bStart === -1) break;
          const bEnd = raw.indexOf(boundaryStr, bStart + boundaryStr.length);
          if (bEnd === -1) break;

          const part = raw.slice(bStart + boundaryStr.length + 2, bEnd - 2); // skip \r\n
          // Find header/body separator
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) { start = bEnd; continue; }

          const headerStr = part.slice(0, headerEnd).toString();
          const body = part.slice(headerEnd + 4);

          // Extract filename from Content-Disposition
          const nameMatch = headerStr.match(/name="([^"]+)"/);
          const fileMatch = headerStr.match(/filename="([^"]+)"/);
          if (nameMatch) {
            parts.push({
              name: nameMatch[1],
              filename: fileMatch ? fileMatch[1] : null,
              data: body
            });
          }
          start = bEnd;
        }

        const filePart = parts.find(p => p.filename);
        if (!filePart) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No file found in upload' }));
          return;
        }

        // Save to temp dir
        const tmpDir = path.join(os.tmpdir(), 'yunchufu_uploads');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        const fileId = crypto.randomBytes(8).toString('hex');
        const safeName = filePart.filename.replace(/[<>:"/\\|?*]/g, '_');
        const tmpPath = path.join(tmpDir, `${fileId}_${safeName}`);
        fs.writeFileSync(tmpPath, filePart.data);

        const ext = path.extname(safeName).toLowerCase();
        const sizeMB = (filePart.data.length / 1024 / 1024).toFixed(1);
        console.log(`[Upload] Saved: ${safeName} (${sizeMB} MB, ${ext})`);

        // Determine file type
        let fileType = 'unknown';
        if (['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv'].includes(ext)) fileType = 'video';
        else if (['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.wma'].includes(ext)) fileType = 'audio';
        else if (['.txt', '.md', '.text'].includes(ext)) fileType = 'text';
        else if (ext === '.pdf') fileType = 'pdf';
        else if (['.doc', '.docx'].includes(ext)) fileType = 'docx';

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          filename: safeName,
          filePath: tmpPath,
          fileType,
          fileSize: filePart.data.length,
          ext
        }));
      } catch (err) {
        console.error('[Upload] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `文件上传失败: ${err.message}` }));
      }
    });
    return;
  }

  // === Transcribe local video/audio file ===
  if (req.method === 'POST' && req.url === '/api/transcribe-local-file') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      const tmpFiles = [];
      try {
        const { filePath, dashscopeApiKey } = JSON.parse(body);
        if (!filePath || !fs.existsSync(filePath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '文件不存在' }));
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const isVideo = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv'].includes(ext);
        const isAudio = ['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.wma'].includes(ext);

        if (!isVideo && !isAudio) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '不支持的文件格式，仅支持视频和音频文件' }));
          return;
        }

        let audioPath = filePath;
        let needCleanup = false;

        // If video, extract audio first
        if (isVideo) {
          console.log(`[Local-ASR] Extracting audio from video...`);
          // Check ffmpeg
          await new Promise((resolve, reject) => {
            exec('ffmpeg -version', { timeout: 5000 }, (err) => {
              if (err) reject(new Error('ffmpeg 未安装'));
              else resolve();
            });
          });

          const tmpDir = os.tmpdir();
          const tmpId = crypto.randomBytes(8).toString('hex');
          audioPath = path.join(tmpDir, `local_audio_${tmpId}.mp3`);
          tmpFiles.push(audioPath);
          needCleanup = true;

          await new Promise((resolve, reject) => {
            exec(`ffmpeg -y -i "${filePath}" -vn -acodec libmp3lame -b:a 64k "${audioPath}" 2>&1`,
              { timeout: 120000 },
              (err) => {
                if (err) reject(new Error(`ffmpeg 音频提取失败: ${err.message}`));
                else resolve();
              }
            );
          });

          const audioStats = fs.statSync(audioPath);
          if (audioStats.size < 1000) {
            throw new Error('提取的音频文件过小，可能提取失败');
          }
          console.log(`[Local-ASR] Audio extracted: ${(audioStats.size / 1024).toFixed(0)} KB`);
        }

        // Call local ASR (faster-whisper on port 3211)
        let transcript = '';
        let asrMethod = '';

        try {
          console.log(`[Local-ASR] Calling local ASR...`);
          const localAsrResp = await fetch('http://localhost:3211/asr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio_path: audioPath }),
            signal: AbortSignal.timeout(300000)
          });

          if (localAsrResp.ok) {
            const localAsrData = await localAsrResp.json();
            if (localAsrData.success && localAsrData.transcript) {
              transcript = localAsrData.transcript;
              asrMethod = 'local (faster-whisper)';
            }
          }
        } catch (e) {
          console.log(`[Local-ASR] Local ASR not available: ${e.message}`);
        }

        // --- Fallback: DashScope SenseVoice API ---
        if (!transcript && dashscopeApiKey) {
          console.log(`[Local-ASR] Falling back to DashScope ASR (sensevoice-v1)...`);
          const audioBase64 = fs.readFileSync(audioPath).toString('base64');
          const audioDataUri = `data:audio/mp3;base64,${audioBase64}`;

          const asrResp = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${dashscopeApiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'sensevoice-v1',
              input: {
                messages: [{
                  role: 'user',
                  content: [{ audio: audioDataUri }]
                }]
              },
              parameters: {}
            })
          });

          if (asrResp.ok) {
            const asrData = await asrResp.json();
            if (asrData.output?.choices?.[0]?.message?.content) {
              const content = asrData.output.choices[0].message.content;
              if (Array.isArray(content)) {
                transcript = content.filter(c => c.text).map(c => c.text).join('');
              } else if (typeof content === 'string') {
                transcript = content;
              }
            }
            asrMethod = 'cloud (DashScope sensevoice-v1)';
          } else {
            const errText = await asrResp.text();
            console.log(`[Local-ASR] DashScope ASR failed (${asrResp.status}): ${errText.substring(0, 200)}`);
          }
        }

        // Cleanup
        if (needCleanup) {
          tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
        }

        if (!transcript) {
          throw new Error('语音转写失败：本地 ASR 未启动，且 DashScope API 不可用。请启动 asr_server.py 或在设置中配置 DashScope API Key。');
        }

        console.log(`[Local-ASR] Transcript (${asrMethod}): ${transcript.length} chars`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          transcript,
          asrMethod,
          success: true
        }));

      } catch (err) {
        console.error('[Local-ASR] Error:', err.message);
        tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `转写失败: ${err.message}` }));
      }
    });
    return;
  }

  // === Extract text from local file (txt/md/pdf) ===
  if (req.method === 'POST' && req.url === '/api/extract-local-text') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { filePath } = JSON.parse(body);
        if (!filePath || !fs.existsSync(filePath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '文件不存在' }));
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        let content = '';
        let title = path.basename(filePath, ext);

        if (['.txt', '.md', '.text'].includes(ext)) {
          // Direct read text file
          const buf = fs.readFileSync(filePath);
          // Try UTF-8 first, fallback to GBK
          content = buf.toString('utf-8');
          if (content.includes('') || content.includes('')) {
            // Garbled - try GBK via iconv not available, just use utf-8
          }
          console.log(`[Local-Text] Read ${ext} file: ${content.length} chars`);

        } else if (ext === '.pdf') {
          // Use Python pdfplumber to extract
          const script = `
import pdfplumber, json, sys
try:
    text_parts = []
    pdf_title = ""
    with pdfplumber.open(sys.argv[1]) as pdf:
        # Try to get title from metadata
        if pdf.metadata and pdf.metadata.get("title"):
            pdf_title = pdf.metadata["title"].strip()
        for page in pdf.pages:
            t = page.extract_text()
            if t: text_parts.append(t)
        # If no metadata title, use first line of first page
        if not pdf_title and text_parts:
            first_line = text_parts[0].strip().split("\\n")[0].strip()
            if len(first_line) < 100:
                pdf_title = first_line
    print(json.dumps({"text": "\\n".join(text_parts), "title": pdf_title, "success": True}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"text": "", "title": "", "success": False, "error": str(e)}, ensure_ascii=False))
`;
          const scriptPath = path.join(os.tmpdir(), `pdf_extract_${crypto.randomBytes(4).toString('hex')}.py`);
          fs.writeFileSync(scriptPath, script);

          const result = await new Promise((resolve, reject) => {
            exec(`python "${scriptPath}" "${filePath}"`, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
              try { fs.unlinkSync(scriptPath); } catch(e) {}
              if (err) reject(new Error(`PDF 提取失败: ${err.message}`));
              else resolve(stdout);
            });
          });

          const pdfData = JSON.parse(result);
          if (!pdfData.success) {
            throw new Error(pdfData.error || 'PDF 提取失败');
          }
          content = pdfData.text;
          console.log(`[Local-Text] PDF extracted: ${content.length} chars`);

        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `不支持的文件格式: ${ext}` }));
          return;
        }

        if (!content || content.trim().length === 0) {
          throw new Error('文件内容为空');
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          title,
          content: content.trim(),
          success: true
        }));

      } catch (err) {
        console.error('[Local-Text] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `文本提取失败: ${err.message}` }));
      }
    });
    return;
  }

  // ======== Douyin Batch Download APIs ========

  // 设置抖音 Cookie
  if (req.method === 'POST' && req.url === '/api/douyin-set-cookie') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { cookie } = JSON.parse(body);
        if (!cookie) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '缺少 cookie 参数' }));
          return;
        }
        const cookiePath = path.join(__dirname, 'douyin_download', 'cookies.json');
        // 解析 cookie 字符串为 key-value 对
        const cookies = {};
        const cookiesKey = ['passport_csrf_token','passport_csrf_token_default','d_ticket',
          'sessionid','sessionid_ss','sid_guard','sid_tt','uid_tt','uid_tt_ss',
          's_v_web_id','__ac_signature','ttwid','odin_tt','n_mh','passport_assist_user',
          'passport_mfa_token','bd_ticket_guard_client_web_domain','publish_badge_show_info',
          'strategyABtestKey','download_guide','__security_server_data_status','dy_swidth','dy_sheight'];
        const matches = cookie.matchAll(/([^=;,]+)=([^;,]+)/g);
        for (const m of matches) {
          const k = m[1].trim();
          const v = m[2].trim();
          if (cookiesKey.includes(k)) cookies[k] = v;
        }
        fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 4), 'utf-8');
        const hasSession = !!cookies.sessionid_ss;
        console.log(`[Douyin-Batch] Cookie saved, keys: ${Object.keys(cookies).length}, has session: ${hasSession}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, keys: Object.keys(cookies).length, hasSession }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Cookie 设置失败: ${err.message}` }));
      }
    });
    return;
  }

  // 查询 Cookie 状态
  if (req.method === 'GET' && req.url === '/api/douyin-cookie-status') {
    try {
      const cookiePath = path.join(__dirname, 'douyin_download', 'cookies.json');
      if (fs.existsSync(cookiePath)) {
        let raw = fs.readFileSync(cookiePath, 'utf-8');
        // Strip BOM if present
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.substring(1);
        const cookies = JSON.parse(raw);
        const hasSession = !!cookies.sessionid_ss;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ exists: true, hasSession, keys: Object.keys(cookies).length }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ exists: false, hasSession: false, keys: 0 }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 启动批量下载任务
  if (req.method === 'POST' && req.url === '/api/douyin-batch-download') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { url, earliest, latest, saveFolder, concurrency } = JSON.parse(body);
        if (!url) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '缺少 url 参数' }));
          return;
        }

        const taskId = 'dy_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const task = {
          id: taskId,
          status: 'running',
          account: '',
          total: 0,
          downloaded: 0,
          skipped: 0,
          failed: 0,
          current: '',
          items: [],
          error: null,
          startTime: Date.now()
        };
        douyinBatchTasks[taskId] = task;

        // 构建配置 JSON 传给 Python
        const config = {
          url,
          earliest: earliest || '',
          latest: latest || '',
          save_folder: saveFolder || DEFAULT_SAVE_FOLDER,
          concurrency: concurrency || 5
        };

        console.log(`[Douyin-Batch] Starting task ${taskId} for ${url}`);
        const { spawn } = require('child_process');
        const pyProc = spawn(PYTHON_CMD, ['batch_download.py'], {
          cwd: path.join(__dirname, 'douyin_download'),
          stdio: ['pipe', 'pipe', 'pipe']
        });

        // 写入配置到 stdin
        pyProc.stdin.write(JSON.stringify(config));
        pyProc.stdin.end();

        // 解析 stdout JSON 行
        let stdoutBuf = '';
        pyProc.stdout.on('data', (data) => {
          stdoutBuf += data.toString();
          const lines = stdoutBuf.split('\n');
          stdoutBuf = lines.pop(); // 保留不完整的行
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const msg = JSON.parse(trimmed);
              if (msg.type === 'start') {
                task.account = msg.account || '';
              } else if (msg.type === 'info') {
                task.total = msg.total || 0;
              } else if (msg.type === 'progress') {
                if (msg.status === 'downloaded') task.downloaded++;
                else if (msg.status === 'skipped') task.skipped++;
                else if (msg.status === 'failed') task.failed++;
                task.current = msg.title || '';
                task.items.push(msg);
              } else if (msg.type === 'done') {
                task.status = 'done';
                task.downloaded = msg.downloaded || task.downloaded;
                task.skipped = msg.skipped || task.skipped;
                task.failed = msg.failed || task.failed;
              } else if (msg.type === 'error') {
                task.status = 'error';
                task.error = msg.message;
              }
            } catch (e) {
              // 非 JSON 行，忽略
            }
          }
        });

        pyProc.stderr.on('data', (data) => {
          console.log(`[Douyin-Batch] stderr: ${data.toString().trim()}`);
        });

        pyProc.on('close', (code) => {
          if (task.status === 'running') {
            task.status = code === 0 ? 'done' : 'error';
          }
          console.log(`[Douyin-Batch] Task ${taskId} finished, code: ${code}, downloaded: ${task.downloaded}, skipped: ${task.skipped}, failed: ${task.failed}`);
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ taskId }));
      } catch (err) {
        console.error('[Douyin-Batch] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `批量下载启动失败: ${err.message}` }));
      }
    });
    return;
  }

  // 查询批量下载任务状态
  if (req.method === 'GET' && req.url.startsWith('/api/douyin-batch-status')) {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const taskId = urlObj.searchParams.get('taskId');
    if (!taskId || !douyinBatchTasks[taskId]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '任务不存在' }));
      return;
    }
    const task = douyinBatchTasks[taskId];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(task));
    return;
  }

  // Static file serving
  let filePath = req.url === '/' ? '/yunchufu.html' : req.url;
  // Remove query strings
  filePath = filePath.split('?')[0];
  const fullPath = path.join(__dirname, filePath);

  // Security: only serve files from this directory
  if (!fullPath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(fullPath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('🦆 雲初馥 - 本地代理服务器已启动');
  console.log(`   访问: http://localhost:${PORT}`);
  console.log(`   API代理: http://localhost:${PORT}/api/proxy`);
  console.log('');
  console.log('   此服务器解决了浏览器直接调用 AI API 的跨域问题');
  console.log('   按 Ctrl+C 停止服务器');
  console.log('');
});

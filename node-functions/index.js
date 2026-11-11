import { handleRequest } from '../danmu_api/worker.js';

// gzip 压缩（可选能力，多路径兜底）：node:zlib → zlib → CompressionStream，全部不可用时不压缩。
// 背景：EdgeOne 函数响应流存在约 30 秒的时长上限，且流式下发速度约 120KB/s，
// 未压缩的大弹幕 JSON（4MB+）会在传完前被切断，客户端拿到截断的坏 JSON。
// gzip 后体积约 1/6，可在时限内传完，同时大幅提升弱网/跨境下的加载速度。
const gzipHelpers = (async () => {
  try {
    const m = await import('node:zlib');
    if (m && m.gzipSync) return { kind: 'node:zlib', fn: (buf) => m.gzipSync(buf) };
  } catch (e) { /* try next */ }
  try {
    const m = await import('zlib');
    if (m && m.gzipSync) return { kind: 'zlib', fn: (buf) => m.gzipSync(buf) };
  } catch (e) { /* try next */ }
  return null;
})();

async function gzipCompress(text) {
  const h = await gzipHelpers;
  if (h) return { bytes: h.fn(Buffer.from(text, 'utf8')), via: h.kind };
  if (typeof CompressionStream === 'function' && typeof Blob === 'function') {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    return { bytes: new Uint8Array(buf), via: 'CompressionStream' };
  }
  return null;
}

function readHeader(request, name) {
  const lower = name.toLowerCase();
  try {
    if (request.headers && typeof request.headers.get === 'function') {
      const v = request.headers.get(name);
      if (v) return v;
    }
  } catch (e) { /* fall through */ }
  try {
    const h = request.headers || {};
    if (typeof h.forEach === 'function') {
      let out = '';
      h.forEach((v, k) => { if (String(k).toLowerCase() === lower) out = v; });
      if (out) return out;
    }
    for (const k of Object.keys(h)) {
      if (k.toLowerCase() === lower) return String(h[k]);
    }
  } catch (e) { /* ignore */ }
  return '';
}

export const onRequest = async (context) => {
  const { request, env } = context;
  // HEAD 请求直接返回200（用于播放器连通性测试，如Hills Lite）
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // 获取协议和主机名，使用属性访问而非 get 方法
  const baseUrl = `https://localhost`;

  // 调试：打印 headers 和原始 URL
  console.log('Request URL:', request.url);
  console.log('Request Headers:', request.headers);

  // 构造完整的 URL
  let fullUrl;
  try {
    let targetUrl = request.url;

    // 判断是否包含 node-functions/index.js，如果是则用 / 代替
    if (request.url.includes('node-functions/index.js')) {
      targetUrl = '/';
    }

    fullUrl = new URL(targetUrl, baseUrl).toString();
    console.log('Request fullUrl:', fullUrl);
  } catch (error) {
    console.error('URL Construction Error:', error);
    return new Response('Invalid URL', { status: 400 });
  }

  // 创建新的 request 对象，替换 url
  // 修复：原写法 body: JSON.stringify(request.body) 会把请求体流序列化成 {}，
  // 导致 POST 接口（match / segmentcomment）丢 body。改为仅非 GET/HEAD 时
  // 把 body 原样读出后转发（读成 ArrayBuffer，避免流式 body 在 Node 运行时需要 duplex 的坑）。
  const requestInit = {
    method: request.method,
    headers: request.headers,
    redirect: request.redirect,
    credentials: request.credentials,
    cache: request.cache,
    mode: request.mode
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const rawBody = await request.arrayBuffer();
    if (rawBody.byteLength > 0) requestInit.body = rawBody;
  }
  const modifiedRequest = new Request(fullUrl, requestInit);

  // 获取客户端 IP 地址
  let clientIp = 'unknown';

  // 尝试从 EO-Connecting-IP 获取客户端 IP
  clientIp = request.headers['eo-connecting-ip'];
  if (!clientIp) {
    // 如果 EO-Connecting-IP 不存在，尝试从 X-Forwarded-For 获取
    const forwardedFor = request.headers['x-forwarded-for'];
    if (forwardedFor) {
      // X-Forwarded-For 可能包含多个 IP 地址，选择第一个（最原始客户端 IP）
      clientIp = forwardedFor.split(',')[0].trim();
    }
  }

  // 传递修改后的 request 和 env 给 handleRequest
  const response = await handleRequest(modifiedRequest, env, "edgeone", clientIp);

  // 边缘CDN缓存：只对有内容的GET响应加缓存头，避免缓存空结果
  if (request.method === 'GET' && response.status === 200) {
    try {
      const url = new URL(request.url);
      const p = url.pathname;
      if (p.includes('/comment/') || p.includes('/search/') || p.includes('/bangumi/')) {
        const text = await response.text();
        let shouldCache = true;
        try {
          const j = JSON.parse(text);
          if (p.includes('/comment/') && (!j.count || j.count === 0)) shouldCache = false;
          if (p.includes('/search/') && (!j.animes || j.animes.length === 0)) shouldCache = false;
          if (p.includes('/bangumi/') && (!j.bangumi || !j.bangumi.episodes || j.bangumi.episodes.length === 0)) shouldCache = false;
        } catch (e) {
          shouldCache = false;
        }
        const newHeaders = new Headers(response.headers);
        if (shouldCache) {
          newHeaders.set('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
        } else {
          newHeaders.set('Cache-Control', 'no-store');
        }
        // 按 Accept-Encoding 区分缓存变体，避免把压缩版发给不接受压缩的客户端
        newHeaders.set('Vary', 'Accept-Encoding');

        // 大 JSON 且客户端接受 gzip 时压缩下发（见文件头说明）；X-Danmu-Gzip 标注实际路径便于线上核查
        let body = text;
        const acceptEncoding = readHeader(request, 'accept-encoding');
        newHeaders.set('X-Danmu-Ae', acceptEncoding ? acceptEncoding.slice(0, 60) : 'none');
        // CDN 会把 Accept-Encoding 改写成 identity，函数永远看不到客户端真实编码支持；
        // 弹幕正文路径一律按播放器处理并压缩（播放器网络栈均支持 gzip），否则大响应必被时长上限截断
        const assumeGzip = !acceptEncoding.includes('gzip') && p.includes('/comment/');
        if (!acceptEncoding.includes('gzip') && !assumeGzip) {
          newHeaders.set('X-Danmu-Gzip', 'client-no-gzip');
        } else if (text.length < 65536) {
          newHeaders.set('X-Danmu-Gzip', 'small');
        } else if (newHeaders.get('Content-Encoding')) {
          newHeaders.set('X-Danmu-Gzip', 'already-encoded');
        } else {
          try {
            const r = await gzipCompress(text);
            if (r) {
              body = r.bytes;
              newHeaders.set('Content-Encoding', 'gzip');
              newHeaders.delete('Content-Length');
              newHeaders.set('X-Danmu-Gzip', assumeGzip ? r.via + '+assumed' : r.via);
            } else {
              newHeaders.set('X-Danmu-Gzip', 'unavailable');
            }
          } catch (e) {
            console.error('gzip compress error (fallback to identity):', e);
            newHeaders.set('X-Danmu-Gzip', 'error');
            body = text;
          }
        }
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      }
    } catch (e) {
      console.error('Cache header wrap error:', e);
    }
  }

  return response;
};

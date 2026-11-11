import { handleRequest } from '../danmu_api/worker.js';

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
        return new Response(text, {
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

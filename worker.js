// worker.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = request.headers.get('Host') || url.host;

    // 基于 CNAME 自动识别目标网站（可扩展为 KV 存储）
    const domainMap = {
      'cf.2xnz.qzz.io': 'example.com'  // 示例：用户 CNAME 指向此域名时，代理到 example.com
    };

    const targetHost = domainMap[host] || 'default.target.com';

    // 测速缓存键：用户IP + 基于 CNAME 的目标域名
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    const cacheKey = `fastest:${clientIP}:${targetHost}`;

    // 检查缓存
    const cached = await env.CACHE.get(cacheKey, { type: 'json' });
    if (cached && Date.now() - cached.timestamp < 30 * 60 * 1000) {
      return proxyToIP(cached.result.ip, targetHost, request);
    }

    // 获取 IP 列表（可从 KV 动态加载）
    const ips = [
      '198.41.209.252', '198.41.209.47', '198.41.209.6',
      '104.18.191.234', '198.41.209.41', '104.18.189.131',
      '104.26.4.181', '104.16.14.77', '173.245.58.212',
      '173.245.58.110', '172.64.32.21', '172.64.33.236',
      '172.64.146.163', '172.64.152.213', '104.19.32.72', '104.19.211.200'
    ];

    // 并发测速（最多 32 线程）
    const results = await Promise.all(
      ips.map(async (ip) => {
        const start = Date.now();
        try {
          const res = await fetch(`https://${ip}/cdn-cgi/trace`, {
            headers: { 'Host': targetHost },
            signal: AbortSignal.timeout(8000)
          });
          const end = Date.now();
          return { ip, time: end - start };
        } catch (e) {
          return { ip, time: Infinity };
        }
      })
    );

    // 排序并缓存最快 IP
    results.sort((a, b) => a.time - b.time);
    const fastest = results[0];

    if (fastest && fastest.time !== Infinity) {
      await env.CACHE.put(cacheKey, JSON.stringify({
        result: fastest,
        timestamp: Date.now()
      }));
    }

    // 反向代理到最快节点
    return proxyToIP(fastest.ip, targetHost, request);
  }
};

// 反向代理逻辑
async function proxyToIP(ip, host, request) {
  const url = new URL(request.url);
  url.host = ip; // 替换为目标 IP
  url.protocol = 'https:'; // 强制 HTTPS

  const newRequest = new Request(url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'follow'
  });

  newRequest.headers.set('Host', host); // 设置真实 Host

  try {
    const response = await fetch(newRequest);
    return response;
  } catch (e) {
    return new Response('代理请求失败', { status: 502 });
  }
}
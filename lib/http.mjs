/**
 * lib/http.mjs —— 给设置页用的几个 JSON 小工具
 * ============================================================================
 * 只做四件事：发 JSON、读 body（带大小上限）、解析 URL、把异常收成 500。
 * 路由本身挂在 `/api/memory` 这个 prefix 下（见 index.js）。
 * ============================================================================
 */

export function sendJson(res, status, value) {
  try {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    try { res.writeHead(500); res.end('{"ok":false}') } catch { /* 连接已断 */ }
  }
}

/** 读请求体（默认上限 1 MB，别让一段粘帖把宿主内存吃了） */
export function readBody(req, limit = 1_048_576) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { try { req.destroy() } catch { /* 已断 */ } return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try { resolve(JSON.parse(text)) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/**
 * 解析请求 URL。
 * ⚠️ 2026-10-25 踩过：一开始这个函数返回的是 `searchParams`，
 *    调用方却拿它当 URL 用（`url.pathname.replace`）→ 整个接口 500。
 *    现在返回完整的 URL 对象。
 */
export function parseUrl(raw) {
  try { return new URL(String(raw || '/'), 'http://127.0.0.1') } catch { return new URL('http://127.0.0.1/') }
}

import { request } from 'node:http'

export interface RpcResponse {
  status: number
  // biome-ignore lint/suspicious/noExplicitAny: JSON from the service
  body: any
}

export function rpc(
  socketPath: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = 5000,
): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request(
      {
        socketPath,
        method,
        path,
        timeout: timeoutMs,
        headers: payload
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: data ? JSON.parse(data) : null,
            })
          } catch (err) {
            reject(err)
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

export async function isServing(socketPath: string): Promise<boolean> {
  try {
    const res = await rpc(socketPath, 'GET', '/status', undefined, 1000)
    return res.status === 200
  } catch {
    return false
  }
}

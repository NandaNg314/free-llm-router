const { DatabaseSync } = require('node:sqlite')

async function main() {
  const db = new DatabaseSync('/app/data/router.db')
  const credRow = db.prepare('SELECT uid, ciphertext FROM credentials LIMIT 1').all()[0]
  const secRow = db.prepare('SELECT value FROM system_kv WHERE prefix = ? AND key = ?').all('server', 'credential_key')[0]
  if (!credRow || !secRow) {
    console.log('No credentials found')
    return
  }
  const secret = JSON.parse(secRow.value)
  const payload = JSON.parse(credRow.ciphertext)

  // SHA-256 派生密钥
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  const cryptoKey = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['decrypt'])

  function fromBase64Url(value) {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/')
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
    const binary = atob(padded + pad)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
    return out
  }

  const iv = fromBase64Url(payload.iv)
  const ct = fromBase64Url(payload.ct)
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ct)
  const cred = JSON.parse(new TextDecoder().decode(plainBuf))

  const res = await fetch('https://copilot.tencent.com/v3/config', {
    headers: {
      'Authorization': 'Bearer ' + cred.accessToken,
      'X-User-Id': cred.uid,
      'User-Agent': 'CodeBuddyIDE/1.106.1',
      'X-Client-Version': '1.106.1'
    }
  })
  console.log('Fetch /v3/config status:', res.status)
  const data = await res.json()
  const models = data?.data?.models || data?.models || []
  console.log('Total models in /v3/config:', models.length)
  for (let i = 0; i < Math.min(8, models.length); i++) {
    console.log('--- Model', i, '---')
    console.log(JSON.stringify(models[i], null, 2))
  }
}

main().catch(console.error)

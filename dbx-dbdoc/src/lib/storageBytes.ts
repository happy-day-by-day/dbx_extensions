export const encodeBytes = (bytes: Uint8Array) => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}
export const decodeBytes = (data: string) => Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
export const sha256 = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), (b) => b.toString(16).padStart(2, '0')).join('')

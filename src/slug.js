// A Bot's Matrix user id is decided once, when its account is created, from the name it
// has at that moment: "桥接" → @qiaojie:tuxai.org. Later renames change the display name
// only, so old messages keep pointing at the same sender.
import { pinyin } from 'pinyin-pro'

// Matrix localparts allow a-z 0-9 . _ = - ; keep to the conservative [a-z0-9._-] and
// always start with a letter, so other homeservers and bridges accept them too.
const MAX = 32

export function slugOf(name) {
  const text = String(name ?? '').trim()
  if (text === '') return ''
  // Pinyin syllables join without a separator: 桥接 → qiaojie, not qiao-jie.
  const romanized = /^[\x20-\x7e]+$/.test(text)
    ? text
    : pinyin(text, { toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('')
  const slug = romanized
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX)
    .replace(/-+$/, '')
  if (slug === '') return ''
  return /^[a-z]/.test(slug) ? slug : `bot-${slug}`
}

// A name already taken gets -2, -3 … so two Bots never share an account.
export function freeLocalpart(name, taken) {
  const base = slugOf(name) || `bot-${Math.random().toString(36).slice(2, 8)}`
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base.slice(0, MAX - String(n).length - 1)}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error(`no free localpart left for "${name}"`)
}

export { MAX as LOCALPART_MAX }

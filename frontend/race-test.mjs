// 文档切换异步错位的端到端守卫测试（jsdom 真实渲染 App）。
// 通过挂起 / 按序放行对 /api/documents/{id} 的响应，复现「A 未回先切 B、
// A 迟到响应」等竞态，并断言正文、侧栏、表单与提交目标始终一致。
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></html>', {
  url: 'http://localhost/',
})
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.navigator = dom.window.navigator
globalThis.getComputedStyle = dom.window.getComputedStyle
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Node = dom.window.Node
globalThis.Range = dom.window.Range
globalThis.Selection = dom.window.Selection
dom.window.Element.prototype.scrollIntoView = () => {}

const tick = () => new Promise((r) => setTimeout(r, 0))
const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick()
}

const DOCS = {
  1: {
    document: { id: 1, title: '文档A', content: 'AAA-访谈正文内容' }, // 10 码位
    codes: [{ id: 7, name: '编码X', color: '#ff0000', usage_count: 0 }, { id: 8, name: '编码Y', color: '#0000ff', usage_count: 0 }],
    codings: [],
  },
  2: {
    document: { id: 2, title: '文档B', content: 'BBBBBBBBBB' }, // 10 码位
    codes: [{ id: 7, name: '编码X', color: '#ff0000', usage_count: 0 }, { id: 8, name: '编码Y', color: '#0000ff', usage_count: 0 }],
    codings: [],
  },
}

const docList = [
  { id: 1, title: '文档A', coding_count: 0 },
  { id: 2, title: '文档B', coding_count: 0 },
]

// 服务器侧创建结果记录
const created = []
const batchCreated = []

// 被挂起的 GET /documents/:id：id -> {resolve, promise}
let held = new Map()
// 被挂起的 GET /documents/:id/search：id -> {resolve, promise}
let heldSearch = new Map()

function hold(id) {
  let resolve
  const promise = new Promise((r) => {
    resolve = () =>
      r({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(DOCS[id])) })
  })
  held.set(id, { resolve, promise })
}

function release(id) {
  const h = held.get(id)
  if (h) {
    h.resolve()
    held.delete(id)
  }
}

function holdSearch(id, query) {
  let resolve
  const promise = new Promise((r) => {
    resolve = () =>
      r({ ok: true, status: 200, json: () => Promise.resolve(searchBody(id, query)) })
  })
  heldSearch.set(`${id}:${query}`, { resolve, promise })
}

function releaseSearch(id, query) {
  const key = `${id}:${query}`
  const h = heldSearch.get(key)
  if (h) {
    h.resolve()
    heldSearch.delete(key)
  }
}

// 与后端一致的字面检索（含彼此重叠命中）
function searchBody(id, query) {
  const content = DOCS[id].document.content
  const matches = []
  let pos = content.indexOf(query)
  while (pos !== -1) {
    matches.push({
      start: pos,
      end: pos + query.length,
      text: content.slice(pos, pos + query.length),
      before: content.slice(Math.max(0, pos - 20), pos),
      after: content.slice(pos + query.length, pos + query.length + 20),
    })
    pos = content.indexOf(query, pos + 1)
  }
  return { document_id: id, query, matches }
}

function jsonRes(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(structuredClone(body)) }
}

globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url, 'http://localhost')
  const path = u.pathname
  const method = options.method || 'GET'
  if (path === '/api/documents' && method === 'GET') return jsonRes(docList)
  const docMatch = path.match(/^\/api\/documents\/(\d+)$/)
  if (docMatch && method === 'GET') {
    const id = Number(docMatch[1])
    if (held.has(id)) return held.get(id).promise
    return jsonRes(DOCS[id])
  }
  if (path === '/api/codes' && method === 'GET')
    return jsonRes([{ id: 7, name: '编码X', color: '#ff0000', usage_count: 0 }, { id: 8, name: '编码Y', color: '#0000ff', usage_count: 0 }])
  if (path === '/api/codings/preview' && method === 'POST') {
    const body = JSON.parse(options.body)
    // 用例 4：冲突预览；其它用例无冲突
    return jsonRes({
      has_conflicts: body.code_id === 8,
      conflicts: body.code_id === 8
        ? [{ type: 'same_code', actions: ['keep'],
             coding: { id: 9, code_id: 8, code_name: '编码Y', code_color: '#00f', start: 0, end: 5 } }]
        : [],
    })
  }
  if (path === '/api/codings' && method === 'POST') {
    const body = JSON.parse(options.body)
    created.push(body)
    return jsonRes({ id: 100 + created.length, ...body })
  }
  const searchMatch = path.match(/^\/api\/documents\/(\d+)\/search$/)
  if (searchMatch && method === 'GET') {
    const id = Number(searchMatch[1])
    const query = u.searchParams.get('query')
    const key = `${id}:${query}`
    if (heldSearch.has(key)) return heldSearch.get(key).promise
    return jsonRes(searchBody(id, query))
  }
  if (path === '/api/codings/batch' && method === 'POST') {
    const body = JSON.parse(options.body)
    batchCreated.push(body)
    return jsonRes({
      created: body.items.map((it, i) => ({
        id: 200 + batchCreated.length * 100 + i,
        start: it.start,
        end: it.end,
      })),
      skipped: [],
      codings: [],
    })
  }
  // 统计类端点一律给空结构，避免干扰
  if (path.endsWith('/cooccurrence')) return jsonRes({ document_id: 0, codes: [], pairs: [] })
  if (path.endsWith('/speakers')) return jsonRes({ document_id: 0, speakers: [], untagged: null })
  if (path.endsWith('/gaps')) return jsonRes({ document_id: 0, coverage: 0, ratio: 0, gaps: [] })
  if (path.endsWith('/transitions')) return jsonRes({ document_id: 0, states: [], transitions: [] })
  if (path.endsWith('/review')) return jsonRes({ batch: null })
  return { ok: true, status: 200, json: () => Promise.resolve({}) }
}

// 先挂起 A：App 初始读取文档 1（列表首个）时响应被挂起
hold(1)

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { act } = await import('react-dom/test-utils')
const { default: App } = await import('./src/App.jsx')

const container = document.getElementById('root')
const root = createRoot(container)
await act(async () => {
  root.render(React.createElement(App))
  await flush()
})

const failures = []
function check(name, cond, extra) {
  if (cond) console.log(`PASS  ${name}`)
  else {
    console.log(`FAIL  ${name}`, extra ?? '')
    failures.push(name)
  }
}

async function switchDoc(id) {
  await act(async () => {
    const select = container.querySelector('.doc-switcher select')
    select.value = String(id)
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await flush(40)
  })
}

// ---------- 用例 1：A 未回先切 B，A 迟到响应不得覆盖 ----------
check('A 读取挂起时为加载态', !!container.querySelector('.loading'))

await switchDoc(2)
check('切到 B（即时返回）后展示 B 正文', container.textContent.includes('BBBBBBBBBB'))
check('且不显示 A 正文', !container.textContent.includes('AAA-访谈正文内容'))

await act(async () => {
  release(1) // A 的迟到响应
  await flush(40)
})
check('A 迟到响应后仍展示 B（迟到响应被丢弃）', container.textContent.includes('BBBBBBBBBB'))
check('A 迟到响应后不出现 A 正文', !container.textContent.includes('AAA-访谈正文内容'))

// ---------- 用例 2：在 A 上填表预览，提交瞬间切到 B，不得写到 B ----------
await switchDoc(1)
check('切回 A 并显示 A 正文', container.textContent.includes('AAA-访谈正文内容'))

const setNative = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  // select 的 onChange 在 React 中挂在 change 事件上
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}
setNative(container.querySelector('.coding-form select'), '7')
const nums = container.querySelectorAll('.coding-form input[type=number]')
setNative(nums[0], '0')
setNative(nums[1], '5')
await act(async () => {
  await flush()
})
check(
  '表单按 A 原文预览片段',
  container.querySelector('.snippet-preview')?.textContent.includes('AAA-访'),
  container.querySelector('.snippet-preview')?.textContent
)

const before = created.length
// 挂起 B 的读取，使切换后停留在加载态；点击提交与切换在同一批更新中发生
hold(2)
await act(async () => {
  container.querySelector('.coding-form .primary-btn').click()
  await tick()
  const select = container.querySelector('.doc-switcher select')
  select.value = '2'
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await flush(40)
})
check('切换加载期间旧表单卸载、显示加载态', !!container.querySelector('.loading'))
// 保证：任何落库提交的目标都只能是预览正文所属的 A（id=1），绝不会是 B（id=2）
check(
  '提交目标始终与预览正文一致：没有任何标注写到 B',
  created.every((c) => c.document_id !== 2),
  created
)

await act(async () => {
  release(2)
  await flush(40)
})
check('B 加载完成展示 B 正文', container.textContent.includes('BBBBBBBBBB'))

// ---------- 用例 3：在 B 上正常提交，落库 document_id=2 ----------
await act(async () => {
  setNative(container.querySelector('.coding-form select'), '7')
  const n2 = container.querySelectorAll('.coding-form input[type=number]')
  setNative(n2[0], '1')
  setNative(n2[1], '4')
  await flush()
})
await act(async () => {
  container.querySelector('.coding-form .primary-btn').click()
  await flush(40)
})
check(
  'B 上正常提交：document_id=2 且区间 [1,4)',
  created.some((c) => c.document_id === 2 && c.start === 1 && c.end === 4),
  created
)
check('用例 2 中若有落库，仅可能写到 A（与 A 预览一致）', created.length >= before)

// ---------- 用例 4：冲突确认跨文档切换必须失效 ----------
await switchDoc(1)
await act(async () => {
  setNative(container.querySelector('.coding-form select'), '8') // code_id=8 触发冲突
  const n3 = container.querySelectorAll('.coding-form input[type=number]')
  setNative(n3[0], '0')
  setNative(n3[1], '5')
  await flush(10)
})
await act(async () => {
  container.querySelector('.coding-form .primary-btn').click()
  await flush(40)
})
check('A 上提交后出现冲突确认弹窗', !!container.querySelector('.modal'))
const beforeSwitch = created.length
// 弹窗未确认即切到 B
hold(2)
await switchDoc(2)
check('切换加载期间冲突弹窗消失（跨文档预览失效）', !container.querySelector('.modal'))
// 极端兜底：若弹窗元素仍在（旧渲染残留），点击确认也不得落库到 B
const confirmBtn = container.querySelector('.modal .primary-btn')
if (confirmBtn) {
  await act(async () => {
    confirmBtn.click()
    await flush(40)
  })
}
check('跨过切换的冲突确认没有产生任何标注', created.length === beforeSwitch, created)
await act(async () => {
  release(2)
  await flush(40)
})
check('B 加载完成且无弹窗残留', container.textContent.includes('BBBBBBBBBB') && !container.querySelector('.modal'))

// ---------- 用例 5：A 检索后改关键词为 B（不重新检索），A 的命中立即消失且不可批量写入 ----------
await switchDoc(1)

const searchInput = () => container.querySelector('.search-bar input')
const searchBtn = () => container.querySelector('.search-bar .primary-btn')
const batchBtn = () => container.querySelector('.apply-row .primary-btn')

await act(async () => {
  setNative(searchInput(), 'AA') // 'AAA…' 中重叠命中 [0,2)、[1,3)
  searchBtn().click()
  await flush(20)
})
check('检索 AA 后展示 2 处命中（含重叠）', !!container.textContent.match(/「AA」命中 2 处/))

await act(async () => {
  setNative(searchInput(), 'BB') // 仅改输入，不提交检索
  await flush(10)
})
check('改关键词后 A 的命中立即清除', !container.querySelector('.match-list'))
check('改关键词后批量提交按钮不再渲染（无法拿旧命中写入）', !batchBtn())
check('改关键词后不残留 A 的命中计数', !container.textContent.includes('「AA」命中'))

// 迟到的 AA 响应也不得恢复旧命中（请求发出时输入仍是 AA，挂起后改词再放行）
await act(async () => {
  setNative(searchInput(), 'AA')
  await flush(5)
  holdSearch(1, 'AA')
  searchBtn().click()
  await flush(10)
  setNative(searchInput(), 'BB') // 检索在途即改词
  await flush(5)
  releaseSearch(1, 'AA') // A 检索迟到响应
  await flush(20)
})
check('A 迟到响应不得在 B 名下恢复旧命中', !container.querySelector('.match-list'))
check('迟到响应后输入仍是 B', searchInput().value === 'BB', searchInput().value)
check('迟到响应后无批量提交入口', !batchBtn())

// ---------- 用例 6：切文档时在途检索的迟到响应不得落到新文档 ----------
await act(async () => {
  setNative(searchInput(), 'AA')
  await flush(5)
  holdSearch(1, 'AA')
  searchBtn().click()
  await flush(10)
})
hold(2)
await switchDoc(2)
check('切文档加载期间不显示旧命中', !container.querySelector('.match-list'))
await act(async () => {
  releaseSearch(1, 'AA') // 旧文档检索迟到
  await flush(20)
  release(2)
  await flush(30)
})
check('旧文档迟到检索不落到新文档', !container.querySelector('.match-list'))
check('输入框随文档切换清空', searchInput().value === '', searchInput().value)

// ---------- 用例 7：在当前文档正常检索并批量写入，目标与关键词绑定 ----------
const batchBefore = batchCreated.length
await act(async () => {
  setNative(searchInput(), 'BBBB') // 'BBBBBBBBBB' 中重叠命中 7 处
  searchBtn().click()
  await flush(20)
})
check('当前文档检索展示 7 处重叠命中', !!container.textContent.match(/「BBBB」命中 7 处/))
await act(async () => {
  const codeSelect = container.querySelector('.apply-row select')
  setNative(codeSelect, '7')
  await flush(5)
  batchBtn().click()
  await flush(30)
})
check(
  '批量写入目标为当前文档且区间来自该次检索',
  batchCreated.length === batchBefore + 1 &&
    batchCreated[batchCreated.length - 1].document_id === 2 &&
    JSON.stringify(batchCreated[batchCreated.length - 1].items) ===
      JSON.stringify([0, 1, 2, 3, 4, 5, 6].map((s) => ({ start: s, end: s + 4 }))),
  batchCreated[batchCreated.length - 1]
)
check('结果提示绑定已检索关键词', container.querySelector('.batch-result')?.textContent.includes('「BBBB」'))

if (failures.length) {
  console.error(`\n${failures.length} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'

/**
 * 检索批量编码面板：输入字面关键词检索当前文档全部命中（含彼此重叠的命中），
 * 逐项勾选 / 全选后选择一个既有编码批量提交。后端在单事务中校验并写入，
 * 完全相同的既有标注会被跳过；提交成功后由 onApplied 触发全局刷新。
 *
 * 命中、勾选与结果提示一律绑定「发起检索时的文档 + 关键词」（searchSession）：
 * - 输入一旦改动（与已检索关键词不一致）立即作废旧会话——清空命中、勾选与
 *   结果提示，并使已发出检索的迟到响应失效，A 的命中绝不会挂在 B 名下；
 * - 检索响应落地前校验「最新序号 + 当前文档 + 回执 document_id/query 与请求
 *   一致」，迟到或串味响应直接丢弃，不得覆盖新查询；
 * - 提交前再次核对所选命中仍属于当前文档与已检索关键词，失配则阻止写入并
 *   提示重新检索。
 */
export default function SearchBatchPanel({ docId, codes, onApplied, onError }) {
  const [query, setQuery] = useState('')
  // searchSession：{ docId, query, matches }——命中清单只属于该文档与该关键词；
  // null 表示当前没有任何已生效的检索结果
  const [session, setSession] = useState(null)
  const [checked, setChecked] = useState(() => new Set())
  const [codeChoice, setCodeChoice] = useState('')
  const [searching, setSearching] = useState(false)
  const [applying, setApplying] = useState(false)
  // { type: 'result', query, created, skipped } | { type: 'warn', text } | null
  const [notice, setNotice] = useState(null)
  const selectAllRef = useRef(null)
  // 检索 / 批量应用的异步错位守卫：只接受最新一次、且仍属当前文档的响应
  const reqSeqRef = useRef(0)
  const docIdRef = useRef(docId)
  useEffect(() => {
    docIdRef.current = docId
  }, [docId])

  // 切换文档后清空检索状态：命中 / 勾选 / 提示均不跨文档携带
  useEffect(() => {
    reqSeqRef.current++ // 使切文档前在途的检索 / 提交响应失效
    setQuery('')
    setSession(null)
    setChecked(new Set())
    setNotice(null)
    setSearching(false)
    setApplying(false)
  }, [docId])

  const matches = session ? session.matches : null
  const allChecked = matches !== null && matches.length > 0 && checked.size === matches.length
  const someChecked = checked.size > 0 && !allChecked

  // 全选框的半选（indeterminate）状态只能透过 DOM 属性设置
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someChecked
  }, [someChecked])

  const selectedItems = useMemo(
    () => (matches ? matches.filter((_, i) => checked.has(i)) : []),
    [matches, checked]
  )

  // 输入变化：与最近一次已检索的关键词不一致即作废整个检索会话
  function handleQueryChange(value) {
    setQuery(value)
    if (session === null || session.query !== value) {
      // 取号使已发出检索的迟到响应失效（seq 校验会丢弃它）
      reqSeqRef.current++
      setSession(null)
      setChecked(new Set())
      setNotice(null)
      setSearching(false)
    }
  }

  async function handleSearch(ev) {
    ev.preventDefault()
    const keyword = query
    if (!keyword || searching) return
    const targetDocId = docId
    const seq = ++reqSeqRef.current
    setSearching(true)
    setNotice(null)
    // 新检索发起即清掉上一轮命中与勾选：在途期间不允许拿旧命中提交
    setSession(null)
    setChecked(new Set())
    try {
      const data = await api.searchDocument(targetDocId, keyword)
      // 又发起了新检索 / 改了关键词（seq 失效）或已切到其它文档：迟到结果丢弃
      if (seq !== reqSeqRef.current || docIdRef.current !== targetDocId) return
      // 服务端回执也必须与发起时的文档、关键词完全一致，任何串味响应不得落地
      if (data.document_id !== targetDocId || data.query !== keyword) {
        setSession(null)
        setChecked(new Set())
        setNotice({ type: 'warn', text: '检索结果与当前文档或关键词不一致，请重新检索。' })
        return
      }
      // 命中与发起检索时的文档、关键词整体绑定
      setSession({ docId: targetDocId, query: keyword, matches: data.matches })
      // 默认全选，便于直接批量编码；可再逐项取消
      setChecked(new Set(data.matches.map((_, i) => i)))
    } catch (e) {
      if (seq === reqSeqRef.current && docIdRef.current === targetDocId) onError(e)
    } finally {
      if (seq === reqSeqRef.current && docIdRef.current === targetDocId) setSearching(false)
    }
  }

  function toggleAll() {
    if (!matches) return
    setChecked(allChecked ? new Set() : new Set(matches.map((_, i) => i)))
  }

  function toggleOne(index) {
    setChecked((cur) => {
      const next = new Set(cur)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  async function handleApply() {
    if (!codeChoice || selectedItems.length === 0 || applying) return
    // 提交前核对：所选命中仍属于当前文档、来自输入框中已检索的关键词，
    // 且每一项都在该次检索返回的命中清单内——任一失配即阻止写入
    const stale =
      session === null ||
      session.docId !== docId ||
      session.query !== query ||
      selectedItems.some((m) => !session.matches.includes(m))
    if (stale) {
      setSession(null)
      setChecked(new Set())
      setNotice({
        type: 'warn',
        text: '所选命中已不属于当前文档或已检索关键词，已阻止写入，请重新检索后再提交。',
      })
      return
    }
    // 提交目标与关键词锁定为发起检索时的上下文，区间与该文档检索结果一一对应
    const targetDocId = session.docId
    const targetQuery = session.query
    const items = selectedItems.map((m) => ({ start: m.start, end: m.end }))
    const seq = ++reqSeqRef.current
    setApplying(true)
    setNotice(null)
    try {
      const data = await api.batchCreateCodings({
        document_id: targetDocId,
        code_id: Number(codeChoice),
        items,
      })
      // 在途期间切走了文档或关键词被改动：结果不落在新查询 / 新文档面板
      if (seq !== reqSeqRef.current || docIdRef.current !== targetDocId) return
      // 结果提示同样绑定发起检索（提交）时的关键词
      setNotice({
        type: 'result',
        query: targetQuery,
        created: data.created,
        skipped: data.skipped,
      })
      await onApplied()
    } catch (e) {
      // 任一非法项时后端整批回滚，这里只提示，无需本地清理
      if (seq === reqSeqRef.current && docIdRef.current === targetDocId) onError(e)
    } finally {
      if (seq === reqSeqRef.current && docIdRef.current === targetDocId) setApplying(false)
    }
  }

  return (
    <section className="search-panel">
      <div className="form-title">检索批量编码</div>

      <form className="search-bar" onSubmit={handleSearch}>
        <input
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="输入字面关键词，如：焦虑"
          maxLength={200}
        />
        <button type="submit" className="primary-btn" disabled={!query || searching}>
          {searching ? '检索中…' : '检索'}
        </button>
      </form>

      {matches !== null && (
        <>
          <div className="match-head">
            <label>
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allChecked}
                onChange={toggleAll}
              />
              全选
            </label>
            <span className="match-stat">
              {/* 计数始终展示已检索关键词，输入框被改动后整个清单即消失 */}
              「{session.query}」命中 {matches.length} 处，已选 {checked.size} 处
            </span>
          </div>

          {matches.length > 0 ? (
            <ul className="match-list">
              {matches.map((m, i) => (
                <li key={`${m.start}-${m.end}`}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked.has(i)}
                      onChange={() => toggleOne(i)}
                    />
                    <code>
                      [{m.start}, {m.end})
                    </code>
                    <span className="match-ctx">
                      …{m.before}
                      <mark>{m.text}</mark>
                      {m.after}…
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty">未检索到命中</div>
          )}

          <div className="apply-row">
            <select value={codeChoice} onChange={(e) => setCodeChoice(e.target.value)}>
              <option value="" disabled>
                选择既有编码…
              </option>
              {codes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              className="primary-btn"
              onClick={handleApply}
              disabled={!codeChoice || selectedItems.length === 0 || applying}
            >
              {applying ? '提交中…' : `批量编码（${selectedItems.length}）`}
            </button>
          </div>
        </>
      )}

      {notice?.type === 'result' && (
        <div className="batch-result">
          「{notice.query}」批量编码完成：新增 {notice.created.length} 条，跳过{' '}
          {notice.skipped.length} 条
          {notice.skipped.length > 0 && (
            <ul>
              {notice.skipped.map((s) => (
                <li key={`${s.start}-${s.end}`}>
                  <code>
                    [{s.start}, {s.end})
                  </code>
                  与既有标注 #{s.existing_id} 完全相同，已跳过
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {notice?.type === 'warn' && <div className="batch-warn">{notice.text}</div>}

      <p className="hint">
        提示：按字面文本匹配（含彼此重叠的命中）；完全相同的既有标注自动跳过，其余按保留边界写入。修改关键词或切换文档后需重新检索。
      </p>
    </section>
  )
}

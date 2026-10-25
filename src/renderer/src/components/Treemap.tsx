import { useEffect, useMemo, useRef, useState } from 'react'
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy'
import type { HierarchyRectangularNode } from 'd3-hierarchy'
import type { Tier, TreeNode } from '@shared/types'
import { fmtBytes } from '../lib/format'

const TIER_RGB: Record<string, [number, number, number]> = {
  SAFE_PURGE: [34, 197, 94],
  REVIEW: [245, 158, 11],
  KEEP: [59, 130, 246],
  LOCKED: [239, 68, 68],
  none: [71, 85, 105]
}

interface Props {
  root: TreeNode
  selectedPath: string | null
  onPick: (node: TreeNode) => void
  onDrill: (node: TreeNode) => void
}

function rgba(rgb: [number, number, number], a: number): string {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`
}

export function Treemap({ root, selectedPath, onPick, onDrill }: Props): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState<{ x: number; y: number; node: TreeNode } | null>(null)
  const layoutRef = useRef<HierarchyRectangularNode<TreeNode> | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const layout = useMemo(() => {
    if (size.w < 20 || size.h < 20) return null
    const h = hierarchy<TreeNode>(root, (d) => (d.children.length ? d.children : undefined))
    h.sum((d) => (d.children.length ? 0 : Math.max(d.size, 1)))
    treemap<TreeNode>()
      .tile(treemapSquarify)
      .size([size.w, size.h])
      .paddingInner(1.5)
      .round(true)(h)
    return h as unknown as HierarchyRectangularNode<TreeNode>
  }, [root, size.w, size.h])

  layoutRef.current = layout

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !layout) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.floor(size.w * dpr))
    canvas.height = Math.max(1, Math.floor(size.h * dpr))
    canvas.style.width = `${size.w}px`
    canvas.style.height = `${size.h}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)

    const leaves = layout.leaves() as HierarchyRectangularNode<TreeNode>[]

    for (const leaf of leaves) {
      const w = leaf.x1 - leaf.x0
      const h = leaf.y1 - leaf.y0
      if (w < 1 || h < 1) continue

      const tier = leaf.data.tier
      const rgb = TIER_RGB[tier ?? 'none']
      const alpha = 0.16 + Math.min(leaf.depth, 6) * 0.05

      ctx.fillStyle = rgba(rgb, alpha)
      ctx.fillRect(leaf.x0, leaf.y0, w, h)

      if (w > 58 && h > 22) {
        ctx.fillStyle = 'rgba(232, 240, 250, 0.92)'
        ctx.font = '11px "Segoe UI", system-ui, sans-serif'
        const label = leaf.data.name.length > Math.floor(w / 6.2)
          ? leaf.data.name.slice(0, Math.max(3, Math.floor(w / 6.2) - 1)) + '…'
          : leaf.data.name
        ctx.fillText(label, leaf.x0 + 5, leaf.y0 + 14)

        if (h > 38) {
          ctx.fillStyle = 'rgba(232, 240, 250, 0.55)'
          ctx.font = '10px "Cascadia Code", Consolas, monospace'
          ctx.fillText(fmtBytes(leaf.data.size), leaf.x0 + 5, leaf.y0 + 28)
        }
      }

      if (leaf.data.path === selectedPath) {
        ctx.strokeStyle = '#e6eef8'
        ctx.lineWidth = 2
        ctx.strokeRect(leaf.x0 + 1, leaf.y0 + 1, w - 2, h - 2)
      }
    }

    // Focus node outline
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(0.5, 0.5, size.w - 1, size.h - 1)
  }, [layout, size.w, size.h, selectedPath])

  const hitTest = (clientX: number, clientY: number): TreeNode | null => {
    const canvas = canvasRef.current
    if (!canvas || !layout) return null
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    const leaves = layout.leaves() as HierarchyRectangularNode<TreeNode>[]
    let best: HierarchyRectangularNode<TreeNode> | null = null
    for (const leaf of leaves) {
      if (x >= leaf.x0 && x <= leaf.x1 && y >= leaf.y0 && y <= leaf.y1) {
        if (!best || leaf.depth > best.depth) best = leaf
      }
    }
    return best ? best.data : null
  }

  return (
    <div className="treemap-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onMouseMove={(e) => {
          const node = hitTest(e.clientX, e.clientY)
          const canvas = canvasRef.current
          if (node && canvas) {
            const rect = canvas.getBoundingClientRect()
            setHover({ x: e.clientX - rect.left, y: e.clientY - rect.top, node })
          } else {
            setHover(null)
          }
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const node = hitTest(e.clientX, e.clientY)
          if (node) onPick(node)
        }}
        onDoubleClick={(e) => {
          const node = hitTest(e.clientX, e.clientY)
          if (node) onDrill(node)
        }}
      />
      {hover && (
        <div
          className="treemap-tip"
          style={{
            left: Math.min(hover.x + 14, size.w - 240),
            top: Math.min(hover.y + 14, size.h - 60)
          }}
        >
          <div className="tip-name">{hover.node.name}</div>
          <div className="tip-size">{fmtBytes(hover.node.size)}</div>
        </div>
      )}
    </div>
  )
}

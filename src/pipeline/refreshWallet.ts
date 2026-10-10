import type { ClosedRow, Db, ExposureRow, PnlRow } from "../db"
import { fetchPnl, listOpenPositions, listRecentClosed, type Position } from "../polymarket/dataApi"

export type RefreshResult = {
   pnl: PnlRow
   closed: ClosedRow[]
   open: { title: string, outcome: string, entryCostUsdc: number, shares: number }[]
}

export async function refreshWallet(db: Db, wallet: string): Promise<RefreshResult> {
   const [open, closed, pnl] = await Promise.all([
      listOpenPositions(wallet),
      listRecentClosed(wallet),
      fetchPnl(wallet),
   ])
   const exposure = exposureByCondition(open)
   const closedRows = closed.map(position => ({
      conditionId: position.condition_id.toLowerCase(),
      title: position.title,
      outcome: position.outcome,
      realizedPnl: position.realized_pnl,
      lastEventAt: position.last_event_at,
   }))
   const pnlRow = { realizedPnl: pnl.realized, unrealizedPnl: pnl.unrealized }
   db.replaceExposure(wallet, exposure)
   db.replaceClosed(wallet, closedRows)
   db.setPnl(wallet, pnlRow)
   const openView = [...open].sort((a, b) => b.entry_cost_usdc - a.entry_cost_usdc).slice(0, 5).map(position => ({
      title: position.title,
      outcome: position.outcome,
      entryCostUsdc: position.entry_cost_usdc,
      shares: position.current_size,
   }))
   return { pnl: pnlRow, closed: closedRows, open: openView }
}

function exposureByCondition(positions: Position[]): ExposureRow[] {
   const byCondition = new Map<string, ExposureRow>()
   for (const position of positions) {
      const conditionId = position.condition_id.toLowerCase()
      const current = byCondition.get(conditionId) ?? { conditionId, entryCostUsdc: 0, shares: 0 }
      current.entryCostUsdc += position.entry_cost_usdc
      current.shares += position.current_size
      byCondition.set(conditionId, current)
   }
   return [...byCondition.values()]
}

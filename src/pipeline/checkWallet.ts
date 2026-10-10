import { formatWallet } from "../alerts/format"
import { fetchUserStats, listRecentPositions } from "../polymarket/dataApi"
import { publicName } from "../polymarket/gamma"
import type { APIEmbed } from "discord.js"

export async function checkWallet(address: string): Promise<APIEmbed | null> {
   const [stats, name, open, closed] = await Promise.all([
      fetchUserStats(address),
      publicName(address),
      listRecentPositions(address, "OPEN", 10),
      listRecentPositions(address, "CLOSED", 10),
   ])
   if (!stats) return null
   const recent = [...open.map(row => line(row, true)), ...closed.map(row => line(row, false))]
      .sort((a, b) => b.at - a.at)
      .slice(0, 10)
   return formatWallet({ address, name, ...stats, recent })
}

function line(row: { title: string, outcome: string, unrealized_pnl: number, realized_pnl: number, last_event_at: number }, open: boolean) {
   return {
      title: row.title,
      outcome: row.outcome,
      pnl: open ? row.unrealized_pnl : row.realized_pnl,
      open,
      at: row.last_event_at,
   }
}

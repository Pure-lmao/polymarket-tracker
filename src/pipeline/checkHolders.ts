import { formatHolder, formatHolderSide, formatMarketChoices } from "../alerts/format"
import type { Db } from "../db"
import { fetchHolders, fetchPnl, listRecentClosed, listTopOpen } from "../polymarket/dataApi"
import { resolveMarket } from "../polymarket/gamma"
import { ensureToken } from "./token"
import type { APIEmbed } from "discord.js"

export async function checkHolders(db: Db, market: string): Promise<APIEmbed[]> {
   const resolved = await resolveMarket(market)
   if (resolved.kind === "many") return [formatMarketChoices(resolved.markets)]
   const holders = await fetchHolders(resolved.conditionId)
   if (holders.length === 0) return [{ title: "No holders", color: 0x5865f2 }]
   const groups = new Map<string, typeof holders>()
   for (const holder of holders) {
      const list = groups.get(holder.token_id) ?? []
      list.push(holder)
      groups.set(holder.token_id, list)
   }
   const embeds: APIEmbed[] = []
   for (const [tokenId, group] of groups) {
      const token = await ensureToken(db, tokenId)
      const blocks: string[] = []
      for (const holder of group) {
         const [open, closed, pnl] = await Promise.all([
            listTopOpen(holder.proxy_wallet),
            listRecentClosed(holder.proxy_wallet),
            fetchPnl(holder.proxy_wallet),
         ])
         blocks.push(formatHolder(holder, open, closed, pnl.realized + pnl.unrealized))
      }
      embeds.push(formatHolderSide(token?.outcome || "outcome", token?.title || tokenId, blocks))
   }
   return embeds
}

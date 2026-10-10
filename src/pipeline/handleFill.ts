import { formatFill, type RepeatKind } from "../alerts/format"
import { blockNumberOf, isFillLog, logIndexOf, type Log } from "../chain/log"
import { decodeFill, walletFill } from "../chain/decodeFill"
import type { Db } from "../db"
import type { APIEmbed } from "discord.js"
import { ensureToken } from "./token"

const REPEAT_MS = 15 * 60 * 1000

export async function handleFill(
   db: Db,
   log: Log,
   notify: (discordId: string, alert: FillAlert) => Promise<void>,
   timestamp = Math.floor(Date.now() / 1000),
): Promise<void> {
   if (!isFillLog(log)) return
   const decoded = decodeFill(log)
   const block = blockNumberOf(log)
   if (!decoded) {
      console.error("could not decode fill", log.transactionHash)
      db.setCursor(block)
      return
   }
   const wallets = db.isTracked(decoded.maker) ? [decoded.maker] : []
   for (const wallet of wallets) {
      const logIndex = logIndexOf(log)
      if (db.hasTrade(log.transactionHash, logIndex, wallet)) continue
      let token = null
      try {
         token = await ensureToken(db, decoded.tokenId)
      } catch (err) {
         console.error("token lookup", decoded.tokenId, err)
      }
      const fill = walletFill(decoded)
      const conditionId = token?.conditionId || decoded.tokenId
      const prior = db.lastOnCondition(wallet, conditionId)
      const alertedRecently = Date.now() - (db.lastAlertAt(wallet) ?? 0) < REPEAT_MS
      const inserted = db.insertTrade({
         txHash: log.transactionHash,
         logIndex,
         wallet,
         tokenId: decoded.tokenId,
         conditionId,
         side: fill.side,
         shares: fill.shares,
         usdc: fill.usdc,
         price: fill.price,
         blockNumber: block,
      })
      if (!inserted) continue
      db.applyFill(wallet, conditionId, fill.side, fill.usdc, fill.shares)
      const repeat = prior && Date.now() - prior.createdAt < REPEAT_MS
         ? repeatKind(prior.tokenId === decoded.tokenId, fill.side)
         : null
      const embedFor = (nickname: string | null, polymarketName: string | null) => formatFill({
         wallet,
         nickname,
         polymarketName,
         side: fill.side,
         usdc: fill.usdc,
         price: fill.price,
         liquidity: fill.liquidity,
         timestamp,
         tokenId: decoded.tokenId,
         token,
         exposure: db.getExposure(wallet, conditionId),
         pnl: db.getPnl(wallet),
         closed: alertedRecently ? [] : db.getClosed(wallet),
         repeat,
      })
      for (const discordId of db.subscribers(wallet)) {
         const identity = db.walletIdentity(discordId, wallet)
         await notify(discordId, {
            wallet,
            tokenId: decoded.tokenId,
            side: fill.side,
            usdc: fill.usdc,
            shares: fill.shares,
            embed: embedFor(identity?.nickname ?? null, identity?.polymarketName ?? null),
         })
      }
   }
   db.setCursor(block)
}

export type FillAlert = {
   wallet: string
   tokenId: string
   side: "BUY" | "SELL"
   usdc: number
   shares: number
   embed: APIEmbed
}

function repeatKind(sameToken: boolean, side: "BUY" | "SELL"): RepeatKind {
   if (sameToken && side === "BUY") return "bought-more"
   if (sameToken && side === "SELL") return "sold-some"
   if (side === "BUY") return "bought-other"
   return "sold-other"
}

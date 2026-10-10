import type { APIEmbed } from "discord.js"
import type { Liquidity } from "../chain/decodeFill"
import type { ClosedRow, ExposureRow, PnlRow, Side, TokenRow } from "../db"
import type { Holder, Position } from "../polymarket/dataApi"

export type RepeatKind = "bought-more" | "sold-some" | "bought-other" | "sold-other"

const NEUTRAL = 0x5865f2

export function walletColor(address: string): number {
   return Number.parseInt(address.slice(-6), 16)
}

export function formatFill(input: {
   wallet: string
   nickname: string | null
   polymarketName: string | null
   side: Side
   usdc: number
   price: number
   liquidity: Liquidity
   timestamp: number
   tokenId: string
   token: TokenRow | null
   exposure: ExposureRow | null
   pnl: PnlRow | null
   closed: ClosedRow[]
   repeat: RepeatKind | null
}): APIEmbed {
   const outcome = input.token?.outcome || "unknown outcome"
   const eventTitle = input.token?.title || input.tokenId
   const name = walletLabel(input.wallet, input.polymarketName, input.nickname)
   const position = input.exposure
      ? `${usd(input.exposure.entryCostUsdc)} @ ${odds(input.exposure.shares === 0 ? 0 : input.exposure.entryCostUsdc / input.exposure.shares)}`
      : "Unknown"
   const fill = `${usd(input.usdc)} @ ${odds(input.price)}`
   const order = input.liquidity === "market" ? "Market (taker)" : "Resting (maker)"
   const time = discordTime(input.timestamp)
   const market = input.token?.eventSlug ? `https://polymarket.com/event/${input.token.eventSlug}` : null
   const profile = `https://polymarket.com/profile/${input.wallet}`
   if (input.repeat) {
      const fields: APIEmbed["fields"] = [
         { name: "Fill", value: fill, inline: true },
         { name: "Order", value: order, inline: true },
         { name: "Position", value: position, inline: true },
         { name: "Time", value: time },
      ]
      if (market) fields.push({ name: "Market", value: market })
      fields.push({ name: "Profile", value: profile })
      return {
         title: name,
         description: `${repeatLine(input.repeat, outcome)}\n${eventTitle}`,
         color: walletColor(input.wallet),
         fields,
         footer: { text: input.wallet },
      }
   }
   const fields: APIEmbed["fields"] = []
   if (input.token?.startTime) {
      fields.push({
         name: input.token.startTime < Math.floor(Date.now() / 1000) ? "Started 🔴" : "Starts",
         value: discordTime(input.token.startTime),
         inline: true,
      })
   }
   fields.push({ name: "Fill", value: fill, inline: true })
   fields.push({ name: "Order", value: order, inline: true })
   fields.push({ name: "Position", value: position, inline: true })
   fields.push({ name: "Filled at", value: time, inline: true })
   if (input.pnl) {
      fields.push({
         name: "Wallet PnL",
         value: `${usd(input.pnl.realizedPnl)} realized / ${usd(input.pnl.unrealizedPnl)} unrealized`,
      })
   }
   if (input.closed.length > 0) {
      fields.push({
         name: "Last 5",
         value: input.closed.map(row => `${closedMark(row.realizedPnl)} ${row.title} :: ${row.outcome} :: ${usd(row.realizedPnl)}`).join("\n").slice(0, 1024),
      })
   }
   if (market) fields.push({ name: "Market", value: market })
   fields.push({ name: "Profile", value: profile })
   return {
      title: `${name} :: ${input.side} ${outcome}`.slice(0, 256),
      description: eventTitle.slice(0, 4096),
      color: walletColor(input.wallet),
      fields,
      footer: { text: input.wallet },
   }
}

export function accumulateFill(sent: APIEmbed, update: APIEmbed, usdc: number, shares: number): APIEmbed {
   const total = `${usd(usdc)} @ ${odds(shares === 0 ? 0 : usdc / shares)}`
   const listed = sent.fields?.find(field => field.name === "Fills")?.value.split("\n")
   const lines = listed && listed.length > 0 ? [...listed] : [fillLine(sent)].filter(line => line !== "")
   const next = fillLine(update)
   if (next) lines.push(next)
   const fields: APIEmbed["fields"] = []
   for (const field of sent.fields ?? []) {
      if (field.name === "Order" || field.name === "Fills") continue
      if (field.name === "Fill") {
         fields.push({ ...field, value: total })
         fields.push({ name: "Fills", value: fitLines(lines) })
         continue
      }
      if (field.name !== "Position" && field.name !== "Filled at" && field.name !== "Time") {
         fields.push(field)
         continue
      }
      const fresh = update.fields?.find(item => item.name === field.name || (field.name === "Filled at" && item.name === "Time"))
      fields.push(fresh ? { ...field, value: fresh.value } : field)
   }
   return { ...sent, fields }
}

function fillLine(embed: APIEmbed): string {
   const fill = embed.fields?.find(field => field.name === "Fill")?.value
   if (!fill) return ""
   const order = embed.fields?.find(field => field.name === "Order")?.value
   const time = embed.fields?.find(field => field.name === "Filled at" || field.name === "Time")?.value
   return [fill, order, time].filter(part => part).join(" · ")
}

function fitLines(lines: string[]): string {
   const kept = [...lines]
   while (kept.length > 1 && kept.join("\n").length > 1024) kept.shift()
   return kept.join("\n")
}

export function formatSnapshot(input: {
   wallet: string
   nickname: string | null
   polymarketName: string | null
   pnl: PnlRow
   closed: ClosedRow[]
   open: { title: string, outcome: string, entryCostUsdc: number, shares: number }[]
}): APIEmbed {
   const fields: APIEmbed["fields"] = [{
      name: "PnL",
      value: `${usd(input.pnl.realizedPnl)} realized / ${usd(input.pnl.unrealizedPnl)} unrealized`,
   }]
   if (input.open.length > 0) {
      fields.push({
         name: "Open",
         value: input.open.slice(0, 5).map(row =>
            `🎫 ${row.title} :: ${row.outcome} :: ${usd(row.entryCostUsdc)} (${num(row.shares)} shares)`,
         ).join("\n").slice(0, 1024),
      })
   }
   if (input.closed.length > 0) {
      fields.push({
         name: "Last 5",
         value: input.closed.map(row => `${closedMark(row.realizedPnl)} ${row.title} :: ${row.outcome} :: ${usd(row.realizedPnl)}`).join("\n").slice(0, 1024),
      })
   }
   return {
      title: walletLabel(input.wallet, input.polymarketName, input.nickname),
      description: input.wallet,
      color: walletColor(input.wallet),
      fields,
   }
}

export function formatWallet(input: {
   address: string
   name: string | null
   realizedPnl: number
   unrealizedPnl: number
   volume: number
   bets: number
   markets: number
   fees: number
   biggestWin: number
   value: number | null
   joined: number | null
   recent: { title: string, outcome: string, pnl: number, open: boolean, at: number }[]
}): APIEmbed {
   const fields: APIEmbed["fields"] = [{
      name: "PnL",
      value: `${signedUsd(input.realizedPnl)} realized / ${signedUsd(input.unrealizedPnl)} unrealized`,
   }, {
      name: "Volume",
      value: usd(input.volume),
      inline: true,
   }, {
      name: "Bets",
      value: num(input.bets),
      inline: true,
   }, {
      name: "Markets",
      value: num(input.markets),
      inline: true,
   }, {
      name: "Fees",
      value: signedUsd(input.fees),
      inline: true,
   }]
   if (input.value !== null) fields.push({ name: "Value", value: usd(input.value), inline: true })
   if (input.biggestWin > 0) fields.push({ name: "Biggest win", value: usd(input.biggestWin), inline: true })
   if (input.joined) fields.push({ name: "Joined", value: discordTime(input.joined), inline: true })
   if (input.recent.length > 0) {
      fields.push({
         name: "Last 10",
         value: input.recent.map(row => {
            const mark = row.open ? "🎫" : row.pnl < 0 ? "📕" : "📗"
            return `${mark} ${row.title} :: ${row.outcome} :: ${signedUsd(row.pnl)} :: ${discordDate(row.at)}`
         }).join("\n").slice(0, 1024),
      })
   }
   return {
      title: input.name || shortAddress(input.address),
      description: input.address,
      color: walletColor(input.address),
      fields,
   }
}

export function formatTrackedList(wallets: { address: string, nickname: string | null, polymarketName: string | null }[]): APIEmbed {
   return {
      title: "Tracked wallets",
      color: NEUTRAL,
      fields: wallets.slice(0, 25).map(wallet => ({
         name: walletLabel(wallet.address, wallet.polymarketName, wallet.nickname),
         value: wallet.address,
      })),
   }
}

export function formatMarketChoices(markets: { title: string, conditionId: string }[]): APIEmbed {
   return {
      title: "That event has several markets",
      description: "Pass one condition id.",
      color: NEUTRAL,
      fields: markets.slice(0, 25).map(market => ({
         name: market.title.slice(0, 256),
         value: market.conditionId,
      })),
   }
}

export function formatHolderSide(outcome: string, title: string, blocks: string[]): APIEmbed {
   return {
      title: `${outcome} :: ${title}`.slice(0, 256),
      description: blocks.join("\n\n").slice(0, 4096),
      color: NEUTRAL,
   }
}

export function formatHolder(holder: Holder, open: Position[], closed: Position[], lifetimePnl: number): string {
   const name = holder.name || shortAddress(holder.proxy_wallet)
   const cost = holder.entry_cost_usdc ?? 0
   const price = holder.avg_price ?? (holder.amount > 0 ? cost / holder.amount : 0)
   const lines = [
      `${name} :: ${signedUsd(lifetimePnl)} :: ${usd(cost)} @ ${odds(price)} :: ${signedUsd(holder.total_pnl ?? 0)}`,
   ]
   for (const row of open) lines.push(`🎫 ${row.title} :: ${row.outcome} :: ${usd(row.entry_cost_usdc)}`)
   for (const row of closed) {
      const mark = row.realized_pnl < 0 ? "📕" : "📗"
      lines.push(`${mark} ${row.title} :: ${row.outcome} :: ${signedUsd(row.realized_pnl)}`)
   }
   return lines.join("\n")
}

export function walletLabel(address: string, polymarketName: string | null, nickname: string | null): string {
   if (polymarketName && nickname) return `${polymarketName} · ${nickname}`
   return polymarketName || nickname || shortAddress(address)
}

export function shortAddress(address: string): string {
   if (!address) return "Unknown"
   return address.slice(0, 6) + "…" + address.slice(-4)
}

function closedMark(pnl: number): string {
   return pnl < 0 ? "📕" : "📗"
}

function repeatLine(repeat: RepeatKind, outcome: string): string {
   if (repeat === "bought-more") return `Bought more ${outcome}`
   if (repeat === "sold-some") return `Sold some ${outcome}`
   if (repeat === "bought-other") return `Bought the other side, ${outcome}`
   return `Sold some of the other side, ${outcome}`
}

function odds(price: number): string {
   if (price <= 0) return "n/a"
   const cents = Math.round(price * 100)
   return `${(1 / price).toFixed(2)} (${cents}c)`
}

function discordTime(unix: number): string {
   return `<t:${unix}:f> (<t:${unix}:R>)`
}

function discordDate(unix: number): string {
   return `<t:${unix}:d> (<t:${unix}:R>)`
}

function usd(value: number): string {
   return money(value, false)
}

function signedUsd(value: number): string {
   return money(value, true)
}

function money(value: number, signed: boolean): string {
   const sign = value < 0 ? "-" : signed ? "+" : ""
   const abs = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
   return sign + "$" + abs
}

function num(value: number): string {
   return value.toLocaleString("en-US", { maximumFractionDigits: 2 })
}

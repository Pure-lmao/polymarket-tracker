import type { Side } from "../db"
import { EXCHANGES } from "./contracts"
import type { Log } from "./log"

const UNIT = 1_000_000

export type DecodedFill = {
   maker: string
   taker: string
   tokenId: string
   makerSide: Side
   makerAmount: bigint
   takerAmount: bigint
}

export type Liquidity = "market" | "resting"

export type WalletFill = {
   side: Side
   shares: number
   usdc: number
   price: number
   liquidity: Liquidity
}

export function decodeFill(log: Log): DecodedFill | null {
   if (log.topics.length < 4) return null
   const data = log.data.startsWith("0x") ? log.data.slice(2) : log.data
   if (data.length < 64 * 4) return null
   const side = Number(word(data, 0))
   if (side !== 0 && side !== 1) return null
   return {
      maker: addressOf(log.topics[2]),
      taker: addressOf(log.topics[3]),
      tokenId: word(data, 1).toString(),
      makerSide: side === 0 ? "BUY" : "SELL",
      makerAmount: word(data, 2),
      takerAmount: word(data, 3),
   }
}

// The indexed maker is the wallet whose order this fill belongs to.
// makerAmount is what that order paid. A buy pays USDC and receives shares.
// Taker equal to the exchange means this order crossed the book.
export function walletFill(fill: DecodedFill): WalletFill {
   const makerBuys = fill.makerSide === "BUY"
   const usdcRaw = makerBuys ? fill.makerAmount : fill.takerAmount
   const sharesRaw = makerBuys ? fill.takerAmount : fill.makerAmount
   const shares = Number(sharesRaw) / UNIT
   const usdc = Number(usdcRaw) / UNIT
   const price = shares === 0 ? 0 : usdc / shares
   const liquidity: Liquidity = EXCHANGES.includes(fill.taker) ? "market" : "resting"
   return { side: fill.makerSide, shares, usdc, price, liquidity }
}

export function addressTopic(address: string): string {
   return "0x" + address.slice(2).toLowerCase().padStart(64, "0")
}

function addressOf(topic: string): string {
   return "0x" + topic.slice(-40).toLowerCase()
}

function word(data: string, index: number): bigint {
   return BigInt("0x" + data.slice(index * 64, index * 64 + 64))
}

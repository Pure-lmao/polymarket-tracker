import { EXCHANGES, ORDER_FILLED_TOPIC } from "./contracts"

export type Log = {
   address: string
   topics: string[]
   data: string
   blockNumber: string
   transactionHash: string
   logIndex: string
   removed?: boolean
}

export function isFillLog(log: Log): boolean {
   if (log.removed) return false
   const topic = log.topics[0]?.toLowerCase()
   return topic === ORDER_FILLED_TOPIC && EXCHANGES.includes(log.address.toLowerCase())
}

export function blockNumberOf(log: Log): number {
   return hexQuantity(log.blockNumber)
}

export function logIndexOf(log: Log): number {
   return hexQuantity(log.logIndex)
}

export function hexQuantity(value: string): number {
   return Number(BigInt(value))
}

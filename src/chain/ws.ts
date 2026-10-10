import { EXCHANGES, ORDER_FILLED_TOPIC, POLYGON_CHAIN_ID } from "./contracts"
import { addressTopic } from "./decodeFill"
import { blockNumberOf, hexQuantity, logIndexOf, type Log } from "./log"

const CHUNK = 2_000
const PING_MS = 20_000

type Hooks = {
   catchUp: boolean
   onLog: (log: Log) => Promise<unknown>
   getCursor: () => number | null
   setCursor: (block: number) => void
}

type RpcMessage = {
   id?: number
   result?: unknown
   error?: { message: string }
   method?: string
   params?: { subscription: string, result: Log }
}

export class ChainSocket {
   private ws: WebSocket | null = null
   private nextId = 1
   private pending = new Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>()
   private addresses: string[] = []
   private makerSub: string | null = null
   private backoff = 1000
   private stopped = false
   private ping: ReturnType<typeof setInterval> | null = null
   private queue: Promise<unknown> = Promise.resolve()
   private blockTimes = new Map<number, number>()

   constructor(private url: string, private hooks: Hooks) {}

   start() {
      this.connect()
   }

   stop() {
      this.stopped = true
      this.clearPing()
      this.ws?.close()
   }

   setWallets(addresses: string[]) {
      this.addresses = [...new Set(addresses.map(address => address.toLowerCase()))]
      void this.enqueue(() => this.resubscribe()).catch(err => console.error(err))
   }

   async blockTime(blockNumber: number): Promise<number> {
      const cached = this.blockTimes.get(blockNumber)
      if (cached !== undefined) return cached
      const block = await this.call("eth_getBlockByNumber", [hex(blockNumber), false]) as { timestamp: string }
      const timestamp = hexQuantity(block.timestamp)
      this.blockTimes.set(blockNumber, timestamp)
      return timestamp
   }

   private connect() {
      if (this.stopped) return
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.addEventListener("open", () => {
         this.backoff = 1000
         void this.enqueue(() => this.onOpen(ws)).catch(err => console.error(err))
      })
      ws.addEventListener("message", (event) => {
         try {
            this.onMessage(String(event.data))
         } catch (err) {
            console.error("socket message", err)
         }
      })
      ws.addEventListener("close", () => {
         if (this.ws !== ws) return
         this.ws = null
         this.failPending(new Error("socket closed"))
         this.makerSub = null
         this.clearPing()
         if (this.stopped) return
         const wait = this.backoff
         this.backoff = Math.min(this.backoff * 2, 30_000)
         console.log(`polygon socket closed, reconnecting in ${wait}ms`)
         setTimeout(() => this.connect(), wait)
      })
      ws.addEventListener("error", () => {
         console.error("polygon socket error")
      })
   }

   private async onOpen(ws: WebSocket) {
      if (this.ws !== ws) return
      const chainId = await this.call("eth_chainId", []) as string
      if (BigInt(chainId) !== POLYGON_CHAIN_ID) throw new Error(`expected chain 137, got ${chainId}`)
      const head = hexQuantity(await this.call("eth_blockNumber", []) as string)
      if (this.hooks.catchUp && this.addresses.length > 0) {
         const cursor = this.hooks.getCursor()
         if (cursor !== null && cursor < head) await this.backfill(cursor + 1, head)
      }
      this.hooks.setCursor(head)
      if (this.ws !== ws) return
      await this.resubscribe()
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return
      this.startPing(ws)
      console.log(`polygon socket ready at block ${head}, catch-up ${this.hooks.catchUp}`)
   }

   private async backfill(fromBlock: number, toBlock: number) {
      console.log(`catch-up ${fromBlock} to ${toBlock}`)
      const topics = this.addresses.map(addressTopic)
      const logs: Log[] = []
      for (let from = fromBlock; from <= toBlock; from += CHUNK) {
         const to = Math.min(toBlock, from + CHUNK - 1)
         const found = await this.getLogs(from, to, topics)
         logs.push(...found)
      }
      logs.sort((a, b) => {
         const block = blockNumberOf(a) - blockNumberOf(b)
         if (block !== 0) return block
         return logIndexOf(a) - logIndexOf(b)
      })
      for (const log of logs) await this.hooks.onLog(log)
   }

   private async getLogs(from: number, to: number, topics: string[]): Promise<Log[]> {
      const logs = await this.call("eth_getLogs", [{
         ...fillFilter(topics),
         fromBlock: hex(from),
         toBlock: hex(to),
      }]) as Log[]
      return logs
   }

   private async resubscribe() {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      if (this.makerSub) await this.call("eth_unsubscribe", [this.makerSub]).catch(() => {})
      this.makerSub = null
      if (this.addresses.length === 0) {
         console.log("no wallets tracked, subscription cleared")
         return
      }
      const topics = this.addresses.map(addressTopic)
      this.makerSub = await this.call("eth_subscribe", ["logs", fillFilter(topics)]) as string
      console.log(`subscribed ${this.addresses.length} wallets`)
   }

   private onMessage(raw: string) {
      const msg = JSON.parse(raw) as RpcMessage
      if (msg.id !== undefined) {
         const pending = this.pending.get(msg.id)
         if (!pending) return
         this.pending.delete(msg.id)
         if (msg.error) pending.reject(new Error(msg.error.message))
         else pending.resolve(msg.result)
         return
      }
      if (msg.method !== "eth_subscription" || !msg.params) return
      const id = msg.params.subscription
      if (id !== this.makerSub) return
      this.hooks.onLog(msg.params.result).catch(err => console.error("fill", err))
   }

   private call(method: string, params: unknown[]): Promise<unknown> {
      const ws = this.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("socket not open"))
      const id = this.nextId++
      return new Promise((resolve, reject) => {
         const timer = setTimeout(() => {
            this.pending.delete(id)
            reject(new Error(`${method} timed out`))
         }, 30_000)
         this.pending.set(id, {
            resolve: (value) => {
               clearTimeout(timer)
               resolve(value)
            },
            reject: (error) => {
               clearTimeout(timer)
               reject(error)
            },
         })
         ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      })
   }

   private enqueue<T>(task: () => Promise<T>): Promise<T> {
      const run = this.queue.then(task)
      this.queue = run.then(() => undefined, () => undefined)
      return run
   }

   private startPing(ws: WebSocket) {
      this.clearPing()
      this.ping = setInterval(() => {
         if (this.ws !== ws) return
         const sock = ws as WebSocket & { ping?: () => void }
         sock.ping?.()
      }, PING_MS)
   }

   private clearPing() {
      if (this.ping) clearInterval(this.ping)
      this.ping = null
   }

   private failPending(error: Error) {
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
   }
}

function hex(n: number): string {
   return "0x" + n.toString(16)
}

function fillFilter(walletTopics: string[]) {
   return {
      address: EXCHANGES,
      topics: [ORDER_FILLED_TOPIC, null, walletTopics],
   }
}

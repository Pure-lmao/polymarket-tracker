import { deliverAlert, startBot } from "./discord/bot"
import { ChainSocket } from "./chain/ws"
import { loadConfig } from "./config"
import { Db } from "./db"
import { blockNumberOf, type Log } from "./chain/log"
import { handleFill } from "./pipeline/handleFill"
import { refreshWallet } from "./pipeline/refreshWallet"

const config = loadConfig()
const db = new Db(config.databasePath)

let fills: Promise<void> = Promise.resolve()

function runExclusive<T>(task: () => Promise<T>): Promise<T> {
   const run = fills.then(task)
   fills = run.then(() => undefined, () => undefined)
   return run
}

function ingest(log: Log): Promise<void> {
   return runExclusive(async () => {
      const timestamp = await socket.blockTime(blockNumberOf(log))
      await handleFill(
         db,
         log,
         (discordId, alert) => deliverAlert(config.discordToken, discordId, alert),
         timestamp,
      )
   })
}

const socket = new ChainSocket(config.polygonWssUrl, {
   catchUp: config.catchUp,
   onLog: log => ingest(log).catch(err => console.error("fill", err)),
   getCursor: () => db.getCursor(),
   setCursor: block => db.setCursor(block),
})

socket.setWallets(db.trackedAddresses())
socket.start()
db.prune()

let refreshing = false
setInterval(() => {
   if (refreshing) return
   refreshing = true
   runExclusive(refreshAll)
      .catch(err => console.error("refresh", err))
      .finally(() => {
         refreshing = false
      })
}, 10 * 60 * 1000)

async function refreshAll() {
   for (const wallet of db.trackedAddresses()) await refreshWallet(db, wallet)
   db.prune()
}

await startBot({ config, db, socket, runExclusive })

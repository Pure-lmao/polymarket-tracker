import { loadConfig } from "./config"
import { Db } from "./db"
import { publicName } from "./polymarket/gamma"

const config = loadConfig()
const db = new Db(config.databasePath)
const addresses = db.trackedAddresses()

for (const address of addresses) {
   const name = await publicName(address)
   if (!name) {
      console.log(`${address} no polymarket name`)
      continue
   }
   db.setPolymarketName(address, name)
   console.log(`${address} ${name}`)
}

console.log(`backfilled ${addresses.length} wallets`)

export type Config = {
   discordToken: string
   discordClientId: string
   polygonWssUrl: string
   databasePath: string
   catchUp: boolean
}

export function loadConfig(): Config {
   const discordToken = required("DISCORD_TOKEN")
   const discordClientId = required("DISCORD_CLIENT_ID")
   const polygonWssUrl = required("POLYGON_WSS_URL")
   const databasePath = process.env.DATABASE_PATH || "data/tracker.db"
   const catchUp = process.env.CATCH_UP === "true"
   return { discordToken, discordClientId, polygonWssUrl, databasePath, catchUp }
}

function required(name: string): string {
   const value = process.env[name]
   if (!value) throw new Error(`${name} is required`)
   return value
}

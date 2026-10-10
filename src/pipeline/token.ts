import type { Db, TokenRow } from "../db"
import { fetchToken } from "../polymarket/dataApi"
import { eventStart } from "../polymarket/gamma"

export async function ensureToken(db: Db, tokenId: string): Promise<TokenRow | null> {
   const cached = db.getToken(tokenId)
   if (cached) return cached
   const ref = await fetchToken(tokenId)
   if (!ref) return null
   const startTime = ref.event_slug ? await eventStart(ref.event_slug, ref.market_slug) : null
   const token: TokenRow = {
      tokenId: ref.token_id,
      conditionId: ref.condition_id.toLowerCase(),
      eventSlug: ref.event_slug,
      marketSlug: ref.market_slug,
      title: ref.title,
      outcome: ref.outcome,
      startTime,
      fetchedAt: Date.now(),
   }
   db.upsertToken(token)
   return token
}

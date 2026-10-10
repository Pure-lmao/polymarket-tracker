const GAMMA = "https://gamma-api.polymarket.com"

export type GammaMarket = {
   conditionId?: string
   question?: string
   slug?: string
   gameStartTime?: string
}

export type GammaEvent = {
   slug?: string
   title?: string
   startDate?: string
   markets?: GammaMarket[]
}

export async function eventStart(eventSlug: string, marketSlug: string | null): Promise<number | null> {
   const events = await gamma<GammaEvent[]>(`/events?slug=${encodeURIComponent(eventSlug)}`)
   const event = events[0]
   if (!event) return null
   const market = marketSlug ? event.markets?.find(item => item.slug === marketSlug) : undefined
   return unixSeconds(market?.gameStartTime || event.startDate)
}

export async function resolveMarket(input: string): Promise<
   | { kind: "one", conditionId: string }
   | { kind: "many", markets: { title: string, conditionId: string }[] }
> {
   const trimmed = input.trim()
   if (/^0x[a-fA-F0-9]{62,64}$/.test(trimmed)) {
      return { kind: "one", conditionId: trimmed.toLowerCase() }
   }
   const slug = slugFrom(trimmed)
   const markets = await gamma<GammaMarket[]>(`/markets?slug=${encodeURIComponent(slug)}`)
   if (markets[0]?.conditionId) return { kind: "one", conditionId: markets[0].conditionId.toLowerCase() }
   const events = await gamma<GammaEvent[]>(`/events?slug=${encodeURIComponent(slug)}`)
   const event = events[0]
   if (!event) throw new Error("market not found")
   const list = (event.markets ?? []).filter(market => market.conditionId)
   if (list.length === 1) return { kind: "one", conditionId: list[0].conditionId!.toLowerCase() }
   if (list.length === 0) throw new Error("market not found")
   return {
      kind: "many",
      markets: list.map(market => ({
         title: market.question || market.slug || market.conditionId!,
         conditionId: market.conditionId!.toLowerCase(),
      })),
   }
}

export async function publicName(address: string): Promise<string | null> {
   const res = await fetch(`${GAMMA}/public-profile?address=${address}`)
   if (!res.ok) return null
   const body = await res.json() as { name?: string, pseudonym?: string }
   return body.name || body.pseudonym || null
}

function unixSeconds(value: string | undefined): number | null {
   if (!value) return null
   const ms = Date.parse(value)
   return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

function slugFrom(input: string): string {
   try {
      const url = new URL(input)
      const parts = url.pathname.split("/").filter(Boolean)
      if (parts[0] === "event" && parts.length >= 3) return parts[2]
      return parts[parts.length - 1] ?? input
   } catch {
      return input
   }
}

async function gamma<T>(path: string): Promise<T> {
   const res = await fetch(GAMMA + path)
   if (!res.ok) throw new Error(`gamma ${res.status} ${path}`)
   return res.json() as Promise<T>
}

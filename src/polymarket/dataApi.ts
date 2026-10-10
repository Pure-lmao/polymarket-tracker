const BASE = "https://data-api.polymarket.com"

export type TokenRef = {
   token_id: string
   condition_id: string
   event_slug: string | null
   market_slug: string | null
   title: string | null
   outcome: string | null
}

export type Position = {
   token_id: string
   condition_id: string
   current_size: number
   entry_cost_usdc: number
   realized_pnl: number
   unrealized_pnl: number
   title: string
   outcome: string
   event_slug: string
   last_event_at: number
}

export type Holder = {
   proxy_wallet: string
   token_id: string
   amount: number
   outcome_index: number
   name: string
   avg_price: number | null
   entry_cost_usdc: number | null
   current_value: number | null
   total_pnl: number | null
   realized_pnl: number | null
}

type Page<T> = {
   data: T[] | null
   pagination?: { next_cursor: string | null }
}

type PnlSeries = {
   points: { realized_pnl: number | null, unrealized_pnl: number | null }[]
} | null

type UserStatsPayload = {
   trades?: number
   biggest_win?: number
   join_date?: number
   all_time_pnl?: {
      trade_count?: number
      volume?: number
      realized_pnl?: number
      unrealized_pnl?: number
      fees_paid?: number
   }
}

export async function fetchToken(tokenId: string): Promise<TokenRef | null> {
   const rows = await fetchTokens([tokenId])
   return rows[0] ?? null
}

export async function fetchTokens(tokenIds: string[]): Promise<TokenRef[]> {
   if (tokenIds.length === 0) return []
   const data = await getData<TokenRef[]>(`/v2/tokens?token_id=${tokenIds.join(",")}`)
   return data ?? []
}

export async function listOpenPositions(user: string): Promise<Position[]> {
   const rows: Position[] = []
   let cursor: string | null = null
   for (;;) {
      const params = new URLSearchParams({ user, status: "OPEN" })
      if (cursor) params.set("cursor", cursor)
      else params.set("limit", "100")
      const page = await getPage<Position>(`/v2/positions?${params}`)
      rows.push(...(page.data ?? []))
      cursor = page.pagination?.next_cursor ?? null
      if (!cursor) break
   }
   return rows
}

export async function listRecentClosed(user: string, limit = 5): Promise<Position[]> {
   return listRecentPositions(user, "CLOSED", limit)
}

export async function listRecentPositions(user: string, status: "OPEN" | "CLOSED", limit: number): Promise<Position[]> {
   const params = new URLSearchParams({
      user,
      status,
      limit: String(limit),
      sort_by: "TIMESTAMP",
      sort_direction: "DESC",
   })
   const page = await getPage<Position>(`/v2/positions?${params}`)
   return page.data ?? []
}

export async function listTopOpen(user: string): Promise<Position[]> {
   const params = new URLSearchParams({ user, status: "OPEN", limit: "3" })
   const page = await getPage<Position>(`/v2/positions?${params}`)
   return page.data ?? []
}

export async function fetchUserStats(user: string): Promise<{
   bets: number
   markets: number
   volume: number
   realizedPnl: number
   unrealizedPnl: number
   fees: number
   biggestWin: number
   value: number | null
   joined: number | null
} | null> {
   const [stats, value] = await Promise.all([
      getData<UserStatsPayload | null>(`/v2/user-stats?user=${user}`),
      fetchPortfolioValue(user),
   ])
   if (!stats) return null
   const pnl = stats.all_time_pnl
   return {
      bets: pnl?.trade_count ?? 0,
      markets: stats.trades ?? 0,
      volume: pnl?.volume ?? 0,
      realizedPnl: pnl?.realized_pnl ?? 0,
      unrealizedPnl: pnl?.unrealized_pnl ?? 0,
      fees: pnl?.fees_paid ?? 0,
      biggestWin: stats.biggest_win ?? 0,
      value,
      joined: stats.join_date ?? null,
   }
}

export async function fetchPnl(user: string): Promise<{ realized: number, unrealized: number }> {
   const data = await getData<PnlSeries>(`/v2/user-pnl?user=${user}&interval=all`)
   const point = data?.points?.at(-1)
   return {
      realized: point?.realized_pnl ?? 0,
      unrealized: point?.unrealized_pnl ?? 0,
   }
}

export async function fetchHolders(conditionId: string): Promise<Holder[]> {
   const params = new URLSearchParams({
      condition: conditionId,
      include_pnl: "true",
      limit: "5",
   })
   const page = await getPage<{ token_id: string, holders: Holder[] }>(`/v2/holders?${params}`)
   return (page.data ?? []).flatMap(book => book.holders)
}

async function fetchPortfolioValue(user: string): Promise<number | null> {
   const res = await fetchOnce(`${BASE}/value?user=${user}`)
   if (!res.ok) return null
   const rows = await res.json() as { value?: number }[]
   return rows[0]?.value ?? null
}

async function getPage<T>(path: string): Promise<Page<T>> {
   const body = await request(path)
   return {
      data: (body.data ?? null) as T[] | null,
      pagination: body.pagination,
   }
}

async function getData<T>(path: string): Promise<T> {
   const body = await request(path)
   return body.data as T
}

async function request(path: string): Promise<{ data: unknown, pagination?: { next_cursor: string | null } }> {
   const res = await fetchOnce(BASE + path)
   if (!res.ok) throw new Error(`data api ${res.status} ${path}`)
   return await res.json() as { data: unknown, pagination?: { next_cursor: string | null } }
}

async function fetchOnce(url: string): Promise<Response> {
   const res = await fetch(url)
   if (res.status !== 429) return res
   const seconds = Number(res.headers.get("retry-after") ?? "1")
   await Bun.sleep(seconds * 1000)
   return fetch(url)
}

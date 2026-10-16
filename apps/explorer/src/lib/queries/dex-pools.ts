import type { Address } from 'viem'
import { queryOptions } from '@tanstack/react-query'
import { fetchDexPools } from '#lib/server/dex-pools'
import { fetchDexSwaps } from '#lib/server/dex-swaps'
import { getTempoChain } from '#wagmi.config'

export function dexPoolsQueryOptions() {
	return queryOptions({
		queryKey: ['dex-pools', getTempoChain().id],
		queryFn: () => fetchDexPools(),
		staleTime: 30_000,
		retry: 1,
	})
}

export function dexSwapsQueryOptions(live: boolean, path?: Address[]) {
	return queryOptions({
		queryKey: ['dex-swaps', getTempoChain().id, path ?? null],
		queryFn: () => fetchDexSwaps({ data: { path } }),
		staleTime: 4_000,
		refetchInterval: live ? 5_000 : false,
		retry: 1,
	})
}

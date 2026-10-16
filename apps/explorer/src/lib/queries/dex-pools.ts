import { queryOptions } from '@tanstack/react-query'
import { fetchDexPools } from '#lib/server/dex-pools'
import { getTempoChain } from '#wagmi.config'

export function dexPoolsQueryOptions() {
	return queryOptions({
		queryKey: ['dex-pools', getTempoChain().id],
		queryFn: () => fetchDexPools(),
		staleTime: 30_000,
		retry: 1,
	})
}

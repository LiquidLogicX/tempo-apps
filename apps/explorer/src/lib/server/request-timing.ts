const SAMPLE_RATE = 0.25

/** Measures Worker response preparation, excluding browser and streaming time. */
export async function withRequestTiming(
	request: Request,
	env: { POSTHOG_API_KEY?: string; VITE_TEMPO_ENV?: string },
	context: { waitUntil(promise: Promise<unknown>): void },
	handle: () => Promise<Response>,
): Promise<Response> {
	const url = new URL(request.url)
	// Skip telemetry intake and static files, including SDK assets.
	if (
		!env.POSTHOG_API_KEY ||
		url.pathname === '/dd-proxy' ||
		url.pathname.startsWith('/assets/') ||
		/\.[a-z0-9]+$/i.test(url.pathname) ||
		Math.random() >= SAMPLE_RATE
	) {
		return handle()
	}

	const startedAt = performance.now()
	let statusCode = 500
	try {
		const response = await handle()
		statusCode = response.status
		return response
	} finally {
		// Background delivery must not delay or fail the application response.
		context.waitUntil(
			fetch('https://us.i.posthog.com/capture/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				signal: AbortSignal.timeout(3000),
				body: JSON.stringify({
					api_key: env.POSTHOG_API_KEY,
					event: 'explorer.server.request_duration',
					properties: {
						distinct_id: 'explorer-server',
						$process_person_profile: false,
						$geoip_disable: true,
						duration_ms: Math.round(performance.now() - startedAt),
						environment: env.VITE_TEMPO_ENV,
						method: request.method,
						route_pattern: url.pathname
							.replace(/\/0x[a-fA-F0-9]+/g, '/:hash')
							.replace(/\/\d+/g, '/:id'),
						status_code: statusCode,
						sample_rate: SAMPLE_RATE,
						tempo_app_id: 'explorer-server',
						tempo_runtime: 'worker',
					},
				}),
			})
				.then((response) => {
					if (!response.ok)
						console.warn('Explorer request timing delivery failed')
					return response.body?.cancel()
				})
				.catch(() => {
					console.warn('Explorer request timing delivery failed')
				}),
		)
	}
}

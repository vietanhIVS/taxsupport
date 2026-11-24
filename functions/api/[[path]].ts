import type { PagesFunction } from '@cloudflare/workers-types'
import { handleApi } from '../../server/api'
import type { Env } from '../../server/security'

export const onRequest: PagesFunction<Env> = ({ request, env }) => handleApi(request as unknown as Request, env) as unknown as ReturnType<PagesFunction<Env>>

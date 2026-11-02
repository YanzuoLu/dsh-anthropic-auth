import { createProviderLogin } from './lib/provider-login.js'
import { mountProviderLoginRoutes } from './lib/provider-login-routes.js'

export const name = 'anthropic-login'
export const inject = ['authorization', 'credentials']

/** Add an authenticated UI surface to DSH's existing Anthropic OAuth flow. */
export function apply(ctx) {
  const controller = createProviderLogin(ctx, {
    provider: 'anthropic', label: 'Anthropic',
    allowedAuthHosts: ['claude.ai', 'console.anthropic.com', 'platform.claude.com'],
  })
  ctx.effect(() => () => controller.dispose(), 'anthropic login controller')
  ctx.inject(['connection'], child => child.effect(
    () => mountProviderLoginRoutes(child, controller, { apiPath: '/api/dsh-anthropic-auth' }),
    'anthropic login routes',
  ))
}

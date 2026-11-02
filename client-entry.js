import { createProviderLoginClient } from './lib/provider-login-client.js';

window.__ModuleLoader__.load({
  id: 'dsh-anthropic-auth',
  factory(require) {
    return createProviderLoginClient(require, {
      id: 'dsh-anthropic-auth', label: 'Anthropic', sectionId: 'anthropic-auth', order: 30,
      apiPath: '/api/dsh-anthropic-auth',
    });
  },
});

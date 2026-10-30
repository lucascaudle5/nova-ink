/**
 * Worker entry for the engine notebook (`nova-ink-engine`): the same sign-in layer as the tldraw test Worker
 * (OAuth for ChatGPT, Cloudflare Access with one allowed email, fail closed) in front of the engine tools.
 */
import { createApp, type AppOptions } from '../app'
import { NotebookLibraryDO } from './library-do'
import { createEngineServer } from './mcp'
import { PageDO } from './page-do'

export { NotebookLibraryDO, PageDO }

export const ENGINE_APP: AppOptions = {
  app: 'nova-ink-engine', bindings: ['PAGE', 'ENGINE_LIBRARY'], notebookLabel: 'your private NOVA Ink notebook',
  homeTitle: 'NOVA Ink notebook', createServer: createEngineServer,
}

export default createApp(undefined, ENGINE_APP)

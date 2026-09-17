import { useStoreSelector } from '@/lib/use-session-slice'
import { $draftTitles, draftTitleIn } from '@/store/composer'

export interface SessionDraftTitleProps {
  /** The draft's composer key — a tile's stored session id, or null for the
   *  new chat that has no session yet. */
  scope: null | string
}

/**
 * A DRAFT'S NAME — what an unsent session is called until it has a real one.
 *
 * The tab of a session that has never been sent renders this instead of its
 * registered title, because the name moves with the composer: every debounced
 * stash republishes it. Re-registering the contribution at that rate would
 * re-render the whole panes area, so the label subscribes for itself and its
 * own key only.
 *
 * Returns null when there is no draft text — the caller's `?? pane.title`
 * fallback then shows the registered title ("New session" on a draft, the
 * real title once the session is listed). Returning the placeholder here
 * would overwrite a real title the moment the composer emptied.
 */
export function SessionDraftTitle({ scope }: SessionDraftTitleProps) {
  return useStoreSelector($draftTitles, titles => draftTitleIn(titles, scope)) || null
}

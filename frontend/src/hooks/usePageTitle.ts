import { useEffect } from 'react'

export const APP_NAME = 'MedReminder'

/** "Today · MedReminder": the browser tab, history and screen-reader page name for the current screen. */
export function titleFor(page: string): string {
  return page ? `${page} · ${APP_NAME}` : APP_NAME
}

/** Set the document title while the calling page is on screen. */
export function usePageTitle(page: string): void {
  useEffect(() => {
    document.title = titleFor(page)
  }, [page])
}

import { describe, expect, it, vi } from 'vitest'
import { createTokenStore } from './tokenStore'

const KEY = 'medreminder.session'
const tokens = { access: 'a', refresh: 'r' }

describe('token store', () => {
  it('uses sessionStorage by default (the app creates it with no arguments)', () => {
    const store = createTokenStore()
    store.set(tokens)
    expect(JSON.parse(window.sessionStorage.getItem(KEY) ?? 'null')).toEqual(tokens)
    expect(window.localStorage.getItem(KEY)).toBeNull()
    expect(window.localStorage.length).toBe(0)
  })

  it('keeps tokens in memory and in sessionStorage, never localStorage', () => {
    const store = createTokenStore(window.sessionStorage)
    store.set(tokens)
    expect(store.get()).toEqual(tokens)
    expect(JSON.parse(window.sessionStorage.getItem(KEY) ?? 'null')).toEqual(tokens)
    expect(window.localStorage.length).toBe(0)
  })

  it('a new store (a page reload) restores the session', () => {
    createTokenStore(window.sessionStorage).set(tokens)
    expect(createTokenStore(window.sessionStorage).get()).toEqual(tokens)
  })

  it('clear forgets everything', () => {
    const store = createTokenStore(window.sessionStorage)
    store.set(tokens)
    store.clear()
    expect(store.get()).toBeNull()
    expect(window.sessionStorage.getItem(KEY)).toBeNull()
  })

  it.each([['not json'], ['{"access":1,"refresh":2}'], ['{"access":"a"}'], ['null'], ['"text"']])(
    'ignores a corrupt saved value (%s)',
    (saved) => {
      window.sessionStorage.setItem(KEY, saved)
      expect(createTokenStore(window.sessionStorage).get()).toBeNull()
    },
  )

  it('still works in memory when storage is unavailable or throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    } as unknown as Storage
    const store = createTokenStore(broken)
    expect(store.get()).toBeNull()
    store.set(tokens)
    expect(store.get()).toEqual(tokens)
    store.clear()
    expect(store.get()).toBeNull()
    expect(createTokenStore(null).get()).toBeNull()
  })

  it('tells subscribers about changes until they unsubscribe', () => {
    const store = createTokenStore(window.sessionStorage)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.set(tokens)
    store.clear()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    store.set(tokens)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('copies what it is given, so later mutation of the caller\'s object changes nothing', () => {
    const store = createTokenStore(window.sessionStorage)
    const original = { access: 'a', refresh: 'r' }
    store.set(original)
    original.access = 'tampered'
    expect(store.get()?.access).toBe('a')
  })
})

import {useCallback, useEffect, useState} from 'react'
import enTranslations from './en.yaml'
import zhCNTranslations from './zh-CN.yaml'
import zhTWTranslations from './zh-TW.yaml'
import hiTranslations from './hi.yaml'

type TranslationKey = string
type TranslationParams = Record<string, string | number>

interface TranslationContext {
  t: (key: TranslationKey, params?: TranslationParams) => string
  locale: string
  setLocale: (locale: string) => void
  availableLocales: string[]
}

const DEFAULT_LOCALE = 'en'
const STORAGE_KEY = 'polly_locale'

// All translations pre-loaded
const translations = {
  'en': enTranslations,
  'zh-CN': zhCNTranslations,
  'zh-TW': zhTWTranslations,
  'hi': hiTranslations
}

const getStoredLocale = (): string => {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

// Global state
let currentLocale = getStoredLocale() // Initialize with stored locale immediately
let updateCounter = 0
const subscribers = new Set<() => void>()

const notifyAll = () => {
  updateCounter++
  subscribers.forEach(fn => fn())
}

const getValue = (obj: any, path: string): string => {
  const result = path.split('.').reduce((o, k) => o?.[k], obj)
  return typeof result === 'string' ? result : path
}

const interpolate = (text: string, params?: TranslationParams): string => {
  if (!params) return text
  return text.replace(/{{(\w+)}}/g, (_, key) => params[key]?.toString() || `{{${key}}}`)
}

const translate = (key: TranslationKey, params?: TranslationParams): string => {
  let text = getValue(translations[currentLocale], key)

  // Fallback to English if not found
  if (text === key && currentLocale !== DEFAULT_LOCALE) {
    text = getValue(translations[DEFAULT_LOCALE], key)
  }

  return interpolate(text, params)
}

const setStoredLocale = (locale: string): void => {
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch (error) {
    console.warn('Failed to store locale:', error)
  }
}

export const getLanguageDisplayName = (code: string): string => {
  const names = {
    'en': 'English',
    'zh-CN': '简体中文',
    'zh-TW': '繁體中文',
    'hi': 'हिन्दी'
  }
  return names[code] || code.toUpperCase()
}

export const useTranslation = (): TranslationContext => {
  const [locale, setLocaleState] = useState(getStoredLocale())
  const [, forceUpdate] = useState(0)

  // Initialize global locale
  useEffect(() => {
    currentLocale = locale
  }, [locale])

  // Subscribe to global updates
  useEffect(() => {
    const handleUpdate = () => {
      forceUpdate(updateCounter)
      setLocaleState(currentLocale)
    }

    subscribers.add(handleUpdate)
    return () => {
      subscribers.delete(handleUpdate)
    }
  }, [])

  const t = useCallback((key: TranslationKey, params?: TranslationParams) => {
    return translate(key, params)
  }, [updateCounter])

  const setLocale = useCallback((newLocale: string) => {
    if (!translations[newLocale]) {
      console.warn(`Locale '${newLocale}' not available`)
      return
    }

    setStoredLocale(newLocale)
    setLocaleState(newLocale)
    currentLocale = newLocale
    notifyAll()
  }, [])

  return {
    t,
    locale,
    setLocale,
    availableLocales: Object.keys(translations)
  }
}

export { translate }
export type { TranslationKey, TranslationParams, TranslationContext }